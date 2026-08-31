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
  // Tilt is a rotation about world X.
  const theta = (-pose.tiltDeg * Math.PI) / 180;
  const half = theta / 2;
  const quaternion: [number, number, number, number] = [Math.sin(half), 0, 0, Math.cos(half)];

  // Offset from centre to bottom-left corner, rotated into world space. The
  // X offset is unaffected by a rotation about X.
  const dy = -locator.height / 2;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const origin: [number, number, number] = [
    pose.centre[0] - locator.width / 2,
    pose.centre[1] + dy * c,
    pose.centre[2] + dy * s,
  ];
  return { origin, quaternion };
}

/**
 * Convert a point in a surface's local frame to world space.
 *
 * Valid for the tilt-only orientations `surfaceTransform` produces: because the
 * rotation is purely about X, it reduces to a 2D rotation in the YZ plane.
 */
export function localToWorld(
  transform: SurfaceTransform,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const [qx, , , qw] = transform.quaternion;
  const theta = 2 * Math.atan2(qx, qw);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    transform.origin[0] + x,
    transform.origin[1] + y * c - z * s,
    transform.origin[2] + y * s + z * c,
  ];
}

/** The surface's outward normal in world space. */
export function surfaceNormal(transform: SurfaceTransform): [number, number, number] {
  const [qx, , , qw] = transform.quaternion;
  const theta = 2 * Math.atan2(qx, qw);
  return [0, -Math.sin(theta), Math.cos(theta)];
}
