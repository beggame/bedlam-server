// ============================================================================
// BEDLAM — Sinyalleşme + Maç Ara Sunucusu (v2, 2026-10-10)
// Tek Node.js süreci, tek port:
//   /peerjs → PeerJS protokollü WebRTC sinyalleşme
//   /mm     → "Maç Ara" eşleştirme kuyruğu + host göçü oda kanalı (WebSocket)
//   /ice    → ICE sunucu listesi (STUN + TURN kimlik bilgileri)
//   /stats  → anlık sayılar (kaç kişi bağlı, kuyruk, bugünkü maç/bot sayısı)
//   /       → sağlık kontrolü
// Maç içi trafik sunucudan GEÇMEZ — oyuncular WebRTC ile doğrudan (ya da TURN rölesiyle) bağlanır.
//
// Ortam değişkenleri (hepsi isteğe bağlı):
//   CF_TURN_KEY_ID + CF_TURN_API_TOKEN → Cloudflare TURN (ayda 1000 GB ücretsiz)
//   METERED_ICE_URL                    → Metered TURN (https://APP.metered.live/api/v1/turn/credentials?apiKey=...)
//   BOT_FILL_MS   (varsayılan 15000)   → bu kadar beklenince istemciye "botla oyna" denir
//   KEEP_AWAKE=1                       → Render ücretsiz planda uyumamak için kendi adresine 10 dk'da bir istek
// ============================================================================
require('./uretim_kontrol').uygula();   // Render/production + SAHTE_SATIN/SAHTE_CUZDAN/LIG_SART_ATLA=1 → açık hata, çıkış 1
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { ExpressPeerServer } = require('peer');
const { WebSocketServer } = require('ws');

const { hizAsildi } = require('./g_magaza');
const PORT = process.env.PORT || 9000;
const BOT_FILL_MS = +(process.env.BOT_FILL_MS || 15000);
const MIN_PV = Number(process.env.MIN_PV) || 315; // en dusuk desteklenen ag protokol surumu (istemci NET_PV); altindakiler cevrimici oynayamaz -> GUNCELLE
const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { try { Object.defineProperty(req, 'ip', { value: gercekIp(req), configurable: true }); } catch (e) {} next(); });   /* g_* modülleri req.ip okur: hepsi aynı IP kuralını kullansın */   // Render önünde tek proxy: req.ip = proxy'nin eklediği son X-Forwarded-For girdisi (istemci başlıkları taklit edemez)
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
const iadeTembel = require('./g_iade');
app.use((req, res, next) => { try { iadeTembel.tembelTara(); } catch (e) {} next(); });   /* tembel iade taraması: uyuyan sunucuda zamanlayıcı kaçarsa istek tetikler (isteği bekletmez; PLAY_SERVIS_JSON yoksa no-op) */

// ---- Çökme koruması + ortak yardımcılar ------------------------------------
let yakalanmayan = 0;   /* /stats: süreç ayakta kalsa da sayılır */
process.on('uncaughtException', e => { yakalanmayan++; try { console.log('[HATA] uncaughtException', e && e.stack || e); } catch (_) {} });
process.on('unhandledRejection', e => { yakalanmayan++; try { console.log('[HATA] unhandledRejection', e && e.stack || e); } catch (_) {} });
/** Zamanlayıcı / geri çağrı sarmalayıcı: hata günlüğe yazılır, süreç düşmez. */
function guvenli(ad, fn) { return (...a) => { try { const r = fn(...a); if (r && typeof r.catch === 'function') r.catch(e => console.log('[HATA]', ad, e && e.message)); return r; } catch (e) { console.log('[HATA]', ad, e && e.stack || e); } }; }
/** ws yükseltme isteği için istemci IP'si (express dışı): gercekIp ile aynı kural. */
function wsIp(req) {
  return gercekIp(req);
}
/** İstemci IP'si (express ve ws için tek kural). Render önünde Cloudflare var: cf-connecting-ip'i Cloudflare her istekte kendisi yazar (istemci taklit edemez).
 *  IP_KAYNAK=xff ile yalnız X-Forwarded-For'un son girdisi kullanılır (Cloudflare yoksa). true-client-ip'e güvenilmez. İlk 3 istekte kaynak başlıklar (son hane maskeli) günlüğe düşer: doğrulama için. */
let ipTani = 0;
function gercekIp(req) {
  const h = (req && req.headers) || {}, cf = h['cf-connecting-ip'], x = h['x-forwarded-for'], sok = (req.socket && req.socket.remoteAddress) || '?';
  const mask = v => String(v || '-').replace(/[0-9a-f]+$/i, '*').slice(0, 80);
  if (ipTani < 3) { ipTani++; console.log('[ip] tanı: cf', mask(cf), '| xff', mask(x), '| soket', mask(sok)); }
  if (process.env.IP_KAYNAK !== 'xff' && typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  if (typeof x === 'string' && x.trim()) { const l = x.split(','); return l[l.length - 1].trim().slice(0, 64) || '?'; }
  return sok;
}
const WS_IP_EN_COK = Number(process.env.WS_IP_EN_COK) || 32;           // IP başına eşzamanlı ws bağlantısı (/mm + /g/sig toplam)
const WS_MSG_HIZ = 30, WS_MSG_PATLAMA = 60;   // bağlantı başına mesaj kovası: saniyede 30, en çok 60'lık patlama
const ipBaglanti = new Map();
/** Bağlantı başına mesaj kovası; aşan bağlantı 1008 ile kapatılır. true = devam. */
function mesajKovasi(ws) {
  const t = Date.now();
  if (ws._kv == null) { ws._kv = WS_MSG_PATLAMA; ws._kvT = t; }
  ws._kv = Math.min(WS_MSG_PATLAMA, ws._kv + (t - ws._kvT) / 1000 * WS_MSG_HIZ); ws._kvT = t;
  if (ws._kv < 1) { console.log('[ws] mesaj sınırı aşıldı, bağlantı kapatılıyor:', ws._ip); try { ws.close(1008, 'hiz'); } catch (e) {} return false; }
  ws._kv -= 1; return true;
}
/** Başarısız kod denemesi sınırı: bağlantı + IP başına dakikada 10; aşılırsa true (çağıran bağlantıyı kapatır). */
const ipDeneme = new Map();
function denemeAsildi(ws) {
  const t = Date.now(), sinir = 10, pen = 60000;
  const say = o => (!o || t - o.bas >= pen) ? { bas: t, n: 0 } : o;
  ws._dn = say(ws._dn); ws._dn.n++;
  const k = say(ipDeneme.get(ws._ip)); k.n++; ipDeneme.set(ws._ip, k);
  if (ipDeneme.size > 20000) ipDeneme.clear();
  return ws._dn.n > sinir || k.n > sinir;
}
setInterval(() => { const t = Date.now(); for (const [ip, k] of ipDeneme) if (t - k.bas >= 60000) ipDeneme.delete(ip); }, 60000).unref();
/** Ham mesajı ayrıştır: yalnız düz nesne kabul edilir (null, dizi, sayı, dize → null). */
function mesajAyristir(raw) {
  let d; try { d = JSON.parse(raw); } catch (e) { return null; }
  return (!d || typeof d !== 'object' || Array.isArray(d)) ? null : d;
}

const KURAL = require('./kural'); const kurallarCfg = KURAL.yukle();
const stats = { day: '', matches: 0, botFills: 0, peakOnline: 0, iceIssued: 0, kural: {} };
function statDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (stats.day !== d) { stats.day = d; stats.matches = 0; stats.botFills = 0; stats.peakOnline = 0; stats.iceIssued = 0; stats.kural = {}; }
}

app.get('/', (req, res) => res.json({ ok: true, name: 'darmaduman-net', v: 2, minPv: MIN_PV, uptime: Math.round(process.uptime()) }));
app.get('/surum', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ minPv: MIN_PV }); });

const server = http.createServer(app);

// ---- 1) PeerJS sinyalleşme ------------------------------------------------
const peerServer = ExpressPeerServer(server, { path: '/', allow_discovery: false, proxied: true });
app.use('/peerjs', peerServer);

// ---- 2) ICE sunucuları (TURN) ---------------------------------------------
// Mobil ağlarda (CGNAT, simetrik NAT) doğrudan bağlantı kurulamazsa trafik TURN rölesinden geçer.
// Kimlik bilgileri kısa ömürlüdür; sunucu üretir, istemci açılışta /ice'tan alır.
const STUN_ONLY = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
let iceSource = 'stun';
// MASRAF KORUMASI (Cloudflare 1000 GB/ay ücretsiz, sonrası ücretli):
//  - her istemciye KENDİ kimliği, kısa ömürlü (ICE_TTL_S, varsayılan 3 saat) → çalınan kimlik kısa sürede ölür
//  - aynı IP saatte en çok ICE_IP_PER_HOUR (20) kimlik alır
//  - günde en çok ICE_DAY_CAP (500) kimlik dağıtılır; dolunca herkes salt STUN alır (oyun yine çalışır)
//  - TURN_OFF=1 → TURN tamamen kapalı (acil durum anahtarı)
const ICE_TTL_S = +(process.env.ICE_TTL_S || 10800);
const ICE_IP_PER_HOUR = +(process.env.ICE_IP_PER_HOUR || 20);
const ICE_DAY_CAP = +(process.env.ICE_DAY_CAP || 500);
const ipHits = new Map(); // ip -> [zamanlar]
let meteredCache = null, meteredT = 0;

function cleanIce(list) {
  // Tarayıcılar 53 numaralı portu engeller → o adresler zaman aşımı yaratır, çıkar
  return (Array.isArray(list) ? list : [list]).map(s => {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => u && !/:53(\?|$)/.test(u));
    return urls.length ? { ...s, urls } : null;
  }).filter(Boolean);
}
// AYLIK KORUMA: son 30 günün Cloudflare TURN çıkış trafiği (faturalanan egressBytes) TURN_MONTH_CAP_GB'a
// (varsayılan 800, ücretsiz sınır 1000) ulaşınca TURN kapanır. Kayan 30 gün → fatura dönemi nereden başlarsa başlasın
// ücretsiz sınır aşılmaz. Okuma için CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN ("Account Analytics: Read" izinli) gerekir.
// Cloudflare TURN açık ama kullanım 6 saattir okunamıyorsa güvenli tarafta kalınır: TURN kapanır.
const TURN_MONTH_CAP_GB = +(process.env.TURN_MONTH_CAP_GB || 800);
const guard = { gb: null, okT: 0, err: '', blocked: false };
async function checkTurnUsage() {
  if (!(process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN)) return;
  if (!(process.env.CF_ACCOUNT_ID && process.env.CF_ANALYTICS_TOKEN)) { guard.err = 'analytics env yok'; guard.blocked = true; return; }
  try {
    const to = new Date(), from = new Date(Date.now() - 30 * 86400e3);
    const q = `query { viewer { accounts(filter: { accountTag: "${process.env.CF_ACCOUNT_ID}" }) {
      callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: "${from.toISOString().slice(0, 10)}", date_leq: "${to.toISOString().slice(0, 10)}" }) {
        sum { egressBytes } } } } }`;
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q })
    });
    const j = await r.json();
    if (!r.ok || j.errors && j.errors.length) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || ('http ' + r.status));
    const acc = (j.data && j.data.viewer && j.data.viewer.accounts || [])[0];
    if (!acc) throw new Error('hesap bulunamadı');
    let bytes = 0; for (const g of acc.callsTurnUsageAdaptiveGroups || []) bytes += (g.sum && g.sum.egressBytes) || 0;
    guard.gb = Math.round(bytes / 1e7) / 100; guard.okT = Date.now(); guard.err = '';
    guard.blocked = guard.gb >= TURN_MONTH_CAP_GB;
    if (guard.blocked) console.log(`[ice] 30 günlük TURN kullanımı ${guard.gb} GB ≥ ${TURN_MONTH_CAP_GB} GB → TURN KAPALI`);
  } catch (e) {
    guard.err = e.message;
    if (Date.now() - guard.okT > 6 * 3600e3) guard.blocked = true;
    console.log('[ice] kullanım okunamadı:', e.message);
  }
}
setInterval(checkTurnUsage, 20 * 60e3); checkTurnUsage();
function turnMode() {
  if (process.env.TURN_OFF === '1') return 'stun';
  if (guard.blocked) return 'stun';
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) return 'cloudflare';
  if (process.env.METERED_ICE_URL) return 'metered';
  if (process.env.ICE_YONLENDIR) return 'yonlendir';   // yalnız yerel test (godot/arac/ag_canli_test.ps1 -Asama B): TURN anahtarı yokken canlı sunucunun /ice ucu
  return 'stun';
}
async function fetchIce(mode) {
  if (mode === 'yonlendir') {
    const r = await fetch(process.env.ICE_YONLENDIR);
    if (!r.ok) throw new Error('yonlendir ' + r.status);
    return cleanIce((await r.json()).iceServers);
  }
  if (mode === 'cloudflare') {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: ICE_TTL_S })
    });
    if (!r.ok) throw new Error('cloudflare ' + r.status);
    return cleanIce((await r.json()).iceServers);
  }
  if (mode === 'metered') {
    if (meteredCache && Date.now() - meteredT < 3600e3) return meteredCache;
    const r = await fetch(process.env.METERED_ICE_URL);
    if (!r.ok) throw new Error('metered ' + r.status);
    meteredCache = [...STUN_ONLY, ...cleanIce(await r.json())]; meteredT = Date.now();
    return meteredCache;
  }
  return STUN_ONLY;
}
function clientIp(req) { /* gercekIp ile aynı kural (cf-connecting-ip, yoksa XFF son girdi) */
  return gercekIp(req);
}
function ipAllowed(ip) {
  const now = Date.now(), arr = (ipHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (arr.length >= ICE_IP_PER_HOUR) { ipHits.set(ip, arr); return false; }
  arr.push(now); ipHits.set(ip, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, arr] of ipHits) if (!arr.some(t => now - t < 3600e3)) ipHits.delete(ip); }, 600e3);
app.get('/ice', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  statDay();
  let mode = turnMode(), why = '';
  if (mode !== 'stun' && stats.iceIssued >= ICE_DAY_CAP) { mode = 'stun'; why = 'daycap'; }
  if (mode !== 'stun' && !ipAllowed(clientIp(req))) { mode = 'stun'; why = 'iplimit'; }
  let list = STUN_ONLY;
  try { list = await fetchIce(mode); if (mode !== 'stun') stats.iceIssued++; }
  catch (e) { console.log('[ice] alınamadı:', e.message); mode = 'stun'; why = 'error'; }
  iceSource = mode;
  res.json({ iceServers: list, src: mode, why, ttl: ICE_TTL_S });
});

// ---- 3) Maç Ara eşleştirme kuyruğu ----------------------------------------
// Protokol (JSON):
//   istemci → {t:'find', pv, size:2|3|4, mode, modes:[...]|null, tz, bot:1, kurallar:1|0}   kuyruğa gir
//   istemci → {t:'cancel'}
//   sunucu  → {t:'queued', size, waiting}
//   sunucu  → {t:'match', role:'host'|'guest', code, size, mode, delay, kural?}   kural: yalnız 'can' dışıysa (zincir|ganimet|tac|fitil|hayatta); yoksa = can
//   sunucu  → {t:'bot'}   BOT_FILL_MS dolup rakip bulunamadı (yalnız bot:1 diyenlere)
//   sunucu  → {t:'guncelle', minPv}   istemci surumu MIN_PV altinda (kuyruga alinmaz)
//   GET /surum → {minPv}
// Eşleşme kuralları:
//   - aynı ağ protokol sürümü (pv) ve aynı kişi sayısı
//   - mod listeleri kesişmeli; maçın modu kesişimden seçilir ve herkese gönderilir
//   - önce yakın saat dilimi (bölge), bekledikçe aralık genişler: 0-4 sn ±2 sa, 4-8 sn ±5 sa, sonra herkes
//   - host = sunucuya en düşük gecikmeli oyuncu (ws ping ile ölçülür)
const MM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // oyunla aynı alfabe
const ALL_MODES = ['classic', 'train', 'climb'];
const MODE_W = { classic: 0.6, train: 0.2, climb: 0.2 };
let queue = []; // {ws, pv, size, modes:Set, tz, bot, t0}

function makeCode() {   // crypto.randomInt; 4 karakter, aynı alfabe; mevcut odalarla (gOdalar + /mm rooms) çakışırsa yeniden üret
  let c = '';
  for (let k = 0; k < 200; k++) {
    c = ''; for (let i = 0; i < 4; i++) c += MM_ALPHABET[crypto.randomInt(MM_ALPHABET.length)];
    if (!(typeof gOdalar !== 'undefined' && gOdalar.has(c)) && !rooms.has(c)) return c;
  }
  return c;
}
function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function dropFromQueue(ws) { const n = queue.length; queue = queue.filter(e => e.ws !== ws); return queue.length !== n; }
function broadcastWaiting() {
  for (const e of queue) send(e.ws, { t: 'queued', size: e.size, waiting: queue.filter(o => o.size === e.size && o.pv === e.pv).length });
}
function parseModes(d) {
  let m = Array.isArray(d.modes) && d.modes.length ? d.modes : (d.mode ? [d.mode] : ALL_MODES);
  m = m.filter(x => ALL_MODES.includes(x));
  return new Set(m.length ? m : ALL_MODES);
}
function tzWindow(waitMs) { return waitMs < 4000 ? 2 : waitMs < 8000 ? 5 : 99; }
function intersect(a, b) { return new Set([...a].filter(x => b.has(x))); }
function pickMode(set) {
  const arr = [...set]; let sum = 0; for (const m of arr) sum += MODE_W[m];
  let r = Math.random() * sum;
  for (const m of arr) { r -= MODE_W[m]; if (r <= 0) return m; }
  return arr[0];
}

function tryMatch() {
  const now = Date.now();
  let changed = false;
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    let modes = a.modes;
    const group = [a];
    // en yakın saat diliminden başlayarak uygun adayları topla
    const cands = queue.filter(b => b !== a && b.pv === a.pv && b.size === a.size)
      .sort((x, y) => Math.abs(x.tz - a.tz) - Math.abs(y.tz - a.tz));
    for (const b of cands) {
      if (group.length >= a.size) break;
      const win = tzWindow(now - Math.min(a.t0, b.t0)); // ikisinden uzun bekleyen aralığı belirler
      if (Math.abs(b.tz - a.tz) > win) continue;
      const m = intersect(modes, b.modes);
      if (!m.size) continue;
      modes = m; group.push(b);
    }
    if (group.length < a.size) continue;
    queue = queue.filter(e => !group.includes(e));
    const code = makeCode();
    const mode = pickMode(modes);
    const kural = KURAL.sec(kurallarCfg, mode, group.map(e => e.kurallar), now, Math.random);
    const host = group.slice().sort((x, y) => (x.ws._rtt ?? 999) - (y.ws._rtt ?? 999))[0];
    for (const e of group) {
      const isHost = e === host;
      send(e.ws, { t: 'match', role: isHost ? 'host' : 'guest', code, size: a.size, mode, delay: isHost ? 0 : 900, ...(kural !== 'can' ? { kural } : {}) });
    }
    statDay(); stats.matches++; stats.kural[kural] = (stats.kural[kural] || 0) + 1;
    console.log(`[mm] eşleşme: ${a.size} kişi, ${mode}, kural ${kural}, tz ${group.map(e => e.tz).join('/')}, rtt ${group.map(e => e.ws._rtt ?? '?').join('/')} → ODA ${code}`);
    changed = true; i = -1; // kuyruk değişti, baştan tara
  }
  // uzun bekleyenleri bota yönlendir
  for (const e of queue.slice()) {
    if (e.bot && now - e.t0 >= BOT_FILL_MS) {
      send(e.ws, { t: 'bot' });
      dropFromQueue(e.ws); statDay(); stats.botFills++; changed = true;
    }
  }
  if (changed) broadcastWaiting();
}
setInterval(guvenli('tryMatch', tryMatch), 1000); // bekleme süresiyle genişleyen kurallar için düzenli tarama

// ---- 4) Host göçü oda kanalı ----------------------------------------------
// istemciler {t:'room-join', code} ile odaya abone olur; yeni host {t:'host-migrate', code} gönderir;
// sunucu odadaki DİĞER üyelere {t:'host-migrated', code} yayınlar.
const rooms = new Map(); // kod -> Set<ws>
function roomAdd(ws, code) {
  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws); ws._rooms.add(code);
}

// ---- WebSocket yönlendirme ------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const gSos = require('./g_arkadas').kur({ mesajKovasi, mesajAyristir });   // Paket B1: /g/sos arkadaş çevrimiçi durumu + davet (g_arkadas.js)
// PeerJS kendi 'upgrade' dinleyicisini takıp bilmediği yolları 400 ile reddediyor.
// Çözüm: mevcut dinleyicileri devral, /mm bize, gerisi PeerJS'e.
const peerUpgradeListeners = server.listeners('upgrade').slice();
server.removeAllListeners('upgrade');
server.on('upgrade', (req, socket, head) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/mm' || url === '/g/sig' || url === '/g/sos') {
    if (url === '/g/sos' && gSos.kapali()) { try { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); } catch (e) {} socket.destroy(); return; }   /* SOS_KAPALI=1 acil kapatma anahtarı */
    if (url === '/g/sos') {   /* /g/sos: /mm + /g/sig sayacından AYRI IP sayacı (eşzamanlı + yükseltme hızı; g_arkadas.ipAl) */
      const ip = wsIp(req), birak = gSos.ipAl(ip);
      if (!birak) { console.log('[sos] IP sınırı'); try { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); } catch (e) {} socket.destroy(); return; }
      socket.once('close', birak);
      gSos.wss.handleUpgrade(req, socket, head, ws => { ws._ip = ip; gSos.wss.emit('connection', ws, req); });
      return;
    }
    const ip = wsIp(req), n = ipBaglanti.get(ip) || 0;
    if (n >= WS_IP_EN_COK) { console.log('[ws] IP bağlantı sınırı:', ip); try { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); } catch (e) {} socket.destroy(); return; }
    ipBaglanti.set(ip, n + 1);
    socket.once('close', () => { const k = (ipBaglanti.get(ip) || 1) - 1; if (k <= 0) ipBaglanti.delete(ip); else ipBaglanti.set(ip, k); });
    const hedef = url === '/mm' ? wss : gwss;
    hedef.handleUpgrade(req, socket, head, ws => { ws._ip = ip; hedef.emit('connection', ws, req); });
  }
  else for (const fn of peerUpgradeListeners) fn.call(server, req, socket, head);
});

function measureRtt(ws) {
  const pongSinir = (ws._goda && ws._goda.basladi) ? (Number(process.env.WS_PONG_MAC_MS) || 10000) : (Number(process.env.WS_PONG_LOBI_MS) || 120000);   /* lobide/kuyrukta arka plana alınan uygulama (kod paylaşımı) atılmaz; yalnız başlamış maçta 10 sn */
  if (ws._sonPong && Date.now() - ws._sonPong > pongSinir) { console.log('[ws] pong yok, bağlantı kesiliyor:', ws._ip); try { ws.terminate(); } catch (e) {} return; }   // terminate → 'close' olağan akışla tetiklenir (askı/devam korunur)
  ws._pingT = Date.now();
  try { ws.ping(); } catch (e) {}
}
wss.on('connection', ws => {
  ws._rooms = new Set(); ws._sonPong = Date.now();
  ws.on('pong', () => {
    ws._sonPong = Date.now();
    const r = Date.now() - ws._pingT;
    ws._rtt = ws._rtt == null ? r : Math.round(ws._rtt * 0.5 + r * 0.5);
  });
  measureRtt(ws);
  ws._rttT = setInterval(guvenli('measureRtt', () => measureRtt(ws)), 3000);
  statDay(); stats.peakOnline = Math.max(stats.peakOnline, wss.clients.size);

  ws.on('message', raw => { try {
    if (!mesajKovasi(ws)) return;
    const d = mesajAyristir(raw); if (!d) return;
    if (typeof d.code === 'string') d.code = d.code.toUpperCase().slice(0, 8); // canlı v1 ile aynı: kod büyük harf
    if (d.t === 'find') {
      if ((d.pv | 0) < MIN_PV) { send(ws, { t: 'guncelle', minPv: MIN_PV }); return; }
      dropFromQueue(ws);
      queue.push({
        ws,
        pv: d.pv | 0,
        size: [2, 3, 4].includes(+d.size) ? +d.size : 2,
        modes: parseModes(d),
        tz: Number.isFinite(+d.tz) ? Math.max(-12, Math.min(14, +d.tz)) : 0,
        bot: !!d.bot,
        kurallar: d.kurallar === 1 || d.kurallar === true ? 1 : 0,   /* FARKLI KURALLAR; yok = eski istemci → 0 (can) */
        t0: Date.now()
      });
      broadcastWaiting();
      tryMatch();
    } else if (d.t === 'cancel') {
      if (dropFromQueue(ws)) broadcastWaiting();
      send(ws, { t: 'cancelled' });
    } else if (d.t === 'ping') {
      send(ws, { t: 'pong' });
    } else if (d.t === 'room-join' && typeof d.code === 'string' && d.code.length <= 8) {
      if (!ws._rooms.has(d.code) && ws._rooms.size >= 4) return;   /* bağlantı başına en çok 4 oda */
      if (!ws._rooms.has(d.code) && denemeAsildi(ws)) { try { ws.close(1008, 'hiz'); } catch (e) {} return; }   /* oda kodu deneme taraması: dakikada 10 yeni oda */
      roomAdd(ws, d.code);
    } else if (d.t === 'host-migrate' && typeof d.code === 'string' && d.code.length <= 8) {
      if (!ws._rooms.has(d.code)) return;   /* yalnız o odadaki bağlantıdan gelen göç yayılır */
      for (const m of rooms.get(d.code) || []) if (m !== ws) send(m, { t: 'host-migrated', code: d.code });
    }
  } catch (e) { console.log('[HATA] /mm mesaj', e && e.stack || e); } });
  const bye = () => {
    clearInterval(ws._rttT);
    if (dropFromQueue(ws)) broadcastWaiting();
    for (const c of ws._rooms) {
      const s = rooms.get(c);
      if (s) { s.delete(ws); if (!s.size) rooms.delete(c); }
    }
    ws._rooms.clear();
  };
  ws.on('close', bye);
  ws.on('error', bye);
});

// ---- 6) Godot istemcisi: /g/sig (godot/AG.md §4–§5) --------------------------------------------
// Web istemcisinden AYRI havuz (farklı protokol/sürüm; birbirleriyle eşleşmezler). Rollback'te host yok:
// sunucu yalnız odayı kurar, sdp/ice mesajlarını röleler, tohum/harita/kadro dağıtır.
//   → {t:'hello', pv, kimlik, ad, karakter, engel?:[etiket]}   ← {t:'ok', id} | {t:'guncelle', minPv}
//      pv 2 (Faz 7 K1/K3): kimlik = oyuncu etiketi (rakibe kadroda gider), engel = engellenen etiketler (kuyruk ve oda bunlarla eşleştirmez)
//   → {t:'cumle', id}                    ← odadaki diğerine {t:'cumle', kimden, id} (hazır cümle; yalnız 0..19 ve 1000..1255 = çıkartma, 3 sn'de 1)
//   → {t:'oda_kur'}                      ← {t:'oda', kod}
//   → {t:'katil', kod}                   ← {t:'oda', kod}; odadaki herkese {t:'esles', oyuncu, tohum, harita, kadro, tur:'oda', kurucu}
//      pv 4: özel oda 2–4 kişi (OZEL_KAPASITE). Her katılımda herkese güncel kadro gider (oyuncu = katılış sırası); istemciler
//      tam ağ kurar (sırası küçük olan teklif yapar). Maçı kurucu başlatır: {t:'kilit', oyunda:1|0} (oyundayken katılım 'oyunda' hatası).
//      Kurucu dışında biri çıkarsa oda açık kalır ({t:'ayrildi', kimden, acik:true}); kurucu çıkarsa oda kapanır (acik:false, kapandi:true).
//   → {t:'ara', bot:1, bolge, rtt[, kisi:2|3|4, takim:'tek'|'2v2']}  ← {t:'kuyruk', bekleyen[, kisi, bulunan]} | {t:'esles', ..., tur:'ara'[, kisi, takim]} | {t:'bot'[, kisi, takim]}
//   → {t:'sdp'|'ice'|'yeniden', kime?, ...}   ← aynı mesaj kime'ye (yoksa odadaki diğerlerine) {kimden} ile; 'yeniden': kopan eş bağlantısını kurmasını ister
//   → {t:'yol', yol:'host'|'srflx'|'relay', rtt}   istatistik
//   → {t:'iptal'} / {t:'ayril'}          ← karşıya {t:'ayrildi', kimden}
//   pv 5 SİNYAL DEVAMI: 'ok' yanıtı {jeton} taşır. Odadaki üyenin soketi kapanınca (telefonda Wi-Fi kapandı / Wi-Fi↔mobil geçişi) hemen ayrılmış
//   sayılmaz: G_ASKI_MS (15 sn; istemcinin 12 sn eş kararından uzun) askıda, yuvası durur. Yeni soket → {t:'devam', jeton, pv} ← {t:'devam_ok', id, kod}
//   (kimlik ve yuva devredilir; eski soket sunucuda hâlâ açık görünse de) | {t:'devam_yok'} (süre doldu / jeton yok). Süre dolarsa eski akış (ayrildi).
//   POST /g/desync {pv, harita, tik, hashBiz, hashO}   (yalnız özet; sayaç)
const MIN_PV_GODOT = Number(process.env.MIN_PV_GODOT) || 6;   // 6: bot v2 + bomba kuralları (sim kuralı değişti, 5 ile desync); 5: rövanş paketi + sim içi DURDUR + kopma toparlanması (eşler arası; sunucu aynı); 4: özel oda 2–4 kişi + takım (tam ağ, kime yönlendirme, kilit); 3: özel odada maç ayarı BASLA paketinde (ev sahibi harita/mod/can/süre); 2: Faz 7 K1 el sıkışma kartı + emote (godot/AG.md §10); altı → güncelle ekranı
const G_BOT_FILL_MS = +(process.env.G_BOT_FILL_MS || 15000);
const OZEL_KAPASITE = 4;   // pv 4: kodla kurulan oda en çok 4 insan (botlar istemcide, sim içinde)
const G_HARITALAR = ['aztek', 'saray', 'lab', 'pagoda', 'uzay', 'kasaba', 'seker', 'yanardag', 'dolap', 'lotus']; // Godot Faz 4: 10 harita (istemci veri/haritalar/*.json ile aynı adlar)
const gwss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
let gKuyruk = [];            // {ws, bolge, rtt, bot, t0, kisi, takim}
const gOdalar = new Map();   // kod -> {kod, uyeler:[ws], tohum, harita, basladi}
const gStats = { eslesme: 0, bot: 0, yol: { host: 0, srflx: 0, relay: 0, prflx: 0 }, desync: 0 };
let gId = 1;
const G_ASKI_MS = +(process.env.G_ASKI_MS || 15000);
// Sessiz ölen soket (rakibin uygulaması dondu / ağı TCP kapanmadan gitti): maçtaki pv 5 istemci 2 sn'de bir ping atar. Başlamış odadaki üyeden
// G_SESSIZ_MS mesaj gelmezse soketi kapatılır → olağan askı (G_ASKI_MS) → ayrildi: kalan oyuncu maçı kazanır (eskiden kimse bilmezdi, iki taraf da "Rakipten haber yok").
const G_SESSIZ_MS = +(process.env.G_SESSIZ_MS || 8000);
const gJeton = new Map();   // devam jetonu → üye soketi (canlı ya da askıda)
function gYeniJeton() { let j = ''; for (let i = 0; i < 24; i++) j += MM_ALPHABET[crypto.randomInt(MM_ALPHABET.length)]; return j; }
/** pv 5: eski üyenin kimliğini, odasını ve jetonunu yeni sokete devret (askıdaki ya da hâlâ açık görünen eski soket). */
function gDevret(eski, yeni) {
  for (const k of ['_gid', '_ad', '_kimlik', '_karakter', '_engel', '_pv', '_jeton']) yeni[k] = eski[k];
  yeni._hello = true; yeni._goda = eski._goda; eski._goda = null; eski._devredildi = true;
  if (eski._askiT) { clearTimeout(eski._askiT); eski._askiT = null; }
  const oda = yeni._goda; if (oda) { const i = oda.uyeler.indexOf(eski); if (i >= 0) oda.uyeler[i] = yeni; }
  gJeton.set(yeni._jeton, yeni);
  try { if (eski.readyState === 1) eski.terminate(); } catch (e) {}
}

function gSend(ws, o) { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }
function gTohum() { return crypto.randomInt(0x7fffffff) * 2 + crypto.randomInt(2); }
function gKadro(uyeler) { return uyeler.map(w => ({ id: w._gid, ad: w._ad, karakter: w._karakter || 'kivilcim', etiket: w._kimlik || '' })); }
// Faz 7 K3: iki taraftan biri diğerini engellediyse eşleşmez; farklı pv hiç eşleşmez (AG.md §10 sürüm kuralı)
function gEngelli(a, b) { return (!!b._kimlik && a._engel && a._engel.has(b._kimlik)) || (!!a._kimlik && b._engel && b._engel.has(a._kimlik)); }
function gUyumlu(a, b) { return a._pv === b._pv && !gEngelli(a, b); }
function gBaslat(oda, tur, ek = {}) {
  oda.basladi = true; oda.tohum = gTohum(); oda.harita = G_HARITALAR[Math.floor(Math.random() * G_HARITALAR.length)];
  oda.uyeler.forEach((w, i) => gSend(w, { t: 'esles', oyuncu: i, kod: oda.kod, tohum: oda.tohum, harita: oda.harita, kadro: gKadro(oda.uyeler), tur, ...ek }));
  statDay(); stats.matches++; gStats.eslesme++;
  console.log(`[g] eşleşme ${tur}: oda ${oda.kod}, rtt ${oda.uyeler.map(w => w._rtt ?? '?').join('/')}`);
}
function gOdadanCik(ws) {
  const oda = ws._goda; if (!oda) return;
  const kurucuydu = oda.uyeler[0] === ws;
  oda.uyeler = oda.uyeler.filter(w => w !== ws); ws._goda = null;
  if (oda.ozel) {
    // pv 4 özel oda: kurucu dışında biri çıkarsa oda açık kalır (maçtaysa kalanlar onu eler, maç sürer; lobideyse yuvası boşalır).
    // Kurucu çıkarsa oda kapanır: kalanlar maçtaysa maçı bitirir, sonra menüye döner.
    if (kurucuydu) {
      for (const w of oda.uyeler) { gSend(w, { t: 'ayrildi', kimden: ws._gid, acik: false, kapandi: true }); w._goda = null; }
      oda.uyeler = []; gOdalar.delete(oda.kod); return;
    }
    if (oda.uyeler.length === 1) oda.basladi = false;   /* kurucu tek kaldı: kilit açılır */
    for (const w of oda.uyeler) gSend(w, { t: 'ayrildi', kimden: ws._gid, acik: true });
    if (!oda.uyeler.length) gOdalar.delete(oda.kod);
    return;
  }
  for (const w of oda.uyeler) gSend(w, { t: 'ayrildi', kimden: ws._gid, acik: false });
  if (!oda.uyeler.length) gOdalar.delete(oda.kod);
}
/** Özel oda kadrosu herkese (her katılımda): istemci yeni eşlere bağlanır, kurucu yuvaları günceller. */
function gOdaKadro(oda) {
  oda.uyeler.forEach((w, i) => gSend(w, { t: 'esles', oyuncu: i, kod: oda.kod, tohum: oda.tohum, harita: oda.harita, kadro: gKadro(oda.uyeler), tur: 'oda', kurucu: oda.uyeler[0]._gid }));
}
function gKuyruktanCik(ws) { const n = gKuyruk.length; gKuyruk = gKuyruk.filter(e => e.ws !== ws); return gKuyruk.length !== n; }
/** K4 (pv değişmez): hızlı eşleşme isteği isteğe bağlı kisi (2|3|4) + takim ('tek'|'2v2', yalnız 4 kişide); alan yoksa 2 / 'tek' (eski istemci). */
function gKuyrukKalip(d) {
  const kisi = [2, 3, 4].includes(+d.kisi) ? +d.kisi : 2;
  const ml = Array.isArray(d.modlar) ? d.modlar.slice(0, 3).filter(x => ALL_MODES.includes(x)) : [];   /* aramada seçilen modlar; yok/boş (eski istemci) = yalnız klasik */
  return { kisi, takim: kisi === 4 && d.takim === '2v2' ? '2v2' : 'tek', kurallar: d.kurallar === 1 || d.kurallar === true ? 1 : 0, modlar: new Set(ml.length ? ml : ['classic']) };   /* kurallar: FARKLI KURALLAR; yok = eski istemci → 0 (can) */
}
/** a ile aynı kalıpta (kisi+takim, pv/engel uyumlu, saat dilimi penceresi içinde) en çok a.kisi insanlık grup; a her zaman ilk. */
function gGrupBul(a, now) {
  const cands = gKuyruk.filter(b => b !== a && b.kisi === a.kisi && b.takim === a.takim && intersect(a.modlar, b.modlar).size > 0 && gUyumlu(a.ws, b.ws)).sort((x, y) => Math.abs(x.bolge - a.bolge) - Math.abs(y.bolge - a.bolge));
  const grup = [a]; let ortak = a.modlar;   /* grubun ortak mod kümesi: her yeni üye kesişimi boşaltmamalı */
  for (const c of cands) {
    if (grup.length >= a.kisi) break;
    if (Math.abs(c.bolge - a.bolge) > tzWindow(now - Math.min(a.t0, c.t0))) continue;
    const yeni = intersect(ortak, c.modlar); if (!yeni.size) continue;
    if (grup.every(g => gUyumlu(g.ws, c.ws))) { grup.push(c); ortak = yeni; }
  }
  return grup;
}
function gKuyrukYayin() {
  const now = Date.now();
  for (const e of gKuyruk) {
    if (e.kisi > 2) gSend(e.ws, { t: 'kuyruk', bekleyen: gKuyruk.length, kisi: e.kisi, bulunan: gGrupBul(e, now).length });
    else gSend(e.ws, { t: 'kuyruk', bekleyen: gKuyruk.length });
  }
}
/** Kuyruk grubundan oda kur ve başlat. Eksik yuvalar (kisi - insan) istemcide bot: sunucu yalnız insanları listeler, kurucu (en eski bekleyen) kadroyu BASLA ile verir. */
function gKuyrukOdasi(grup) {
  grup.sort((x, y) => x.t0 - y.t0);
  gKuyruk = gKuyruk.filter(e => !grup.includes(e));
  const kod = makeCode();
  const oda = { kod, uyeler: grup.map(e => e.ws), basladi: false };
  gOdalar.set(kod, oda); for (const e of grup) e.ws._goda = oda;
  let ortak = grup[0].modlar || new Set(['classic']); for (const e of grup) ortak = intersect(ortak, e.modlar || new Set(['classic']));
  const mod = ortak.size ? pickMode(ortak) : 'classic';   /* ortak modlardan ağırlıklı (klasik 0,6, tren 0,2, tırmanma 0,2) */
  const kural = KURAL.sec(kurallarCfg, mod, grup.map(e => e.kurallar), Date.now(), Math.random);   /* FARKLI KURALLAR: gruptaki herkes açıksa ağırlıklı (can 3, diğerleri 1); tırmanmada kural yok */
  stats.kural[kural] = (stats.kural[kural] || 0) + 1;
  gBaslat(oda, 'ara', { ...(grup[0].kisi > 2 ? { kisi: grup[0].kisi, takim: grup[0].takim } : {}), ...(kural !== 'can' ? { kural } : {}), ...(mod !== 'classic' ? { mod } : {}) });
}
function gEslestir() {
  const now = Date.now();
  let degisti = false;
  for (let i = 0; i < gKuyruk.length; i++) {
    const a = gKuyruk[i];
    const grup = gGrupBul(a, now);
    if (grup.length < a.kisi) continue;
    gKuyrukOdasi(grup);
    degisti = true; i = -1;
  }
  for (const e of gKuyruk.slice()) {
    if (!gKuyruk.includes(e)) continue;
    if (e.bot && now - e.t0 >= G_BOT_FILL_MS) {
      if (e.kisi > 2) {
        const grup = gGrupBul(e, now);
        if (grup.length >= 2) { gKuyrukOdasi(grup); statDay(); stats.botFills++; gStats.bot++; degisti = true; continue; }   /* 2+ insan: eksik yuvalar bot dolgusu */
        gSend(e.ws, { t: 'bot', kisi: e.kisi, takim: e.takim });   /* tek insan: yerel bot maçı (kisi - 1 bot) */
      } else gSend(e.ws, { t: 'bot' });
      gKuyruktanCik(e.ws); statDay(); stats.botFills++; gStats.bot++; degisti = true;
    }
  }
  if (degisti) gKuyrukYayin();
}
setInterval(guvenli('gEslestir', gEslestir), 1000);
setInterval(guvenli('sessiz', () => {   /* yalnız başlamış, başka üyesi olan odada ve jetonlu (pv 5, nabız atan) üyede: lobide arka plana alınan uygulama ya da rakibi gitmiş tek kalan (artık nabız atmaz) atılmaz */
  const t = Date.now();
  for (const ws of gwss.clients) if (ws._goda && ws._goda.basladi && ws._goda.uyeler.length > 1 && ws._jeton && !ws._bitti && t - ws._sonT > G_SESSIZ_MS) { console.log(`[g] sessiz soket (${t - ws._sonT} ms): üye ${ws._gid} oda ${ws._goda.kod}`); ws.terminate(); }
}), 1000);
// Faz 7.6 dereceli lig (K2): ayrı kuyruk, puan/sonuç sunucuda (g_lig.js)
const gLig = require('./g_lig').kur(app, { gonder: gSend, uyumlu: gUyumlu, odaBaslat: (a, b, ek) => { const kod = makeCode(); const oda = { kod, uyeler: [a, b], basladi: false }; gOdalar.set(kod, oda); a._goda = oda; b._goda = oda; gBaslat(oda, 'dereceli', ek); } });

gwss.on('connection', ws => {
  ws._gid = gId++; ws._ad = 'Oyuncu'; ws._goda = null; ws._hello = false; ws._sonT = Date.now(); ws._sonPong = Date.now();
  ws.on('pong', () => { ws._sonPong = Date.now(); const r = Date.now() - ws._pingT; ws._rtt = ws._rtt == null ? r : Math.round(ws._rtt * 0.5 + r * 0.5); });
  measureRtt(ws); ws._rttT = setInterval(guvenli('measureRtt', () => measureRtt(ws)), 3000);
  statDay(); stats.peakOnline = Math.max(stats.peakOnline, wss.clients.size + gwss.clients.size);
  ws.on('message', raw => { try {
    ws._sonT = Date.now();
    if (!mesajKovasi(ws)) return;
    const d = mesajAyristir(raw); if (!d) return;
    if (d.t === 'hello') {
      if ((d.pv | 0) < MIN_PV_GODOT) { gSend(ws, { t: 'guncelle', minPv: MIN_PV_GODOT }); return; }
      ws._hello = true; ws._pv = d.pv | 0;
      ws._ad = String(d.ad || 'Oyuncu').slice(0, 16); ws._kimlik = /^[A-Z0-9]{3,12}$/.test(String(d.kimlik || '')) ? String(d.kimlik) : ''; ws._karakter = String(d.karakter || 'kivilcim').slice(0, 24);
      ws._engel = new Set((Array.isArray(d.engel) ? d.engel : []).slice(0, 200).map(String).filter(x => /^[A-Z0-9]{3,12}$/.test(x)));
      if (ws._jeton) gJeton.delete(ws._jeton);   /* tekrar hello: eski jeton geçersiz (yetim jeton kalmaz) */
      ws._jeton = gYeniJeton(); gJeton.set(ws._jeton, ws);
      gSend(ws, { t: 'ok', id: ws._gid, minPv: MIN_PV_GODOT, jeton: ws._jeton });
      return;
    }
    if (d.t === 'devam') {
      const eski = gJeton.get(String(d.jeton || ''));
      if ((d.pv | 0) < MIN_PV_GODOT || !eski || eski === ws || !eski._goda) { gSend(ws, { t: 'devam_yok' }); return; }
      gDevret(eski, ws); gStats.devam = (gStats.devam || 0) + 1;
      console.log(`[g] devam: üye ${ws._gid} oda ${ws._goda.kod}`);
      gSend(ws, { t: 'devam_ok', id: ws._gid, kod: ws._goda.kod });
      return;
    }
    if (!ws._hello) { gSend(ws, { t: 'hata', neden: 'hello yok' }); return; }
    if (typeof d.kod === 'string') d.kod = d.kod.toUpperCase().slice(0, 8);
    if (d.t === 'oda_kur') {
      gKuyruktanCik(ws); gOdadanCik(ws);
      const kod = makeCode(); const oda = { kod, uyeler: [ws], basladi: false, ozel: true, tohum: gTohum(), harita: G_HARITALAR[Math.floor(Math.random() * G_HARITALAR.length)] };   /* ozel: kodla kurulan oda (2–4 kişi; tohum/harita yalnız varsayılan, maç ayarını kurucu BASLA ile verir) */
      gOdalar.set(kod, oda); ws._goda = oda;
      gSend(ws, { t: 'oda', kod, oyuncu: 0 });
    } else if (d.t === 'katil') {
      const oda = gOdalar.get(d.kod || '');
      if (oda && oda.uyeler.includes(ws)) return;
      /* oda var/yok/dolu/oyunda/sürüm/engel ayırt edilemesin: hepsi 'oda yok' (istemci metni: "Böyle bir oda yok."); deneme sınırı aşılırsa bağlantı kapanır */
      if (!oda || oda.basladi || oda.uyeler.length >= (oda.ozel ? OZEL_KAPASITE : 2) || oda.uyeler.some(w => !gUyumlu(w, ws))) {
        if (denemeAsildi(ws)) { console.log('[g] kod deneme sınırı:', ws._ip); try { ws.close(1008, 'hiz'); } catch (e) {} return; }
        gSend(ws, { t: 'hata', neden: 'oda yok' }); return;
      }
      gKuyruktanCik(ws); gOdadanCik(ws);
      oda.uyeler.push(ws); ws._goda = oda;
      gSend(ws, { t: 'oda', kod: oda.kod, oyuncu: oda.uyeler.length - 1 });
      statDay(); stats.matches++; gStats.eslesme++;
      console.log(`[g] oda ${oda.kod} katılım: ${oda.uyeler.length} kişi`);
      gOdaKadro(oda);
    } else if (d.t === 'kilit') {
      const oda = ws._goda; if (!oda || !oda.ozel || oda.uyeler[0] !== ws) return;   /* yalnız kurucu */
      oda.basladi = !!d.oyunda;
    } else if (d.t === 'ara' && d.dereceli) {
      gKuyruktanCik(ws); gOdadanCik(ws); gLig.araIstek(ws, d);
    } else if (d.t === 'ara') {
      gKuyruktanCik(ws); gOdadanCik(ws); gLig.cik(ws);
      gKuyruk.push({ ...gKuyrukKalip(d), ws, bolge: Number.isFinite(+d.bolge) ? Math.max(-12, Math.min(14, +d.bolge)) : 0, rtt: +d.rtt || ws._rtt || 999, bot: !!d.bot, t0: Date.now() });
      gKuyrukYayin(); gEslestir();
    } else if (d.t === 'iptal') {
      if (gKuyruktanCik(ws)) gKuyrukYayin(); gLig.cik(ws);
      gSend(ws, { t: 'iptal_ok' });
    } else if (d.t === 'sdp' || d.t === 'ice' || d.t === 'yeniden') {
      const oda = ws._goda; if (!oda) return;
      const kime = d.kime == null ? null : d.kime | 0;
      for (const w of oda.uyeler) if (w !== ws && (kime == null || w._gid === kime)) gSend(w, { ...d, kimden: ws._gid });
    } else if (d.t === 'yol') {
      const y = String(d.yol || ''); if (y in gStats.yol) gStats.yol[y]++;
      console.log(`[g] yol ${y} rtt ${d.rtt | 0} ms (oda ${ws._goda ? ws._goda.kod : '-'})`);
    } else if (d.t === 'cumle') {
      const oda = ws._goda, id = d.id | 0; if (!oda || !((id >= 0 && id <= 19) || (id >= 1000 && id <= 1255))) return;   /* 1000+N: çıkartma kimliği N (emote.json), lobide sataşma çıkartması */
      const t = Date.now(); if (ws._cumleT && t - ws._cumleT < 3000) return; ws._cumleT = t;
      for (const w of oda.uyeler) if (w !== ws) gSend(w, { t: 'cumle', kimden: ws._gid, id });
    } else if (d.t === 'ayril') {
      gOdadanCik(ws);   /* açık çıkış: askı yok (bye'da _goda boş) */
    } else if (d.t === 'ping') {
      gSend(ws, { t: 'pong', z: d.z });
    }
  } catch (e) { console.log('[HATA] /g/sig mesaj', e && e.stack || e); } });
  const bye = () => {
    if (ws._bitti) return; ws._bitti = true;   /* error + close iki kez çağırır */
    clearInterval(ws._rttT); if (gKuyruktanCik(ws)) gKuyrukYayin();
    if (ws._devredildi) return;   /* kimliği yeni sokete geçti */
    if (ws._goda && ws._jeton) {   /* pv 5: odadaki üye askıya (yuvası durur); süre dolarsa ayrılır */
      console.log(`[g] askida: üye ${ws._gid} oda ${ws._goda.kod}`);
      ws._askiT = setTimeout(guvenli('aski', () => { ws._askiT = null; if (ws._devredildi) return; gJeton.delete(ws._jeton); gLig.kopma(ws); gOdadanCik(ws); }), G_ASKI_MS);
      return;
    }
    if (ws._jeton) gJeton.delete(ws._jeton);
    gLig.kopma(ws); gOdadanCik(ws);
  };
  ws.on('close', bye); ws.on('error', bye);
});
app.use('/g/desync', express.json({ limit: '4kb' }));
const gAlan = v => String(v ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').slice(0, 40);   // günlük satırı enjeksiyonu yok: kontrol karakteri temizle, 40'a kes
app.post('/g/desync', (req, res) => {
  if (hizAsildi(clientIp(req), 10, 'desync')) return res.status(429).json({ ok: false });
  const d = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  gStats.desync++;
  console.log(`[g] DESYNC pv ${gAlan(d.pv)} harita ${gAlan(d.harita)} tik ${gAlan(d.tik)} ${gAlan(d.hashBiz)} ≠ ${gAlan(d.hashO)}`);
  res.json({ ok: true });
});
app.get('/g/surum', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ minPv: MIN_PV_GODOT, haritalar: G_HARITALAR }); });
// Faz 7 mağaza uçları (/g/satin v1 …): g_magaza.js
const gMagaza = require('./g_magaza').kur(app);
const gHesap = require('./g_hesap').kur(app);   // Faz 7.5 /g/ayar + hesap silme işi
const gCuzdan = require('./g_cuzdan').kur(app);   // Faz 7.7 gem cüzdanı (/g/cuzdan v1)
const gIade = require('./g_iade').kur();   // Sürüm 5 Play iadesinde gem geri alma
require('./g_iade').bildirimKur(app);   // Play RTDN (Pub/Sub push) /g/play-bildirim
require('./g_ekonomi').kur(app);   // GET /g/ekonomi (dükkân ekonomi sayıları, gem fiyatı yok)
const gSosyal = require('./g_sosyal').kur(app);   // Faz 7.8 /g/rapor v1
const gCokme = require('./g_cokme').kur(app);   // Adım 11 /g/cokme çökme raporu

app.get('/kural', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(KURAL.bugunKural(kurallarCfg, Date.now())); });

app.get('/stats', (req, res) => {
  statDay();
  res.set('Cache-Control', 'no-store');
  res.json({
    godot: { online: gwss.clients.size, kuyruk: gKuyruk.length, odalar: gOdalar.size, ...gStats, minPv: MIN_PV_GODOT, magaza: gMagaza.istat, hesap: gHesap.istat, cuzdan: gCuzdan.istat, iade: gIade.istat, sosyal: gSosyal.istat, lig: gLig.istat, cokme: gCokme.istat, sos: gSos.istat() },
    online: wss.clients.size, queue: queue.length, rooms: rooms.size,
    today: stats.day, matches: stats.matches, kural: stats.kural, botFills: stats.botFills, peakOnline: stats.peakOnline,
    ice: turnMode(), iceIssued: stats.iceIssued, iceDayCap: ICE_DAY_CAP, turn30dGB: guard.gb, turnCapGB: TURN_MONTH_CAP_GB, turnBlocked: guard.blocked, guardErr: guard.err, yakalanmayan, uptime: Math.round(process.uptime())
  });
});

// ---- 5) Uyanık kalma (Render ücretsiz plan) --------------------------------
// Render, 15 dk dışarıdan istek gelmeyen ücretsiz servisi uyutur. KEEP_AWAKE=1 ise sunucu kendi
// genel adresine 10 dk'da bir istek atar. Ücretsiz plan ayda 750 saat verir (tek servis 7/24 = ~744 saat).
if (process.env.KEEP_AWAKE === '1' && process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + '/?keep=1').catch(() => {}); }, 10 * 60 * 1000);
}

/* Express hata yakalayıcısı (tüm route'lardan sonra): yığın izi / dosya yolu sızmasın */
app.use((e, req, res, next) => { if (res.headersSent) return next(e); const k = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500; if (k >= 500) console.log('[hata]', e.message); res.status(k).json({ ok: false }); });

server.listen(PORT, '0.0.0.0', () => console.log(`darmaduman-net v2 hazır → :${PORT} (/peerjs, /mm, /ice, /stats)`));
