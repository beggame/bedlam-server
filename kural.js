// Kural seçimi (klasik + tren). 2026-11-03: GÜNÜN KURALI kapatıldı (bugunKural/istanbulGun duruyor, sec kullanmıyor); yerine FARKLI KURALLAR: gruptaki HERKES kurallar:1 ise
// ağırlıklı rastgele (can 3, o modun diğer her kuralı 1). Saf işlevler: server.js ve test_kural.js kullanır.
'use strict';
const fs = require('fs'), path = require('path');
const KURALLAR = ['zincir', 'ganimet', 'tac', 'fitil', 'hayatta'];   // klasik; 'can' = normal (alanda hiç gönderilmez)
const TREN_KURALLARI = ['soygun', 'kopan', 'hakimiyet'];   // istemci KuralId adlarıyla aynı
const HAVUZ = { classic: KURALLAR, train: TREN_KURALLARI };
const CAN_AGIRLIK = 3;
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
/** Kural seçimi: mod classic|train + gruptaki HERKES bayrak=1 (eski istemci/kapalı = 0 → can) → ağırlıklı: can 3, havuzdaki her kural 1. cfg/nowMs eski imza için duruyor. */
function sec(cfg, mod, bayraklar, nowMs, rng) {
  const h = HAVUZ[mod];
  if (!h || !bayraklar.length || !bayraklar.every(b => b === 1)) return 'can';
  const r = Math.floor(rng() * (CAN_AGIRLIK + h.length));
  return r < CAN_AGIRLIK ? 'can' : h[Math.min(r - CAN_AGIRLIK, h.length - 1)];
}
module.exports = { yukle, istanbulGun, bugunKural, sec, KURALLAR, TREN_KURALLARI };
