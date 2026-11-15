import { ARENA, CAR, NET } from '/shared/constants.js';
import { angleDelta, clamp, copyCar, createCar, stepCar } from '/shared/simulation.js';

const TICK_SECONDS = 1 / NET.SIM_HZ;
const TAU = Math.PI * 2;
const STORAGE_KEY = 'apex-rift-callsign';
const CALLSIGNS = ['Nova', 'Vega', 'Rook', 'Kite', 'Echo', 'Juno', 'Hex', 'Zephyr'];

const dom = {
  canvas: document.getElementById('arena'),
  screen: document.getElementById('screen'),
  menuPanel: document.getElementById('menu-panel'),
  lobbyPanel: document.getElementById('lobby-panel'),
  playerName: document.getElementById('player-name'),
  createRoom: document.getElementById('create-room'),
  joinForm: document.getElementById('join-form'),
  gameCode: document.getElementById('game-code'),
  joinSubmit: document.querySelector('#join-form button[type="submit"]'),
  connection: document.getElementById('connection'),
  connectionLabel: document.getElementById('connection-label'),
  lobbyCode: document.getElementById('lobby-code'),
  copyCode: document.getElementById('copy-code'),
  roster: document.getElementById('roster'),
  rosterCount: document.getElementById('roster-count'),
  lobbyNote: document.getElementById('lobby-note'),
  startRace: document.getElementById('start-race'),
  leaveLobby: document.getElementById('leave-lobby'),
  leaveGame: document.getElementById('leave-game'),
  hud: document.getElementById('hud'),
  hudCode: document.getElementById('hud-code'),
  hudSpeed: document.getElementById('hud-speed'),
  hudPing: document.getElementById('hud-ping'),
  hudRacers: document.getElementById('hud-racers'),
  announce: document.getElementById('announce'),
  toast: document.getElementById('toast')
};

const ctx = dom.canvas.getContext('2d');

const view = {
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: 1
};

const state = {
  phase: 'menu', // menu | lobby | countdown | racing
  code: null,
  selfId: null,
  selfSlot: null,
  hostId: null,
  maxPlayers: NET.MAX_PLAYERS,
  roster: new Map(),
  selfState: null,
  selfVisual: null,
  selfError: { x: 0, z: 0, rotation: 0 },
  snapshots: [],
  pendingInputs: [],
  inputSeq: 0,
  accumulator: 0,
  lastFrame: performance.now(),
  countdownEndsAt: 0,
  announceHideAt: 0,
  ping: null,
  keys: new Set(),
  camera: { x: 0, z: 0, zoom: 10, initialized: false },
  lastHudAt: 0
};

let toastTimer = 0;

// ---------------------------------------------------------------------------
// Socket.io connection
// ---------------------------------------------------------------------------

const socket = window.io({
  // WebSocket-only avoids the polling -> upgrade phase. Use polling as a
  // fallback if you deploy behind a proxy that cannot forward WebSockets.
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  timeout: 10_000
});

socket.on('connect', () => {
  setConnection('Connected', 'online');
});

socket.on('disconnect', () => {
  setConnection('Disconnected', 'offline');
  if (state.code || state.phase !== 'menu') {
    resetToMenu('Connection lost. Create or join a new room.');
  }
});

socket.on('connect_error', () => {
  setConnection('Server unreachable', 'offline');
});

socket.on('room:lobby', (lobby) => {
  if (!state.code || lobby.code !== state.code) return;

  if (state.phase === 'lobby') {
    applyLobby(lobby);
  } else if (state.phase !== 'menu') {
    state.hostId = lobby.hostId;
    state.maxPlayers = lobby.maxPlayers;
  }
});

socket.on('game:starting', handleGameStarting);
socket.on('game:live', handleGameLive);
socket.on('game:snapshot', handleSnapshot);
socket.on('game:player-left', handlePlayerLeft);

// App-level ping. Socket.io's built-in heartbeat is not a useful game RTT
// measurement, so measure a tiny acknowledged round trip instead.
window.setInterval(() => {
  if (!socket.connected) return;

  const sentAt = performance.now();
  socket.timeout(2000).emit('latency:ping', sentAt, (error, echoedAt) => {
    if (error) return;
    state.ping = Math.max(0, Math.round(performance.now() - echoedAt));
    dom.hudPing.textContent = String(state.ping);
  });
}, 2000);

// ---------------------------------------------------------------------------
// Menu and lobby UI
// ---------------------------------------------------------------------------

dom.playerName.value = loadSavedName();
dom.playerName.addEventListener('input', () => {
  dom.playerName.value = dom.playerName.value.replace(/[\u0000-\u001f\u007f]/g, '');
});

dom.gameCode.addEventListener('input', () => {
  dom.gameCode.value = dom.gameCode.value.replace(/\D/g, '').slice(0, 4);
});

dom.createRoom.addEventListener('click', createRoom);
dom.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  joinRoom();
});

dom.startRace.addEventListener('click', startRace);
dom.leaveLobby.addEventListener('click', leaveRoom);
dom.leaveGame.addEventListener('click', leaveRoom);
dom.copyCode.addEventListener('click', copyGameCode);

async function createRoom() {
  if (state.phase !== 'menu') return;
  if (!socket.connected) {
    showToast('Not connected to the server yet.');
    return;
  }

  const name = getPlayerName();
  if (!name) return;
  saveName(name);

  setBusy(dom.createRoom, true);
  const response = await request('room:create', { name });
  setBusy(dom.createRoom, false);

  if (!response?.ok) {
    showToast(response?.error || 'Could not create a room.');
    return;
  }

  enterLobby(response);
}

async function joinRoom() {
  if (state.phase !== 'menu') return;
  if (!socket.connected) {
    showToast('Not connected to the server yet.');
    return;
  }

  const code = dom.gameCode.value.replace(/\D/g, '');
  if (code.length !== 4) {
    showToast('Enter the 4-digit game code.');
    dom.gameCode.focus();
    return;
  }

  const name = getPlayerName();
  if (!name) return;
  saveName(name);

  setBusy(dom.joinSubmit, true);
  const response = await request('room:join', { code, name });
  setBusy(dom.joinSubmit, false);

  if (!response?.ok) {
    showToast(response?.error || 'Could not join that room.');
    return;
  }

  enterLobby(response);
}

async function startRace() {
  if (!state.code) return;

  setBusy(dom.startRace, true);
  const response = await request('room:start', {});
  setBusy(dom.startRace, false);

  if (!response?.ok) {
    showToast(response?.error || 'Could not start the race.');
  }
}

function leaveRoom() {
  if (socket.connected) {
    socket.emit('room:leave', {});
  }
  resetToMenu('Left the room.');
}

function enterLobby(response) {
  state.phase = 'lobby';
  state.code = response.code;
  state.selfId = response.selfId;
  state.selfSlot = response.youSlot;

  state.selfState = null;
  state.selfVisual = null;
  state.camera.initialized = false;
  state.pendingInputs = [];
  state.snapshots = [];
  state.inputSeq = 0;
  state.keys.clear();

  dom.menuPanel.classList.add('is-hidden');
  dom.lobbyPanel.classList.remove('is-hidden');
  dom.screen.classList.remove('is-hidden');
  dom.hud.classList.add('is-hidden');
  hideAnnouncement();

  if (response.lobby) applyLobby(response.lobby);
  dom.hudCode.textContent = response.code;
  dom.gameCode.value = '';
  dom.screen.scrollTop = 0;
}

function applyLobby(lobby) {
  if (!state.code || state.phase !== 'lobby') return;

  state.hostId = lobby.hostId;
  state.maxPlayers = lobby.maxPlayers;

  const players = [...lobby.players].sort((a, b) => a.slot - b.slot);
  state.roster = new Map(players.map((player) => [player.slot, player]));

  const isHost = lobby.hostId === state.selfId;
  dom.lobbyCode.textContent = lobby.code;
  dom.rosterCount.textContent = `${players.length} / ${lobby.maxPlayers}`;
  dom.startRace.classList.toggle('is-hidden', !isHost);
  dom.startRace.disabled = players.length === 0;
  dom.lobbyNote.textContent = isHost
    ? players.length > 1
      ? 'Everyone is in. Start when you are ready.'
      : 'Share the code — or start solo to test the handling.'
    : 'Waiting for the host to start the race…';

  const fragment = document.createDocumentFragment();

  players.forEach((player, index) => {
    const item = document.createElement('li');
    item.className = 'roster__item';
    item.style.animationDelay = `${Math.min(index * 35, 180)}ms`;

    const swatch = document.createElement('span');
    swatch.className = 'roster__swatch';
    swatch.style.setProperty('--player-color', player.color);

    const name = document.createElement('span');
    name.className = 'roster__name';
    name.textContent = player.name;

    const badge = document.createElement('span');
    const isSelf = player.id === state.selfId;
    const isRoomHost = player.id === lobby.hostId;

    if (isRoomHost) {
      badge.className = 'roster__badge';
      badge.textContent = isSelf ? 'Host · You' : 'Host';
    } else if (isSelf) {
      badge.className = 'roster__badge roster__badge--you';
      badge.textContent = 'You';
    }

    item.append(swatch, name);
    if (badge.textContent) item.append(badge);
    fragment.append(item);
  });

  dom.roster.replaceChildren(fragment);
}

async function copyGameCode() {
  if (!state.code) return;

  try {
    await navigator.clipboard.writeText(state.code);
    showToast(`Game code ${state.code} copied.`);
  } catch {
    showToast(`Game code: ${state.code}`);
  }
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

function getPlayerName() {
  const name = dom.playerName.value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NET.MAX_NAME_LENGTH);

  if (!name) {
    showToast('Choose a call sign first.');
    dom.playerName.focus();
    return null;
  }

  dom.playerName.value = name;
  return name;
}

function request(event, payload) {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve({ ok: false, error: 'Not connected to the server.' });
      return;
    }

    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) {
        resolve({ ok: false, error: 'The server did not respond. Try again.' });
      } else {
        resolve(response ?? { ok: false, error: 'Empty server response.' });
      }
    });
  });
}

function resetToMenu(message) {
  state.phase = 'menu';
  state.code = null;
  state.selfId = null;
  state.selfSlot = null;
  state.hostId = null;
  state.roster = new Map();
  state.selfState = null;
  state.selfVisual = null;
  state.selfError = { x: 0, z: 0, rotation: 0 };
  state.snapshots = [];
  state.pendingInputs = [];
  state.inputSeq = 0;
  state.accumulator = 0;
  state.countdownEndsAt = 0;
  state.announceHideAt = 0;
  state.keys.clear();
  state.camera.initialized = false;

  dom.screen.classList.remove('is-hidden');
  dom.menuPanel.classList.remove('is-hidden');
  dom.lobbyPanel.classList.add('is-hidden');
  dom.hud.classList.add('is-hidden');
  dom.roster.replaceChildren();
  dom.startRace.classList.add('is-hidden');
  dom.lobbyCode.textContent = '----';
  dom.hudCode.textContent = '----';
  dom.hudSpeed.textContent = '0';
  hideAnnouncement();
  dom.screen.scrollTop = 0;

  if (message) showToast(message);
}

function setConnection(label, mode) {
  dom.connection.dataset.state = mode;
  dom.connectionLabel.textContent = label;
}

// ---------------------------------------------------------------------------
// Authoritative game events
// ---------------------------------------------------------------------------

function handleGameStarting(data) {
  if (!state.code || !Array.isArray(data?.players)) return;

  state.phase = 'countdown';
  state.countdownEndsAt =
    performance.now() + (Number(data.countdownMs) || NET.COUNTDOWN_MS);
  state.snapshots = [];
  state.pendingInputs = [];
  state.inputSeq = 0;
  state.accumulator = 0;
  state.lastFrame = performance.now();
  state.announceHideAt = 0;
  state.keys.clear();

  const roster = new Map();
  for (const player of data.players) {
    const previous = state.roster.get(player.slot);
    roster.set(player.slot, { ...previous, ...player });
  }
  state.roster = roster;

  const self = roster.get(state.selfSlot);
  if (!self) {
    showToast('Your spawn was not found. Please rejoin.');
    return;
  }

  state.selfState = createCar(
    Number(self.x) || 0,
    Number(self.z) || 0,
    Number(self.rotation) || 0
  );
  state.selfVisual = copyCar(state.selfState);
  state.selfError = { x: 0, z: 0, rotation: 0 };

  state.camera.x = state.selfState.x;
  state.camera.z = state.selfState.z;
  state.camera.initialized = false;

  dom.screen.classList.add('is-hidden');
  dom.hud.classList.remove('is-hidden');
  dom.hudCode.textContent = state.code;
  dom.hudSpeed.textContent = '0';
  dom.hudRacers.textContent = `${roster.size} / ${NET.MAX_PLAYERS}`;
  showAnnouncement(String(Math.ceil((Number(data.countdownMs) || NET.COUNTDOWN_MS) / 1000)));
}

function handleGameLive() {
  if (state.phase !== 'countdown' && state.phase !== 'racing') return;

  state.phase = 'racing';
  state.countdownEndsAt = 0;
  state.accumulator = 0;
  state.lastFrame = performance.now();
  showAnnouncement('GO', 'announce--go', 700);
}

function handleSnapshot(snapshot) {
  if (!state.selfSlot || state.phase !== 'racing') return;
  if (!Array.isArray(snapshot?.p)) return;

  const parsed = {
    recv: performance.now(),
    tick: Number(snapshot.t) || 0,
    cars: new Map()
  };

  for (const row of snapshot.p) {
    if (!Array.isArray(row) || row.length < 7) continue;

    const [slot, x, z, rotation, vx, vz, ack] = row;
    if (
      !Number.isFinite(slot) ||
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(rotation)
    ) {
      continue;
    }

    parsed.cars.set(slot, {
      x,
      z,
      rotation,
      vx: Number(vx) || 0,
      vz: Number(vz) || 0,
      ack: Number(ack) || 0
    });
  }

  if (parsed.cars.size === 0) return;

  state.snapshots.push(parsed);
  if (state.snapshots.length > 40) state.snapshots.shift();

  const self = parsed.cars.get(state.selfSlot);
  if (self && state.selfState) reconcileSelf(self);

  dom.hudRacers.textContent = `${state.roster.size} / ${NET.MAX_PLAYERS}`;
}

function handlePlayerLeft(payload) {
  const slot = Number(payload?.slot);
  if (!Number.isInteger(slot)) return;

  if (state.phase === 'countdown' || state.phase === 'racing') {
    state.roster.delete(slot);
    for (const snapshot of state.snapshots) snapshot.cars.delete(slot);
    dom.hudRacers.textContent = `${state.roster.size} / ${NET.MAX_PLAYERS}`;

    if (slot === state.selfSlot) {
      resetToMenu('You left the room.');
    }
  }
}

function reconcileSelf(serverCar) {
  const previous = state.selfVisual
    ? {
        x: state.selfVisual.x,
        z: state.selfVisual.z,
        rotation: state.selfVisual.rotation
      }
    : null;

  // Inputs newer than the server's ack still need to be replayed on top of the
  // authoritative state. This is client-side prediction + reconciliation.
  state.pendingInputs = state.pendingInputs.filter((input) => input.seq > serverCar.ack);

  const predicted = {
    x: serverCar.x,
    z: serverCar.z,
    rotation: serverCar.rotation,
    vx: serverCar.vx,
    vz: serverCar.vz
  };

  for (const input of state.pendingInputs) {
    stepCar(predicted, input, TICK_SECONDS);
  }

  state.selfState = predicted;

  if (!previous) {
    state.selfVisual = copyCar(predicted);
    state.selfError = { x: 0, z: 0, rotation: 0 };
    return;
  }

  const dx = previous.x - predicted.x;
  const dz = previous.z - predicted.z;

  if (Math.hypot(dx, dz) > 10) {
    // A wall hit or a long stall: snapping is less jarring than a long slide.
    state.selfVisual = copyCar(predicted);
    state.selfError = { x: 0, z: 0, rotation: 0 };
    return;
  }

  // Render the correction over a few frames instead of popping.
  state.selfError.x = dx;
  state.selfError.z = dz;
  state.selfError.rotation = angleDelta(predicted.rotation, previous.rotation);
}

// ---------------------------------------------------------------------------
// Input and fixed-step prediction
// ---------------------------------------------------------------------------

function sampleControls() {
  const keys = state.keys;
  const forward = keys.has('KeyW') || keys.has('ArrowUp');
  const backward = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');

  return {
    throttle: (forward ? 1 : 0) - (backward ? 1 : 0),
    steer: (right ? 1 : 0) - (left ? 1 : 0),
    handbrake: keys.has('Space')
  };
}

function sendInputStep() {
  if (state.phase !== 'racing' || !state.selfState) return;

  const controls = sampleControls();
  submitInput(controls);
}

function submitInput(controls) {
  if (!state.selfState) return;

  const input = {
    seq: state.inputSeq + 1,
    throttle: controls.throttle,
    steer: controls.steer,
    handbrake: controls.handbrake
  };

  state.inputSeq = input.seq;
  state.pendingInputs.push(input);
  if (state.pendingInputs.length > 240) state.pendingInputs.shift();

  stepCar(state.selfState, input, TICK_SECONDS);

  if (socket.connected) {
    // Volatile means "drop this packet if the socket is backed up". For
    // per-tick controls, a stale queued input is worse than a dropped one.
    socket.volatile.emit('game:input', input);
  }
}

function sendNeutralNow() {
  if (state.phase !== 'racing' || !state.selfState) return;
  submitInput({ throttle: 0, steer: 0, handbrake: false });
}

function updateSelfVisual(dt) {
  if (!state.selfState || !state.selfVisual) return;

  const decay = Math.exp(-14 * dt);
  state.selfError.x *= decay;
  state.selfError.z *= decay;
  state.selfError.rotation *= decay;

  state.selfVisual.x = state.selfState.x + state.selfError.x;
  state.selfVisual.z = state.selfState.z + state.selfError.z;
  state.selfVisual.rotation = state.selfState.rotation + state.selfError.rotation;
  state.selfVisual.vx = state.selfState.vx;
  state.selfVisual.vz = state.selfState.vz;
}

function updateHud(now) {
  if (now - state.lastHudAt < 100) return;
  state.lastHudAt = now;

  const speed = state.selfState
    ? Math.round(Math.hypot(state.selfState.vx, state.selfState.vz) * 3.6)
    : 0;
  dom.hudSpeed.textContent = String(speed);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const DRIVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space'
]);

window.addEventListener('keydown', (event) => {
  if (state.phase !== 'racing' && state.phase !== 'countdown') return;
  if (!DRIVE_KEYS.has(event.code)) return;
  event.preventDefault();
  state.keys.add(event.code);
});

window.addEventListener('keyup', (event) => {
  if (!DRIVE_KEYS.has(event.code)) return;
  if (state.phase === 'racing' || state.phase === 'countdown') {
    event.preventDefault();
  }
  state.keys.delete(event.code);
});

window.addEventListener('blur', () => {
  state.keys.clear();
  state.accumulator = 0;
  sendNeutralNow();
});

document.addEventListener('visibilitychange', () => {
  state.keys.clear();
  state.accumulator = 0;
  state.lastFrame = performance.now();
  if (document.hidden) sendNeutralNow();
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function frame(now) {
  window.requestAnimationFrame(frame);

  const rawDt = Math.max(0, (now - state.lastFrame) / 1000);
  state.lastFrame = now;
  const dt = Math.min(rawDt, 0.1);

  updateAnnouncement(now);

  if (state.phase === 'racing') {
    if (rawDt > 0.25) state.accumulator = 0;

    state.accumulator += dt;
    let steps = 0;
    while (state.accumulator >= TICK_SECONDS && steps < 5) {
      sendInputStep();
      state.accumulator -= TICK_SECONDS;
      steps += 1;
    }
    if (steps === 5) state.accumulator = 0;

    updateSelfVisual(dt);
    updateHud(now);
  } else {
    state.accumulator = 0;
  }

  render(now, dt);
}

window.requestAnimationFrame(frame);

function resize() {
  view.width = window.innerWidth;
  view.height = window.innerHeight;
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  dom.canvas.width = Math.floor(view.width * view.dpr);
  dom.canvas.height = Math.floor(view.height * view.dpr);
}

window.addEventListener('resize', resize);
resize();

function updateCamera(dt) {
  const inGame = state.phase === 'countdown' || state.phase === 'racing';
  let targetX = 0;
  let targetZ = 0;
  let targetZoom;

  if (inGame && state.selfVisual) {
    targetX = state.selfVisual.x;
    targetZ = state.selfVisual.z;
    targetZoom = clamp(
      Math.min(view.width / 64, view.height / 42),
      8,
      34
    );
  } else {
    targetZoom = clamp(
      Math.min(
        view.width / (ARENA.width + 20),
        view.height / (ARENA.depth + 20)
      ),
      3,
      16
    );
  }

  const halfViewWidth = view.width / (2 * targetZoom);
  const halfViewDepth = view.height / (2 * targetZoom);
  const limitX = Math.max(0, ARENA.width / 2 - halfViewWidth + 4);
  const limitZ = Math.max(0, ARENA.depth / 2 - halfViewDepth + 4);

  targetX = clamp(targetX, -limitX, limitX);
  targetZ = clamp(targetZ, -limitZ, limitZ);

  if (!state.camera.initialized) {
    state.camera.x = targetX;
    state.camera.z = targetZ;
    state.camera.zoom = targetZoom;
    state.camera.initialized = true;
    return;
  }

  const followRate = inGame ? 12 : 4;
  const positionBlend = 1 - Math.exp(-followRate * dt);
  const zoomBlend = 1 - Math.exp(-7 * dt);

  state.camera.x += (targetX - state.camera.x) * positionBlend;
  state.camera.z += (targetZ - state.camera.z) * positionBlend;
  state.camera.zoom += (targetZoom - state.camera.zoom) * zoomBlend;
}

function collectCars(now) {
  const cars = [];
  if (state.phase !== 'countdown' && state.phase !== 'racing') return cars;

  for (const player of state.roster.values()) {
    if (player.slot === state.selfSlot) {
      if (!state.selfVisual) continue;
      cars.push({
        ...state.selfVisual,
        slot: player.slot,
        name: player.name,
        color: player.color,
        isSelf: true
      });
      continue;
    }

    const remote = sampleRemoteCar(player.slot, now);
    if (!remote) continue;

    cars.push({
      ...remote,
      slot: player.slot,
      name: player.name,
      color: player.color,
      isSelf: false
    });
  }

  return cars;
}

function sampleRemoteCar(slot, now) {
  const fallback = state.roster.get(slot);
  const snapshots = state.snapshots;

  if (snapshots.length === 0) {
    return fallback && Number.isFinite(fallback.x) ? { ...fallback } : null;
  }

  // Render slightly in the past so two snapshots are available to blend.
  const targetTime = now - NET.INTERP_DELAY_MS;
  let before = null;
  let after = null;

  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (snapshots[index].recv <= targetTime) {
      before = snapshots[index];
      after = snapshots[index + 1] ?? null;
      break;
    }
  }

  if (!before) {
    before = snapshots[0];
    after = snapshots[1] ?? null;
  }

  let a = before?.cars.get(slot) ?? null;
  let b = after?.cars.get(slot) ?? null;
  if (!a && !b) {
    return fallback && Number.isFinite(fallback.x) ? { ...fallback } : null;
  }

  if (!a) a = b;
  if (!b) return { ...a };

  const span = Math.max(1, after.recv - before.recv);
  const t = clamp((targetTime - before.recv) / span, 0, 1);

  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    rotation: a.rotation + angleDelta(a.rotation, b.rotation) * t,
    vx: a.vx + (b.vx - a.vx) * t,
    vz: a.vz + (b.vz - a.vz) * t
  };
}

function render(now, dt) {
  updateCamera(dt);

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);

  // Deep asphalt/sky backdrop.
  const background = ctx.createLinearGradient(0, 0, 0, view.height);
  background.addColorStop(0, '#080d15');
  background.addColorStop(0.55, '#060a11');
  background.addColorStop(1, '#04070c');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, view.width, view.height);

  const camera = state.camera;
  const cars = collectCars(now);

  ctx.save();
  ctx.translate(
    view.width / 2 - camera.x * camera.zoom,
    view.height / 2 - camera.z * camera.zoom
  );
  ctx.scale(camera.zoom, camera.zoom);

  drawArena(camera.zoom);
  for (const car of cars) drawCar(car);

  ctx.restore();

  drawLabels(cars, camera, view.width, view.height);

  // Subtle edge vignette keeps attention on the track.
  const vignette = ctx.createRadialGradient(
    view.width / 2,
    view.height / 2,
    Math.min(view.width, view.height) * 0.25,
    view.width / 2,
    view.height / 2,
    Math.max(view.width, view.height) * 0.72
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.36)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, view.width, view.height);
}

function drawArena(zoom) {
  const halfWidth = ARENA.width / 2;
  const halfDepth = ARENA.depth / 2;
  const onePixel = 1 / zoom;

  ctx.save();

  // Floor.
  const floor = ctx.createLinearGradient(0, -halfDepth, 0, halfDepth);
  floor.addColorStop(0, '#0b1320');
  floor.addColorStop(0.55, '#090f18');
  floor.addColorStop(1, '#0b111b');
  ctx.fillStyle = floor;
  ctx.fillRect(-halfWidth, -halfDepth, ARENA.width, ARENA.depth);

  // Track grid.
  ctx.beginPath();
  for (let x = -halfWidth + 10; x < halfWidth; x += 10) {
    ctx.moveTo(x, -halfDepth);
    ctx.lineTo(x, halfDepth);
  }
  for (let z = -halfDepth + 10; z < halfDepth; z += 10) {
    ctx.moveTo(-halfWidth, z);
    ctx.lineTo(halfWidth, z);
  }
  ctx.strokeStyle = 'rgba(122, 155, 197, 0.07)';
  ctx.lineWidth = onePixel;
  ctx.stroke();

  // Center mark.
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, TAU);
  ctx.setLineDash([2.5, 2.5]);
  ctx.strokeStyle = 'rgba(122, 155, 197, 0.12)';
  ctx.lineWidth = onePixel;
  ctx.stroke();
  ctx.setLineDash([]);

  // Start line.
  const cell = 4;
  const startZ = 24;
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < ARENA.width / cell; column += 1) {
      if ((row + column) % 2 !== 0) continue;
      ctx.fillStyle = 'rgba(226, 238, 255, 0.13)';
      ctx.fillRect(
        -halfWidth + column * cell,
        startZ + row * cell,
        cell,
        cell
      );
    }
  }

  // Spawn bay marks.
  for (let index = 0; index < NET.MAX_PLAYERS; index += 1) {
    const x = [-27, -9, 9, 27][index % 4];
    const z = index < 4 ? 42 : 32;
    ctx.strokeStyle = 'rgba(122, 155, 197, 0.16)';
    ctx.lineWidth = 1.5 * onePixel;
    ctx.strokeRect(x - 3.1, z - 3.7, 6.2, 7.4);
  }

  // Arena outline.
  ctx.strokeStyle = 'rgba(82, 215, 255, 0.3)';
  ctx.lineWidth = 2 * onePixel;
  ctx.strokeRect(-halfWidth, -halfDepth, ARENA.width, ARENA.depth);

  // Corner accents.
  const corner = 14;
  ctx.strokeStyle = 'rgba(255, 104, 70, 0.9)';
  ctx.lineWidth = 4 * onePixel;
  ctx.beginPath();
  ctx.moveTo(-halfWidth, -halfDepth + corner);
  ctx.lineTo(-halfWidth, -halfDepth);
  ctx.lineTo(-halfWidth + corner, -halfDepth);
  ctx.moveTo(halfWidth - corner, -halfDepth);
  ctx.lineTo(halfWidth, -halfDepth);
  ctx.lineTo(halfWidth, -halfDepth + corner);
  ctx.moveTo(halfWidth, halfDepth - corner);
  ctx.lineTo(halfWidth, halfDepth);
  ctx.lineTo(halfWidth - corner, halfDepth);
  ctx.moveTo(-halfWidth + corner, halfDepth);
  ctx.lineTo(-halfWidth, halfDepth);
  ctx.lineTo(-halfWidth, halfDepth - corner);
  ctx.stroke();

  ctx.restore();
}

function drawCar(car) {
  const { x, z, rotation, color, isSelf } = car;

  // Ground shadow.
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.beginPath();
  ctx.ellipse(x + 0.2, z + 0.34, 1.5, 2.34, 0, 0, TAU);
  ctx.fill();

  if (isSelf) {
    ctx.beginPath();
    ctx.arc(x, z, 2.72, 0, TAU);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 0.12;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.translate(x, z);
  ctx.rotate(Math.PI - rotation);

  // Wheels.
  ctx.fillStyle = '#03060b';
  ctx.fillRect(-1.38, -1.32, 0.42, 1.1);
  ctx.fillRect(0.96, -1.32, 0.42, 1.1);
  ctx.fillRect(-1.38, 0.82, 0.42, 1.18);
  ctx.fillRect(0.96, 0.82, 0.42, 1.18);

  // Low-poly body.
  ctx.beginPath();
  ctx.moveTo(0, -2.42);
  ctx.lineTo(1.08, -1.38);
  ctx.lineTo(1.17, 1.42);
  ctx.lineTo(0.82, 1.82);
  ctx.lineTo(-0.82, 1.82);
  ctx.lineTo(-1.17, 1.42);
  ctx.lineTo(-1.08, -1.38);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.lineWidth = 0.09;
  ctx.stroke();

  // Left-side highlight.
  ctx.beginPath();
  ctx.moveTo(-0.88, -1.3);
  ctx.lineTo(-0.63, 1.43);
  ctx.lineTo(-0.17, 1.43);
  ctx.lineTo(-0.42, -1.3);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.fill();

  // Cockpit.
  ctx.beginPath();
  ctx.ellipse(0, -0.34, 0.62, 0.82, 0, 0, TAU);
  ctx.fillStyle = 'rgba(4, 11, 20, 0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(130, 220, 255, 0.28)';
  ctx.lineWidth = 0.06;
  ctx.stroke();

  // Rear wing.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.37)';
  ctx.fillRect(-1.18, 1.55, 2.36, 0.25);

  // Nose marker and lights.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.fillRect(-0.48, -2.08, 0.96, 0.13);
  ctx.fillStyle = '#ffe3a3';
  ctx.fillRect(-0.72, -1.72, 0.25, 0.14);
  ctx.fillRect(0.47, -1.72, 0.25, 0.14);

  ctx.restore();
}

function drawLabels(cars, camera, width, height) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const car of cars) {
    const screenX =
      width / 2 + (car.x - camera.x) * camera.zoom;
    const screenY =
      height / 2 + (car.z - camera.z) * camera.zoom;

    if (
      screenX < -100 ||
      screenX > width + 100 ||
      screenY < -100 ||
      screenY > height + 100
    ) {
      continue;
    }

    const text = car.isSelf ? 'YOU' : car.name;
    ctx.font = car.isSelf
      ? '700 10px "Segoe UI", system-ui, sans-serif'
      : '600 10px "Segoe UI", system-ui, sans-serif';

    const labelWidth = Math.ceil(ctx.measureText(text).width) + 14;
    const labelHeight = 20;
    const labelX = clamp(
      screenX - labelWidth / 2,
      4,
      width - labelWidth - 4
    );
    const labelY = screenY - CAR.radius * camera.zoom - 18;

    roundedRect(ctx, labelX, labelY, labelWidth, labelHeight, 5);
    ctx.fillStyle = 'rgba(4, 9, 15, 0.78)';
    ctx.fill();
    ctx.strokeStyle = car.isSelf
      ? 'rgba(255, 200, 87, 0.55)'
      : 'rgba(151, 179, 219, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = car.isSelf ? '#ffc857' : '#d7e3f4';
    ctx.fillText(text, labelX + labelWidth / 2, labelY + labelHeight / 2 + 0.5);
  }

  ctx.restore();
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

// ---------------------------------------------------------------------------
// Announcements, toasts, storage
// ---------------------------------------------------------------------------

function showAnnouncement(text, extraClass = '', duration = 0) {
  dom.announce.textContent = text;
  dom.announce.className = `announce${extraClass ? ` ${extraClass}` : ''}`;
  dom.announce.classList.remove('is-hidden');
  state.announceHideAt = duration > 0 ? performance.now() + duration : 0;
}

function hideAnnouncement() {
  dom.announce.className = 'announce is-hidden';
  dom.announce.textContent = '';
  state.announceHideAt = 0;
}

function updateAnnouncement(now) {
  if (state.phase === 'countdown') {
    const remaining = state.countdownEndsAt - now;
    const label = remaining > 0 ? String(Math.ceil(remaining / 1000)) : 'SYNC';

    if (dom.announce.textContent !== label || dom.announce.classList.contains('is-hidden')) {
      showAnnouncement(label);
    }
    return;
  }

  if (state.announceHideAt > 0 && now >= state.announceHideAt) {
    hideAnnouncement();
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.remove('is-hidden');
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.add('is-hidden');
  }, 3000);
}

function loadSavedName() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)?.trim();
    if (saved) return saved.slice(0, NET.MAX_NAME_LENGTH);
  } catch {
    // Storage can be unavailable in private contexts.
  }

  const prefix = CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)];
  return `${prefix}-${Math.floor(10 + Math.random() * 90)}`;
}

function saveName(name) {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Non-fatal; the server still has the name for this session.
  }
}
