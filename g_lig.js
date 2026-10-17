// ============================================================================
// BEDLAM Godot — dereceli lig (Faz 7.6, K2; godot/LIG.md). Puan, lig ve sıra SUNUCUDA; istemci yalnız sonuç bildirir.
// Veri: lig.json (godot/veri/lig.json kopyası). Depo: Firestore lig/<uid> (yönetici) ya da SAHTE_CUZDAN=1'de bellek (yalnız yerel test).
//
// Sinyalleşme (server.js /g/sig çağırır):
//   → {t:'ara', dereceli:1, kimlik}   kimlik = Firebase ID jetonu → uygunluk (sart: maç sayısı, Play bağlı), ceza, puan → dereceli kuyruk
//   ← {t:'kuyruk', bekleyen, dereceli:1} | {t:'hata', neden:'kimlik'|'uygun_degil'|'ceza', kalanSn?} | {t:'esles', ..., macId, dereceli:1}
// HTTP (v1):
//   POST /g/sonuc { v:1, kimlik, macId, kazanan (oyuncu 0|1), hashlar:[[tik, "hex16"], …] (son ≤ 8 onaylı hash) }
//        → iki bildirim gelene dek en çok sonucBeklemeSn bekler (uzun yoklama) → { v:1, ok, durum: sayildi|sayilmadi|..., puan, degisim, lig }
//        Kural: iki taraf aynı kazanan + ortak tiklerde aynı hash → Elo; çelişki → yazılmaz; tek bildirim + maç sırasında kopma görüldü → kopan kaybeder.
//   POST /g/lig   { v:1, kimlik, tablo? } → { v:1, ok, ben:{puan, lig, mac, galibiyet, gecici, cezaBitis, enYuksekLig}, sezon:{id, bitis}, tablo?:[ilk 50] }
// Sezon: saatte bir kontrol; bitiş geçtiyse her oyuncuya ulaştığı en yüksek ligin ödülü (g_cuzdan.ogeEkle) + puan yumuşak sıfırlama.
// ============================================================================
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path'), express = require('express');
const { kimlikDogrula, ogeEkle } = require('./g_cuzdan');

const LIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'lig.json'), 'utf8'));
const PROJE = process.env.FIREBASE_PROJE || 'bedlam-94bfc';
const FS_AD = `projects/${PROJE}/databases/(default)/documents`, FS = 'https://firestore.googleapis.com/v1/' + FS_AD;
const sahte = () => process.env.SAHTE_CUZDAN === '1';

// ---- yönetici erişimi ----
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let erisim = null;
async function jeton() {
  if (erisim && erisim.bitis > Date.now() + 60000) return erisim.jeton;
  const sa = JSON.parse(process.env.FIREBASE_SERVIS_JSON); const t = Math.floor(Date.now() / 1000);
  const bas = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), iddia = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600 }));
  const imza = b64url(crypto.createSign('RSA-SHA256').update(bas + '.' + iddia).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + bas + '.' + iddia + '.' + imza });
  if (!r.ok) throw new Error('oauth ' + r.status); const j = await r.json(); erisim = { jeton: j.access_token, bitis: Date.now() + (j.expires_in || 3600) * 1000 }; return erisim.jeton;
}

// ---- depo: lig/<uid> ----
const VARSAYILAN = () => ({ ad: '', etiket: '', puan: LIG.puan.baslangic, mac: 0, galibiyet: 0, sezon: LIG.sezon.id, enYuksekLig: 'bronz', cezaBitis: 0, kopmalar: [] });
const bellek = new Map(); let bellekSurum = 0;
const deger = v => typeof v === 'number' ? { integerValue: String(Math.round(v)) } : Array.isArray(v) ? { arrayValue: { values: v.map(x => ({ integerValue: String(x) })) } } : { stringValue: String(v) };
function coz(f) {
  const l = VARSAYILAN(); if (!f) return l;
  for (const k of ['ad', 'etiket', 'sezon', 'enYuksekLig']) if (f[k]?.stringValue != null) l[k] = f[k].stringValue;
  for (const k of ['puan', 'mac', 'galibiyet', 'cezaBitis']) if (f[k]?.integerValue != null) l[k] = +f[k].integerValue;
  l.kopmalar = (f.kopmalar?.arrayValue?.values || []).map(x => +x.integerValue); return l;
}
async function oku(uid) {
  if (sahte()) { const d = bellek.get(uid); return d ? { var: true, u: d.u, l: JSON.parse(JSON.stringify(d.l)) } : { var: false, l: VARSAYILAN() }; }
  const r = await fetch(`${FS}/lig/${uid}`, { headers: { Authorization: 'Bearer ' + await jeton() } });
  if (r.status === 404) return { var: false, l: VARSAYILAN() }; if (!r.ok) throw new Error('lig oku ' + r.status);
  const d = await r.json(); return { var: true, u: d.updateTime, l: coz(d.fields) };
}
async function yaz(uid, onceki, l) {
  if (sahte()) { const d = bellek.get(uid); if (onceki.var ? (!d || d.u !== onceki.u) : !!d) return false; bellek.set(uid, { u: 'b' + (++bellekSurum), l: JSON.parse(JSON.stringify(l)) }); return true; }
  const f = {}; for (const [k, v] of Object.entries(l)) f[k] = deger(v);
  const r = await fetch(`${FS}:commit`, { method: 'POST', headers: { Authorization: 'Bearer ' + await jeton(), 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: [{ update: { name: `${FS_AD}/lig/${uid}`, fields: f }, currentDocument: onceki.var ? { updateTime: onceki.u } : { exists: false } }] }) });
  if (r.ok) return true; if (r.status === 409 || r.status === 400 || r.status === 412) return false; throw new Error('lig yaz ' + r.status);
}
/** oku → değiştir → ön koşullu yaz (çakışmada 3 deneme). */
async function guncelle(uid, f) { for (let d = 0; d < 3; d++) { const w = await oku(uid); const l = w.l; f(l); if (await yaz(uid, w, l)) return l; } throw new Error('lig çakışma'); }
async function tablo() {
  if (sahte()) return [...bellek.entries()].map(([uid, d]) => ({ uid, ...d.l })).sort((a, b) => b.puan - a.puan).slice(0, 50).map(Satir);
  const q = { structuredQuery: { from: [{ collectionId: 'lig' }], orderBy: [{ field: { fieldPath: 'puan' }, direction: 'DESCENDING' }], limit: 50 } };
  const r = await fetch(`${FS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + await jeton(), 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  if (!r.ok) throw new Error('tablo ' + r.status);
  return (await r.json()).filter(e => e.document).map(e => Satir({ uid: e.document.name.split('/').pop(), ...coz(e.document.fields) }));
}
const Satir = l => ({ ad: l.ad, etiket: l.etiket, puan: l.puan, lig: ligBul(l.puan).id });

// ---- kurallar ----
function ligBul(puan) { let s = LIG.ligler[0]; for (const l of LIG.ligler) if (puan >= l.esik) s = l; return s; }
/** Elo: beklenen E = 1/(1+10^((Rb−Ra)/400)), ΔR = K·(S−E); geçici (ilk geciciMac maç) K büyük; taban altına inmez. */
function elo(ra, rb, kazandi, gecici) { const E = 1 / (1 + Math.pow(10, (rb - ra) / 400)); const K = gecici ? LIG.puan.kGecici : LIG.puan.kNormal; return Math.round(K * ((kazandi ? 1 : 0) - E)); }
/** Lig düşüşü koruması: önceki lig eşiğinin dusmeKorumasi altına inmeden düşmez (puan yine yazılır, gösterilen lig korunur). */
function gosterilenLig(oncekiLig, puan) { const yeni = ligBul(puan); const o = LIG.ligler.find(x => x.id === oncekiLig); if (o && yeni.esik < o.esik && puan >= o.esik - LIG.puan.dusmeKorumasi) return o; return yeni; }
function cezaDk(kopmaSayisi) { const c = LIG.ceza.kopmaDk; return c[Math.min(c.length - 1, Math.max(0, kopmaSayisi - 1))]; }
function hashUyumlu(a, b) {
  const ma = new Map((a || []).filter(x => Array.isArray(x) && x.length === 2).map(x => [x[0] | 0, String(x[1])])); let ortak = 0;
  for (const x of (b || [])) { if (!Array.isArray(x) || !ma.has(x[0] | 0)) continue; ortak++; if (ma.get(x[0] | 0) !== String(x[1])) return false; }
  return ortak >= 1;
}
async function uygun(uid) {
  if (sahte() || process.env.LIG_SART_ATLA === '1') return { ok: true };
  const t = await jeton();
  const r = await fetch(`${FS}/kullanici/${uid}`, { headers: { Authorization: 'Bearer ' + t } }); let mac = 0;
  if (r.ok) { try { const p = JSON.parse((await r.json()).fields?.profil?.stringValue || '{}'); mac = p.profilv?.Toplam?.Mac | 0; } catch (e) {} }
  if (mac < LIG.sart.mac) return { ok: false, neden: 'uygun_degil', mac, gerek: LIG.sart.mac };
  if (LIG.sart.play) {
    const a = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJE}/accounts:lookup`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: [uid] }) });
    const u = a.ok ? (await a.json()).users?.[0] : null; if (!u || !(u.providerUserInfo || []).some(p => p.providerId === 'playgames.google.com')) return { ok: false, neden: 'uygun_degil', play: false };
  }
  return { ok: true };
}

// ---- kuyruk ve maçlar ----
let kuyruk = []; const maclar = new Map(); const ciftGun = new Map(); const istat = { dereceliMac: 0, sayildi: 0, sayilmadi: 0, kopma: 0 };
function kur(app, s) {   // s: { gonder(ws, o), uyumlu(a, b), odaBaslat(wsA, wsB, ek) }
  async function araIstek(ws, d) {
    let uid; try { uid = await kimlikDogrula(d.kimlik); } catch (e) { s.gonder(ws, { t: 'hata', neden: 'kimlik' }); return; }
    try {
      const u = await uygun(uid); if (!u.ok) { s.gonder(ws, { t: 'hata', neden: u.neden, mac: u.mac, gerek: u.gerek, play: u.play }); return; }
      const w = await oku(uid); const simdi = Date.now();
      if (w.l.cezaBitis > simdi) { s.gonder(ws, { t: 'hata', neden: 'ceza', kalanSn: Math.ceil((w.l.cezaBitis - simdi) / 1000) }); return; }
      kuyruk = kuyruk.filter(e => e.ws !== ws && e.uid !== uid);
      ws._ligUid = uid; ws._ligPuan = w.l.puan;
      if (!w.var) await guncelle(uid, l => { l.ad = ws._ad || ''; l.etiket = ws._kimlik || ''; });
      kuyruk.push({ ws, uid, puan: w.l.puan, t0: simdi });
      for (const e of kuyruk) s.gonder(e.ws, { t: 'kuyruk', bekleyen: kuyruk.length, dereceli: 1 });
      eslestir();
    } catch (e) { console.log('[lig] ara hata', e.message); s.gonder(ws, { t: 'hata', neden: 'sunucu' }); }
  }
  function cik(ws) { const n = kuyruk.length; kuyruk = kuyruk.filter(e => e.ws !== ws); return n !== kuyruk.length; }
  function eslestir(simdi = Date.now()) {
    const E = LIG.eslesme; const gun = new Date(simdi).toISOString().slice(0, 10);
    for (let i = 0; i < kuyruk.length; i++) {
      const a = kuyruk[i];
      const b = kuyruk.find(c => {
        if (c === a || c.uid === a.uid || !s.uyumlu(a.ws, c.ws)) return false;
        const bekle = (simdi - Math.min(a.t0, c.t0)) / 1000, pencere = Math.min(E.enFazla, E.pencere + E.genisleme * Math.floor(bekle / E.genislemeSn));
        if (Math.abs(a.puan - c.puan) > pencere) return false;
        return (ciftGun.get([a.uid, c.uid].sort().join('|') + '|' + gun) || 0) < E.ayniCiftGunluk;
      });
      if (!b) continue;
      kuyruk = kuyruk.filter(e => e !== a && e !== b);
      const anahtar = [a.uid, b.uid].sort().join('|') + '|' + gun; ciftGun.set(anahtar, (ciftGun.get(anahtar) || 0) + 1);
      const macId = crypto.randomBytes(9).toString('base64url');
      maclar.set(macId, { uids: [a.uid, b.uid], puan: [a.puan, b.puan], t0: simdi, rapor: {}, bekleyen: [], kopan: null, bitti: false });
      a.ws._ligMac = macId; b.ws._ligMac = macId; istat.dereceliMac++;
      s.odaBaslat(a.ws, b.ws, { macId, dereceli: 1 });
      i = -1;
    }
  }
  /** Sinyalleşme bağlantısı koptu: kuyruktan çık; dereceli maç sonuçlanmadıysa kopma kaydı (kopan kaybeder kuralı). */
  function kopma(ws) {
    cik(ws); const m = ws._ligMac && maclar.get(ws._ligMac); if (!m || m.bitti || m.kopan) return;
    if (Object.keys(m.rapor).length === 0) { m.kopan = ws._ligUid; m.kopmaT = Date.now(); istat.kopma++; }
  }
  setInterval(() => { eslestir(); const t = Date.now(); for (const [id, m] of maclar) if (t - m.t0 > 3 * 3600 * 1000) maclar.delete(id); }, 1000).unref?.();

  async function karar(macId, m) {
    if (m.bitti) return m.sonuc; m.bitti = true;
    const [ua, ub] = m.uids, ra = m.rapor[ua], rb = m.rapor[ub]; let kazananUid = null, durum = 'sayilmadi';
    if (ra && rb) {
      if (ra.kazanan === rb.kazanan && (ra.kazanan === 0 || ra.kazanan === 1) && hashUyumlu(ra.hashlar, rb.hashlar)) { kazananUid = m.uids[ra.kazanan]; durum = 'sayildi'; }
      else console.log('[lig] çelişki', macId, ra.kazanan, rb.kazanan);
    } else if (m.kopan && (ra || rb)) {
      const bildiren = ra ? ua : ub; if (m.kopan !== bildiren) { kazananUid = bildiren; durum = 'sayildi'; }
    }
    const sonuc = { durum, degisim: {}, puan: {}, lig: {} };
    if (durum === 'sayildi') {
      const kaybeden = m.uids.find(u => u !== kazananUid);
      const [la, lb] = [await oku(m.uids[0]), await oku(m.uids[1])];
      for (const [i, u] of m.uids.entries()) {
        const ben = i === 0 ? la.l : lb.l, o = i === 0 ? lb.l : la.l, kazandi = u === kazananUid;
        const d = elo(ben.puan, o.puan, kazandi, ben.mac < LIG.puan.geciciMac); sonuc.degisim[u] = d;
        const l = await guncelle(u, x => {
          const onceki = ligBul(x.puan).id; x.puan = Math.max(LIG.puan.taban, x.puan + d); x.mac++; if (kazandi) x.galibiyet++;
          const g = gosterilenLig(onceki, x.puan); if (LIG.ligler.findIndex(z => z.id === g.id) > LIG.ligler.findIndex(z => z.id === x.enYuksekLig)) x.enYuksekLig = g.id;
          if (u === kaybeden && m.kopan === u) { const t = Date.now(); x.kopmalar = [...x.kopmalar.filter(k => t - k < LIG.ceza.kopmaPencereSaat * 3600 * 1000), t]; x.cezaBitis = t + cezaDk(x.kopmalar.length) * 60000; }
        });
        sonuc.puan[u] = l.puan; sonuc.lig[u] = ligBul(l.puan).id;
      }
      istat.sayildi++;
    } else istat.sayilmadi++;
    m.sonuc = sonuc; for (const f of m.bekleyen) f(sonuc); m.bekleyen = []; return sonuc;
  }

  app.use('/g/sonuc', express.json({ limit: '4kb' })); app.use('/g/lig', express.json({ limit: '2kb' }));
  app.post('/g/sonuc', async (req, res) => {
    res.set('Cache-Control', 'no-store'); const d = req.body || {};
    if (d.v !== 1) return res.status(400).json({ v: 1, ok: false, durum: 'surum', destek: [1] });
    let uid; try { uid = await kimlikDogrula(d.kimlik); } catch { return res.status(401).json({ v: 1, ok: false, durum: 'kimlik' }); }
    const m = maclar.get(String(d.macId || '')); if (!m || !m.uids.includes(uid)) return res.status(404).json({ v: 1, ok: false, durum: 'mac_yok' });
    if (!m.rapor[uid]) m.rapor[uid] = { kazanan: Number.isInteger(d.kazanan) ? d.kazanan : -1, hashlar: Array.isArray(d.hashlar) ? d.hashlar.slice(0, 8) : [] };
    let yanitlandi = false;
    const yanit = sn => { if (yanitlandi) return; yanitlandi = true; const o = { v: 1, ok: true, durum: sn.durum, degisim: sn.degisim[uid] ?? 0, puan: sn.puan[uid] ?? null, lig: sn.lig[uid] ?? null }; res.json(o); };
    if (m.bitti) return yanit(m.sonuc);
    if (Object.keys(m.rapor).length === 2) return yanit(await karar(d.macId, m));
    // bekleyenler karar verilince (ikinci bildirim ya da zaman aşımı) tek noktadan yanıtlanır; zamanlayıcı yalnız kararı tetikler
    const zaman = setTimeout(() => { karar(d.macId, m).catch(e => console.log('[lig] karar hata', e.message)); }, (LIG.sonucBeklemeSn || 30) * 1000);
    m.bekleyen.push(sn => { clearTimeout(zaman); yanit(sn); });
  });
  app.post('/g/lig', async (req, res) => {
    res.set('Cache-Control', 'no-store'); const d = req.body || {};
    if (d.v !== 1) return res.status(400).json({ v: 1, ok: false, durum: 'surum', destek: [1] });
    if (!process.env.FIREBASE_SERVIS_JSON && !sahte()) return res.status(503).json({ v: 1, ok: false, durum: 'dogrulayici_yok' });
    let uid; try { uid = await kimlikDogrula(d.kimlik); } catch { return res.status(401).json({ v: 1, ok: false, durum: 'kimlik' }); }
    try {
      const w = await oku(uid); const l = w.l; const g = ligBul(l.puan);
      const o = { v: 1, ok: true, ben: { puan: l.puan, lig: g.id, mac: l.mac, galibiyet: l.galibiyet, gecici: l.mac < LIG.puan.geciciMac, cezaBitis: l.cezaBitis, enYuksekLig: l.enYuksekLig }, sezon: { id: LIG.sezon.id, bitis: LIG.sezon.bitis } };
      if (d.tablo) o.tablo = await tablo();
      res.json(o);
    } catch (e) { res.status(502).json({ v: 1, ok: false, durum: 'hata' }); }
  });
  return { istat, araIstek, cik, kopma, eslestir };
}

/** Sezon kapanışı (bitiş geçtiyse, bir kez): en yüksek ligin ödülü sunucu envanterine, puan yumuşak sıfırlama. Dönüş: işlenen oyuncu sayısı. */
async function sezonKapat(simdi = Date.now()) {
  if (simdi < Date.parse(LIG.sezon.bitis + 'T23:59:59Z')) return 0;
  const uidler = sahte() ? [...bellek.keys()] : (await (await fetch(`${FS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + await jeton(), 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'lig' }], where: { fieldFilter: { field: { fieldPath: 'sezon' }, op: 'EQUAL', value: { stringValue: LIG.sezon.id } } }, limit: 1000 } }) })).json()).filter(e => e.document).map(e => e.document.name.split('/').pop());
  let n = 0;
  for (const uid of uidler) {
    const w = await oku(uid); if (w.l.sezon !== LIG.sezon.id) continue;
    await ogeEkle(uid, LIG.odul[w.l.enYuksekLig] || []);
    await guncelle(uid, x => { x.puan = Math.round(LIG.puan.baslangic + (x.puan - LIG.puan.baslangic) * LIG.sezon.sifirlama); x.sezon = LIG.sezon.id + '-kapandi'; x.enYuksekLig = ligBul(x.puan).id; });
    n++;
  }
  if (n) console.log('[lig] sezon kapandı', LIG.sezon.id, n, 'oyuncu');
  return n;
}
if (process.env.NODE_ENV !== 'test') setInterval(() => sezonKapat().catch(e => console.log('[lig] sezon hata', e.message)), 3600 * 1000).unref?.();

module.exports = { kur, sezonKapat, elo, ligBul, gosterilenLig, hashUyumlu, cezaDk, istat, _bellek: bellek, LIG };
