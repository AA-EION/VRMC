// SPDX-License-Identifier: GPL-3.0-only

import { FingerFrame } from './fingers.js';

/**
 * Picking a device up, moving it, and turning it to face you.
 *
 * ONE HAND MOVES IT, TWO HANDS TURN IT
 * A pinch inside a device's volume takes hold of it, and the device travels
 * with that pinch. Pinch with the second hand as well and the angle between the
 * two hands drives yaw — the same gesture as turning a real object held in both
 * hands, and the only rotation worth offering. Roll is deliberately absent: a
 * rolled Launchpad is one you cannot play, and a wrist rolls thirty degrees
 * without its owner noticing.
 *
 * PINNING IS NOT A SETTING
 * A pinned device ignores grabs entirely, and the reason is not tidiness. A
 * hand playing a pad grid is *constantly* inside the volume a grab test looks
 * at — that is what playing is — and every finger-drum roll is a sequence of
 * near-pinches at speed. Without a pin, a fast passage eventually reads as
 * somebody taking hold of the instrument and dragging it off the desk
 * mid-phrase, which is unrecoverable in the worst possible moment.
 *
 * The thresholds are shared with `KnobControl` on purpose. They were tuned
 * against hand tracking's actual noise floor — an estimate of fingertip
 * separation that wanders by several millimetres while pinching — and a second
 * set of numbers for the same gesture would be a second thing to retune.
 */

export interface GrabbableTarget {
  /** Stable identity, so a caller can match a grab back to its device. */
  readonly id: number;
  /** World position of the device's centre. */
  centre: [number, number, number];
  /** Current yaw, in degrees. */
  yawDeg: number;
  /** Half-extent of the volume a pinch must be inside to take hold, in metres. */
  readonly reach: number;
  /** True while the device refuses to be moved. */
  pinned: boolean;
}

export interface GrabSink {
  /** A device was taken hold of. */
  onGrab(id: number): void;
  /**
   * The device moved. Fired per frame while held, so this must not allocate or
   * touch the network — it is for keeping the mesh and the detector in step.
   */
  onMove(id: number, centre: readonly [number, number, number], yawDeg: number): void;
  /**
   * Let go. This is where a caller tells the bridge, once: a grab produces a
   * new pose ninety times a second and exactly one of them is worth sending.
   */
  onRelease(id: number): void;
}

export interface GrabOptions {
  /** Thumb-to-index distance below which a pinch is closed. */
  pinchClose: number;
  /**
   * Distance above which an existing pinch is considered released. Strictly
   * greater than `pinchClose`: a single threshold makes a held device flutter
   * between grabbed and released at the tracker's noise floor.
   */
  pinchOpen: number;
  /**
   * How far a pinch may be from a device's centre and still take hold, as a
   * multiple of the device's own `reach`.
   */
  grabScale: number;
  /**
   * Minimum separation between two pinches before the angle between them is
   * used for yaw, in metres. Below this the angle is dominated by tracking
   * noise and the device spins.
   */
  minTwoHandSpan: number;
}

export const DEFAULT_GRAB_OPTIONS: GrabOptions = {
  pinchClose: 0.022,
  pinchOpen: 0.035,
  grabScale: 1,
  minTwoHandSpan: 0.12,
};

/** The two hands' (thumb, index) fingertip pairs, as `Finger` indexes them. */
const PINCH_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [5, 6],
];

const LEFT = 0;
const RIGHT = 1;

export class Grabbable {
  readonly options: GrabOptions;
  private readonly targets: GrabbableTarget[] = [];

  /** Pinch state per hand, for hysteresis across frames. */
  private readonly pinching = new Uint8Array(PINCH_PAIRS.length);
  /** World position of each hand's pinch this frame. */
  private readonly pinchAt = new Float32Array(PINCH_PAIRS.length * 3);
  /** Whether each hand had a usable pinch position this frame. */
  private readonly pinchTracked = new Uint8Array(PINCH_PAIRS.length);

  /** Which target each hand holds, by index into `targets`, or -1. */
  private readonly held = new Int16Array(PINCH_PAIRS.length).fill(-1);
  /** Offset from the pinch to the device centre at the moment of grab. */
  private readonly grabOffset = new Float32Array(PINCH_PAIRS.length * 3);

  /**
   * The hand-to-hand bearing as of the previous frame, while two hands hold
   * one device. Yaw accumulates the change frame by frame — see `applyMotion`.
   */
  private lastBearing = 0;
  private twoHanded = false;

  constructor(options: Partial<GrabOptions> = {}) {
    this.options = { ...DEFAULT_GRAB_OPTIONS, ...options };
  }

  /** Register a device. Returns its index, for `remove`. */
  add(target: GrabbableTarget): number {
    this.targets.push(target);
    return this.targets.length - 1;
  }

  /** Forget a device, releasing it first if a hand is on it. */
  remove(id: number, sink: GrabSink): boolean {
    const at = this.targets.findIndex((t) => t.id === id);
    if (at < 0) return false;
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      if (this.held[hand] === at) this.releaseHand(hand, sink);
    }
    this.targets.splice(at, 1);
    // Indices above the removed one all shift down by one, and a hand still
    // pointing at an old index would be holding the wrong device.
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      const holding = this.held[hand]!;
      if (holding > at) this.held[hand] = holding - 1;
    }
    return true;
  }

  /** True while any hand is holding this device. */
  isHeld(id: number): boolean {
    const at = this.targets.findIndex((t) => t.id === id);
    if (at < 0) return false;
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      if (this.held[hand] === at) return true;
    }
    return false;
  }

  get count(): number {
    return this.targets.length;
  }

  /** Advance one frame. */
  update(frame: FingerFrame, sink: GrabSink): void {
    this.readPinches(frame);

    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      if (this.pinchTracked[hand] === 0) {
        // Tracking dropped. Let go rather than freeze: a device welded to a
        // hand nobody is reporting any more needs the session restarted.
        this.releaseHand(hand, sink);
        this.pinching[hand] = 0;
        continue;
      }
      if (this.pinching[hand] === 0) {
        this.releaseHand(hand, sink);
        continue;
      }
      if (this.held[hand]! < 0) this.tryGrab(hand, sink);
    }

    /*
     * A device pinned while it is being held lets go at once.
     *
     * Pinning is a thing somebody does from the wrist menu with the other hand,
     * often *because* the device is drifting — so it has to take effect on the
     * frame it is asked for rather than at the next release. Checked here
     * rather than in `tryGrab` because that only ever runs for a hand that is
     * not already holding something.
     */
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      const index = this.held[hand]!;
      if (index >= 0 && this.targets[index]?.pinned === true) this.releaseHand(hand, sink);
    }

    this.applyMotion(sink);
  }

  /** Release everything. For teardown, and for transport loss. */
  releaseAll(sink: GrabSink): void {
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) this.releaseHand(hand, sink);
  }

  // --- internals ---

  private readPinches(frame: FingerFrame): void {
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      const [thumb, index] = PINCH_PAIRS[hand]!;
      if (frame.tracked[thumb] !== 1 || frame.tracked[index] !== 1) {
        this.pinchTracked[hand] = 0;
        continue;
      }
      const to = thumb * 3;
      const io = index * 3;
      const o = hand * 3;
      this.pinchAt[o] = (frame.position[to]! + frame.position[io]!) * 0.5;
      this.pinchAt[o + 1] = (frame.position[to + 1]! + frame.position[io + 1]!) * 0.5;
      this.pinchAt[o + 2] = (frame.position[to + 2]! + frame.position[io + 2]!) * 0.5;
      this.pinchTracked[hand] = 1;

      const dx = frame.position[to]! - frame.position[io]!;
      const dy = frame.position[to + 1]! - frame.position[io + 1]!;
      const dz = frame.position[to + 2]! - frame.position[io + 2]!;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.pinching[hand] =
        this.pinching[hand] === 1
          ? distance < this.options.pinchOpen
            ? 1
            : 0
          : distance < this.options.pinchClose
            ? 1
            : 0;
    }
  }

  private tryGrab(hand: number, sink: GrabSink): void {
    const o = hand * 3;
    const px = this.pinchAt[o]!;
    const py = this.pinchAt[o + 1]!;
    const pz = this.pinchAt[o + 2]!;

    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i]!;
      // Pinned devices are not merely skipped in the ranking — they are
      // invisible to the grab test, so a pinned Launchpad next to a loose one
      // can never win the pinch and leave the loose one unmovable.
      if (target.pinned) continue;
      /*
       * A device the other hand already holds is deliberately still a
       * candidate. Taking it with the second hand as well *is* the rotate
       * gesture — `applyMotion` only turns a device when both hands are on the
       * same one — so skipping it here, which is what this did at first, made
       * two-handed rotation quietly impossible: the second pinch found nothing
       * to hold and the first hand went on translating alone.
       */
      const dx = target.centre[0] - px;
      const dy = target.centre[1] - py;
      const dz = target.centre[2] - pz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > target.reach * this.options.grabScale) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    if (best < 0) return;

    const target = this.targets[best]!;
    this.held[hand] = best;
    this.grabOffset[o] = target.centre[0] - px;
    this.grabOffset[o + 1] = target.centre[1] - py;
    this.grabOffset[o + 2] = target.centre[2] - pz;
    sink.onGrab(target.id);
  }

  private heldBySomeone(index: number): boolean {
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      if (this.held[hand] === index) return true;
    }
    return false;
  }

  private applyMotion(sink: GrabSink): void {
    const left = this.held[LEFT]!;
    const right = this.held[RIGHT]!;

    // Both hands, one device: position follows the midpoint, yaw follows the
    // bearing between the hands. The same gesture as turning something you are
    // holding in both hands.
    if (left >= 0 && left === right) {
      const target = this.targets[left]!;
      const lx = this.pinchAt[LEFT * 3]!;
      const lz = this.pinchAt[LEFT * 3 + 2]!;
      const rx = this.pinchAt[RIGHT * 3]!;
      const rz = this.pinchAt[RIGHT * 3 + 2]!;
      const span = Math.hypot(rx - lx, rz - lz);

      if (span >= this.options.minTwoHandSpan) {
        const bearing = Math.atan2(rx - lx, rz - lz);
        if (!this.twoHanded) {
          // Latch on the current bearing, so taking the second hand never makes
          // the device jump to whatever angle the hands happen to be at.
          this.twoHanded = true;
          this.lastBearing = bearing;
        }
        /*
         * Accumulated frame by frame, not measured from the latch.
         *
         * Measuring from the latch and wrapping the result into (-180, 180]
         * looks equivalent and caps the total rotation at half a turn: keep
         * turning past 180° and the device snaps back the other way. Per-frame
         * deltas have no such limit, because at 90 Hz a hand cannot move far
         * enough between frames for the wrap to be ambiguous — which is also
         * why wrapping each one is still correct as the bearing crosses ±180
         * behind the player.
         */
        let delta = ((bearing - this.lastBearing) * 180) / Math.PI;
        delta = ((((delta + 180) % 360) + 360) % 360) - 180;
        this.lastBearing = bearing;
        target.yawDeg += delta;
      }

      // Position from the midpoint of the two grab offsets, so the device stays
      // where it was taken hold of rather than snapping between the hands.
      target.centre[0] =
        (this.pinchAt[LEFT * 3]! + this.grabOffset[LEFT * 3]! +
          this.pinchAt[RIGHT * 3]! + this.grabOffset[RIGHT * 3]!) * 0.5;
      target.centre[1] =
        (this.pinchAt[LEFT * 3 + 1]! + this.grabOffset[LEFT * 3 + 1]! +
          this.pinchAt[RIGHT * 3 + 1]! + this.grabOffset[RIGHT * 3 + 1]!) * 0.5;
      target.centre[2] =
        (this.pinchAt[LEFT * 3 + 2]! + this.grabOffset[LEFT * 3 + 2]! +
          this.pinchAt[RIGHT * 3 + 2]! + this.grabOffset[RIGHT * 3 + 2]!) * 0.5;
      sink.onMove(target.id, target.centre, target.yawDeg);
      return;
    }

    this.twoHanded = false;

    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      const index = this.held[hand]!;
      if (index < 0) continue;
      const target = this.targets[index]!;
      const o = hand * 3;
      target.centre[0] = this.pinchAt[o]! + this.grabOffset[o]!;
      target.centre[1] = this.pinchAt[o + 1]! + this.grabOffset[o + 1]!;
      target.centre[2] = this.pinchAt[o + 2]! + this.grabOffset[o + 2]!;
      sink.onMove(target.id, target.centre, target.yawDeg);
    }
  }

  private releaseHand(hand: number, sink: GrabSink): void {
    const index = this.held[hand]!;
    if (index < 0) return;
    this.held[hand] = -1;
    this.twoHanded = false;
    const target = this.targets[index];
    // Only the last hand off announces the release: with two hands on one
    // device, lifting one of them is still a hold.
    if (target !== undefined && !this.heldBySomeone(index)) sink.onRelease(target.id);
  }
}
