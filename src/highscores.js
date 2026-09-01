/**
 * The lap record board.
 *
 * Ten per table, kept in localStorage so a browser on its own needs nothing at
 * all. Every entry carries an id and the time it was set, which is what lets two
 * boards from two devices be merged later without either winning by being loaded
 * second.
 *
 * This is the one piece of plumbing webracing does not share with websoccer and
 * webtennis, and the reason is the shape of a score. Theirs is a result - a
 * scoreline, where more is better and a defeat is not news. Here it is a lap
 * time: a smaller number wins, there is no opponent in it, and it is per table
 * rather than per difficulty, because a lap of the pool table and a lap of the
 * desk are not comparable and never will be. Everything else about the board -
 * merging, clearing, the three letters, the Worker that holds it - is word for
 * word the same file the other two games run.
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
/** One table per track. The name is kept for the sake of the shared server. */
export const LEVELS = TRACK_KEYS;
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
  for (const level of LEVELS) {
    const seen = new Map();
    for (const raw of [...(mine?.[level] || []), ...(theirs?.[level] || [])]) {
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
  const out = {};
  for (const level of LEVELS) {
    out[level] = (board?.[level] || []).filter((row) => Number(row?.at) >= when);
  }
  return merge({}, out);
}

/** A board with these ids taken out, wherever they sit. */
export function without(board, ids) {
  const drop = new Set(ids || []);
  const out = {};
  for (const level of LEVELS) {
    out[level] = (board?.[level] || []).filter((row) => !drop.has(row?.id));
  }
  return merge({}, out);
}

export function levelOf(track) {
  return LEVELS.includes(track) ? track : LEVELS[0];
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

  table(track) {
    return this.tables[levelOf(track)] || [];
  }

  qualifies(track, entry) {
    return qualifies(this.table(track), entry);
  }

  /** Adds a lap and returns where it landed, or 0 if it missed the board. */
  add(track, entry) {
    const clean = cleanEntry(entry);
    if (!clean) return 0;
    const level = levelOf(track);
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
