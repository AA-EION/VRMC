// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import { fitVelocityCurve, speedToVelocity, VelocityCurve } from '../src/index.js';

/**
 * Fitting the curve to a particular pair of hands.
 *
 * The presets are a guess at an average hand, and hand tracking makes the
 * spread between people much wider than it is on hardware: there is no physical
 * surface to stop against, so how fast a finger is travelling when it crosses
 * the plane is personal style rather than a property of the instrument.
 */

describe('fitting three strikes', () => {
  it('puts a medium strike in the middle of the range', () => {
    // The whole point: after calibration, the hit somebody thinks of as medium
    // sends something a DAW treats as mezzo-forte.
    const fit = fitVelocityCurve({ soft: 0.3, medium: 0.9, hard: 2.0 })!;
    expect(fit).not.toBeNull();
    const v = speedToVelocity(0.9, fit.gamma, fit.minSpeed, fit.maxSpeed);
    expect(v).toBeGreaterThan(74);
    expect(v).toBeLessThan(86);
  });

  it('puts the soft and hard strikes at the ends', () => {
    const fit = fitVelocityCurve({ soft: 0.3, medium: 0.9, hard: 2.0 })!;
    expect(speedToVelocity(0.3, fit.gamma, fit.minSpeed, fit.maxSpeed)).toBe(1);
    expect(speedToVelocity(2.0, fit.gamma, fit.minSpeed, fit.maxSpeed)).toBe(127);
  });

  it('fits a light player and a heavy one to the same three velocities', () => {
    /*
     * The reason this exists. Somebody who plays lightly can be a factor of
     * three below somebody who does not, and the presets are wrong for both in
     * opposite directions. After fitting, the same three strikes mean the same
     * three things.
     */
    const light = fitVelocityCurve({ soft: 0.15, medium: 0.35, hard: 0.8 })!;
    const heavy = fitVelocityCurve({ soft: 0.6, medium: 1.5, hard: 3.2 })!;

    for (const [fit, samples] of [
      [light, { soft: 0.15, medium: 0.35, hard: 0.8 }],
      [heavy, { soft: 0.6, medium: 1.5, hard: 3.2 }],
    ] as const) {
      expect(speedToVelocity(samples.soft, fit.gamma, fit.minSpeed, fit.maxSpeed)).toBe(1);
      const medium = speedToVelocity(samples.medium, fit.gamma, fit.minSpeed, fit.maxSpeed);
      expect(Math.abs(medium - 80)).toBeLessThan(6);
      expect(speedToVelocity(samples.hard, fit.gamma, fit.minSpeed, fit.maxSpeed)).toBe(127);
    }
  });

  it('stays monotonic, so harder is always louder', () => {
    const fit = fitVelocityCurve({ soft: 0.2, medium: 0.7, hard: 1.9 })!;
    let previous = 0;
    for (let speed = 0.2; speed <= 1.9; speed += 0.02) {
      const v = speedToVelocity(speed, fit.gamma, fit.minSpeed, fit.maxSpeed);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it('keeps the exponent inside a band that is still a curve', () => {
    /*
     * Outside it the curve stops being one: very low and almost any contact
     * reaches full velocity, very high and nothing but a slam does. A fit that
     * wants a number outside the band is one built on bad samples, and clamping
     * beats shipping an instrument with a single dynamic.
     */
    const nearlySoft = fitVelocityCurve({ soft: 0.2, medium: 0.26, hard: 3.0 })!;
    expect(nearlySoft.gamma).toBeGreaterThanOrEqual(0.2);
    expect(nearlySoft.gamma).toBeLessThanOrEqual(3);

    const nearlyHard = fitVelocityCurve({ soft: 0.2, medium: 2.9, hard: 3.0 })!;
    expect(nearlyHard.gamma).toBeGreaterThanOrEqual(0.2);
    expect(nearlyHard.gamma).toBeLessThanOrEqual(3);
  });
});

describe('refusing a fit', () => {
  /*
   * A refusal is the preset kept, which is a working instrument. A fit forced
   * out of bad samples is one that plays nothing but ghost notes — and the
   * person who calibrated it has no way of knowing that is what happened.
   */
  it('refuses strikes that are not in order', () => {
    expect(fitVelocityCurve({ soft: 1.5, medium: 0.9, hard: 2.0 })).toBeNull();
    expect(fitVelocityCurve({ soft: 0.3, medium: 2.5, hard: 2.0 })).toBeNull();
  });

  it('refuses two strikes that were really the same strike', () => {
    expect(fitVelocityCurve({ soft: 0.9, medium: 0.92, hard: 2.0 })).toBeNull();
    expect(fitVelocityCurve({ soft: 0.3, medium: 1.98, hard: 2.0 })).toBeNull();
  });

  it('refuses a range too narrow to have three dynamics in it', () => {
    expect(fitVelocityCurve({ soft: 0.5, medium: 0.56, hard: 0.62 })).toBeNull();
  });

  it('refuses anything that is not a number of metres per second', () => {
    expect(fitVelocityCurve({ soft: NaN, medium: 0.9, hard: 2 })).toBeNull();
    expect(fitVelocityCurve({ soft: 0, medium: 0.9, hard: 2 })).toBeNull();
    expect(fitVelocityCurve({ soft: -1, medium: 0.9, hard: 2 })).toBeNull();
    expect(fitVelocityCurve({ soft: 0.3, medium: 0.9, hard: Infinity })).toBeNull();
  });

  it('is a different mapping from the preset it replaces', () => {
    // Otherwise the whole routine is ceremony.
    const fit = fitVelocityCurve({ soft: 0.6, medium: 1.5, hard: 3.2 })!;
    const before = speedToVelocity(1.5, VelocityCurve.SOFT);
    const after = speedToVelocity(1.5, fit.gamma, fit.minSpeed, fit.maxSpeed);
    expect(Math.abs(after - before)).toBeGreaterThan(5);
  });
});
