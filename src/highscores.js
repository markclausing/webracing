/**
 * The lap record board.
 *
 * Ten per list, kept in localStorage so a browser on its own needs nothing at
 * all. Every entry carries an id and the time it was set, which is what lets two
 * boards from two devices be merged later without either winning by being loaded
 * second.
 *
 * This is the one piece of plumbing webracing does not share with websoccer and
 * webtennis, and the reason is the shape of a score. Theirs is a result - a
 * scoreline, where more is better and a defeat is not news. Here it is a lap
 * time: a smaller number wins and there is no opponent in it. Everything else
 * about the board - merging, clearing, the three letters, the Worker that holds
 * it - is word for word the same file the other two games run.
 *
 * A lap of the pool table and a lap of the desk are not comparable and never
 * will be, so there is a list per table. There is also a list per set of
 * opponents; see LEVELS for what that is and is not measuring.
 *
 * A record has to be a *clean* lap: no falling off, no being scooped up, no
 * going round the wrong way. The simulation decides that and hands the flag
 * over; nothing here can tell.
 *
 * Nothing in here touches the simulation, and the store is injectable so the
 * tests can run it without a browser.
 */

import { TRACK_KEYS } from './game/tracks.js';

/**
 * Where the board is kept, unless the game says otherwise.
 *
 * It has to be said otherwise when several games share an origin, which these
 * three do: all of them live on the same github.io domain, and one key would
 * mean tennis results landing in a racing table.
 */
export const KEY = 'webracing.highscores.v1';

/**
 * One list per table per set of opponents, keyed `pool:hard`.
 *
 * The CPU setting does not touch your car - grip, acceleration and top speed are
 * identical on EASY and HARD, and what varies is the table, not the level. What
 * it does change is the traffic, and traffic can only ever cost you time,
 * because there is no slipstream in this game and another car is never a help.
 * Measured with one fixed driver over ten seeds and four tables, the best lap
 * moved by at most 0.07 of a second between the three settings, with no
 * ordering. So these lists are about the conditions a lap was set in rather than
 * about the car.
 *
 * `online` is one of them because it has to be. An online race has no CPU
 * setting at all - every car is a person - and filing those laps under whichever
 * level the menu happened to be showing would be writing down something untrue.
 */
export const TIERS = ['easy', 'normal', 'hard', 'online'];
export const LEVELS = TRACK_KEYS.flatMap((t) => TIERS.map((d) => `${t}:${d}`));
export const TABLE_SIZE = 10;
export const NAME_LENGTH = 3;

/** The letters you can pick from, in the order the stick cycles through them. */
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';

/** Nobody has ever driven a lap of these tables in under four seconds. */
const FASTEST = 4000;
/** And a "lap" of twenty minutes is a browser tab that was left open. */
const SLOWEST = 20 * 60 * 1000;

const empty = () => Object.fromEntries(LEVELS.map((l) => [l, []]));

function cleanName(name) {
  const up = String(name ?? '').toUpperCase();
  let out = '';
  for (const ch of up) {
    if (ALPHABET.includes(ch) && out.length < NAME_LENGTH) out += ch;
  }
  return out.padEnd(NAME_LENGTH, '-');
}

/**
 * One row, from anywhere: our own storage, another device, or a shared board.
 * Anything unusable comes back null rather than throwing - a corrupt board
 * should cost you a row, not the page.
 */
export function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ms = Math.round(Number(raw.ms));
  if (!Number.isFinite(ms) || ms < FASTEST || ms > SLOWEST) return null;
  const at = Number(raw.at);
  return {
    id: String(raw.id || '').slice(0, 40) || makeId(),
    name: cleanName(raw.name),
    ms,
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
  };
}

/** Unique enough to tell two entries apart when boards are merged. */
export function makeId() {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${Date.now().toString(36)}-${rand}`;
}

/** Quickest first; a dead heat goes to whoever set it first. */
export function compare(a, b) {
  if (a.ms !== b.ms) return a.ms - b.ms;
  return a.at - b.at;
}

export function sortTable(entries) {
  return [...entries].sort(compare).slice(0, TABLE_SIZE);
}

/** Would this lap get on the board? */
export function qualifies(table, entry) {
  const clean = cleanEntry(entry);
  if (!clean) return false;
  // Sorted here rather than trusted: a board that arrived from somewhere else
  // may be in any order, and asking the wrong row would let a slower lap in.
  const rows = sortTable(table || []);
  if (rows.length < TABLE_SIZE) return true;
  return compare(clean, rows[rows.length - 1]) < 0;
}

/** Where a lap would land, counting from 1, or 0 if it would not. */
export function placeOf(table, entry) {
  const clean = cleanEntry(entry);
  if (!clean) return 0;
  const rows = sortTable([...(table || []), clean]);
  const at = rows.findIndex((r) => r.id === clean.id);
  return at < 0 ? 0 : at + 1;
}

/**
 * Two boards into one. Same id means the same lap, however many times it has
 * travelled: a board that has been round three devices must not grow three
 * copies of everything.
 */
export function merge(mine, theirs) {
  const out = empty();
  const a = normalise(mine);
  const b = normalise(theirs);
  for (const level of LEVELS) {
    const seen = new Map();
    for (const raw of [...(a[level] || []), ...(b[level] || [])]) {
      const entry = cleanEntry(raw);
      if (entry && !seen.has(entry.id)) seen.set(entry.id, entry);
    }
    out[level] = sortTable([...seen.values()]);
  }
  return out;
}

/**
 * A board with everything set before `since` dropped.
 *
 * This is what makes emptying the shared board stick. Wiping the server does not
 * wipe anybody's browser, and the next time one of them syncs it posts its own
 * copy straight back. So a cleared board remembers when it was cleared, and
 * refuses anything older.
 */
export function since(board, when) {
  if (!when) return merge({}, board);
  const from = normalise(board);
  const out = {};
  for (const level of LEVELS) {
    out[level] = (from[level] || []).filter((row) => Number(row?.at) >= when);
  }
  return merge({}, out);
}

/** A board with these ids taken out, wherever they sit. */
export function without(board, ids) {
  const drop = new Set(ids || []);
  const from = normalise(board);
  const out = {};
  for (const level of LEVELS) {
    out[level] = (from[level] || []).filter((row) => !drop.has(row?.id));
  }
  return merge({}, out);
}

/** `('pool', 'hard')` -> `'pool:hard'`, and anything unrecognised -> the first list. */
export function levelOf(track, tier = 'normal') {
  const key = String(track).includes(':') ? String(track) : `${track}:${tier}`;
  return LEVELS.includes(key) ? key : LEVELS[0];
}

/** The table and the opponents a list is for, for putting on screen. */
export function partsOf(key) {
  const [track, tier] = String(key).split(':');
  return { track, tier: TIERS.includes(tier) ? tier : 'normal' };
}

/**
 * Any board, in the shape this version expects.
 *
 * The first version of the board was keyed by table alone, and there are boards
 * in browsers and on a server with rows filed that way. Dropping them would be
 * throwing away laps people actually drove, so they are folded into NORMAL -
 * which is a guess, but it is the setting the menu opens on and therefore the
 * one they were most likely set against.
 *
 * Runs on the way in rather than as a one-off migration, because there is no
 * moment when every copy of the board has been converted: a browser that has not
 * been opened for a month will post the old shape whenever it next syncs.
 */
function normalise(board) {
  const out = {};
  for (const [key, rows] of Object.entries(board || {})) {
    if (!Array.isArray(rows)) continue;
    const to = LEVELS.includes(key) ? key
      : (TRACK_KEYS.includes(key) ? `${key}:normal` : null);
    if (!to) continue;
    (out[to] ||= []).push(...rows);
  }
  return out;
}

export class Highscores {
  constructor(store = globalThis.localStorage, key = KEY) {
    this.store = store;
    this.key = key;
    this.tables = this.read();
  }

  read() {
    try {
      const raw = this.store?.getItem(this.key);
      if (!raw) return empty();
      return merge(empty(), JSON.parse(raw));
    } catch {
      // Unreadable, or storage turned off. An empty board is the right answer:
      // losing the board is a shame, refusing to start the game is worse.
      return empty();
    }
  }

  write() {
    try {
      this.store?.setItem(this.key, JSON.stringify(this.tables));
    } catch { /* private mode: the board just will not stick */ }
  }

  table(track, tier) {
    return this.tables[levelOf(track, tier)] || [];
  }

  qualifies(track, tier, entry) {
    return qualifies(this.table(track, tier), entry);
  }

  /** Adds a lap and returns where it landed, or 0 if it missed the board. */
  add(track, tier, entry) {
    const clean = cleanEntry(entry);
    if (!clean) return 0;
    const level = levelOf(track, tier);
    this.tables[level] = sortTable([...this.table(level), clean]);
    this.write();
    return this.tables[level].findIndex((r) => r.id === clean.id) + 1;
  }

  /** Folds in a board from somewhere else and keeps the result. */
  absorb(theirs) {
    this.tables = merge(this.tables, theirs);
    this.write();
    return this.tables;
  }

  all() {
    return this.tables;
  }
}
