/**
 * The CPU drivers.
 *
 * They produce a button mask, exactly like a keyboard does, and the simulation
 * cannot tell the difference. That is worth more than it sounds: there is one
 * driving model rather than two, so a car that understeers understeers for
 * everybody, and a headless test can fill all four seats and run a whole race in
 * a few milliseconds.
 *
 * A driver here does two things, which is roughly what a driver does. It looks a
 * fixed distance up the road and steers at what it finds. And it looks a little
 * further than that, sees how much the road has turned by then, and decides
 * whether it can still be doing this speed when it arrives.
 */

import {
  BOOST_POWER, BOOST_R, BTN, CAR_R, NUDGE_RANGE, SLIP_MAX, TOP_SPEED, TURN_STALL,
} from '../constants.js';
import { bendAhead, pointAt } from './path.js';
import { nextRandom } from '../util.js';

/** How long a driver holds a line before choosing another one, in ticks. */
const DRIFT_EVERY = 40;
/**
 * How far up the road it starts moving over for something lying in it, and how
 * hard it leans away.
 *
 * Swept over both, twenty-four races each: the force is what matters and the
 * distance barely moves the needle. At 2.2 the EASY drivers still hit a ball
 * eighty times a race; at 4.5 that is twenty-six, and the HARD drivers twelve.
 * Stronger again just makes them swerve.
 */
const DODGE_LOOK = 200;
const DODGE_FORCE = 4.5;

/** Shortest way round from one heading to another, in radians. */
function wrapAngle(a) {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/**
 * A turbo close enough ahead to be worth going for.
 *
 * Ahead along the road rather than merely nearby, so a driver does not turn
 * round for one it has just gone past, and close enough that the detour costs
 * less than the turbo is worth.
 */
function wanted(state, car) {
  const { path } = state.track;
  let best = null;
  let bestGap = Infinity;
  for (const boost of state.boosts) {
    const d = Math.hypot(boost.x - car.x, boost.y - car.y);
    if (d > 260 || d < BOOST_R) continue;
    const cs = Math.cos(car.angle);
    const sn = Math.sin(car.angle);
    const ahead = (boost.x - car.x) * cs + (boost.y - car.y) * sn;
    if (ahead < 30) continue;
    if (d < bestGap) {
      bestGap = d;
      best = boost;
    }
  }
  void path;
  return best;
}

/**
 * How far to move over for whatever is sitting in the road.
 *
 * The CPU could see a turbo and another car and nothing else, so a snooker ball
 * on the racing line was invisible to it: put four of them out on the pool table
 * and the EASY drivers hit the cushions a hundred and forty times a race,
 * ricocheting off something they never knew was there. An obstacle only the
 * player can see does not make a track harder, it makes the opposition worse.
 *
 * Returns how far to shift the aim sideways, positive being to the driver's
 * left. Sharper the closer the thing is, and nothing at all once it is behind.
 */
function dodge(state, car) {
  const cs = Math.cos(car.angle);
  const sn = Math.sin(car.angle);
  let push = 0;
  for (const prop of state.track.props || []) {
    const dx = prop.x - car.x;
    const dy = prop.y - car.y;
    const ahead = dx * cs + dy * sn;
    if (ahead < 0 || ahead > DODGE_LOOK) continue;
    const across = -dx * sn + dy * cs;
    const clear = prop.r + CAR_R + 8;
    if (Math.abs(across) > clear) continue;
    // Away from whichever side of the nose it is on, and hardest when it is
    // nearly under the wheels.
    const urgency = 1 - ahead / DODGE_LOOK;
    push -= (clear - Math.abs(across)) * Math.sign(across || 1) * urgency * DODGE_FORCE;
  }
  return push;
}

/**
 * Somebody close enough to lean on: *beside* you, going the same way.
 *
 * Beside, and not in front, and that is the whole difference between squeezing
 * and ramming. Aimed at anything ahead as well, a driver simply drove into the
 * back of whoever it was following and stayed there - four evenly matched cars
 * on the pool table logged 667 contacts in a forty-five second race, which is
 * not a move, it is grinding.
 *
 * And only towards the inside. Leaning on a car that is already on your inside
 * puts you off the road, not them, and a driver that keeps doing that is not
 * aggressive, it is stupid.
 */
function alongside(state, car) {
  const cs = Math.cos(car.angle);
  const sn = Math.sin(car.angle);
  let best = null;
  let bestGap = Infinity;
  for (const other of state.cars) {
    if (other === car || other.mode !== 'run') continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const d = Math.hypot(dx, dy);
    if (d > NUDGE_RANGE || d < 1) continue;
    const ahead = dx * cs + dy * sn;
    const across = -dx * sn + dy * cs;
    if (ahead < -CAR_R || ahead > CAR_R * 3) continue; // behind, or in front: leave them
    if (Math.abs(across) < CAR_R) continue; // directly in line: that is a shunt
    if (Math.cos(other.angle - car.angle) < 0.5) continue; // going the other way
    // Only if they are the one nearer the edge of the road.
    if (Math.abs((car.side || 0) + across) < Math.abs(car.side || 0)) continue;
    if (d < bestGap) {
      bestGap = d;
      best = other;
    }
  }
  return best;
}

export function aiMask(state, car) {
  // Reaction time, and the cheapest lever there is: a driver that re-reads the
  // road every single tick is inhumanly tidy, and one that re-reads it every
  // eighth of a second drives like somebody who is not quite paying attention.
  if (state.tick - car.thinkAt < car.ai.react) return car.want;
  car.thinkAt = state.tick;

  const { track } = state;
  const { path } = track;
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
  const top = TOP_SPEED * track.handling.top * car.ai.speed;
  // What a tow or a turbo is worth to it right now. Without this the driver
  // works out a target speed that knows nothing about either, reaches it on a
  // straight, and brakes - throwing away the turbo it collected two seconds ago.
  // Measured before it was here: the car in second picked up seven turbos a race
  // and never closed a yard with any of them.
  const help = top * (SLIP_MAX * car.slip + (car.boost > 0 ? BOOST_POWER : 0));

  // How far up the road it is reading, stretched with speed: at a crawl you
  // steer at the next few feet, at speed you steer at the corner.
  const look = car.ai.look * (0.55 + 0.9 * Math.min(1, speed / TOP_SPEED));

  // Where on the road it wants to be. Re-picked now and then rather than every
  // tick, so it drifts across the road the way a person does instead of
  // vibrating about the centreline.
  //
  // On the car's own clock, and that is the whole point. This used to hang on a
  // pattern in the global tick - `(tick + seat * 13) % 40 === 0` - which sits
  // below the reaction-time return above, so a driver that only thinks every
  // fourth or eighth tick never landed on the ticks the pattern named. Measured:
  // on EASY not one of the four cars ever changed its line for a whole race, and
  // on NORMAL only one of them did. They picked an offset on the grid and held
  // it to the flag, which is exactly the metronome `wobble` exists to prevent.
  // `driftAt` starts staggered per seat, so they do not all move together.
  if (car.drift === undefined || state.tick - car.driftAt >= DRIFT_EVERY) {
    car.driftAt = state.tick;
    car.drift = (nextRandom(state) * 2 - 1) * car.ai.wobble;
  }

  const aim = pointAt(path, car.along + look);
  let tx = aim.x - aim.ty * car.drift;
  let ty = aim.y + aim.tx * car.drift;

  // A turbo just up the road is worth a small detour. The CPU gets these the
  // same way you do, and one that drove past them while you collected them
  // would look less like an opponent and more like scenery.
  const grab = wanted(state, car);
  if (grab) {
    tx = tx * 0.35 + grab.x * 0.65;
    ty = ty * 0.35 + grab.y * 0.65;
  }

  // Round whatever is lying in the road. Before anything else wants the aim:
  // a turbo is worth a detour and a rival is worth an elbow, but neither is
  // worth driving into a snooker ball for.
  const swerve = dodge(state, car);
  if (swerve !== 0) {
    tx += -Math.sin(car.angle) * swerve;
    ty += Math.cos(car.angle) * swerve;
  }

  // Leaning on whoever is alongside. Wound up with the level, and pointed at
  // whoever happens to be there - the simulation knows which cars are people and
  // deliberately does not look, because a CPU that only ever elbows the human is
  // a CPU you can feel cheating.
  //
  // Not conditional on there being no turbo about, which it used to be. Turbos
  // are on the road often enough that a driver spent most of a race ignoring the
  // car it was wheel to wheel with, and measured on a straight it moved across
  // by two tenths of a pixel in a second. Wanting the turbo and leaning on
  // somebody are both just pulls on the same aim.
  if (car.ai.nudge > 0) {
    const rival = alongside(state, car);
    if (rival) {
      // Aimed through them rather than at them, and harder the closer they are:
      // a squeeze is a place you intend to be, not a car you intend to hit.
      const close = 1 - Math.min(1, Math.hypot(rival.x - car.x, rival.y - car.y) / NUDGE_RANGE);
      const push = car.ai.nudge * close * 1.6;
      tx += (rival.x - car.x) * push;
      ty += (rival.y - car.y) * push;
    }
  }

  const want = Math.atan2(ty - car.y, tx - car.x);
  let diff = wrapAngle(want - car.angle);

  // Facing the wrong way - spun, or just put back on. Reverse out of it rather
  // than sitting there sawing at the wheel, which is what a lookahead alone does
  // when the thing it is looking at is behind the car.
  const backwards = Math.abs(diff) > 2.2;
  let mask = 0;

  if (backwards && speed < TURN_STALL * 2.2) {
    mask |= BTN.DOWN;
    mask |= diff > 0 ? BTN.LEFT : BTN.RIGHT; // steering is inverted in reverse
    car.want = mask;
    return mask;
  }

  const dead = 0.035;
  if (diff > dead) mask |= BTN.RIGHT;
  else if (diff < -dead) mask |= BTN.LEFT;

  // How much the road has turned by the time it gets there, and therefore how
  // fast it can still be going when it does. `slip` is how much of that warning
  // this driver actually acts on - the whole difference between EASY going into
  // the hairpin and HARD going into it.
  const bend = bendAhead(path, car.along + 20, Math.max(90, look * 1.5));
  let target = top * (1 - bend * 0.82 * car.ai.slip);
  // The extra is worth having on a straight and worth nothing in a corner: the
  // tyres do not know you picked anything up, and a driver that carried a turbo
  // into a hairpin would simply arrive at the scenery sooner.
  target += help * Math.max(0, 1 - bend * 2.2);
  // Being a long way off the road is its own reason to slow down: at full speed
  // on the grass it will never get back on.
  if (Math.abs(car.side || 0) > track.width) target *= 0.72;
  if (target < top * 0.22) target = top * 0.22;

  if (speed > target * 1.05) {
    mask |= BTN.DOWN;
    // On the brake the tyres let go, which is a hairpin's best friend and a fast
    // corner's worst. Only lean on it when the corner is genuinely tight.
    if (bend < 0.35) mask &= ~BTN.DOWN;
  } else {
    mask |= BTN.UP;
  }

  // Straightening up out of a slide: if the car is travelling a long way from
  // where it is pointing, back off until it comes back to it.
  if (Math.abs(car.slide) > 90 && bend < 0.2) mask &= ~BTN.UP;

  car.want = mask;
  return mask;
}
