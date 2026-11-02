// ============================================================================
// BEDLAM Godot — çökme / hata raporu (Yol haritası Adım 11). server.js: require('./g_cokme').kur(app)
// POST /g/cokme { s: sürüm adı ≤32, pv: int, p: platform ≤16, m: mesaj ≤300 (zorunlu), y: yığın ≤2000, n: bu oturumda tekrar ≥1 } → { ok:true } | { ok:false, hata:'sinir' } 429
//   Kullanıcı kimliği YOK (gizlilik). Gövde en çok 8 KB. IP başına saatte en çok COKME_IP_SAAT (20) rapor.
//   İmza = sha1(m + yığının ilk satırı) ilk 12 hex → Firestore cokme/<imza>: mesaj, yigin, sayac (increment), ilk, son (ms), surum, pv, platform.
//   Firestore yoksa (FIREBASE_SERVIS_JSON) ya da hata verirse yalnız bellek: son 100 imza halkası.
// GET /g/cokme?anahtar=... → COKME_ANAHTAR tanımlı ve eşitse bellekteki liste (sayaca göre azalan); değilse 404.
// ============================================================================
'use strict';
const crypto = require('crypto'), express = require('express');
const { erisimJetonu } = require('./g_cuzdan');

const PROJE = process.env.FIREBASE_PROJE || 'bedlam-94bfc';
const FS_AD = `projects/${PROJE}/databases/(default)/documents`, FS = 'https://firestore.googleapis.com/v1/' + FS_AD;
const HALKA = 100, SAAT_MS = 3600 * 1000;
const istat = { rapor: 0, red: 0, sinir: 0, bugun: 0, gun: '', fsHata: 0 };
const bellek = new Map();   // imza → kayıt (ekleme sırası = eskiden yeniye)
const ipSayac = new Map();  // ip → { bas, n }

const kirp = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
const tamsayi = v => Number.isFinite(+v) ? Math.trunc(+v) : 0;
const imzaAl = (m, y) => crypto.createHash('sha1').update(m + (y.split('\n')[0] || '')).digest('hex').slice(0, 12);
function ipSinir(ip, simdi) {
  const limit = Number(process.env.COKME_IP_SAAT) || 20; let k = ipSayac.get(ip);
  if (!k || simdi - k.bas >= SAAT_MS) { k = { bas: simdi, n: 0 }; ipSayac.set(ip, k); if (ipSayac.size > 20000) ipSayac.clear(); }
  return ++k.n > limit;
}

/** Firestore cokme/<imza>: alanlar güncellenir, sayaç increment, ilk = minimum (yalnız ilk yazımda kalır). */
async function firestoreYaz(imza, k, n) {
  const t = await erisimJetonu(), ad = `${FS_AD}/cokme/${imza}`;
  const sv = v => typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v };
  const fields = { mesaj: sv(k.mesaj), yigin: sv(k.yigin), son: sv(k.son), surum: sv(k.surum), pv: sv(k.pv), platform: sv(k.platform) };
  const writes = [{ update: { name: ad, fields }, updateMask: { fieldPaths: Object.keys(fields) },
    updateTransforms: [{ fieldPath: 'sayac', increment: { integerValue: String(n) } }, { fieldPath: 'ilk', minimum: { integerValue: String(k.son) } }] }];
  const r = await fetch(`${FS}:commit`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  if (!r.ok) throw new Error('yaz ' + r.status);
}

function kaydet(d, simdi = Date.now()) {
  const mesaj = kirp(d.m, 300), yigin = kirp(d.y, 2000), n = Math.min(Math.max(tamsayi(d.n), 1), 1000000);
  const imza = imzaAl(mesaj, yigin), eski = bellek.get(imza);
  const k = { imza, mesaj, yigin, sayac: (eski ? eski.sayac : 0) + n, ilk: eski ? eski.ilk : simdi, son: simdi, surum: kirp(d.s, 32), pv: tamsayi(d.pv), platform: kirp(d.p, 16) };
  bellek.delete(imza); bellek.set(imza, k); if (bellek.size > HALKA) bellek.delete(bellek.keys().next().value);
  const gun = new Date(simdi).toISOString().slice(0, 10); if (istat.gun !== gun) { istat.gun = gun; istat.bugun = 0; }
  istat.rapor++; istat.bugun++;
  console.log(`[cokme] ${imza} x${k.sayac} ${k.platform} ${k.surum} pv${k.pv} ${mesaj.slice(0, 120).replace(/\s+/g, ' ')}`);
  return { imza, k, n };
}

function kur(app) {
  app.use('/g/cokme', express.json({ limit: '8kb' }));
  app.post('/g/cokme', (req, res) => {
    res.set('Cache-Control', 'no-store'); const d = req.body || {};
    if (typeof d.m !== 'string' || !d.m.trim()) { istat.red++; return res.status(400).json({ ok: false, hata: 'gecersiz' }); }
    if (ipSinir(req.ip || (req.socket && req.socket.remoteAddress) || '?', Date.now())) { istat.sinir++; return res.status(429).json({ ok: false, hata: 'sinir' }); }
    const { imza, k, n } = kaydet(d);
    res.json({ ok: true });
    if (process.env.FIREBASE_SERVIS_JSON) firestoreYaz(imza, k, n).catch(e => { istat.fsHata++; console.log('[cokme] firestore hatası', e.message); });
  });
  app.get('/g/cokme', (req, res) => {
    const a = process.env.COKME_ANAHTAR;
    if (!a || typeof req.query.anahtar !== 'string' || req.query.anahtar !== a) return res.status(404).end();
    res.set('Cache-Control', 'no-store'); res.json({ v: 1, liste: [...bellek.values()].sort((x, y) => y.sayac - x.sayac || y.son - x.son) });
  });
  return { istat, bellek };
}

module.exports = { kur, kaydet, imzaAl, istat, _bellek: bellek, _ipSayac: ipSayac };
