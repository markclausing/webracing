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
  BTN, TOP_SPEED, TURN_STALL,
} from '../constants.js';
import { bendAhead, pointAt } from './path.js';
import { nextRandom } from '../util.js';

/** Shortest way round from one heading to another, in radians. */
function wrapAngle(a) {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
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

  // How far up the road it is reading, stretched with speed: at a crawl you
  // steer at the next few feet, at speed you steer at the corner.
  const look = car.ai.look * (0.55 + 0.9 * Math.min(1, speed / TOP_SPEED));

  // Where on the road it wants to be. Re-picked now and then rather than every
  // tick, so it drifts across the road the way a person does instead of
  // vibrating about the centreline.
  // Staggered by seat, or four identical drivers re-pick their line on the same
  // tick and the field runs round nose to tail in grid order for three laps.
  if ((state.tick + car.index * 13) % 40 === 0 || car.drift === undefined) {
    car.drift = (nextRandom(state) * 2 - 1) * car.ai.wobble;
  }

  const aim = pointAt(path, car.along + look);
  const tx = aim.x - aim.ty * car.drift;
  const ty = aim.y + aim.tx * car.drift;

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
