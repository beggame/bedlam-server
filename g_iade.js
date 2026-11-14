// ============================================================================
// BEDLAM Godot — Play iade / ters ibraz taraması (Sürüm 5). server.js: require('./g_iade').kur()
// Oyuncu Play'de bir satın almayı iade ettirirse (ya da ters ibraz/chargeback olursa) cüzdana yüklenen gem geri alınır:
//   Google Play Developer API purchases.voidedpurchases.list (type=0 = uygulama içi ürünler) → her kayıt { purchaseToken, orderId, voidedSource, voidedReason, voidedTimeMillis }
//   iz = sha256(purchaseToken) hex = satin/<iz> belgesi (g_cuzdan.js /yukle yazar) → g_cuzdan.iadeUygula(iz, kayit): bakiye ASLA negatife düşmez, tek seferlik iade/<iz> belgesi çift geri almayı önler.
// startTime GÖNDERİLMEZ: her taramada Play'in tüm penceresi (varsayılan son 30 gün) okunur; tekrar güvenlidir (iade/<iz> exists:false).
// Bellek Set'i yalnız gereksiz Firestore okumasını önler (süreç yeniden başlarsa boşalır; doğruluk Firestore'dadır).
// Ortam: PLAY_SERVIS_JSON (Play API; Play Console › API erişimi'nde "mali verileri görüntüle" yetkisi), FIREBASE_SERVIS_JSON (cüzdan), IADE_TARAMA_DK (tarama aralığı dakika, varsayılan 60; eski IADE_TARA_SAAT saat olarak hâlâ okunur), PLAY_BILDIRIM_ANAHTAR (RTDN ucu, tanımsızsa 404).
// Yoksa ya da NODE_ENV=test ise zamanlayıcı kurulmaz (tara() elle çağrılabilir).
// ============================================================================
'use strict';
const crypto = require('crypto');
const { KATALOG, erisimJetonu } = require('./g_magaza');
const { iadeUygula } = require('./g_cuzdan');
const { hizAsildi } = require('./g_magaza');

const SAYFA_EN_COK = 20, BELLEK_EN_COK = 20000, GORULDU = new Set();
const istat = { tarama: 0, kayit: 0, alindi: 0, zaten: 0, hata: 0, rtdn: 0, rtdnIade: 0, rtdnHata: 0, rtdnTarama: 0, rtdnBirlesti: 0, tembel: 0 };
let calisiyor = false, sonTarama = 0, bekleyen = null;

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
  if (calisiyor) return; calisiyor = true; sonTarama = Date.now();
  try {
    istat.tarama++;
    for (const paket of KATALOG.paket.filter(x => !x.endsWith('.godot'))) { try { await paketTara(paket); } catch (e) { console.log('[iade] paket hata', paket, e.message); istat.hata++; } }
  } finally { calisiyor = false; }
}

/** O4: RTDN bildirimi yalnız bir TETİKTİR; içeriğine (jeton, sipariş) güvenilmez, iade bildirimden uygulanmaz. Play'in voidedpurchases listesi hemen taranır.
 *  Aynı anda en çok bir tarama; son taramadan IADE_RTDN_ARALIK_MS (varsayılan 60 sn) geçmediyse tek bir ertelenmiş taramada birleşir. Dönüş: 'basladi' | 'ertelendi' | 'birlesti'. */
function taramaTetikle() {
  if (bekleyen) { istat.rtdnBirlesti++; return 'birlesti'; }
  const aralik = process.env.IADE_RTDN_ARALIK_MS !== undefined ? Number(process.env.IADE_RTDN_ARALIK_MS) : 60000;
  const bekle = calisiyor ? Math.min(5000, Math.max(aralik, 1)) : Math.max(0, aralik - (Date.now() - sonTarama));
  const calistir = () => { bekleyen = null; if (calisiyor) { bekleyen = setTimeout(calistir, 1000); bekleyen.unref(); return; } istat.rtdnTarama++; tara().catch(e => console.log('[iade] rtdn tarama hata', e.message)); };
  if (bekle <= 0) { istat.rtdnTarama++; tara().catch(e => console.log('[iade] rtdn tarama hata', e.message)); return 'basladi'; }
  bekleyen = setTimeout(calistir, bekle); bekleyen.unref(); return 'ertelendi';
}

/** Tembel tarama: Render ücretsiz katmanı uyuyunca zamanlayıcı kaçar. Her HTTP isteği bunu çağırır (server.js ara katmanı); son taramadan IADE_TARAMA_DK (varsayılan 60) dk geçtiyse
 *  taramaTetikle() arka planda çalışır (istek beklemez, hata fırlatmaz). PLAY_SERVIS_JSON yoksa hiçbir şey yapmaz. Çalışan ya da bekleyen tarama varsa dokunmaz. Dönüş: true = tetiklendi. */
function tembelTara() {
  if (!process.env.PLAY_SERVIS_JSON || calisiyor || bekleyen) return false;
  const dk = Number(process.env.IADE_TARAMA_DK) || (Number(process.env.IADE_TARA_SAAT) || 0) * 60 || 60;
  if (Date.now() - sonTarama < dk * 60 * 1000) return false;
  try { istat.tembel++; taramaTetikle(); return true; } catch (e) { console.log('[iade] tembel tetik hata', e.message); return false; }
}

function kur(secenek = {}) {
  if (!process.env.PLAY_SERVIS_JSON || !process.env.FIREBASE_SERVIS_JSON || process.env.NODE_ENV === 'test') return { istat, tara };
  const dk = Number(secenek.dk || process.env.IADE_TARAMA_DK) || (Number(secenek.saat || process.env.IADE_TARA_SAAT) || 0) * 60 || 60, aralik = dk * 60 * 1000, guvenli = () => tara().catch(e => console.log('[iade] tarama hata', e.message));
  setTimeout(() => { guvenli(); setInterval(guvenli, aralik).unref(); }, 60000).unref();
  return { istat, tara };
}

/** Sabit zamanlı dizge karşılaştırması (hash üzerinden, uzunluk sızmaz). */
const esit = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
/** Play Gerçek Zamanlı Geliştirici Bildirimleri (Pub/Sub push): POST /g/play-bildirim?anahtar=<PLAY_BILDIRIM_ANAHTAR>.
 *  Gövde { message: { data: base64(JSON), messageId }, subscription }. voidedPurchaseNotification (tek seferlik ürün) → YALNIZ voidedpurchases taramasını tetikler (taramaTetikle); iade doğrudan bildirimden uygulanmaz.
 *  oneTimeProductNotification yalnız günlüğe. Anahtar yoksa uç 404, yanlışsa 403; geçerli istekte işleme hatası olsa bile 200 döner (Pub/Sub yeniden denemesin), hata günlüğe + istat.rtdnHata. */
function bildirimKur(app) {
  const express = require('express');
  app.use('/g/play-bildirim', express.json({ limit: '32kb' }));
  app.post('/g/play-bildirim', async (req, res) => {
    res.set('Cache-Control', 'no-store'); const anahtar = process.env.PLAY_BILDIRIM_ANAHTAR;
    if (!anahtar) return res.status(404).json({ ok: false });
    if (hizAsildi(req.ip || '', Number(process.env.PLAY_BILDIRIM_IP_DK) || 300, 'play-bildirim')) return res.status(429).json({ ok: false });
    const q = req.query && req.query.anahtar; if (typeof q !== 'string' || !esit(q, anahtar)) return res.status(403).json({ ok: false });
    istat.rtdn++;
    try {
      const data = req.body && req.body.message && req.body.message.data; if (typeof data !== 'string') return res.status(200).json({ ok: true, yok: 'veri' });
      const n = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
      if (n.voidedPurchaseNotification) {
        const v = n.voidedPurchaseNotification;
        if (v.productType === 1) return res.status(200).json({ ok: true, yok: 'abonelik' });   // abonelik iadesi: bu sunucu ilgilenmez
        const d = taramaTetikle(); istat.rtdnIade++; console.log('[iade] rtdn voided bildirimi → tarama', d);
      } else if (n.oneTimeProductNotification) { const o = n.oneTimeProductNotification; console.log('[iade] rtdn tek seferlik ürün bildirimi', o.notificationType, o.sku); }
      else if (n.testNotification) console.log('[iade] rtdn test bildirimi');
    } catch (e) { istat.rtdnHata++; console.log('[iade] rtdn hata', e.message); }
    return res.status(200).json({ ok: true });
  });
}
module.exports = { kur, tara, istat, bildirimKur, taramaTetikle, tembelTara };
