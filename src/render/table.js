/**
 * The table, painted once onto an offscreen canvas.
 *
 * It never changes, so it is drawn at the size of the whole world the first time
 * a track is raced and blitted every frame after that - the same trick websoccer
 * uses for its pitch and webtennis for its court. The difference here is that
 * the world is bigger than the window and the camera moves over it, so this
 * canvas is a couple of megapixels rather than a screenful.
 *
 * Everything is in world units. Nothing in this file knows the camera exists.
 */

import { pointAt } from '../game/path.js';

function tracePath(ctx, path) {
  const { x, y, count } = path;
  ctx.beginPath();
  ctx.moveTo(x[0], y[0]);
  for (let i = 1; i < count; i++) ctx.lineTo(x[i], y[i]);
  ctx.closePath();
}

/**
 * The whole table is drawn as concentric ribbons: one stroke of the loop on top
 * of another, each narrower than the last.
 *
 * The obvious alternative - work out a copy of the curve pushed 50 pixels to one
 * side, and stroke that - is what this used to do, and offsetting a curve
 * properly is a genuinely hard problem. Anywhere the road turned tighter than
 * the offset distance the copy folded back through itself and left a whisker of
 * cushion sticking out into the baize. Concentric strokes have no such problem,
 * because the browser is doing the hard part.
 */
function ribbon(ctx, path, width, style) {
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  tracePath(ctx, path);
  ctx.stroke();
}

/** Draws a whole track to a canvas the size of its world. Returns the canvas. */
export function drawTable(track, make) {
  const { world, theme, path } = track;
  const canvas = make(world.w, world.h);
  const ctx = canvas.getContext('2d');
  const edge = track.width + track.shoulder;

  ctx.fillStyle = theme.floor;
  ctx.fillRect(0, 0, world.w, world.h);
  // The room the table is standing in gets a texture of its own, very faint. A
  // flat fill reads as a hole in the picture rather than as a floor, and on a
  // phone held upright there is a lot of it on screen at once.
  if (track.edge === 'fall') {
    ctx.save();
    ctx.globalAlpha = 0.5;
    grain(ctx, { world, theme: { grain: theme.table, grainAlpha: 0.1 } });
    ctx.restore();
  }

  // A table with cushions is a table you can see all of; one you can fall off is
  // a strip of surface with a room a long way underneath it, and the two want
  // completely different pictures.
  if (track.edge === 'wall') {
    tableTop(ctx, track);
    decorations(ctx, track, 1);
    // The rails. Drawn widest, so only the outer few pixels of them survive the
    // shoulder going on top - which is exactly what a cushion looks like.
      ribbon(ctx, path, edge * 2 + 22, theme.kerb);
  } else {
    // On a table you can fall off, the clutter goes on the floor underneath and
    // is dimmed. That, and the shadow the road casts onto it, is most of what
    // makes the course look like it is up in the air rather than painted on.
    decorations(ctx, track, 0.34);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 16;
    ribbon(ctx, path, edge * 2, theme.shoulder);
    ctx.restore();
  }

  // A dark lip, then the rough, then the painted edges of the road, then the
  // road. The lip is doing more work than it looks: without it the course is
  // three shades of the same colour on top of each other and the eye has
  // nothing to follow.
  ribbon(ctx, path, edge * 2 + 10, 'rgba(0, 0, 0, 0.42)');
  ribbon(ctx, path, edge * 2, theme.shoulder);
  ribbon(ctx, path, track.width * 2 + 6, theme.line);
  ribbon(ctx, path, track.width * 2 - 2, theme.road);
  centreLine(ctx, track);

  // The spills, and the texture on a bare tabletop. Both belong on the road and
  // nowhere else, so they are drawn on a layer of their own and then trimmed to
  // it - a stroke of the same loop, composited. Trimming to a shape worked out
  // from the curve was the last thing in here that could produce a whisker.
  const spills = make(world.w, world.h);
  const layer = spills.getContext('2d');
  if (track.edge === 'fall') grain(layer, track);
  patches(layer, track);
  layer.globalCompositeOperation = 'destination-in';
  ribbon(layer, path, edge * 2, '#000');
  ctx.drawImage(spills, 0, 0);

  startLine(ctx, track);
  pits(ctx, track);
  props(ctx, track);

  return canvas;
}

function tableTop(ctx, track) {
  const { world, theme } = track;
  const inset = 26;
  ctx.fillStyle = theme.table;
  roundRect(ctx, inset, inset, world.w - inset * 2, world.h - inset * 2, 40);
  ctx.fill();

  // A rail around it, so it reads as a piece of furniture rather than a
  // rectangle of colour.
  ctx.strokeStyle = theme.kerb;
  ctx.lineWidth = 16;
  roundRect(ctx, inset - 8, inset - 8, world.w - (inset - 8) * 2, world.h - (inset - 8) * 2, 46);
  ctx.stroke();

  ctx.save();
  roundRect(ctx, inset, inset, world.w - inset * 2, world.h - inset * 2, 40);
  ctx.clip();
  grain(ctx, track);
  ctx.restore();
}

/**
 * Texture, of the cheapest kind that works: short strokes in a slightly
 * different shade, laid down on a fixed grid.
 *
 * Not random - not because it has to match anything, this canvas is never
 * hashed, but because a table that looked different every time you loaded the
 * page would be somebody's bug report.
 */
function grain(ctx, track) {
  const { world, theme } = track;
  ctx.strokeStyle = theme.grain;
  // Per theme, because the same strength is wood on one table and corrugated
  // iron on another: photographed at one setting for all four, the garden's
  // paving came out ribbed like a roof.
  ctx.globalAlpha = theme.grainAlpha ?? 0.45;
  ctx.lineWidth = 3;
  for (let y = 0; y < world.h; y += 18) {
    const wobble = ((y * 37) % 61) - 30;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(world.w / 3, y + wobble * 0.4, (world.w * 2) / 3, y - wobble * 0.4, world.w, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A dashed line down the middle of the road, and nothing else. */
function centreLine(ctx, track) {
  ctx.strokeStyle = track.theme.line;
  ctx.globalAlpha = 0.3;
  ctx.setLineDash([26, 30]);
  ctx.lineWidth = 4;
  tracePath(ctx, track.path);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** Chequers across the road at nothing-along, which is where a lap begins. */
function startLine(ctx, track) {
  const at = pointAt(track.path, 0);
  const rows = 3;
  const squares = 8;
  const step = (track.width * 2) / squares;

  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(Math.atan2(at.ty, at.tx));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < squares; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#12100e' : '#f4f0e6';
      ctx.fillRect(r * 11 - 16, -track.width + c * step, 11, step);
    }
  }
  ctx.restore();
}

function patches(ctx, track) {
  for (const patch of track.patches || []) {
    const look = LOOKS[patch.look] || LOOKS.default;
    ctx.save();
    ctx.globalAlpha = look.alpha;
    ctx.fillStyle = look.fill;
    blob(ctx, patch.x, patch.y, patch.r);
    ctx.fill();
    if (look.edge) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = look.edge;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** What a spill looks like. Everything else about a spill is in SURFACES. */
const LOOKS = {
  default: { fill: '#000000', alpha: 0.2 },
  milk: { fill: '#f4f2ec', alpha: 0.9, edge: 'rgba(220,216,206,0.9)' },
  crumbs: { fill: '#8a6234', alpha: 0.55 },
  chalk: { fill: '#cfe6ff', alpha: 0.22 },
  mud: { fill: '#4c3520', alpha: 0.92, edge: 'rgba(30,20,10,0.5)' },
  puddle: { fill: '#4a7f9c', alpha: 0.65, edge: 'rgba(180,220,240,0.5)' },
  coffee: { fill: '#4a2c17', alpha: 0.85, edge: 'rgba(20,10,4,0.55)' },
  mousepad: { fill: '#22242a', alpha: 0.9 },
};

/**
 * A circle with the roundness taken out of it.
 *
 * Fixed lumps rather than random ones, for the same reason the grain is fixed:
 * this canvas is drawn once and it should be the same picture every time.
 */
function blob(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const wobble = 1 + 0.16 * Math.sin(i * 2.3) + 0.09 * Math.cos(i * 3.7 + x);
    const px = x + Math.cos(a) * r * wobble;
    const py = y + Math.sin(a) * r * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** The pockets. A hole, a lip, and no bottom. */
function pits(ctx, track) {
  for (const pit of track.pits || []) {
    ctx.fillStyle = '#0a0d0a';
    ctx.beginPath();
    ctx.arc(pit.x, pit.y, pit.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(240, 226, 184, 0.5)';
    ctx.lineWidth = 6;
    ctx.stroke();
  }
}

function props(ctx, track) {
  for (const prop of track.props || []) drawProp(ctx, prop);
}

function drawProp(ctx, prop) {
  const { x, y, r } = prop;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.ellipse(x + 6, y + 9, r * 1.05, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();

  const skin = {
    mug: ['#e8e2d6', '#c3bbaa', '#3a2416'],
    jar: ['#c6432f', '#8d2b1d', '#f0d9a6'],
    stone: ['#8d8b83', '#5f5d57', '#a8a69d'],
    pot: ['#b56a3a', '#7d4423', '#3d2a17'],
    ball: ['#e8d24a', '#a8912a', '#f6ecc0'],
    eraser: ['#e07ba0', '#a44e6e', '#f3c0d2'],
  }[prop.kind] || ['#9a9a9a', '#666', '#bbb'];

  ctx.fillStyle = skin[0];
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = skin[1];
  ctx.lineWidth = 4;
  ctx.stroke();
  // A smaller circle inside: the inside of a mug, the shine on a snooker ball.
  ctx.fillStyle = skin[2];
  ctx.beginPath();
  ctx.arc(x - r * 0.12, y - r * 0.12, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The things lying about that you cannot hit. */
function decorations(ctx, track, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const item of track.decor || []) {
    ctx.save();
    ctx.translate(item.x, item.y);
    if (item.a) ctx.rotate(item.a);
    DECOR[item.kind]?.(ctx, item, track);
    ctx.restore();
  }
  ctx.restore();
}

const DECOR = {
  plate(ctx, d) {
    ctx.fillStyle = '#efe9df';
    ctx.beginPath();
    ctx.arc(0, 0, d.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#cfc6b6';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, d.r * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  },
  toast(ctx) {
    ctx.fillStyle = '#c99542';
    roundRect(ctx, -34, -30, 68, 60, 8);
    ctx.fill();
    ctx.fillStyle = '#e8c078';
    roundRect(ctx, -26, -22, 52, 44, 6);
    ctx.fill();
  },
  cutlery(ctx) {
    ctx.fillStyle = '#c9ccd2';
    roundRect(ctx, -8, -110, 16, 220, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -104, 18, 34, 0, 0, Math.PI * 2);
    ctx.fill();
  },
  napkin(ctx, d) {
    ctx.fillStyle = '#dfe6ea';
    ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
    ctx.strokeStyle = '#c3ccd2';
    ctx.lineWidth = 4;
    ctx.strokeRect(-d.w / 2, -d.h / 2, d.w, d.h);
  },
  cue(ctx, d) {
    ctx.fillStyle = '#c99a5c';
    ctx.fillRect(-d.w / 2, -7, d.w, 14);
    ctx.fillStyle = '#5d3d1e';
    ctx.fillRect(d.w / 2 - 130, -9, 130, 18);
    ctx.fillStyle = '#2f6fa0';
    ctx.fillRect(-d.w / 2, -6, 16, 12);
  },
  spot(ctx, d) {
    ctx.fillStyle = 'rgba(240, 226, 184, 0.8)';
    ctx.beginPath();
    ctx.arc(0, 0, d.r, 0, Math.PI * 2);
    ctx.fill();
  },
  book(ctx, d) {
    ctx.fillStyle = '#2f4b7a';
    roundRect(ctx, -d.w / 2, -d.h / 2, d.w, d.h, 6);
    ctx.fill();
    ctx.fillStyle = '#e8e2d0';
    ctx.fillRect(-d.w / 2 + 10, -d.h / 2 + 8, d.w - 20, d.h - 16);
    ctx.fillStyle = '#2f4b7a';
    ctx.fillRect(-8, -d.h / 2, 16, d.h);
  },
  pencil(ctx, d) {
    ctx.fillStyle = '#e8b83a';
    ctx.fillRect(-d.w / 2, -11, d.w, 22);
    ctx.fillStyle = '#d9c4a0';
    ctx.beginPath();
    ctx.moveTo(d.w / 2, -11);
    ctx.lineTo(d.w / 2 + 40, 0);
    ctx.lineTo(d.w / 2, 11);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e08aa0';
    ctx.fillRect(-d.w / 2 - 26, -11, 26, 22);
  },
  ruler(ctx, d) {
    ctx.fillStyle = 'rgba(214, 232, 226, 0.85)';
    ctx.fillRect(-d.w / 2, -18, d.w, 36);
    ctx.strokeStyle = 'rgba(20, 40, 36, 0.5)';
    ctx.lineWidth = 2;
    for (let i = -d.w / 2 + 12; i < d.w / 2; i += 24) {
      ctx.beginPath();
      ctx.moveTo(i, -18);
      ctx.lineTo(i, -4);
      ctx.stroke();
    }
  },
  jar(ctx, d) {
    drawProp(ctx, { ...d, x: 0, y: 0 });
  },
  stone(ctx, d) {
    drawProp(ctx, { ...d, x: 0, y: 0 });
  },
  flower(ctx, d) {
    ctx.fillStyle = '#d84f7a';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * d.r, Math.sin(a) * d.r, d.r * 0.7, d.r * 0.5, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f0d24a';
    ctx.beginPath();
    ctx.arc(0, 0, d.r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  },
  hose(ctx, d, track) {
    ctx.strokeStyle = '#2f6b3a';
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(60, track.world.h - 90);
    ctx.bezierCurveTo(560, track.world.h + 40, 900, track.world.h - 260, 1500, track.world.h - 70);
    ctx.stroke();
  },
};

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export { roundRect };
