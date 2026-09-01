// Screenshots for the README, taken by a browser rather than by hand.
//
//   node tools/screenshot.js
//
// Starts the relay, drives a headless Chrome over the DevTools protocol, plays a
// real race in it and photographs the interesting moments. No dependencies: the
// protocol is JSON over a WebSocket, and Node has had one of those for a while.
//
// It is a tool rather than a test, but it is worth keeping in the repository for
// the same reason the tests are - a screenshot taken by hand is out of date the
// day after somebody changes the colour of the road, and one that can be retaken
// with a single command tends actually to be retaken.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
// Out of the way of the repository: a browser profile is a few thousand files
// and none of them belong next to the game.
const PROFILE = path.join(tmpdir(), `webracing-shots-${process.pid}`);
const PORT = 5177;
const CDP_PORT = 9333;
// A board of its own. Without this the tool posts its laps into whatever
// highscores.json is sitting next to a real server, and photographs them.
const SCORES = path.join(tmpdir(), `webracing-shots-scores-${process.pid}.json`);

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The DevTools protocol, which is a WebSocket you send numbered messages down. */
class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.waiting = new Map();
    socket.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      const pending = this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    };
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('could not open the DevTools socket'));
    });
    return new Devtools(socket);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs an expression in the page and hands back its value. */
  async run(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description
        || res.exceptionDetails.text || 'the page threw');
    }
    return res.result.value;
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  docs/screenshots/${name}.png`);
  }

  async size(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile,
    });
    // The game reads `(pointer: coarse)` to decide whether to put the on-screen
    // controls up. The device metrics override alone does not set that, and
    // neither does setEmitTouchEventsForMouse - it takes real touch emulation,
    // which is why the first phone screenshots came out with no controls on them.
    await this.send('Emulation.setTouchEmulationEnabled', {
      enabled: mobile, maxTouchPoints: mobile ? 5 : 1,
    });
    await this.send('Emulation.setEmitTouchEventsForMouse', {
      enabled: mobile, configuration: mobile ? 'mobile' : 'desktop',
    });
  }
}

/**
 * Runs the race forward without waiting for it in real time.
 *
 * The page's own loop is driven by requestAnimationFrame, which in a headless
 * browser runs when it feels like it. Stepping the simulation by hand and
 * letting the loop draw whatever it finds is both quicker and repeatable - and
 * it is only possible because the simulation is a pure function of its state,
 * which is the same property the netcode is built on.
 */
/**
 * A stand-in driver for the player's car, installed in the page.
 *
 * Not the game's own CPU driver, which draws on `state.rng`: stepping the race
 * by hand already puts this out of step with a real session, and there is no
 * reason to disturb the other three cars as well. This one reads the state and
 * never writes to it.
 */
const DRIVER = `window.__drive = async () => {
  const { pointAt, bendAhead } = await import('/src/game/path.js');
  const { BTN, TOP_SPEED } = await import('/src/constants.js');
  return (state, seat, override) => {
    const car = state.cars[seat];
    if (!car) return 0;
    const { path } = state.track;
    const speed = Math.hypot(car.vx, car.vy);
    const look = 100 + 100 * Math.min(1, speed / TOP_SPEED);
    const aim = pointAt(path, car.along + look);
    let diff = Math.atan2(aim.y - car.y, aim.x - car.x) - car.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (override) return override.reduce((m, b) => m | BTN[b], 0);
    let mask = diff > 0.04 ? BTN.RIGHT : diff < -0.04 ? BTN.LEFT : 0;
    const bend = bendAhead(path, car.along + 20, Math.max(90, look * 1.5));
    const target = Math.max(TOP_SPEED * 0.28, TOP_SPEED * (1 - bend * 0.85));
    return mask | (speed > target * 1.05 ? BTN.DOWN : BTN.UP);
  };
}`;

function advance(ticks, override = null) {
  return `(async () => {
    const g = window.__game;
    const { step } = await import('/src/game/sim.js');
    const drive = await window.__drive();
    for (let i = 0; i < ${ticks} && g.state && g.state.phase !== 'over'; i++) {
      const inputs = g.transport.poll(g.state.tick);
      inputs[g.seat] = drive(g.state, g.seat, ${JSON.stringify(override)});
      step(g.state, inputs);
    }
    return g.state ? g.state.phase : 'menu';
  })()`;
}

/** Runs until the race reaches a phase, or gives up. */
function until(phase) {
  return `(async () => {
    const g = window.__game;
    const { step } = await import('/src/game/sim.js');
    const drive = await window.__drive();
    let guard = 0;
    while (g.state && g.state.phase !== '${phase}' && guard++ < 60 * 400) {
      const inputs = g.transport.poll(g.state.tick);
      inputs[g.seat] = drive(g.state, g.seat, null);
      step(g.state, inputs);
    }
    return g.state ? g.state.phase : 'menu';
  })()`;
}

/** Types into the three-letter name entry the way a person would. */
function type(keys) {
  return `(() => {
    for (const key of ${JSON.stringify(keys)}) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    return true;
  })()`;
}

async function main() {
  if (!CHROME) throw new Error('no Chrome found; set CHROME=/path/to/chrome');
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });

  const relay = spawn(process.execPath, ['server/relay.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), QUIET: '1', SCORES_FILE: SCORES,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    // Without these two it starts and then quietly never opens the debugging
    // port, which looks exactly like it never started at all.
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let dev = null;
  try {
    let target = null;
    for (let i = 0; i < 120 && !target; i++) {
      await sleep(100);
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('headless Chrome never answered');
    await fetch(`http://localhost:${PORT}/index.html`);

    dev = await Devtools.open(target.webSocketDebuggerUrl);
    await dev.send('Page.enable');
    await dev.send('Runtime.enable');

    // --- The menu -----------------------------------------------------------
    console.log('menu');
    await dev.size(1280, 800);
    await dev.send('Page.navigate', { url: `http://localhost:${PORT}/` });
    await sleep(1600);
    await dev.run(DRIVER);
    await dev.run("document.getElementById('track').value = 'pool';"
      + "document.getElementById('track').dispatchEvent(new Event('change'));");
    await sleep(700);
    await dev.shot('menu');

    // --- A race, at four moments --------------------------------------------
    console.log('a race on the pool table');
    await dev.run("document.getElementById('start').click()");
    await sleep(500);
    await dev.run(advance(120));
    await sleep(400);
    await dev.shot('countdown');

    // Far enough in that the field has spread out and there is rubber on the road.
    await dev.run(advance(640));
    await sleep(400);
    await dev.shot('gameplay');

    // Hard over and on the brake, which is what a slide looks like.
    await dev.run(advance(24, ['UP', 'LEFT', 'DOWN']));
    await sleep(400);
    await dev.shot('slide');

    await dev.run(until('finish'));
    await dev.run(advance(60));
    await sleep(400);
    await dev.shot('finish');

    // --- Records, and the board they land on --------------------------------
    //
    // Three laps rather than one, so the board in the picture is a board rather
    // than a single row. They are laps this tool actually drove: nothing is
    // written onto the board that was not raced for.
    console.log('setting lap records');
    for (const [i, name] of [['M', 'J', 'C'], ['A', 'C', 'E'], ['B', 'O', 'T']].entries()) {
      if (i > 0) {
        await dev.run("document.getElementById('start').click()");
        await sleep(400);
        await dev.run(DRIVER);
      }
      await dev.run(until('over'));
      await sleep(700); // the page's own loop notices and puts the picker up
      const picking = await dev.run(
        "!document.getElementById('hiscore').classList.contains('hidden')",
      );
      if (!picking) {
        console.log(`  (no record offered on run ${i + 1})`);
        continue;
      }
      if (i === 0) await dev.shot('record');
      await dev.run(type(name));
      await sleep(250);
      await dev.run(type(['Enter']));
      await sleep(1000);
    }
    await dev.run("document.getElementById('scoresBox').open = true;"
      + "document.getElementById('controlsBox').open = false;"
      + "document.getElementById('scoresBox').scrollIntoView();");
    await sleep(700);
    await dev.shot('records');

    // --- A phone ------------------------------------------------------------
    console.log('a phone');
    await dev.size(390, 844, true);
    await dev.send('Page.navigate', { url: `http://localhost:${PORT}/` });
    await sleep(1600);
    await dev.run(DRIVER);
    await dev.run("document.getElementById('start').click()");
    await sleep(500);
    await dev.run(advance(700));
    await sleep(400);
    await dev.shot('mobile');

    console.log('done');
  } finally {
    dev?.socket.close();
    chrome.kill();
    relay.kill();
    rmSync(PROFILE, { recursive: true, force: true });
    rmSync(SCORES, { force: true });
  }
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
