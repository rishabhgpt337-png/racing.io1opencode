# Apex Rift — multiplayer racing foundation

A small, runnable foundation for a top-down multiplayer racing / combat game:

- Node.js + Express + Socket.io
- 4-digit private lobbies
- Authoritative 60 Hz server simulation
- 20 Hz snapshots with client-side prediction, server reconciliation, and remote interpolation
- Low-poly canvas renderer and a basic race-start flow

No build step. The browser loads the same physics module as the server.

## Run it

```bash
npm install
npm start
```

Open [http://localhost:3100](http://localhost:3100) in two tabs (or two devices on the same LAN). Create a room in one tab, enter the four-digit code in the other, then start the race as host.

If port 3100 is already in use, the server automatically tries the next port and prints the correct URL in the terminal. You can also choose one explicitly:

```powershell
$env:PORT=3200; npm start
```

On macOS/Linux, use `PORT=3200 npm start`.

Development mode with automatic server restarts:

```bash
npm run dev
```

Smoke test of the whole handshake and sync loop:

```bash
npm test
```

### LAN play

The server binds all interfaces by default. Find your machine's IPv4 address and open `http://YOUR-LAN-IP:3100` from the other device. Allow the printed port through the local firewall if necessary. A 4-digit code is only a room identifier; use HTTPS and real authentication for public deployment.

### Play from the internet

The GitHub repository page only shows source code. GitHub Pages cannot run this game because multiplayer requires the Node.js/Socket.io server. Either keep the server running on your machine, or deploy it to a Node host.

A Render blueprint is included:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rishabhgpt337-png/racing.io1opencode)

Render gives you a public `https://…onrender.com` URL. It supports WebSockets. Free instances sleep when idle, so the first load can take a few seconds. The included `render.yaml` sets `NODE_ENV=production`, and Render supplies `PORT` automatically.

Alternatives that support persistent WebSockets: Railway, Fly.io, a VPS, or any Node host. Serverless platforms that do not support long-lived WebSocket connections are not suitable.

## Controls

| Input | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake / reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake / drift |

Touch controls are intentionally not included yet.

## Project layout

```text
server/
  index.js          HTTP, Socket.io lobby events, fixed timestep loop
  room.js           Room/player state, countdown, movement, snapshots
shared/
  constants.js      Tick rates, arena/car tuning, spawns, colors
  simulation.js     Deterministic car physics shared by server and client
public/
  index.html        Menu, lobby, HUD
  app.js            Socket client, prediction/reconciliation, interpolation, renderer
  styles.css        UI
tests/
  smoke.mjs         Automated create → join → start → input → snapshot test
```

## Networking model

### 1. Room lifecycle

- `room:create` creates a room with a random unused code from `1000–9999`, adds the host, and joins the socket to a Socket.io channel (`room:1234`).
- `room:join` validates the code, lobby state, and capacity (8 players).
- `room:start` is host-only. The server resets spawn positions, broadcasts `game:starting`, and waits 3 seconds.
- When the countdown reaches zero, the server sets `phase = 'racing'`, broadcasts `game:live`, and accepts inputs.
- Empty rooms are deleted immediately. Host leaves trigger a host migration to the next player.
- Starting the race with one player is allowed so you can test handling solo.

### 2. Authoritative simulation

The server runs a fixed **60 Hz** loop (`server/index.js`). The loop advances a deadline by exactly one tick each step, so timer jitter does not accumulate. A catch-up cap prevents a death spiral after a process stall.

Clients send **input state**, never positions:

```js
{ seq, throttle, steer, handbrake }
```

The server clamps values, rate-limits input packets, and simulates movement itself. If input packets stop for 250 ms (for example, the tab was hidden), the server neutralizes the controls so the car cannot drive away on its own.

### 3. Snapshots

The server broadcasts at **20 Hz** (every third simulation tick). Snapshot rows are compact arrays:

```text
[slot, x, z, rotation, vx, vz, lastProcessedInputSeq]
```

One broadcast is sent to the entire room rather than one tailored packet per player. Each client finds its own row to get its acknowledgement number.

Snapshots are sent with `volatile.emit`, which drops a packet if the socket is backed up instead of building an ever-growing queue of stale states.

### 4. Client prediction and reconciliation

The local client:

1. Samples controls at 60 Hz and immediately applies the same shared `stepCar()` function.
2. Stores each unacknowledged input.
3. On a snapshot, replaces its local state with the server's authoritative state.
4. Removes inputs with `seq <= acknowledgedSeq`.
5. Replays the remaining inputs on top of the server state.
6. Smooths small correction errors over a few frames; large errors snap.

This makes local driving react immediately without trusting the client.

### 5. Remote interpolation

Other cars are rendered **100 ms in the past**. The client buffers snapshots and interpolates between the two that bracket the render time. Rotation interpolation uses shortest-angle wrapping. This hides packet jitter and the 20 Hz snapshot rate; tune `NET.INTERP_DELAY_MS` in `shared/constants.js`.

### 6. Transport

The browser requests a direct WebSocket (`transports: ['websocket']`) to skip the polling → WebSocket upgrade. Compression is disabled for small game packets. RTT shown in the HUD is a tiny application-level ping, not the Socket.io heartbeat.

None of this changes geographic latency. For genuinely low ping, deploy game servers in the regions players are in.

## Tuning

Edit `shared/constants.js`:

- `NET.SIM_HZ` — authoritative simulation frequency (default 60).
- `NET.SNAPSHOT_HZ` / `NET.SNAPSHOT_EVERY` — network frequency (default 20).
- `NET.INPUT_HZ` — documentary; client prediction steps at `SIM_HZ`.
- `NET.INTERP_DELAY_MS` — remote render delay (default 100 ms).
- `NET.COUNTDOWN_MS` — pre-race freeze.
- `CAR.*` — acceleration, top speed, grip, handbrake, wall bounce.
- `ARENA`, `SPAWNS`, `COLORS`.

Snapshot cost at 8 players is roughly 400–500 bytes of JSON per snapshot. At 20 Hz that is around 8–10 KB/s per client before WebSocket framing.

## Adding combat next

The server is already the single source of truth, so combat should follow the same pattern:

1. Add health/armor/weapon cooldown fields to the server player object.
2. Validate fire requests on the server (fire rate, ammo, alive state).
3. Resolve hits on the server using the authoritative car positions, not client-reported positions.
4. Add the new state to the compact snapshot row and HUD.
5. Add server-side car-to-car collision. It is currently walls-only; collisions should be resolved after all cars have stepped.
6. Add race checkpoints/laps on the server if you want a finish condition.

Send cosmetic effects (muzzle flash, hit sparks) as separate ephemeral events; never let them affect hit detection.

## Production notes

This is a solid single-process prototype, but review these before launch:

- **4-digit lobby codes are guessable.** Add authentication, per-IP join limits, room expiration, and possibly a private invite token in addition to the code.
- **Socket.io is convenient, not the fastest possible stack.** For larger rooms or higher tick rates, consider `uWebSockets.js`, raw WebSockets + a binary protocol, or a dedicated game server framework. Measure before switching.
- **One Node process is a limit.** For multiple instances, use the Socket.io Redis adapter and ensure everyone in a room hits the same authoritative process. A shared room registry is also needed if you allow finding a room from any node.
- **Use binary snapshots at scale.** JSON is readable and fine for 8-player rooms; MessagePack or a custom ArrayBuffer layout will cut bandwidth and parse cost.
- **Add session recovery.** A reconnect creates a new socket id today, so the client returns to the menu. Production games usually use a signed session token and a short reconnect grace period.
- **Interest management.** When the player count grows, send only nearby cars rather than the whole room.
- **Run behind TLS and a WebSocket-capable proxy.** Confirm `wss://` and sticky sessions if you use multiple nodes.
- **Instrument tick time, snapshot bytes, and RTT percentiles.** Average ping is not enough; watch p95/p99 and input starvation.

## Scope

Included: room creation/joining, host start, countdown, authoritative driving, prediction/reconciliation, interpolated remote cars, ping HUD, leave/disconnect cleanup, smoke test.

Not included yet: combat, car-vs-car collisions, laps/checkpoints, touch controls, reconnect recovery, matchmaking, persistence, anti-cheat, spectator mode. The shared physics module is the correct place to extend deterministic movement; gameplay rules belong on the server.
