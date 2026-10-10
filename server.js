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
const http = require('http');
const express = require('express');
const { ExpressPeerServer } = require('peer');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 9000;
const BOT_FILL_MS = +(process.env.BOT_FILL_MS || 15000);
const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

const stats = { day: '', matches: 0, botFills: 0, peakOnline: 0, iceIssued: 0 };
function statDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (stats.day !== d) { stats.day = d; stats.matches = 0; stats.botFills = 0; stats.peakOnline = 0; stats.iceIssued = 0; }
}

app.get('/', (req, res) => res.json({ ok: true, name: 'darmaduman-net', v: 2, uptime: Math.round(process.uptime()) }));

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
  return 'stun';
}
async function fetchIce(mode) {
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
function clientIp(req) { // Render önünde Cloudflare var: bu başlıkları istemci taklit edemez
  return req.get('cf-connecting-ip') || req.get('true-client-ip') || req.ip || '?';
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
//   istemci → {t:'find', pv, size:2|3|4, mode, modes:[...]|null, tz, bot:1}   kuyruğa gir
//   istemci → {t:'cancel'}
//   sunucu  → {t:'queued', size, waiting}
//   sunucu  → {t:'match', role:'host'|'guest', code, size, mode, delay}
//   sunucu  → {t:'bot'}   BOT_FILL_MS dolup rakip bulunamadı (yalnız bot:1 diyenlere)
// Eşleşme kuralları:
//   - aynı ağ protokol sürümü (pv) ve aynı kişi sayısı
//   - mod listeleri kesişmeli; maçın modu kesişimden seçilir ve herkese gönderilir
//   - önce yakın saat dilimi (bölge), bekledikçe aralık genişler: 0-4 sn ±2 sa, 4-8 sn ±5 sa, sonra herkes
//   - host = sunucuya en düşük gecikmeli oyuncu (ws ping ile ölçülür)
const MM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // oyunla aynı alfabe
const ALL_MODES = ['classic', 'train', 'climb'];
const MODE_W = { classic: 0.6, train: 0.2, climb: 0.2 };
let queue = []; // {ws, pv, size, modes:Set, tz, bot, t0}

function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += MM_ALPHABET[Math.floor(Math.random() * MM_ALPHABET.length)];
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
    const host = group.slice().sort((x, y) => (x.ws._rtt ?? 999) - (y.ws._rtt ?? 999))[0];
    for (const e of group) {
      const isHost = e === host;
      send(e.ws, { t: 'match', role: isHost ? 'host' : 'guest', code, size: a.size, mode, delay: isHost ? 0 : 900 });
    }
    statDay(); stats.matches++;
    console.log(`[mm] eşleşme: ${a.size} kişi, ${mode}, tz ${group.map(e => e.tz).join('/')}, rtt ${group.map(e => e.ws._rtt ?? '?').join('/')} → ODA ${code}`);
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
setInterval(tryMatch, 1000); // bekleme süresiyle genişleyen kurallar için düzenli tarama

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
// PeerJS kendi 'upgrade' dinleyicisini takıp bilmediği yolları 400 ile reddediyor.
// Çözüm: mevcut dinleyicileri devral, /mm bize, gerisi PeerJS'e.
const peerUpgradeListeners = server.listeners('upgrade').slice();
server.removeAllListeners('upgrade');
server.on('upgrade', (req, socket, head) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/mm') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  else for (const fn of peerUpgradeListeners) fn.call(server, req, socket, head);
});

function measureRtt(ws) {
  ws._pingT = Date.now();
  try { ws.ping(); } catch (e) {}
}
wss.on('connection', ws => {
  ws._rooms = new Set();
  ws.on('pong', () => {
    const r = Date.now() - ws._pingT;
    ws._rtt = ws._rtt == null ? r : Math.round(ws._rtt * 0.5 + r * 0.5);
  });
  measureRtt(ws);
  ws._rttT = setInterval(() => measureRtt(ws), 3000);
  statDay(); stats.peakOnline = Math.max(stats.peakOnline, wss.clients.size);

  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (typeof d.code === 'string') d.code = d.code.toUpperCase().slice(0, 8); // canlı v1 ile aynı: kod büyük harf
    if (d.t === 'find') {
      dropFromQueue(ws);
      queue.push({
        ws,
        pv: d.pv | 0,
        size: [2, 3, 4].includes(+d.size) ? +d.size : 2,
        modes: parseModes(d),
        tz: Number.isFinite(+d.tz) ? Math.max(-12, Math.min(14, +d.tz)) : 0,
        bot: !!d.bot,
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
      roomAdd(ws, d.code);
    } else if (d.t === 'host-migrate' && typeof d.code === 'string' && d.code.length <= 8) {
      roomAdd(ws, d.code);
      for (const m of rooms.get(d.code)) if (m !== ws) send(m, { t: 'host-migrated', code: d.code });
    }
  });
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

app.get('/stats', (req, res) => {
  statDay();
  res.set('Cache-Control', 'no-store');
  res.json({
    online: wss.clients.size, queue: queue.length, rooms: rooms.size,
    today: stats.day, matches: stats.matches, botFills: stats.botFills, peakOnline: stats.peakOnline,
    ice: turnMode(), iceIssued: stats.iceIssued, iceDayCap: ICE_DAY_CAP, turn30dGB: guard.gb, turnCapGB: TURN_MONTH_CAP_GB, turnBlocked: guard.blocked, guardErr: guard.err, uptime: Math.round(process.uptime())
  });
});

// ---- 5) Uyanık kalma (Render ücretsiz plan) --------------------------------
// Render, 15 dk dışarıdan istek gelmeyen ücretsiz servisi uyutur. KEEP_AWAKE=1 ise sunucu kendi
// genel adresine 10 dk'da bir istek atar. Ücretsiz plan ayda 750 saat verir (tek servis 7/24 = ~744 saat).
if (process.env.KEEP_AWAKE === '1' && process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + '/?keep=1').catch(() => {}); }, 10 * 60 * 1000);
}

server.listen(PORT, '0.0.0.0', () => console.log(`darmaduman-net v2 hazır → :${PORT} (/peerjs, /mm, /ice, /stats)`));
