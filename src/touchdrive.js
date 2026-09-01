/**
 * The on-screen controls, for a car rather than for a footballer.
 *
 * The shared TouchControls in touch.js gives eight directions and two buttons,
 * which is right for the other two games and wrong for this one in two ways.
 *
 * It steers in eight directions, so a diagonal on the stick also presses UP or
 * DOWN - and in this game those are the throttle and the brake, which are
 * already buttons. Reaching for a bit of left lock would quietly lift you off
 * the power.
 *
 * And it is all or nothing. The stick is read as a direction, so any deflection
 * past a ten pixel dead zone is full lock. On a keyboard that is fine, because a
 * key is all or nothing anyway and you steer by tapping it. Under a thumb it
 * makes the car dart.
 *
 * So here the stick does one job - steering - and does it proportionally.
 *
 * The catch is that the simulation takes one bit per direction and always will:
 * that bitmask is what goes over the wire, and it is what makes a lap driven on
 * a phone comparable with one driven on a keyboard. The way round it is to send
 * the bit for only some of the ticks. Half deflection holds LEFT on every other
 * tick, and because the car smooths its steering towards whatever is being asked
 * for, it settles at about half lock. Spread evenly rather than in blocks, so it
 * comes out as a steady half rather than as a wobble.
 *
 * Nothing about this is visible to the simulation, the netcode or the record
 * board. It is one machine deciding what to press.
 */

import { TouchControls } from './touch.js';
import { BTN } from './constants.js';

/** How far the stick has to move before it steers at all, as a share of throw. */
const DEAD = 0.16;
/**
 * And how far it moves for full lock, when the wheel is not on screen to be
 * measured. The real figure is taken off the element every time a thumb lands
 * on it, because how wide the wheel is depends on how much room the pedals left.
 */
const FALLBACK_THROW = 58;
/**
 * How much finer the middle of the range is than the ends.
 *
 * More than linear, because most of a thumb's travel should be spent on the
 * small corrections you make all the time rather than on the full lock you want
 * twice a lap. At 1 the control is even and still darts. At 2 it is calm and
 * half a thumb's travel is only a sixth of a turn, which is a long way to move
 * for an ordinary corner. This is the middle.
 */
const CURVE = 1.5;

/**
 * Take the pointer, and carry on if the browser will not give it.
 *
 * setPointerCapture throws for a pointer the browser does not consider active,
 * and an unguarded call takes the whole handler down with it - the wheel is
 * never picked up, and the car simply does not steer. Capture is a nicety here
 * anyway: it keeps a thumb that slides off the button attached to it, and
 * without it the pedals still work.
 */
function capture(el, id) {
  try {
    el.setPointerCapture?.(id);
  } catch { /* not an active pointer: the control works without it */ }
}

export class TouchDrive extends TouchControls {
  constructor() {
    super();
    /** Where the wheel is, -1 to 1. */
    this.wheel = 0;
    /** The two buttons, kept apart from the steering so advance() can rebuild. */
    this.buttons = 0;
    /** Carries the fraction of a tick's worth of lock that has not been spent. */
    this.spent = 0;
    /** How far the knob can travel, measured off the wheel when it is touched. */
    this.throwPx = 0;
  }

  /** @param {{root: Element, stick: Element, knob: Element, gas: Element, brake: Element}} el */
  attach(el) {
    this.elements = el;
    const { stick, knob } = el;

    const grab = (e) => {
      capture(stick, e.pointerId);
      this.stickPointer = e.pointerId;
      const box = stick.getBoundingClientRect();
      this.origin = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      // However much track there is either side of the knob.
      this.throwPx = Math.max(30, (box.width - (knob.offsetWidth || 62)) / 2);
      this.turn(e, knob);
      e.preventDefault();
    };
    const move = (e) => {
      if (e.pointerId !== this.stickPointer) return;
      this.turn(e, knob);
      e.preventDefault();
    };
    const drop = (e) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.wheel = 0;
      this.spent = 0;
      knob.style.transform = 'translate(-50%, -50%)';
    };
    stick.addEventListener('pointerdown', grab);
    stick.addEventListener('pointermove', move);
    stick.addEventListener('pointerup', drop);
    stick.addEventListener('pointercancel', drop);

    this.pedal(el.gas, BTN.FIRE);
    this.pedal(el.brake, BTN.SWITCH);
    this.advance();
  }

  /**
   * A pedal you hold for the whole race.
   *
   * Released only by the finger that pressed it, and never by pointerleave.
   * The shared version listens for that too, which means a thumb sliding a few
   * pixels off the edge of the button - or a second finger touching down and
   * lifting somewhere else - lets go of the throttle mid-corner.
   */
  pedal(el, bit) {
    let held = null;
    const down = (e) => {
      capture(el, e.pointerId);
      held = e.pointerId;
      this.buttons |= bit;
      el.classList.add('pressed');
      e.preventDefault();
    };
    const up = (e) => {
      if (held !== null && e.pointerId !== held) return;
      held = null;
      this.buttons &= ~bit;
      el.classList.remove('pressed');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    // A long press on a button is a text selection to a phone browser unless it
    // is told otherwise, and then the throttle you were holding is a highlighted
    // word instead. The CSS says so too; this is the half of it a stylesheet
    // cannot do.
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Where the wheel is now, and where to draw the knob. */
  turn(e, knob) {
    const span = this.throwPx || FALLBACK_THROW;
    const dx = e.clientX - this.origin.x;
    const throwLen = Math.max(-1, Math.min(1, dx / span));
    const past = Math.max(0, Math.abs(throwLen) - DEAD) / (1 - DEAD);
    this.wheel = Math.sign(throwLen) * past ** CURVE;
    // Horizontally only, because that is the only thing it does. A knob that
    // followed a thumb up and down would be promising something.
    knob.style.transform = `translate(calc(-50% + ${throwLen * span}px), -50%)`;
  }

  /**
   * One tick. Works out whether the steering bit is pressed this time.
   *
   * Evenly spread rather than blocked: adding the deflection up and pressing
   * whenever the total passes one puts the on-ticks as far apart as they go, so
   * two thirds of lock comes out as on-on-off rather than as on-on-off-off-off
   * repeated, which the car would feel as a wobble.
   */
  advance() {
    let steer = 0;
    const want = Math.abs(this.wheel);
    if (want > 0) {
      this.spent += want;
      if (this.spent >= 1) {
        this.spent -= 1;
        steer = this.wheel < 0 ? BTN.LEFT : BTN.RIGHT;
      }
    } else {
      this.spent = 0;
    }
    this.mask = this.buttons | steer;
  }

  show(on) {
    super.show(on);
    if (!on) {
      this.buttons = 0;
      this.wheel = 0;
      this.spent = 0;
    }
  }
}
