// relay：本地 WebSocket 消息转发服务。按 channel 名在同组连接间转发，不解释消息内容。

import { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const PORT = 3055;
const DEFAULT_CHANNEL = 'default';

// channel -> Set<WebSocket>
const groups = new Map();

function getGroup(channel) {
  let set = groups.get(channel);
  if (!set) {
    set = new Set();
    groups.set(channel, set);
  }
  return set;
}

function join(socket, channel) {
  if (socket.channel === channel) return;
  leave(socket);
  getGroup(channel).add(socket);
  socket.channel = channel;
}

function leave(socket) {
  const channel = socket.channel;
  if (!channel) return;
  const set = groups.get(channel);
  if (set) {
    set.delete(socket);
    if (set.size === 0) groups.delete(channel);
  }
  socket.channel = null;
}

function peers(socket) {
  const set = groups.get(socket.channel);
  if (!set) return [];
  return [...set].filter((peer) => peer !== socket);
}

function count(channel) {
  const set = groups.get(channel);
  return set ? set.size : 0;
}

function now() {
  return new Date().toISOString();
}

function readChannel(url) {
  try {
    const parsed = new URL(url, `ws://${HOST}:${PORT}`);
    const value = parsed.searchParams.get('channel');
    return value && value.trim() ? value.trim() : DEFAULT_CHANNEL;
  } catch {
    return DEFAULT_CHANNEL;
  }
}

const server = new WebSocketServer({ host: HOST, port: PORT });

server.on('listening', () => {
  console.log(`[relay] listening ws://${HOST}:${PORT} ${now()}`);
});

server.on('connection', (socket, request) => {
  socket.channel = null;
  join(socket, readChannel(request.url));
  console.log(`[relay] connect channel=${socket.channel} id=${socket.figrigId ?? 'unset'} size=${count(socket.channel)}`);

  socket.on('message', (data) => {
    const text = data.toString();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (parsed && parsed.type === 'figrig-id') {
      socket.figrigId = String(parsed.id ?? 'unset');
      console.log(`[relay] identify channel=${socket.channel} id=${socket.figrigId}`);
      return;
    }

    if (parsed && parsed.type === 'figrig-join') {
      const target = String(parsed.channel ?? '').trim() || DEFAULT_CHANNEL;
      const before = socket.channel;
      join(socket, target);
      console.log(`[relay] move id=${socket.figrigId ?? 'unset'} ${before} -> ${socket.channel} size=${count(socket.channel)}`);
      return;
    }

    const targets = peers(socket);
    for (const peer of targets) {
      if (peer.readyState === peer.OPEN) peer.send(text);
    }
    console.log(`[relay] forward channel=${socket.channel} from=${socket.figrigId ?? 'unset'} peers=${targets.length} bytes=${Buffer.byteLength(text)}`);
  });

  socket.on('close', () => {
    const channel = socket.channel;
    leave(socket);
    console.log(`[relay] disconnect channel=${channel} id=${socket.figrigId ?? 'unset'} size=${count(channel)}`);
  });

  socket.on('error', (error) => {
    console.log(`[relay] error channel=${socket.channel} message=${error.message}`);
  });
});

server.on('error', (error) => {
  console.error(`[relay] server error ${error.message}`);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  console.log('[relay] stop');
  server.close(() => process.exit(0));
});
