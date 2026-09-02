import { describe, it, expect } from 'vitest';
import { HAND_JOINTS, HandSkeleton, JOINTS_PER_HAND } from '../src/xr/HandSkeleton.js';

/**
 * The skeleton, against a fake runtime.
 *
 * There is no XR device here, so what is exercised is the part that is ours:
 * which joints are asked for, what happens when a hand is incomplete or a fill
 * fails, where each hand's matrices land in the shared buffer, and — the reason
 * the class exists at all — that none of it allocates.
 */

/** A stand-in for one `XRHand`: a Map of joint name to a unique space object. */
function fakeHand(missing?: string): Map<string, object> {
  const hand = new Map<string, object>();
  for (const name of HAND_JOINTS) {
    if (name === missing) continue;
    hand.set(name, { name });
  }
  return hand;
}

function fakeSource(handedness: XRHandedness, missing?: string): unknown {
  return { handedness, hand: fakeHand(missing) };
}

function fakeSession(...sources: unknown[]): XRSession {
  return { inputSources: sources } as unknown as XRSession;
}

/**
 * A frame whose `fillPoses` writes a recognisable value per joint, so the
 * buffer can be checked for which hand's data landed where.
 */
function fakeFrame(options: { ok?: boolean; stamp?: number } = {}): XRFrame {
  const { ok = true, stamp = 1 } = options;
  return {
    fillPoses(spaces: Iterable<unknown>, _base: unknown, out: Float32Array): boolean {
      if (!ok) return false;
      let j = 0;
      for (const _space of spaces) {
        void _space;
        for (let k = 0; k < 16; k++) out[j * 16 + k] = stamp * 100 + j;
        j++;
      }
      return true;
    },
  } as unknown as XRFrame;
}

const SPACE = {} as XRReferenceSpace;

describe('binding', () => {
  it('asks for every joint the standard names, in the standard order', () => {
    // The order is the whole of the binding: the glb names its bones in it, and
    // XRHand iterates in it, so a reordering here silently attaches the wrong
    // bone to the wrong joint rather than failing.
    expect(HAND_JOINTS).toHaveLength(25);
    expect(HAND_JOINTS[0]).toBe('wrist');
    expect(HAND_JOINTS[JOINTS_PER_HAND - 1]).toBe('pinky-finger-tip');
    expect(new Set(HAND_JOINTS).size).toBe(25);
  });

  it('binds both hands into their own slots', () => {
    const s = new HandSkeleton();
    s.syncInputSources(fakeSession(fakeSource('left'), fakeSource('right')));
    expect(s.hands).toHaveLength(2);
    expect(s.hands[0]!.handedness).toBe('left');
    expect(s.hands[1]!.offset).toBe(JOINTS_PER_HAND * 16);
  });

  it('ignores input sources that are not hands', () => {
    const s = new HandSkeleton();
    s.syncInputSources(fakeSession({ handedness: 'left' }, fakeSource('right')));
    expect(s.hands).toHaveLength(1);
    expect(s.hands[0]!.handedness).toBe('right');
  });

  it('refuses a hand missing a joint rather than drawing a broken one', () => {
    /*
     * A mesh with three bones left at their bind pose is a hand with a snapped
     * finger, which reads far worse than a hand that is simply not there.
     */
    const s = new HandSkeleton();
    s.syncInputSources(fakeSession(fakeSource('left', 'ring-finger-tip')));
    expect(s.hands).toHaveLength(0);
  });

  it('takes at most two hands, because there are two hands', () => {
    const s = new HandSkeleton();
    s.syncInputSources(
      fakeSession(fakeSource('left'), fakeSource('right'), fakeSource('none')),
    );
    expect(s.hands).toHaveLength(2);
  });

  it('rebuilds cleanly when the sources change', () => {
    const s = new HandSkeleton();
    s.syncInputSources(fakeSession(fakeSource('left'), fakeSource('right')));
    s.syncInputSources(fakeSession(fakeSource('right')));
    expect(s.hands).toHaveLength(1);
    expect(s.hands[0]!.handedness).toBe('right');
    expect(s.hands[0]!.offset).toBe(0);
  });
});

describe('filling', () => {
  it('puts each hand where its binding says', () => {
    const s = new HandSkeleton();
    s.syncInputSources(fakeSession(fakeSource('left'), fakeSource('right')));
    s.update(fakeFrame({ stamp: 1 }), SPACE);
    // Both hands are filled from the same fake, so the check is that the second
    // hand's block was written at all — i.e. that the offset was applied.
    expect(s.matrices[0]).toBe(100);
    expect(s.matrices[JOINTS_PER_HAND * 16]).toBe(100);
    expect(s.hands.every((h) => h.tracked)).toBe(true);
  });

  it('marks a hand untracked when the fill fails, and leaves the buffer alone', () => {
    /*
     * The spec leaves the buffer unspecified when any pose is missing, so
     * nothing in it can be trusted. A hand drawn from a half-filled buffer is a
     * hand folded through itself — far worse than one that blinks out.
     */
    const s = new HandSkeleton();
    s.syncInputSources(fakeSession(fakeSource('left')));
    s.update(fakeFrame({ stamp: 7 }), SPACE);
    const before = Array.from(s.matrices.subarray(0, 16));

    s.update(fakeFrame({ ok: false }), SPACE);
    expect(s.hands[0]!.tracked).toBe(false);
    expect(Array.from(s.matrices.subarray(0, 16))).toEqual(before);
  });

  it('falls back to getJointPose where fillPoses is missing', () => {
    const frame = {
      getJointPose(space: { name: string }): unknown {
        const matrix = new Float32Array(16);
        matrix[0] = HAND_JOINTS.indexOf(space.name as (typeof HAND_JOINTS)[number]);
        return { transform: { matrix } };
      },
    } as unknown as XRFrame;

    const s = new HandSkeleton();
    s.syncInputSources(fakeSession(fakeSource('left')));
    s.update(frame, SPACE);
    expect(s.hands[0]!.tracked).toBe(true);
    expect(s.matrices[0]).toBe(0);
    expect(s.matrices[16]).toBe(1);
  });
});

describe('the reason this class exists', () => {
  const gc = globalThis.gc;

  it.skipIf(gc === undefined)('fills both hands for an hour without growing the heap', () => {
    /*
     * The claim that justifies not using three's XRHandModelFactory. That path
     * calls frame.getJointPose() once per joint per hand per frame — fifty
     * XRJointPose objects a frame, each holding a transform holding a matrix
     * and a DOMPointReadOnly — which is about four and a half thousand objects
     * a second landing in the nursery of the one process where a GC pause is
     * audible as a late note.
     *
     * The threshold is deliberately loose: the point is to catch per-frame
     * allocation, which would show up as tens of megabytes, not to police the
     * kilobytes JIT warmup contributes.
     */
    const s = new HandSkeleton();
    s.syncInputSources(fakeSession(fakeSource('left'), fakeSource('right')));
    const frame = fakeFrame();

    for (let i = 0; i < 2000; i++) s.update(frame, SPACE);

    const heap = (): number => {
      gc?.();
      gc?.();
      return process.memoryUsage().heapUsed;
    };
    const before = heap();
    // 300 000 frames is about 55 minutes at 90 Hz.
    for (let i = 0; i < 300_000; i++) s.update(frame, SPACE);
    const growth = heap() - before;

    expect(growth).toBeLessThan(2 * 1024 * 1024);
  });
});
