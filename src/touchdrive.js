/**
 * The on-screen controls, for a car rather than for a footballer.
 *
 * The shared TouchControls in touch.js gives eight directions and two buttons.
 * That is right for the other two games and wrong for this one in three ways,
 * and the third only became obvious once somebody played it on a phone.
 *
 * It steers in eight directions, so a diagonal also presses UP or DOWN - which
 * here are the throttle and the brake. Reaching for a bit of left lock quietly
 * lifted you off the power.
 *
 * It is all or nothing. Any deflection past a ten pixel dead zone is full lock.
 * On a keyboard that is fine, because a key is all or nothing anyway and you
 * steer by tapping it. Under a thumb it makes the car dart.
 *
 * And it is *absolute*: the middle of the stick is a fixed point on the glass,
 * and you cannot feel it. Every correction began with finding a centre that
 * gives you nothing back, while the road went past. So the wheel here is
 * relative - wherever your thumb lands is straight ahead, and you steer by
 * moving from there. Nothing to aim at, so nothing to miss.
 *
 * The one thing worth keeping from the original is that the simulation takes one
 * bit per direction and always will: that bitmask is what goes over the wire,
 * and it is what makes a lap set on a phone comparable with one set on a
 * keyboard. So a part-turned wheel presses the bit for a share of the ticks
 * rather than all of them, spread evenly, and the car - which smooths its
 * steering towards whatever is being asked for - settles at that share.
 */

import { TouchControls } from './touch.js';
import { BTN } from './constants.js';

/** How far the thumb moves for full lock, in CSS pixels each way. */
const THROW = 46;
/** And how much of that does nothing, so a resting thumb does not steer. */
const DEAD = 0.12;
/**
 * How much finer the middle of the range is than the ends.
 *
 * More than linear, because most of a thumb's travel should go on the small
 * corrections you make all the time rather than on the full lock you want twice
 * a lap. At 1 it darts; at 2 an ordinary corner is most of the travel.
 */
const CURVE = 1.4;
/** How far the knob slides in its track, which is only a picture of the above. */
const KNOB_TRAVEL = 58;
/** A tap you can feel, where the phone has a motor. Milliseconds. */
const BUZZ = 12;

/**
 * Take the pointer, and carry on if the browser will not give it.
 *
 * setPointerCapture throws for a pointer the browser does not consider active,
 * and an unguarded call takes the whole handler down with it - the wheel is
 * never picked up and the car simply does not steer.
 */
function capture(el, id) {
  try {
    el.setPointerCapture?.(id);
  } catch { /* not an active pointer: the control works without it */ }
}

/** A short tap of the motor, on the phones that have one. */
function buzz(ms = BUZZ) {
  try {
    navigator.vibrate?.(ms);
  } catch { /* not allowed here, or no motor */ }
}

export class TouchDrive extends TouchControls {
  constructor() {
    super();
    /** Where the wheel is, -1 to 1. */
    this.wheel = 0;
    /** The pedals, kept apart from the steering so advance() can rebuild. */
    this.buttons = 0;
    /** Carries the fraction of a tick's worth of lock that has not been spent. */
    this.spent = 0;
    /**
     * Whether the car drives itself and the pedal is a brake.
     *
     * The default on a phone, and not out of laziness. Holding a throttle down
     * for two minutes with one thumb while steering with the other leaves
     * nothing spare, and the throttle is the input you almost always want
     * anyway - what you actually decide, corner by corner, is when to come off
     * it. So the button becomes the thing you decide.
     */
    this.auto = true;
  }

  /** @param {{root, stick, knob, gas, brake}} el */
  attach(el) {
    this.elements = el;
    const { stick, knob } = el;

    const grab = (e) => {
      capture(stick, e.pointerId);
      this.stickPointer = e.pointerId;
      // Wherever the thumb lands is straight ahead. That is the whole idea:
      // there is no centre to find, because it comes to you.
      this.origin = { x: e.clientX, y: e.clientY };
      this.wheel = 0;
      this.spent = 0;
      this.draw(knob);
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
      this.draw(knob);
    };
    stick.addEventListener('pointerdown', grab);
    stick.addEventListener('pointermove', move);
    stick.addEventListener('pointerup', drop);
    stick.addEventListener('pointercancel', drop);
    stick.addEventListener('contextmenu', (e) => e.preventDefault());

    this.pedal(el.gas, BTN.FIRE);
    this.pedal(el.brake, BTN.SWITCH);
    this.advance();
  }

  /**
   * A pedal, held down.
   *
   * Released only by the finger that pressed it, and never by pointerleave. The
   * shared control listens for that too, which means a thumb sliding a few
   * pixels off the edge lets go mid-corner. A phone with a motor gives a tap
   * back, because a sheet of glass gives you nothing.
   */
  pedal(el, bit) {
    if (!el) return;
    let held = null;
    const down = (e) => {
      capture(el, e.pointerId);
      held = e.pointerId;
      this.buttons |= bit;
      el.classList.add('pressed');
      buzz();
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
    // A long press is a text selection to a phone browser unless it is told
    // otherwise, and then the throttle you were holding is a highlighted word.
    // The CSS says so too; this is the half a stylesheet cannot do.
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Where the wheel is now, measured from wherever the thumb started. */
  turn(e, knob) {
    const dx = (e.clientX - this.origin.x) / THROW;
    const at = Math.max(-1, Math.min(1, dx));
    const past = Math.max(0, Math.abs(at) - DEAD) / (1 - DEAD);
    this.wheel = Math.sign(at) * past ** CURVE;
    this.draw(knob);
  }

  /** The knob shows how much lock is on, not where the thumb is. */
  draw(knob) {
    if (!knob) return;
    knob.style.transform = `translate(calc(-50% + ${this.wheel * KNOB_TRAVEL}px), -50%)`;
  }

  /**
   * One tick. Works out what is pressed this time.
   *
   * The steering is spread evenly rather than blocked: adding the deflection up
   * and pressing whenever the total passes one puts the on-ticks as far apart as
   * they go, so two thirds of lock comes out as on-on-off rather than as
   * on-on-off-off-off repeated, which the car would feel as a wobble.
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
    let pedals = this.buttons;
    // Foot down unless you have asked for the brake. Local, like the duty cycle
    // above: the simulation is handed an ordinary mask and never knows.
    if (this.auto && !(pedals & BTN.SWITCH)) pedals |= BTN.FIRE;
    this.mask = pedals | steer;
  }

  show(on) {
    super.show(on);
    if (!on) {
      this.buttons = 0;
      this.wheel = 0;
      this.spent = 0;
      this.stickPointer = null;
      this.draw(this.elements?.knob);
    }
  }
}
