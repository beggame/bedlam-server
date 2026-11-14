// ============================================================================
// BEDLAM Godot — ekonomi sayıları (istemci uzaktan ayar). server.js: require('./g_ekonomi').kur(app)
// GET /g/ekonomi → { v:1, surum, veri:{ coin, reklamOdul, reklamKat, hediye, turSeviye, turAdim, kasma, gunlukSayi, coinFiyat:{öğe:coin}, acikDalga } }
//   dukkan.json'ın yalnız genel alt kümesi; GEM FİYATI, gemPaket, gemSet ve kupaYolu ASLA dahil değildir (gem değerleri yalnız sunucuda).
//   Cache-Control public max-age=300 + ETag (sha1); If-None-Match → 304. IP başına dakikada 30 istek.
// ============================================================================
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { hizAsildi } = require('./g_magaza');

function govde(D = JSON.parse(fs.readFileSync(path.join(__dirname, 'dukkan.json'), 'utf8'))) {
  const coinFiyat = {}; for (const [k, f] of Object.entries(D.fiyat || {})) if (f && typeof f.coin === 'number' && f.coin > 0) coinFiyat[k] = f.coin;
  const veri = { coin: D.coin, reklamOdul: D.reklamOdul, reklamKat: D.reklamKat, hediye: D.hediye, turSeviye: D.turSeviye, turAdim: D.turAdim, kasma: D.kasma, gunlukSayi: D.gunlukSayi, coinFiyat, acikDalga: D.acikDalga };
  const metin = JSON.stringify({ v: 1, surum: D.surum, veri }); return { metin, etag: '"' + crypto.createHash('sha1').update(metin).digest('hex') + '"' };
}
function kur(app) {
  const G = govde();
  app.get('/g/ekonomi', (req, res) => {
    if (hizAsildi(req.ip || '', Number(process.env.EKONOMI_IP_DK) || 30, 'ekonomi')) return res.status(429).json({ v: 1, ok: false, durum: 'hata', hata: 'hiz' });
    res.set('Cache-Control', 'public, max-age=300'); res.set('ETag', G.etag);
    if ((req.headers['if-none-match'] || '').split(',').map(x => x.trim()).includes(G.etag)) return res.status(304).end();
    res.type('application/json').send(G.metin);
  });
}
module.exports = { kur, govde };
