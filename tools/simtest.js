// Headless: races whole races with no browser, and checks the rules.
//
//   node tools/simtest.js
//
// Three things matter here. That the simulation is deterministic, because the
// online game depends on it. That the geometry every rule is measured against -
// the loop through each table - is sane, because a track whose corners cross
// over each other would give one car a lap and another car a nervous breakdown.
// And that the lap record board only ever accepts a clean lap, because a board
// full of laps set by cutting the corner is a board nobody will race against.

import { createRace, formatLap, hashState, lapMs } from '../src/game/state.js';
import { step } from '../src/game/sim.js';
import { TRACKS, loadTrack } from '../src/game/tracks.js';
import { bendAhead, gapAround, nearest, pointAt } from '../src/game/path.js';
import { BTN, DROP_GAP, TICK_RATE } from '../src/constants.js';
import {
  Highscores, cleanEntry, merge, placeOf, qualifies, sortTable,
} from '../src/highscores.js';
import * as commentary from '../src/commentary.js';
import { phrase } from '../src/speech.js';
import { neighbours, compare } from './sync-shared.js';

let failed = false;
function check(ok, message) {
  if (ok) {
    console.log(`OK: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failed = true;
  }
}

const MAX = TICK_RATE * 400; // no race here should take seven minutes

function race(options = {}) {
  const state = createRace({
    seed: 7, humans: [false, false, false, false], difficulty: 'hard', ...options,
  });
  const seen = {};
  const inputs = options.inputs || [0, 0, 0, 0];
  let guard = 0;
  while (state.phase !== 'over' && guard++ < MAX) {
    step(state, inputs);
    for (const e of state.events) seen[e.type] = (seen[e.type] || 0) + 1;
    for (const car of state.cars) {
      if (!Number.isFinite(car.x) || !Number.isFinite(car.y)) {
        throw new Error(`${car.name} went NaN on tick ${state.tick}`);
      }
    }
  }
  return { state, seen };
}

// --- The tables --------------------------------------------------------------

console.log('Tables:');
for (const def of TRACKS) {
  const track = loadTrack(def.key);
  const { path } = track;

  // Every piece of the loop should be about the same length as its neighbours.
  // A spline through badly spaced control points bunches up, and where it
  // bunches, `nearest` starts preferring the wrong side of a hairpin.
  let shortest = Infinity;
  let longest = 0;
  for (let i = 0; i < path.count; i++) {
    const d = path.along[i + 1] - path.along[i];
    if (d < shortest) shortest = d;
    if (d > longest) longest = d;
  }

  // And no two parts of the road may come close enough to touch. If they do, a
  // car on one of them is inside the other and its lap counter is a coin toss.
  let closest = Infinity;
  const gate = track.width * 2 + 20;
  for (let i = 0; i < path.count; i += 2) {
    for (let j = i + 1; j < path.count; j += 2) {
      const apart = Math.abs(gapAround(path.total, path.along[i], path.along[j]));
      if (apart < gate * 1.6) continue; // neighbours along the road, not a crossing
      const d = Math.hypot(path.x[i] - path.x[j], path.y[i] - path.y[j]);
      if (d < closest) closest = d;
    }
  }

  console.log(`  ${def.key.padEnd(10)} ${Math.round(path.total)}px in ${path.count} pieces, `
    + `${shortest.toFixed(1)}-${longest.toFixed(1)}px each, `
    + `road never closer to itself than ${Math.round(closest)}px`);
  check(longest / shortest < 6, `${def.key}: the loop is evenly spaced enough to search`);
  check(closest > gate, `${def.key}: the road never runs into itself`);
  check(path.total > 2500 && path.total < 8000, `${def.key}: a lap is a sensible length`);
}
console.log('');

// --- Whole races -------------------------------------------------------------

console.log('Races (four HARD cars, three laps):');
for (const def of TRACKS) {
  const { state } = race({ track: def.key });
  const seconds = state.tick / TICK_RATE;
  const best = state.best ? formatLap(lapMs(state.best.ticks)) : 'none';
  console.log(`  ${def.key.padEnd(10)} ${seconds.toFixed(1)}s, finishing order `
    + `${state.order.map((i) => state.cars[i].name[0]).join('')}, fastest lap ${best}`);
  check(state.phase === 'over', `${def.key}: the race reaches a finish`);
  check(state.order.length === state.cars.length, `${def.key}: everybody is classified`);
  check(state.best !== null, `${def.key}: somebody turns a clean lap`);
  check(state.cars.every((c) => c.lap === state.config.laps + 1
    || c.progress > 0), `${def.key}: every car made progress`);
}
console.log('');

// --- Determinism -------------------------------------------------------------

const a = race({ track: 'garden', seed: 99 });
const b = race({ track: 'garden', seed: 99 });
check(hashState(a.state) === hashState(b.state),
  `the same race twice is the same race (hash ${hashState(a.state)})`);
const c = race({ track: 'garden', seed: 100 });
check(hashState(c.state) !== hashState(a.state), 'a different seed is a different race');

// --- Falling off, and being scooped up ---------------------------------------
//
// A player who does nothing at all must not be able to stop the race. This is
// the single most likely way for a four-player game to hang: three cars finish,
// one sits on the grid, and the leader is a lap and a half up the road.

for (const def of TRACKS) {
  const { state, seen } = race({
    track: def.key, humans: [true, false, false, false], difficulty: 'normal',
  });
  check(state.phase === 'over', `${def.key}: an idle player does not hang the race`);
  check(seen.drop > 0, `${def.key}: an idle player is scooped up (${seen.drop || 0} times)`);
  check(state.cars[0].place === 4, `${def.key}: and finishes last`);
  check(state.cars[0].best === null, `${def.key}: and sets no lap record`);
}

// Flat out into the scenery: on a table you fall off it, behind a rail you
// bounce off it, and either way the race goes on.
{
  const fell = race({ track: 'breakfast', humans: [true, false, false, false], inputs: [BTN.UP, 0, 0, 0] });
  const bounced = race({ track: 'pool', humans: [true, false, false, false], inputs: [BTN.UP, 0, 0, 0] });
  check(fell.seen.fall > 0, `flat out on a tabletop goes over the edge (${fell.seen.fall} times)`);
  check(bounced.seen.wall > 0, `flat out on a pool table hits the cushions (${bounced.seen.wall} times)`);
  check(fell.state.phase === 'over' && bounced.state.phase === 'over',
    'and both races still finish');
}

// The gap that decides it is measured on the road, not on the screen - and it
// is only a rule while the race is on. Once somebody has won, scooping up the
// stragglers would be tidying for its own sake, so the field is allowed to
// spread out over the slowing-down lap.
{
  const state = createRace({
    seed: 7, track: 'desk', humans: [true, false, false, false], difficulty: 'normal',
  });
  let worst = 0;
  let guard = 0;
  while (state.phase !== 'over' && guard++ < MAX) {
    step(state, [0, 0, 0, 0]);
    if (state.phase !== 'race') continue;
    // Only the cars actually driving. One that is falling has its progress
    // frozen for the second or so the animation takes, and the leader carries on
    // through it, so a car on its way off the table is legitimately further
    // behind than the rule ever allowed a car on the road to be.
    const running = state.cars.filter((car) => car.mode === 'run').map((car) => car.progress);
    if (running.length < 2) continue;
    const spread = Math.max(...running) - Math.min(...running);
    if (spread > worst) worst = spread;
  }
  check(worst < DROP_GAP * 1.1,
    `nobody still driving is further behind than the rule allows (worst ${Math.round(worst)}px `
    + `against a limit of ${DROP_GAP})`);
}

// Being put back on the road has to put you inside the rule, not on the edge of
// it. This is a regression test for a real one: the last car on the road is
// allowed to be a whole DROP_GAP behind, and dropping somebody REJOIN_BACK
// behind *that* put them outside the limit, so they were scooped up again on the
// next tick and never completed a lap.
{
  const state = createRace({
    seed: 3, track: 'garden', humans: [false, false, false, false], difficulty: 'hard', laps: 5,
  });
  let guard = 0;
  let worst = 0;
  let rejoins = 0;
  while (state.phase !== 'over' && guard++ < MAX) {
    step(state, [0, 0, 0, 0]);
    // Hold one car still every so often, so it has to be fished out repeatedly.
    if (state.tick % 400 < 260) {
      state.cars[3].vx = 0;
      state.cars[3].vy = 0;
    }
    for (const e of state.events) {
      if (e.type !== 'rejoin') continue;
      rejoins++;
      const car = state.cars[e.seat];
      const front = Math.max(...state.cars.map((c) => c.progress));
      const gap = front - car.progress;
      if (gap > worst) worst = gap;
    }
  }
  check(rejoins > 3, `a car that keeps stopping keeps being fished out (${rejoins} times)`);
  check(worst < DROP_GAP,
    `and is always put back inside the rule (worst ${Math.round(worst)}px of ${DROP_GAP})`);
  check(state.phase === 'over', 'and the race still reaches a finish');
}

// --- A lap only counts if it was clean ---------------------------------------

{
  // A CPU car, so that once it has been fished out of the pocket it drives the
  // rest of the lap by itself. Scripting a human round a pool table from here
  // would be testing the script.
  const state = createRace({
    seed: 5, track: 'pool', humans: [false, false, false, false], laps: 5,
  });
  const car = state.cars[0];
  let guard = 0;
  while (car.laps.length < 1 && guard++ < MAX) step(state, [0, 0, 0, 0]);
  check(car.laps[0].clean === true, 'an untroubled lap is filed as clean');
  check(car.best !== null, 'and becomes the personal best');

  const pocket = state.track.pits[0];
  car.x = pocket.x;
  car.y = pocket.y;
  step(state, [0, 0, 0, 0]);
  check(car.mode === 'falling', 'driving into a pocket takes you out of the race');
  check(car.clean === false, 'and the lap you were on stops being a record');

  const was = { laps: car.laps.length, best: car.best };
  while (car.laps.length === was.laps && guard++ < MAX) step(state, [0, 0, 0, 0]);
  check(car.laps[was.laps].clean === false, 'the lap it was on is filed as not clean');
  check(car.best === was.best, 'and cannot become a personal best however quick it looks');
}

// Going round the wrong way takes the lap back rather than handing one out.
{
  const state = createRace({ seed: 5, track: 'breakfast', humans: [true, false, false, false] });
  let guard = 0;
  while (state.cars[0].lap < 1 && guard++ < MAX) step(state, [BTN.UP, 0, 0, 0]);
  const was = state.cars[0].lap;
  // Put it back over the line the way it came - the position and the piece it is
  // on, but not `along`, which is what it is being compared against. Setting that
  // too would be moving the goalposts along with the car.
  const back = pointAt(state.track.path, state.track.path.total - 30);
  state.cars[0].x = back.x;
  state.cars[0].y = back.y;
  state.cars[0].node = back.node;
  step(state, [0, 0, 0, 0]);
  check(state.cars[0].lap === was - 1, 'crossing the line backwards takes the lap back');
  check(state.cars[0].clean === false, 'and voids the lap you were on');
}

// --- The geometry the rules are measured against -----------------------------

{
  const { path } = loadTrack('breakfast');
  const on = pointAt(path, 500);
  const found = nearest(path, on.x, on.y, -1);
  check(found.dist < 1, 'a point on the loop is found on the loop');
  check(Math.abs(gapAround(path.total, 500, found.along)) < 12,
    'and at the distance it was asked for');

  const off = nearest(path, on.x - on.ty * 40, on.y + on.tx * 40, -1);
  check(Math.abs(off.dist - 40) < 2, 'a point beside the road is the right distance from it');
  check(off.side > 0, 'and on the side it was put');

  check(bendAhead(path, 0, 4) < 0.01, 'four pixels of road is straight');
  const bends = [];
  for (let d = 0; d < path.total; d += 40) bends.push(bendAhead(path, d, 200));
  check(Math.max(...bends) > 0.25, 'and somewhere on the table there is a real corner');
}

// --- The board ---------------------------------------------------------------

check(cleanEntry({ ms: 13000, name: 'abc' })?.name === 'ABC', 'a name is three capitals');
check(cleanEntry({ ms: 13000, name: 'ab' })?.name === 'AB-', 'and padded when it is short');
check(cleanEntry({ ms: 100 }) === null, 'an impossible lap is refused');
check(cleanEntry({ ms: 60 * 60 * 1000 }) === null, 'and so is an hour-long one');
check(cleanEntry({ ms: 'nonsense' }) === null, 'and so is a lap that is not a number');

const rows = sortTable([
  { id: '1', name: 'AAA', ms: 15000, at: 1 },
  { id: '2', name: 'BBB', ms: 13000, at: 2 },
  { id: '3', name: 'CCC', ms: 13000, at: 1 },
]);
check(rows[0].name === 'CCC' && rows[1].name === 'BBB' && rows[2].name === 'AAA',
  'quickest first, and a dead heat goes to whoever got there first');

const full = Array.from({ length: 10 }, (_, i) => ({
  id: `f${i}`, name: 'ZZZ', ms: 12000 + i, at: 1,
}));
check(qualifies(full, { ms: 11000 }), 'a quicker lap gets on a full board');
check(!qualifies(full, { ms: 99000 }), 'and a slower one does not');
check(placeOf(full, { ms: 11000 }) === 1, 'a new best lap goes to the top');

{
  const mine = { breakfast: [{ id: 'x', name: 'AAA', ms: 14000, at: 1 }] };
  const theirs = { breakfast: [{ id: 'x', name: 'AAA', ms: 14000, at: 1 }] };
  check(merge(mine, theirs).breakfast.length === 1,
    'the same lap from two devices is one row, not two');
  check(merge(mine, { breakfast: [{ id: 'y', name: 'BBB', ms: 13000, at: 2 }] })
    .breakfast.length === 2, 'and two different laps are two');
}

{
  // A board with no browser behind it, which is how the tests and the server
  // both use it.
  const store = new Map();
  const board = new Highscores({
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  });
  board.add('desk', { id: 'a', name: 'ABC', ms: 19000, at: 1 });
  check(board.table('desk').length === 1, 'a lap can be added without a browser');
  check(board.table('pool').length === 0, 'and it does not appear under another table');
  check(new Highscores({ getItem: (k) => store.get(k) ?? null }).table('desk').length === 1,
    'and it is still there when the page is loaded again');
}

// --- The commentator ---------------------------------------------------------
//
// The synthesiser only knows the phonemes it is given, and `phrase()` silently
// drops a word it has not been taught rather than throwing. That is the right
// behaviour at three in the morning in somebody's browser and completely the
// wrong behaviour here: a typo in one line would just mean the man says half a
// sentence and nobody ever finds out which half.

{
  const sentences = [
    ...Object.values(commentary.LINES).flat(),
    ...[0, 1, 2, 3].map((i) => commentary.winCall(i)),
    ...[0, 1, 2, 3].map((i) => commentary.lapCall(i)),
    ...[0, 1, 2, 3].map((i) => commentary.placeCall(i, i + 1)),
  ];
  const unsayable = sentences.filter((line) => line.split(/\s+/)
    .some((word) => !commentary.WORDS[word]));
  check(unsayable.length === 0,
    `all ${sentences.length} lines the commentator can produce are in his vocabulary`
    + (unsayable.length ? ` (cannot say: ${unsayable.join('; ')})` : ''));
  check(phrase(commentary.LINES.fall[0], commentary.WORDS).length > 4,
    'and a line comes out as a run of phonemes rather than nothing');

  // And the other way round: a word nothing can reach is a word somebody meant
  // to use and forgot to.
  const reachable = new Set(sentences.flatMap((line) => line.split(/\s+/)));
  const orphans = Object.keys(commentary.WORDS).filter((w) => !reachable.has(w));
  check(orphans.length === 0,
    `and every word he has been taught is one he can say (${orphans.join(', ') || 'none spare'})`);
}

// --- The shared plumbing -----------------------------------------------------

const found = neighbours();
if (!found.length) {
  console.log('NOTE: no websoccer or webtennis beside this one, so nothing to compare');
} else {
  for (const [name, at] of found) {
    const shared = compare(at);
    if (shared.differs.length || shared.missing.length) {
      console.log(`NOTE: ${shared.differs.length} shared files differ from ${name} `
        + '(run node tools/sync-shared.js)');
    } else {
      console.log(`OK: the ${shared.same.length} files shared with ${name} are identical`);
    }
  }
}

console.log('');
console.log(failed ? 'SUITE FAILED' : 'SUITE PASSED');
process.exit(failed ? 1 : 0);
