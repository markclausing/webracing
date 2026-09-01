/**
 * Steering assistance, for a thumb.
 *
 * This is an input aid and nothing more. It reads the state and never writes to
 * it, and what comes out the far end is an ordinary button mask - the same one
 * a keyboard produces. That is not a detail: the simulation has to be identical
 * on every machine or the netcode has nothing to stand on, and a lap set on a
 * phone has to be a lap the same car could have driven. So nothing here touches
 * grip, or lock, or how the car turns. It decides which way somebody would have
 * pressed if they had four fingers and a bigger screen.
 *
 * What it works out is one number: how much lock following the road would want,
 * right now, from -1 to 1. touchdrive.js mixes that with what the thumb is
 * asking for.
 */

import { TOP_SPEED } from './constants.js';
import { bendAhead, pointAt } from './game/path.js';

/** How far up the road it reads, at a crawl and at speed. */
const LOOK_NEAR = 95;
const LOOK_FAR = 205;
/**
 * The heading error that deserves full lock.
 *
 * Small, because the aid is meant to hold a line rather than to rescue a spin:
 * at half a radian out you are already sideways and no amount of steering is the
 * answer.
 */
const FULL_LOCK = 0.42;

/** Shortest way round from one heading to another, in radians. */
function wrap(a) {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/**
 * How much lock following the road would want, -1 to 1.
 *
 * The same lookahead the CPU drivers use, without the wobble that makes them
 * human or the lean that makes the hard ones a nuisance. Returns 0 for a car
 * that is not on the road, so being scooped up does not come with a phantom
 * hand on the wheel.
 */
export function roadDemand(state, seat) {
  const car = state?.cars?.[seat];
  if (!car || car.mode !== 'run' || !state.track) return 0;
  const { path } = state.track;
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
  const look = LOOK_NEAR + (LOOK_FAR - LOOK_NEAR) * Math.min(1, speed / TOP_SPEED);
  const aim = pointAt(path, car.along + look);
  const want = Math.atan2(aim.y - car.y, aim.x - car.x);
  const off = wrap(want - car.angle);
  return Math.max(-1, Math.min(1, off / FULL_LOCK));
}

/**
 * Coming off the power for a corner, which is the other half of the aid.
 *
 * The brake in this game takes most of the grip with it - that is the whole
 * trick of the thing, and it is why a stab of it steps the back out. Which makes
 * it completely the wrong control to hand somebody who is struggling. Lifting
 * off costs nothing and slows you down, so that is what this does: it works out
 * how fast the road ahead will actually take, and if you are over it, it lets go
 * of the throttle you are holding.
 *
 * It can only ever slow you down. There is no version of this that makes you
 * quicker than somebody who lifted at the right moment on a keyboard, which is
 * what keeps an aided lap honest on the record board.
 *
 * At the strongest setting it will use the brake as well, and only when the car
 * is pointed more or less where it is going - braking mid-slide is how you spin,
 * and an aid that spun you would be worse than no aid.
 */
const LOOK_AHEAD = 165;
const CORNER_BITE = 0.82;
const SLIDING = 70;

export function easeOff(state, seat, strength) {
  const car = state?.cars?.[seat];
  if (!strength || !car || car.mode !== 'run' || !state.track) return { lift: false, brake: false };
  const { path } = state.track;
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
  const bend = bendAhead(path, car.along + 20, LOOK_AHEAD);
  const takes = TOP_SPEED * state.track.handling.top * (1 - bend * CORNER_BITE);
  const over = speed / Math.max(60, takes);
  // Some help lifts late and only for the worst of it; lots lifts early. The
  // margin on top matters: without it the strongest setting lifted on a straight,
  // because a table with a handling penalty makes the speed the road "takes"
  // fractionally lower than the speed the car will actually reach.
  const lift = over > 1.06 + (1 - strength) * 0.3;
  const brake = strength > 0.7 && over > 1.3 && Math.abs(car.slide) < SLIDING;
  return { lift, brake };
}

/**
 * How much of that gets mixed in.
 *
 * Off is the keyboard's deal: what you press is what the car does. The other two
 * let the road decide *how much* lock while you decide which way - see blend() -
 * and take their foot off for a corner you were going to arrive at too quickly.
 */
export const ASSIST = {
  off: { key: 'off', label: 'Off', strength: 0 },
  some: { key: 'some', label: 'Some', strength: 0.55 },
  lots: { key: 'lots', label: 'Lots', strength: 0.9 },
};

/**
 * The thumb and the road, mixed.
 *
 * You say which way; the road says how much. Ask for a little left where the
 * corner wants a lot and you get a lot; ask for left where the road wants right
 * and your input is pulled back towards nothing rather than turned round for
 * you. That is the whole aid, and it is aimed squarely at the thing that makes a
 * phone hard: judging *how far* to move a thumb you cannot feel.
 *
 * A hand that is not on the wheel gets nothing at all, and that part is not
 * negotiable. The first version helped hardest when you were asking for least,
 * which felt lovely and was an autopilot: measured over 24 races with nobody
 * touching the wheel, it completed 2.9 laps of 3, finished third of four and set
 * a 13.18s lap - quicker than the thumb it was supposed to be helping. Laps like
 * that would have gone on the record board.
 */
export function blend(thumb, road, strength) {
  if (!strength || thumb === 0) return thumb;
  const side = Math.sign(thumb);
  // How much the road wants, if it wants it the way you are asking. Asking the
  // wrong way is worth nothing, so the aid winds you back rather than steering
  // for you.
  const wants = road * side > 0 ? Math.abs(road) : 0;
  const amount = Math.abs(thumb) + strength * (wants - Math.abs(thumb));
  return side * Math.max(0, Math.min(1, amount));
}
