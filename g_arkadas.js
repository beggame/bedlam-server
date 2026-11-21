// ============================================================================
// BEDLAM Godot — arkadaş çevrimiçi durumu + davet iletimi: WebSocket ucu /g/sos (Paket B1).
// server.js: const gSos = require('./g_arkadas').kur({ mesajKovasi, mesajAyristir }); upgrade dalı gSos.ipAl(ip) ile IP sayacını alır, sonra gSos.wss'e yönlendirir; SOS_KAPALI için gSos.kapali().
// TÜM durum bellektedir; arkadaş/engel listesi, jeton ve uid'ler diske/günlüğe YAZILMAZ. Sunucu yalnız uid taşır (ad/etiket yok).
//
// ---- PROTOKOL sv:1 (JSON, tek mesaj ≤ 4096 bayt; bağlantı başına saniyede 30 mesaj / 60 patlama, aşan bağlantı 1008 ile kapanır) ----
// Kimlik = Firebase ID jetonu (g_cuzdan.kimlikDogrulaAyrinti) → uid (+ jetonun exp'i).
//  İSTEMCİ → SUNUCU
//   {t:'hello', sv:1, kimlik, arkadas:[uid…≤100], durum:'menu'|'lobi'|'mac', engel?:[uid…≤100], istekKapali?:true}
//        Bağlanınca HELLO_MS (5 sn) içinde ZORUNLU ilk mesaj. Bozuk → {t:'hata',k:'bicim'}; geçersiz/süresi dolmuş jeton → {t:'hata',k:'kimlik'}; ikisinde de sunucu kapatır (1008).
//        engel/istekKapali yalnız bu bağlantı için geçerlidir; yeniden bağlanınca (hello) TEKRAR gönderilmelidir.
//   {t:'arkadas', liste:[uid…≤100]}   Arkadaş listesini güncelle.
//        Yalnız ÇIKARMA içeren (yeni liste eskinin alt kümesi) güncelleme sınırsız ve hemen uygulanır.
//        EKLEME içeren güncelleme dakikada 6; aşarsa eklemeler UYGULANMAZ (çıkarmalar yine uygulanır) ve {t:'hata',k:'sinir'} döner. Liste >100 / dizi değil → {t:'hata',k:'bicim'}. Bağlantı açık kalır.
//   {t:'durum', d:'menu'|'lobi'|'mac'}   Durum değişimi. Bağlantı başına en çok SOS_DURUM_MS (2 sn) aralıkla yayınlanır; aşan değişiklik ertelenir, pencere açılınca SON değer yayınlanır (hata dönmez).
//   {t:'davet', kime, kod, pv}   kod 4–8 hane oda kodu, pv tamsayı 0–100000. Aynı hedefe 30 sn'de 1, dakikada 6, günde SOS_DAVET_GUN (100).
//   {t:'davet_yanit', kime, d:'kabul'|'red'}   Yalnız kime gerçekten davet gönderdiyse (10 dk içinde) ve karşılıklıysa iletilir; tek kullanımlık.
//   {t:'istek', kime}   Karşılıksız arkadaşlık isteği (kime listemde olmalı). Gönderene ASLA sonuç dönmez. Hedefe günde 1; gönderene günde SOS_ISTEK_GUN (10); IP başına günde SOS_ISTEK_IP_GUN (30); hedefin günlük alım tavanı SOS_ISTEK_ALIM_GUN (20). Aşım sessiz yutulur.
//   {t:'engel', liste:[uid…≤100]}   Engel listesini TAMAMEN değiştirir (daralma/genişleme fark etmez). Dakikada 6 (aşım → {t:'hata',k:'sinir'}, uygulanmaz); >100 → {t:'hata',k:'bicim'}.
//  SUNUCU → İSTEMCİ
//   {t:'ok', cevrimici:[{uid,durum}…]}    hello kabul; yalnız KARŞILIKLI (ve engelsiz) arkadaşlar.
//   {t:'vardi', uid, durum}               karşılıklı arkadaş çevrimiçi oldu / durumu değişti.
//   {t:'gitti', uid}                      karşılıklı arkadaş çevrimdışı oldu ya da karşılıklılık/engel bitti. Kopuşta VE liste/engel değişiminde SOS_GITTI_MS (10 sn) gecikmeli gelir (ayırt edilemez); kendi listenden çıkardığın kişi için hemen gelir.
//   {t:'davet', kimden, kod, pv, ttl:90}  gelen davet (ttl sn).
//   {t:'davet_durum', kime, d:'iletildi'|'yok'|'macta'|'sinir'}   davet sonucu. 'yok' = çevrimdışı / karşılıksız / engelli / kendin (hepsi aynı yanıt). 'macta' hedef maçta (YİNE iletilir).
//   {t:'davet_yanit', kimden, d:'kabul'|'red'}
//   {t:'istek', kimden}                   gelen arkadaşlık isteği (istekKapali:true ise ve engellenmişse hiç gelmez).
//   {t:'dolu'}                            sunucu bağlantı tavanında (1013 ile kapanır) → sonra tekrar dene.
//   {t:'hata', k:'kimlik'|'baska'|'bicim'|'sinir'}
// ---- HATA KODLARI ve İSTEMCİ DAVRANIŞI ----
//   kimlik : jeton geçersiz/süresi dolmuş (bağlantı kapanır). → Firebase'den TAZE jeton al (getIdToken(true)), yeniden bağlan. Sunucu ayrıca jeton exp'inden 5 dk sonra (nabız turunda) kimlik ile kapatır: aynı yol.
//   baska  : aynı uid başka cihazdan bağlandı, bu bağlantı kapatılıyor. → OTOMATİK YENİDEN BAĞLANMA, aksi hâlde iki cihaz birbirini döngüde düşürür; kullanıcıya bilgi göster.
//   bicim  : mesaj biçimi/sınırı yanlış. hello'da bağlantı kapanır (hata, yeniden denemeyle düzelmez); diğerlerinde bağlantı açık, mesaj uygulanmadı → istemci hatası, günlüğe yaz.
//   sinir  : hız sınırı. arkadas/engel'de mesaj (ya da eklemeler) uygulanmadı, bağlantı açık → bir süre sonra tekrar dene (sabit pencere 1 dk). hello'da (aynı uid dakikada >3 devralma) YENİ bağlantı reddedilir, eski kalır; kapanır → ≥1 dk bekle.
//   Yükseltme düzeyi: IP başına eşzamanlı SOS_IP_EN_COK (12) soket ve dakikada SOS_IP_HIZ (30) bağlanma; aşım → HTTP 429 (WebSocket açılmaz) → üstel geri çekilmeyle dene. SOS_KAPALI=1 → HTTP 503.
// ---- ZAMAN / VARSAYILANLAR ---- (ortam değişkenleri parantezde)
//   hello bekleme 5 sn (SOS_HELLO_MS) · nabız 30 sn WS ping, 2 kaçırılan pong'da kopar (SOS_NABIZ_MS) · gitti gecikmesi 10 sn (SOS_GITTI_MS) · durum aralığı 2 sn (SOS_DURUM_MS)
//   toplam bağlantı tavanı 2000 (SOS_TAVAN) · gün sınırları: SOS_DAVET_GUN 100, SOS_ISTEK_GUN 10, SOS_ISTEK_IP_GUN 30, SOS_ISTEK_ALIM_GUN 20 · SOS_IP_EN_COK 12, SOS_IP_HIZ 30 · SOS_JETON_PAY_S 300 (jeton exp sonrası ek süre) · SOS_KAPALI=1 acil kapatma.
//   Önerilen istemci nabzı: gerek yok (sunucu ping'ler; WebSocket kütüphanesi pong'u otomatik yanıtlar). Önerilen yeniden bağlanma: 'baska' dışında 2→4→8…60 sn geri çekilme; uygulama arka plandan dönünce hello yeniden gönderilir.
// Karşılıklılık: A'nın varlığı/durumu/daveti B'ye yalnız A.liste∋B VE B.liste∋A ise ve ikisi birbirini ENGELLEMEMİŞSE gider; aksi hâlde davet 'yok' (çevrimdışından ayırt edilemez).
// Engel: B, A'yı engellediyse A'dan gelen istek/davet B'ye iletilmez (gönderen yanıtı çevrimdışı hedefle aynı), A, B'nin varlığını/durumunu görmez; yön simetriktir (A engelleyince B de A'yı görmez).
// ============================================================================
'use strict';
const { WebSocketServer } = require('ws');
const { kimlikDogrulaAyrinti } = require('./g_cuzdan');

const SV = 1;
const UID_RE = /^[A-Za-z0-9]{6,128}$/;
const KOD_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4,8}$/;   // server.js MM_ALPHABET ile aynı; oda kodu 4 (makeCode), /mm 8'e kadar
const DURUMLAR = ['menu', 'lobi', 'mac'];
const LISTE_EN_COK = 100, HARITA_TAVAN = 50000;
const bugun = () => new Date().toISOString().slice(0, 10);
/** Boyut tavanlı Map yazımı: dolunca en eski (ekleme sırası) anahtar atılır. */
function tavanli(m, k, v) {
  if (!m.has(k) && m.size >= HARITA_TAVAN) { const ilk = m.keys().next().value; m.delete(ilk); }
  m.set(k, v);
}

function kur(dep = {}) {
  const env = k => process.env[k];
  const sayi = (k, v) => { const n = Number(env(k)); return Number.isFinite(n) && n >= 0 && env(k) !== '' && env(k) != null ? n : v; };
  const HELLO_MS = sayi('SOS_HELLO_MS', 5000), NABIZ_MS = sayi('SOS_NABIZ_MS', 30000), GITTI_MS = sayi('SOS_GITTI_MS', 10000), DURUM_MS = sayi('SOS_DURUM_MS', 2000);
  const TAVAN = sayi('SOS_TAVAN', 2000), IP_EN_COK = sayi('SOS_IP_EN_COK', 12), IP_HIZ = sayi('SOS_IP_HIZ', 30), JETON_PAY_S = sayi('SOS_JETON_PAY_S', 300);
  const DAVET_GUN = sayi('SOS_DAVET_GUN', 100), ISTEK_GUN = sayi('SOS_ISTEK_GUN', 10);   // gün sınırları (yalnız test için ortamdan değişir)
  const ISTEK_ALIM_GUN = sayi('SOS_ISTEK_ALIM_GUN', 20), ISTEK_IP_GUN = sayi('SOS_ISTEK_IP_GUN', 30);
  const HEDEF_MS = 30000, DAVET_DK = 6, ARKADAS_DK = 6, ENGEL_DK = 6, DEVRAL_DK = 3, YANIT_MS = 600000, DAVET_TTL = 90;
  const mesajKovasi = dep.mesajKovasi || (() => true);
  const mesajAyristir = dep.mesajAyristir || (raw => { let d; try { d = JSON.parse(raw); } catch (e) { return null; } return (!d || typeof d !== 'object' || Array.isArray(d)) ? null : d; });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const kayit = new Map();       // uid -> { uid, ws|null, durum, liste:Set, engel:Set, istekKapali, gorulen:Map<uid,durum>, gT:Map<uid,Timeout>, gitT }
  const sayac = new Map();       // uid -> { gun, davet, istek, dkBas, dkN, akBas, akN, enBas, enN, dvBas, dvN }
  const hedefDavet = new Map();  // `${gonderen}>${hedef}` -> zaman (aynı hedefe 30 sn'de 1)
  const bekleyenDavet = new Map(); // `${davetci}>${davetEdilen}` -> zaman (davet_yanit yalnız gerçek davete)
  const hedefIstek = new Map();  // `${gonderen}>${hedef}` -> gün (aynı hedefe günde 1)
  const hedefAlim = new Map();   // hedef uid -> { gun, n } (günlük istek alım tavanı)
  const ipIstek = new Map();     // ip -> { gun, n } (IP başına günlük istek gönderimi)
  const ipSoket = new Map(), ipHiz = new Map();   // ip -> eşzamanlı sos soketi / ip -> { bas, n } yükseltme hızı
  const istat = { gun: bugun(), davet: 0, istek: 0, toplamDavet: 0, toplamIstek: 0 };

  const gonder = (ws, o) => { try { if (ws && ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(JSON.stringify(o)); } catch (e) {} };
  const kapat = (ws, kod) => { try { ws.close(kod || 1000); } catch (e) {} };
  const gunKontrol = () => { const g = bugun(); if (istat.gun !== g) { istat.gun = g; istat.davet = 0; istat.istek = 0; } };
  const sayacAl = uid => {
    const g = bugun(); let s = sayac.get(uid);
    if (!s || s.gun !== g) { s = { gun: g, davet: 0, istek: 0, dkBas: 0, dkN: 0, akBas: 0, akN: 0, enBas: 0, enN: 0, dvBas: 0, dvN: 0 }; tavanli(sayac, uid, s); }
    return s;
  };
  /** Sabit pencereli sınır: pencere dolmadıysa ve sayı sınıra ulaştıysa false (artırmaz). */
  const pencere = (s, bas, n, sinir, ms) => {
    const t = Date.now();
    if (t - s[bas] >= ms) { s[bas] = t; s[n] = 0; }
    if (s[n] >= sinir) return false;
    s[n]++; return true;
  };
  /** Günlük sayaç haritası (hedefAlim/ipIstek): sınıra ulaşmadıysa artırır, true. */
  const gunluk = (harita, anahtar, sinir) => {
    const g = bugun(); let o = harita.get(anahtar);
    if (!o || o.gun !== g) { o = { gun: g, n: 0 }; tavanli(harita, anahtar, o); }
    if (o.n >= sinir) return false;
    o.n++; return true;
  };

  /** IP başına /g/sos sayacı (server.js upgrade dalı çağırır; /mm + /g/sig sayacından AYRI). Reddedilirse null (429), kabulde idempotent bırakma işlevi döner (soket kapanınca çağrılır). */
  function ipAl(ip) {
    const t = Date.now(); let h = ipHiz.get(ip);
    if (!h || t - h.bas >= 60000) { h = { bas: t, n: 0 }; tavanli(ipHiz, ip, h); }
    if (h.n >= IP_HIZ) return null; h.n++;
    const n = ipSoket.get(ip) || 0; if (n >= IP_EN_COK) return null;
    ipSoket.set(ip, n + 1);
    let birakildi = false;
    return () => { if (birakildi) return; birakildi = true; const k = (ipSoket.get(ip) || 1) - 1; if (k <= 0) ipSoket.delete(ip); else ipSoket.set(ip, k); };
  }

  // ---- varlık (presence) ----
  const gorunur = r => !!r && (!!r.ws || !!r.gitT);   // soket açık ya da gitti gecikmesinde
  /** a ile b arasında karşılıklı arkadaşlık var mı (engel yok, iki yönlü liste). */
  const karsilikli = (a, b) => !!a && !!b && a.liste.has(b.uid) && b.liste.has(a.uid) && !a.engel.has(b.uid) && !b.engel.has(a.uid);
  const istenen = k => {
    const m = new Map();
    for (const f of k.liste) { const r = kayit.get(f); if (r && gorunur(r) && karsilikli(k, r)) m.set(f, r.durum); }
    return m;
  };
  /** k'nın istemcisinin gördüğü çevrimiçi kümeyi gerçek karşılıklı kümeyle eşitle (vardi/gitti farkı). gecik: kaybolanlar için gitti SOS_GITTI_MS geciktirilir (karşı tarafın liste/engel değişimi gerçek kopuştan ayırt edilemesin). */
  const esitle = (k, gecik) => {
    if (!k.ws) return;
    const ist = istenen(k);
    for (const [f, d] of ist) {
      const bek = k.gT.get(f); if (bek) { clearTimeout(bek); k.gT.delete(f); }
      if (k.gorulen.get(f) !== d) { gonder(k.ws, { t: 'vardi', uid: f, durum: d }); k.gorulen.set(f, d); }
    }
    for (const f of [...k.gorulen.keys()]) {
      if (ist.has(f)) continue;
      if (!gecik) { const bek = k.gT.get(f); if (bek) { clearTimeout(bek); k.gT.delete(f); } gonder(k.ws, { t: 'gitti', uid: f }); k.gorulen.delete(f); continue; }
      if (k.gT.has(f)) continue;
      const z = setTimeout(() => {
        k.gT.delete(f);
        if (!k.ws || !k.gorulen.has(f) || istenen(k).has(f)) return;
        gonder(k.ws, { t: 'gitti', uid: f }); k.gorulen.delete(f);
      }, GITTI_MS);
      if (z.unref) z.unref(); k.gT.set(f, z);
    }
  };
  /** k değişti: kendisini (hemen) ve eski/yeni listesindeki herkesi eşitle (gecik: başkalarına gitti gecikmeli). ek: ek uid'ler (engel değişimi). */
  const etkile = (k, eskiListe, gecik, ek) => {
    esitle(k, false);
    const u = new Set(k.liste); if (eskiListe) for (const x of eskiListe) u.add(x); if (ek) for (const x of ek) u.add(x);
    for (const x of u) { const r = kayit.get(x); if (r && r !== k) esitle(r, gecik); }
  };

  /** Dizi ≤100 değilse null; geçerli uid'ler Set (kendi hariç). */
  const listeCoz = (v, kendi) => {
    if (!Array.isArray(v) || v.length > LISTE_EN_COK) return null;
    const s = new Set();
    for (const x of v) if (typeof x === 'string' && UID_RE.test(x) && x !== kendi) s.add(x);
    return s;
  };

  // ---- mesajlar ----
  async function hello(ws, d) {
    if (ws._helloAlindi) return; ws._helloAlindi = true;
    const durum = d.durum == null ? 'menu' : d.durum;
    if (d.sv !== SV || typeof d.kimlik !== 'string' || !DURUMLAR.includes(durum) || !Array.isArray(d.arkadas) || d.arkadas.length > LISTE_EN_COK || (d.engel != null && !Array.isArray(d.engel)) || (d.engel && d.engel.length > LISTE_EN_COK)) { gonder(ws, { t: 'hata', k: 'bicim' }); return kapat(ws, 1008); }
    let uid, exp; try { ({ uid, exp } = await kimlikDogrulaAyrinti(d.kimlik)); } catch (e) { gonder(ws, { t: 'hata', k: 'kimlik' }); return kapat(ws, 1008); }
    if (ws.readyState !== 1) return;
    if (typeof uid !== 'string' || !UID_RE.test(uid)) { gonder(ws, { t: 'hata', k: 'kimlik' }); return kapat(ws, 1008); }
    let r = kayit.get(uid), eskiListe = null, eskiEngel = null;
    if (r && r.ws && r.ws !== ws && !pencere(sayacAl(uid), 'dvBas', 'dvN', DEVRAL_DK, 60000)) { gonder(ws, { t: 'hata', k: 'sinir' }); return kapat(ws, 1008); }   // devralma sıklık sınırı: yeni soket reddedilir, eskisi kalır
    clearTimeout(ws._helloT);
    if (r) {
      if (r.gitT) { clearTimeout(r.gitT); r.gitT = null; }
      if (r.ws && r.ws !== ws) { const eski = r.ws; eski._eski = true; gonder(eski, { t: 'hata', k: 'baska' }); kapat(eski, 1000); }
      eskiListe = r.liste; eskiEngel = r.engel;
    } else { r = { uid, ws: null, durum, liste: new Set(), engel: new Set(), istekKapali: false, gorulen: new Map(), gT: new Map(), gitT: null }; kayit.set(uid, r); }
    r.ws = ws; ws._rec = r; ws._exp = exp; r.durum = durum; r.liste = listeCoz(d.arkadas, uid);
    r.engel = d.engel ? listeCoz(d.engel, uid) : new Set(); r.istekKapali = d.istekKapali === true;
    for (const z of r.gT.values()) clearTimeout(z); r.gT.clear();
    r.gorulen = istenen(r);
    gonder(ws, { t: 'ok', cevrimici: [...r.gorulen].map(([u, dd]) => ({ uid: u, durum: dd })) });
    for (const x of new Set([...r.liste, ...(eskiListe || []), ...r.engel, ...(eskiEngel || [])])) { const p = kayit.get(x); if (p && p !== r) esitle(p, true); }
  }

  function davet(k, d) {
    if (typeof d.kime !== 'string' || !UID_RE.test(d.kime) || typeof d.kod !== 'string') return;
    const kod = d.kod.toUpperCase();
    if (!KOD_RE.test(kod) || !Number.isInteger(d.pv) || d.pv < 0 || d.pv > 100000) return;
    gunKontrol();
    const s = sayacAl(k.uid), t = Date.now(), anahtar = k.uid + '>' + d.kime, son = hedefDavet.get(anahtar);
    if ((son && t - son < HEDEF_MS) || s.davet >= DAVET_GUN || !pencere(s, 'dkBas', 'dkN', DAVET_DK, 60000)) return gonder(k.ws, { t: 'davet_durum', kime: d.kime, d: 'sinir' });
    s.davet++; istat.davet++; istat.toplamDavet++; tavanli(hedefDavet, anahtar, t);
    const h = kayit.get(d.kime);
    if (!h || !h.ws || h === k || !karsilikli(k, h)) return gonder(k.ws, { t: 'davet_durum', kime: d.kime, d: 'yok' });   // çevrimdışı = karşılıksız = engelli = kendine: aynı yanıt
    gonder(h.ws, { t: 'davet', kimden: k.uid, kod, pv: d.pv, ttl: DAVET_TTL });
    tavanli(bekleyenDavet, anahtar, t);
    gonder(k.ws, { t: 'davet_durum', kime: d.kime, d: h.durum === 'mac' ? 'macta' : 'iletildi' });
  }

  function davetYanit(k, d) {
    if (typeof d.kime !== 'string' || !UID_RE.test(d.kime) || (d.d !== 'kabul' && d.d !== 'red')) return;
    const anahtar = d.kime + '>' + k.uid, z = bekleyenDavet.get(anahtar);
    if (!z || Date.now() - z > YANIT_MS) return;   // yalnız bu kişinin gerçekten gönderdiği davete yanıt
    bekleyenDavet.delete(anahtar);
    const h = kayit.get(d.kime);
    if (h && h.ws && karsilikli(k, h)) gonder(h.ws, { t: 'davet_yanit', kimden: k.uid, d: d.d });
  }

  function istek(k, d) {
    if (typeof d.kime !== 'string' || !UID_RE.test(d.kime) || d.kime === k.uid) return;
    gunKontrol();
    const g = bugun(), s = sayacAl(k.uid), anahtar = k.uid + '>' + d.kime;
    if (s.istek >= ISTEK_GUN || hedefIstek.get(anahtar) === g) return;   // aşım sessiz yutulur
    if (k.ws && k.ws._ip && !gunluk(ipIstek, k.ws._ip, ISTEK_IP_GUN)) return;   // IP başına günlük gönderim (sessiz)
    s.istek++; tavanli(hedefIstek, anahtar, g); istat.istek++; istat.toplamIstek++;
    if (!k.liste.has(d.kime)) return;
    const h = kayit.get(d.kime);
    if (!h || !h.ws || h.liste.has(k.uid) || h.istekKapali || h.engel.has(k.uid)) return;   // gönderene hiçbir şey dönmez
    if (!gunluk(hedefAlim, h.uid, ISTEK_ALIM_GUN)) return;   // hedefin günlük alım tavanı
    gonder(h.ws, { t: 'istek', kimden: k.uid });
  }

  /** Durum değişimini uygula ve yay (hız sınırı çağıranda). */
  const durumUygula = (k, v) => { if (k.durum === v) return; k.durum = v; etkile(k, null, false); };
  function durumGuncelle(ws, k, v) {
    const t = Date.now(), gecen = t - (ws._durumSonT || 0);
    if (!ws._durumT && gecen >= DURUM_MS) { ws._durumSonT = t; durumUygula(k, v); return; }
    ws._durumBek = v;   // pencere dolana dek yalnız SON değer tutulur
    if (ws._durumT) return;
    ws._durumT = setTimeout(() => {
      ws._durumT = null; ws._durumSonT = Date.now();
      const x = ws._durumBek; ws._durumBek = null;
      if (x != null && k.ws === ws && !ws._bitti) durumUygula(k, x);
    }, Math.max(0, DURUM_MS - gecen));
  }

  function mesaj(ws, raw) {
    if (ws._eski) return;
    if (!mesajKovasi(ws)) return;
    const d = mesajAyristir(raw); if (!d || typeof d.t !== 'string') return;
    if (d.t === 'hello') { hello(ws, d).catch(() => { gonder(ws, { t: 'hata', k: 'kimlik' }); kapat(ws, 1008); }); return; }
    const k = ws._rec; if (!k || k.ws !== ws) return;   // hello tamamlanmadan başka mesaj işlenmez
    if (d.t === 'durum') {
      if (!DURUMLAR.includes(d.d)) return;
      durumGuncelle(ws, k, d.d);
    } else if (d.t === 'arkadas') {
      const yeni = listeCoz(d.liste, k.uid); if (!yeni) return gonder(ws, { t: 'hata', k: 'bicim' });
      const eski = k.liste; let ekleme = false; for (const x of yeni) if (!eski.has(x)) { ekleme = true; break; }
      if (!ekleme) { k.liste = yeni; etkile(k, eski, true); return; }   // yalnız çıkarma: sınırsız, hemen
      if (!pencere(sayacAl(k.uid), 'akBas', 'akN', ARKADAS_DK, 60000)) {
        const kes = new Set(); for (const x of yeni) if (eski.has(x)) kes.add(x);
        if (kes.size !== eski.size) { k.liste = kes; etkile(k, eski, true); }   // çıkarmalar yine uygulanır, eklemeler değil
        return gonder(ws, { t: 'hata', k: 'sinir' });
      }
      k.liste = yeni; etkile(k, eski, true);
    } else if (d.t === 'engel') {
      const yeni = listeCoz(d.liste, k.uid); if (!yeni) return gonder(ws, { t: 'hata', k: 'bicim' });
      if (!pencere(sayacAl(k.uid), 'enBas', 'enN', ENGEL_DK, 60000)) return gonder(ws, { t: 'hata', k: 'sinir' });
      const eski = k.engel; k.engel = yeni; etkile(k, null, true, [...eski, ...yeni]);
    } else if (d.t === 'davet') davet(k, d);
    else if (d.t === 'davet_yanit') davetYanit(k, d);
    else if (d.t === 'istek') istek(k, d);
  }

  wss.on('connection', ws => {
    if (wss.clients.size > TAVAN) { gonder(ws, { t: 'dolu' }); kapat(ws, 1013); return; }
    ws._kacirilan = 0; ws._helloAlindi = false; ws._rec = null;
    ws._helloT = setTimeout(() => { if (!ws._rec) kapat(ws, 1008); }, HELLO_MS);
    ws.on('pong', () => { ws._kacirilan = 0; });
    ws.on('message', raw => { try { mesaj(ws, raw); } catch (e) { try { console.log('[sos] mesaj hatası', e && e.message); } catch (_) {} } });
    const bye = () => {
      if (ws._bitti) return; ws._bitti = true; clearTimeout(ws._helloT); clearTimeout(ws._durumT); ws._durumT = null;
      const r = ws._rec; if (!r || r.ws !== ws) return;
      r.ws = null;
      r.gitT = setTimeout(() => {
        r.gitT = null; if (r.ws) return;
        if (kayit.get(r.uid) === r) kayit.delete(r.uid);
        for (const z of r.gT.values()) clearTimeout(z); r.gT.clear();
        etkile(r, null, false);   // r artık görünmez: karşılıklı arkadaşlara gitti
      }, GITTI_MS);
    };
    ws.on('close', bye); ws.on('error', bye);
  });

  // nabız (WS ping/pong) + jeton süresi + bellek süpürme
  const nabiz = setInterval(() => {
    const simdi = Date.now() / 1000;
    for (const ws of wss.clients) {
      if (ws._exp && simdi > ws._exp + JETON_PAY_S) { gonder(ws, { t: 'hata', k: 'kimlik' }); kapat(ws, 1008); continue; }   // jeton süresi bitti: istemci taze jetonla yeniden bağlanır
      if (ws._kacirilan >= 2) { try { ws.terminate(); } catch (e) {} continue; }
      ws._kacirilan++; try { ws.ping(); } catch (e) {}
    }
  }, NABIZ_MS);
  const supur = setInterval(() => {
    const t = Date.now(), g = bugun();
    for (const [k, z] of hedefDavet) if (t - z >= HEDEF_MS) hedefDavet.delete(k);
    for (const [k, z] of bekleyenDavet) if (t - z >= YANIT_MS) bekleyenDavet.delete(k);
    for (const [k, v] of hedefIstek) if (v !== g) hedefIstek.delete(k);
    for (const [k, s] of sayac) if (s.gun !== g) sayac.delete(k);
    for (const m of [hedefAlim, ipIstek]) for (const [k, o] of m) if (o.gun !== g) m.delete(k);
    for (const [k, h] of ipHiz) if (t - h.bas >= 60000) ipHiz.delete(k);
    gunKontrol();
  }, 60000);
  nabiz.unref(); supur.unref();

  return {
    wss, ipAl,
    kapali: () => process.env.SOS_KAPALI === '1',
    /** /stats özeti: yalnız sayılar. */
    istat: () => { gunKontrol(); return { baglanti: wss.clients.size, kayit: kayit.size, gunDavet: istat.davet, gunIstek: istat.istek, toplamDavet: istat.toplamDavet, toplamIstek: istat.toplamIstek }; },
    _kayit: kayit, _harita: () => ({ ipSoket: ipSoket.size, ipHiz: ipHiz.size }), _kapat() { clearInterval(nabiz); clearInterval(supur); }
  };
}
module.exports = { kur, SV };
