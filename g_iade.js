// ============================================================================
// BEDLAM Godot — Play iade / ters ibraz taraması (Sürüm 5). server.js: require('./g_iade').kur()
// Oyuncu Play'de bir satın almayı iade ettirirse (ya da ters ibraz/chargeback olursa) cüzdana yüklenen gem geri alınır:
//   Google Play Developer API purchases.voidedpurchases.list (type=0 = uygulama içi ürünler) → her kayıt { purchaseToken, orderId, voidedSource, voidedReason, voidedTimeMillis }
//   iz = sha256(purchaseToken) hex = satin/<iz> belgesi (g_cuzdan.js /yukle yazar) → g_cuzdan.iadeUygula(iz, kayit): bakiye ASLA negatife düşmez, tek seferlik iade/<iz> belgesi çift geri almayı önler.
// startTime GÖNDERİLMEZ: her taramada Play'in tüm penceresi (varsayılan son 30 gün) okunur; tekrar güvenlidir (iade/<iz> exists:false).
// Bellek Set'i yalnız gereksiz Firestore okumasını önler (süreç yeniden başlarsa boşalır; doğruluk Firestore'dadır).
// Ortam: PLAY_SERVIS_JSON (Play API; Play Console › API erişimi'nde "mali verileri görüntüle" yetkisi), FIREBASE_SERVIS_JSON (cüzdan), IADE_TARA_SAAT (tarama aralığı, varsayılan 6).
// Yoksa ya da NODE_ENV=test ise zamanlayıcı kurulmaz (tara() elle çağrılabilir).
// ============================================================================
'use strict';
const crypto = require('crypto');
const { KATALOG, erisimJetonu } = require('./g_magaza');
const { iadeUygula } = require('./g_cuzdan');

const SAYFA_EN_COK = 20, BELLEK_EN_COK = 20000, GORULDU = new Set();
const istat = { tarama: 0, kayit: 0, alindi: 0, zaten: 0, hata: 0 };
let calisiyor = false;

/** Tek paketin iade sayfalarını dolaşıp kayıtları işler. 401/403/404 → hata sayılır, çağıran sıradaki pakete geçer. */
async function paketTara(paket) {
  let token = '', gorulen = new Set();
  for (let sayfa = 0; sayfa < SAYFA_EN_COK; sayfa++) {
    const t = await erisimJetonu();
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(paket)}/purchases/voidedpurchases?type=0&maxResults=1000` + (token ? '&token=' + encodeURIComponent(token) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 401 || r.status === 403 || r.status === 404) { console.log(`[iade] ${paket} voidedpurchases ${r.status}`); istat.hata++; return; }
    if (!r.ok) throw new Error('voidedpurchases ' + r.status);
    const j = await r.json();
    for (const k of j.voidedPurchases || []) {
      if (typeof k.purchaseToken !== 'string' || !k.purchaseToken) continue; istat.kayit++;
      const iz = crypto.createHash('sha256').update(k.purchaseToken).digest('hex'); if (GORULDU.has(iz)) continue;
      try {
        const o = await iadeUygula(iz, k);
        if (['alindi', 'zaten', 'kayit_yok', 'urun_yok', 'cuzdan_yok'].includes(o.durum)) { if (GORULDU.size > BELLEK_EN_COK) GORULDU.clear(); GORULDU.add(iz); }
        if (o.durum === 'alindi') istat.alindi++; else if (o.durum === 'zaten') istat.zaten++;
      } catch (e) { console.log('[iade] kayit hata', iz.slice(0, 8), e.message); istat.hata++; }   // bir kayıt taramayı durdurmaz; Set'e girmez, sonraki taramada yeniden denenir
    }
    const sonraki = j.tokenPagination && j.tokenPagination.nextPageToken;
    if (!sonraki || gorulen.has(sonraki)) return; gorulen.add(sonraki); token = sonraki;
  }
}

/** Play'de yayında olan paketleri tarar (dev paketi Play'de yok, 404 hata sayılmasın); aynı anda yalnız bir tarama. Hata fırlatmaz (istat.hata). */
async function tara() {
  if (calisiyor) return; calisiyor = true;
  try {
    istat.tarama++;
    for (const paket of KATALOG.paket.filter(x => !x.endsWith('.godot'))) { try { await paketTara(paket); } catch (e) { console.log('[iade] paket hata', paket, e.message); istat.hata++; } }
  } finally { calisiyor = false; }
}

function kur(secenek = {}) {
  if (!process.env.PLAY_SERVIS_JSON || !process.env.FIREBASE_SERVIS_JSON || process.env.NODE_ENV === 'test') return { istat, tara };
  const aralik = (Number(secenek.saat || process.env.IADE_TARA_SAAT) || 6) * 3600 * 1000, guvenli = () => tara().catch(e => console.log('[iade] tarama hata', e.message));
  setTimeout(() => { guvenli(); setInterval(guvenli, aralik).unref(); }, 60000).unref();
  return { istat, tara };
}
module.exports = { kur, tara, istat };
