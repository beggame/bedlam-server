# Darmaduman / Bedlam — Ağ Sunucusu (sinyalleşme + Maç Ara)

Tek Node.js süreci, tek port. İki görevi var:

- **/peerjs** → WebRTC sinyalleşme (PeerJS bulutunun yerine geçer; oda kodu akışı da artık buradan çalışır)
- **/mm** → "Maç Ara" eşleştirme kuyruğu (2 / 3 / 4 kişilik)

Maç trafiği sunucudan **geçmez** — oyuncular WebRTC ile birbirine doğrudan bağlanır. Bu yüzden ücretsiz/küçük bir sunucu bile binlerce oyuncuya sinyalleşme sağlayabilir.

## Yerelde çalıştırma (test)

```bash
npm install
npm start          # varsayılan port 9000
```

Sağlık kontrolü: `http://localhost:9000/` → `{"ok":true,...}`

## İnternete açma (Render — ücretsiz, önerilen)

1. Bu klasörü bir GitHub deposuna yükle (ya da Render "Deploy from Git" olmadan manuel).
2. https://render.com → New → **Web Service** → depoyu seç.
3. Ayarlar: Runtime **Node**, Build Command `npm install`, Start Command `npm start`. Render `PORT` değişkenini kendisi verir, kod bunu okuyor.
4. Deploy bitince sana bir adres verir: `https://SENIN-SERVISIN.onrender.com`

Alternatifler: Railway, Fly.io, kendi VPS'in (Hetzner vb.) — hepsinde tek gereksinim Node 18+ ve tek açık port.

> Not: Render ücretsiz planında servis 15 dk boşta kalınca uyur, ilk istekte ~30 sn'de uyanır. Test için sorun değil; yayında küçük ücretli plana geçmek gerekir.

## Oyunu sunucuya bağlama

Oyun HTML dosyasında en üstteki ağ bölümünde şu satırı bul:

```js
const NET_SERVER = (typeof window!=='undefined' && window.__NET_SERVER) || '';
```

`''` yerine sunucu adresini yaz:

```js
const NET_SERVER = (typeof window!=='undefined' && window.__NET_SERVER) || 'https://SENIN-SERVISIN.onrender.com';
```

- Adres doluysa: oda kodu + MAÇ ARA bu sunucudan çalışır.
- Adres boşsa: oda kodu eski PeerJS bulutuyla çalışmaya devam eder, MAÇ ARA "sunucu ayarlı değil" uyarısı verir.

## Eşleştirme protokolü (istemci ↔ /mm)

```
istemci → {t:'find', size:2|3|4}    kuyruğa gir
istemci → {t:'cancel'}              kuyruktan çık
sunucu  → {t:'queued', size, waiting}
sunucu  → {t:'match', role:'host'|'guest', code, size, delay}
```

Eşleşince: host `kadim-arena-<code>` kimliğiyle odayı kurar, misafirler `delay` ms bekleyip aynı koda katılır — sonrası mevcut oda kodu akışının aynısı.

## Sonraki adımlar (yol haritası)

- TURN sunucusu (kısıtlı NAT'lı mobil ağlar için) — adım 4
- Bölgesel kuyruklar / beceri eşleştirme — yayın sonrası
