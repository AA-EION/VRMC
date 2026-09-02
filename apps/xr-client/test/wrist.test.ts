import { describe, it, expect } from 'vitest';
import { HAND_JOINTS, JOINTS_PER_HAND } from '../src/xr/HandSkeleton.js';
import {
  WRIST_ALONG,
  WRIST_FACING,
  WRIST_LIFT,
  WRIST_POSE_FLOATS,
  facingAmount,
  wristPose,
} from '../src/xr/wrist.js';

/**
 * The wrist frame, built from three points on a hand.
 *
 * Everything here is checked through the *basis it produces* rather than
 * against the quaternion's components, because the components are only correct
 * in so far as they produce it — and because the property that matters is
 * geometric: does the panel face the back of the hand, does its long side run
 * along the forearm, are the words the right way up.
 */

const index = (name: (typeof HAND_JOINTS)[number]): number => HAND_JOINTS.indexOf(name);

/** A skeleton buffer with the four joints that matter placed as given. */
function hand(points: {
  wrist: readonly [number, number, number];
  middle: readonly [number, number, number];
  indexMeta: readonly [number, number, number];
  pinky: readonly [number, number, number];
}): Float32Array {
  const matrices = new Float32Array(2 * JOINTS_PER_HAND * 16);
  const put = (joint: number, at: readonly [number, number, number]): void => {
    const m = joint * 16;
    matrices[m] = 1;
    matrices[m + 5] = 1;
    matrices[m + 10] = 1;
    matrices[m + 15] = 1;
    matrices[m + 12] = at[0];
    matrices[m + 13] = at[1];
    matrices[m + 14] = at[2];
  };
  put(index('wrist'), points.wrist);
  put(index('middle-finger-metacarpal'), points.middle);
  put(index('index-finger-metacarpal'), points.indexMeta);
  put(index('pinky-finger-metacarpal'), points.pinky);
  return matrices;
}

/** Rotate (x, y, z) by the quaternion in a pose buffer. */
function axis(pose: Float32Array, x: number, y: number, z: number): [number, number, number] {
  const [, , , qx, qy, qz, qw] = pose;
  const tx = qy! * z - qz! * y + qw! * x;
  const ty = qz! * x - qx! * z + qw! * y;
  const tz = qx! * y - qy! * x + qw! * z;
  return [
    x + 2 * (qy! * tz - qz! * ty),
    y + 2 * (qz! * tx - qx! * tz),
    z + 2 * (qx! * ty - qy! * tx),
  ];
}

const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/**
 * A left hand held palm-down, fingers along +X.
 *
 * Worth deriving rather than guessing, because the first version of this
 * fixture had the anatomy backwards and it looked exactly like the sign flip
 * being wrong.
 *
 * Fingers along +X and up along +Y makes +Z the third right-handed axis, so
 * with the wrist at the origin: hold a left hand palm-down with the fingers
 * pointing along +X, and the thumb — and therefore the index metacarpal — falls
 * on the +Z side, with the pinky on -Z. The back of the hand then points at
 * +Y, which is what every expectation below is written against.
 */
const PALM_DOWN_LEFT = hand({
  wrist: [0, 1, 0],
  middle: [0.08, 1, 0],
  indexMeta: [0.07, 1, 0.02],
  pinky: [0.07, 1, -0.02],
});

describe('the frame', () => {
  it('faces the back of the hand', () => {
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    expect(wristPose(PALM_DOWN_LEFT, 0, 'left', pose)).toBe(true);
    // Palm down, so the back of the hand — and the panel's +Z — is up.
    const forward = axis(pose, 0, 0, 1);
    expect(forward[1]).toBeCloseTo(1, 5);
  });

  it('runs its long side along the forearm', () => {
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    // +X toward the fingers, which is where a watch's long side goes.
    const across = axis(pose, 1, 0, 0);
    expect(across[0]).toBeCloseTo(1, 5);
  });

  it('produces an orthonormal basis', () => {
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    const x = axis(pose, 1, 0, 0);
    const y = axis(pose, 0, 1, 0);
    const z = axis(pose, 0, 0, 1);
    for (const v of [x, y, z]) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    expect(dot(x, y)).toBeCloseTo(0, 5);
    expect(dot(y, z)).toBeCloseTo(0, 5);
    expect(dot(x, z)).toBeCloseTo(0, 5);
  });

  it('flips the facing for the other hand', () => {
    /*
     * The one thing handedness decides. Both hands' metacarpals run the same
     * way across the palm, so without the sign flip a right hand's console
     * would sit under the palm and face the floor.
     */
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    const left = axis(pose, 0, 0, 1);
    wristPose(PALM_DOWN_LEFT, 0, 'right', pose);
    const right = axis(pose, 0, 0, 1);
    expect(dot(left, right)).toBeCloseTo(-1, 5);
  });

  it('floats off the back of the wrist rather than inside it', () => {
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    // Wrist is at y = 1 and the back of the hand is up, so the panel is above.
    expect(pose[1]).toBeCloseTo(1 + WRIST_LIFT, 5);
    // …and a little toward the fingers, along +X.
    expect(pose[0]).toBeCloseTo(WRIST_ALONG, 5);
  });

  it('re-squares the frame when the metacarpals are not perpendicular', () => {
    /*
     * They are not, on anybody. A basis taken straight from two hand-measured
     * directions is skewed, and a skewed basis makes a quaternion that shears
     * the panel.
     */
    const skewed = hand({
      wrist: [0, 1, 0],
      middle: [0.08, 1, 0],
      indexMeta: [0.09, 1.01, -0.02],
      pinky: [0.05, 0.99, 0.02],
    });
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    expect(wristPose(skewed, 0, 'left', pose)).toBe(true);
    const x = axis(pose, 1, 0, 0);
    const y = axis(pose, 0, 1, 0);
    const z = axis(pose, 0, 0, 1);
    expect(dot(x, y)).toBeCloseTo(0, 5);
    expect(dot(y, z)).toBeCloseTo(0, 5);
    expect(dot(x, z)).toBeCloseTo(0, 5);
  });

  it('survives a wrist turned right round', () => {
    // A half turn about an axis is where the naive quaternion conversion
    // divides by zero, and a wrist turned to read a watch is very close to it.
    const upsideDown = hand({
      wrist: [0, 1, 0],
      middle: [-0.08, 1, 0],
      indexMeta: [-0.07, 1, -0.02],
      pinky: [-0.07, 1, 0.02],
    });
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    expect(wristPose(upsideDown, 0, 'left', pose)).toBe(true);
    const [qx, qy, qz, qw] = [pose[3]!, pose[4]!, pose[5]!, pose[6]!];
    expect(Math.hypot(qx, qy, qz, qw)).toBeCloseTo(1, 5);
    expect(Number.isFinite(qx + qy + qz + qw)).toBe(true);
  });

  it('refuses a hand that is not a hand', () => {
    // Rather than returning a pose of zero, which would put a console at the
    // player's feet.
    const collapsed = hand({
      wrist: [0, 1, 0],
      middle: [0, 1, 0],
      indexMeta: [0, 1, 0],
      pinky: [0, 1, 0],
    });
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    expect(wristPose(collapsed, 0, 'left', pose)).toBe(false);
  });

  it('reads the second hand from its own slot', () => {
    const matrices = new Float32Array(2 * JOINTS_PER_HAND * 16);
    matrices.set(PALM_DOWN_LEFT.subarray(0, JOINTS_PER_HAND * 16), JOINTS_PER_HAND * 16);
    const pose = new Float32Array(WRIST_POSE_FLOATS);
    expect(wristPose(matrices, 0, 'left', pose)).toBe(false);
    expect(wristPose(matrices, JOINTS_PER_HAND * 16, 'left', pose)).toBe(true);
  });
});

describe('the facing gate', () => {
  const pose = new Float32Array(WRIST_POSE_FLOATS);

  it('is shut with the arm hanging by a side', () => {
    /*
     * The whole safety property. Below the threshold the menu is not drawn and
     * its detector does not run, so a hand playing a pad grid cannot press
     * anything on it — which is the one thing this panel must never do.
     */
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    // Panel faces up; eye is well off to the side and below.
    expect(facingAmount(pose, 2, 0.2, 0)).toBe(0);
  });

  it('opens when the wrist is turned to look at it', () => {
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    // Directly above, looking straight down at a panel facing up.
    expect(facingAmount(pose, pose[0]!, pose[1]! + 0.4, pose[2]!)).toBeCloseTo(1, 5);
  });

  it('ramps rather than snapping', () => {
    // So the panel arrives as a fade. A control that appears is one that was
    // not there when you started reaching for it.
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    const seen: number[] = [];
    for (let angle = 0; angle <= 80; angle += 10) {
      const r = 0.4;
      const rad = (angle * Math.PI) / 180;
      seen.push(
        facingAmount(
          pose,
          pose[0]! + Math.sin(rad) * r,
          pose[1]! + Math.cos(rad) * r,
          pose[2]!,
        ),
      );
    }
    expect(seen[0]).toBeCloseTo(1, 5);
    expect(seen.at(-1)).toBe(0);
    // Monotonic, and passing through values that are neither 0 nor 1.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]!);
    expect(seen.some((v) => v > 0.01 && v < 0.99)).toBe(true);
  });

  it('is shut when the eye is on the panel itself', () => {
    wristPose(PALM_DOWN_LEFT, 0, 'left', pose);
    expect(facingAmount(pose, pose[0]!, pose[1]!, pose[2]!)).toBe(0);
  });

  it('states a threshold that an arm at rest cannot reach', () => {
    expect(WRIST_FACING).toBeGreaterThan(0.4);
    expect(WRIST_FACING).toBeLessThan(0.85);
  });
});
