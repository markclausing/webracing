/**
 * What gets said in Discord when somebody sets a lap record.
 *
 * Shared by the Worker and by `node server/relay.js`, so whichever one you are
 * running says the same thing. It is only string building - no network, no
 * storage - which is also what makes it testable.
 */

import { LEVELS } from '../src/highscores.js';

const NAMES = {
  breakfast: 'the breakfast table',
  pool: 'the pool table',
  garden: 'the garden path',
  desk: 'the desk',
};

/** "1:04.83". The same format the game shows, and deliberately duplicated. */
function lap(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/**
 * Rows that are on the new board and were not on the old one.
 *
 * Worked out from the two boards rather than from what was posted, on purpose: a
 * lap that did not make the top ten is not news, and a lap arriving for the
 * second time from a second device is not news either.
 */
export function newRows(before, after) {
  const rows = [];
  for (const level of LEVELS) {
    const had = new Set((before?.[level] || []).map((r) => r.id));
    for (const row of after?.[level] || []) {
      if (!had.has(row.id)) rows.push({ ...row, level });
    }
  }
  return rows;
}

/** One Discord webhook payload for a batch of new records. */
export function announcement(rows, url) {
  const lines = rows.map((row) => {
    const where = NAMES[row.level] || row.level;
    return `**${row.name}** went round ${where} in **${lap(row.ms)}**`;
  });
  const content = lines.join('\n') + (url ? `\n${url}` : '');
  return { content, allowed_mentions: { parse: [] } };
}

export { lap };
