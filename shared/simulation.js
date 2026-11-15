import { ARENA, CAR } from './constants.js';

export const NEUTRAL_INPUT = Object.freeze({
  seq: 0,
  throttle: 0,
  steer: 0,
  handbrake: false
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function createCar(x = 0, z = 0, rotation = 0) {
  return { x, z, rotation, vx: 0, vz: 0 };
}

export function copyCar(car) {
  return {
    x: car.x,
    z: car.z,
    rotation: car.rotation,
    vx: car.vx,
    vz: car.vz
  };
}

/**
 * Fixed-dt arcade car physics. Both the server and the predicting client run
 * this exact function. Do not use frame delta here: netcode depends on a
 * deterministic timestep.
 *
 * World axes: +X is right, +Z is "forward/down" on the client's top-down view,
 * and rotation 0 faces +Z. Forward vector = (sin(rotation), cos(rotation)).
 */
export function stepCar(car, input, dt) {
  const throttle = clamp(Number(input?.throttle) || 0, -1, 1);
  const steer = clamp(Number(input?.steer) || 0, -1, 1);
  const handbrake = input?.handbrake === true;

  let forwardX = Math.sin(car.rotation);
  let forwardZ = Math.cos(car.rotation);
  let forwardSpeed = car.vx * forwardX + car.vz * forwardZ;

  // Engine / brakes. Holding reverse while moving forward brakes first.
  let force = 0;
  if (throttle > 0) {
    force = forwardSpeed < -0.5 ? CAR.brakeForce : CAR.acceleration;
  } else if (throttle < 0) {
    force = forwardSpeed > 0.5 ? CAR.brakeForce : CAR.reverseAcceleration;
  }

  if (force !== 0) {
    car.vx += forwardX * force * throttle * dt;
    car.vz += forwardZ * force * throttle * dt;
  }

  // More speed means more grip and slightly less steering authority.
  const speed = Math.hypot(car.vx, car.vz);
  if (speed > 0.15) {
    const direction = forwardSpeed >= 0 ? 1 : -1;
    const lowSpeedAuthority = Math.min(1, speed / 8);
    const highSpeedDamping = 1 - Math.min(1, speed / CAR.maxSpeed) * 0.28;
    car.rotation +=
      steer * CAR.turnRate * dt * lowSpeedAuthority * highSpeedDamping * direction;

    // Keep angles bounded so snapshots remain small and interpolation is sane.
    if (car.rotation > Math.PI) car.rotation -= Math.PI * 2;
    if (car.rotation < -Math.PI) car.rotation += Math.PI * 2;
  }

  // Recompute the basis after rotation.
  forwardX = Math.sin(car.rotation);
  forwardZ = Math.cos(car.rotation);
  forwardSpeed = car.vx * forwardX + car.vz * forwardZ;

  // Remove sideways velocity. Handbrake lowers grip so the car can slide.
  const rightX = Math.cos(car.rotation);
  const rightZ = -Math.sin(car.rotation);
  const lateralSpeed = car.vx * rightX + car.vz * rightZ;
  const grip = handbrake ? CAR.handbrakeGrip : CAR.grip;
  const lateralRetention = Math.exp(-grip * dt);
  const lateralDelta = lateralSpeed * (lateralRetention - 1);
  car.vx += rightX * lateralDelta;
  car.vz += rightZ * lateralDelta;

  // Aerodynamic rolling resistance.
  const drag = handbrake ? CAR.handbrakeDrag : CAR.drag;
  const dragRetention = Math.exp(-drag * dt);
  car.vx *= dragRetention;
  car.vz *= dragRetention;

  // Clamp along the heading, not the total vector: lateral drift is allowed.
  forwardSpeed = car.vx * forwardX + car.vz * forwardZ;
  if (forwardSpeed > CAR.maxSpeed) {
    const excess = forwardSpeed - CAR.maxSpeed;
    car.vx -= forwardX * excess;
    car.vz -= forwardZ * excess;
  } else if (forwardSpeed < -CAR.maxReverseSpeed) {
    const excess = forwardSpeed + CAR.maxReverseSpeed;
    car.vx -= forwardX * excess;
    car.vz -= forwardZ * excess;
  }

  car.x += car.vx * dt;
  car.z += car.vz * dt;

  // Static arena walls. Collisions are part of the shared simulation so the
  // local prediction hugs the wall instead of waiting for a correction.
  const halfWidth = ARENA.width / 2 - CAR.radius;
  const halfDepth = ARENA.depth / 2 - CAR.radius;

  if (car.x < -halfWidth) {
    car.x = -halfWidth;
    if (car.vx < 0) car.vx = -car.vx * CAR.wallBounce;
  } else if (car.x > halfWidth) {
    car.x = halfWidth;
    if (car.vx > 0) car.vx = -car.vx * CAR.wallBounce;
  }

  if (car.z < -halfDepth) {
    car.z = -halfDepth;
    if (car.vz < 0) car.vz = -car.vz * CAR.wallBounce;
  } else if (car.z > halfDepth) {
    car.z = halfDepth;
    if (car.vz > 0) car.vz = -car.vz * CAR.wallBounce;
  }

  return car;
}

/** Shortest signed angular difference, useful for interpolation/corrections. */
export function angleDelta(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
