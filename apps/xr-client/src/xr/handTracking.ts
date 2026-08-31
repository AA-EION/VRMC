import { FingerFrame, Finger } from '@vrmc/interaction';

/**
 * Reads Quest hand-tracking joints into a `FingerFrame`, once per XR frame.
 *
 * WebXR exposes 25 joints per hand. We need five per hand — the fingertips —
 * and we need them without allocating, because this runs 90 times a second for
 * the whole session.
 *
 * The obvious API, `XRFrame.getJointPose(joint, space)`, returns a fresh
 * `XRJointPose` object per joint per frame: 10 objects per frame, 900 a second,
 * each holding a transform holding a matrix and a DOMPointReadOnly. That is a
 * steady drip into the nursery, and the resulting minor GCs land wherever they
 * land — including in the middle of a fill.
 *
 * `XRFrame.fillPoses()` exists for exactly this reason: it writes 4x4 matrices
 * straight into a Float32Array we own. Same data, no garbage. We use it when
 * available and keep `getJointPose` as the fallback for runtimes that lack it.
 */

/** The five tip joints, in the order `Finger` indexes them. */
const TIP_JOINTS = [
  'thumb-tip',
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const;

const JOINTS_PER_HAND = TIP_JOINTS.length;
const FLOATS_PER_MATRIX = 16;

/** Base index into `FingerFrame` for each hand. */
const HAND_BASE: Record<XRHandedness, number> = {
  left: Finger.LEFT_THUMB,
  right: Finger.RIGHT_THUMB,
  none: Finger.LEFT_THUMB,
};

/** Per-hand cache of the joint spaces, which are stable for the session. */
interface HandBinding {
  source: XRInputSource;
  spaces: XRSpace[];
  base: number;
}

export class HandTracker {
  /** Scratch for fillPoses: five 4x4 matrices. */
  private readonly poseMatrices = new Float32Array(JOINTS_PER_HAND * FLOATS_PER_MATRIX);
  /** Scratch for fillJointRadii. */
  private readonly radii = new Float32Array(JOINTS_PER_HAND);

  private readonly bindings: HandBinding[] = [];
  /** Whether the runtime has the bulk pose API. Probed once. */
  private bulkApi: boolean | null = null;

  /** True once at least one hand has reported a pose this session. */
  handsSeen = false;

  /**
   * Rebuild the hand bindings from the session's input sources.
   *
   * Call on `inputsourceschange`, not per frame: `XRHand` is a Map and walking
   * it allocates an iterator, which is fine occasionally and not fine at 90 Hz.
   */
  syncInputSources(session: XRSession): void {
    this.bindings.length = 0;
    for (const source of session.inputSources) {
      const hand = source.hand;
      if (!hand) continue;
      const spaces: XRSpace[] = [];
      let complete = true;
      for (const jointName of TIP_JOINTS) {
        const space = hand.get(jointName as unknown as XRHandJoint);
        if (!space) {
          complete = false;
          break;
        }
        spaces.push(space);
      }
      if (!complete) continue;
      this.bindings.push({
        source,
        spaces,
        base: HAND_BASE[source.handedness] ?? Finger.LEFT_THUMB,
      });
    }
  }

  /** Number of hands currently being tracked. */
  get handCount(): number {
    return this.bindings.length;
  }

  /**
   * Fill `out` with this frame's fingertip positions, in `referenceSpace`.
   *
   * `out.beginFrame()` must already have been called; this only sets the
   * fingers it can see, leaving the rest marked untracked so the detector
   * releases their notes.
   */
  update(frame: XRFrame, referenceSpace: XRReferenceSpace, out: FingerFrame): void {
    if (this.bulkApi === null) {
      this.bulkApi =
        typeof frame.fillPoses === 'function' && typeof frame.fillJointRadii === 'function';
    }

    for (const binding of this.bindings) {
      if (this.bulkApi) {
        this.updateBulk(frame, referenceSpace, binding, out);
      } else {
        this.updatePerJoint(frame, referenceSpace, binding, out);
      }
    }
  }

  /** Allocation-free path. */
  private updateBulk(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    binding: HandBinding,
    out: FingerFrame,
  ): void {
    const ok = frame.fillPoses?.(binding.spaces, referenceSpace, this.poseMatrices) ?? false;
    if (!ok) {
      // The spec leaves the buffer's contents unspecified when any pose is
      // missing, so nothing in it can be trusted. Reading it anyway would place
      // a fingertip at a stale or garbage position — and a fingertip that
      // teleports through a pad is a note the player did not play.
      return;
    }
    frame.fillJointRadii?.(binding.spaces as Iterable<XRJointSpace>, this.radii);

    for (let j = 0; j < JOINTS_PER_HAND; j++) {
      const m = j * FLOATS_PER_MATRIX;
      // Translation lives in elements 12..14 of a column-major 4x4.
      out.setFinger(
        binding.base + j,
        this.poseMatrices[m + 12]!,
        this.poseMatrices[m + 13]!,
        this.poseMatrices[m + 14]!,
        this.radii[j]!,
      );
    }
    this.handsSeen = true;
  }

  /**
   * Fallback path for runtimes without `fillPoses`.
   *
   * Allocates, but degrades gracefully: better a little garbage than no hands.
   * It also copes with partial tracking, since each joint is asked for
   * separately and a missing one only costs that finger.
   */
  private updatePerJoint(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    binding: HandBinding,
    out: FingerFrame,
  ): void {
    for (let j = 0; j < JOINTS_PER_HAND; j++) {
      const space = binding.spaces[j] as XRJointSpace;
      const pose = frame.getJointPose?.(space, referenceSpace);
      if (!pose) continue;
      const p = pose.transform.position;
      out.setFinger(binding.base + j, p.x, p.y, p.z, pose.radius ?? 0.008);
      this.handsSeen = true;
    }
  }
}
