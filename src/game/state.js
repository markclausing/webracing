/**
 * The race, as data.
 *
 * Same contract as websoccer and webtennis: one plain object holding everything
 * the game needs, no DOM, no clock, and no randomness that does not come out of
 * `state.rng`. Four machines given the same state and the same buttons must
 * reach the same finishing order, which is what makes the netcode possible and,
 * more usefully day to day, makes the whole thing testable without a browser.
 *
 * The one thing in here that is not a number is `state.track`, and it is safe:
 * it is built from the track's key by loadTrack(), which is pure, cached, and
 * gives every machine the identical loop.
 */

import {
  AI_LEVELS, CAR_PRESETS, COUNTDOWN_TICKS, LAPS, MAX_CARS, TICK_RATE,
} from '../constants.js';
import { loadTrack } from './tracks.js';
import { pointAt } from './path.js';

export function createRace(options = {}) {
  const opts = {
    seed: 12345,
    track: 'breakfast',
    laps: LAPS,
    humans: [true, false, false, false],
    cars: MAX_CARS,
    difficulty: 'normal',
    ...options,
  };

  const track = loadTrack(opts.track);
  const count = Math.max(2, Math.min(MAX_CARS, Math.round(opts.cars)));

  const state = {
    tick: 0,
    rng: opts.seed | 0,
    seed: opts.seed | 0,
    config: {
      track: track.key,
      laps: Math.max(1, Math.round(opts.laps)),
      cars: count,
    },
    track,
    // countdown | race | finish | over
    phase: 'countdown',
    phaseTimer: COUNTDOWN_TICKS,
    message: '',
    // What just happened. The renderer and the sound read these; the simulation
    // never reads them back, and they are cleared at the top of every step.
    events: [],
    // Finishing order, filled as cars cross the line for the last time.
    order: [],
    // Turbos lying on the road. Dropped behind the leader and short lived, so
    // running away at the front means never meeting one - see turbo() in sim.js.
    boosts: [],
    // The quickest clean lap anybody has turned in this race, in ticks.
    best: null,
    cars: [],
  };

  for (let i = 0; i < count; i++) {
    state.cars.push(makeCar(state, i, !!opts.humans[i], levelFor(opts.difficulty, i)));
  }
  return state;
}

function levelFor(difficulty, i) {
  const key = Array.isArray(difficulty) ? difficulty[i] : difficulty;
  return AI_LEVELS[key] || AI_LEVELS.normal;
}

/**
 * The grid: two by two, just short of the line, in the order the seats were
 * handed out.
 *
 * Behind the line rather than on it, so the first crossing starts the first lap
 * and every lap on the board was timed the same way - including the first one,
 * which on a grid drawn across the line would have been a standing start and a
 * second and a half slower than all the others for no reason anybody could see.
 */
function makeCar(state, index, human, ai) {
  const { track } = state;
  const preset = CAR_PRESETS[index];
  const row = Math.floor(index / 2);
  const at = pointAt(track.path, -track.start.back - row * 46);
  const side = index % 2 === 0 ? 1 : -1;
  const off = track.width * 0.42 * side;

  return {
    index,
    name: preset.name,
    human: !!human,
    ai,
    // Where it is, which way it is pointing, and where it is going. The last two
    // are not the same thing, and the difference between them is the drift.
    x: at.x - at.ty * off,
    y: at.y + at.tx * off,
    angle: Math.atan2(at.ty, at.tx),
    vx: 0,
    vy: 0,
    steer: 0,
    // Where it sits on the loop. `node` is the piece it was on last tick, and it
    // is state rather than something worked out fresh: a track that doubles back
    // has two nearest points and only one of them is the road you are on.
    node: at.node,
    along: at.along,
    lap: 0,
    progress: at.along,
    place: index + 1,
    lapStart: 0,
    // A lap stops counting for the board the moment you are put back on the
    // track, however you got there. The clock keeps running; the record does not.
    clean: true,
    laps: [],
    best: null,
    finished: false,
    // run | falling | waiting
    mode: 'run',
    timer: 0,
    fell: 0,
    drops: 0,
    // How deep in somebody's wake it is, 0 to 1, and how many ticks of turbo it
    // has left. Both raise the ceiling and push a little harder towards it.
    slip: 0,
    boost: 0,
    // Read by the renderer and the sound, never by the simulation.
    surface: 'road',
    slide: 0,
    throttle: 0,
    braking: false,
    prevMask: 0,
    // The CPU only changes its mind every few ticks; this is what it decided.
    want: 0,
    thinkAt: -99,
    // When it last chose a line across the road. Staggered on the grid, so four
    // identical drivers do not all move over at the same moment and run round
    // nose to tail in grid order for three laps.
    driftAt: -index * 11,
  };
}

/** Ticks to a lap time. Lap times are the whole point of the board. */
export function lapMs(ticks) {
  return Math.round((ticks * 1000) / TICK_RATE);
}

/** "1:04.83", or "--.--" for a lap nobody has turned yet. */
export function formatLap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--.--';
  const total = Math.round(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/** The car in front, by distance covered rather than by who is nearer the line. */
export function leader(state) {
  let best = state.cars[0];
  for (const car of state.cars) if (car.progress > best.progress) best = car;
  return best;
}

/** Places, one to four, by distance covered. Finishers keep the place they took. */
export function rank(state) {
  const running = [];
  for (const car of state.cars) {
    if (!car.finished) running.push(car);
  }
  running.sort((a, b) => b.progress - a.progress);
  const taken = state.order.length;
  running.forEach((car, i) => {
    car.place = taken + i + 1;
  });
}

/** The lap a car is on, as it should read on screen: 1 to the last, never 0. */
export function lapNumber(state, car) {
  return Math.max(1, Math.min(state.config.laps, car.lap || 1));
}

/** Deterministic hash of everything that matters, for the desync check. */
export function hashState(state) {
  let h = 2166136261;
  const mix = (v) => {
    h ^= Math.round(v * 16) | 0;
    h = Math.imul(h, 16777619);
  };
  mix(state.tick);
  mix(state.phase === 'race' ? 1 : state.phase === 'countdown' ? 2 : 3);
  // The turbos are hashed too. They come out of state.rng, so two machines that
  // disagreed about where one landed would be about to disagree about the race,
  // and this is the cheapest place to find that out.
  mix(state.boosts.length);
  for (const boost of state.boosts) {
    mix(boost.x);
    mix(boost.y);
    mix(boost.life);
  }
  for (const car of state.cars) {
    mix(car.x);
    mix(car.y);
    mix(car.vx);
    mix(car.vy);
    mix(car.angle * 100);
    mix(car.lap);
    mix(car.boost);
    mix(car.finished ? 1 : 0);
  }
  return h >>> 0;
}
