import { hashState } from '../game/state.js';
import { MAX_CARS } from '../constants.js';

/**
 * A transport supplies the inputs of ALL players, per tick.
 * The game loop only knows this interface:
 *
 *    transport.sample(tick)   record (and send) this machine's input
 *    transport.ready(tick)    are we allowed to simulate this tick?
 *    transport.poll(tick)  -> [mask0, mask1, mask2, mask3]
 *    transport.afterStep(state)
 *
 * Locally everything comes from the keyboard and the gamepads; online the rest
 * of it comes from up to three other people. The simulation cannot tell the
 * difference - which is why adding online multiplayer needed no changes to
 * sim.js at all.
 *
 * This is websoccer and webtennis's netcode with the two turned into four. The
 * shape is identical and the idea is identical; what changed is that "the peer"
 * became "the other seats", and a stall is now anybody's fault rather than one
 * particular person's.
 */

/** Everybody on one machine: keyboards, gamepads, and the CPU for the rest. */
export class LocalTransport {
  constructor(devices, humanSlots = [0]) {
    this.devices = devices;
    this.humanSlots = humanSlots; // humanSlots[controller] = seat index
    this.online = false;
  }

  sample() {}

  ready() {
    return true;
  }

  poll() {
    const out = new Array(MAX_CARS).fill(0);
    this.humanSlots.forEach((seat, controller) => {
      if (seat >= 0 && seat < MAX_CARS) out[seat] = this.devices.mask(controller);
    });
    return out;
  }

  afterStep() {}
  dispose() {}
}

/**
 * Ring buffer of inputs per tick. Stores the tick number alongside the value, so
 * a stale entry can never pass for a fresh one after the buffer wraps around.
 */
export class InputBuffer {
  constructor(size = 1024) {
    this.size = size;
    this.masks = new Int32Array(size);
    this.ticks = new Int32Array(size).fill(-1);
  }

  set(tick, mask) {
    if (tick < 0) return;
    const i = tick % this.size;
    if (this.ticks[i] === tick) return; // first value to arrive wins
    this.masks[i] = mask;
    this.ticks[i] = tick;
  }

  get(tick) {
    const i = ((tick % this.size) + this.size) % this.size;
    return this.ticks[i] === tick ? this.masks[i] : null;
  }
}

/**
 * Online multiplayer: lockstep with input delay, for up to four.
 *
 * Every machine runs the same deterministic simulation and sends the others only
 * its own buttons - never positions, never lap times. The input for tick T is
 * sent DELAY ticks ahead of time so it arrives before it is needed. If it is not
 * there anyway the simulation waits (a "stall") rather than guessing, so nobody
 * can drift apart from anybody else.
 *
 * With four players a stall is three times as likely as it was with two, which
 * is the honest cost of this arrangement. Two things take the edge off it: the
 * delay tunes itself upwards for everybody who needs it, and a player who
 * actually disconnects stops being waited for at all - see `gone`.
 */
export class OnlineTransport {
  constructor({
    signal, devices, seats = 2, localSeat = 0, delay = 4, minDelay = 3, maxDelay = 14,
  }) {
    this.signal = signal;
    this.devices = devices;
    this.seats = seats;
    this.localSeat = localSeat;
    this.delay = delay;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.online = true;

    this.buffers = [];
    for (let i = 0; i < MAX_CARS; i++) this.buffers.push(new InputBuffer());
    this.lastSent = -1;

    /** Seats whose player has left. Their car carries on, on autopilot. */
    this.gone = [];
    this.stalls = 0;
    this.stallWindow = 0;
    this.calmSeconds = 0;
    this.stalling = false;
    this.ping = 0;
    this.pongs = 0;
    this.desync = false;

    this.myHashes = new Map();
    this.theirHashes = new Map();

    // For the first DELAY ticks nobody has been able to send anything yet. Every
    // machine fills in the same zeroes, otherwise everyone waits for everyone.
    for (let t = 0; t < delay; t++) {
      for (const buffer of this.buffers) buffer.set(t, 0);
    }

    signal.on('input', (m) => {
      // The seat is stamped by the relay, not by the sender: a client that could
      // name its own seat could drive somebody else's car.
      const buffer = this.buffers[m.seat];
      if (!buffer) return;
      for (const [tick, mask] of m.frames) buffer.set(tick, mask);
    });
    signal.on('hash', (m) => this.onRemoteHash(m));
    signal.on('ping', (m) => signal.send({ t: 'pong', id: m.id }));
    signal.on('pong', (m) => {
      this.ping = Math.max(0, Math.round(now() - m.id));
      this.pongs++;
    });
    signal.on('peerleft', (m) => this.left(m.seat));
  }

  /**
   * Somebody has closed their tab.
   *
   * Their car is handed nothing but zeroes from here on, which every machine
   * does identically, so the race carries on and stays in step. It does not end
   * the race: three people should not lose their game because a fourth had to
   * answer the door.
   */
  left(seat) {
    if (seat === undefined || seat === null || this.gone.includes(seat)) return;
    this.gone.push(seat);
  }

  /** Record this machine's input for tick+DELAY and send it off. */
  sample(tick) {
    const target = tick + this.delay;
    if (target <= this.lastSent) return;

    // Online you drive one car, so both keyboard halves and every gamepad drive
    // the same one.
    let mask = 0;
    for (let slot = 0; slot < MAX_CARS; slot++) mask |= this.devices.mask(slot);

    const mine = this.buffers[this.localSeat];
    // Fill every tick up to and including `target`. Usually that is exactly one,
    // but if the delay has just gone up there must be no gap: a missing tick
    // would leave everybody else waiting forever.
    for (let t = Math.max(this.lastSent + 1, 0); t <= target; t++) mine.set(t, mask);
    this.lastSent = target;

    // The last few ticks ride along every time: lost packets repair themselves
    // without anything ever having to be re-requested.
    const frames = [];
    for (let t = Math.max(0, target - 7); t <= target; t++) {
      const v = mine.get(t);
      if (v !== null) frames.push([t, v]);
    }
    this.signal.send({ t: 'input', frames });
  }

  ready(tick) {
    let ok = true;
    for (let seat = 0; seat < this.seats; seat++) {
      if (this.gone.includes(seat)) continue;
      if (this.buffers[seat].get(tick) === null) {
        ok = false;
        break;
      }
    }
    if (ok) {
      this.stalling = false;
    } else {
      this.stalls++;
      this.stallWindow++;
      this.stalling = true;
    }
    return ok;
  }

  /**
   * The input delay adapts to the connection: if we stall often we send our
   * input further ahead (slightly laggier controls, but a smooth picture). It
   * may differ per player - every input carries its own tick number, so the
   * simulation stays identical on every machine.
   */
  tuneDelay() {
    if (this.stallWindow > 8 && this.delay < this.maxDelay) {
      this.delay++;
      this.calmSeconds = 0;
    } else if (this.stallWindow === 0) {
      this.calmSeconds++;
      if (this.calmSeconds >= 8 && this.delay > this.minDelay) {
        this.delay--;
        this.calmSeconds = 0;
      }
    } else {
      this.calmSeconds = 0;
    }
    this.stallWindow = 0;
  }

  poll(tick) {
    const out = new Array(MAX_CARS).fill(0);
    for (let seat = 0; seat < this.seats; seat++) {
      if (this.gone.includes(seat)) continue;
      out[seat] = this.buffers[seat].get(tick) ?? 0;
    }
    return out;
  }

  /** Compare state once a second; any difference means a desync. */
  afterStep(state) {
    if (state.tick % 60 !== 0) return;
    this.tuneDelay();

    const mine = hashState(state);
    this.myHashes.set(state.tick, mine);
    if (this.myHashes.size > 40) {
      this.myHashes.delete(this.myHashes.keys().next().value);
    }

    this.signal.send({ t: 'hash', tick: state.tick, hash: mine });
    this.signal.send({ t: 'ping', id: now() });

    const theirs = this.theirHashes.get(state.tick);
    if (theirs !== undefined) {
      this.theirHashes.delete(state.tick);
      if (theirs !== mine) this.desync = true;
    }
  }

  onRemoteHash(m) {
    const mine = this.myHashes.get(m.tick);
    if (mine === undefined) {
      this.theirHashes.set(m.tick, m.hash);
      if (this.theirHashes.size > 40) {
        this.theirHashes.delete(this.theirHashes.keys().next().value);
      }
    } else if (mine !== m.hash) {
      this.desync = true;
    }
  }

  dispose() {
    this.signal.close();
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
