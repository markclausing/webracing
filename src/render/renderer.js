/**
 * Drawing. Reads the state, never writes to it.
 *
 * The one real difference from the other two games is that there is a camera.
 * A court fits on a screen and a pitch nearly does; a tabletop circuit does not,
 * and four cars on it can be a long way apart. So the view zooms out to hold
 * whoever is still racing and stops when it has nothing left to give - which is
 * the moment the simulation calls somebody dropped.
 *
 * The camera must never feed back into the simulation. What it can see depends
 * on the size of the window, and the window is not the same size on two
 * machines; a rule that read from it would have two players disagreeing about
 * the result of the same race. It only clamps itself to the same distance the
 * simulation uses, so what you see matches what it decided - see DROP_GAP.
 */

import {
  BOOST_R, CAR_L, CAR_PRESETS, CAR_W, MIN_CAR_ON_SCREEN, SLIDE_MARK, TICK_RATE, VIEW_MAX,
} from '../constants.js';
import { formatLap, lapMs, lapNumber } from '../game/state.js';
import { drawTable, roundRect } from './table.js';

/** How quickly the camera catches up. Low enough to glide, high enough to keep up. */
const FOLLOW = 0.12;
const ZOOM_FOLLOW = 0.07;
/** Room left round the outermost car, in world units. */
const MARGIN = 150;
/** How many skid marks are kept before the oldest are forgotten. */
const MARKS = 520;
/** A turbo starts fading with this much of its life left, in ticks. */
const BOOST_FADE = 60;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tables = new Map();
    this.cam = null;
    this.marks = [];
    this.bottomInset = 0;
    this.shake = 0;
  }

  /** One offscreen canvas per track, painted the first time it is raced. */
  table(track) {
    let found = this.tables.get(track.key);
    if (!found) {
      found = drawTable(track, (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      });
      this.tables.set(track.key, found);
    }
    return found;
  }

  /** Called at the start of a race: the marks on the table are last race's. */
  reset() {
    this.marks.length = 0;
    this.cam = null;
    this.shake = 0;
  }

  // --- The camera ------------------------------------------------------------

  follow(state) {
    const cars = state.cars.filter((c) => c.mode !== 'falling');
    const watch = cars.length ? cars : state.cars;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const car of watch) {
      if (car.x < minX) minX = car.x;
      if (car.x > maxX) maxX = car.x;
      if (car.y < minY) minY = car.y;
      if (car.y > maxY) maxY = car.y;
    }

    const view = this.viewport();
    // How much world has to fit, and the zoom that would just about do it.
    const needW = maxX - minX + MARGIN * 2;
    const needH = maxY - minY + MARGIN * 2;
    let zoom = Math.min(view.w / needW, view.h / needH);

    // How far out it will go: measured against the geometric mean of the window
    // rather than its width, because width alone is only right on a landscape
    // screen - on a phone held upright it forced the view to be as wide as a
    // desktop's and twice as tall as the table.
    const span = Math.sqrt(view.w * view.h);
    const out = span / VIEW_MAX;
    // And how far in: enough that a car is the same size in the hand as it is on
    // a laptop. See MIN_CAR_ON_SCREEN.
    const inTo = Math.max(out, (MIN_CAR_ON_SCREEN * this.pixelRatio()) / CAR_L);
    zoom = clamp(zoom, out, inTo);

    const w = view.w / zoom;
    const h = view.h / zoom;
    const world = state.track.world;
    let cx = (minX + maxX) / 2;
    let cy = (minY + maxY) / 2;
    // Kept over the table where it can be. On a table smaller than the view
    // there is nothing to choose, so it sits in the middle rather than jammed
    // against an edge.
    cx = w >= world.w ? world.w / 2 : clamp(cx, w / 2, world.w - w / 2);
    cy = h >= world.h ? world.h / 2 : clamp(cy, h / 2, world.h - h / 2);

    const want = { x: cx, y: cy, zoom };
    if (!this.cam) this.cam = { ...want };
    else {
      this.cam.x += (want.x - this.cam.x) * FOLLOW;
      this.cam.y += (want.y - this.cam.y) * FOLLOW;
      this.cam.zoom += (want.zoom - this.cam.zoom) * ZOOM_FOLLOW;
    }
    return this.cam;
  }

  /**
   * Device pixels per CSS pixel. Read off the canvas rather than from
   * devicePixelRatio, because the canvas is what everything here is drawn in and
   * the two can disagree - the page rounds its backing store, and a headless
   * browser will tell you whatever it was started with.
   */
  pixelRatio() {
    const css = this.canvas.clientWidth;
    return css > 0 ? this.canvas.width / css : 1;
  }

  /** The part of the canvas the game gets, once the touch controls have theirs. */
  viewport() {
    return {
      w: this.canvas.width,
      h: Math.max(80, this.canvas.height - this.bottomInset),
    };
  }

  toScreen(x, y) {
    const view = this.viewport();
    return {
      x: view.w / 2 + (x - this.cam.x) * this.cam.zoom,
      y: view.h / 2 + (y - this.cam.y) * this.cam.zoom,
    };
  }

  // --- The frame -------------------------------------------------------------

  draw(state, info = {}) {
    const ctx = this.ctx;
    const table = this.table(state.track);
    const cam = this.follow(state);
    const view = this.viewport();
    const z = cam.zoom;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = state.track.theme.floor;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = true;

    // A knock shakes the picture for a few frames. Purely cosmetic, and it is
    // the cheapest way to make a bump feel like it cost something.
    let jx = 0;
    let jy = 0;
    if (this.shake > 0) {
      this.shake *= 0.86;
      jx = Math.sin(state.tick * 5.1) * this.shake;
      jy = Math.cos(state.tick * 4.3) * this.shake;
      if (this.shake < 0.3) this.shake = 0;
    }

    ctx.save();
    ctx.translate(jx, jy);
    ctx.drawImage(table,
      view.w / 2 - cam.x * z, view.h / 2 - cam.y * z,
      table.width * z, table.height * z);

    this.trackMarks(state);
    this.drawMarks();
    this.drawBoosts(state);
    // Whoever is furthest up the screen is drawn first, so a car catching
    // another one goes over the top of it rather than under.
    const order = [...state.cars].sort((a, b) => a.y - b.y);
    for (const car of order) this.drawCar(state, car);
    ctx.restore();

    this.offScreen(state, info.seat);
    this.hud(state, info);
    if (info.net) this.netInfo(info.net);
  }

  // --- Cars ------------------------------------------------------------------

  /**
   * Rubber left on the road.
   *
   * Kept here rather than painted onto the table, which is cached per track and
   * would carry last race's mistakes into this one. A ring of a few hundred
   * short segments that fade as they age is cheaper anyway, and fading is what
   * they should do.
   */
  trackMarks(state) {
    for (const car of state.cars) {
      if (car.mode !== 'run' || Math.abs(car.slide) < SLIDE_MARK) continue;
      this.marks.push({
        x: car.x, y: car.y, a: car.angle, life: 1,
      });
    }
    if (this.marks.length > MARKS) this.marks.splice(0, this.marks.length - MARKS);
    for (const mark of this.marks) mark.life -= 0.0035;
  }

  drawMarks() {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, 4 * z);
    for (const mark of this.marks) {
      if (mark.life <= 0) continue;
      const at = this.toScreen(mark.x, mark.y);
      const dx = Math.cos(mark.a) * CAR_L * 0.32 * z;
      const dy = Math.sin(mark.a) * CAR_L * 0.32 * z;
      ctx.strokeStyle = `rgba(24, 20, 18, ${0.35 * mark.life})`;
      ctx.beginPath();
      ctx.moveTo(at.x - dx, at.y - dy);
      ctx.lineTo(at.x + dx, at.y + dy);
      ctx.stroke();
    }
  }

  /**
   * The turbos lying on the road.
   *
   * A chevron pointing the way you are going, so it reads as "this way, faster"
   * rather than as a coin. It fades over its last second, which is the only
   * warning you get that one is about to go.
   */
  drawBoosts(state) {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    for (const boost of state.boosts) {
      const at = this.toScreen(boost.x, boost.y);
      const fade = Math.min(1, boost.life / BOOST_FADE);
      const pulse = 0.7 + 0.3 * Math.sin(state.tick * 0.22 + boost.born);
      const r = BOOST_R * z;

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(at.x, at.y);
      ctx.fillStyle = `rgba(255, 225, 77, ${0.16 * pulse})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * (1 + 0.15 * pulse), 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(255, 240, 150, ${0.9 * pulse})`;
      ctx.lineWidth = Math.max(1.5, 3 * z);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const off of [-0.35, 0.35]) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.5, (off - 0.35) * r);
        ctx.lineTo(r * 0.45, off * r);
        ctx.lineTo(-r * 0.5, (off + 0.35) * r);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawCar(state, car) {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    const at = this.toScreen(car.x, car.y);
    const kit = CAR_PRESETS[car.index];

    // Off the table: it shrinks away and turns as it goes, which is the whole
    // animation and quite enough of one.
    const fell = car.mode === 'falling' ? car.fell : 0;
    const scale = z * (1 - fell * 0.8);
    if (fell >= 1) return;

    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(car.angle + fell * 2.4);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 1 - fell * 0.5;

    // What the car is getting for free, out of the back of it. A turbo is a
    // flame; a tow is a few lines of disturbed air, and faint on purpose - it is
    // worth seven per cent and should not look like it is worth more.
    if (car.boost > 0) {
      const flare = 0.6 + 0.4 * Math.sin(state.tick * 0.9);
      for (const [len, colour] of [[1.5, 'rgba(255, 120, 40, 0.75)'], [0.85, 'rgba(255, 232, 150, 0.9)']]) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(-CAR_L / 2, -CAR_W * 0.28);
        ctx.lineTo(-CAR_L / 2 - CAR_L * len * flare, 0);
        ctx.lineTo(-CAR_L / 2, CAR_W * 0.28);
        ctx.closePath();
        ctx.fill();
      }
    } else if (car.slip > 0.25) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.1 + car.slip * 0.18})`;
      ctx.lineWidth = 1.2;
      for (const y of [-CAR_W * 0.3, CAR_W * 0.3]) {
        ctx.beginPath();
        ctx.moveTo(-CAR_L * 0.6, y);
        ctx.lineTo(-CAR_L * (0.6 + car.slip * 0.7), y);
        ctx.stroke();
      }
    }

    // Shadow, offset a little so the car sits above the table rather than on it.
    ctx.fillStyle = 'rgba(8, 8, 10, 0.4)';
    roundRect(ctx, -CAR_L / 2 + 2, -CAR_W / 2 + 3, CAR_L, CAR_W, 4);
    ctx.fill();

    // Wheels, turned by however much lock is on. Drawn under the body, so only
    // the tread shows past the sides - which is what makes it read as a car
    // rather than a lozenge.
    ctx.fillStyle = '#17161a';
    for (const [wx, wy, steer] of [
      [CAR_L * 0.26, -CAR_W * 0.56, true], [CAR_L * 0.26, CAR_W * 0.56, true],
      [-CAR_L * 0.28, -CAR_W * 0.56, false], [-CAR_L * 0.28, CAR_W * 0.56, false],
    ]) {
      ctx.save();
      ctx.translate(wx, wy);
      if (steer) ctx.rotate(car.steer * 0.5);
      ctx.fillRect(-4, -2.6, 8, 5.2);
      ctx.restore();
    }

    ctx.fillStyle = kit.body;
    roundRect(ctx, -CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W, 4);
    ctx.fill();
    ctx.strokeStyle = kit.trim;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Windscreen towards the front, a stripe down the middle, and a nose light -
    // three marks, and between them they say which end is which at any zoom.
    ctx.fillStyle = kit.glass;
    roundRect(ctx, CAR_L * 0.02, -CAR_W * 0.34, CAR_L * 0.24, CAR_W * 0.68, 2);
    ctx.fill();
    ctx.fillStyle = kit.trim;
    ctx.fillRect(-CAR_L * 0.42, -1.2, CAR_L * 0.34, 2.4);
    ctx.fillStyle = '#fff4cf';
    ctx.fillRect(CAR_L * 0.42, -CAR_W * 0.3, 2.4, CAR_W * 0.6);

    // Brake lights, and they are the one thing on the car that tells you what
    // the driver in front has just decided.
    if (car.braking) {
      ctx.fillStyle = '#ff4832';
      ctx.fillRect(-CAR_L / 2 - 1, -CAR_W * 0.34, 2.6, CAR_W * 0.24);
      ctx.fillRect(-CAR_L / 2 - 1, CAR_W * 0.1, 2.6, CAR_W * 0.24);
    }
    ctx.restore();

    if (car.mode === 'waiting') this.waitingRing(at, z, car);
  }

  /** Put back on the road and not yet moving: a ring, so nobody rams it blind. */
  waitingRing(at, z, car) {
    const ctx = this.ctx;
    const pulse = 0.4 + 0.35 * Math.sin(car.timer * 0.4);
    ctx.strokeStyle = `rgba(255, 225, 77, ${pulse})`;
    ctx.lineWidth = Math.max(1, 2 * z);
    ctx.beginPath();
    ctx.arc(at.x, at.y, CAR_L * 0.85 * z, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * Arrows at the edge of the screen for cars that are not on it.
   *
   * The camera stops zooming out at the distance the game calls dropped, and
   * that distance is measured along the road: a car a whole corner behind can be
   * only a few feet away across the table, or off the side of the screen. This
   * is what keeps the promise that you can always see where everybody is.
   */
  offScreen(state, seat) {
    const ctx = this.ctx;
    const view = this.viewport();
    for (const car of state.cars) {
      if (car.mode === 'falling') continue;
      const at = this.toScreen(car.x, car.y);
      const pad = 26;
      if (at.x > pad && at.x < view.w - pad && at.y > pad && at.y < view.h - pad) continue;
      const x = clamp(at.x, pad, view.w - pad);
      const y = clamp(at.y, pad, view.h - pad);
      const a = Math.atan2(at.y - view.h / 2, at.x - view.w / 2);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = CAR_PRESETS[car.index].body;
      ctx.globalAlpha = car.index === seat ? 1 : 0.75;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-8, -8);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // --- The panel -------------------------------------------------------------

  hud(state, info) {
    const ctx = this.ctx;
    const s = Math.max(1, Math.round(Math.min(this.canvas.width / 640, 2.4)));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Standings, top left. Four rows, and the row that is yours is picked out.
    const rows = [...state.cars].sort((a, b) => a.place - b.place);
    const w = 152 * s;
    const h = 12 + rows.length * 15 * s;
    ctx.fillStyle = 'rgba(8, 12, 16, 0.7)';
    ctx.fillRect(8, 8, w, h);
    ctx.font = `${11 * s}px "Courier New", monospace`;
    rows.forEach((car, i) => {
      const y = 14 + i * 15 * s;
      ctx.fillStyle = CAR_PRESETS[car.index].body;
      ctx.fillRect(14, y + 2 * s, 6 * s, 8 * s);
      ctx.fillStyle = car.index === info.seat ? '#ffe14d' : '#c8d6cc';
      const lap = car.finished ? 'FIN' : `L${lapNumber(state, car)}`;
      ctx.fillText(`${car.place}  ${car.name.padEnd(7)}${lap}`, 14 + 10 * s, y);
    });

    // Your lap and your times, top right. Nothing here for a spectator.
    const you = state.cars[info.seat ?? -1];
    if (you) {
      const running = state.phase === 'race' && !you.finished
        ? lapMs(state.tick - you.lapStart) : 0;
      const lines = [
        `LAP ${lapNumber(state, you)}/${state.config.laps}`,
        formatLap(running),
        `BEST ${you.best ? formatLap(lapMs(you.best)) : '--:--.--'}`,
      ];
      const bw = 150 * s;
      ctx.fillStyle = 'rgba(8, 12, 16, 0.7)';
      ctx.fillRect(this.canvas.width - bw - 8, 8, bw, 12 + lines.length * 15 * s);
      ctx.textAlign = 'right';
      lines.forEach((text, i) => {
        ctx.fillStyle = i === 1 ? '#ffe14d' : '#c8d6cc';
        ctx.font = `${(i === 1 ? 14 : 11) * s}px "Courier New", monospace`;
        ctx.fillText(text, this.canvas.width - 16, 14 + i * 15 * s);
      });
      ctx.textAlign = 'left';
    }

    if (state.phase === 'countdown') this.countdown(state, s);
    // Not while something is asking for your initials. The results card and the
    // record picker are both in the middle of the screen and both want reading;
    // stacked, neither of them can be.
    if (!info.quiet && (state.phase === 'finish' || state.phase === 'over')) {
      this.results(state, s, info.seat);
    }
  }

  countdown(state, s) {
    const ctx = this.ctx;
    const left = Math.ceil(state.phaseTimer / TICK_RATE);
    const view = this.viewport();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${90 * s}px "Courier New", monospace`;
    ctx.fillStyle = left <= 1 ? '#7fe07a' : '#ffe14d';
    ctx.fillText(String(Math.max(1, left)), view.w / 2, view.h * 0.42);
    ctx.font = `${13 * s}px "Courier New", monospace`;
    ctx.fillStyle = '#c8d6cc';
    ctx.fillText(state.track.name, view.w / 2, view.h * 0.42 + 62 * s);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  /** Who finished where, and the quickest lap of the race under it. */
  results(state, s, seat) {
    const ctx = this.ctx;
    const view = this.viewport();
    const rows = [...state.cars].sort((a, b) => a.place - b.place);
    const w = 320 * s;
    const h = (72 + rows.length * 22) * s;
    const x = (view.w - w) / 2;
    const y = view.h * 0.2;

    ctx.fillStyle = 'rgba(6, 12, 16, 0.88)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255, 225, 77, 0.5)';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.strokeRect(x, y, w, h);

    ctx.textAlign = 'center';
    ctx.font = `bold ${20 * s}px "Courier New", monospace`;
    ctx.fillStyle = '#ffe14d';
    ctx.fillText('FINISH', view.w / 2, y + 16 * s);

    ctx.textAlign = 'left';
    ctx.font = `${13 * s}px "Courier New", monospace`;
    rows.forEach((car, i) => {
      const ry = y + (48 + i * 22) * s;
      ctx.fillStyle = CAR_PRESETS[car.index].body;
      ctx.fillRect(x + 18 * s, ry + 2 * s, 7 * s, 11 * s);
      ctx.fillStyle = car.index === seat ? '#ffffff' : '#c8d6cc';
      ctx.fillText(`${car.place}   ${car.name}`, x + 32 * s, ry);
      ctx.textAlign = 'right';
      ctx.fillText(car.best ? formatLap(lapMs(car.best)) : '--:--.--', x + w - 18 * s, ry);
      ctx.textAlign = 'left';
    });

    ctx.textAlign = 'center';
    ctx.font = `${11 * s}px "Courier New", monospace`;
    ctx.fillStyle = '#8fae9a';
    const best = state.best
      ? `FASTEST LAP  ${state.cars[state.best.seat].name}  ${formatLap(lapMs(state.best.ticks))}`
      : 'NOBODY TURNED A CLEAN LAP';
    ctx.fillText(best, view.w / 2, y + h - 22 * s);
    ctx.textAlign = 'left';
  }

  netInfo(net) {
    const ctx = this.ctx;
    ctx.font = '12px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = net.stalling ? '#ffb84d' : '#7ea888';
    const text = net.gone.length
      ? `${net.gone.length} PLAYER${net.gone.length > 1 ? 'S' : ''} GONE`
      : `${net.ping} ms${net.stalling ? ' - WAITING' : ''}`;
    ctx.fillText(text, 12, this.canvas.height - 22);
  }

  /** A bump, felt rather than seen. Called from the sound side, on events. */
  knock(hard) {
    this.shake = Math.min(9, Math.max(this.shake, hard / 42));
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
