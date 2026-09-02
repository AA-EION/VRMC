import type { ZoneLocator } from './surface.js';

/** Where a surface sits in the room and how far it is tilted back. */
export interface SurfacePose {
  /** World position of the surface's centre. */
  centre: readonly [number, number, number];
  /**
   * Tilt in degrees: 0 is a vertical panel facing the player, 90 lies flat on
   * the desk with its face upward.
   */
  tiltDeg: number;
  /**
   * Rotation about world Y, in degrees. Optional; 0 faces the player's start
   * heading, which is what every default pose here assumes.
   *
   * Yaw and tilt, and deliberately no roll. Once a device can be picked up
   * somebody has to be able to turn it to face them, so yaw is necessary — but
   * roll is not: a rolled Launchpad is one you cannot play, because the grid
   * stops being a grid the moment its rows stop being level. Hand tracking will
   * happily report thirty degrees of wrist roll nobody intended, so a pose that
   * cannot carry roll is one that cannot pick it up by accident either.
   */
  yawDeg?: number;
}

export interface SurfaceTransform {
  /** World position of the surface's local origin — its bottom-left corner. */
  origin: [number, number, number];
  /** World orientation as a quaternion (x, y, z, w). */
  quaternion: [number, number, number, number];
}

/**
 * Resolve a pose into the transform the renderer and the detector both use.
 *
 * The layouts put their origin at the bottom-left corner, which is the natural
 * frame for laying zones out but an awkward one to place a panel by. Placement
 * is expressed from the centre instead, and this converts between the two.
 *
 * Both consumers must agree exactly: the mesh is drawn at this transform and
 * the detector inverts it to find fingertips. A discrepancy does not look
 * broken — the pads simply trigger somewhere slightly other than where they
 * appear, which is far harder to diagnose than an obvious failure.
 */
export function surfaceTransform(locator: ZoneLocator, pose: SurfacePose): SurfaceTransform {
  // Yaw about world Y, then tilt about the surface's own X. Composed in that
  // order — `yaw * tilt` — so tilting always tips the panel back toward whoever
  // it is facing, rather than toward wherever -Z happens to be.
  const theta = (-pose.tiltDeg * Math.PI) / 180;
  const psi = ((pose.yawDeg ?? 0) * Math.PI) / 180;
  const quaternion = multiply(
    [0, Math.sin(psi / 2), 0, Math.cos(psi / 2)],
    [Math.sin(theta / 2), 0, 0, Math.cos(theta / 2)],
  );

  // Offset from centre to bottom-left corner, rotated into world space.
  const offset = rotate(quaternion, -locator.width / 2, -locator.height / 2, 0);
  const origin: [number, number, number] = [
    pose.centre[0] + offset[0],
    pose.centre[1] + offset[1],
    pose.centre[2] + offset[2],
  ];
  return { origin, quaternion };
}

/** Hamilton product, `a` then `b` applied to a vector as `a * b * v`. */
function multiply(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Rotate a vector by a quaternion.
 *
 * Written out longhand rather than through a library, for the same reason
 * `PokeDetector.toLocal` is: this package has no dependencies and the two ends
 * of a transform must agree exactly. A discrepancy here does not look broken —
 * the pads simply trigger somewhere slightly other than where they appear.
 */
function rotate(
  q: readonly [number, number, number, number],
  vx: number,
  vy: number,
  vz: number,
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  // v' = v + 2 * (qv x (qv x v + w*v))
  const tx = qy * vz - qz * vy + qw * vx;
  const ty = qz * vx - qx * vz + qw * vy;
  const tz = qx * vy - qy * vx + qw * vz;
  return [
    vx + 2 * (qy * tz - qz * ty),
    vy + 2 * (qz * tx - qx * tz),
    vz + 2 * (qx * ty - qy * tx),
  ];
}

/**
 * Convert a point in a surface's local frame to world space.
 *
 * This used to shortcut the maths: with a tilt-only orientation the rotation is
 * purely about X and reduces to a 2D rotation in the YZ plane, which was true
 * and is not any more. A yawed panel has a quaternion with a Y component, and
 * recovering an angle from `atan2(qx, qw)` on one of those returns a number
 * that means nothing — so a device somebody had turned to face them would draw
 * in one place and answer fingers in another. It is the general rotation now.
 */
export function localToWorld(
  transform: SurfaceTransform,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const v = rotate(transform.quaternion, x, y, z);
  return [
    transform.origin[0] + v[0],
    transform.origin[1] + v[1],
    transform.origin[2] + v[2],
  ];
}

/**
 * `localToWorld` without the array.
 *
 * The allocating form is fine for placement, which happens when somebody moves
 * something. This one is for the note path: a chord is ten strikes in a frame,
 * each of which now wants the world position of the pad it hit so the click can
 * be placed there, and ten small arrays a frame is the sort of drip the whole
 * design is arranged to avoid.
 */
export function localToWorldInto(
  transform: SurfaceTransform,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  offset = 0,
): void {
  const [qx, qy, qz, qw] = transform.quaternion;
  const tx = qy * z - qz * y + qw * x;
  const ty = qz * x - qx * z + qw * y;
  const tz = qx * y - qy * x + qw * z;
  out[offset] = transform.origin[0] + x + 2 * (qy * tz - qz * ty);
  out[offset + 1] = transform.origin[1] + y + 2 * (qz * tx - qx * tz);
  out[offset + 2] = transform.origin[2] + z + 2 * (qx * ty - qy * tx);
}

/** The surface's outward normal in world space. */
export function surfaceNormal(transform: SurfaceTransform): [number, number, number] {
  return rotate(transform.quaternion, 0, 0, 1);
}
