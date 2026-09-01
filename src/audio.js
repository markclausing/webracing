/**
 * The sound: an original chiptune, an engine, and the noises a toy car makes on
 * a kitchen table - all synthesised in the browser.
 *
 * Nothing is loaded; there is no audio file. A pulse wave carries the melody, a
 * second one runs a fast arpeggio underneath it, a triangle plays the bass and
 * filtered noise does the drums. That is how the sound chips of the era worked,
 * and it keeps the whole thing at a few kilobytes of source with no dependency
 * and no build step, in keeping with the rest of the project.
 *
 * The engine came with this game. It is the one sound here that is not an event
 * but a state: a sawtooth and a pulse a fifth apart, whose pitch is your speed
 * and whose filter is your throttle, running from the green light to the flag.
 * It is also the only readout of how fast you are going, because a speedometer
 * on a game about a toy car would be absurd and you can hear it anyway.
 */

const BPM = 168;
const STEP = 60 / BPM / 4; // one sixteenth note, in seconds
const BARS = 8;
const STEPS_PER_BAR = 16;
const TOTAL_STEPS = BARS * STEPS_PER_BAR;

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'A4' -> 440. Sharps as in 'F#4'. */
export function noteFreq(name) {
  const m = /^([A-G])(#?)(-?\d)$/.exec(name);
  if (!m) return 0;
  const midi = SEMITONES[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
}

// Em - C - G - D, twice: the four chords every driving tune of the period was
// built on, and they still pull forward.
const CHORDS = [
  { bass: 'E2', notes: ['E3', 'G3', 'B3'] },
  { bass: 'C2', notes: ['C3', 'E3', 'G3'] },
  { bass: 'G2', notes: ['G3', 'B3', 'D4'] },
  { bass: 'D2', notes: ['D3', 'F#3', 'A3'] },
  { bass: 'E2', notes: ['E3', 'G3', 'B3'] },
  { bass: 'C2', notes: ['C3', 'E3', 'G3'] },
  { bass: 'G2', notes: ['G3', 'B3', 'D4'] },
  { bass: 'D2', notes: ['D3', 'F#3', 'A3'] },
];

// Eight eighth-notes per bar, one bar per chord. A dash is a rest.
const MELODY = [
  ['E5', 'B4', 'E5', 'G5', 'F#5', 'E5', 'B4', '-'],
  ['C5', 'E5', 'G5', 'E5', 'D5', 'C5', 'G4', '-'],
  ['D5', 'G5', 'B5', 'A5', 'G5', 'D5', 'B4', '-'],
  ['A4', 'D5', 'F#5', 'A5', 'F#5', 'D5', 'A4', '-'],
  ['B5', 'G5', 'E5', 'G5', 'B5', 'E6', 'D6', '-'],
  ['C6', 'G5', 'E5', 'G5', 'C6', 'E6', 'D6', '-'],
  ['B5', 'D6', 'G6', 'D6', 'B5', 'G5', 'D5', '-'],
  ['A5', 'F#5', 'D5', 'F#5', 'A5', 'D6', 'C#6', '-'],
];

/** Per sixteenth: what the lead, arpeggio, bass and drums do. */
function buildTrack() {
  const lead = new Array(TOTAL_STEPS).fill(null);
  const arp = new Array(TOTAL_STEPS).fill(null);
  const bass = new Array(TOTAL_STEPS).fill(null);
  const drum = new Array(TOTAL_STEPS).fill(null);

  for (let bar = 0; bar < BARS; bar++) {
    const chord = CHORDS[bar];
    const phrase = MELODY[bar];

    for (let step = 0; step < STEPS_PER_BAR; step++) {
      const i = bar * STEPS_PER_BAR + step;

      if (step % 2 === 0) {
        const note = phrase[step / 2];
        if (note !== '-') lead[i] = { freq: noteFreq(note), dur: STEP * 1.8 };
      }

      // Arpeggio cycling the chord on every sixteenth: the trick that made three
      // voices sound like a full band.
      arp[i] = { freq: noteFreq(chord.notes[step % chord.notes.length]), dur: STEP * 0.9 };

      // A driving eighth-note bass rather than the football game's walking one.
      if (step % 2 === 0) bass[i] = { freq: noteFreq(chord.bass), dur: STEP * 1.7 };

      if (step === 0 || step === 6 || step === 10) drum[i] = 'kick';
      else if (step === 4 || step === 12) drum[i] = 'snare';
      else if (step % 2 === 0) drum[i] = 'hat';
    }
  }
  return { lead, arp, bass, drum, steps: TOTAL_STEPS, step: STEP };
}

export const TRACK = buildTrack();

/** A pulse wave of the given duty cycle, which is what gives it the bite. */
function pulseWave(ctx, duty, harmonics = 24) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * duty);
  }
  return ctx.createPeriodicWave(real, imag);
}

/**
 * One audio context shared by the tune, the engine and the effects. They have to
 * share it: the tune suspends nothing when it stops, or the engine would go with
 * it, and browsers hand out a limited number of contexts.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  /** Browsers only allow this from a click or a key press. */
  wake() {
    if (!this.ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return null; // no Web Audio: the game is perfectly playable in silence
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
      this.leadWave = pulseWave(this.ctx, 0.25);
      this.arpWave = pulseWave(this.ctx, 0.125);
      this.noise = this.makeNoise(0.4);
      this.longNoise = this.makeNoise(3.2); // the skid needs something to run on
    }
    this.ctx.resume?.();
    return this.ctx;
  }

  makeNoise(seconds) {
    const frames = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** A plain tone with a hard attack and a quick decay. */
  tone(freq, at, dur, wave, level) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    if (typeof wave === 'string') osc.type = wave;
    else osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
    return osc;
  }

  /** Filtered noise: everything percussive here is made of this. */
  noiseBurst(at, { freq, q = 1, dur, level, sweepTo = null, long = false, type = 'bandpass' }) {
    const src = this.ctx.createBufferSource();
    src.buffer = long ? this.longNoise : this.noise;
    if (long) src.loop = true;
    const band = this.ctx.createBiquadFilter();
    band.type = type;
    band.frequency.setValueAtTime(freq, at);
    band.Q.value = q;
    if (sweepTo) band.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + Math.min(0.04, dur / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(band).connect(gain).connect(this.master);
    src.start(at);
    src.stop(at + dur + 0.05);
    return gain;
  }
}

export class Chiptune {
  constructor(engine) {
    this.engine = engine;
    this.playing = false;
    this.timer = null;
    this.stepIndex = 0;
    this.nextStepTime = 0;
  }

  start() {
    if (this.playing) return;
    if (!this.engine.wake()) return;
    this.ctx = this.engine.ctx;
    this.master = this.engine.master;
    this.leadWave = this.engine.leadWave;
    this.arpWave = this.engine.arpWave;
    this.noise = this.engine.noise;
    this.playing = true;
    this.stepIndex = 0;
    this.nextStepTime = this.ctx.currentTime + 0.08;
    // Two clocks: a coarse timer that keeps topping up what the audio clock,
    // which is the accurate one, is going to play next.
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Deliberately not suspending the context: the engine and the crashes carry
    // on through it once the race has started.
  }

  toggle(on) {
    if (on) this.start();
    else this.stop();
  }

  schedule() {
    if (!this.playing) return;
    const lookahead = 0.25;
    while (this.nextStepTime < this.ctx.currentTime + lookahead) {
      this.playStep(this.stepIndex, this.nextStepTime);
      this.nextStepTime += TRACK.step;
      this.stepIndex = (this.stepIndex + 1) % TRACK.steps;
    }
  }

  playStep(i, at) {
    const lead = TRACK.lead[i];
    if (lead) this.tone(lead.freq, at, lead.dur, this.leadWave, 0.28);

    const arp = TRACK.arp[i];
    if (arp) this.tone(arp.freq, at, arp.dur, this.arpWave, 0.09);

    const bass = TRACK.bass[i];
    if (bass) this.tone(bass.freq, at, bass.dur, 'triangle', 0.42);

    const drum = TRACK.drum[i];
    if (drum === 'kick') this.kick(at);
    else if (drum === 'snare') this.hit(at, 1400, 0.16, 0.28);
    else if (drum === 'hat') this.hit(at, 7000, 0.04, 0.07);
  }

  tone(freq, at, dur, wave, level) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    if (typeof wave === 'string') osc.type = wave;
    else osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(freq, at);
    // Hard on, quick decay: no envelope knobs on those chips either.
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  kick(at) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    gain.gain.setValueAtTime(0.6, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + 0.16);
  }

  hit(at, freq, dur, level) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(band).connect(gain).connect(this.master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }
}

/**
 * The engine, and the tyres under it.
 *
 * Two oscillators a fifth apart through a lowpass, plus a loop of noise for the
 * tyres. All four values - pitch, filter, engine level, tyre level - are set
 * every frame from what the car is doing, so this is one long note that lasts
 * the whole race rather than a sound that gets triggered.
 *
 * A small buzz on the pitch is deliberate. A single steady oscillator does not
 * sound like an engine, it sounds like a test tone, and the difference between
 * the two is that nothing mechanical ever holds a note exactly.
 */
export class Engine {
  constructor(engine) {
    this.engine = engine;
    this.running = false;
    this.phase = 0;
  }

  start() {
    if (this.running) return;
    const ctx = this.engine.wake();
    if (!ctx) return;
    this.ctx = ctx;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 700;
    this.filter.Q.value = 3;
    this.filter.connect(this.gain).connect(this.engine.master);

    this.low = ctx.createOscillator();
    this.low.type = 'sawtooth';
    this.high = ctx.createOscillator();
    this.high.type = 'square';
    const mix = ctx.createGain();
    mix.gain.value = 0.35;
    this.low.connect(this.filter);
    this.high.connect(mix).connect(this.filter);
    this.low.start();
    this.high.start();

    // The tyres: a loop of noise through a band, opened only while sliding.
    this.tyres = ctx.createGain();
    this.tyres.gain.value = 0;
    this.tyreBand = ctx.createBiquadFilter();
    this.tyreBand.type = 'bandpass';
    this.tyreBand.frequency.value = 2400;
    this.tyreBand.Q.value = 0.8;
    this.skid = ctx.createBufferSource();
    this.skid.buffer = this.engine.longNoise;
    this.skid.loop = true;
    this.skid.connect(this.tyreBand).connect(this.tyres).connect(this.engine.master);
    this.skid.start();

    this.running = true;
  }

  /**
   * One frame.
   *
   * @param speed 0 to 1 of the car's top speed
   * @param throttle 0 or 1
   * @param slide how far sideways it is going, in px/s
   */
  update(speed, throttle, slide) {
    if (!this.running || !this.engine.enabled) return;
    const now = this.ctx.currentTime;
    this.phase += 0.13;
    const wobble = 1 + Math.sin(this.phase) * 0.012;
    // Two "gears", which is all it takes: the pitch climbs, drops back once, and
    // climbs again. Without it the note simply rises for ever and the car sounds
    // like a vacuum cleaner.
    const gear = speed < 0.55 ? speed / 0.55 : (speed - 0.55) / 0.45;
    const hz = (58 + gear * 96) * wobble;
    this.low.frequency.setTargetAtTime(hz, now, 0.04);
    this.high.frequency.setTargetAtTime(hz * 1.5, now, 0.04);
    // Off the throttle it goes dull, which is the sound of lifting for a corner.
    this.filter.frequency.setTargetAtTime(420 + speed * 1500 + throttle * 700, now, 0.05);
    this.gain.gain.setTargetAtTime(0.1 + speed * 0.12 + throttle * 0.05, now, 0.06);

    const howling = Math.min(1, Math.max(0, (Math.abs(slide) - 40) / 130));
    this.tyres.gain.setTargetAtTime(howling * 0.16, now, 0.05);
    this.tyreBand.frequency.setTargetAtTime(1500 + howling * 2200, now, 0.05);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    const now = this.ctx.currentTime;
    // Faded rather than cut: stopping an oscillator at full level is a click.
    this.gain.gain.setTargetAtTime(0, now, 0.08);
    this.tyres.gain.setTargetAtTime(0, now, 0.08);
    const at = now + 0.4;
    this.low.stop(at);
    this.high.stop(at);
    this.skid.stop(at);
  }
}

/** The least time between two things the commentator says, in seconds. */
const LINE_GAP = 2.2;

/**
 * Race sounds, built from the same two ingredients as the tune: a tone and a
 * band of noise. Nothing here is a recording.
 */
export class Sfx {
  constructor(engine, speech = null) {
    this.engine = engine;
    this.speech = speech;
    this.lastLine = -99;
    this.lastBump = -99;
    this.talking = true;
  }

  get ctx() {
    return this.engine.ctx;
  }

  ready() {
    return !!this.engine.ctx && this.engine.enabled;
  }

  /** A starting light. Three flat pips and a higher one for go. */
  light(go = false) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    this.engine.tone(go ? 880 : 440, now, go ? 0.5 : 0.18, 'square', 0.34);
  }

  /**
   * Plastic into plastic. Short, hard, and low, with the pitch of the thump
   * following how hard it was - which is the only way a nudge and a broadside
   * sound like different things.
   */
  bump(hard = 100) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    if (now - this.lastBump < 0.06) return;
    this.lastBump = now;
    const t = Math.min(1, hard / 320);
    this.engine.noiseBurst(now, {
      freq: 700 + t * 1500, q: 1.2, dur: 0.09 + t * 0.06, level: 0.18 + t * 0.24, sweepTo: 190,
    });
    this.engine.tone(90 + t * 90, now, 0.1, 'triangle', 0.2 + t * 0.16);
  }

  /** A rail, a cushion, a book: duller than a car, and it rings a little. */
  wall(hard = 100) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    const t = Math.min(1, hard / 320);
    this.engine.noiseBurst(now, {
      freq: 320, q: 2.4, dur: 0.16, level: 0.14 + t * 0.16, sweepTo: 120,
    });
  }

  /** Off the table. A falling whistle and then nothing, which is the joke. */
  fall() {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(760, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.55);
    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
    osc.connect(gain).connect(this.engine.master);
    osc.start(now);
    osc.stop(now + 0.65);
    this.engine.noiseBurst(now + 0.55, {
      freq: 260, q: 0.7, dur: 0.14, level: 0.2, sweepTo: 90,
    });
  }

  /** Back on the road: two rising pips, so you know you have control again. */
  ready2go() {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    this.engine.tone(520, now, 0.07, 'square', 0.16);
    this.engine.tone(780, now + 0.09, 0.09, 'square', 0.16);
  }

  /**
   * Picking up a turbo. A rising sweep with a bite of noise on it - the sweep is
   * the arcade convention for "you now have more of something", and the noise
   * stops it sounding like a menu.
   */
  turbo() {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(1250, now + 0.26);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(gain).connect(this.engine.master);
    osc.start(now);
    osc.stop(now + 0.36);
    this.engine.noiseBurst(now, {
      freq: 900, q: 0.9, dur: 0.3, level: 0.12, sweepTo: 4200,
    });
  }

  /** Over the line. A chime, and a brighter one for a personal best. */
  lap(best = false) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    const notes = best ? [660, 880, 1320] : [520, 700];
    notes.forEach((freq, i) => {
      this.engine.tone(freq, now + i * 0.08, 0.16, 'square', 0.2);
    });
  }

  /** The flag: a little fanfare, and a longer one for whoever won. */
  flag(won = false) {
    if (!this.ready()) return;
    const now = this.ctx.currentTime;
    const notes = won ? [523, 659, 784, 1046, 1318] : [523, 659, 784];
    notes.forEach((freq, i) => {
      this.engine.tone(freq, now + i * 0.11, 0.24, 'square', 0.24);
      this.engine.tone(freq / 2, now + i * 0.11, 0.24, 'triangle', 0.16);
    });
  }

  /**
   * The commentator. Rarely, and never over himself: this game is loud enough
   * without a man talking through the corners.
   */
  call(text, { force = false } = {}) {
    if (!this.ready() || !this.talking || !this.speech || !text) return 0;
    const now = this.ctx.currentTime;
    if (!force && now - this.lastLine < LINE_GAP) return 0;
    this.lastLine = now;
    return this.speech.line(text, now);
  }

  say(event) {
    if (!this.ready() || !this.talking || !this.speech) return 0;
    const now = this.ctx.currentTime;
    if (now - this.lastLine < LINE_GAP) return 0;
    this.lastLine = now;
    return this.speech.say(event);
  }

  /**
   * Everything the simulation reported this frame, turned into noise.
   *
   * `seat` is which car is yours, and it does more work than it looks: a bump
   * three corners away should not sound like one you were in, and the
   * commentator should not narrate somebody else's mistake over the top of your
   * own race.
   */
  play(events, { seat = -1, laps = 0, lines = {} } = {}) {
    if (!this.ready()) return;
    for (const e of events) {
      switch (e.type) {
        case 'light':
          this.light(false);
          break;
        case 'go':
          this.light(true);
          this.call(lines.go, { force: true });
          break;
        case 'bump':
          if (e.seat === seat || e.other === seat) this.bump(e.hard);
          break;
        case 'wall':
          if (e.seat === seat) this.wall(e.hard);
          break;
        case 'fall':
        case 'drop':
          if (e.seat === seat) {
            this.fall();
            this.say('fall');
          }
          break;
        case 'ready':
          if (e.seat === seat) this.ready2go();
          break;
        case 'boost':
          if (e.seat === seat) this.turbo();
          break;
        case 'lap':
          if (e.seat === seat) {
            this.lap(e.personal);
            // Only your own last lap, and only once: the whole point of saying
            // it is that you are the one who has to do something about it.
            if (e.lap === laps - 1) this.say('final');
          }
          if (e.overall && lines.record) this.call(lines.record);
          break;
        case 'finish':
          if (e.place === 1) {
            this.flag(e.seat === seat);
            this.call(lines.win, { force: true });
          } else if (e.seat === seat) {
            this.flag(false);
            this.call(lines.you);
          }
          break;
        default:
          break;
      }
    }
  }
}
