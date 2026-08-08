// ============================================================================
// DARMADUMAN / BEDLAM — Sinyalleşme + Maç Ara Sunucusu (yol haritası adım 2+3+4)
// Tek Node.js süreci, tek port:
//   /peerjs → PeerJS protokollü WebRTC sinyalleşme (PeerJS bulutunun yerine geçer)
//   /mm     → "Maç Ara" eşleştirme kuyruğu + oda varlığı/host göçü röle kanalı (WebSocket)
//   /       → sağlık kontrolü (deploy platformları için)
// Maç içi trafik sunucudan GEÇMEZ — oyuncular WebRTC ile birbirine doğrudan bağlanır.
// ============================================================================
const http = require('http');
const express = require('express');
const { ExpressPeerServer } = require('peer');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 9000;
const app = express();
app.get('/', (req, res) => res.json({ ok: true, name: 'darmaduman-net', uptime: Math.round(process.uptime()) }));

const server = http.createServer(app);

// ---- 1) PeerJS sinyalleşme ------------------------------------------------
const peerServer = ExpressPeerServer(server, { path: '/', allow_discovery: false });
app.use('/peerjs', peerServer);

// ---- 2) Maç Ara eşleştirme kuyruğu (artık MOD FARKINDA) --------------------
// Protokol (JSON):
//   istemci → {t:'find', size:2|3|4, mode:'classic'|'climb'|'train'|null, modes:[...]|null}
//              mode/modes belirtilmezse ya da null ise "tüm modlarda ara" kabul edilir.
//              modes verilmişse mode yerine öncelikli okunur (birden fazla mod seçimi).
//   istemci → {t:'cancel'}             kuyruktan çık
//   sunucu  → {t:'queued', size, waiting}          durum (kuyruğa girince + biri girip çıktıkça)
//   sunucu  → {t:'match', role:'host'|'guest', code, size, delay, mode}
//              host odayı 'kadim-arena-<code>' peer kimliğiyle kurar; misafirler
//              delay ms bekleyip aynı koda katılır (hostun odayı açması için pay).
//              mode: eşleşen tarafların ORTAK modlarından seçilen, gerçekte oynanacak mod.
const MM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // oyunla aynı alfabe
const MODES = ['classic', 'climb', 'train'];
const queues = { 2: [], 3: [], 4: [] }; // her eleman: {ws, modes:Set<string>}

function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += MM_ALPHABET[Math.floor(Math.random() * MM_ALPHABET.length)];
  return c;
}
function modesOf(d) {
  if (Array.isArray(d.modes) && d.modes.length) {
    const s = new Set(d.modes.filter(m => MODES.includes(m)));
    return s.size ? s : new Set(MODES);
  }
  if (typeof d.mode === 'string' && MODES.includes(d.mode)) return new Set([d.mode]);
  return new Set(MODES); // mode/modes belirtilmediyse ya da null ise: tüm modlar kabul (eski istemcilerle de uyumlu)
}
function dropFromQueues(ws) {
  for (const k of Object.keys(queues)) {
    const i = queues[k].findIndex(e => e.ws === ws);
    if (i >= 0) queues[k].splice(i, 1);
  }
}
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcastWaiting(size) {
  for (const e of queues[size]) send(e.ws, { t: 'queued', size, waiting: queues[size].length });
}
function tryMatch(size) {
  const q = queues[size];
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < q.length; i++) {
      // i'den başlayarak modu kesişen (size-1) tane daha eşleşecek eleman ara
      const group = [q[i]];
      let commonModes = new Set(q[i].modes);
      for (let j = i + 1; j < q.length && group.length < size; j++) {
        const cand = q[j];
        const inter = new Set([...commonModes].filter(m => cand.modes.has(m)));
        if (inter.size > 0) { group.push(cand); commonModes = inter; }
      }
      if (group.length === size) {
        for (const g of group) { const idx = q.indexOf(g); if (idx >= 0) q.splice(idx, 1); }
        const code = makeCode();
        const commonArr = [...commonModes];
        const chosenMode = commonArr[Math.floor(Math.random() * commonArr.length)];
        group.forEach((e, k) => {
          send(e.ws, { t: 'match', role: k === 0 ? 'host' : 'guest', code, size, delay: k === 0 ? 0 : 900, mode: chosenMode });
          e.ws._mmMatched = true;
        });
        console.log(`[mm] eşleşme: ${size} kişi → ODA ${code} (mod: ${chosenMode})`);
        progress = true;
        break; // kuyruk değişti, baştan tara
      }
    }
  }
  broadcastWaiting(size);
}

// ---- 3) Oda varlığı / host göçü röle kanalı --------------------------------
// Maç içi oyun trafiği sunucudan geçmez, ama host koparsa hayatta kalan misafirlerin
// birbirini/yeni hostu bulabilmesi için hafif bir "kim hangi oda kodunda" kaydı tutulur.
// Bu, WebRTC bağlantısından TAMAMEN ayrı, sadece küçük bir duyuru kanalıdır.
// Protokol (JSON):
//   istemci → {t:'room-join', code}     bu bağlantıyı <code> odasına kaydet (host da, misafir de katılırken gönderir)
//   istemci → {t:'host-migrate', code}  "ben bu kodun yeni hostuyum, PeerJS kimliğimi yeniden kadim-arena-<code> ile açtım"
//   sunucu  → {t:'host-migrated', code} odadaki DİĞER herkese relay edilir → onlar aynı koda yeniden bağlanmayı dener
const rooms = new Map(); // code -> Set<ws>
function roomJoin(ws, code) {
  if (!code) return;
  roomLeave(ws);
  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws);
  ws._roomCode = code;
}
function roomLeave(ws) {
  const code = ws._roomCode;
  if (code && rooms.has(code)) {
    rooms.get(code).delete(ws);
    if (rooms.get(code).size === 0) rooms.delete(code);
  }
  ws._roomCode = null;
}

const wss = new WebSocketServer({ noServer: true });
// PeerJS kendi 'upgrade' dinleyicisini takıp bilmediği yolları 400 ile reddediyor.
// Çözüm: mevcut dinleyicileri devral, /mm bize, gerisi PeerJS'e.
const peerUpgradeListeners = server.listeners('upgrade').slice();
server.removeAllListeners('upgrade');
server.on('upgrade', (req, socket, head) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/mm') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  else for (const fn of peerUpgradeListeners) fn.call(server, req, socket, head);
});

wss.on('connection', ws => {
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (d.t === 'find') {
      const size = [2, 3, 4].includes(+d.size) ? +d.size : 2;
      dropFromQueues(ws);
      queues[size].push({ ws, modes: modesOf(d) });
      send(ws, { t: 'queued', size, waiting: queues[size].length });
      tryMatch(size);
    } else if (d.t === 'cancel') {
      const wasIn = Object.values(queues).some(q => q.some(e => e.ws === ws));
      dropFromQueues(ws);
      if (wasIn) for (const s of [2, 3, 4]) broadcastWaiting(s);
      send(ws, { t: 'cancelled' });
    } else if (d.t === 'room-join') {
      const code = (d.code || '').toString().toUpperCase().slice(0, 8);
      roomJoin(ws, code);
    } else if (d.t === 'host-migrate') {
      const code = ws._roomCode;
      if (code && rooms.has(code)) {
        for (const other of rooms.get(code)) { if (other !== ws) send(other, { t: 'host-migrated', code }); }
        console.log(`[room] host göçü duyurusu → ODA ${code}`);
      }
    } else if (d.t === 'ping') {
      send(ws, { t: 'pong' });
    }
  });
  ws.on('close', () => { dropFromQueues(ws); for (const s of [2, 3, 4]) broadcastWaiting(s); roomLeave(ws); });
  ws.on('error', () => { dropFromQueues(ws); roomLeave(ws); });
});

server.listen(PORT, '0.0.0.0', () => console.log(`darmaduman-net hazır → :${PORT} (sinyalleşme: /peerjs, maç ara: /mm)`));
