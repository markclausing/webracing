// End-to-end network test without a browser.
//
//   node tools/netcheck.js
//
// Starts the real relay, connects four real clients, has them race a whole race
// against each other with scripted input, and then checks that all four machines
// simulated the exact same race. That is what lockstep stands or falls on, and
// with four players there is three times as much of it to go wrong as there was
// in the two-player games this came from.
//
// The two things it is really looking for are the ones that only appear with
// more than two: that a message is delivered to everybody in the room rather
// than to "the other one", and that the seat a message came from is the seat the
// relay says it came from rather than the seat the sender claims.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRace, hashState } from '../src/game/state.js';
import { step } from '../src/game/sim.js';
import { Signal } from '../src/net/signal.js';
import { OnlineTransport } from '../src/net/transport.js';
import { bendAhead, pointAt } from '../src/game/path.js';
import { BTN, MAX_CARS, TOP_SPEED } from '../src/constants.js';

const PORT = 5199;
const HOOK_PORT = 5198;
const TICKS = 60 * 45; // 45 seconds of racing, which is about a whole race
const SCORES_FILE = join(tmpdir(), `webracing-scores-${process.pid}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(ok, message) {
  if (ok) {
    console.log(`OK: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failed = true;
  }
}

/**
 * A stand-in driver, good enough to get round.
 *
 * Deliberately not the game's own CPU driver, even though it is right there:
 * that one draws on `state.rng`, and a peer that called it for its own seat
 * alone would consume a random number the other three did not. The whole point
 * of this test is that four machines stay identical, and the test must not be
 * the thing that pulls them apart.
 *
 * So this reads the state and never writes to it, and the `wander` is a function
 * of the tick rather than of a die - which also means all four cars drive
 * differently without any of them being unpredictable.
 */
function autopilot(state, seat, tick) {
  const car = state.cars[seat];
  if (!car) return 0;
  const { path } = state.track;
  const speed = Math.hypot(car.vx, car.vy);
  const look = 90 + 90 * Math.min(1, speed / TOP_SPEED);
  const wander = Math.sin(tick / 45 + seat * 1.7) * 26;

  const aim = pointAt(path, car.along + look);
  const want = Math.atan2(
    (aim.y + aim.tx * wander) - car.y,
    (aim.x - aim.ty * wander) - car.x,
  );
  let diff = want - car.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  // Pointing the wrong way and barely moving: back out of it rather than sawing
  // at the wheel at something behind the car. The game's own driver does the
  // same thing, and without it one car in a handful of runs sits against a
  // cushion for the whole race and the test blames the network for it.
  if (Math.abs(diff) > 2.2 && speed < 60) {
    return BTN.DOWN | (diff > 0 ? BTN.LEFT : BTN.RIGHT);
  }

  let mask = 0;
  if (diff > 0.04) mask |= BTN.RIGHT;
  else if (diff < -0.04) mask |= BTN.LEFT;

  const bend = bendAhead(path, car.along + 20, Math.max(90, look * 1.5));
  const target = Math.max(TOP_SPEED * 0.25, TOP_SPEED * (1 - bend * 0.85));
  if (speed > target * 1.05) mask |= BTN.DOWN;
  else mask |= BTN.UP;
  return mask;
}

/** The device the transport reads, wired to the autopilot for one seat. */
function scriptedDevice(peer) {
  return {
    tick: 0,
    mask() {
      return autopilot(peer.state, peer.seat, this.tick);
    },
  };
}

async function waitFor(check2, what, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check2()) return; // await: an async check returns a Promise, always truthy
    await sleep(10);
  }
  throw new Error(`Timed out: ${what}`);
}

function makePeer(signal, seat, opts) {
  const humans = new Array(MAX_CARS).fill(false);
  for (let i = 0; i < opts.cars; i++) humans[i] = true;
  const peer = { seat, state: createRace({ ...opts, humans }) };
  peer.devices = scriptedDevice(peer);
  peer.transport = new OnlineTransport({
    signal, devices: peer.devices, seats: opts.cars, localSeat: seat,
  });
  return peer;
}

async function runPeer(peer) {
  let spins = 0;
  while (peer.state.tick < TICKS && peer.state.phase !== 'over') {
    const tick = peer.state.tick;
    peer.devices.tick = tick;
    peer.transport.sample(tick);

    if (!peer.transport.ready(tick)) {
      if (++spins > 6000) throw new Error(`Seat ${peer.seat} stuck on tick ${tick}`);
      await sleep(1); // wait for whoever has not sent yet
      continue;
    }
    spins = 0;
    step(peer.state, peer.transport.poll(tick));
    peer.transport.afterStep(peer.state);

    // The real loop waits on the display; here we just give the network some air.
    if (tick % 16 === 0) await sleep(0);
  }
}

async function main() {
  // Discord, for the length of this test: a server that writes down what it was
  // told. The relay should post here the moment a record lands.
  const announced = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        announced.push(JSON.parse(body));
      } catch { /* not our message */ }
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => hook.listen(HOOK_PORT, r));

  const server = spawn(process.execPath, ['server/relay.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      QUIET: '1',
      SCORES_FILE,
      DISCORD_WEBHOOK: `http://localhost:${HOOK_PORT}/hook`,
      GAME_URL: 'http://example.invalid/webracing',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.resume();

  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/index.html`);
        return res.ok;
      } catch {
        return false;
      }
    }, 'server did not start');
    console.log(`OK: relay is up on port ${PORT} and serving the page`);

    const url = `ws://localhost:${PORT}`;
    const peers = [];
    const opts = { seed: 4242, track: 'breakfast', laps: 3, cars: 4 };

    // --- The room fills up --------------------------------------------------

    const hostSignal = new Signal(url);
    let code = null;
    let hostSeat = -1;
    let roster = [];
    hostSignal.on('room', (m) => {
      code = m.code;
      hostSeat = m.seat;
      roster = m.seats;
    });
    hostSignal.on('peer', (m) => { roster = m.seats; });
    hostSignal.create();

    await waitFor(() => code !== null, 'the host never received a room code');
    check(hostSeat === 0, `whoever opens the room takes the first seat (code ${code})`);

    const guests = [];
    for (let i = 1; i < 4; i++) {
      const signal = new Signal(url);
      const guest = { signal, seat: -1, started: null };
      signal.on('room', (m) => { guest.seat = m.seat; });
      signal.on('start', (m) => { guest.started = m; });
      signal.join(code);
      guests.push(guest);
      // One at a time, so the seats are handed out in a knowable order.
      await waitFor(() => guest.seat >= 0, `guest ${i} never got a seat`);
    }

    check(guests.map((g) => g.seat).join(',') === '1,2,3',
      'seats are handed out in order as people arrive');
    await waitFor(() => roster.filter(Boolean).length === 4,
      'the host was never told the room was full');
    check(roster.every(Boolean), 'and everybody in the room is told who else is in it');

    // A fifth is turned away rather than quietly given somebody else's car.
    const spare = new Signal(url);
    let refused = null;
    spare.on('error', (m) => { refused = m.msg; });
    spare.join(code);
    await waitFor(() => refused !== null, 'a fifth player was not turned away');
    check(/full/i.test(refused), `a fifth player is refused ("${refused}")`);
    spare.close();

    // --- The lights ---------------------------------------------------------

    hostSignal.send({ t: 'start', ...opts });
    peers[0] = makePeer(hostSignal, hostSeat, opts);
    await waitFor(() => guests.every((g) => g.started), 'not everybody was told to start');
    check(guests.every((g) => g.started.seed === opts.seed && g.started.track === opts.track),
      'the start goes to all three guests with the same seed and table');
    check(guests.every((g) => g.started.seat === 0),
      'and it is stamped with the seat it came from, not one the sender chose');
    for (const guest of guests) peers[guest.seat] = makePeer(guest.signal, guest.seat, opts);

    // --- The race -----------------------------------------------------------

    const t0 = Date.now();
    await Promise.all(peers.map(runPeer));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const ticks = peers.map((p) => p.state.tick);
    const hashes = peers.map((p) => hashState(p.state));
    console.log(`     ${Math.min(...ticks)} ticks raced by four players in ${secs}s of real time`);
    console.log(`     places     : ${peers.map((p) => p.state.cars.map((c) => c.place).join('')).join('  ')}`);
    console.log(`     stalls     : ${peers.map((p) => p.transport.stalls).join(', ')} `
      + '(high is expected: this test runs flat out, a browser runs at 60 fps)');
    console.log(`     input delay: ${peers.map((p) => p.transport.delay).join(', ')} ticks`);
    console.log(`     pongs      : ${peers.map((p) => p.transport.pongs).join(', ')}`);

    check(new Set(hashes).size === 1,
      `all four players computed the same race (hash ${hashes[0]})`);
    check(peers.every((p) => !p.transport.desync),
      'and the built-in desync check never fired');
    check(peers.every((p) => p.transport.pongs > 0),
      'ping and pong get through in every direction');
    check(peers.every((p) => p.state.cars.every((c) => c.lap >= 1)),
      'every car got off the grid and over the line');
    // Whether a clean lap happened at all depends on how the scripted drivers
    // got on, which is not what this test is about. That all four machines agree
    // about it is.
    const fastest = peers.map((p) => (p.state.best
      ? `${p.state.best.seat}@${p.state.best.ticks}` : 'none'));
    check(new Set(fastest).size === 1,
      `all four agree on the fastest lap of the race (${fastest[0]})`);

    // --- Somebody closes their tab ------------------------------------------
    //
    // Three people must not lose their race because a fourth had to answer the
    // door. Their car carries on with nothing pressed, which every machine does
    // identically, so the race stays in step.
    guests[2].signal.close();
    await waitFor(() => peers[0].transport.gone.includes(3),
      'the others were never told seat 3 had gone');
    check(peers[0].transport.gone.includes(3), 'a player leaving is reported by seat');
    const before = peers[0].state.tick;
    for (let i = 0; i < 120; i++) {
      const tick = peers[0].state.tick;
      peers[0].transport.sample(tick);
      if (!peers[0].transport.ready(tick)) break;
      step(peers[0].state, peers[0].transport.poll(tick));
      peers[0].transport.afterStep(peers[0].state);
    }
    check(peers[0].state.tick > before,
      'and the race carries on without waiting for them');

    for (const peer of peers) peer.transport.dispose();

    // --- The shared board ---------------------------------------------------
    //
    // Two devices, neither of which has seen the other's laps. Both post their
    // own board; both must come away with the same one.
    const boardUrl = `http://localhost:${PORT}/highscores`;
    const post = async (board) => {
      const res = await fetch(boardUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board }),
      });
      return (await res.json()).board;
    };
    const row = (id, name, ms, at) => ({ id, name, ms, at });

    const LIST = 'breakfast:hard';
    const afterPhone = await post({ [LIST]: [row('p1', 'AAA', 14200, 1000)] });
    const afterLaptop = await post({ [LIST]: [row('l1', 'BBB', 13100, 2000)] });

    check(afterPhone[LIST].length === 1,
      'the first device is not sent laps it should not have seen yet');
    check(afterLaptop[LIST].length === 2,
      'two devices post their own boards and end up with one');
    check(afterLaptop[LIST][0].name === 'BBB',
      'and the quicker lap is at the top of it');

    const junk = await post({
      [LIST]: [row('bad1', 'ZZZ', 12, 3000), { id: 'bad2', name: 'X' }, 'nonsense'],
    });
    check(junk[LIST].length === 2, 'the server refuses impossible laps and nonsense rows');

    // A browser that has not been opened since the board was one list per table.
    const legacy = await post({ breakfast: [row('old', 'M-A', 11767, 4000)] });
    check(legacy['breakfast:normal']?.[0]?.name === 'M-A',
      'a lap from the old one-list-per-table board is kept, under NORMAL');

    // Three records landed: two devices' own laps and one from the old board
    // shape. Waiting for two and then asserting three is a race the test loses
    // about half the time.
    await waitFor(() => announced.length >= 3, 'the relay never posted to the webhook', 4000);
    const said = announced.map((a) => a.embeds?.[0]?.description || '').join(' ');
    check(/AAA/.test(said) && /BBB/.test(said),
      'both new records are announced, by name');
    check(/0:13\.10/.test(said), 'with the lap time written the way the game writes it');
    check(/breakfast table/.test(said), 'and the table they were set on');
    check(announced.every((a) => a.username === 'WebRacing' && a.embeds?.[0]?.url),
      'each post names the game and links to it, because three games share a channel');
    check(announced.length === 3, `once each, not more (${announced.length} posts)`);

    const stored = await (await fetch(boardUrl)).json();
    check(stored.board['breakfast:hard'].length === 2,
      'and the board is kept on disk and readable');

    process.exitCode = failed ? 1 : 0;
    console.log('');
    console.log(failed ? 'NETCHECK FAILED' : 'NETCHECK PASSED');
  } finally {
    server.kill();
    hook.close();
    try {
      rmSync(SCORES_FILE, { force: true });
    } catch { /* nothing to clean up */ }
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
