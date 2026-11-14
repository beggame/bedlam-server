// Üretim güvenlik kontrolü: Render (RENDER ortamı) ya da NODE_ENV=production iken test/geliştirme bayrakları açıksa sunucu AÇILMAZ.
// server.js en başta çağırır. GERCEK_SATIN bu listede DEĞİL (gerçek satın almayı bilerek açan ayardır).
'use strict';
const YASAK = ['SAHTE_SATIN', 'SAHTE_CUZDAN', 'LIG_SART_ATLA'];
/** env üretimse ve yasak bayrak '1' ise açıklayıcı hata metni, yoksa ''. */
function kontrol(env = process.env) {
  if (!env.RENDER && env.NODE_ENV !== 'production') return '';
  const acik = YASAK.filter(k => env[k] === '1');
  return acik.length ? `[BAŞLANGIÇ HATASI] Üretim ortamında (RENDER/NODE_ENV=production) ${acik.join(', ')}=1 olamaz: bu bayraklar yalnız yerel geliştirme içindir. Ortam değişkenlerini silin.` : '';
}
/** Üretimde yasak bayrak varsa hata yazıp süreci 1 koduyla bitirir. */
function uygula(env = process.env) { const h = kontrol(env); if (h) { console.error(h); process.exit(1); } }
module.exports = { kontrol, uygula, YASAK };
