/**
 * Velocity mapping shared by every input surface.
 *
 * Hand tracking gives us the fingertip's speed along the pad normal at the
 * instant it crosses the strike plane. Mapping that straight to 1..127 feels
 * wrong: a real pad's dynamic range is compressed at the top (you cannot hit a
 * pad twice as hard as "hard") and expanded at the bottom (the difference
 * between a ghost note and a soft note is musically large). So we normalise
 * against a usable speed window and then bend the curve.
 */

/** Speed (m/s) mapped to velocity 1. Slower than this is still a hit, just quiet. */
export const MIN_STRIKE_SPEED = 0.08;

/** Speed (m/s) mapped to velocity 127. Beyond this we clamp. */
export const MAX_STRIKE_SPEED = 2.2;

/** Substituted when tracking drops the joint mid-strike. Mezzo-forte. */
export const DEFAULT_VELOCITY = 90;

/**
 * Curve shapes. `gamma` < 1 makes soft hits louder (easier to play quietly on a
 * surface with no physical resistance); > 1 makes the pad feel stiffer.
 */
export const VelocityCurve = {
  /** Straight line. Predictable, but soft hits are hard to land. */
  LINEAR: 1.0,
  /** Default. Slightly eased so light taps still speak. */
  NATURAL: 0.65,
  /** Very forgiving — good for finger drumming with no haptic feedback. */
  SOFT: 0.45,
  /** Requires real commitment to reach the top. Good for melodic playing. */
  HARD: 1.6,
} as const;

/**
 * Convert a strike speed in m/s to a MIDI velocity in 1..127.
 *
 * Velocity 0 is never returned: a Note On with velocity 0 is a Note Off on the
 * wire, which would leave the voice hanging.
 */
export function speedToVelocity(
  speed: number,
  gamma: number = VelocityCurve.NATURAL,
  minSpeed: number = MIN_STRIKE_SPEED,
  maxSpeed: number = MAX_STRIKE_SPEED,
): number {
  const span = maxSpeed - minSpeed;
  let t = span > 0 ? (speed - minSpeed) / span : 0;
  if (t <= 0) return 1;
  if (t >= 1) return 127;
  t = Math.pow(t, gamma);
  const v = 1 + t * 126;
  return v < 1 ? 1 : v > 127 ? 127 : Math.round(v);
}

/** Clamp any number into the 7-bit MIDI data range. */
export function clamp7(v: number): number {
  const n = v | 0;
  return n < 0 ? 0 : n > 127 ? 127 : n;
}

/** Clamp into the 14-bit range used by pitch bend and hi-res CC. */
export function clamp14(v: number): number {
  const n = v | 0;
  return n < 0 ? 0 : n > 16383 ? 16383 : n;
}
