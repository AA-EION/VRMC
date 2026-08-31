import { clamp14, EventFlags } from '@vrmc/protocol';
import { FingerFrame, MAX_FINGERS } from './fingers.js';

/** Receives continuous-controller output from a knob or fader. */
export interface ControlSink {
  /** 14-bit value, 0..16383. */
  onValue(controlIndex: number, value14: number, flags: number): void;
  onGrab(controlIndex: number): void;
  onRelease(controlIndex: number): void;
}

export interface KnobOptions {
  /** World-space radius within which a pinch will latch onto this control. */
  grabRadius: number;
  /**
   * Metres of hand travel that sweep the full 0..1 range.
   *
   * 0.25 m is about a comfortable forearm movement. Shorter feels twitchy at
   * hand-tracking's noise floor; much longer and a full sweep needs a shoulder.
   */
  travel: number;
  /** Distance between thumb and index tips below which a pinch is closed. */
  pinchClose: number;
  /**
   * Distance above which an existing pinch is considered released.
   *
   * Strictly greater than `pinchClose`: hand tracking's estimate of fingertip
   * separation wanders by several millimetres while pinching, and a single
   * threshold makes a held knob flutter between grabbed and released.
   */
  pinchOpen: number;
}

export const DEFAULT_KNOB_OPTIONS: KnobOptions = {
  grabRadius: 0.06,
  travel: 0.25,
  pinchClose: 0.022,
  pinchOpen: 0.035,
};

/** The two hands' (thumb, index) fingertip pairs. */
const PINCH_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // left thumb, left index
  [5, 6], // right thumb, right index
];

interface KnobState {
  /** World position of the control's centre. */
  x: number;
  y: number;
  z: number;
  /** Current normalised value, 0..1. */
  value: number;
  /** Which hand (index into PINCH_PAIRS) holds it, or -1. */
  heldBy: number;
  /** Pinch height and value at the moment of grab, for relative dragging. */
  grabY: number;
  grabValue: number;
}

/**
 * Pinch-and-drag continuous controls: knobs and faders.
 *
 * Twisting a virtual knob the way you would a real one reads well in a demo and
 * plays badly: hand tracking estimates finger *positions* far more reliably
 * than wrist roll, so a twist-mapped knob jitters and slips. Dragging
 * vertically uses the axis the tracker is most confident about, and it is what
 * the control surfaces in DAWs already do — so it is also what a player's hands
 * already know.
 *
 * Values are relative to where the grab started rather than absolute, so
 * latching onto a knob never makes it jump.
 */
export class KnobControl {
  readonly options: KnobOptions;
  private readonly knobs: KnobState[] = [];

  /** Pinch state per hand, for hysteresis across frames. */
  private readonly pinching = new Uint8Array(PINCH_PAIRS.length);
  /** Knob index each hand currently holds, or -1. */
  private readonly handHolds = new Int16Array(PINCH_PAIRS.length).fill(-1);

  constructor(options: Partial<KnobOptions> = {}) {
    this.options = { ...DEFAULT_KNOB_OPTIONS, ...options };
  }

  /** Register a control at a world position. Returns its index. */
  addKnob(x: number, y: number, z: number, initialValue = 0.5): number {
    this.knobs.push({
      x,
      y,
      z,
      value: Math.min(1, Math.max(0, initialValue)),
      heldBy: -1,
      grabY: 0,
      grabValue: 0,
    });
    return this.knobs.length - 1;
  }

  /** Move a control, e.g. because its panel was repositioned. */
  setKnobPosition(index: number, x: number, y: number, z: number): void {
    const knob = this.knobs[index];
    if (knob === undefined) return;
    knob.x = x;
    knob.y = y;
    knob.z = z;
  }

  /** Current normalised value of a control, 0..1. */
  valueOf(index: number): number {
    return this.knobs[index]?.value ?? 0;
  }

  /** True while a hand is holding this control. */
  isHeld(index: number): boolean {
    return (this.knobs[index]?.heldBy ?? -1) >= 0;
  }

  get count(): number {
    return this.knobs.length;
  }

  /** Advance one frame. Emits value changes into `sink`. */
  update(frame: FingerFrame, sink: ControlSink): void {
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) {
      const [thumb, index] = PINCH_PAIRS[hand]!;
      if (thumb >= MAX_FINGERS || index >= MAX_FINGERS) continue;

      const tracked = frame.tracked[thumb] === 1 && frame.tracked[index] === 1;
      if (!tracked) {
        this.releaseHand(hand, sink);
        this.pinching[hand] = 0;
        continue;
      }

      const to = thumb * 3;
      const io = index * 3;
      const px = (frame.position[to]! + frame.position[io]!) * 0.5;
      const py = (frame.position[to + 1]! + frame.position[io + 1]!) * 0.5;
      const pz = (frame.position[to + 2]! + frame.position[io + 2]!) * 0.5;

      const dx = frame.position[to]! - frame.position[io]!;
      const dy = frame.position[to + 1]! - frame.position[io + 1]!;
      const dz = frame.position[to + 2]! - frame.position[io + 2]!;
      const pinchDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const wasPinching = this.pinching[hand] === 1;
      const nowPinching = wasPinching
        ? pinchDist < this.options.pinchOpen
        : pinchDist < this.options.pinchClose;
      this.pinching[hand] = nowPinching ? 1 : 0;

      if (!nowPinching) {
        this.releaseHand(hand, sink);
        continue;
      }

      let holding = this.handHolds[hand]!;
      if (holding < 0) {
        holding = this.nearestKnob(px, py, pz);
        if (holding < 0) continue;
        const knob = this.knobs[holding]!;
        if (knob.heldBy >= 0) continue; // already held by the other hand
        knob.heldBy = hand;
        knob.grabY = py;
        knob.grabValue = knob.value;
        this.handHolds[hand] = holding;
        sink.onGrab(holding);
      }

      const knob = this.knobs[holding]!;
      const delta = (py - knob.grabY) / this.options.travel;
      const next = Math.min(1, Math.max(0, knob.grabValue + delta));
      if (next !== knob.value) {
        knob.value = next;
        sink.onValue(holding, clamp14(Math.round(next * 16383)), EventFlags.NONE);
      }
    }
  }

  /** Release every held control. For teardown and transport loss. */
  releaseAll(sink: ControlSink): void {
    for (let hand = 0; hand < PINCH_PAIRS.length; hand++) this.releaseHand(hand, sink);
  }

  private releaseHand(hand: number, sink: ControlSink): void {
    const holding = this.handHolds[hand]!;
    if (holding < 0) return;
    this.handHolds[hand] = -1;
    const knob = this.knobs[holding];
    if (knob !== undefined) knob.heldBy = -1;
    sink.onRelease(holding);
  }

  /** Nearest control within the grab radius, or -1. */
  private nearestKnob(x: number, y: number, z: number): number {
    const limit = this.options.grabRadius * this.options.grabRadius;
    let best = -1;
    let bestDist = limit;
    for (let i = 0; i < this.knobs.length; i++) {
      const k = this.knobs[i]!;
      const dx = k.x - x;
      const dy = k.y - y;
      const dz = k.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }
}
