/**
 * The tables.
 *
 * Four of them, and they are the only thing that changes between races. The cars
 * do not: the board at the end is a list of lap times, and a lap time means
 * nothing if the red car was quicker than the blue one before anybody turned a
 * wheel. So variety lives here instead - in how wide the road is, what happens
 * when you leave it, and how much of the surface is trying to throw you off.
 *
 * Each track is a list of control points and a handful of nouns. The smooth loop
 * through the points is built once in path.js and everything else is measured
 * against it; the nouns are for the renderer, which knows how to draw a mug and
 * a pool table pocket and nothing about racing.
 *
 * Everything that is meant to be *in the way* - spills, obstacles, pockets - is
 * placed against the road rather than at a point on the table: `at` is how far
 * round the loop it sits, from 0 to 1, and `off` is how far to one side of the
 * centreline, in pixels. `loadTrack` turns those into coordinates.
 *
 * That is not tidiness. Placed by hand, four of the pool table's six pockets sat
 * out on the baize where no car could ever reach them, both of the breakfast
 * table's obstacles were stranded in the middle of the infield, and the desk's
 * spilled coffee was outside the road and therefore clipped away to nothing -
 * the blurb promised six pockets and the table had two. Against the road, a
 * thing that is supposed to be in the way is in the way, and it stays there when
 * somebody moves a corner.
 *
 * `edge` is the one that changes how a table plays more than any number:
 *
 *   'fall'  the road is on a tabletop, and beyond the shoulder there is carpet
 *           a long way down. Running wide is the end of your lap.
 *   'wall'  something solid runs along the outside - cushions, books - and you
 *           bounce off it. Faster and far more forgiving.
 */

import { buildPath, pointAt } from './path.js';

/**
 * Handling per table, applied to every car equally.
 *
 * `grip` scales the tyres, `top` the speed and `accel` how hard it pulls. A
 * kitchen table is polished wood and a garden is not, and the difference should
 * be in the driving rather than only in the colours.
 */
const STOCK = { grip: 1, top: 1, accel: 1 };

export const TRACKS = [
  {
    key: 'breakfast',
    name: 'THE BREAKFAST TABLE',
    blurb: 'Polished wood, a spill of milk on the fast left-hander, and a long '
      + 'way down on both sides.',
    edge: 'fall',
    width: 46,
    shoulder: 26,
    handling: { ...STOCK, grip: 0.96 },
    world: { w: 2060, h: 1300 },
    start: { back: 40 },
    theme: {
      floor: '#1d130d',
      table: '#a9713c',
      grain: '#8d5c2c',
      road: '#d8b088',
      shoulder: '#7c4a1f',
      line: '#fbf3e4',
      kerb: '#e8e2d2',
      grainAlpha: 0.55,
    },
    points: [
      [370, 380], [720, 280], [1110, 300], [1450, 390], [1690, 590],
      [1620, 840], [1330, 950], [1010, 890], [830, 720], [650, 880],
      [430, 910], [300, 710], [290, 490],
    ],
    patches: [
      { at: 0.40, off: 8, r: 62, surface: 'slick', look: 'milk' },
      { at: 0.11, off: -28, r: 48, surface: 'rough', look: 'crumbs' },
      { at: 0.70, off: 26, r: 44, surface: 'rough', look: 'crumbs' },
    ],
    props: [
      { kind: 'mug', at: 0.57, off: 36, r: 24 },
      { kind: 'jar', at: 0.86, off: -34, r: 20 },
    ],
    decor: [
      { kind: 'plate', x: 1000, y: 250, r: 120 },
      { kind: 'toast', x: 985, y: 240, a: 0.3 },
      { kind: 'toast', x: 1035, y: 275, a: -0.5 },
      { kind: 'cutlery', x: 1750, y: 1050, a: 0.7 },
      { kind: 'cutlery', x: 1810, y: 1030, a: 0.7 },
      { kind: 'napkin', x: 220, y: 1080, w: 260, h: 200, a: -0.15 },
      { kind: 'plate', x: 1780, y: 240, r: 90 },
      { kind: 'napkin', x: 1600, y: 1180, w: 300, h: 220, a: 0.22 },
      { kind: 'jar', x: 300, y: 140, r: 46 },
      { kind: 'toast', x: 1240, y: 1220, a: 0.9 },
      { kind: 'cutlery', x: 120, y: 620, a: 1.6 },
    ],
  },

  {
    key: 'pool',
    name: 'THE POOL TABLE',
    blurb: 'Cushions all the way round, so you can lean on them. The six pockets '
      + 'are not a metaphor.',
    edge: 'wall',
    width: 50,
    shoulder: 62, // the baize is slow but perfectly drivable
    handling: { ...STOCK, grip: 1.06, top: 0.97 },
    world: { w: 2200, h: 1420 },
    start: { back: 40 },
    theme: {
      floor: '#0e120c',
      table: '#166030',
      grain: '#0f4d26',
      road: '#3aa15e',
      shoulder: '#227a42',
      line: '#eafaee',
      kerb: '#e6cf92',
      grainAlpha: 0.5,
    },
    points: [
      [400, 380], [900, 300], [1400, 310], [1800, 400], [1900, 700],
      [1820, 1030], [1350, 1120], [820, 1100], [420, 1020], [320, 700],
      [330, 500],
    ],
    // The pockets. Set just off the racing line, so they only collect you if you
    // run wide - which is what makes a cushion worth using rather than avoiding.
    // Just outside the white line, alternating sides: on the road you are safe,
    // a wheel over it and you are not. Set at 84 they overlapped the road by ten
    // pixels and swallowed cars that had done nothing wrong.
    pits: [
      { at: 0.05, off: 96, r: 38 }, { at: 0.21, off: -96, r: 38 },
      { at: 0.38, off: 96, r: 38 }, { at: 0.54, off: -96, r: 38 },
      { at: 0.71, off: 96, r: 38 }, { at: 0.87, off: -96, r: 38 },
    ],
    patches: [
      { at: 0.30, off: 0, r: 58, surface: 'rough', look: 'chalk' },
    ],
    props: [
      { kind: 'ball', at: 0.14, off: -66, r: 20 },
      { kind: 'ball', at: 0.46, off: 70, r: 20 },
      { kind: 'ball', at: 0.79, off: -62, r: 20 },
    ],
    decor: [
      { kind: 'cue', x: 1100, y: 700, a: 0.35, w: 900 },
      { kind: 'spot', x: 1110, y: 480, r: 8 },
      { kind: 'spot', x: 1110, y: 940, r: 8 },
    ],
  },

  {
    key: 'garden',
    name: 'THE GARDEN PATH',
    blurb: 'Wet paving between the beds. Mud where the hose has been, and a lawn '
      + 'that will take a second off you every time you touch it.',
    edge: 'fall',
    width: 44,
    shoulder: 40,
    handling: { ...STOCK, grip: 0.9, accel: 0.95 },
    world: { w: 2200, h: 1400 },
    start: { back: 36 },
    theme: {
      floor: '#0b1009',
      table: '#33501f',
      grain: '#294218',
      road: '#a8a296',
      shoulder: '#4a7029',
      line: '#e6e3d9',
      kerb: '#b9b2a0',
      grainAlpha: 0.16,
    },
    points: [
      [330, 740], [430, 450], [700, 320], [990, 400], [1130, 640],
      [1330, 810], [1610, 780], [1830, 570], [1980, 740], [1900, 1030],
      [1600, 1160], [1240, 1140], [900, 1060], [600, 1100], [370, 990],
    ],
    patches: [
      { at: 0.33, off: 0, r: 56, surface: 'sticky', look: 'mud' },
      { at: 0.61, off: 18, r: 52, surface: 'slick', look: 'puddle' },
      { at: 0.89, off: -16, r: 44, surface: 'slick', look: 'puddle' },
    ],
    props: [
      { kind: 'stone', at: 0.24, off: 54, r: 22 },
      { kind: 'stone', at: 0.52, off: -52, r: 20 },
      { kind: 'pot', at: 0.76, off: 56, r: 24 },
    ],
    decor: [
      { kind: 'hose', x: 0, y: 0 },
      { kind: 'flower', x: 300, y: 250, r: 26 },
      { kind: 'flower', x: 1500, y: 300, r: 26 },
      { kind: 'flower', x: 2050, y: 1200, r: 26 },
      { kind: 'flower', x: 760, y: 1300, r: 26 },
      { kind: 'flower', x: 1180, y: 200, r: 22 },
      { kind: 'flower', x: 120, y: 1180, r: 24 },
      { kind: 'stone', x: 900, y: 780, r: 52 },
      { kind: 'stone', x: 1560, y: 520, r: 40 },
      { kind: 'flower', x: 1900, y: 180, r: 28 },
    ],
  },

  {
    key: 'desk',
    name: 'THE DESK',
    blurb: 'Books for barriers and a hairpin round the mug. The tightest of the '
      + 'four, and the one where the brake earns its keep.',
    edge: 'wall',
    width: 40,
    shoulder: 24,
    handling: { ...STOCK, grip: 1.02, top: 0.94, accel: 1.06 },
    world: { w: 1900, h: 1300 },
    start: { back: 36 },
    theme: {
      floor: '#100e13',
      table: '#5b4636',
      grain: '#463527',
      road: '#9c9992',
      shoulder: '#6a5748',
      line: '#f6f1e6',
      kerb: '#d9c98f',
      grainAlpha: 0.32,
    },
    points: [
      [554, 420], [986, 388], [1378, 436], [1578, 604], [1370, 716],
      [1026, 684], [842, 796], [1002, 940], [1418, 964], [1658, 868],
      [1738, 1052], [1338, 1140], [906, 1124], [570, 1028], [442, 780],
      [458, 572],
    ],
    patches: [
      { at: 0.28, off: 6, r: 44, surface: 'slick', look: 'coffee' },
      { at: 0.66, off: -12, r: 48, surface: 'rough', look: 'mousepad' },
    ],
    props: [
      { kind: 'mug', at: 0.49, off: 42, r: 22 },
      { kind: 'eraser', at: 0.84, off: -40, r: 18 },
    ],
    decor: [
      { kind: 'book', x: 1180, y: 180, w: 520, h: 120, a: 0.04 },
      { kind: 'book', x: 340, y: 1330, w: 400, h: 110, a: -0.06 },
      { kind: 'pencil', x: 2080, y: 400, a: 1.35, w: 460 },
      { kind: 'ruler', x: 150, y: 620, a: 1.52, w: 520 },
    ],
  },
];

/**
 * A track with its loop built and its numbers filled in.
 *
 * Cached, because the loop is a few hundred points of trigonometry-free but
 * pointless-to-repeat arithmetic and both the simulation and the renderer ask
 * for it. Same object, same numbers, every time - which the netcode needs.
 */
const built = new Map();

export function trackByKey(key) {
  return TRACKS.find((t) => t.key === key) || TRACKS[0];
}

/**
 * `at` round the loop and `off` to one side, turned into a point on the table.
 *
 * Anything that already carries x and y is left alone, which is what the scenery
 * uses: a plate on the floor beside the road is not measured against the road.
 */
function place(path, items = []) {
  return items.map((item) => {
    if (item.x !== undefined) return item;
    const on = pointAt(path, (item.at || 0) * path.total);
    const off = item.off || 0;
    return { ...item, x: on.x - on.ty * off, y: on.y + on.tx * off };
  });
}

export function loadTrack(key) {
  const found = built.get(key);
  if (found) return found;
  const def = trackByKey(key);
  const path = buildPath(def.points);
  const track = {
    ...def,
    path,
    patches: place(path, def.patches),
    props: place(path, def.props),
    pits: place(path, def.pits),
  };
  built.set(track.key, track);
  return track;
}

export const TRACK_KEYS = TRACKS.map((t) => t.key);
