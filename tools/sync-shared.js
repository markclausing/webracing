// Checks the files shared with websoccer and webtennis are still the same files.
//
//   node tools/sync-shared.js            # report drift
//   node tools/sync-shared.js --pull     # take the other games' copy
//   node tools/sync-shared.js --push     # send this copy back to both
//
// The three games share their plumbing - the input mask, the touch controls, the
// room protocol, the three-letter name entry, the speech synthesiser and the
// maths - and share it by having the same file in every repository rather than
// by a package, because none of them has a build step and none is going to get
// one for this.
//
// Copying is only worth anything if somebody notices when the copies part ways,
// which is what this is. It is part of `npm test`, so a change to a shared file
// on one side shows up as a failing test on the others rather than as a bug six
// months later.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEIGHBOURS = [
  ['websoccer', process.env.WEBSOCCER || path.resolve(HERE, '..', 'websoccer')],
  ['webtennis', process.env.WEBTENNIS || path.resolve(HERE, '..', 'webtennis')],
];

/**
 * What is generic enough to be identical in all three games.
 *
 * Shorter than the list webtennis keeps, and the four that fell off it are worth
 * naming, because each one is a place where this game genuinely is a different
 * game rather than the same one with new pictures:
 *
 *   src/highscores.js   theirs is a scoreline, where bigger is better and a
 *                       defeat is not news. A lap time is smaller-is-better, has
 *                       no opponent in it, and is kept per table rather than per
 *                       difficulty.
 *   src/net/transport.js  two players became four, so "the peer" became "the
 *                       other seats" and a stall is anybody's fault.
 *   server/relay.js     rooms hold four, and the relay stamps the seat a message
 *   worker/index.js     came from rather than letting the sender name it.
 *
 * Deliberately not on the list either: anything that knows what sport it is. The
 * simulation, the renderer, the sounds and the words are each game's own, and
 * pretending otherwise would mean a shared file full of `if (racing)`.
 */
export const SHARED = [
  'src/util.js',
  'src/input.js',
  'src/touch.js',
  'src/speech.js',
  'src/nameEntry.js',
  'src/net/signal.js',
  'server/ws.js',
];

function read(root, file) {
  const at = path.join(root, file);
  return existsSync(at) ? readFileSync(at, 'utf8') : null;
}

export function compare(there) {
  const same = [];
  const differs = [];
  const missing = [];
  for (const file of SHARED) {
    const mine = read(HERE, file);
    const theirs = read(there, file);
    if (mine === null || theirs === null) missing.push(file);
    else if (mine === theirs) same.push(file);
    else differs.push(file);
  }
  return { same, differs, missing };
}

/** Every neighbour that is actually checked out beside this one. */
export function neighbours() {
  return NEIGHBOURS.filter(([, at]) => existsSync(at));
}

if (process.argv[1] && process.argv[1].endsWith('sync-shared.js')) {
  const pull = process.argv.includes('--pull');
  const push = process.argv.includes('--push');
  const found = neighbours();

  if (!found.length) {
    // Not an error: a checkout of one game on its own is a perfectly good
    // checkout. There is simply nothing to compare against.
    console.log('SKIP: no websoccer or webtennis beside this one');
    process.exit(0);
  }

  let bad = 0;
  for (const [name, at] of found) {
    const { same, differs, missing } = compare(at);

    if (pull || push) {
      for (const file of differs) {
        const from = pull ? path.join(at, file) : path.join(HERE, file);
        const to = pull ? path.join(HERE, file) : path.join(at, file);
        writeFileSync(to, readFileSync(from));
        console.log(`${pull ? 'pulled from' : 'pushed to'} ${name}: ${file}`);
      }
      if (!differs.length) console.log(`nothing to copy: ${name} already matches`);
      // Pulling from the first neighbour changes what the second is compared
      // against, which is the point: the three are meant to converge.
      continue;
    }

    console.log(`Shared with ${name}: ${same.length} of ${SHARED.length} files identical`);
    for (const file of missing) console.log(`  MISSING  ${file}`);
    for (const file of differs) console.log(`  DIFFERS  ${file}`);
    bad += differs.length + missing.length;
  }

  if (pull || push) process.exit(0);

  if (bad) {
    console.error('');
    console.error('FAIL: the shared files have drifted apart. Look at the difference, decide');
    console.error('which side is right, then run this with --pull or --push.');
    process.exit(1);
  }
  console.log('OK: all three games are running the same plumbing underneath');
}
