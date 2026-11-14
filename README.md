# Bedlam — Ağ Sunucusu v2 (sinyalleşme + Maç Ara + TURN)

Tek Node.js süreci, tek port. Maç trafiği sunucudan **geçmez** (WebRTC, gerekirse TURN rölesi).

| Yol | Görev |
|---|---|
| `/peerjs` | WebRTC sinyalleşme (PeerJS) |
| `/mm` | Maç Ara kuyruğu + host göçü oda kanalı (WebSocket) |
| `/ice` | STUN + kısa ömürlü TURN kimlikleri |
| `/stats` | bağlı oyuncu, kuyruk, bugünkü maç / bot doldurma, günün zirvesi |
| `/` | sağlık kontrolü |
| `/g/sig` | **Godot istemcisi** (WebSocket): hello/pv, oda kur/katıl, eşleştirme (bölge+RTT), SDP/ICE rölesi, yol istatistiği — rollback için host yok (godot/AG.md) |
| `/g/cokme` | Çökme / hata raporu (POST `{s,pv,p,m,y,n}`, kimliksiz, 8 KB, IP başına saatte 20; imza = sha1(m+yığın ilk satır) → Firestore `cokme/<imza>` sayaçlı; bellekte son 100). `GET ?anahtar=` ile liste |
| `/g/desync`, `/g/surum` | Godot desync özeti (POST), en düşük Godot protokol sürümü (`MIN_PV_GODOT`, varsayılan 1) |

## Ekonomi / satın alma uçları (2026-11-14)
| Uç | Görev |
|---|---|
| `POST /g/cuzdan` (+ `/yukle` `/harca` `/odul`) | gem cüzdanı. Yeni durumlar: `borc` (iade borcu varken /harca), `geri_yuklendi` + `tasima_sinir` (kalıcı ürün hesap taşıma), `hesap_uyusmaz` (`obfuscatedExternalAccountId` ≠ sha256(uid) hex), `fiyat_degisti` (tek öğede de; yanıtta güncel `fiyat`). Cüzdan yanıtında borç varken `borc` ve `kilit[]` (borçtan sonra gemle alınmış öğeler; öğe silinmez). `/odul` kutuda miktarı sunucu seçer (sha256(uid:id)), yanıtta `miktar` |
| `POST /g/play-bildirim?anahtar=` | Play RTDN (Pub/Sub push): voidedPurchaseNotification → yalnız voidedpurchases taramasını tetikler (içerik kullanılmaz; en çok dakikada bir, `IADE_RTDN_ARALIK_MS`); oneTimeProductNotification → log. Geçerli istekte hep 200 (yanlış anahtar 403, anahtar tanımsız 404) |
| `GET /g/ekonomi` | dukkan.json genel alt kümesi (coin, reklam, hediye, tur, kasma, coinFiyat, acikDalga; gem fiyatı ve kupaYolu YOK). `Cache-Control: public, max-age=300` + ETag/304 |
| `GET /g/ayar` | artık `t` (sunucu saati, ms) da döner |

/yukle sonrası sunucu Play'e `consume` (tüketilir) / `acknowledge` (kalıcı) gönderir (hata yanıtı bozmaz; `/stats` cuzdan.onay / onayHata). Testler: `node test_odeme.js` (+ test_cuzdan, test_iade, test_kupa).

## v2'de ne değişti (v1 = GitHub beggame/bedlam-server 2026-08-08: `server.v1.bak.js`)
- Yalnız aynı protokol sürümü (`pv`) eşleşir — eski sürümler yenilerle eşleşip "eski sürüm" hatası almaz.
- Mod listeleri kesişmeli; maçın modu sunucuda seçilip herkese gönderilir (eskiden iki oyuncu farklı modda olabiliyordu).
- Bölge: önce saat dilimi ±2 sa, 4 sn sonra ±5 sa, 8 sn sonra herkes.
- Host = sunucuya en düşük gecikmeli oyuncu (ws ping).
- 15 sn rakip yoksa `{t:'bot'}` → oyun sormadan bot maçı başlatır (yalnız `bot:1` gönderen yeni istemciler).
- Host göçü oda kanalı (`room-join` / `host-migrate` → `host-migrated`) eklendi.
- `/ice`, `/stats`, isteğe bağlı uyanık kalma.

## Ortam değişkenleri (Render → Environment)
| Değişken | Ne işe yarar |
|---|---|
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare TURN (ayda 1000 GB ücretsiz). Cloudflare → Realtime → TURN Server → Create |
| `METERED_ICE_URL` | Alternatif: Metered TURN, `https://APP.metered.live/api/v1/turn/credentials?apiKey=...` |
| `BOT_FILL_MS` | Bot doldurma süresi, varsayılan 15000 |
| `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN` | Cloudflare hesap kimliği + "Account Analytics: Read" izinli API token. Aylık koruma bununla kullanımı okur; Cloudflare TURN açıkken bunlar YOKSA TURN verilmez (güvenli taraf) |
| `TURN_MONTH_CAP_GB` | son 30 günde bu kadar GB çıkış olunca TURN kapanır, varsayılan 800 (ücretsiz sınır 1000) |
| `ICE_DAY_CAP` | günde en çok TURN kimliği, varsayılan 500; dolunca salt STUN |
| `ICE_IP_PER_HOUR` | aynı IP'ye saatte en çok kimlik, varsayılan 20 |
| `ICE_TTL_S` | kimlik ömrü, varsayılan 10800 (3 saat) |
| `TURN_OFF` | `1` → TURN tamamen kapalı (acil durum) |
| `COKME_ANAHTAR` | `GET /g/cokme?anahtar=...` ile bellekteki çökme listesini okuma anahtarı (tanımsızsa uç 404) |
| `COKME_IP_SAAT` | aynı IP'den saatte en çok çökme raporu, varsayılan 20 |
| `KEEP_AWAKE` | `1` → kendi adresine 10 dk'da bir istek, Render ücretsiz plan uyumaz (ayda 750 saat, tek servis 7/24 ≈ 744 saat) |
| `IP_KAYNAK` | varsayılan: `cf-connecting-ip` (Cloudflare yazar), yoksa X-Forwarded-For son girdi. `xff` → yalnız X-Forwarded-For. Açılışta ilk 3 istekte `[ip] tanı` satırı (son hane maskeli) hangisinin dolu geldiğini gösterir |
| `WS_IP_EN_COK` | IP başına eşzamanlı ws bağlantısı (/mm + /g/sig toplam), varsayılan 32 (mobil operatörler çok oyuncuyu tek IP'de toplar) |
| `WS_PONG_MAC_MS`, `WS_PONG_LOBI_MS` | pong gelmeyen bağlantıyı kesme süresi: başlamış maçta 10000, lobide/kuyrukta 120000 (arka plana alınan uygulama atılmaz) |
| `CUZDAN_UID_DK`, `CUZDAN_IP_DK` | cüzdan yazma uçları (yukle/harca/odul) dakika sınırı: uid 20, IP 60 |
| `CUZDAN_OKU_UID_DK`, `CUZDAN_OKU_IP_DK` | cüzdan OKUMA ucu (`POST /g/cuzdan`) dakika sınırı: uid 60, IP 600 (aşılırsa 429) |
| `PLAY_BILDIRIM_ANAHTAR` | Play RTDN ucu `POST /g/play-bildirim?anahtar=...` gizli anahtarı (sabit zamanlı karşılaştırma). Tanımsızsa uç 404. Pub/Sub push abonelik adresi: `https://<sunucu>/g/play-bildirim?anahtar=<anahtar>` |
| `PLAY_BILDIRIM_IP_DK` | RTDN ucu IP başına dakika sınırı, varsayılan 300 |
| `IADE_TARAMA_DK` | Play voidedpurchases tarama aralığı (dakika), varsayılan 60 (eski `IADE_TARA_SAAT` saat olarak hâlâ okunur). Tembel tarama: uyuyan sunucuda zamanlayıcı kaçarsa gelen herhangi bir HTTP isteği, son taramadan bu kadar dk geçtiyse taramayı arka planda tetikler (isteği bekletmez; `PLAY_SERVIS_JSON` yoksa no-op). RTDN anlık yol, tarama güvenlik ağı |
| `EKONOMI_IP_DK` | `GET /g/ekonomi` IP başına dakika sınırı, varsayılan 30 |
| `RENDER` / `NODE_ENV=production` | (Render kendisi koyar) Bu ortamda `SAHTE_SATIN`, `SAHTE_CUZDAN` ya da `LIG_SART_ATLA` = `1` ise sunucu açık hata yazıp çıkış koduyla (1) kapanır (`uretim_kontrol.js`). `GERCEK_SATIN` bu kontrole dahil değildir |

**Kötüye kullanım korumaları (2026-11-14):** bozuk/boş ws mesajı yok sayılır, yakalanmayan hata süreci düşürmez (`/stats` `yakalanmayan` sayar); bağlantı başına saniyede 30 mesaj (patlama 60), aşan 1008 ile kapanır; oda kodu crypto ile ve çakışmasız; başarısız katılma bağlantı+IP başına dakikada 10, hatalar tek tip `oda yok`; `/g/desync` IP başına dakikada 10. Test: `node test_guvenlik.js`.

TURN tanımlı değilse yalnız STUN döner (eski davranış).

**Masraf koruması:** Cloudflare TURN sonradan ödemelidir ve panelde harcama tavanı yoktur. Bu yüzden sunucu son 30 günün faturalanan çıkış trafiğini 20 dk'da bir okur, 800 GB'a ulaşınca TURN'ü kapatır (kayan 30 gün → fatura dönemi nereden başlarsa başlasın 1000 GB aşılmaz). Kullanım 6 saattir okunamıyorsa da kapatır. Her oyuncuya kendi 3 saatlik kimliği verilir, IP ve günlük sınır vardır. `/stats` → `turn30dGB`, `turnBlocked`. Acil durdurma: `TURN_OFF=1` ya da Cloudflare'de TURN anahtarını silmek.

## Zorunlu güncelleme (MIN_PV)
- Ortam değişkeni `MIN_PV` (varsayılan 315): en düşük desteklenen ağ protokol sürümü (istemci `NET_PV`).
- Bu sürümün altındaki istemciler `find` gönderince kuyruğa alınmaz, `{t:'guncelle', minPv}` alır → oyun "GÜNCELLE" uyarısı verir.
- `MIN_PV` değerini yalnızca yeni sürüm %100 dağıtıma ulaştıktan sonra yükseltin.
- `GET /surum` → `{minPv}` (istemci açılışta okuyabilir); `/` yanıtında da `minPv` vardır.

## Yerelde test
```bash
npm install
PORT=9123 node server.js
node test_g.js 9123   # /g/sig protokol testi (12 kontrol)
```

## Günün kuralı (klasik mod varyantı)
- Veri: `kurallar.json` (`gunler` 0=Pazar…6, `oran` 0.25, `saatDilimi` Europe/Istanbul; gün sınırı sabit UTC+3). Aynı dosya istemcide `godot/veri/` ve `godot/proje/veri/` altında. Test için `KURALLAR_DOSYA` ortam değişkeni başka dosya gösterir.
- Kurallar: `can` (normal, 3 can; varsayılan), `zincir`, `ganimet`, `tac`, `fitil` (oyunda SICAK BOMBA), `hayatta` (HAYATTA KALMA). Hafta: Pzt+Sal zincir, Çar fitil, Per tac, Cum hayatta, Cmt+Paz ganimet.
- `find` mesajına `gunKurali:1|0` eklenir (yok = eski istemci = 0).
- Eşleşen mod `classic` ve gruptaki HERKES `gunKurali:1` ise olasılık `oran` ile bugünün kuralı seçilir; aksi `can`. Kuyruk bölünmez.
- `match` mesajına `kural:"<kural>"` yalnız `can` dışı seçildiyse eklenir (yok = can) → eski istemciler etkilenmez.
- `GET /kural` → `{gun:"YYYY-MM-DD", kural}` (bugünün kuralı; menü kartı için). `/stats` → `kural:{zincir:n,…,can:n}` (bugünkü maçlar). `[mm] eşleşme` satırında `kural X`.
- Test: `node test_kural.js` (saf işlevler + gerçek sunucu süreci).

## Cüzdan eklemeleri (2026-11-14)
- `kupa.json`: `gunlukKutuGem` 3 (kimlik başına günlük kutu gem tavanı); `haftaSeri` (haftalık yol gemisi seri kademeleri), `hedefGem` (oyun hedefi gemleri, 21 kayıt), `gunlukHedef` 3, `efsaneGun` 30; sayılar yalnız bu dosyadan okunur. `kupaYolu.seviyeSablon` girdilerinde `min`/`max` seviye sınırı (dahil) vardır.
- `POST /g/cuzdan/yukle` başarılı yanıtlarına (`yuklendi`, `zaten`, `geri_yuklendi`) `test: true|false` eklendi (Play `purchaseType === 0` → test); istemci analitikte test alımlarını ayırır.
- `POST /g/cuzdan/odul` yeni tür `hafta`: `{ v:1, olcek:5, kimlik, tur:'hafta', id:'w2026-46' }`. id = `w` + ISO 8601 hafta anahtarı `YYYY-WW` (UTC, Pazartesi başlar; yıl = haftanın Perşembe'sinin yılı). Sunucu şimdiki ya da bir önceki hafta dışını reddeder: eski → `{ok:false,durum:'sinir'}`, ileri/bozuk biçim → 400 `gecersiz`. Kimlik başına tek sefer (`odul/<uid>_<id>`); miktar istemciden alınmaz. Seri: cüzdan `hs` (seri sayısı) + `hw` (son ödül haftası); ardışık hafta seriyi artırır, 2+ hafta atlanırsa bir kademe düşer, geç talep seriyi değiştirmez; miktar `haftaSeri` kademesinden. `odul` belgesine `n` yazılır. Yanıt: `{ ok:true, durum:'verildi'|'zaten', miktar, gem, sahip, ... }`. Günlük kutu tavanına (`kgem`) sayılmaz.
- `POST /g/cuzdan/odul` tür `hedef`: `tur:'hedef', id:'h_<kural>'` (örn `h_mac:1000`; kural `kupa.json hedefGem` içinde olmalı, yoksa 400 `gecersiz`). Kimlik başına tek sefer; günlük tavan `gunlukHedef` (cüzdan `hgun`/`hsay`) aşılırsa `{ok:false,durum:'sinir'}` (istemci sonra dener). Verilmiş hedefin tekrarı tavandayken de `zaten`. Belge kimliğinde `:` yerine `~` kullanılır.
- `POST /g/cuzdan/odul` tür `efsane`: `tur:'efsane', id:'e<sayaç>'`. Sunucu öğeyi kendi seçer (gem'li, coin'siz, gem >= 50, açık dalga, gem paketlerinde olmayan, sahip olunmayan; sha256(uid:id) ile). `efsaneGun` (30) günden yakın önceki efsane (`et`) varsa `limit`; aday yoksa 400 `gecersiz`. Yanıt `oge` + cüzdan (`sahip` güncel); gem girişi yok.
- `/g/cuzdan/yukle` ve `/g/satin`: Play yanıtında `productId` bildirilenden farklıysa ya da `quantity` > 1 ise `gecersiz`. Tek seferlik üründe yeni jetonla ikinci alım `tek_sefer` (Play onayı çağrılmaz); `satin/<iz>` aynı uid'e aitse `zaten`. Express hata yakalayıcısı gövdeyi `{ok:false}` ile sınırlar.
- Set içerik genişlemesi göçü (`g_cuzdan.setGoc`): dukkan.json'da sonradan öğe eklenen tekSefer set paketlerinin alınmış olanları için eksik öğeler cüzdan okunurken `sahip`'e eklenir (gem verilmez); eklenenler cüzdandaki `goc` listesine yazılır. `POST /g/cuzdan` okumasında yalnız eksik varsa tek küçük yazım yapılır; eksik yoksa yazım yok. İade (`iadeUygula`) düşülecek öğeleri `satin.verilen.ogeler` + (`goc` ∩ paket `ogeler`) olarak hesaplar; satın almadan önce sahip olunan ya da başka yolla alınan öğeye dokunulmaz; düşen öğeler `goc`'dan da çıkar (yeniden göç etmez).
- Tembel iade taraması: bkz. `IADE_TARAMA_DK`; `istat.tembel` sayar.
- Test: `node test_goc.js` (hafta, test alanı, göç + iade, tembel tarama).

- Sürüm 5 güvenlik düzeltmeleri (`/g/cuzdan/odul`): eski (şimdiki/önceki/ileri hafta dışı) geçerli `w` kimliği `{ok:false,durum:'suresi_gecti'}` (200). `yol` adımı hem `yolTaban+yolGun*gün` hem `yolUst.taban+yolUst.gun*gün` (`kupa.json`) altında olmalı, yoksa `sinir`. `hedef`: hesap yaşı (`kt0`) `hedefGun[kural]` günden küçükse `sinir`. `efsane`: hesap yaşı `efsaneIlkGun` günden küçükse ya da iade borcu varsa `sinir`. Express hata yakalayıcısı yalnız 4xx/5xx `{ok:false}` döner, 5xx günlüğe yazılır.
