/**
 * The racing line, as geometry.
 *
 * A track is a handful of control points; everything else in the game is worked
 * out from the smooth loop that runs through them. Where the road is, how far
 * off it you are, which way it goes next, who is in front, where to put a car
 * that has fallen off the table, and what the CPU should be steering at - all of
 * it is "how far along the loop am I, and how far to one side".
 *
 * That is why there is no tile map here. A grid would give the surface cheaply
 * and nothing else: laps, positions and the whole idea of being a screen behind
 * would each need their own answer. One curve gives all of them, and it is the
 * same curve on every machine, which the netcode needs it to be.
 *
 * Nothing in this file is random and nothing reads the clock.
 */

/** How many straight pieces each stretch between two control points becomes. */
const SAMPLES = 16;

/**
 * A closed Catmull-Rom loop through `points`, flattened into a polyline with a
 * running total of its own length.
 *
 * Catmull-Rom because it passes *through* its control points: a track is drawn
 * by saying where the corners are, and a curve that merely leans towards them
 * would mean tuning a corner by moving a point that is not on it.
 */
export function buildPath(points, samples = SAMPLES) {
  const n = points.length;
  const xs = [];
  const ys = [];

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      // The standard uniform form, halved: at t=0 it is exactly p1.
      xs.push(0.5 * ((2 * p1[0])
        + (-p0[0] + p2[0]) * t
        + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
        + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3));
      ys.push(0.5 * ((2 * p1[1])
        + (-p0[1] + p2[1]) * t
        + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
        + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3));
    }
  }

  const count = xs.length;
  const x = Float64Array.from(xs);
  const y = Float64Array.from(ys);
  // Cumulative length at the start of each piece, plus the whole loop at the end.
  const along = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    along[i + 1] = along[i] + Math.sqrt((x[j] - x[i]) ** 2 + (y[j] - y[i]) ** 2);
  }

  return { x, y, along, count, total: along[count] };
}

/**
 * The closest point on the loop to (px, py).
 *
 * `hint` is the piece the car was on last tick. Searching outwards from there
 * rather than over the whole loop is not about speed - the loop is only a few
 * hundred pieces - it is about being right. A track that doubles back past
 * itself has two closest points and only one of them is the one you are driving
 * on; without a hint a car taking a hairpin tight would be credited with the
 * road on the other side of it and appear to complete the lap backwards.
 *
 * A car that is genuinely lost (thrown a long way, or just put back on) has no
 * useful hint, and a full sweep is the honest answer. Pass -1 for that.
 */
export function nearest(path, px, py, hint = -1, window = 90) {
  const { x, y, count } = path;
  let from = 0;
  let to = count;
  if (hint >= 0) {
    from = hint - window;
    to = hint + window;
  }

  let bestD = Infinity;
  let bestI = 0;
  let bestT = 0;

  for (let k = from; k < to; k++) {
    const i = ((k % count) + count) % count;
    const j = (i + 1) % count;
    const ax = x[i];
    const ay = y[i];
    const bx = x[j] - ax;
    const by = y[j] - ay;
    const l2 = bx * bx + by * by;
    let t = l2 > 0 ? ((px - ax) * bx + (py - ay) * by) / l2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const dx = px - (ax + bx * t);
    const dy = py - (ay + by * t);
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      bestI = i;
      bestT = t;
    }
  }

  return describe(path, bestI, bestT, px, py, Math.sqrt(bestD));
}

/** Fills in everything the rest of the game asks about a point on the loop. */
function describe(path, i, t, px, py, dist) {
  const { x, y, along, count } = path;
  const j = (i + 1) % count;
  const cx = x[i] + (x[j] - x[i]) * t;
  const cy = y[i] + (y[j] - y[i]) * t;
  let tx = x[j] - x[i];
  let ty = y[j] - y[i];
  const l = Math.sqrt(tx * tx + ty * ty) || 1;
  tx /= l;
  ty /= l;
  // Which side of the road you are on: positive is to the left of the direction
  // of travel. Signed, because the CPU steers back by it and a magnitude cannot
  // say which way.
  const side = (px - cx) * -ty + (py - cy) * tx;
  return {
    node: i,
    t,
    x: cx,
    y: cy,
    tx,
    ty,
    dist,
    side,
    along: along[i] + l * t,
  };
}

/** A point on the loop by distance travelled, wrapping as often as it needs to. */
export function pointAt(path, distance) {
  const { along, count, total } = path;
  let d = distance % total;
  if (d < 0) d += total;
  // Binary search: the running total is sorted, and a linear walk here is the
  // one place this file could get slow, because the CPU asks for several points
  // up the road on every car on every tick.
  let lo = 0;
  let hi = count;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (along[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = along[lo + 1] - along[lo];
  const t = seg > 0 ? (d - along[lo]) / seg : 0;
  return describe(path, lo, t, 0, 0, 0);
}

/**
 * How tight the loop is `ahead` pixels from here, as a number between 0 (dead
 * straight) and 1 (a hairpin).
 *
 * This is what the CPU brakes for, and what the game uses to decide a corner is
 * a corner. Worked out from the angle between the direction of travel now and
 * the direction of travel there, rather than from a curvature, because the
 * question is not how sharp the bend is at one point - it is how much the road
 * has turned by the time you get out of it.
 */
export function bendAhead(path, from, ahead) {
  const a = pointAt(path, from);
  const b = pointAt(path, from + ahead);
  const dot = a.tx * b.tx + a.ty * b.ty;
  return (1 - Math.max(-1, Math.min(1, dot))) / 2;
}

/**
 * The gap from `a` to `b` around a loop, signed and always the short way.
 *
 * Positive means b is ahead. Needed everywhere a race position is worked out,
 * because two cars either side of the start line are next to each other and a
 * plain subtraction says they are a whole lap apart.
 */
export function gapAround(total, a, b) {
  let d = (b - a) % total;
  if (d > total / 2) d -= total;
  if (d < -total / 2) d += total;
  return d;
}
