import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3200 + Math.floor(Math.random() * 300);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    })
  ]);
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 4000
    });

    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, event, payload, timeout = 4000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      if (error) reject(new Error(`${event} ack timed out`));
      else resolve(response);
    });
  });
}

function once(socket, event, timeout = 5000) {
  return withTimeout(
    new Promise((resolve) => socket.once(event, resolve)),
    timeout,
    event
  );
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // Server has not bound the port yet.
    }
    await delay(100);
  }
  throw new Error('Server did not start in time');
}

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

let host;
let guest;
let late;

try {
  await waitForServer();

  host = await connectClient();
  guest = await connectClient();

  const created = await emitAck(host, 'room:create', { name: 'Host' });
  assert.equal(created.ok, true);
  assert.match(created.code, /^\d{4}$/);

  const joined = await emitAck(guest, 'room:join', {
    code: created.code,
    name: 'Guest'
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.code, created.code);
  assert.notEqual(joined.youSlot, created.youSlot);

  const hostLive = once(host, 'game:live');
  const guestLive = once(guest, 'game:live');

  const start = await emitAck(host, 'room:start', {});
  assert.equal(start.ok, true);

  await Promise.all([hostLive, guestLive]);

  const snapshots = [];
  host.on('game:snapshot', (snapshot) => snapshots.push(snapshot));

  for (let seq = 1; seq <= 24; seq += 1) {
    host.emit('game:input', {
      seq,
      throttle: 1,
      steer: 0,
      handbrake: false
    });
    await delay(16);
  }

  for (let seq = 25; seq <= 42; seq += 1) {
    host.emit('game:input', {
      seq,
      throttle: 1,
      steer: 1,
      handbrake: false
    });
    await delay(16);
  }

  await delay(250);

  const latest = snapshots.at(-1);
  assert.ok(latest, 'Expected at least one snapshot');
  assert.ok(Array.isArray(latest.p) && latest.p.length === 2);

  const selfRow = latest.p.find((row) => row[0] === created.youSlot);
  assert.ok(selfRow, 'Expected the local car in the snapshot');

  const [, x, z, rotation, , , ack] = selfRow;
  assert.ok(ack >= 30, `Expected server to process inputs, got ack ${ack}`);
  assert.ok(z < 41, `Expected forward movement, got z=${z}`);
  assert.ok(Math.abs(rotation - Math.PI) > 0.01, 'Expected steering to change rotation');

  late = await connectClient();
  const lateJoin = await emitAck(late, 'room:join', {
    code: created.code,
    name: 'Late'
  });
  assert.equal(lateJoin.ok, false);

  console.log('Smoke test passed: room code, lobby join, race start, input ack, snapshot sync.');
  console.log(`Room ${created.code}: ${x.toFixed(2)}, ${z.toFixed(2)} at ack ${ack}.`);
} catch (error) {
  console.error(error);
  if (serverOutput.trim()) {
    console.error('\nServer output:\n' + serverOutput.trim());
  }
  process.exitCode = 1;
} finally {
  host?.disconnect();
  guest?.disconnect();
  late?.disconnect();
  server.kill();
}
