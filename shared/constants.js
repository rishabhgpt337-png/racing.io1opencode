/**
 * Shared by the Node server and the browser client.
 * Keep this file free of Node- or browser-only APIs.
 */
export const NET = Object.freeze({
  /** Authoritative simulation frequency. */
  SIM_HZ: 60,
  /** Network snapshot frequency. 20 Hz is plenty with interpolation. */
  SNAPSHOT_HZ: 20,
  /** 60 / 20 = send a snapshot every 3 simulation ticks. */
  SNAPSHOT_EVERY: 3,
  /** Client sends one input packet per simulation tick. */
  INPUT_HZ: 60,
  /** Render remote cars this far in the past to absorb jitter. */
  INTERP_DELAY_MS: 100,
  /** Server counts down before it accepts movement input. */
  COUNTDOWN_MS: 3000,
  MAX_PLAYERS: 8,
  MAX_NAME_LENGTH: 16,
  /** Hard cap to make abusive input spam cheap to reject. */
  INPUTS_PER_SECOND: 120,
  /** If packets stop arriving, coast instead of applying stale controls forever. */
  INPUT_TIMEOUT_MS: 250
});

export const TICK_MS = 1000 / NET.SIM_HZ;
export const TICK_SECONDS = 1 / NET.SIM_HZ;

export const ARENA = Object.freeze({
  width: 180,
  depth: 120
});

export const CAR = Object.freeze({
  radius: 1.9,
  maxSpeed: 38,
  maxReverseSpeed: 16,
  acceleration: 40,
  reverseAcceleration: 26,
  brakeForce: 72,
  turnRate: 2.75,
  grip: 9,
  handbrakeGrip: 1.8,
  drag: 0.6,
  handbrakeDrag: 2.4,
  wallBounce: 0.32
});

/**
 * Starting grid, front row first. Rotation Math.PI means facing -Z.
 * The server assigns a spawn by room slot so every client agrees.
 */
export const SPAWNS = Object.freeze([
  Object.freeze({ x: -27, z: 42, rotation: Math.PI }),
  Object.freeze({ x: -9, z: 42, rotation: Math.PI }),
  Object.freeze({ x: 9, z: 42, rotation: Math.PI }),
  Object.freeze({ x: 27, z: 42, rotation: Math.PI }),
  Object.freeze({ x: -27, z: 32, rotation: Math.PI }),
  Object.freeze({ x: -9, z: 32, rotation: Math.PI }),
  Object.freeze({ x: 9, z: 32, rotation: Math.PI }),
  Object.freeze({ x: 27, z: 32, rotation: Math.PI })
]);

export const COLORS = Object.freeze([
  '#ff5d73',
  '#ffb703',
  '#4cc9f0',
  '#7bd389',
  '#b388ff',
  '#ff8fab',
  '#fb8500',
  '#e5e7eb'
]);
