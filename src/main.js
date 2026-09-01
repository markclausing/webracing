/**
 * The page: menu, race loop, and the wiring between the two.
 *
 * The loop is the same fixed-timestep arrangement as websoccer and webtennis,
 * talking to a transport that is either local or online, and the simulation
 * never knows which. That part is shared code; what is here is this game's own.
 */

import { FRAME_TIME, MAX_CARS, TOP_SPEED } from './constants.js';
import {
  ACTIONS, InputDevices, PRESETS, findConflicts, keyLabel, loadBindings, saveBindings,
} from './input.js';
import { isTouchDevice } from './touch.js';
import { TouchDrive } from './touchdrive.js';
import { createRace, formatLap, lapMs } from './game/state.js';
import { step } from './game/sim.js';
import { TRACKS, loadTrack, trackByKey } from './game/tracks.js';
import { Renderer } from './render/renderer.js';
import { AudioEngine, Chiptune, Engine, Sfx } from './audio.js';
import { Speech } from './speech.js';
import * as commentary from './commentary.js';
import { Highscores, makeId, placeOf } from './highscores.js';
import { NameEntry } from './nameEntry.js';
import { boardFor, relayFor } from './config.js';
import { Signal } from './net/signal.js';
import { LocalTransport, OnlineTransport } from './net/transport.js';

const canvas = document.getElementById('table');
const menu = document.getElementById('menu');
const pauseBox = document.getElementById('pause');
const netendBox = document.getElementById('netend');
const hiscoreBox = document.getElementById('hiscore');
const onlineStatus = document.getElementById('onlineStatus');
const roomCode = document.getElementById('roomCode');
const lobbyBox = document.getElementById('lobby');
const goButton = document.getElementById('go');

const audio = new AudioEngine();
const music = new Chiptune(audio);
const motor = new Engine(audio);
const speech = new Speech(audio, commentary);
const sfx = new Sfx(audio, speech);
// Its own key, like the record board: the other two games are on this domain
// too, and they do not even mean the same thing by the same buttons.
const KEYS_STORAGE = 'webracing.bindings';
const bindings = loadBindings(KEYS_STORAGE);
const devices = new InputDevices(bindings);
// Without this nothing is listening to the keyboard at all - the lights go
// green, and then four cars sit there with the handbrake on.
devices.attach();
const touch = new TouchDrive();
const renderer = new Renderer(canvas);
const highscores = new Highscores(globalThis.localStorage);

let soundOn = globalThis.localStorage?.getItem('webracing.sound') !== 'off';
sfx.talking = globalThis.localStorage?.getItem('webracing.talk') !== 'off';
audio.enabled = soundOn;

const onTouchDevice = isTouchDevice();
if (onTouchDevice) {
  touch.attach({
    root: document.getElementById('touch'),
    stick: document.getElementById('stick'),
    knob: document.getElementById('knob'),
    gas: document.getElementById('btnGas'),
    brake: document.getElementById('btnBrake'),
  });
  devices.touch = touch;
}

const game = {
  state: null,
  transport: null,
  signal: null,
  seat: 0,
  // Which list a lap set in this race belongs on: the CPU setting, or 'online'.
  // Kept here rather than in the state, because the simulation has no opinion
  // about it - four identical cars race the same way whoever is driving them.
  tier: 'normal',
  humans: [],
  paused: false,
  acc: 0,
  last: performance.now(),
  ended: false,
};
window.__game = game;

// --- Who is driving what -----------------------------------------------------

/**
 * Which seats a person is sitting in on this machine.
 *
 * Two of them come off the keyboard, and any gamepad plugged in past those two
 * gets a seat of its own. That falls out of how InputDevices works rather than
 * being arranged here: slots 0 and 1 have key bindings and read a gamepad as
 * well, slots 2 and 3 have no bindings at all and are gamepad-only. So a lone
 * pad shares a car with the keyboard, and a third and fourth pad bring their own.
 */
function localSeats(keyboardPlayers) {
  const seats = [];
  for (let i = 0; i < keyboardPlayers; i++) seats.push(i);
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = keyboardPlayers; i < MAX_CARS; i++) {
    if (pads && pads[i]) seats.push(i);
  }
  return seats;
}

const CAR_NAMES = ['RED', 'BLUE', 'GREEN', 'YELLOW'];

function describeSeats(seats) {
  if (!seats.length) return '';
  const names = seats.map((s) => CAR_NAMES[s]).join(', ');
  return seats.length === 1 ? `You are ${names}.` : `${names} are people; the rest is the CPU.`;
}

// --- Starting and stopping ---------------------------------------------------

function beginRace(state, transport, seat) {
  game.state = state;
  game.transport = transport;
  game.seat = seat;
  game.paused = false;
  game.ended = false;
  game.acc = 0;
  game.last = performance.now();
  menu.classList.add('hidden');
  pauseBox.classList.add('hidden');
  netendBox.classList.add('hidden');
  canvas.focus();
  renderer.reset();
  if (onTouchDevice) {
    touch.show(true);
    // Leave the bottom of the screen to the controls, in canvas pixels - which
    // are not CSS pixels on a phone.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    renderer.bottomInset = 168 * dpr;
  }
  music.stop();
  if (soundOn) motor.start();
  sizeCanvas();
}

function startLocal({ players }) {
  const seats = localSeats(players);
  const humans = new Array(MAX_CARS).fill(false);
  for (const seat of seats) humans[seat] = true;
  const state = createRace({
    seed: (Date.now() & 0x7fffffff) || 1,
    track: trackKey,
    laps: lapCount(),
    humans,
    difficulty,
  });
  game.humans = seats;
  game.tier = difficulty;
  beginRace(state, new LocalTransport(devices, seats), seats[0] ?? 0);
}

function startOnline(opts) {
  const humans = new Array(MAX_CARS).fill(false);
  for (let i = 0; i < opts.cars; i++) humans[i] = true;
  const state = createRace({
    seed: opts.seed,
    track: opts.track,
    laps: opts.laps,
    cars: opts.cars,
    humans,
  });
  game.humans = [opts.seat];
  game.tier = 'online';
  beginRace(state, new OnlineTransport({
    signal: opts.signal, devices, seats: opts.cars, localSeat: opts.seat,
  }), opts.seat);
}

function toMenu() {
  if (game.transport) game.transport.dispose();
  else if (game.signal) game.signal.close();
  motor.stop();
  game.state = null;
  game.transport = null;
  game.signal = null;
  menu.classList.remove('hidden');
  pauseBox.classList.add('hidden');
  netendBox.classList.add('hidden');
  touch.show(false);
  renderer.bottomInset = 0;
  if (soundOn) music.start();
  setOnlineStatus('');
  roomCode.classList.add('hidden');
  lobbyBox.classList.add('hidden');
  goButton.classList.add('hidden');
  document.getElementById('host').disabled = false;
}

// --- The loop ----------------------------------------------------------------

function sizeCanvas() {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}
addEventListener('resize', sizeCanvas);

function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = Math.min(0.25, (now - game.last) / 1000);
  game.last = now;

  if (!game.state) {
    drawTitle();
    return;
  }

  if (pending.open) {
    nameEntry.step(devices.mask(0));
    renderer.draw(game.state, { seat: game.seat, net: netInfo(), quiet: true });
    return;
  }

  if (!game.paused) {
    game.acc += elapsed;
    let guard = 0;
    while (game.acc >= FRAME_TIME / 1000 && guard < 8) {
      const tick = game.state.tick;
      // The wheel decides what to press this tick before anybody reads it. It
      // sends a fraction of the ticks rather than all of them, which is how one
      // bit of steering comes out as half a turn of lock.
      touch.advance();
      game.transport.sample(tick);
      if (!game.transport.ready(tick)) break;
      const inputs = game.transport.poll(tick);
      step(game.state, inputs);
      game.transport.afterStep(game.state);
      sfx.play(game.state.events, {
        seat: game.seat, laps: game.state.config.laps, lines: commentaryLines(),
      });
      shakeOn(game.state.events);
      game.acc -= FRAME_TIME / 1000;
      guard++;
    }
    if (guard >= 8 || game.acc > (FRAME_TIME / 1000) * 8) {
      game.acc = Math.min(game.acc, (FRAME_TIME / 1000) * 8);
    }
  }

  drive();
  renderer.draw(game.state, { seat: game.seat, net: netInfo() });
  checkNetEnd();

  if (game.state.phase === 'over' && !game.transport.online) {
    if (offerRecord()) return;
    if (devices.isDown('Enter') || devices.isDown('Space')) toMenu();
  }
}

/** The engine note, which is your car and nobody else's. */
function drive() {
  const car = game.state.cars[game.seat];
  if (!car) return;
  const speed = Math.hypot(car.vx, car.vy) / TOP_SPEED;
  motor.update(car.mode === 'run' ? speed : 0, car.throttle, car.mode === 'run' ? car.slide : 0);
}

function shakeOn(events) {
  for (const e of events) {
    if ((e.type === 'bump' && (e.seat === game.seat || e.other === game.seat))
      || (e.type === 'wall' && e.seat === game.seat)) {
      renderer.knock(e.hard);
    }
  }
}

/**
 * The four lines the commentator is allowed to say, worked out per frame.
 *
 * Built here rather than in audio.js, which knows how to make a noise and
 * nothing about who is winning. The synthesiser is shared with the other two
 * games; the words are this one's own.
 */
function commentaryLines() {
  const state = game.state;
  const winner = state.order[0];
  const you = state.cars[game.seat];
  return {
    go: 'go',
    record: state.best ? commentary.lapCall(state.best.seat) : '',
    win: winner === undefined ? '' : commentary.winCall(winner),
    you: you && you.finished ? commentary.placeCall(game.seat, you.place) : '',
  };
}

function netInfo() {
  const t = game.transport;
  if (!t || !t.online) return null;
  return {
    online: true, ping: t.ping, stalling: t.stalling, desync: t.desync, gone: t.gone,
  };
}

function checkNetEnd() {
  const t = game.transport;
  if (!t || !t.online || game.ended) return;
  const finished = game.state.phase === 'over';
  const everybodyLeft = t.gone.length >= t.seats - 1;
  if (!everybodyLeft && !t.desync && !finished) return;
  game.ended = true;
  document.getElementById('netendTitle').textContent = t.desync ? 'DESYNC'
    : everybodyLeft ? 'EVERYBODY LEFT' : 'RACE OVER';
  document.getElementById('netendText').textContent = t.desync
    ? 'The players computed a different race. It has been stopped.'
    : everybodyLeft ? 'There is nobody else left in the room.'
      : resultLine(game.state);
  netendBox.classList.remove('hidden');
  // A record set online is still your lap, and the board should have it.
  offerRecord();
}

function resultLine(state) {
  const you = state.cars[game.seat];
  const best = state.best ? formatLap(lapMs(state.best.ticks)) : 'nobody';
  return `You finished ${you ? you.place : '?'} of ${state.cars.length}. `
    + `Fastest lap ${best}.`;
}

let titleTick = 0;
function drawTitle() {
  sizeCanvas();
  titleTick++;
  const ctx = renderer.ctx;
  const table = renderer.table(loadTrack(trackKey));
  const track = trackByKey(trackKey);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = track.theme.floor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // The table the menu is standing on is the one you are about to race, drifting
  // slowly sideways. It costs nothing: the canvas is already drawn.
  const z = Math.max(canvas.width / table.width, canvas.height / table.height) * 1.08;
  const driftX = Math.sin(titleTick / 420) * (table.width * z - canvas.width) * 0.5;
  const driftY = Math.cos(titleTick / 560) * (table.height * z - canvas.height) * 0.5;
  ctx.globalAlpha = 0.75;
  ctx.drawImage(table,
    (canvas.width - table.width * z) / 2 + driftX,
    (canvas.height - table.height * z) / 2 + driftY,
    table.width * z, table.height * z);
  ctx.globalAlpha = 1;
}

// --- Lap records -------------------------------------------------------------

const pending = { open: false, entry: null, track: null, tier: 'normal' };

const nameEntry = new NameEntry(document.getElementById('hiscoreLetters'), (name) => {
  try {
    globalThis.localStorage?.setItem('webracing.name', name);
  } catch { /* private mode */ }
  const place = highscores.add(pending.track, pending.tier, { ...pending.entry, name });
  pending.open = false;
  hiscoreBox.classList.add('hidden');
  renderScores(pending.track, pending.tier, place);
  document.getElementById('scoresBox').open = true;
  toMenu();
  syncScores();
});

window.addEventListener('keydown', (e) => {
  if (!pending.open) return;
  if (nameEntry.type(e.key)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

/**
 * The quickest clean lap anybody sitting at this machine turned, if it is quick
 * enough for the board.
 *
 * One entry per race, whoever set it. Four people round one keyboard would
 * otherwise be asked for four sets of initials in a row, and three of them would
 * be for laps nobody was going to look at again.
 */
function bestLocalLap(state) {
  let best = null;
  for (const seat of game.humans) {
    const car = state.cars[seat];
    if (!car || car.best === null) continue;
    if (!best || car.best < best.ticks) best = { seat, ticks: car.best };
  }
  return best;
}

function offerRecord() {
  if (pending.open) return true;
  if (game.ended && !game.transport.online) return false;
  game.ended = true;

  const state = game.state;
  const lap = bestLocalLap(state);
  if (!lap) return false;

  const entry = {
    id: makeId(),
    name: lastName(),
    ms: lapMs(lap.ticks),
    at: Date.now(),
  };
  const track = state.config.track;
  if (!highscores.qualifies(track, game.tier, entry)) return false;

  pending.entry = entry;
  pending.track = track;
  pending.tier = game.tier;
  pending.open = true;
  const who = game.humans.length > 1 ? `${CAR_NAMES[lap.seat]}, ` : '';
  document.getElementById('hiscoreLine').textContent
    = `${who}${formatLap(entry.ms)} round ${trackByKey(track).name} `
    + `${game.tier === 'online' ? 'online' : `against ${game.tier.toUpperCase()}`}: `
    + `number ${placeOf(highscores.table(track, game.tier), entry)}`;
  hiscoreBox.classList.remove('hidden');
  nameEntry.start(lastName());
  return true;
}

function lastName() {
  try {
    return globalThis.localStorage?.getItem('webracing.name') || 'AAA';
  } catch {
    return 'AAA';
  }
}

async function syncScores() {
  const url = boardFor(location);
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board: highscores.all() }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data?.board) return false;
    highscores.absorb(data.board);
    renderScores(trackKey, boardTier());
    return true;
  } catch {
    return false;
  }
}

/**
 * Which list the menu is showing, which is always the one you would be racing
 * for: the table you have picked, against the opponents you have picked.
 */
function boardTier() {
  return mode === 'online' ? 'online' : difficulty;
}

function renderScores(track, tier, freshPlace = 0) {
  const body = document.getElementById('scoresBody');
  document.getElementById('scoresLevel').textContent
    = `${trackByKey(track).name} · ${tier.toUpperCase()}`;
  body.innerHTML = '';
  const rows = highscores.table(track, tier);
  for (let i = 0; i < rows.length; i++) {
    const tr = document.createElement('tr');
    if (i + 1 === freshPlace) tr.className = 'fresh';
    for (const [cls, text] of [
      ['place', `${i + 1}`],
      ['name', rows[i].name],
      ['result', formatLap(rows[i].ms)],
      ['when', new Date(rows[i].at).toLocaleDateString()],
    ]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  document.getElementById('scoresNote').textContent = rows.length
    ? 'One clean lap. Falling off, being scooped up or going round the wrong way '
      + 'all void the lap you were on. The CPU setting does not touch your car - '
      + 'it changes the traffic, so each set of opponents keeps its own list.'
    : 'Nothing here yet. Turn a clean lap of this table against these opponents '
      + 'and the list is yours.';
}

// --- Changing the keys -------------------------------------------------------
//
// The same arrangement as the other two games, on the same shared input module.
// The labels are this game's own, because "kick or slide" means nothing here.

const KEY_LABELS = {
  up: 'Accelerate',
  down: 'Brake / reverse',
  left: 'Steer left',
  right: 'Steer right',
  fire: 'Accelerate (2nd)',
  switch: 'Brake (2nd)',
};

const keysBody = document.getElementById('keysBody');
const bindHint = document.getElementById('bindHint');
let listeningFor = null;

function setBindHint(text, warn = false) {
  bindHint.textContent = text;
  bindHint.classList.toggle('warn', warn);
}

function renderBindings() {
  const clashing = new Set();
  for (const clash of findConflicts(bindings)) {
    clashing.add(`${clash.a.slot}:${clash.a.action}`);
    clashing.add(`${clash.b.slot}:${clash.b.action}`);
  }

  keysBody.innerHTML = '';
  for (const action of ACTIONS) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = KEY_LABELS[action];
    row.appendChild(name);

    for (let slot = 0; slot < 2; slot++) {
      const cell = document.createElement('td');
      const button = document.createElement('button');
      const id = `${slot}:${action}`;
      const waiting = listeningFor && listeningFor.slot === slot && listeningFor.action === action;
      button.className = 'bind';
      button.dataset.bind = id;
      button.textContent = waiting ? 'press a key' : keyLabel(bindings[slot][action]);
      if (waiting) button.classList.add('listening');
      if (clashing.has(id)) button.classList.add('clash');
      button.addEventListener('click', () => {
        listeningFor = { slot, action };
        setBindHint('Press the key you want to use, or Escape to cancel.');
        renderBindings();
      });
      cell.appendChild(button);
      row.appendChild(cell);
    }
    keysBody.appendChild(row);
  }

  for (const select of document.querySelectorAll('[data-preset]')) {
    const slot = Number(select.dataset.preset);
    const current = PRESETS.find((p) => ACTIONS.every((a) => p.bindings[a] === bindings[slot][a]));
    select.innerHTML = '';
    for (const preset of PRESETS) {
      const option = document.createElement('option');
      option.value = preset.key;
      option.textContent = preset.label;
      if (current && current.key === preset.key) option.selected = true;
      select.appendChild(option);
    }
    if (!current) {
      const option = document.createElement('option');
      option.value = 'custom';
      option.textContent = 'Custom';
      option.selected = true;
      select.appendChild(option);
    }
  }

  if (clashing.size) {
    setBindHint('Those keys overlap. Fine on your own, but two players need separate keys.', true);
  } else if (!listeningFor) {
    setBindHint('Click a key to change it.');
  }
}

// Capture phase and always prevented: otherwise pressing Space would activate
// the button that still has focus and immediately ask for another key.
window.addEventListener('keydown', (e) => {
  if (!listeningFor) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') {
    listeningFor = null;
    renderBindings();
    return;
  }
  const { slot, action } = listeningFor;
  listeningFor = null;
  bindings[slot][action] = e.code;
  devices.setBindings(bindings);
  devices.down.clear(); // the key we just captured never gets a keyup we care about
  saveBindings(bindings, KEYS_STORAGE);
  renderBindings();
}, true);

for (const select of document.querySelectorAll('[data-preset]')) {
  select.addEventListener('change', () => {
    const preset = PRESETS.find((p) => p.key === select.value);
    if (!preset) return;
    bindings[Number(select.dataset.preset)] = { ...preset.bindings };
    devices.setBindings(bindings);
    saveBindings(bindings, KEYS_STORAGE);
    renderBindings();
  });
}

renderBindings();

// --- Menu --------------------------------------------------------------------

let mode = '1';
let difficulty = 'normal';
let trackKey = TRACKS[0].key;

function lapCount() {
  return Number(document.getElementById('laps').value) || 3;
}

function setOnlineStatus(text) {
  onlineStatus.textContent = text;
}

const trackSelect = document.getElementById('track');
for (const track of TRACKS) {
  const option = document.createElement('option');
  option.value = track.key;
  option.textContent = track.name;
  trackSelect.appendChild(option);
}
trackSelect.addEventListener('change', () => {
  trackKey = trackSelect.value;
  document.getElementById('trackBlurb').textContent = trackByKey(trackKey).blurb;
  renderScores(trackKey, boardTier());
});
document.getElementById('trackBlurb').textContent = trackByKey(trackKey).blurb;

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('difficultyRow').classList.toggle('hidden', mode === 'online');
    document.getElementById('onlineSetup').classList.toggle('hidden', mode !== 'online');
    document.getElementById('start').classList.toggle('hidden', mode === 'online');
    document.getElementById('host').classList.toggle('hidden', mode !== 'online');
    if (mode !== 'online') {
      goButton.classList.add('hidden');
      setOnlineStatus('');
    }
    showLocalSeats();
    renderScores(trackKey, boardTier());
  });
});

document.querySelectorAll('[data-difficulty]').forEach((btn) => {
  btn.addEventListener('click', () => {
    difficulty = btn.dataset.difficulty;
    document.querySelectorAll('[data-difficulty]').forEach((b) => b.classList.toggle('active', b === btn));
    renderScores(trackKey, boardTier());
  });
});

document.querySelectorAll('[data-sound]').forEach((btn) => {
  btn.classList.toggle('active', (btn.dataset.sound === 'on') === soundOn);
  btn.addEventListener('click', () => {
    soundOn = btn.dataset.sound === 'on';
    document.querySelectorAll('[data-sound]').forEach((b) => b.classList.toggle('active', b === btn));
    try {
      globalThis.localStorage?.setItem('webracing.sound', soundOn ? 'on' : 'off');
    } catch { /* private mode */ }
    audio.enabled = soundOn;
    if (soundOn) audio.wake();
    music.toggle(soundOn && !game.state);
  });
});

document.querySelectorAll('[data-talk]').forEach((btn) => {
  btn.classList.toggle('active', (btn.dataset.talk === 'on') === sfx.talking);
  btn.addEventListener('click', () => {
    sfx.talking = btn.dataset.talk === 'on';
    document.querySelectorAll('[data-talk]').forEach((b) => b.classList.toggle('active', b === btn));
    try {
      globalThis.localStorage?.setItem('webracing.talk', sfx.talking ? 'on' : 'off');
    } catch { /* private mode */ }
    if (sfx.talking) {
      audio.wake();
      sfx.call('fastest lap red', { force: true });
    }
  });
});

document.getElementById('start').addEventListener('click', () => {
  audio.wake();
  startLocal({ players: mode === '2' ? 2 : 1 });
});

/**
 * Says which cars have a person in them, and it earns its place: a gamepad
 * plugged in after the page loaded silently adds a third and fourth driver, and
 * nothing else on screen would say so.
 */
function showLocalSeats() {
  const line = document.getElementById('localSeats');
  if (mode === 'online') {
    line.textContent = '';
    return;
  }
  line.textContent = describeSeats(localSeats(mode === '2' ? 2 : 1));
}
addEventListener('gamepadconnected', showLocalSeats);
addEventListener('gamepaddisconnected', showLocalSeats);

// --- Online ------------------------------------------------------------------

let room = { seat: 0, host: false, seats: [] };

function connect() {
  if (game.signal) game.signal.close();
  const signal = new Signal(relayFor(location));
  game.signal = signal;
  signal.on('error', (m) => setOnlineStatus(m.msg || 'Connection error'));
  return signal;
}

/** Four boxes, filling up. Whoever opened the room decides when to go. */
function renderLobby() {
  lobbyBox.innerHTML = '';
  lobbyBox.classList.remove('hidden');
  room.seats.forEach((taken, i) => {
    const box = document.createElement('div');
    box.className = 'seat';
    box.textContent = taken ? CAR_NAMES[i] : '- - -';
    if (taken) {
      box.classList.add('taken');
      box.style.background = ['#e0453c', '#3d7fe0', '#4fbb46', '#f2c437'][i];
    }
    if (i === room.seat) box.classList.add('you');
    lobbyBox.appendChild(box);
  });
  const here = room.seats.filter(Boolean).length;
  if (room.host) {
    goButton.classList.remove('hidden');
    goButton.disabled = here < 2;
    goButton.textContent = here < 2 ? 'WAITING FOR SOMEBODY' : `START WITH ${here} CARS`;
  }
}

document.getElementById('host').addEventListener('click', () => {
  audio.wake();
  const signal = connect();
  signal.on('room', (m) => {
    room = { seat: m.seat, host: true, seats: m.seats };
    roomCode.textContent = m.code;
    roomCode.classList.remove('hidden');
    setOnlineStatus('Share this code. You can start as soon as one more is in.');
    renderLobby();
  });
  signal.on('peer', (m) => {
    if (game.state) return;
    room.seats = m.seats;
    renderLobby();
  });
  signal.on('peerleft', (m) => {
    if (game.state) return;
    room.seats = m.seats;
    renderLobby();
  });
  document.getElementById('host').disabled = true;
  signal.create();
});

goButton.addEventListener('click', () => {
  const signal = game.signal;
  if (!signal) return;
  // Seats are handed out in order and the pack is however many are in the room,
  // so a race of three is seats 0, 1 and 2 and there is no gap to reason about.
  const cars = room.seats.filter(Boolean).length;
  const seed = (Date.now() & 0x7fffffff) || 1;
  const opts = { seed, track: trackKey, laps: lapCount(), cars };
  signal.send({ t: 'start', ...opts });
  startOnline({ ...opts, seat: room.seat, signal });
});

document.getElementById('join').addEventListener('click', () => {
  audio.wake();
  const code = document.getElementById('joinCode').value.toUpperCase().trim();
  if (code.length < 4) {
    setOnlineStatus('Enter the four-character code.');
    return;
  }
  const signal = connect();
  signal.on('room', (m) => {
    room = { seat: m.seat, host: false, seats: m.seats };
    setOnlineStatus(`You are ${CAR_NAMES[m.seat]}. Waiting for the lights...`);
    renderLobby();
  });
  signal.on('peer', (m) => {
    if (game.state) return;
    room.seats = m.seats;
    renderLobby();
  });
  signal.on('peerleft', (m) => {
    if (game.state) return;
    room.seats = m.seats;
    renderLobby();
  });
  signal.on('start', (m) => {
    startOnline({
      seed: m.seed,
      track: m.track,
      laps: m.laps || 3,
      cars: m.cars || 2,
      seat: room.seat,
      signal,
    });
  });
  setOnlineStatus('Connecting...');
  signal.join(code);
});

document.getElementById('joinCode').addEventListener('keydown', (e) => e.stopPropagation());

// --- Odds and ends -----------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game.state && !game.transport.online) {
    game.paused = !game.paused;
    pauseBox.classList.toggle('hidden', !game.paused);
    if (game.paused) motor.stop();
    else if (soundOn) motor.start();
  }
});

document.getElementById('quit').addEventListener('click', toMenu);
document.getElementById('netendBack').addEventListener('click', toMenu);

const startMusicOnFirstGesture = () => {
  audio.wake();
  if (soundOn && !game.state) music.start();
  removeEventListener('pointerdown', startMusicOnFirstGesture);
  removeEventListener('keydown', startMusicOnFirstGesture);
};
addEventListener('pointerdown', startMusicOnFirstGesture);
addEventListener('keydown', startMusicOnFirstGesture);

showLocalSeats();
renderScores(trackKey, boardTier());
syncScores();
sizeCanvas();
requestAnimationFrame(frame);
