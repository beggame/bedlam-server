# Bedlam — Ağ Sunucusu v2 (sinyalleşme + Maç Ara + TURN)

Tek Node.js süreci, tek port. Maç trafiği sunucudan **geçmez** (WebRTC, gerekirse TURN rölesi).

| Yol | Görev |
|---|---|
| `/peerjs` | WebRTC sinyalleşme (PeerJS) |
| `/mm` | Maç Ara kuyruğu + host göçü oda kanalı (WebSocket) |
| `/ice` | STUN + kısa ömürlü TURN kimlikleri |
| `/stats` | bağlı oyuncu, kuyruk, bugünkü maç / bot doldurma, günün zirvesi |
| `/` | sağlık kontrolü |

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
| `KEEP_AWAKE` | `1` → kendi adresine 10 dk'da bir istek, Render ücretsiz plan uyumaz (ayda 750 saat, tek servis 7/24 ≈ 744 saat) |

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
```
