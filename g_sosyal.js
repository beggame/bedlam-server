// ============================================================================
// BEDLAM Godot — sosyal uçlar (Faz 7.8). server.js: require('./g_sosyal').kur(app)
// POST /g/rapor (v1) { v:1, kimlik, hedef (oyuncu etiketi), neden: ad | hile | davranis, not? (≤ 200) }
//   → { v:1, ok, durum: alindi | surum | kimlik | gecersiz | sinir | dogrulayici_yok | hata }
//   Raporlayan Firebase ID jetonuyla doğrulanır; oyuncu başına günde 10 rapor; kendini raporlayamaz (etiket = kendi etiketi ise reddedilir, istemci de engeller).
//   Kayıt: Firestore rapor/<otomatik> (yönetici; istemci kuralı yok = okunamaz/yazılamaz) → moderasyon kuyruğu (konsoldan incelenir).
// ============================================================================
'use strict';
const crypto = require('crypto'), express = require('express');
const { kimlikDogrula } = require('./g_cuzdan');
const PROJE = process.env.FIREBASE_PROJE || 'bedlam-94bfc';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJE}/databases/(default)/documents`;
const NEDEN = ['ad', 'hile', 'davranis'];
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
const gunluk = new Map(); const istat = { rapor: 0, red: 0 }; const bellek = [];
function kur(app) {
  app.use('/g/rapor', express.json({ limit: '4kb' }));
  app.post('/g/rapor', async (req, res) => {
    res.set('Cache-Control', 'no-store'); const d = req.body || {};
    const yanit = (kod, o) => { if (!o.ok) istat.red++; res.status(kod).json({ v: 1, ...o }); };
    if (d.v !== 1) return yanit(400, { ok: false, durum: 'surum', destek: [1] });
    const sahte = process.env.SAHTE_CUZDAN === '1';
    if (!process.env.FIREBASE_SERVIS_JSON && !sahte) return yanit(503, { ok: false, durum: 'dogrulayici_yok' });
    let uid; try { uid = await kimlikDogrula(d.kimlik); } catch { return yanit(401, { ok: false, durum: 'kimlik' }); }
    if (typeof d.hedef !== 'string' || !/^[A-Z0-9]{3,12}$/.test(d.hedef) || !NEDEN.includes(d.neden) || (d.not != null && (typeof d.not !== 'string' || d.not.length > 200))) return yanit(400, { ok: false, durum: 'gecersiz' });
    const k = uid + '|' + new Date().toISOString().slice(0, 10), n = (gunluk.get(k) || 0) + 1; gunluk.set(k, n); if (gunluk.size > 20000) gunluk.clear();
    if (n > 10) return yanit(429, { ok: false, durum: 'sinir' });
    const kayit = { raporlayan: uid, hedef: d.hedef, neden: d.neden, not: (d.not || '').slice(0, 200), t: Date.now(), durum: 'yeni' };
    try {
      if (sahte) bellek.push(kayit);
      else {
        const t = await erisimJetonu(); const f = {}; for (const [a, v] of Object.entries(kayit)) f[a] = typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v };
        const r = await fetch(`${FS}/rapor`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: f }) });
        if (!r.ok) throw new Error('yaz ' + r.status);
      }
      istat.rapor++; console.log(`[rapor] ${d.neden} → #${d.hedef} (${uid.slice(0, 8)})`); return yanit(200, { ok: true, durum: 'alindi' });
    } catch (e) { console.log('[rapor] hata', e.message); return yanit(502, { ok: false, durum: 'hata' }); }
  });
  return { istat, bellek };
}
module.exports = { kur, istat };
