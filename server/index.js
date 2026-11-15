import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { NET } from '../shared/constants.js';
import { Room } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 3100;

const app = express();
app.disable('x-powered-by');

/** Rooms in memory. Use Redis + Socket.io adapter when you scale past one node. */
const rooms = new Map();

app.get('/health', (_req, res) => {
  let players = 0;
  for (const room of rooms.values()) players += room.players.size;
  res.json({
    ok: true,
    rooms: rooms.size,
    players,
    uptimeSeconds: Math.round(process.uptime())
  });
});

const staticMaxAge = process.env.NODE_ENV === 'production' ? '1h' : 0;

app.use(
  '/shared',
  express.static(path.join(ROOT, 'shared'), { maxAge: staticMaxAge })
);
app.use(
  express.static(path.join(ROOT, 'public'), { maxAge: staticMaxAge })
);

const httpServer = createServer(app);

const ioOptions = {
  perMessageDeflate: false, // tiny game packets compress poorly and cost CPU
  pingInterval: 10_000,
  pingTimeout: 5_000,
  maxHttpBufferSize: 64 * 1024
};

if (process.env.CORS_ORIGIN) {
  ioOptions.cors = {
    origin: process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
  };
}

const io = new Server(httpServer, ioOptions);

function sendAck(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NET.MAX_NAME_LENGTH);
}

function createRoomCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(randomInt(1000, 10000));
    if (!rooms.has(code)) return code;
  }

  // Extremely unlikely, but deterministic fallback if the RNG keeps colliding.
  for (let code = 1000; code <= 9999; code += 1) {
    const candidate = String(code);
    if (!rooms.has(candidate)) return candidate;
  }

  return null;
}

function currentRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) ?? null : null;
}

function broadcastLobby(room) {
  io.to(room.channel).emit('room:lobby', room.toLobby());
}

function detachSocket(socket) {
  const room = currentRoom(socket);
  if (!room) {
    socket.data.roomCode = null;
    return;
  }

  socket.leave(room.channel);
  socket.data.roomCode = null;

  const player = room.removePlayer(socket.id);
  if (player) {
    io.to(room.channel).emit('game:player-left', { slot: player.slot });
  }

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  broadcastLobby(room);
}

function lobbyActionAllowed(socket) {
  const now = Date.now();
  if (now - (socket.data.lastLobbyActionAt ?? 0) < 500) return false;
  socket.data.lastLobbyActionAt = now;
  return true;
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.lastLobbyActionAt = 0;
  socket.data.inputWindowStartedAt = 0;
  socket.data.inputCount = 0;

  socket.on('latency:ping', (sentAt, ack) => {
    if (typeof ack === 'function') ack(sentAt);
  });

  socket.on('room:create', (payload, ack) => {
    if (currentRoom(socket)) {
      sendAck(ack, { ok: false, error: 'You are already in a room.' });
      return;
    }

    if (!lobbyActionAllowed(socket)) {
      sendAck(ack, { ok: false, error: 'Please wait a moment and try again.' });
      return;
    }

    const code = createRoomCode();
    if (!code) {
      sendAck(ack, { ok: false, error: 'No room codes are available right now.' });
      return;
    }

    const name = cleanName(payload?.name) || `Racer ${randomInt(10, 100)}`;
    const room = new Room(code, socket.id);
    const player = room.addPlayer(socket.id, name);

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(room.channel);

    sendAck(ack, {
      ok: true,
      code,
      selfId: socket.id,
      youSlot: player.slot,
      lobby: room.toLobby()
    });
    broadcastLobby(room);
  });

  socket.on('room:join', (payload, ack) => {
    if (currentRoom(socket)) {
      sendAck(ack, { ok: false, error: 'You are already in a room.' });
      return;
    }

    if (!lobbyActionAllowed(socket)) {
      sendAck(ack, { ok: false, error: 'Please wait a moment and try again.' });
      return;
    }

    const code = String(payload?.code ?? '').trim();
    if (!/^\d{4}$/.test(code)) {
      sendAck(ack, { ok: false, error: 'Enter a valid 4-digit game code.' });
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      sendAck(ack, { ok: false, error: 'That room does not exist.' });
      return;
    }

    if (room.phase !== 'lobby') {
      sendAck(ack, { ok: false, error: 'That race has already started.' });
      return;
    }

    if (room.isFull) {
      sendAck(ack, { ok: false, error: 'That room is full.' });
      return;
    }

    const name = cleanName(payload?.name) || `Racer ${randomInt(10, 100)}`;
    const player = room.addPlayer(socket.id, name);

    socket.data.roomCode = code;
    socket.join(room.channel);

    sendAck(ack, {
      ok: true,
      code,
      selfId: socket.id,
      youSlot: player.slot,
      lobby: room.toLobby()
    });
    broadcastLobby(room);
  });

  socket.on('room:leave', (_payload, ack) => {
    detachSocket(socket);
    sendAck(ack, { ok: true });
  });

  socket.on('room:start', (_payload, ack) => {
    const room = currentRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: 'You are not in a room.' });
      return;
    }

    const error = room.canStart(socket.id);
    if (error) {
      sendAck(ack, { ok: false, error });
      return;
    }

    room.beginCountdown(io);
    sendAck(ack, { ok: true });
  });

  socket.on('game:input', (raw) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== 'racing') return;

    const player = room.getPlayer(socket.id);
    if (!player) return;

    const now = Date.now();

    // Token bucket at slightly above the intended 60 Hz input rate.
    if (now - socket.data.inputWindowStartedAt >= 1000) {
      socket.data.inputWindowStartedAt = now;
      socket.data.inputCount = 0;
    }
    socket.data.inputCount += 1;
    if (socket.data.inputCount > NET.INPUTS_PER_SECOND) return;

    if (!raw || typeof raw !== 'object') return;

    const seq = raw.seq;
    if (
      !Number.isInteger(seq) ||
      seq <= player.lastInputSeq ||
      seq > player.lastInputSeq + 1000
    ) {
      return;
    }

    // Never trust client values. The server owns position, velocity and state.
    const throttle = Math.max(-1, Math.min(1, Number(raw.throttle) || 0));
    const steer = Math.max(-1, Math.min(1, Number(raw.steer) || 0));

    player.latestInput = {
      seq,
      throttle,
      steer,
      handbrake: raw.handbrake === true
    };
    player.lastInputSeq = seq;
    player.lastInputAt = now;
    player.inputStale = false;
  });

  socket.on('disconnect', () => {
    detachSocket(socket);
  });
});

// Fixed timestep loop. The deadline is advanced by exactly one tick, so timer
// jitter does not accumulate into simulation drift. Catch-up is capped to avoid
// a death spiral after a process stall.
const TICK_MS = 1000 / NET.SIM_HZ;
let nextTickAt = performance.now();
let loopTimer = null;
let shuttingDown = false;

function gameLoop() {
  if (shuttingDown) return;

  let steps = 0;
  while (performance.now() >= nextTickAt && steps < 5) {
    const wallNow = Date.now();
    for (const room of rooms.values()) {
      room.update(io, wallNow);
    }
    nextTickAt += TICK_MS;
    steps += 1;
  }

  if (performance.now() - nextTickAt > 250) {
    nextTickAt = performance.now() + TICK_MS;
  }

  loopTimer = setTimeout(gameLoop, Math.max(0, nextTickAt - performance.now()));
}

const configuredPort = Number(process.env.PORT) || DEFAULT_PORT;
let serverStarted = false;

function startListening(port, attempts = 0) {
  const onListening = () => {
    httpServer.off('listening', onListening);
    httpServer.off('error', onError);

    // A retried listen can leave a stale callback behind; only start once.
    if (serverStarted) return;
    serverStarted = true;

    const address = httpServer.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    console.log(`Apex Rift is ready at http://localhost:${activePort}`);
    console.log('Open that URL in two browser tabs to play with a friend.');
    nextTickAt = performance.now() + TICK_MS;
    gameLoop();
  };

  const onError = (error) => {
    httpServer.off('listening', onListening);
    httpServer.off('error', onError);

    if (error.code === 'EADDRINUSE' && attempts < 10) {
      const nextPort = port + 1;
      console.warn(
        `Port ${port} is already in use. Trying http://localhost:${nextPort} instead...`
      );
      setImmediate(() => startListening(nextPort, attempts + 1));
      return;
    }

    console.error(`Could not start Apex Rift: ${error.message}`);
    process.exit(1);
  };

  httpServer.once('listening', onListening);
  httpServer.once('error', onError);
  httpServer.listen(port);
}

startListening(configuredPort);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(loopTimer);
  console.log(`\n${signal} received, shutting down.`);

  io.close();
  httpServer.close(() => process.exit(0));

  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
