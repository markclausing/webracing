/**
 * What gets said in Discord when somebody sets a lap record.
 *
 * Kept apart from the Worker so both servers can use it and so the wording can
 * be tested without a network anywhere near it. Nothing in here talks to
 * Discord; it only decides what is news and what the message should say.
 *
 * It says which game is talking, and that is not decoration. All three games
 * post into the same channel - the webhook is only an address and does not care
 * who is using it - so a bare "MJC 0:13.35" would be indistinguishable from a
 * football result to anybody who was not already playing.
 */

import { LEVELS, partsOf } from '../src/highscores.js';

/** How many records one post will mention before it just counts the rest. */
const MAX_LINES = 3;

/** What each table is called in a sentence. */
const NAMES = {
  breakfast: 'the breakfast table',
  pool: 'the pool table',
  garden: 'the garden path',
  desk: 'the desk',
};

/** And who they were up against, which is what the list is keyed by. */
const AGAINST = {
  easy: ' against EASY',
  normal: ' against NORMAL',
  hard: ' against HARD',
  online: ', online',
};

/** "1:04.83". The same format the game shows. */
export function lap(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/**
 * Which rows are new, and where they landed.
 *
 * Worked out by comparing the board before and after rather than trusting what
 * was sent: a lap that did not make the top ten is not news, and the same lap
 * arriving from a second device is not news either, because merging matches it
 * by id.
 */
export function newRows(before, after) {
  const rows = [];
  for (const level of LEVELS) {
    const had = new Set((before?.[level] || []).map((r) => r.id));
    const now = after?.[level] || [];
    for (let i = 0; i < now.length; i++) {
      if (!had.has(now[i].id)) rows.push({ entry: now[i], level, place: i + 1 });
    }
  }
  // Best placings first, so a post that has to cut something cuts the least
  // interesting line.
  return rows.sort((a, b) => a.place - b.place);
}

function ordinal(n) {
  if (n === 1) return '**fastest lap on the list**';
  if (n === 2) return 'second';
  if (n === 3) return 'third';
  return `number ${n}`;
}

function line({ entry, level, place }) {
  const { track, tier } = partsOf(level);
  const where = NAMES[track] || track;
  return `🏁 **${entry.name}** went round ${where}${AGAINST[tier] ?? ''} `
    + `in **${lap(entry.ms)}** — ${ordinal(place)}`;
}

/**
 * Where the game lives. Overridden with a GAME_URL secret if you host it
 * somewhere else, because the whole point of the message is that people can
 * click it and go and beat the time.
 */
export const GAME_URL = 'https://markclausing.github.io/webracing/';

/** Red, the colour of the first car on the grid. */
const COLOUR = 0xe0453c;

/**
 * The body of the Discord post.
 *
 * An embed rather than a line of text: it gives the message a clickable title,
 * so nobody has to copy an address out of a chat window, and it says which game
 * this is. The name is set on the message as well, so it reads as WebRacing
 * talking whatever the webhook itself was called when it was made.
 */
export function announcement(rows, gameUrl = GAME_URL) {
  const shown = rows.slice(0, MAX_LINES).map(line);
  if (rows.length > MAX_LINES) {
    shown.push(`…and ${rows.length - MAX_LINES} more.`);
  }
  const url = gameUrl || GAME_URL;
  const plural = rows.length > 1 ? 'New lap records' : 'New lap record';
  return {
    username: 'WebRacing',
    embeds: [{
      title: `🏎️ ${plural} in WebRacing`,
      url,
      description: shown.join('\n'),
      color: COLOUR,
      footer: { text: `Play at ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}` },
    }],
    // Names are three characters of A-Z, 0-9 and a dash, so they cannot spell a
    // mention - but a board this open should not be one webhook away from
    // pinging a whole server, whatever anybody changes later.
    allowed_mentions: { parse: [] },
  };
}
