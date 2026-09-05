import { HAND_JOINTS } from './HandSkeleton.js';

/**
 * Where a panel worn on the wrist actually goes.
 *
 * The reasoning here is EION Studios', from the console in its own immersive
 * room, and it is worth restating because both halves of it cost a round trip
 * to discover.
 *
 * IT IS NOT HUNG OFF THE GRIP
 * A hand-tracked input source has no grip pose at all — three's own
 * `WebXRController.update` takes the joint branch when `inputSource.hand` is
 * set and never touches `grip`, which then stays wherever it last was with
 * `visible` false. A console hung off the grip therefore works perfectly with
 * controllers and vanishes the moment somebody puts them down.
 *
 * AND THE FRAME IS DERIVED FROM THE JOINTS, NOT TAKEN FROM ONE
 * A joint space's axes are a convention, and reasoning about which way the
 * wrist's Y points is guesswork that reads sideways as often as not. Three
 * points on the hand need no convention: the wrist and the middle metacarpal
 * give the direction along the arm, the index and pinky metacarpals give the
 * direction across the palm, and their cross product is the back of the hand
 * once handedness has decided its sign.
 *
 * From those the panel is laid out the way a watch actually is:
 *
 *   +Z  the back of the hand   — so it faces you as you turn your wrist
 *   +X  toward the fingers     — the long side runs along the forearm
 *   +Y  perpendicular to both  — so the words are upright with the hand held
 *                                across the body, which is how anybody checks
 *                                the time
 *
 * Everything here writes into buffers the caller owns. It runs every frame for
 * as long as a session lasts, on the same frame as the notes.
 */

/** Indices into `HandSkeleton`'s joint order. */
const WRIST = HAND_JOINTS.indexOf('wrist');
const INDEX_META = HAND_JOINTS.indexOf('index-finger-metacarpal');
const MIDDLE_META = HAND_JOINTS.indexOf('middle-finger-metacarpal');
const PINKY_META = HAND_JOINTS.indexOf('pinky-finger-metacarpal');

/** How far off the back of the wrist the panel floats, in metres. */
export const WRIST_LIFT = 0.035;
/** …and how far along the forearm toward the hand it sits. */
export const WRIST_ALONG = 0.02;

/**
 * How square-on the panel must be to the eye before it counts as being looked
 * at. A dot product, so 1 is dead on and 0 is edge on.
 *
 * 0.55 is about fifty-six degrees off, which is far enough open that turning
 * your wrist to read it is enough and narrow enough that an arm hanging by a
 * side never qualifies. That second half is the whole safety property: below
 * the threshold the menu is not drawn *and its detector does not run*, so a
 * hand playing a pad grid cannot press anything on it.
 */
export const WRIST_FACING = 0.55;

/** Result layout: position xyz, then quaternion xyzw. */
export const WRIST_POSE_FLOATS = 7;

/** Read a joint's translation out of a column-major 4x4 at `base`. */
function translation(matrices: Float32Array, base: number, joint: number, out: Float32Array, at: number): void {
  const m = base + joint * 16;
  out[at] = matrices[m + 12]!;
  out[at + 1] = matrices[m + 13]!;
  out[at + 2] = matrices[m + 14]!;
}

function normalise(v: Float32Array, at: number): number {
  const x = v[at]!;
  const y = v[at + 1]!;
  const z = v[at + 2]!;
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length < 1e-6) return 0;
  v[at] = x / length;
  v[at + 1] = y / length;
  v[at + 2] = z / length;
  return length;
}

function cross(a: Float32Array, ai: number, b: Float32Array, bi: number, out: Float32Array, oi: number): void {
  const ax = a[ai]!;
  const ay = a[ai + 1]!;
  const az = a[ai + 2]!;
  const bx = b[bi]!;
  const by = b[bi + 1]!;
  const bz = b[bi + 2]!;
  out[oi] = ay * bz - az * by;
  out[oi + 1] = az * bx - ax * bz;
  out[oi + 2] = ax * by - ay * bx;
}

/**
 * Scratch for one call. Module-level rather than per-call because this runs
 * every frame, and the whole file exists to avoid the alternative.
 *
 * Slots: 0 wrist, 3 along, 6 across, 9 dorsal, 12 up, 15 spare.
 */
const scratch = new Float32Array(18);

/**
 * Compute the wrist panel's world pose.
 *
 * Returns false when the joints do not describe a hand — a degenerate palm, or
 * a skeleton that has not been filled this frame. The caller must treat that as
 * «no panel» rather than as a pose of zero.
 */
export function wristPose(
  matrices: Float32Array,
  base: number,
  handedness: XRHandedness,
  out: Float32Array,
): boolean {
  translation(matrices, base, WRIST, scratch, 0);
  translation(matrices, base, MIDDLE_META, scratch, 3);
  translation(matrices, base, INDEX_META, scratch, 6);
  translation(matrices, base, PINKY_META, scratch, 9);

  // along: wrist -> middle metacarpal, up the arm toward the fingers.
  scratch[3] = scratch[3]! - scratch[0]!;
  scratch[4] = scratch[4]! - scratch[1]!;
  scratch[5] = scratch[5]! - scratch[2]!;
  if (normalise(scratch, 3) === 0) return false;

  // across: pinky -> index, so the sign of the cross product is the only thing
  // handedness has to decide.
  scratch[6] = scratch[6]! - scratch[9]!;
  scratch[7] = scratch[7]! - scratch[10]!;
  scratch[8] = scratch[8]! - scratch[11]!;
  if (normalise(scratch, 6) === 0) return false;

  // dorsal = across x along, the back of the hand.
  cross(scratch, 6, scratch, 3, scratch, 9);
  if (handedness === 'right') {
    scratch[9] = -scratch[9]!;
    scratch[10] = -scratch[10]!;
    scratch[11] = -scratch[11]!;
  }
  if (normalise(scratch, 9) === 0) return false;

  // up = dorsal x along, then along re-squared against the other two — the
  // metacarpals are not exactly perpendicular to the forearm on anybody.
  cross(scratch, 9, scratch, 3, scratch, 12);
  if (normalise(scratch, 12) === 0) return false;
  cross(scratch, 12, scratch, 9, scratch, 3);
  if (normalise(scratch, 3) === 0) return false;

  // Position: off the back of the wrist and a little toward the hand.
  out[0] = scratch[0]! + scratch[9]! * WRIST_LIFT + scratch[3]! * WRIST_ALONG;
  out[1] = scratch[1]! + scratch[10]! * WRIST_LIFT + scratch[4]! * WRIST_ALONG;
  out[2] = scratch[2]! + scratch[11]! * WRIST_LIFT + scratch[5]! * WRIST_ALONG;

  quaternionFromBasis(scratch, 3, 12, 9, out, 3);
  return true;
}

/**
 * A quaternion from three orthonormal columns.
 *
 * The branch on the trace is not an optimisation: the naive form divides by a
 * quantity that goes to zero for a half-turn about any axis, and a wrist turned
 * to read a watch is very close to exactly that.
 */
function quaternionFromBasis(
  v: Float32Array,
  xi: number,
  yi: number,
  zi: number,
  out: Float32Array,
  at: number,
): void {
  const m00 = v[xi]!;
  const m10 = v[xi + 1]!;
  const m20 = v[xi + 2]!;
  const m01 = v[yi]!;
  const m11 = v[yi + 1]!;
  const m21 = v[yi + 2]!;
  const m02 = v[zi]!;
  const m12 = v[zi + 1]!;
  const m22 = v[zi + 2]!;

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[at] = (m21 - m12) * s;
    out[at + 1] = (m02 - m20) * s;
    out[at + 2] = (m10 - m01) * s;
    out[at + 3] = 0.25 / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[at] = 0.25 * s;
    out[at + 1] = (m01 + m10) / s;
    out[at + 2] = (m02 + m20) / s;
    out[at + 3] = (m21 - m12) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[at] = (m01 + m10) / s;
    out[at + 1] = 0.25 * s;
    out[at + 2] = (m12 + m21) / s;
    out[at + 3] = (m02 - m20) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[at] = (m02 + m20) / s;
    out[at + 1] = (m12 + m21) / s;
    out[at + 2] = 0.25 * s;
    out[at + 3] = (m10 - m01) / s;
  }
}

/**
 * How square-on the panel is to the eye, 0..1, ramped from the threshold.
 *
 * A ramp rather than a switch, so the panel fades in as the wrist turns rather
 * than appearing. The number below the threshold is exactly zero, which is what
 * the caller gates the detector on — see `WRIST_FACING`.
 */
export function facingAmount(
  pose: Float32Array,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
): number {
  // The panel's own +Z, from its quaternion. Rotating (0, 0, 1) reduces to
  // three terms per axis, so it is written out rather than going through a
  // general rotate.
  const qx = pose[3]!;
  const qy = pose[4]!;
  const qz = pose[5]!;
  const qw = pose[6]!;
  const nx = 2 * (qx * qz + qw * qy);
  const ny = 2 * (qy * qz - qw * qx);
  const nz = 1 - 2 * (qx * qx + qy * qy);

  let dx = eyeX - pose[0]!;
  let dy = eyeY - pose[1]!;
  let dz = eyeZ - pose[2]!;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length < 1e-6) return 0;
  dx /= length;
  dy /= length;
  dz /= length;

  const facing = nx * dx + ny * dy + nz * dz;
  if (facing <= WRIST_FACING) return 0;
  return Math.min(1, (facing - WRIST_FACING) / (1 - WRIST_FACING));
}
