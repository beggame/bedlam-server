// Günün kuralı (klasik mod varyantı). Saf işlevler: server.js ve test_kural.js kullanır.
'use strict';
const fs = require('fs'), path = require('path');
const KURALLAR = ['zincir', 'ganimet', 'tac', 'fitil', 'hayatta'];   // 'can' = normal (alanda hiç gönderilmez)
const VARSAYILAN = { gunler: { 1: 'zincir', 2: 'zincir', 3: 'fitil', 4: 'tac', 5: 'hayatta', 6: 'ganimet', 0: 'ganimet' }, oran: 0.25, saatDilimi: 'Europe/Istanbul' };
function yukle(dosya) {
  try { return Object.assign({}, VARSAYILAN, JSON.parse(fs.readFileSync(dosya || process.env.KURALLAR_DOSYA || path.join(__dirname, 'kurallar.json'), 'utf8'))); }
  catch (e) { return VARSAYILAN; }
}
/** İstanbul takvim günü (UTC+3 sabit, Türkiye'de yaz saati yok): {gun:'YYYY-MM-DD', hafta:0..6 (0=Pazar)} */
function istanbulGun(nowMs) {
  const d = new Date(nowMs + 3 * 3600 * 1000);
  return { gun: d.toISOString().slice(0, 10), hafta: d.getUTCDay() };
}
function bugunKural(cfg, nowMs) {
  const g = istanbulGun(nowMs); const k = cfg.gunler && cfg.gunler[g.hafta];
  return { gun: g.gun, kural: KURALLAR.includes(k) ? k : 'can' };
}
/** Kural seçimi: klasik mod + gruptaki HERKES gunKurali:1 + rng() < oran → bugünün kuralı; aksi 'can'. */
function sec(cfg, mod, bayraklar, nowMs, rng) {
  if (mod !== 'classic' || !bayraklar.length || !bayraklar.every(b => b === 1)) return 'can';
  if (!(rng() < cfg.oran)) return 'can';
  return bugunKural(cfg, nowMs).kural;
}
module.exports = { yukle, istanbulGun, bugunKural, sec, KURALLAR };
