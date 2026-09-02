import type { SurfacePose } from '@vrmc/layout';

/**
 * Putting a device down on something real.
 *
 * The arithmetic only, so it can be tested without a headset — the WebXR
 * plumbing that finds the surface is in `SurfaceAnchor.ts`.
 */

/**
 * How far above a real surface a device sits, in metres.
 *
 * Not zero. Hit tests and plane detection both report a surface with a
 * centimetre or so of uncertainty, and a device placed exactly at the reported
 * height sinks into the desk about half the time — which in passthrough reads
 * as the instrument being *inside* the furniture. A couple of millimetres of
 * clearance is invisible and always on the right side.
 */
export const SURFACE_CLEARANCE = 0.002;

/** Lying flat, face up. */
export const FLAT_TILT_DEG = 90;

/**
 * The pose for a device lying flat on a surface at `surfaceY`, turned so its
 * far edge points away from the player.
 *
 * Yaw is derived rather than kept, and that is the whole of «drop it on the
 * desk»: a device you have to then turn by hand has not been put down for you.
 * A device directly under the viewer has no meaningful direction to face, so
 * its current yaw is kept instead of being replaced by whatever `atan2` makes
 * of two numbers that are both nearly zero.
 */
export function poseOnSurface(
  current: SurfacePose,
  surfaceY: number,
  viewer: readonly [number, number, number],
): SurfacePose {
  const centre: [number, number, number] = [
    current.centre[0],
    surfaceY + SURFACE_CLEARANCE,
    current.centre[2],
  ];

  const ax = centre[0] - viewer[0];
  const az = centre[2] - viewer[2];
  const yawDeg =
    ax * ax + az * az < 1e-4
      ? (current.yawDeg ?? 0)
      : (Math.atan2(-ax, -az) * 180) / Math.PI;

  return { centre, tiltDeg: FLAT_TILT_DEG, yawDeg };
}

/**
 * Whether a horizontal surface is a plausible place to put this device.
 *
 * A room has plenty of horizontal surfaces and most of them are the floor or
 * the ceiling. This is not a general test of furniture; it is the band a person
 * would actually rest a controller on and then play it — roughly between a low
 * coffee table and a standing desk. Anything outside it is rejected rather than
 * used, because a Launchpad placed on the ceiling is worse than one left
 * floating where it was.
 */
export const SURFACE_BAND = { low: 0.25, high: 1.4 } as const;

export function isPlayableSurface(y: number): boolean {
  return y >= SURFACE_BAND.low && y <= SURFACE_BAND.high;
}

/**
 * Pick the surface a device should land on, from the candidates found below it.
 *
 * The highest one that is still under the device and inside the playable band —
 * a desk stands above the floor it is on, and the desk is what somebody meant.
 * Returns null when nothing qualifies, which the caller must treat as «leave it
 * where it is» rather than as zero.
 */
export function bestSurface(candidates: readonly number[], deviceY: number): number | null {
  let best: number | null = null;
  for (const y of candidates) {
    // Strictly below the device, with a little tolerance: a device already
    // resting on the desk must not be told to drop onto the desk it is on and
    // sink by its own clearance each time.
    if (y > deviceY + SURFACE_CLEARANCE) continue;
    if (!isPlayableSurface(y)) continue;
    if (best === null || y > best) best = y;
  }
  return best;
}
