/**
 * The simulation. One tick of the race, and nothing else.
 *
 * No DOM, no clock, no Math.random: give it the same state and the same four
 * button masks and it produces the same next state on every machine, which is
 * the whole basis of the netcode. Everything the outside world needs to know
 * about what happened is pushed onto `state.events` and read by the renderer and
 * the sound; the simulation never reads them back.
 *
 * The driving model is the standard arcade one, and it is worth saying out loud
 * because everything about how the game feels comes out of the order of four
 * lines:
 *
 *   1. turn the car - the heading moves, the velocity does not
 *   2. split the velocity into "along the car" and "across the car"
 *   3. the engine works on the first, the tyres eat the second
 *   4. put them back together
 *
 * Step 1 is where the slide comes from: turning the nose does not turn the car,
 * it only changes what counts as sideways. Step 3 is where the brake becomes a
 * handbrake, because braking is allowed to take most of the grip away with it.
 */

import {
  ACCEL, BOOST_AHEAD, BOOST_EVERY, BOOST_LIFE, BOOST_MAX, BOOST_MIN_GAP, BOOST_POWER,
  BOOST_R, BOOST_TICKS, BRAKE, BRAKE_GRIP, BTN, BUMP_MIN, BUMP_PUSH, CAR_R, DROP_GAP,
  DROP_TICKS, DT, FALL_ANIM, FALL_TICKS, FINISH_TICKS, GRIP, REJOIN_BACK, REVERSE_ACCEL,
  REVERSE_SPEED, ROLL_DRAG, SLIDE_DRAG, SLIDE_MARK, SLIP_MAX, SLIP_MIN_SPEED, SLIP_RANGE,
  SLIP_WIDTH, SURFACES, TICK_RATE, TOP_SPEED, TURN_FADE, TURN_MIN, TURN_RATE, TURN_STALL,
} from '../constants.js';
import { nextRandom } from '../util.js';
import { gapAround, nearest, pointAt } from './path.js';
import { leader, rank } from './state.js';
import { aiMask } from './ai.js';

/** How quickly the wheel follows the button. Instant steering feels like ice. */
const STEER_SMOOTH = 0.32;
/** How much of the speed into a wall comes back out of it. */
const WALL_BOUNCE = 0.36;
/** How far behind the leader a car put back on the road may be, as a share of
 *  the distance that would have it scooped up again. */
const REJOIN_ROOM = 0.6;

export function step(state, inputs = []) {
  state.events.length = 0;
  state.tick++;

  if (state.phase === 'over') return state;

  if (state.phase === 'countdown') {
    state.phaseTimer--;
    // Three, two, one, go - and the lights are events rather than a number the
    // renderer works out for itself, so the sound and the picture agree.
    // Counted off the tick before the second turns over, so all three lights
    // happen: on the second itself the first one has already gone by.
    if (state.phaseTimer > 0 && (state.phaseTimer + 1) % TICK_RATE === 0) {
      state.events.push({ type: 'light', left: Math.ceil(state.phaseTimer / TICK_RATE) });
    }
    if (state.phaseTimer <= 0) {
      state.phase = 'race';
      state.phaseTimer = 0;
      for (const car of state.cars) car.lapStart = state.tick;
      state.events.push({ type: 'go' });
    }
    return state;
  }

  // Who is in whose wake, worked out for everybody before anybody moves. Done
  // in its own pass rather than inside drive(), or the first car in the list
  // would be reading last tick's positions and the last car this tick's.
  tow(state);
  for (const car of state.cars) drive(state, car, maskFor(state, car, inputs));
  bumps(state);
  for (const car of state.cars) locate(state, car);
  turbo(state);
  rank(state);

  if (state.phase === 'finish') {
    state.phaseTimer--;
    const allIn = state.cars.every((c) => c.finished);
    if (allIn || state.phaseTimer <= 0) endRace(state);
  }
  return state;
}

/**
 * Who is driving this car.
 *
 * A human who has already finished hands the wheel back to the CPU rather than
 * stopping dead on the road, which is both what happens on a real slowing-down
 * lap and the only way the cars behind get a clean run at the line.
 */
function maskFor(state, car, inputs) {
  if (!car.human || car.finished) return aiMask(state, car);
  return inputs[car.index] | 0;
}

function drive(state, car, mask) {
  // Off the table, or waiting to be put back on it. Neither is driving.
  if (car.mode === 'falling') {
    car.timer--;
    car.fell = Math.min(1, (FALL_TICKS - car.timer) / FALL_ANIM);
    // Still travelling while it drops, so it goes over the edge rather than
    // stopping in mid-air and then sinking.
    car.x += car.vx * DT * 0.4;
    car.y += car.vy * DT * 0.4;
    if (car.timer <= 0) rejoin(state, car, 'fell');
    return;
  }
  if (car.mode === 'waiting') {
    car.timer--;
    if (car.timer <= 0) {
      car.mode = 'run';
      state.events.push({ type: 'ready', seat: car.index });
    }
    return;
  }

  const { track } = state;
  const surf = SURFACES[car.surface] || SURFACES.road;
  const accel = (mask & (BTN.UP | BTN.FIRE)) !== 0;
  const brake = (mask & (BTN.DOWN | BTN.SWITCH)) !== 0;
  let want = 0;
  if (mask & BTN.LEFT) want -= 1;
  if (mask & BTN.RIGHT) want += 1;

  // --- 1. turn the car ------------------------------------------------------
  car.steer += (want - car.steer) * STEER_SMOOTH;
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
  // A parked car does not steer, and a car doing 300 does not steer like one
  // doing 30. Without the second half of that a car pirouettes on the spot.
  const grounded = Math.min(1, speed / TURN_STALL);
  const fade = Math.min(1, speed / (TOP_SPEED * TURN_FADE));
  const rate = TURN_RATE * (1 - (1 - TURN_MIN) * fade);
  // Reversing steers the other way round, as it does in a car park.
  const cs0 = Math.cos(car.angle);
  const sn0 = Math.sin(car.angle);
  const going = car.vx * cs0 + car.vy * sn0;
  car.angle += car.steer * rate * grounded * (going < -4 ? -1 : 1) * DT;

  // --- 2. split it ----------------------------------------------------------
  const cs = Math.cos(car.angle);
  const sn = Math.sin(car.angle);
  let fwd = car.vx * cs + car.vy * sn;
  let lat = -car.vx * sn + car.vy * cs;

  // --- 3. the engine and the tyres ------------------------------------------
  if (accel && !brake) {
    fwd += ACCEL * track.handling.accel * DT;
  } else if (brake) {
    // One control does both jobs. At speed it is a brake, and it takes most of
    // the grip with it; at a standstill it is reverse. Nobody has ever wanted a
    // separate reverse button on a game like this.
    if (fwd > 6) fwd -= BRAKE * DT;
    else fwd = Math.max(-REVERSE_SPEED, fwd - REVERSE_ACCEL * DT);
  } else {
    fwd -= fwd * ROLL_DRAG * DT;
  }

  const grip = GRIP * surf.grip * track.handling.grip * (brake ? BRAKE_GRIP : 1);
  const kept = Math.exp(-grip * DT);
  const wasSliding = Math.abs(car.slide) > SLIDE_MARK;
  lat *= kept;
  // A slide is not free: scrubbing sideways takes speed out of the car, which is
  // why the fastest way round a corner is not the most spectacular one.
  fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), Math.abs(lat) * SLIDE_DRAG * DT);

  if (surf.drag) fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), surf.drag * DT);

  // The tow and the turbo, and they do the same thing: raise the ceiling and
  // push a little harder towards it. Raising the ceiling alone would take a
  // straight to get anything out of, which is not what either is for.
  if (car.boost > 0) car.boost--;
  const extra = SLIP_MAX * car.slip + (car.boost > 0 ? BOOST_POWER : 0);
  const cap = TOP_SPEED * surf.top * track.handling.top * (1 + extra);
  if (extra > 0 && accel && !brake) fwd += ACCEL * extra * 1.6 * DT;
  if (fwd > cap) fwd = cap;
  if (fwd < -REVERSE_SPEED) fwd = -REVERSE_SPEED;

  // --- 4. put it back together ----------------------------------------------
  car.vx = cs * fwd - sn * lat;
  car.vy = sn * fwd + cs * lat;
  car.x += car.vx * DT;
  car.y += car.vy * DT;

  car.slide = lat;
  car.throttle = accel ? 1 : 0;
  car.braking = brake;
  car.prevMask = mask;

  if (!wasSliding && Math.abs(lat) > SLIDE_MARK) {
    state.events.push({ type: 'skid', seat: car.index, hard: Math.abs(lat) });
  }
}

/**
 * The tow, for everybody at once.
 *
 * You are in somebody's wake if they are in front of you, close, and near enough
 * to your line. `car.slip` comes out between 0 and 1 - deepest right behind
 * them, fading to nothing at the edges - and drive() turns it into speed.
 *
 * Measured from your own nose rather than from the road, so it works round a
 * corner as well as down a straight, and it does not care who is leading: the
 * CPU gets exactly the same tow you do. That is the point of having it.
 */
function tow(state) {
  for (const car of state.cars) {
    car.slip = 0;
    if (car.mode !== 'run') continue;
    const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (speed < SLIP_MIN_SPEED) continue;
    const cs = Math.cos(car.angle);
    const sn = Math.sin(car.angle);

    for (const other of state.cars) {
      if (other === car || other.mode !== 'run') continue;
      const dx = other.x - car.x;
      const dy = other.y - car.y;
      // In front of me, and how far off to one side.
      const ahead = dx * cs + dy * sn;
      const across = Math.abs(-dx * sn + dy * cs);
      if (ahead <= CAR_R || ahead > SLIP_RANGE || across > SLIP_WIDTH) continue;
      // And going roughly the same way: a car coming the other way is pushing
      // air at you, not out of your way.
      if (Math.cos(other.angle - car.angle) < 0.6) continue;

      const near = 1 - (ahead - CAR_R) / (SLIP_RANGE - CAR_R);
      const line = 1 - across / SLIP_WIDTH;
      const pull = near * line;
      if (pull > car.slip) car.slip = pull;
    }
  }
}

/**
 * The turbos on the road: dropped, taken, and gone again.
 *
 * Dropped a little way up the road from the last car still running, and only
 * when the leader is far enough past that spot to be nowhere near it. Then given
 * about four seconds to live. Nothing here refuses the leader a turbo; it simply
 * puts them where the leader is not, and takes them away before the leader could
 * get back round to one.
 */
function turbo(state) {
  if (state.phase !== 'race') return;
  const running = state.cars.filter((c) => c.mode === 'run' && !c.finished);

  for (let i = state.boosts.length - 1; i >= 0; i--) {
    const boost = state.boosts[i];
    boost.life--;
    let taken = null;
    for (const car of running) {
      if (Math.hypot(car.x - boost.x, car.y - boost.y) < BOOST_R + CAR_R) {
        taken = car;
        break;
      }
    }
    if (taken) {
      taken.boost = BOOST_TICKS;
      state.events.push({ type: 'boost', seat: taken.index, x: boost.x, y: boost.y });
      state.boosts.splice(i, 1);
    } else if (boost.life <= 0) {
      state.events.push({ type: 'boostgone', x: boost.x, y: boost.y });
      state.boosts.splice(i, 1);
    }
  }

  if (state.tick % BOOST_EVERY !== 0 || state.boosts.length >= BOOST_MAX) return;
  if (running.length < 2) return;

  // Dropped up the road from one of the cars that is not leading, picked at
  // random from them, and only if the leader is already past that spot.
  //
  // Tied to the last car instead, which is where this started, they only ever
  // landed in front of whoever was fourth - so the car in second, the one who
  // could actually still do something about the race, never saw one. Every car
  // behind the leader now gets a turn, and the further back you are the more of
  // them you meet, because the ones dropped for the cars ahead of you are still
  // lying there when you arrive.
  const front = Math.max(...state.cars.map((c) => c.progress));
  const chasing = running.filter((c) => c.progress < front);
  if (!chasing.length) return;
  const forCar = chasing[Math.min(chasing.length - 1, Math.floor(nextRandom(state) * chasing.length))];
  const at = forCar.progress + BOOST_AHEAD;
  if (front - at < BOOST_MIN_GAP) return; // the leader would be right on top of it

  const { path } = state.track;
  const on = pointAt(path, at);
  // Somewhere across the road, so they are worth steering for rather than
  // collected by driving in a straight line.
  const off = (nextRandom(state) * 2 - 1) * state.track.width * 0.55;
  state.boosts.push({
    x: on.x - on.ty * off,
    y: on.y + on.tx * off,
    life: BOOST_LIFE,
    born: state.tick,
  });
  state.events.push({ type: 'boostdrop', x: on.x - on.ty * off, y: on.y + on.tx * off });
}

/**
 * Where the car has got to: the road under it, the lap it is on, and whether it
 * is still in the race at all.
 */
function locate(state, car) {
  const { track } = state;
  const { path } = track;
  if (car.mode !== 'run') return;

  const near = nearest(path, car.x, car.y, car.node);

  // Laps, wrap-safely. The two `along` values are a few pixels apart, so the
  // short way round between them says which side of the line the car has just
  // come from - a plain comparison would fire on every stationary wobble.
  const delta = gapAround(path.total, car.along, near.along);
  if (delta > 0 && near.along < car.along) crossLine(state, car, 1);
  else if (delta < 0 && near.along > car.along) crossLine(state, car, -1);

  car.node = near.node;
  car.along = near.along;
  car.side = near.side;
  car.progress = car.lap * path.total + car.along;

  surfaceUnder(state, car, near);
  if (car.mode !== 'run') return;

  props(state, car);

  // Left behind. Measured along the road rather than across the screen, because
  // the screen is not the same size on two machines and this is a rule of the
  // game - see DROP_GAP.
  if (state.phase === 'race' && !car.finished) {
    const front = leader(state);
    if (front !== car && front.progress - car.progress > DROP_GAP) drop(state, car);
  }
}

/** The surface, the pockets, and the edge of the table. */
function surfaceUnder(state, car, near) {
  const { track } = state;

  for (const pit of track.pits || []) {
    const d = Math.hypot(car.x - pit.x, car.y - pit.y);
    if (d < pit.r) {
      fall(state, car, 'pocket');
      return;
    }
  }

  const limit = track.width + track.shoulder;
  if (near.dist > limit) {
    if (track.edge === 'wall') {
      bounceOffWall(state, car, near, limit);
      car.surface = 'rough';
      return;
    }
    fall(state, car, 'edge');
    return;
  }

  let key = near.dist <= track.width ? 'road' : 'rough';
  // A spill sits on top of whatever is under it; it never makes road out of
  // nothing, which is what checking it last rather than first buys.
  for (const patch of track.patches || []) {
    if (Math.hypot(car.x - patch.x, car.y - patch.y) < patch.r) key = patch.surface;
  }
  if (key !== car.surface) {
    state.events.push({ type: 'surface', seat: car.index, from: car.surface, to: key });
  }
  car.surface = key;
}

function bounceOffWall(state, car, near, limit) {
  const dx = car.x - near.x;
  const dy = car.y - near.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = dx / d;
  const ny = dy / d;
  car.x = near.x + nx * limit;
  car.y = near.y + ny * limit;
  const into = car.vx * nx + car.vy * ny;
  if (into > 0) {
    car.vx -= into * nx * (1 + WALL_BOUNCE);
    car.vy -= into * ny * (1 + WALL_BOUNCE);
    // Said apart from a prop, because a rail and a snooker ball are not the same
    // noise and, more usefully, because you cannot tune what you cannot count.
    if (into > 60) state.events.push({ type: 'wall', seat: car.index, hard: into, what: 'edge' });
  }
}

/** The solid things on the table: mugs, stones, a pot of jam. */
function props(state, car) {
  for (const prop of state.track.props || []) {
    const dx = car.x - prop.x;
    const dy = car.y - prop.y;
    const d = Math.hypot(dx, dy);
    const min = prop.r + CAR_R;
    if (d >= min || d === 0) continue;
    const nx = dx / d;
    const ny = dy / d;
    car.x = prop.x + nx * min;
    car.y = prop.y + ny * min;
    const into = car.vx * nx + car.vy * ny;
    if (into < 0) {
      car.vx -= into * nx * (1 + WALL_BOUNCE);
      car.vy -= into * ny * (1 + WALL_BOUNCE);
      state.events.push({
        type: 'wall', seat: car.index, hard: -into, what: 'prop', kind: prop.kind,
      });
    }
  }
}

/**
 * Cars into cars.
 *
 * Elastic and generous: bumping somebody off the road is half of what this game
 * is for, and a shove that only nudges is not worth attempting. BUMP_MIN is
 * there so two cars that have come to rest against each other still separate -
 * without it a pair can wedge and sit there for the rest of the race.
 */
function bumps(state) {
  const cars = state.cars;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      if (a.mode !== 'run' || b.mode !== 'run') continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      const min = CAR_R * 2;
      if (d >= min) continue;
      if (d === 0) {
        dx = 1;
        dy = 0;
        d = 1;
      }
      const nx = dx / d;
      const ny = dy / d;
      const push = (min - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;

      const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      const kick = Math.max(BUMP_MIN, -closing * BUMP_PUSH) / 2;
      if (closing < 0) {
        a.vx -= nx * kick;
        a.vy -= ny * kick;
        b.vx += nx * kick;
        b.vy += ny * kick;
        state.events.push({ type: 'bump', seat: a.index, other: b.index, hard: -closing });
      }
    }
  }
}

function crossLine(state, car, way) {
  const path = state.track.path;
  if (way < 0) {
    // Round the wrong way. It happens after a spin, and it must not hand out a
    // free lap on the way back - and the lap it happened on is not a record.
    if (car.lap > 0) car.lap--;
    car.clean = false;
    return;
  }

  car.lap++;
  if (car.lap > 1) {
    const ticks = state.tick - car.lapStart;
    const clean = car.clean && ticks > TICK_RATE; // a "lap" of half a second is a glitch
    car.laps.push({ ticks, clean });
    let personal = false;
    let overall = false;
    if (clean) {
      if (car.best === null || ticks < car.best) {
        car.best = ticks;
        personal = true;
      }
      if (state.best === null || ticks < state.best.ticks) {
        state.best = { seat: car.index, ticks };
        overall = true;
      }
    }
    state.events.push({
      type: 'lap', seat: car.index, lap: car.lap - 1, ticks, clean, personal, overall,
    });
  }
  car.lapStart = state.tick;
  car.clean = true;
  car.progress = car.lap * path.total + car.along;

  if (car.lap > state.config.laps) finish(state, car);
}

function finish(state, car) {
  car.finished = true;
  state.order.push(car.index);
  car.place = state.order.length;
  state.events.push({ type: 'finish', seat: car.index, place: car.place });
  if (state.order.length === 1) {
    state.phase = 'finish';
    state.phaseTimer = FINISH_TICKS;
    state.message = `${car.name} WINS`;
  }
}

/**
 * The race is over, and everybody still out there is classified where they were.
 *
 * Somebody has to be fourth, and making three cars drive a whole extra lap so a
 * scoreboard can be filled in is how a two-minute game becomes a five-minute
 * one.
 */
function endRace(state) {
  const rest = state.cars.filter((c) => !c.finished).sort((a, b) => b.progress - a.progress);
  for (const car of rest) {
    car.finished = true;
    state.order.push(car.index);
    car.place = state.order.length;
  }
  state.phase = 'over';
  state.events.push({ type: 'race', order: [...state.order] });
}

/** Off the table, into a pocket, or over the edge of the desk. */
function fall(state, car, why) {
  if (car.mode !== 'run') return;
  car.mode = 'falling';
  car.timer = FALL_TICKS;
  car.fell = 0;
  car.clean = false;
  state.events.push({ type: 'fall', seat: car.index, why });
}

/** A screen behind, and scooped up off the table by the hand of God. */
function drop(state, car) {
  if (car.mode !== 'run') return;
  car.mode = 'falling';
  car.timer = DROP_TICKS + FALL_ANIM;
  car.fell = 0;
  car.clean = false;
  car.drops++;
  state.events.push({ type: 'drop', seat: car.index });
}

/**
 * Put back on the road, just behind the last car still running.
 *
 * Behind the pack rather than where it went off, which is the difference between
 * a mistake costing you a place and a mistake costing you the race. It is also
 * the only thing standing between the CPU and a car sitting in a flower bed for
 * two minutes.
 */
function rejoin(state, car, why) {
  const { path } = state.track;
  // Only cars that are actually driving. One that is falling has its progress
  // frozen where it went off, and lining up behind a car that is not there is
  // how you end up in a flower bed.
  const running = state.cars.filter((c) => c !== car && !c.finished && c.mode === 'run');
  const others = running.length ? running : state.cars.filter((c) => c !== car);
  const back = Math.min(...others.map((c) => c.progress)) - REJOIN_BACK;

  // Never further behind the leader than this, whoever is last.
  //
  // Without the floor the rule eats itself. The last car on the road is allowed
  // to be a whole DROP_GAP behind; drop you REJOIN_BACK behind *that* and you
  // are put back outside the limit, so you are scooped up again on the next
  // tick, and again, and again. Measured before this was here: at a high input
  // delay one car was picked up seven times in forty-five seconds and never
  // completed a single lap.
  const floorAt = Math.max(...state.cars.map((c) => c.progress)) - DROP_GAP * REJOIN_ROOM;
  const target = Math.max(0, back, floorAt);

  const lap = Math.max(0, Math.floor(target / path.total));
  const at = pointAt(path, target);
  car.x = at.x;
  car.y = at.y;
  car.angle = Math.atan2(at.ty, at.tx);
  car.vx = 0;
  car.vy = 0;
  car.slide = 0;
  car.steer = 0;
  car.node = at.node;
  car.along = at.along;
  car.side = 0;
  car.lap = lap;
  car.progress = lap * path.total + at.along;
  car.surface = 'road';
  car.boost = 0; // whatever you had, you dropped it over the edge
  car.clean = false;
  // The clock starts again from here. The lap can never be a record now - that
  // is what `clean` is for - but the running time on screen is the one number
  // the player is watching, and carrying the time from before the accident into
  // it would show a lap of a minute and a half for the rest of the race.
  car.lapStart = state.tick;
  car.fell = 0;
  car.mode = 'waiting';
  car.timer = why === 'fell' ? 24 : 12;
  car.thinkAt = -99;
  state.events.push({ type: 'rejoin', seat: car.index, why });
}
