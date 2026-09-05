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

/* ---- Fitting the curve to a particular pair of hands --------------------- */

/**
 * The three strikes a calibration asks for, as peak approach speeds in m/s.
 */
export interface VelocitySamples {
  soft: number;
  medium: number;
  hard: number;
}

/** A curve fitted to one person, as `speedToVelocity` takes it. */
export interface VelocityFit {
  minSpeed: number;
  maxSpeed: number;
  gamma: number;
}

/** Where a medium strike should land. Mezzo-forte, the middle of the range. */
const MEDIUM_TARGET = 80;

/**
 * Bounds on the fitted exponent.
 *
 * Outside these the curve stops being a curve: below 0.2 almost any contact
 * reaches full velocity, above 3 nothing but a slam does. A fit that wants a
 * number outside the band is a fit built on bad samples, and clamping it is
 * kinder than accepting an instrument that only plays one dynamic.
 */
const GAMMA_RANGE = { low: 0.2, high: 3 } as const;

/**
 * Fit the velocity curve to how somebody actually hits a pad.
 *
 * `VelocityCurve`'s presets are a guess at an average hand, and hand tracking
 * makes the spread between people much wider than it is on hardware: there is
 * no physical surface to stop against, so how fast a finger is travelling when
 * it crosses the plane is a matter of personal style rather than of the
 * instrument. Somebody who plays lightly can be a factor of three below
 * somebody who does not, and both of them find the presets wrong in opposite
 * directions.
 *
 * Three strikes are enough because the shape has three degrees of freedom and
 * each sample pins one: soft sets the floor, hard sets the ceiling, and medium
 * decides how the range in between is distributed.
 *
 * Returns null when the samples do not describe a usable range — the strikes
 * were not in order, or two of them were effectively the same hit. A refusal
 * here is a preset kept, which is a working instrument; a fit forced out of bad
 * samples is one that plays nothing but ghost notes.
 */
export function fitVelocityCurve(samples: VelocitySamples): VelocityFit | null {
  const { soft, medium, hard } = samples;
  if (![soft, medium, hard].every((v) => Number.isFinite(v) && v > 0)) return null;
  // Strictly increasing, with enough of a gap to have meant something. Two
  // strikes within 5 cm/s of each other are the same strike as far as anybody's
  // hand is concerned.
  if (!(soft + 0.05 <= medium && medium + 0.05 <= hard)) return null;

  const span = hard - soft;
  if (span < 0.15) return null;

  const t = (medium - soft) / span;
  if (!(t > 0.02 && t < 0.98)) return null;

  const target = (MEDIUM_TARGET - 1) / 126;
  const gamma = Math.log(target) / Math.log(t);
  if (!Number.isFinite(gamma)) return null;

  return {
    minSpeed: soft,
    maxSpeed: hard,
    gamma: Math.min(GAMMA_RANGE.high, Math.max(GAMMA_RANGE.low, gamma)),
  };
}
