import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_GRAB_OPTIONS,
  Finger,
  FingerFrame,
  Grabbable,
  type GrabSink,
  type GrabbableTarget,
} from '../src/index.js';

interface Event { kind: 'grab' | 'move' | 'release'; id: number }

class Recorder implements GrabSink {
  events: Event[] = [];
  onGrab(id: number): void { this.events.push({ kind: 'grab', id }); }
  onMove(id: number): void { this.events.push({ kind: 'move', id }); }
  onRelease(id: number): void { this.events.push({ kind: 'release', id }); }
  of(kind: Event['kind']): Event[] { return this.events.filter((e) => e.kind === kind); }
  clear(): void { this.events = []; }
}

const FRAME_DT = 1 / 90;
const CLOSED = DEFAULT_GRAB_OPTIONS.pinchClose - 0.004;
const OPEN = DEFAULT_GRAB_OPTIONS.pinchOpen + 0.01;

function target(id: number, x = 0, y = 1, z = -0.5): GrabbableTarget {
  return { id, centre: [x, y, z], yawDeg: 0, reach: 0.2, pinned: false };
}

/** Drives one or two pinching hands through frames. */
class Rig {
  readonly frame = new FingerFrame();
  readonly sink = new Recorder();
  private t = 1000;

  constructor(readonly grab: Grabbable) {}

  /**
   * Step a frame. Each hand is given as [x, y, z, separation] or null for a
   * hand that is not being tracked at all.
   */
  step(left: readonly number[] | null, right: readonly number[] | null): void {
    this.t += FRAME_DT * 1000;
    this.frame.beginFrame(this.t, FRAME_DT);
    if (left !== null) this.hand(Finger.LEFT_THUMB, Finger.LEFT_INDEX, left);
    if (right !== null) this.hand(Finger.RIGHT_THUMB, Finger.RIGHT_INDEX, right);
    this.grab.update(this.frame, this.sink);
  }

  private hand(thumb: number, index: number, at: readonly number[]): void {
    const [x, y, z, separation] = at as [number, number, number, number];
    // Split the separation across the pair so the midpoint is exactly (x,y,z).
    this.frame.setFinger(thumb, x - separation / 2, y, z, 0.008);
    this.frame.setFinger(index, x + separation / 2, y, z, 0.008);
  }
}

describe('taking hold', () => {
  let grab: Grabbable;
  let rig: Rig;
  let pad: GrabbableTarget;

  beforeEach(() => {
    grab = new Grabbable();
    pad = target(1);
    grab.add(pad);
    rig = new Rig(grab);
  });

  it('grabs a device the pinch closed inside', () => {
    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    expect(rig.sink.of('grab').map((e) => e.id)).toEqual([1]);
    expect(grab.isHeld(1)).toBe(true);
  });

  it('ignores a pinch closed out of reach', () => {
    rig.step([2, 1, -0.5, OPEN], null);
    rig.step([2, 1, -0.5, CLOSED], null);
    expect(rig.sink.of('grab')).toHaveLength(0);
  });

  it('carries the device with the hand', () => {
    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    rig.step([0.3, 1.2, -0.4, CLOSED], null);
    expect(pad.centre[0]).toBeCloseTo(0.3, 6);
    expect(pad.centre[1]).toBeCloseTo(1.2, 6);
    expect(pad.centre[2]).toBeCloseTo(-0.4, 6);
  });

  it('keeps the offset it was taken hold of at, so it never jumps', () => {
    // Pinch off-centre; the device should keep that relationship, not snap its
    // centre onto the pinch.
    rig.step([0.1, 1, -0.5, OPEN], null);
    rig.step([0.1, 1, -0.5, CLOSED], null);
    rig.step([0.5, 1, -0.5, CLOSED], null);
    expect(pad.centre[0]).toBeCloseTo(0.4, 6);
  });

  it('lets go when the pinch opens, once', () => {
    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, OPEN], null);
    expect(rig.sink.of('release')).toHaveLength(1);
    expect(grab.isHeld(1)).toBe(false);
  });

  it('lets go when tracking drops rather than freezing the device to a ghost', () => {
    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    rig.step(null, null);
    expect(rig.sink.of('release')).toHaveLength(1);
  });

  it('does not flutter between held and released at the noise floor', () => {
    /*
     * The hysteresis band. Hand tracking's estimate of fingertip separation
     * wanders by several millimetres while pinching, so a single threshold
     * makes a held device stutter — grabbed, dropped, grabbed — as the number
     * crosses back and forth.
     */
    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    const between = (DEFAULT_GRAB_OPTIONS.pinchClose + DEFAULT_GRAB_OPTIONS.pinchOpen) / 2;
    for (let i = 0; i < 20; i++) rig.step([0, 1, -0.5, between], null);
    expect(rig.sink.of('release')).toHaveLength(0);
    expect(grab.isHeld(1)).toBe(true);
  });
});

describe('pinning', () => {
  it('is invisible to the grab test, not merely deprioritised', () => {
    /*
     * The reason pinning exists at all. A hand playing a pad grid is constantly
     * inside the volume a grab test looks at — that is what playing is — and a
     * finger-drum roll is a sequence of near-pinches at speed. Without this, a
     * fast passage eventually reads as somebody dragging the instrument off the
     * desk mid-phrase.
     */
    const grab = new Grabbable();
    const pinned = target(1);
    pinned.pinned = true;
    grab.add(pinned);
    const rig = new Rig(grab);

    rig.step([0, 1, -0.5, OPEN], null);
    for (let i = 0; i < 30; i++) rig.step([i * 0.01, 1, -0.5, CLOSED], null);
    expect(rig.sink.of('grab')).toHaveLength(0);
    expect(pinned.centre).toEqual([0, 1, -0.5]);
  });

  it('does not shadow a loose device beside it', () => {
    // A pinned device that merely lost the ranking would still win the pinch
    // and leave the loose one next to it unmovable.
    const grab = new Grabbable();
    const pinned = target(1, 0, 1, -0.5);
    pinned.pinned = true;
    const loose = target(2, 0.05, 1, -0.5);
    grab.add(pinned);
    grab.add(loose);
    const rig = new Rig(grab);

    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    expect(rig.sink.of('grab').map((e) => e.id)).toEqual([2]);
  });

  it('releases a device that is pinned while it is being held', () => {
    const grab = new Grabbable();
    const pad = target(1);
    grab.add(pad);
    const rig = new Rig(grab);

    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    expect(grab.isHeld(1)).toBe(true);

    // Pinning mid-grab is a legitimate thing to do from the wrist menu; the
    // device must stop following the hand at once rather than at the next
    // release.
    pad.pinned = true;
    rig.step([0.4, 1, -0.5, CLOSED], null);
    expect(pad.centre[0]).toBeCloseTo(0, 6);
  });
});

describe('turning it with both hands', () => {
  let grab: Grabbable;
  let rig: Rig;
  let pad: GrabbableTarget;

  beforeEach(() => {
    grab = new Grabbable();
    pad = target(1);
    grab.add(pad);
    rig = new Rig(grab);
  });

  /** Put both pinches on the device, one each side, and close them. */
  function twoHanded(): void {
    rig.step([-0.1, 1, -0.5, OPEN], [0.1, 1, -0.5, OPEN]);
    rig.step([-0.1, 1, -0.5, CLOSED], [0.1, 1, -0.5, CLOSED]);
  }

  it('does not jump when the second hand joins', () => {
    // Latching on the current bearing is what stops the device snapping to
    // whatever angle the hands happen to be at.
    twoHanded();
    expect(pad.yawDeg).toBeCloseTo(0, 6);
  });

  it('turns with the bearing between the hands', () => {
    twoHanded();
    // Swing the right hand a quarter turn about the midpoint.
    rig.step([0, 1, -0.6, CLOSED], [0, 1, -0.4, CLOSED]);
    expect(Math.abs(pad.yawDeg)).toBeCloseTo(90, 4);
  });

  it('takes the short way round when the hands cross behind the player', () => {
    /*
     * The wrap. Without it, a bearing crossing from just under +180 to just
     * over -180 reads as a 360-degree change and the device spins all the way
     * round the other way.
     */
    twoHanded();
    let previous = pad.yawDeg;
    for (let step = 1; step <= 36; step++) {
      /*
       * Swept from the bearing the grab actually latched at, which is 90°: the
       * two pinches start either side of the device along X. Starting the sweep
       * at 0 instead makes the first step an eighty-degree jump — a fact about
       * where the hands were put, not about the wrap this is testing.
       */
      const angle = ((90 + step * 10) * Math.PI) / 180;
      const dx = Math.sin(angle) * 0.1;
      const dz = Math.cos(angle) * 0.1;
      rig.step([-dx, 1, -0.5 - dz, CLOSED], [dx, 1, -0.5 + dz, CLOSED]);
      // No single step may move the yaw more than the hands actually moved.
      expect(Math.abs(pad.yawDeg - previous)).toBeLessThan(30);
      previous = pad.yawDeg;
    }
    // …and a full turn of the hands is a full turn of the device, rather than
    // a half turn that snapped back.
    expect(Math.abs(pad.yawDeg)).toBeCloseTo(360, 3);
  });

  it('ignores the bearing when the hands are too close to mean anything', () => {
    // Below the span threshold the angle is dominated by tracking noise, and a
    // device driven from it spins on the spot.
    rig.step([-0.01, 1, -0.5, OPEN], [0.01, 1, -0.5, OPEN]);
    rig.step([-0.01, 1, -0.5, CLOSED], [0.01, 1, -0.5, CLOSED]);
    rig.step([0, 1, -0.51, CLOSED], [0, 1, -0.49, CLOSED]);
    expect(pad.yawDeg).toBe(0);
  });

  it('stays held when one hand lets go, and announces the release only at the end', () => {
    twoHanded();
    rig.sink.clear();
    rig.step([-0.1, 1, -0.5, OPEN], [0.1, 1, -0.5, CLOSED]);
    expect(rig.sink.of('release')).toHaveLength(0);
    expect(grab.isHeld(1)).toBe(true);
    rig.step([-0.1, 1, -0.5, OPEN], [0.1, 1, -0.5, OPEN]);
    expect(rig.sink.of('release')).toHaveLength(1);
  });
});

describe('the roster changing underneath', () => {
  it('releases and forgets a device that is removed mid-grab', () => {
    const grab = new Grabbable();
    grab.add(target(1));
    const rig = new Rig(grab);
    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);

    expect(grab.remove(1, rig.sink)).toBe(true);
    expect(rig.sink.of('release').map((e) => e.id)).toEqual([1]);
    expect(grab.count).toBe(0);
  });

  it('keeps a held device attached to the right hand when another is removed', () => {
    /*
     * Indices shift when something is spliced out of the middle, and a hand
     * still pointing at an old index is a hand holding a different device.
     */
    const grab = new Grabbable();
    grab.add(target(1, -1, 1, -0.5));
    const wanted = target(2, 0, 1, -0.5);
    grab.add(wanted);
    const rig = new Rig(grab);

    rig.step([0, 1, -0.5, OPEN], null);
    rig.step([0, 1, -0.5, CLOSED], null);
    expect(grab.isHeld(2)).toBe(true);

    grab.remove(1, rig.sink);
    rig.step([0.25, 1, -0.5, CLOSED], null);
    expect(grab.isHeld(2)).toBe(true);
    expect(wanted.centre[0]).toBeCloseTo(0.25, 6);
  });
});
