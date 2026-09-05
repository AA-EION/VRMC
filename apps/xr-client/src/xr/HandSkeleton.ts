/**
 * The full hand skeleton, for drawing — twenty-five joints per hand.
 *
 * Deliberately separate from `HandTracker`, which reads five.
 *
 * The tip path is the hot path: poke detection depends on it, it runs whether
 * or not anything is drawn, and it has been tuned against the one thing that
 * actually breaks a hand-tracked instrument — a GC pause landing in the middle
 * of a fill. Adding twenty more joints to it so a mesh could be skinned would
 * have made every player pay for a feature only the full-VR room uses, and it
 * would have put the drawing code inside the file the notes come out of. So
 * this is its own class with its own buffers, running only while hands are on
 * screen, and `handTracking.ts` is untouched.
 *
 * WHY NOT `XRHandModelFactory`
 * three ships one, and it is the official route, and it is not usable here.
 * It is driven by `renderer.xr.getHand(i)`, and three's own `WebXRController`
 * updates those joint groups with `frame.getJointPose()` — one call per joint
 * per hand per frame. That is fifty `XRJointPose` objects a frame, each holding
 * a transform holding a matrix and a DOMPointReadOnly: about four and a half
 * thousand objects a second, which is precisely the steady drip
 * `handTracking.ts` was written to avoid.
 *
 * `XRFrame.fillPoses()` exists for exactly this reason: it writes 4x4 matrices
 * straight into a Float32Array we own. Same data, same official asset, no
 * garbage. The mesh it skins is the same `generic-hand` glb the factory would
 * have fetched — vendored, so nothing is downloaded from a CDN mid-session.
 */

/**
 * The standard's own order, which is the order `XRHand` iterates in — and the
 * order the glb names its bones in, which is the whole of the binding.
 */
export const HAND_JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const;

export const JOINTS_PER_HAND = HAND_JOINTS.length;
const FLOATS_PER_MATRIX = 16;

/** Joints of one hand, and where its matrices live in the shared buffer. */
export interface HandBinding {
  handedness: XRHandedness;
  spaces: XRSpace[];
  /** Index into `matrices`, in floats. */
  offset: number;
  /** True once this hand reported a complete pose this frame. */
  tracked: boolean;
}

/**
 * Reads every joint of every tracked hand into one Float32Array.
 *
 * Two hands at most, because there are two hands. The buffer is sized for both
 * up front rather than grown, so a hand appearing mid-session costs a rebind
 * and no allocation.
 */
export class HandSkeleton {
  /** 4x4 column-major matrices, two hands' worth. */
  readonly matrices = new Float32Array(2 * JOINTS_PER_HAND * FLOATS_PER_MATRIX);

  /**
   * One hand's worth of scratch.
   *
   * `fillPoses` fills from index zero, so writing a second hand straight into
   * `matrices` would need a subarray view — and a view is an allocation, once
   * per hand per frame, which is the whole thing this class exists to avoid.
   * Filling a fixed scratch and copying costs one `set` of 400 floats and no
   * garbage at all.
   */
  private readonly scratch = new Float32Array(JOINTS_PER_HAND * FLOATS_PER_MATRIX);

  private readonly bindings: HandBinding[] = [];
  /** Whether the runtime has the bulk pose API. Probed once. */
  private bulkApi: boolean | null = null;

  /**
   * Rebuild the bindings from the session's input sources.
   *
   * Called on `inputsourceschange`, never per frame: `XRHand` is a Map, and
   * walking it allocates an iterator — fine occasionally, not fine at 90 Hz.
   */
  syncInputSources(session: XRSession): void {
    this.bindings.length = 0;
    let offset = 0;
    for (const source of session.inputSources) {
      const hand = source.hand;
      if (hand === undefined || hand === null) continue;
      if (this.bindings.length >= 2) break;

      const spaces: XRSpace[] = [];
      let complete = true;
      for (const jointName of HAND_JOINTS) {
        const space = hand.get(jointName as unknown as XRHandJoint);
        if (space === undefined) {
          complete = false;
          break;
        }
        spaces.push(space);
      }
      // A partial skeleton cannot be drawn: a mesh with three bones left at
      // their bind pose is a hand with a broken finger, which reads far worse
      // than a hand that is not there.
      if (!complete) continue;

      this.bindings.push({ handedness: source.handedness, spaces, offset, tracked: false });
      offset += JOINTS_PER_HAND * FLOATS_PER_MATRIX;
    }
  }

  /** The hands currently bound, in the order their matrices are stored. */
  get hands(): readonly HandBinding[] {
    return this.bindings;
  }

  /**
   * Fill the buffer with this frame's joint poses.
   *
   * Every binding's `tracked` is set to whether it produced a usable pose, so
   * the renderer can hide a hand rather than leave it wherever it last was.
   */
  update(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    if (this.bulkApi === null) this.bulkApi = typeof frame.fillPoses === 'function';

    for (const binding of this.bindings) {
      binding.tracked = this.bulkApi
        ? this.fillBulk(frame, referenceSpace, binding)
        : this.fillPerJoint(frame, referenceSpace, binding);
    }
  }

  /** Allocation-free path. */
  private fillBulk(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    binding: HandBinding,
  ): boolean {
    const ok = frame.fillPoses?.(binding.spaces, referenceSpace, this.scratch) ?? false;
    if (!ok) {
      // The spec leaves the buffer unspecified when any pose is missing, so
      // nothing in it can be trusted. A hand drawn from a half-filled buffer
      // is a hand folded through itself.
      return false;
    }
    this.matrices.set(this.scratch, binding.offset);
    return true;
  }

  /**
   * Fallback for runtimes without `fillPoses`.
   *
   * Allocates, and degrades gracefully. A runtime this old is not a Quest 3,
   * so this is the desktop emulator's path rather than the one anybody plays
   * on — and a little garbage there costs nothing that matters.
   */
  private fillPerJoint(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    binding: HandBinding,
  ): boolean {
    let any = false;
    for (let j = 0; j < JOINTS_PER_HAND; j++) {
      const pose = frame.getJointPose?.(binding.spaces[j] as XRJointSpace, referenceSpace);
      if (pose === undefined || pose === null) return false;
      this.matrices.set(pose.transform.matrix, binding.offset + j * FLOATS_PER_MATRIX);
      any = true;
    }
    return any;
  }
}
