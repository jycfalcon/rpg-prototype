const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss  = new WebSocket.Server({ port: PORT });

let nextId  = 1;
const players = new Map(); // id → { ws, state }

wss.on('connection', ws => {
  const id = String(nextId++);
  players.set(id, { ws, state: null });
  console.log(`[+] Player ${id} joined  — total: ${players.size}`);

  // Welcome: send this player their ID + snapshot of everyone already here
  const existing = [];
  for (const [pid, p] of players) {
    if (pid !== id && p.state) existing.push(p.state);
  }
  send(ws, { type: 'welcome', id, others: existing });

  // Notify everyone else
  broadcast({ type: 'join', id }, id);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'state') {
        const state = { ...msg, id };
        players.get(id).state = state;
        broadcast({ type: 'state', player: state }, id);
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    players.delete(id);
    console.log(`[-] Player ${id} left   — total: ${players.size}`);
    broadcast({ type: 'leave', id });
  });

  ws.on('error', () => {});
});

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  }
}

console.log(`WS server listening on port ${PORT}`);
