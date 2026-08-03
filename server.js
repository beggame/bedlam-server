// ============================================================================
// DARMADUMAN / BEDLAM — Sinyalleşme + Maç Ara Sunucusu (yol haritası adım 2+3)
// Tek Node.js süreci, tek port:
//   /peerjs → PeerJS protokollü WebRTC sinyalleşme (PeerJS bulutunun yerine geçer)
//   /mm     → "Maç Ara" eşleştirme kuyruğu (WebSocket)
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

// ---- 2) Maç Ara eşleştirme kuyruğu ----------------------------------------
// Protokol (JSON):
//   istemci → {t:'find', size:2|3|4}   kuyruğa gir
//   istemci → {t:'cancel'}             kuyruktan çık
//   sunucu  → {t:'queued', size, waiting}          durum (kuyruğa girince + biri girip çıktıkça)
//   sunucu  → {t:'match', role:'host'|'guest', code, size, delay}
//              host odayı 'kadim-arena-<code>' peer kimliğiyle kurar; misafirler
//              delay ms bekleyip aynı koda katılır (hostun odayı açması için pay).
const MM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // oyunla aynı alfabe
const queues = { 2: [], 3: [], 4: [] };

function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += MM_ALPHABET[Math.floor(Math.random() * MM_ALPHABET.length)];
  return c;
}
function dropFromQueues(ws) {
  for (const k of Object.keys(queues)) {
    const i = queues[k].indexOf(ws);
    if (i >= 0) queues[k].splice(i, 1);
  }
}
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcastWaiting(size) {
  for (const w of queues[size]) send(w, { t: 'queued', size, waiting: queues[size].length });
}
function tryMatch(size) {
  const q = queues[size];
  while (q.length >= size) {
    const group = q.splice(0, size);
    const code = makeCode();
    group.forEach((ws, i) => {
      send(ws, { t: 'match', role: i === 0 ? 'host' : 'guest', code, size, delay: i === 0 ? 0 : 900 });
      ws._mmMatched = true;
    });
    console.log(`[mm] eşleşme: ${size} kişi → ODA ${code}`);
  }
  broadcastWaiting(size);
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
      queues[size].push(ws);
      send(ws, { t: 'queued', size, waiting: queues[size].length });
      tryMatch(size);
    } else if (d.t === 'cancel') {
      const wasIn = Object.values(queues).some(q => q.includes(ws));
      dropFromQueues(ws);
      if (wasIn) for (const s of [2, 3, 4]) broadcastWaiting(s);
      send(ws, { t: 'cancelled' });
    } else if (d.t === 'ping') {
      send(ws, { t: 'pong' });
    }
  });
  ws.on('close', () => { dropFromQueues(ws); for (const s of [2, 3, 4]) broadcastWaiting(s); });
  ws.on('error', () => dropFromQueues(ws));
});

server.listen(PORT, '0.0.0.0', () => console.log(`darmaduman-net hazır → :${PORT} (sinyalleşme: /peerjs, maç ara: /mm)`));
