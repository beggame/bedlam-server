// ============================================================================
// BEDLAM Godot — gem cüzdanı (Faz 7.7; godot/EKONOMI.md). server.js: require('./g_cuzdan').kur(app)
// Gem gerçek parayla (Play test ürünü) alındığı için bakiye SUNUCUDA: Firestore cuzdan/<uid> (istemci kuralı: okuma/yazma yok, yalnız yönetici).
// Coin oynayarak kazanılır ve istemcide kalır (hile yalnız oyuncunun kendi kozmetiğini etkiler; güç veren ürün yok).
//
// Protokol v1 (gövde JSON; "kimlik" = Firebase ID jetonu, imzası Google sertifikalarıyla doğrulanır):
//   POST /g/cuzdan        { v:1, kimlik }                          → { v:1, ok, gem, sahip[], ilkPaket }
//   POST /g/cuzdan/yukle  { v:1, kimlik, paket, urun, jeton }      → gem paketi: Play doğrulaması + jeton başına TEK yükleme (satin/<sha256>)
//   POST /g/cuzdan/harca  { v:1, kimlik, oge, islem }              → gemle öğe: fiyat sunucu kataloğundan (dukkan.json), işlem kimliğiyle TEK harcama
//   Hata: { v:1, ok:false, durum: surum | kimlik | gecersiz | yetersiz | zaten_var | tek_sefer | gercek_kapali | bekliyor | iptal | dogrulayici_yok | hata }
// Eşzamanlılık: her yazım Firestore commit + currentDocument (updateTime / exists:false) ön koşuluyla; çakışmada 3 kez yeniden dener (çift harcama yok).
// Ortam: FIREBASE_SERVIS_JSON (yönetici), PLAY_SERVIS_JSON (Play doğrulaması, g_magaza.js), GERCEK_SATIN (kapalı: yalnız test satın alması).
// ============================================================================
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path'), express = require('express');
const { playDogrula } = require('./g_magaza');

const PROJE = process.env.FIREBASE_PROJE || 'bedlam-94bfc';
const FS_AD = `projects/${PROJE}/databases/(default)/documents`, FS = 'https://firestore.googleapis.com/v1/' + FS_AD;
const DUKKAN = JSON.parse(fs.readFileSync(path.join(__dirname, 'dukkan.json'), 'utf8'));
const URUN = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, 'urunler.json'), 'utf8')).urunler.map(u => [u.id, u]));
const PAKETLER = JSON.parse(fs.readFileSync(path.join(__dirname, 'urunler.json'), 'utf8')).paket;
const GEM_PAKET = new Map(DUKKAN.gemPaket.map(p => [p.urun, p]));

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
const deger = v => typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(x => ({ stringValue: String(x) })) } } : { stringValue: String(v) };
const coz = f => ({ gem: +(f?.gem?.integerValue || 0), sahip: (f?.sahip?.arrayValue?.values || []).map(x => x.stringValue), islemler: (f?.islemler?.arrayValue?.values || []).map(x => x.stringValue), ilkPaket: !!f?.ilkPaket?.booleanValue });
// SAHTE_CUZDAN=1: YALNIZ YEREL GELİŞTİRME — Firestore yerine bellek deposu (aynı ön koşul anlamı); kimlik doğrulaması gerçek kalır. Render'da ASLA açılmaz.
const bellek = new Map(); let bellekSurum = 0;
async function oku(uid) {
  if (process.env.SAHTE_CUZDAN === '1') { const d = bellek.get('cuzdan/' + uid); return d ? { var: true, updateTime: d.updateTime, c: coz(d.fields) } : { var: false, c: coz({}) }; }
  const t = await erisimJetonu(); const r = await fetch(`${FS}/cuzdan/${uid}`, { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 404) return { var: false, c: coz({}) }; if (!r.ok) throw new Error('oku ' + r.status);
  const d = await r.json(); return { var: true, updateTime: d.updateTime, c: coz(d.fields) };
}
/** Ön koşullu yazım; çakışmada false döner (çağıran yeniden okur). ek: aynı commit'te oluşturulacak ek belgeler (exists:false). */
async function yaz(uid, onceki, c, ek = []) {
  if (process.env.SAHTE_CUZDAN === '1') {
    const d = bellek.get('cuzdan/' + uid); if (onceki.var ? (!d || d.updateTime !== onceki.updateTime) : !!d) return 'cakisma';
    for (const e of ek) if (bellek.has(e.yol)) return 'var';
    bellek.set('cuzdan/' + uid, { fields: { gem: deger(c.gem), sahip: deger(c.sahip), islemler: deger(c.islemler.slice(-50)), ilkPaket: deger(c.ilkPaket) }, updateTime: 'b' + (++bellekSurum) });
    for (const e of ek) bellek.set(e.yol, {}); return 'ok';
  }
  const t = await erisimJetonu();
  const writes = [{ update: { name: `${FS_AD}/cuzdan/${uid}`, fields: { gem: deger(c.gem), sahip: deger(c.sahip), islemler: deger(c.islemler.slice(-50)), ilkPaket: deger(c.ilkPaket) } }, currentDocument: onceki.var ? { updateTime: onceki.updateTime } : { exists: false } }];
  for (const e of ek) writes.push({ update: { name: `${FS_AD}/${e.yol}`, fields: Object.fromEntries(Object.entries(e.alan).map(([k, v]) => [k, deger(v)])) }, currentDocument: { exists: false } });
  const r = await fetch(`${FS}:commit`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  if (r.ok) return 'ok'; if (r.status === 409 || r.status === 400 || r.status === 412) { const j = await r.json().catch(() => ({})); return /ALREADY_EXISTS|already exists/i.test(JSON.stringify(j)) ? 'var' : 'cakisma'; }
  throw new Error('yaz ' + r.status);
}

const istat = { yukle: 0, harca: 0, red: 0 };
function kur(app, secenek = {}) {
  const dogrula = secenek.dogrula || playDogrula;
  app.use('/g/cuzdan', express.json({ limit: '8kb' }));
  const yanit = (res, kod, o) => { if (o.ok === false) istat.red++; res.status(kod).json({ v: 1, ...o }); };
  async function ortak(req, res) {
    res.set('Cache-Control', 'no-store'); const d = req.body || {};
    if (d.v !== 1) { yanit(res, 400, { ok: false, durum: 'surum', destek: [1] }); return null; }
    if (!process.env.FIREBASE_SERVIS_JSON && process.env.SAHTE_CUZDAN !== '1') { yanit(res, 503, { ok: false, durum: 'dogrulayici_yok' }); return null; }
    try { return { d, uid: await kimlikDogrula(d.kimlik) }; } catch (e) { yanit(res, 401, { ok: false, durum: 'kimlik' }); return null; }
  }
  const cuzdanYanit = c => ({ gem: c.gem, sahip: c.sahip, ilkPaket: c.ilkPaket });
  app.post('/g/cuzdan', async (req, res) => {
    const o = await ortak(req, res); if (!o) return;
    try { const w = await oku(o.uid); yanit(res, 200, { ok: true, ...cuzdanYanit(w.c) }); } catch (e) { yanit(res, 502, { ok: false, durum: 'hata' }); }
  });
  app.post('/g/cuzdan/yukle', async (req, res) => {
    const o = await ortak(req, res); if (!o) return; const { d, uid } = o; istat.yukle++;
    const u = URUN.get(d.urun), gp = GEM_PAKET.get(d.urun);
    if (!u || u.tur !== 'tuketilir' || !gp || typeof d.jeton !== 'string' || d.jeton.length < 8 || d.jeton.length > 4096 || !PAKETLER.includes(d.paket)) return yanit(res, 400, { ok: false, durum: 'gecersiz' });
    try {
      const p = await dogrula(d.paket, d.urun, d.jeton);
      if (p.dogrulayiciYok) return yanit(res, 503, { ok: false, durum: 'dogrulayici_yok' });
      if (p.yok) return yanit(res, 200, { ok: false, durum: 'gecersiz' });
      if (p.purchaseType !== 0 && process.env.GERCEK_SATIN !== '1') return yanit(res, 200, { ok: false, durum: 'gercek_kapali' });
      if (p.purchaseState === 2) return yanit(res, 200, { ok: false, durum: 'bekliyor' }); if (p.purchaseState !== 0) return yanit(res, 200, { ok: false, durum: 'iptal' });
      const iz = crypto.createHash('sha256').update(d.jeton).digest('hex');
      for (let deneme = 0; deneme < 3; deneme++) {
        const w = await oku(uid); const c = { ...w.c, sahip: [...w.c.sahip], islemler: [...w.c.islemler] };
        if (c.islemler.includes('j:' + iz.slice(0, 24))) return yanit(res, 200, { ok: true, durum: 'zaten', ...cuzdanYanit(c) });   // bu jeton zaten yüklendi (istemci tekrar denedi): tüketebilir
        if (gp.tekSefer && c.ilkPaket) return yanit(res, 200, { ok: false, durum: 'tek_sefer', ...cuzdanYanit(c) });
        c.gem += gp.gem; for (const og of gp.ogeler || []) if (!c.sahip.includes(og)) c.sahip.push(og); if (gp.tekSefer) c.ilkPaket = true; c.islemler.push('j:' + iz.slice(0, 24));
        const s = await yaz(uid, w, c, [{ yol: `satin/${iz}`, alan: { uid, urun: u.id, t: Date.now() } }]);
        if (s === 'ok') { console.log(`[cuzdan] +${gp.gem} gem ${u.id} ${uid.slice(0, 8)}`); return yanit(res, 200, { ok: true, durum: 'yuklendi', ...cuzdanYanit(c) }); }
        if (s === 'var') return yanit(res, 200, { ok: false, durum: 'zaten_kullanildi' });   // jeton başka hesaba yüklenmiş
      }
      return yanit(res, 409, { ok: false, durum: 'hata' });
    } catch (e) { console.log('[cuzdan] yukle hata', e.message); return yanit(res, 502, { ok: false, durum: 'hata' }); }
  });
  app.post('/g/cuzdan/harca', async (req, res) => {
    const o = await ortak(req, res); if (!o) return; const { d, uid } = o; istat.harca++;
    const f = DUKKAN.fiyat[d.oge]; if (!f || !f.gem || typeof d.islem !== 'string' || d.islem.length < 6 || d.islem.length > 64) return yanit(res, 400, { ok: false, durum: 'gecersiz' });
    try {
      for (let deneme = 0; deneme < 3; deneme++) {
        const w = await oku(uid); const c = { ...w.c, sahip: [...w.c.sahip], islemler: [...w.c.islemler] };
        if (c.islemler.includes('h:' + d.islem)) return yanit(res, 200, { ok: true, durum: 'zaten', ...cuzdanYanit(c) });
        if (c.sahip.includes(d.oge)) return yanit(res, 200, { ok: false, durum: 'zaten_var', ...cuzdanYanit(c) });
        if (c.gem < f.gem) return yanit(res, 200, { ok: false, durum: 'yetersiz', ...cuzdanYanit(c) });
        c.gem -= f.gem; c.sahip.push(d.oge); c.islemler.push('h:' + d.islem);
        if (await yaz(uid, w, c) === 'ok') { console.log(`[cuzdan] -${f.gem} gem ${d.oge} ${uid.slice(0, 8)}`); return yanit(res, 200, { ok: true, durum: 'alindi', ...cuzdanYanit(c) }); }
      }
      return yanit(res, 409, { ok: false, durum: 'hata' });
    } catch (e) { console.log('[cuzdan] harca hata', e.message); return yanit(res, 502, { ok: false, durum: 'hata' }); }
  });
  return { istat };
}
/** Sunucu içi: öğeleri oyuncunun sunucu envanterine ekle (lig sezon ödülü). Çakışmada yeniden dener. */
async function ogeEkle(uid, ogeler) {
  for (let d = 0; d < 3; d++) {
    const w = await oku(uid); const c = { ...w.c, sahip: [...w.c.sahip], islemler: [...w.c.islemler] }; let yeni = false;
    for (const o of ogeler) if (!c.sahip.includes(o)) { c.sahip.push(o); yeni = true; }
    if (!yeni) return true; if (await yaz(uid, w, c) === 'ok') return true;
  }
  return false;
}
module.exports = { kur, kimlikDogrula, istat, ogeEkle, _bellek: bellek };
