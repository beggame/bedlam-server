// ============================================================================
// BEDLAM Godot — gem cüzdanı (Faz 7.7; godot/EKONOMI.md). server.js: require('./g_cuzdan').kur(app)
// Gem gerçek parayla (Play test ürünü) alındığı için bakiye SUNUCUDA: Firestore cuzdan/<uid> (istemci kuralı: okuma/yazma yok, yalnız yönetici).
// Coin oynayarak kazanılır ve istemcide kalır (hile yalnız oyuncunun kendi kozmetiğini etkiler; güç veren ürün yok).
//
// Protokol v1 (gövde JSON; "kimlik" = Firebase ID jetonu, imzası Google sertifikalarıyla doğrulanır):
//   POST /g/cuzdan        { v:1, kimlik }                          → { v:1, ok, gem, sahip[], ilkPaket, tek[] }   (tek = alınmış tek seferlik ürün kimlikleri; ilkPaket = tek içinde ilk_paket, eski istemci uyumu)
//   POST /g/cuzdan/yukle  { v:1, kimlik, paket, urun, jeton }      → gem paketi (tuketilir ya da tekSefer kalici örn destekci): Play doğrulaması + jeton başına TEK yükleme (satin/<sha256>); yanıtta iade = pakette zaten sahip olunan öğelerin gem karşılığı
//   POST /g/cuzdan/harca  { v:1, kimlik, oge, islem }              → gemle öğe: fiyat sunucu kataloğundan (dukkan.json), işlem kimliğiyle TEK harcama
//   POST /g/cuzdan/odul   { v:1, olcek, kimlik, tur, id, ... }       → tur yol (y<adım>) | kutu (k<n>, boy) | hafta (w<YYYY>-<WW>; seri: cüzdan hs/hw, kupa.json haftaSeri) | hedef (h_<kural>; kupa.json hedefGem, günlük tavan gunlukHedef) | efsane (e<n>; sunucu öğeyi seçer, efsaneGun sınırı): kimlik başına TEK sefer
//   Hata: { v:1, ok:false, durum: surum | kimlik | gecersiz | yetersiz | zaten_var | tek_sefer | gercek_kapali | bekliyor | iptal | dogrulayici_yok | hata }
// Eşzamanlılık: her yazım Firestore commit + currentDocument (updateTime / exists:false) ön koşuluyla; çakışmada 3 kez yeniden dener (çift harcama yok).
// Sürüm 5 iade: iadeUygula(iz, kayit) — Play iade/ters ibraz (g_iade.js tarar) sonrası gem geri alma: satin/<iz> → iade/<iz> (exists:false, çift geri alma yok); bakiye ASLA negatife düşmez (eksik iade/ belgesine yazılır).
// Ortam: FIREBASE_SERVIS_JSON (yönetici), PLAY_SERVIS_JSON (Play doğrulaması, g_magaza.js), GERCEK_SATIN (kapalı: yalnız test satın alması).
// ============================================================================
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path'), express = require('express');
const { playDogrula, playOnayla, hizAsildi, urunUygun } = require('./g_magaza');

const PROJE = process.env.FIREBASE_PROJE || 'bedlam-94bfc';
const FS_AD = `projects/${PROJE}/databases/(default)/documents`, FS = 'https://firestore.googleapis.com/v1/' + FS_AD;
const DUKKAN = JSON.parse(fs.readFileSync(path.join(__dirname, 'dukkan.json'), 'utf8'));
const URUN = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, 'urunler.json'), 'utf8')).urunler.map(u => [u.id, u]));
const PAKETLER = JSON.parse(fs.readFileSync(path.join(__dirname, 'urunler.json'), 'utf8')).paket;
const GEM_PAKET = new Map(DUKKAN.gemPaket.map(p => [p.urun, p]));
/** Setin verilecek parçaları: cüzdanda olmayanlar. Coinle de alınan parça cüzdana yazılmaz; istemcinin parca listesinde yoksa sahip sayılır. */
const setEksik = (gs, sahip, parca) => gs.ogeler.filter(x => !sahip.includes(x) && (!Array.isArray(parca) || parca.includes(x) || !DUKKAN.fiyat[x]?.coin));
/** Eksik parçaların set fiyatı: orantılı, 10'a yukarı yuvarlı, tek tek toplamını aşmaz (istemci Dukkan.SetFiyat ile aynı). */
const setFiyat = (gs, eksik) => { if (eksik.length === gs.ogeler.length) return gs.gem; const ayri = eksik.reduce((t, x) => t + (DUKKAN.fiyat[x]?.gem || 0), 0); return Math.min(ayri, Math.ceil(gs.gem * eksik.length / gs.ogeler.length / 10) * 10); };
const KUPA = JSON.parse(fs.readFileSync(path.join(__dirname, 'kupa.json'), 'utf8'));   // kupa yolu / kutu gem tabloları (godot/veri/ilerleme.json ile eşit; test_kupa.js)
/** Kupa yolu adımının gem ödülü (istemcideki Kupa.Odul ile aynı seçim; coin ölçeklemesi gem'i etkilemez). 0 = bu adımda gem yok. */
function yolGem(idx) {
  const y = KUPA.kupaYolu, adim = y.adim || 5, sv = Math.floor(idx / adim) + 1, k = idx % adim; let ad = y.varsayilan;
  for (const e of y.seviyeSablon || []) if ((Array.isArray(e.seviyeler) ? e.seviyeler.includes(sv) : sv % e.her === 0) && sv >= (e.min || 1) && sv <= (e.max || Infinity) && y.sablonlar[e.sablon]) { ad = e.sablon; break; }   /* seviyeler: listedeki seviyeler; her: katları; min/max: seviye sınırları (dahil); ilk eşleşen kazanır */
  const sa = y.sablonlar[ad] || y.sablonlar.temel, o = sa[Math.min(k, sa.length - 1)]; return o && o.gem ? o.gem : 0;
}

// ---- Google erişim jetonu (yönetici) ----
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let erisim = null;
async function erisimJetonu() {
  if (erisim && erisim.bitis > Date.now() + 60000) return erisim.jeton;
  const sa = JSON.parse(process.env.FIREBASE_SERVIS_JSON); const t = Math.floor(Date.now() / 1000);
  const bas = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), iddia = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600 }));
  const imza = b64url(crypto.createSign('RSA-SHA256').update(bas + '.' + iddia).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + bas + '.' + iddia + '.' + imza });
  if (!r.ok) throw new Error('oauth ' + r.status); const j = await r.json(); erisim = { jeton: j.access_token, bitis: Date.now() + (j.expires_in || 3600) * 1000 }; return erisim.jeton;
}

// ---- Firebase ID jetonu doğrulama (securetoken sertifikaları, RS256) ----
let cert = null, certBitis = 0;
async function certAl() {
  if (cert && Date.now() < certBitis) return cert;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'); if (!r.ok) throw new Error('cert ' + r.status);
  const m = /max-age=(\d+)/.exec((r.headers && r.headers.get && r.headers.get('cache-control')) || ''); cert = await r.json(); certBitis = Date.now() + (m ? +m[1] : 3600) * 1000; return cert;
}
async function kimlikDogrula(idJeton) {
  if (typeof idJeton !== 'string' || idJeton.length > 4096) throw new Error('bicim');
  const [h, p, s] = idJeton.split('.'); if (!s) throw new Error('bicim');
  const H = JSON.parse(Buffer.from(h, 'base64url')), P = JSON.parse(Buffer.from(p, 'base64url'));
  if (H.alg !== 'RS256') throw new Error('alg'); const c = (await certAl())[H.kid]; if (!c) throw new Error('kid');
  if (!crypto.createVerify('RSA-SHA256').update(h + '.' + p).verify(c, Buffer.from(s, 'base64url'))) throw new Error('imza');
  const simdi = Date.now() / 1000;
  if (P.aud !== PROJE || P.iss !== 'https://securetoken.google.com/' + PROJE || !(P.exp > simdi) || P.iat > simdi + 300 || !P.sub) throw new Error('iddia');
  return P.sub;
}

// ---- Firestore (yönetici REST) ----
const deger = v => typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(x => ({ stringValue: String(x) })) } } : (v && typeof v === 'object') ? { mapValue: { fields: alanlar(v) } } : { stringValue: String(v) };
const alanlar = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deger(v)]));
/** Alınmış tek seferlik ürün kimlikleri; eski belgede yalnız ilkPaket:true varsa ilk_paket sayılır (geriye uyum). */
const tekCoz = f => { const l = (f?.tek?.arrayValue?.values || []).map(x => x.stringValue); if (f?.ilkPaket?.booleanValue && !l.includes('ilk_paket')) l.push('ilk_paket'); return l; };
const OLCEK = 5;   // 2026-11-07 gem ölçeği: fiyat ve bakiyeler 5'e bölündü. olcek alanı olmayan eski cüzdan okunurken yukarı yuvarlanarak çevrilir, ilk yazımda kalıcı olur.
/* olcek = belgede uygulanmış toplam bölen (0/eksik = 1). Hedef OLCEK'ten farklıysa gem, kgem ve borc ceil(x * eski / hedef) ile göçer (0 → 5: ceil(x/5), eski davranış). */
const olcekCevir = (x, eski) => Math.ceil((x || 0) * eski / OLCEK);
const olcekle = c => { const eski = c.olcek > 0 ? c.olcek : 1; if (eski !== OLCEK) { c.gem = olcekCevir(c.gem, eski); c.kgem = olcekCevir(c.kgem, eski); c.borc = olcekCevir(c.borc, eski); c.olcek = OLCEK; } return c; };
const ALIM_EN_COK = 200, klon = c => ({ ...c, sahip: [...c.sahip], tek: [...c.tek], islemler: [...c.islemler], alim: [...(c.alim || [])], goc: [...(c.goc || [])] });
const coz = f => olcekle({ olcek: +(f?.olcek?.integerValue || 0), gem: +(f?.gem?.integerValue || 0), sahip: (f?.sahip?.arrayValue?.values || []).map(x => x.stringValue), islemler: (f?.islemler?.arrayValue?.values || []).map(x => x.stringValue), tek: tekCoz(f), kt0: +(f?.kt0?.integerValue || 0), kgun: f?.kgun?.stringValue || '', kgem: +(f?.kgem?.integerValue || 0), borc: +(f?.borc?.integerValue || 0), borcT: +(f?.borcT?.integerValue || 0), alim: (f?.alim?.arrayValue?.values || []).map(x => x.stringValue), goc: (f?.goc?.arrayValue?.values || []).map(x => x.stringValue), hs: +(f?.hs?.integerValue || 0), hw: f?.hw?.stringValue || '', hgun: f?.hgun?.stringValue || '', hsay: +(f?.hsay?.integerValue || 0), et: +(f?.et?.integerValue || 0) });
// SAHTE_CUZDAN=1: YALNIZ YEREL GELİŞTİRME — Firestore yerine bellek deposu (aynı ön koşul anlamı); kimlik doğrulaması gerçek kalır. Render'da ASLA açılmaz.
const bellek = new Map(); let bellekSurum = 0;
/** Set içerik genişlemesi göçü ("satın alınan değer kaybetmez"): dukkan.json'da sonradan öğe eklenen tekSefer paketlerin (ogeler'i olan) alınmış olanları için eksik öğeler sahip'e eklenir (GEM VERİLMEZ).
 *  Eklenen öğeler c.goc'a da yazılır: iadeUygula bunları da düşer (satin.verilen.ogeler'de yoksa bile; göçle gelen öğenin sahibi paket satın almasıdır). Yalnız eksik varsa değişir → true. */
const GOC_PAKET = DUKKAN.gemPaket.filter(p => p.tekSefer && Array.isArray(p.ogeler) && p.ogeler.length);
function setGoc(c) {
  let degisti = false;
  for (const p of GOC_PAKET) if (c.tek.includes(p.urun)) for (const o of p.ogeler) if (!c.sahip.includes(o)) { c.sahip.push(o); if (!c.goc.includes(o)) c.goc.push(o); degisti = true; }
  return degisti;
}
/** Cüzdanı okur ve set göçünü bellekte uygular (w.goc = bu okumada eksik öğe eklendi; kalıcılaştırma çağırana ait: yalnız w.goc true ise yaz → gereksiz Firestore yazımı yok). */
async function oku(uid) { const w = await okuHam(uid); w.goc = w.var && setGoc(w.c); return w; }
async function okuHam(uid) {
  if (process.env.SAHTE_CUZDAN === '1') { const d = bellek.get('cuzdan/' + uid); return d ? { var: true, updateTime: d.updateTime, c: coz(d.fields) } : { var: false, c: coz({}) }; }
  const t = await erisimJetonu(); const r = await fetch(`${FS}/cuzdan/${uid}`, { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 404) return { var: false, c: coz({}) }; if (!r.ok) throw new Error('oku ' + r.status);
  const d = await r.json(); return { var: true, updateTime: d.updateTime, c: coz(d.fields) };
}
/** Firestore belgesini okur (yol: 'satin/<iz>'); yoksa null; alanlar düz nesne (stringValue / integerValue). */
const cozDeger = v => v.integerValue !== undefined ? +v.integerValue : v.stringValue !== undefined ? v.stringValue : v.booleanValue !== undefined ? v.booleanValue : v.arrayValue ? (v.arrayValue.values || []).map(cozDeger) : v.mapValue ? duz(v.mapValue.fields) : v;
const duz = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, cozDeger(v)]));
/** { alan, updateTime } ya da null (map ve dizi alanlar çözülür). */
async function belgeOkuT(yol) {
  if (process.env.SAHTE_CUZDAN === '1') { const d = bellek.get(yol); return d ? { alan: duz(d.fields), updateTime: d.updateTime } : null; }
  const t = await erisimJetonu(); const r = await fetch(`${FS}/${yol}`, { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 404) return null; if (!r.ok) throw new Error('belgeOku ' + r.status);
  const j = await r.json(); return { alan: duz(j.fields), updateTime: j.updateTime };
}
async function belgeOku(yol) { const b = await belgeOkuT(yol); return b ? b.alan : null; }
/** Cüzdan belgesinin düz alanları (yaz ve taşıma/ek yazımlar paylaşır). */
const cuzdanAlan = c => ({ olcek: OLCEK, gem: c.gem, sahip: c.sahip, islemler: c.islemler.slice(-50), ilkPaket: c.tek.includes('ilk_paket'), tek: c.tek, kt0: c.kt0 || 0, kgun: c.kgun || '', kgem: c.kgem || 0, borc: c.borc || 0, borcT: c.borcT || 0, alim: (c.alim || []).slice(-ALIM_EN_COK), goc: c.goc || [], hs: c.hs || 0, hw: c.hw || '', hgun: c.hgun || '', hsay: c.hsay || 0, et: c.et || 0 });
/** Ön koşullu yazım; çakışmada 'cakisma', ek belge (exists:false) çakışırsa 'var' döner (çağıran yeniden okur). ek: aynı commit'te yazılacak ek belgeler { yol, alan, kosul? } (kosul varsayılan { exists:false }; { exists:true } | { updateTime }). */
async function yaz(uid, onceki, c, ek = []) {
  if (process.env.SAHTE_CUZDAN === '1') {
    const d = bellek.get('cuzdan/' + uid); if (onceki.var ? (!d || d.updateTime !== onceki.updateTime) : !!d) return 'cakisma';
    for (const e of ek) { const k = e.kosul || { exists: false }, v = bellek.get(e.yol); if (k.exists === false && v) return 'var'; if (k.exists === true && !v) return 'cakisma'; if (k.updateTime && (!v || v.updateTime !== k.updateTime)) return 'cakisma'; }
    bellek.set('cuzdan/' + uid, { fields: alanlar(cuzdanAlan(c)), updateTime: 'b' + (++bellekSurum) });
    for (const e of ek) bellek.set(e.yol, { fields: alanlar(e.alan), updateTime: 'b' + (++bellekSurum) }); return 'ok';
  }
  const t = await erisimJetonu();
  const writes = [{ update: { name: `${FS_AD}/cuzdan/${uid}`, fields: alanlar(cuzdanAlan(c)) }, currentDocument: onceki.var ? { updateTime: onceki.updateTime } : { exists: false } }];
  for (const e of ek) writes.push({ update: { name: `${FS_AD}/${e.yol}`, fields: alanlar(e.alan) }, currentDocument: e.kosul || { exists: false } });
  const r = await fetch(`${FS}:commit`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  if (r.ok) return 'ok'; if (r.status === 409 || r.status === 400 || r.status === 412) { const j = await r.json().catch(() => ({})); return /ALREADY_EXISTS|already exists/i.test(JSON.stringify(j)) ? 'var' : 'cakisma'; }
  throw new Error('yaz ' + r.status);
}

/** Gem girişi: önce iade borcu (Play iadesinde geri alınamayan eksik gem) düşülür, kalan bakiyeye eklenir. Bakiye asla eksi olmaz. */
function gemGiris(c, miktar) { const ode = Math.min(c.borc || 0, miktar); c.borc = (c.borc || 0) - ode; c.gem += miktar - ode; if (!(c.borc > 0)) { c.borc = 0; c.borcT = 0; } return ode; }   /* borç kapanınca kilit boşalır */
const istat = { yukle: 0, harca: 0, red: 0, onay: 0, onayAtla: 0, onayHata: 0, hesapUyusmaz: 0, hesapEtiketsiz: 0, tasima: 0, tasimaUyusmaz: 0, odulHizli: 0, odulEfsane: 0 };
/** Ödül hızı izlemesi (1A, 2026-11-14): istemci beyanlı ödüller (yol/kutu/hafta/hedef) sunucu tavanlarıyla sınırlı; kimlik başına pencere (kupa.json odulIzleme.gun) içindeki gem toplamı eşiği (odulIzleme.gem) aşarsa pencere başına bir kez günlüğe yazılır ve istat.odulHizli sayılır. Bellekte; yeniden başlatmada sıfırlanır; engel DEĞİL, yalnız ölçüm. */
const odulHiz = new Map();
function odulIzle(uid, tur, gem, simdi, iz) {
  iz = iz || {}; const gunMs = (iz.gun || 7) * 864e5, esik = iz.gem || 35;
  if (odulHiz.size > 20000) { for (const [k, v] of odulHiz) if (simdi - v.t0 >= gunMs) odulHiz.delete(k); for (const k of odulHiz.keys()) { if (odulHiz.size <= 15000) break; odulHiz.delete(k); } }   /* en eskiler (ekleme sırası) gider; yeni uyarılar kaybolmaz */
  let v = odulHiz.get(uid); if (!v || simdi - v.t0 >= gunMs) { v = { t0: simdi, gem: 0, uyari: false }; odulHiz.set(uid, v); }
  v.gem += gem; if (!v.uyari && v.gem > esik) { v.uyari = true; istat.odulHizli++; console.log(`[odul] hizli ${uid.slice(0, 8)} ${v.gem} gem / ${Math.ceil((simdi - v.t0) / 864e5) || 1} gün (son: ${tur})`); }
  return v.uyari;
}
/** Kutu gem miktarı: sha256(uid:id) ilk 4 bayt → min..max (istemci seçmez). */
const kutuMiktar = (uid, id, kb) => kb.min + (crypto.createHash('sha256').update(uid + ':' + id).digest().readUInt32BE(0) % (kb.max - kb.min + 1));
/** Borç varken kilitli öğeler: borcT (iade edilen satın almanın zamanı) sonrası gemle alınmış, hâlâ sahip olunan öğeler. */
const kilitHesap = c => { if (!(c.borc > 0) || !c.borcT) return []; const k = new Set(); for (const a of c.alim || []) { const i = a.lastIndexOf('@'); if (i > 0 && +a.slice(i + 1) >= c.borcT && c.sahip.includes(a.slice(0, i))) k.add(a.slice(0, i)); } return [...k]; };
/** ISO 8601 hafta anahtarı 'YYYY-WW' (UTC; hafta Pazartesi başlar, yıl = haftanın Perşembe'sinin yılı). */
function isoHafta(ms) {
  const t = new Date(ms); const g = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())); const gun = g.getUTCDay() || 7; g.setUTCDate(g.getUTCDate() + 4 - gun);
  const y0 = Date.UTC(g.getUTCFullYear(), 0, 1), h = Math.ceil(((g - y0) / 864e5 + 1) / 7); return g.getUTCFullYear() + '-' + String(h).padStart(2, '0');
}
/** 'YYYY-WW' ISO hafta kimliği → o haftanın Pazartesi 00:00 UTC ms (4 Ocak her zaman 1. haftadadır). */
function haftaMs(id) {
  const m = /^([0-9]{4})-([0-9]{2})$/.exec(id); if (!m) return NaN;
  const j4 = new Date(Date.UTC(+m[1], 0, 4)), gun = j4.getUTCDay() || 7; return j4.getTime() - (gun - 1) * 864e5 + (+m[2] - 1) * 7 * 864e5;
}
/** Seri kademe indeksi: haftaSeri içinde n'in girdiği (n'den küçük/eşit başlangıçlı) en büyük kademe. */
const seriKademe = n => { let i = 0; KUPA.haftaSeri.forEach((k, j) => { if (n >= k.n) i = j; }); return i; };
/** Haftalık seri: talep edilen hafta W için { n (ödenen seri sayısı), gem, yeniHs, yeniHw }. Ardışık: hs+1; 2+ hafta atlanırsa bir kademe düşer; geç talep (W <= hw) seriyi değiştirmez. */
function seriHesap(c, W) {
  const S = KUPA.haftaSeri, hs = c.hs > 0 ? c.hs : 1; let n, yeniHs = c.hs, yeniHw = c.hw;
  if (!c.hw) { n = 1; yeniHs = 1; yeniHw = W; }
  else { const fark = Math.round((haftaMs(W) - haftaMs(c.hw)) / (7 * 864e5));
    if (fark <= 0) n = hs;
    else { n = fark === 1 ? hs + 1 : S[Math.max(0, seriKademe(hs) - 1)].n; yeniHs = n; yeniHw = W; } }
  return { n, gem: S[seriKademe(n)].gem, yeniHs, yeniHw };
}
/** Kutudan efsane öğe adayı: gem'li, coin'siz, gem >= 50, açık dalgada, gerçek para paketlerinde olmayan, cüzdanda olmayan öğeler (ada göre sıralı); sha256(uid:id) ilk 4 bayt mod uzunluk. Aday yoksa ''. */
const PAKET_OGE = new Set(DUKKAN.gemPaket.flatMap(p => p.ogeler || []));
const EFSANE_ADAY = Object.entries(DUKKAN.fiyat).filter(([k, f]) => f.gem >= 50 && !f.coin && !PAKET_OGE.has(k) && (!DUKKAN.dalga || !DUKKAN.dalga[k] || DUKKAN.dalga[k] <= (DUKKAN.acikDalga || 0))).map(([k]) => k).sort();
function efsaneSec(uid, id, c) { const l = EFSANE_ADAY.filter(x => !c.sahip.includes(x)); return l.length ? l[crypto.createHash('sha256').update(uid + ':' + id).digest().readUInt32BE(0) % l.length] : ''; }
function kur(app, secenek = {}) {
  const dogrula = secenek.dogrula || playDogrula, onayla = secenek.onayla || playOnayla;
  app.use('/g/cuzdan', express.json({ limit: '8kb' }));
  const yanit = (res, kod, o) => { if (o.ok === false) istat.red++; res.status(kod).json({ v: 1, ...o }); };
  async function ortak(req, res) {
    res.set('Cache-Control', 'no-store'); const d = req.body || {};
    if (d.v !== 1) { yanit(res, 400, { ok: false, durum: 'surum', destek: [1] }); return null; }
    if (!req.path.endsWith('/cuzdan') && d.olcek !== OLCEK) { yanit(res, 200, { ok: false, durum: 'guncelle' }); return null; }   // eski ölçekli istemci harcayamaz ve yükleyemez; bakiye okuması serbest
    if (!process.env.FIREBASE_SERVIS_JSON && process.env.SAHTE_CUZDAN !== '1') { yanit(res, 503, { ok: false, durum: 'dogrulayici_yok' }); return null; }
    const yaz_ = !req.path.endsWith('/cuzdan');   // yukle / harca / odul: yazma sınırı; okuma ayrı (daha geniş) sınırlı
    if (yaz_ && hizAsildi(req.ip || '', Number(process.env.CUZDAN_IP_DK) || 60, 'cuzdan-ip')) { yanit(res, 429, { ok: false, durum: 'hata', hata: 'hiz' }); return null; }
    if (!yaz_ && hizAsildi(req.ip || '', Number(process.env.CUZDAN_OKU_IP_DK) || 600, 'cuzdan-oku-ip')) { yanit(res, 429, { ok: false, durum: 'hata', hata: 'hiz' }); return null; }
    let uid; try { uid = await kimlikDogrula(d.kimlik); } catch (e) { yanit(res, 401, { ok: false, durum: 'kimlik' }); return null; }
    if (yaz_ && hizAsildi(uid, Number(process.env.CUZDAN_UID_DK) || 20, 'cuzdan-uid')) { yanit(res, 429, { ok: false, durum: 'hata', hata: 'hiz' }); return null; }
    if (!yaz_ && hizAsildi(uid, Number(process.env.CUZDAN_OKU_UID_DK) || 60, 'cuzdan-oku-uid')) { yanit(res, 429, { ok: false, durum: 'hata', hata: 'hiz' }); return null; }
    return { d, uid };
  }
  /** Her yanıtta borc (0 dahil) ve kilit (boş dizi dahil) gider; kilit = borçtan sonra gemle alınmış öğeler, öğeler silinmez. */
  const cuzdanYanit = c => ({ gem: c.gem, sahip: c.sahip, ilkPaket: c.tek.includes('ilk_paket'), tek: c.tek, borc: c.borc > 0 ? c.borc : 0, kilit: c.borc > 0 ? kilitHesap(c) : [] });
  /** Play onayı (tüketilir: consume, kalıcı: acknowledge); hata yanıtı bozmaz, yalnız günlük + sayaç. */
  async function onayEt(p, d, u) {
    try {
      const tur = u.tur === 'tuketilir' ? 'consume' : 'acknowledge';
      if (tur === 'consume' ? p.consumptionState === 1 : p.acknowledgementState === 1) { istat.onayAtla++; return; }
      await onayla(d.paket, d.urun, d.jeton, tur); istat.onay++;
    } catch (e) { istat.onayHata++; console.log('[cuzdan] play onay hata', u.id, e.message); }
  }
  app.post('/g/cuzdan', async (req, res) => {
    const o = await ortak(req, res); if (!o) return;
    try { const w = await oku(o.uid); if (w.goc) { try { await yaz(o.uid, w, w.c); istat.goc = (istat.goc || 0) + 1; } catch (e) { console.log('[cuzdan] goc yazim hata', e.message); } }   /* yalnız eksik varsa tek küçük yazım; çakışmada yanıt yine düzeltilmiş, sonraki yazım kalıcı kılar */
      yanit(res, 200, { ok: true, ...cuzdanYanit(w.c) }); } catch (e) { yanit(res, 502, { ok: false, durum: 'hata' }); }
  });
  app.post('/g/cuzdan/yukle', async (req, res) => {
    const o = await ortak(req, res); if (!o) return; const { d, uid } = o; istat.yukle++;
    const u = URUN.get(d.urun), gp = GEM_PAKET.get(d.urun);
    if (!u || !gp || (u.tur !== 'tuketilir' && !(u.tur === 'kalici' && gp.tekSefer)) || typeof d.jeton !== 'string' || d.jeton.length < 8 || d.jeton.length > 4096 || !PAKETLER.includes(d.paket)) return yanit(res, 400, { ok: false, durum: 'gecersiz' });
    try {
      const p = await dogrula(d.paket, d.urun, d.jeton);
      if (p.dogrulayiciYok) return yanit(res, 503, { ok: false, durum: 'dogrulayici_yok' });
      if (p.yok || !urunUygun(p, d.urun)) return yanit(res, 200, { ok: false, durum: 'gecersiz' });   /* productId uyuşmaz / quantity > 1 */
      if (p.purchaseType !== 0 && process.env.GERCEK_SATIN !== '1') return yanit(res, 200, { ok: false, durum: 'gercek_kapali' });
      if (p.purchaseState === 2) return yanit(res, 200, { ok: false, durum: 'bekliyor' }); if (p.purchaseState !== 0) return yanit(res, 200, { ok: false, durum: 'iptal' });
      const iz = crypto.createHash('sha256').update(d.jeton).digest('hex'), jk = 'j:' + iz.slice(0, 24);
      const hesapId = crypto.createHash('sha256').update(uid).digest('hex'), etiket = typeof p.obfuscatedExternalAccountId === 'string' ? p.obfuscatedExternalAccountId : '';
      /* A4: kalıcı ürün (destekçi) başka hesaba ya da silinmiş hesaba aitse geri yükleme = taşıma */
      const satinB = (u.tur === 'kalici' || (gp && gp.tekSefer)) ? await belgeOkuT('satin/' + iz) : null, tasima = u.tur === 'kalici' && !!(satinB && satinB.alan.uid !== uid);   /* tek seferlik tüketilir pakette de aynı jeton+aynı hesap 'zaten' (islemler 50 ile sınırlı) */
      for (let deneme = 0; deneme < 3; deneme++) {
        const w = await oku(uid); const c = klon(w.c);
        if (!tasima && (c.islemler.includes(jk) || (satinB && satinB.alan.uid === uid))) return yanit(res, 200, { ok: true, durum: 'zaten', test: p.purchaseType === 0, ...cuzdanYanit(c) });   // bu jeton zaten yüklendi (istemci tekrar denedi): tüketebilir
        /* A6: satın alma hesaba bağlama (istemci obfuscatedExternalAccountId = sha256(uid) hex gönderir); alan boşsa eski istemci: izin ver, say */
        if (etiket) { if (etiket !== hesapId) { if (!tasima) { istat.hesapUyusmaz++; console.log('[cuzdan] hesap_uyusmaz', u.id, uid.slice(0, 8)); return yanit(res, 200, { ok: false, durum: 'hesap_uyusmaz' }); } istat.tasimaUyusmaz++; console.log('[cuzdan] taşıma: hesap etiketi eşleşmiyor (izinli)', u.id, uid.slice(0, 8)); } } else istat.hesapEtiketsiz++;
        if (tasima) {
          const sb = satinB.alan, simdi = Date.now();
          if (sb.tasindiT && simdi - sb.tasindiT < 7 * 864e5) return yanit(res, 200, { ok: false, durum: 'tasima_sinir', ...cuzdanYanit(c) });
          const yeni = [], ek = []; for (const og of gp.ogeler || []) if (!c.sahip.includes(og)) { c.sahip.push(og); yeni.push(og); }
          if (!c.tek.includes(gp.urun)) c.tek.push(gp.urun); c.islemler.push(jk);   /* gem YOK: yalnız ilk yüklemede verilir */
          const eskiUid = typeof sb.uid === 'string' ? sb.uid : '';
          if (eskiUid) { const we = await oku(eskiUid); if (we.var) { const ce = klon(we.c), og = new Set(gp.ogeler || []); ce.sahip = ce.sahip.filter(x => !og.has(x)); ce.goc = (ce.goc || []).filter(x => !og.has(x)); ce.tek = ce.tek.filter(x => x !== gp.urun); ce.islemler = ce.islemler.filter(x => x !== jk); ek.push({ yol: 'cuzdan/' + eskiUid, alan: cuzdanAlan(ce), kosul: { updateTime: we.updateTime } }); } }
          const yenis = { ...sb, uid, ilkUid: typeof sb.ilkUid === 'string' ? sb.ilkUid : eskiUid, tasindiT: simdi }; if (sb.verilen && typeof sb.verilen === 'object') yenis.verilen = { ...sb.verilen, ogeler: [...new Set([...(sb.verilen.ogeler || []), ...yeni])] };
          ek.push({ yol: 'satin/' + iz, alan: yenis, kosul: satinB.updateTime ? { updateTime: satinB.updateTime } : { exists: true } });
          const s = await yaz(uid, w, c, ek);
          if (s === 'ok') { istat.tasima++; console.log(`[cuzdan] geri yüklendi (taşıma) ${u.id} ${eskiUid.slice(0, 8) || '-'} → ${uid.slice(0, 8)}`); await onayEt(p, d, u); return yanit(res, 200, { ok: true, durum: 'geri_yuklendi', iade: 0, test: p.purchaseType === 0, ...cuzdanYanit(c) }); }
          continue;   /* çakışma: yeniden oku */
        }
        if (gp.tekSefer && c.tek.includes(gp.urun)) return yanit(res, 200, { ok: false, durum: 'tek_sefer', ...cuzdanYanit(c) });
        let iade = 0; const yeni = []; for (const og of gp.ogeler || []) { if (!c.sahip.includes(og)) { c.sahip.push(og); yeni.push(og); } else iade += (DUKKAN.fiyat[og] && DUKKAN.fiyat[og].gem) || 0; }   // pakette sahip olunan öğe: gem fiyatı kadar iade
        gemGiris(c, gp.gem + iade); if (gp.tekSefer) c.tek.push(gp.urun); c.islemler.push(jk);
        /* A7: satın almada gerçekte verilen (iade yalnız bunları geri alır; önceden sahip olunan öğe silinmez) */
        const s = await yaz(uid, w, c, [{ yol: `satin/${iz}`, alan: { uid, ilkUid: uid, urun: u.id, t: Date.now(), verilen: { gem: gp.gem + iade, ogeler: yeni, olcek: OLCEK } } }]);
        if (s === 'ok') { console.log(`[cuzdan] +${gp.gem} gem ${u.id} ${uid.slice(0, 8)}`); await onayEt(p, d, u); return yanit(res, 200, { ok: true, durum: 'yuklendi', iade, test: p.purchaseType === 0, ...cuzdanYanit(c) }); }
        if (s === 'var') return yanit(res, 200, { ok: false, durum: 'zaten_kullanildi' });   // jeton başka hesaba yüklenmiş (tüketilir ürünlerde eski davranış)
      }
      return yanit(res, 409, { ok: false, durum: 'hata' });
    } catch (e) { console.log('[cuzdan] yukle hata', e.message); return yanit(res, 502, { ok: false, durum: 'hata' }); }
  });
  app.post('/g/cuzdan/harca', async (req, res) => {
    const o = await ortak(req, res); if (!o) return; const { d, uid } = o; istat.harca++;
    const gs = (DUKKAN.gemSet || {})[d.oge] || null, f = gs ? { gem: gs.gem } : DUKKAN.fiyat[d.oge];   // gs: gemle alınan öğe seti (dukkan.json gemSet: tek işlemde eksik parçalar, fiyat setEksik/setFiyat; en az 2 parça eksik olmalı)
    if (!f || !f.gem || typeof d.islem !== 'string' || d.islem.length < 6 || d.islem.length > 64) return yanit(res, 400, { ok: false, durum: 'gecersiz' });
    try {
      for (let deneme = 0; deneme < 3; deneme++) {
        const w = await oku(uid); const c = klon(w.c);
        if (c.islemler.includes('h:' + d.islem)) return yanit(res, 200, { ok: true, durum: 'zaten', ...cuzdanYanit(c) });
        if (c.borc > 0) return yanit(res, 200, { ok: false, durum: 'borc', borc: c.borc, ...cuzdanYanit(c) });   // iade borcu kapanana kadar gemle alım yok
        const eksik = gs ? setEksik(gs, c.sahip, d.parca) : null, tutar = gs ? setFiyat(gs, eksik) : f.gem;
        if (gs ? eksik.length < 2 : c.sahip.includes(d.oge)) return yanit(res, 200, { ok: false, durum: 'zaten_var', ...cuzdanYanit(c) });
        if (d.fiyat !== undefined && d.fiyat !== tutar) return yanit(res, 200, { ok: false, durum: 'fiyat_degisti', fiyat: tutar, ...cuzdanYanit(c) });   // ekrandaki fiyattan farklı gem düşülmez (fiyat gönderilmezse: eski istemci, denetim yok)
        if (c.gem < tutar) return yanit(res, 200, { ok: false, durum: 'yetersiz', ...cuzdanYanit(c) });
        const alinan = gs ? eksik : [d.oge], simdi = Date.now();
        c.gem -= tutar; c.sahip.push(...alinan); c.islemler.push('h:' + d.islem); c.alim.push(...alinan.map(x => x + '@' + simdi)); c.alim = c.alim.slice(-ALIM_EN_COK);
        if (await yaz(uid, w, c) === 'ok') { console.log(`[cuzdan] -${tutar} gem ${d.oge} ${uid.slice(0, 8)}`); return yanit(res, 200, { ok: true, durum: 'alindi', ...cuzdanYanit(c) }); }
      }
      return yanit(res, 409, { ok: false, durum: 'hata' });
    } catch (e) { console.log('[cuzdan] harca hata', e.message); return yanit(res, 502, { ok: false, durum: 'hata' }); }
  });
  // Kupa yolu / kutu gem kazancı: kimlik başına TEK sefer (odul/<uid>_<id> belgesi exists:false ile, cüzdan yazımıyla aynı commit). Miktarı istemci seçmez:
  //   tur 'yol' id 'y<adım>': gem sunucu tablosundan (kupa.json); adım ilk istekten bu yana erişilebilir üst sınırı (yolTaban + gün*yolGun) aşamaz → 'sinir' (istemci bekler, sonra dener).
  //   tur 'kutu' id 'k<sayaç>' boy kucuk|buyuk: miktarı SUNUCU seçer: sha256(uid:id) ilk 4 bayt → kutuGem[boy] min–max (istemcinin gönderdiği gem yok sayılır); kimlik başına günlük toplam tavanlı → 'limit'.
  //   Yanıt: { ok:true, durum:'verildi'|'zaten', miktar (verilen gem), gem, sahip, ilkPaket } | { ok:false, durum:'gecersiz'|'sinir'|'limit' }
  app.post('/g/cuzdan/odul', async (req, res) => {
    const o = await ortak(req, res); if (!o) return; const { d, uid } = o; istat.odul = (istat.odul || 0) + 1;
    const id = typeof d.id === 'string' ? d.id : ''; let gem = 0, idx = -1;
    if (d.tur === 'hafta') {   // haftalık yol gemisi: id 'w<ISO yıl>-<hafta 2 hane>' (örn w2026-46); miktar kupa.json haftaSeri + cüzdan hs/hw (istemci gönderemez); şimdiki ya da bir önceki ISO hafta (sunucu saati, UTC)
      const m = /^w([0-9]{4})-([0-9]{2})$/.exec(id), simdiH = Date.now(), bu = isoHafta(simdiH), once = isoHafta(simdiH - 7 * 864e5), ileri = isoHafta(simdiH + 14 * 36e5);   /* ileri: UTC+14'e kadar saat dilimi (yerel Pazartesi, UTC hâlâ Pazar) */
      if (!m || !Array.isArray(KUPA.haftaSeri) || !KUPA.haftaSeri.length) return yanit(res, 400, { ok: false, durum: 'gecersiz' });
      if (id !== 'w' + bu && id !== 'w' + once && id !== 'w' + ileri) { const eski = +m[1] * 100 + +m[2] < +bu.replace('-', ''); return eski ? yanit(res, 200, { ok: false, durum: 'suresi_gecti' }) : yanit(res, 400, { ok: false, durum: 'gecersiz' }); }
      gem = 1;   /* yer tutucu: gerçek miktar seriHesap (döngüde) */
    }
    const odId = id.replace(/:/g, '~');   /* Firestore belge kimliği: ':' URL'de özel yöntem ayracı olabilir */
    let efsane = false, hedefKural = '';
    if (d.tur === 'yol') { const m = /^y([0-9]{1,4})$/.exec(id); if (m) { idx = +m[1]; gem = yolGem(idx); } }
    else if (d.tur === 'hedef') { if (id.length <= 64 && /^h_[a-z_]+(:[a-z0-9_]+){1,3}$/.test(id) && Object.hasOwn(KUPA.hedefGem || {}, id.slice(2))) { hedefKural = id.slice(2); gem = KUPA.hedefGem[hedefKural]; } }
    else if (d.tur === 'efsane') { if (/^e[0-9]{1,9}$/.test(id)) { efsane = true; gem = 1; } }
    else if (d.tur === 'kutu') { const m = /^k([0-9]{1,9})$/.exec(id), kb = Object.hasOwn(KUPA.kutuGem, d.boy) ? KUPA.kutuGem[d.boy] : null; if (m && kb) gem = kutuMiktar(uid, id, kb); }
    if (!(gem > 0)) return yanit(res, 400, { ok: false, durum: 'gecersiz' });
    try {
      if (hedefKural || efsane) { const eski = await belgeOku(`odul/${uid}_${odId}`); if (eski) { const w2 = await oku(uid); return yanit(res, 200, { ok: true, durum: 'zaten', miktar: eski.gem || 0, ...(efsane ? { oge: eski.oge || '' } : {}), ...cuzdanYanit(w2.c) }); } }   /* daha önce verilmiş: tavan/limit değil 'zaten' */
      for (let deneme = 0; deneme < 3; deneme++) {
        const w = await oku(uid); const c = klon(w.c); const simdi = Date.now(); const ilk = !c.kt0; if (ilk) c.kt0 = simdi; let n = 0, oge = '';
        if (d.tur === 'hafta') { const sh = seriHesap(c, id.slice(1)); gem = sh.gem; n = sh.n; c.hs = sh.yeniHs; c.hw = sh.yeniHw; }
        if (d.tur === 'yol') {
          const gun = Math.floor((simdi - c.kt0) / 864e5);
          if (idx >= KUPA.yolTaban + KUPA.yolGun * gun || (KUPA.yolUst && idx >= KUPA.yolUst.taban + KUPA.yolUst.gun * gun)) { if (ilk) await yaz(uid, w, c); return yanit(res, 200, { ok: false, durum: 'sinir', ...cuzdanYanit(c) }); }
        } else if (d.tur === 'kutu') {
          const bugun = new Date(simdi).toISOString().slice(0, 10); if (c.kgun !== bugun) { c.kgun = bugun; c.kgem = 0; }
          if (c.kgem + gem > KUPA.gunlukKutuGem) { if (ilk) await yaz(uid, w, c); return yanit(res, 200, { ok: false, durum: 'limit', ...cuzdanYanit(c) }); }
          c.kgem += gem;
        } else if (hedefKural) {
          if (simdi - c.kt0 < ((KUPA.hedefGun || {})[hedefKural] || 1) * 864e5) { if (ilk) await yaz(uid, w, c); return yanit(res, 200, { ok: false, durum: 'sinir', ...cuzdanYanit(c) }); }   /* hesap yaşı: hedef en erken ceil(N/hız) gün sonra */
          const bugun = new Date(simdi).toISOString().slice(0, 10); if (c.hgun !== bugun) { c.hgun = bugun; c.hsay = 0; }
          if (c.hsay >= (KUPA.gunlukHedef || 3)) { if (ilk) await yaz(uid, w, c); return yanit(res, 200, { ok: false, durum: 'sinir', ...cuzdanYanit(c) }); }
          c.hsay++;
        } else if (efsane) {
          if (c.borc > 0 || simdi - c.kt0 < (KUPA.efsaneIlkGun || 30) * 864e5) { if (ilk) await yaz(uid, w, c); return yanit(res, 200, { ok: false, durum: 'sinir', ...cuzdanYanit(c) }); }
          if (c.et && simdi - c.et < (KUPA.efsaneGun || 30) * 864e5) { if (ilk) await yaz(uid, w, c); return yanit(res, 200, { ok: false, durum: 'limit', ...cuzdanYanit(c) }); }
          oge = efsaneSec(uid, id, c); if (!oge) { if (ilk) await yaz(uid, w, c); return yanit(res, 400, { ok: false, durum: 'gecersiz' }); }
          c.sahip.push(oge); c.et = simdi; gem = 0;
        }
        if (gem > 0) gemGiris(c, gem);
        const s = await yaz(uid, w, c, [{ yol: `odul/${uid}_${odId}`, alan: { uid, tur: d.tur, id, gem, t: simdi, ...(n ? { n } : {}), ...(oge ? { oge } : {}) } }]);
        if (s === 'ok') { console.log(`[cuzdan] +${gem} gem ${d.tur} ${id} ${uid.slice(0, 8)}`); if (oge) istat.odulEfsane++; if (gem > 0) odulIzle(uid, d.tur, gem, simdi, KUPA.odulIzleme); return yanit(res, 200, { ok: true, durum: 'verildi', miktar: gem, ...(n ? { n } : {}), ...(oge ? { oge } : {}), ...cuzdanYanit(c) }); }
        if (s === 'var') { const w2 = await oku(uid); if (w2.var !== w.var || w2.updateTime !== w.updateTime) continue; const eski = await belgeOku(`odul/${uid}_${odId}`); return yanit(res, 200, { ok: true, durum: 'zaten', miktar: eski ? (eski.gem || 0) : gem, ...(eski && eski.n ? { n: eski.n } : {}), ...(eski && eski.oge ? { oge: eski.oge } : {}), ...cuzdanYanit(w2.c) }); }   // cüzdan değişmedi → bu kimlik daha önce verilmiş
      }
      return yanit(res, 409, { ok: false, durum: 'hata' });
    } catch (e) { console.log('[cuzdan] odul hata', e.message); return yanit(res, 502, { ok: false, durum: 'hata' }); }
  });
  return { istat };
}
/** Sunucu içi: öğeleri oyuncunun sunucu envanterine ekle (lig sezon ödülü). Çakışmada yeniden dener. */
async function ogeEkle(uid, ogeler) {
  for (let d = 0; d < 3; d++) {
    const w = await oku(uid); const c = klon(w.c); let yeni = false;
    for (const o of ogeler) if (!c.sahip.includes(o)) { c.sahip.push(o); yeni = true; }
    if (!yeni) return true; if (await yaz(uid, w, c) === 'ok') return true;
  }
  return false;
}
/** Play iadesi / ters ibrazı sonrası gem geri alma (g_iade.js ve RTDN çağırır). iz = sha256(jeton) hex. → { durum: alindi | zaten | kayit_yok | urun_yok | cuzdan_yok, gem?, eksik? }
 *  Geri alınan yalnız satin/<iz>.verilen (gerçekten verilen gem dahil iade + yeni eklenen öğeler); verilen yoksa (eski kayıt) paket tablosu. Geri alınamayan gem borca yazılır; borcT = borca yol açan en eski iade edilmiş satın almanın zamanı (kilit buna bakar). */
async function iadeUygula(iz, kayit = {}) {
  const satin = await belgeOku(`satin/${iz}`); if (!satin) return { durum: 'kayit_yok' };   // cüzdandan geçmeyen satın alma (örn. Reklamları Kaldır)
  const gp = GEM_PAKET.get(satin.urun); if (!gp) return { durum: 'urun_yok' };
  /* Y1: gem geri alma ve borç, gemi alan hesaptan (ilkUid; hiç değişmez); paket öğeleri şimdiki sahipten (uid). ilkUid yoksa eski kayıt: uid. */
  const pkUid = typeof satin.uid === 'string' ? satin.uid : '', uid = typeof satin.ilkUid === 'string' ? satin.ilkUid : pkUid;
  if (!uid && pkUid) {   /* ilk sahip hesabını silmiş (ilkUid boşaltıldı), ürün başka hesaba taşınmış: gem silinen hesapla gitti; şimdiki sahipten yalnız paket öğeleri düşer */
    const ogV0 = new Set(satin.verilen && typeof satin.verilen === 'object' ? satin.verilen.ogeler || [] : gp.ogeler || []);
    for (let deneme = 0; deneme < 3; deneme++) {
      const wp = await oku(pkUid); if (!wp.var) return { durum: 'cuzdan_yok' };
      const cp = klon(wp.c); const ogP = new Set([...ogV0, ...(cp.goc || []).filter(x => (gp.ogeler || []).includes(x))]);
      cp.sahip = cp.sahip.filter(x => !ogP.has(x)); cp.goc = (cp.goc || []).filter(x => !ogP.has(x)); if (gp.tekSefer) cp.tek = cp.tek.filter(x => x !== gp.urun);
      const s2 = await yaz(pkUid, wp, cp, [{ yol: `iade/${iz}`, alan: { uid: pkUid, urun: satin.urun, gem: 0, eksik: 0, t: Date.now(), siparis: kayit.orderId || '', kaynak: kayit.voidedSource ?? '', neden: kayit.voidedReason ?? '' } }]);
      if (s2 === 'ok') { console.log(`[cuzdan] IADE (taşınmış, ilk sahip silinmiş) öğeler düşüldü ${satin.urun} ${String(pkUid).slice(0, 8)}`); return { durum: 'alindi', gem: 0, eksik: 0 }; }
      if (s2 === 'var') return { durum: 'zaten' };
    }
    throw new Error('iade cakisma');
  }
  if (!uid) return { durum: 'cuzdan_yok' };   // hesap silinmiş: satin belgesi anonimleştirildi (uid/ilkUid boş)
  const v = satin.verilen && typeof satin.verilen === 'object' ? satin.verilen : null;
  const gemV = v ? (v.olcek > 0 && v.olcek !== OLCEK ? olcekCevir(v.gem, v.olcek) : (v.gem || 0)) : gp.gem, ogV = new Set(v ? v.ogeler || [] : gp.ogeler || []);
  for (let deneme = 0; deneme < 3; deneme++) {
    const w = await oku(uid); if (!w.var) return { durum: 'cuzdan_yok' };   // silinmiş hesap: cüzdan yaratma
    const c = klon(w.c);
    /* düşülecek öğeler = verilen.ogeler (ogV) + paketin göçle eklenmiş öğeleri (c.goc ∩ gp.ogeler); önceden sahip olunan / sonradan başka yolla alınan öğeye dokunulmaz */
    const ogD = new Set([...ogV, ...(c.goc || []).filter(x => (gp.ogeler || []).includes(x))]); c.goc = (c.goc || []).filter(x => !ogD.has(x));
    const al = Math.min(c.gem, gemV), eksik = gemV - al; c.gem -= al; c.borc = (c.borc || 0) + eksik;   /* geri alınamayan kısım borç: sonraki gem girişlerinden düşülür */
    if (eksik > 0) { const t = +satin.t > 0 ? +satin.t : Date.now(); c.borcT = c.borcT > 0 ? Math.min(c.borcT, t) : t; }
    const ek = [{ yol: `iade/${iz}`, alan: { uid, urun: satin.urun, gem: al, eksik, t: Date.now(), siparis: kayit.orderId || '', kaynak: kayit.voidedSource ?? '', neden: kayit.voidedReason ?? '' } }];
    if (pkUid && pkUid !== uid) {
      const wp = await oku(pkUid);
      if (wp.var) { const cp = klon(wp.c); const ogP = new Set([...ogV, ...(cp.goc || []).filter(x => (gp.ogeler || []).includes(x))]); cp.sahip = cp.sahip.filter(x => !ogP.has(x)); cp.goc = (cp.goc || []).filter(x => !ogP.has(x)); if (gp.tekSefer) cp.tek = cp.tek.filter(x => x !== gp.urun); ek.push({ yol: 'cuzdan/' + pkUid, alan: cuzdanAlan(cp), kosul: { updateTime: wp.updateTime } }); }
    } else { c.sahip = c.sahip.filter(x => !ogD.has(x)); if (gp.tekSefer) c.tek = c.tek.filter(x => x !== gp.urun); }
    const s = await yaz(uid, w, c, ek);
    if (s === 'ok') { console.log(`[cuzdan] IADE -${al} gem (eksik ${eksik}) ${satin.urun} ${String(uid).slice(0, 8)}`); return { durum: 'alindi', gem: al, eksik }; }
    if (s === 'var') return { durum: 'zaten' };
  }
  throw new Error('iade cakisma');
}
module.exports = { odulIzle, _odulHiz: odulHiz, haftaMs, seriHesap, efsaneSec, EFSANE_ADAY, isoHafta, setGoc, kur, iadeUygula, gemGiris, yolGem, kimlikDogrula, erisimJetonu, istat, ogeEkle, kutuMiktar, olcekle, coz, _bellek: bellek };
