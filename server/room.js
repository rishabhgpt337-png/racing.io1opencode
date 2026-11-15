import { ARENA, COLORS, NET, SPAWNS, TICK_SECONDS } from '../shared/constants.js';
import { createCar, NEUTRAL_INPUT, stepCar } from '../shared/simulation.js';

const SNAPSHOT_DECIMALS = 2;

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export class Room {
  constructor(code, hostId) {
    this.code = code;
    this.channel = `room:${code}`;
    this.hostId = hostId;
    this.players = new Map();
    this.phase = 'lobby'; // lobby | countdown | racing
    this.tick = 0;
    this.countdownEndsAt = 0;
    this.createdAt = Date.now();
  }

  get isFull() {
    return this.players.size >= NET.MAX_PLAYERS;
  }

  addPlayer(id, name) {
    let slot = 1;
    const usedSlots = new Set([...this.players.values()].map((player) => player.slot));
    while (usedSlots.has(slot)) slot += 1;

    const usedColors = new Set([...this.players.values()].map((player) => player.color));
    const color = COLORS.find((candidate) => !usedColors.has(candidate)) ??
      COLORS[(slot - 1) % COLORS.length];

    const player = {
      id,
      slot,
      name,
      color,
      ...createCar(),
      latestInput: NEUTRAL_INPUT,
      lastInputSeq: 0,
      lastProcessedSeq: 0,
      lastInputAt: 0,
      inputStale: true
    };

    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return null;

    this.players.delete(id);
    if (this.hostId === id) {
      this.hostId = this.players.values().next().value?.id ?? null;
    }
    return player;
  }

  getPlayer(id) {
    return this.players.get(id);
  }

  toLobby() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      maxPlayers: NET.MAX_PLAYERS,
      players: [...this.players.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((player) => ({
          id: player.id,
          slot: player.slot,
          name: player.name,
          color: player.color
        }))
    };
  }

  gameRoster() {
    return [...this.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((player) => ({
        slot: player.slot,
        name: player.name,
        color: player.color,
        x: player.x,
        z: player.z,
        rotation: player.rotation
      }));
  }

  canStart(playerId) {
    if (this.phase !== 'lobby') return 'The race has already started.';
    if (this.hostId !== playerId) return 'Only the host can start the race.';
    if (this.players.size === 0) return 'There are no players in this room.';
    return null;
  }

  beginCountdown(io) {
    this.phase = 'countdown';
    this.tick = 0;
    this.countdownEndsAt = Date.now() + NET.COUNTDOWN_MS;

    for (const player of this.players.values()) {
      const spawn = SPAWNS[(player.slot - 1) % SPAWNS.length];
      Object.assign(player, createCar(spawn.x, spawn.z, spawn.rotation));
      player.latestInput = NEUTRAL_INPUT;
      player.lastInputSeq = 0;
      player.lastProcessedSeq = 0;
      player.lastInputAt = 0;
      player.inputStale = true;
    }

    io.to(this.channel).emit('game:starting', {
      countdownMs: NET.COUNTDOWN_MS,
      arena: ARENA,
      players: this.gameRoster()
    });
  }

  update(io, now) {
    if (this.phase === 'countdown') {
      if (now < this.countdownEndsAt) return;

      this.phase = 'racing';
      this.tick = 0;

      for (const player of this.players.values()) {
        player.latestInput = NEUTRAL_INPUT;
        player.lastInputSeq = 0;
        player.lastProcessedSeq = 0;
        player.lastInputAt = 0;
        player.inputStale = true;
      }

      io.to(this.channel).emit('game:live', {
        tick: 0,
        serverTime: now
      });
      this.broadcastSnapshot(io);
      return;
    }

    if (this.phase !== 'racing') return;

    this.tick += 1;

    for (const player of this.players.values()) {
      // A hidden tab or dead connection must not leave the throttle pinned.
      if (now - player.lastInputAt > NET.INPUT_TIMEOUT_MS) {
        if (!player.inputStale) {
          player.latestInput = {
            seq: player.latestInput.seq,
            throttle: 0,
            steer: 0,
            handbrake: false
          };
          player.inputStale = true;
        }
      }

      stepCar(player, player.latestInput, TICK_SECONDS);
      player.lastProcessedSeq = player.latestInput.seq;
    }

    // Snapshots are sent at 20 Hz even though simulation runs at 60 Hz.
    if (this.tick % NET.SNAPSHOT_EVERY === 0) {
      this.broadcastSnapshot(io);
    }
  }

  /**
   * Compact array format keeps snapshots small:
   * [slot, x, z, rotation, vx, vz, ackedInputSequence]
   * Every client reads its own ack from its row. One room broadcast rather than
   * one tailored packet per client.
   */
  broadcastSnapshot(io) {
    const players = [];

    for (const player of this.players.values()) {
      players.push([
        player.slot,
        round(player.x, SNAPSHOT_DECIMALS),
        round(player.z, SNAPSHOT_DECIMALS),
        round(player.rotation, 3),
        round(player.vx, 2),
        round(player.vz, 2),
        player.lastProcessedSeq
      ]);
    }

    io.to(this.channel).volatile.emit('game:snapshot', {
      t: this.tick,
      p: players
    });
  }
}
