// ============================================================================
// BEDLAM Godot — hesap ve uzaktan ayar uçları (Faz 7.5; godot/PLAN.md §7b). server.js: require('./g_hesap').kur(app)
//
// GET /g/ayar   (v1) uzaktan ayar / bakım: { v:1, bakim, mesaj, minPv }  (AYAR_BAKIM=1, AYAR_MESAJ, MIN_PV_GODOT ortam değişkenleri)
// Hesap silme işi: istemci kullanici/<uid>.silmeIstegi = ms yazar (oyunda AYARLAR › PROFİL › HESABI SİL; iptal = 0).
//   7 günü geçen istekler için: kullanici/<uid>, etiket/<ETİKET>, liderlik/<uid> belgeleri ve Firebase Auth kullanıcısı silinir.
//   Ortam: FIREBASE_SERVIS_JSON (Firebase Admin servis hesabı; Datastore + Identity Toolkit yetkisi). Yoksa iş çalışmaz (günlüğe yazar).
//   6 saatte bir; başlangıçtan 1 dk sonra ilk tur.
// ============================================================================
'use strict';
const crypto = require('crypto');

const PROJE = process.env.FIREBASE_PROJE || 'bedlam-94bfc';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJE}/databases/(default)/documents`;
const BEKLEME_MS = 7 * 24 * 3600 * 1000;
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let erisim = null;
async function erisimJetonu() {
  if (erisim && erisim.bitis > Date.now() + 60000) return erisim.jeton;
  const sa = JSON.parse(process.env.FIREBASE_SERVIS_JSON); const t = Math.floor(Date.now() / 1000);
  const bas = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iddia = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600 }));
  const imza = b64url(crypto.createSign('RSA-SHA256').update(bas + '.' + iddia).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + bas + '.' + iddia + '.' + imza });
  if (!r.ok) throw new Error('oauth ' + r.status);
  const j = await r.json(); erisim = { jeton: j.access_token, bitis: Date.now() + (j.expires_in || 3600) * 1000 }; return erisim.jeton;
}

const istat = { silinen: 0, tur: 0, hata: 0, son: '' };
/** Süresi dolan silme isteklerini işler; silinen uid listesi döner. */
async function silmeTuru(simdi = Date.now()) {
  if (!process.env.FIREBASE_SERVIS_JSON) { istat.son = 'servis yok'; return []; }
  istat.tur++; const t = await erisimJetonu(); const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
  const q = { structuredQuery: { from: [{ collectionId: 'kullanici' }], where: { fieldFilter: { field: { fieldPath: 'silmeIstegi' }, op: 'GREATER_THAN', value: { integerValue: '0' } } }, limit: 200 } };
  const r = await fetch(FS + ':runQuery', { method: 'POST', headers: H, body: JSON.stringify(q) });
  if (!r.ok) throw new Error('sorgu ' + r.status);
  const silinen = [];
  for (const e of await r.json()) {
    const d = e.document; if (!d) continue; const f = d.fields || {}; const istek = +(f.silmeIstegi?.integerValue || 0);
    if (!istek || simdi - istek < BEKLEME_MS) continue;
    const uid = d.name.split('/').pop(), etiket = f.etiket?.stringValue;
    try {
      for (const yol of [`kullanici/${uid}`, `liderlik/${uid}`, ...(etiket ? [`etiket/${etiket}`] : [])]) {
        const s = await fetch(`${FS}/${yol}`, { method: 'DELETE', headers: H }); if (!s.ok && s.status !== 404) throw new Error(yol + ' ' + s.status);
      }
      const a = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJE}/accounts:delete`, { method: 'POST', headers: H, body: JSON.stringify({ localId: uid }) });
      if (!a.ok && a.status !== 400) throw new Error('auth ' + a.status);
      silinen.push(uid); istat.silinen++; console.log('[hesap] silindi', uid.slice(0, 8));
    } catch (er) { istat.hata++; console.log('[hesap] silme hatası', uid.slice(0, 8), er.message); }
  }
  istat.son = new Date(simdi).toISOString(); return silinen;
}

function kur(app) {
  app.get('/g/ayar', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ v: 1, bakim: process.env.AYAR_BAKIM === '1', mesaj: process.env.AYAR_MESAJ || '', minPv: Number(process.env.MIN_PV_GODOT) || 0 });
  });
  if (process.env.NODE_ENV !== 'test') {
    const dongu = () => silmeTuru().catch(e => { istat.hata++; console.log('[hesap] tur hatası', e.message); });
    setTimeout(dongu, 60 * 1000); setInterval(dongu, 6 * 3600 * 1000);
  }
  return { istat };
}

module.exports = { kur, silmeTuru, istat, BEKLEME_MS };
