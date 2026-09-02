import { describe, it, expect } from 'vitest';
import {
  BUDGET,
  CALIBRATION_FOV,
  DISC_RADIUS,
  GALAXY_FRAG,
  GALAXY_INK,
  GALAXY_VERT,
  MAX_DENSITY,
  buildDisc,
  buildField,
  buildMotes,
  rng,
  worldPointSize,
  type Cloud,
} from '../src/xr/galaxy.js';

/**
 * The galaxy, without a GPU.
 *
 * Everything here is arithmetic that decides what the room looks like and what
 * it costs, which is exactly the part a headless test can hold onto. What it
 * cannot check is that the shaders compile or that the result is beautiful —
 * see test/render-smoke.mjs for the first and a headset for the second.
 */

/** Distance of a particle from the cloud's origin. */
function radiusOf(cloud: Cloud, i: number): number {
  const x = cloud.position[i * 3]!;
  const y = cloud.position[i * 3 + 1]!;
  const z = cloud.position[i * 3 + 2]!;
  return Math.sqrt(x * x + y * y + z * z);
}

describe('the deterministic PRNG', () => {
  it('gives the same sequence for the same seed', () => {
    const a = rng(0x1e04);
    const b = rng(0x1e04);
    for (let i = 0; i < 64; i++) expect(a()).toBe(b());
  });

  it('gives different sequences for different seeds', () => {
    const a = rng(0x1e04);
    const b = rng(0x5c0d);
    // Not a statistical claim; just that the clouds are not the same cloud.
    const differ = Array.from({ length: 32 }, () => a() !== b()).filter(Boolean);
    expect(differ.length).toBeGreaterThan(30);
  });

  it('stays inside [0, 1)', () => {
    const r = rng(0x3f11);
    for (let i = 0; i < 10_000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('the disc', () => {
  const disc = buildDisc(4000);

  it('is the same galaxy every time it is built', () => {
    // The whole reason the PRNG is seeded: a room that reshuffles itself is a
    // room nobody learns the shape of.
    const again = buildDisc(4000);
    expect(Array.from(disc.position)).toEqual(Array.from(again.position));
    expect(Array.from(disc.density)).toEqual(Array.from(again.density));
  });

  it('stays inside the radius it advertises', () => {
    for (let i = 0; i < 4000; i++) {
      // The rim frays outward by its own scatter, which is what makes it a
      // galaxy rather than a disc with an edge; the allowance is that jitter.
      expect(radiusOf(disc, i)).toBeLessThan(DISC_RADIUS * 1.5);
    }
  });

  it('is a bulge and not a ring', () => {
    // More than a fifth of the particles inside the inner third of the radius.
    // A uniform disc would put about a ninth there.
    let inner = 0;
    for (let i = 0; i < 4000; i++) if (radiusOf(disc, i) < DISC_RADIUS / 3) inner++;
    expect(inner / 4000).toBeGreaterThan(0.2);
  });

  it('is a disc, and flattens as it goes out', () => {
    /*
     * «Flattens» is a ratio, not a height, and getting that backwards is easy:
     * the *absolute* thickness grows outward, because the scatter the arms fray
     * with grows faster (0.22 + 0.13r) than the flattening term damps it
     * (1 / (1 + 0.3r)). What falls — and what the eye actually reads as a disc
     * rather than a cloud — is thickness measured against radius.
     */
    let nearRatio = 0;
    let nearCount = 0;
    let farRatio = 0;
    let farCount = 0;
    for (let i = 0; i < 4000; i++) {
      const r = radiusOf(disc, i);
      if (r < 1e-3) continue;
      const ratio = Math.abs(disc.position[i * 3 + 1]!) / r;
      if (r < DISC_RADIUS * 0.25) {
        nearRatio += ratio;
        nearCount++;
      } else if (r > DISC_RADIUS * 0.75) {
        farRatio += ratio;
        farCount++;
      }
    }
    expect(nearCount).toBeGreaterThan(0);
    expect(farCount).toBeGreaterThan(0);
    expect(farRatio / farCount).toBeLessThan(nearRatio / nearCount);
    // …and it is a disc at every radius: nowhere is it as tall as it is wide.
    expect(nearRatio / nearCount).toBeLessThan(0.5);
  });

  it("carries the manual's ramp: full ink at the core, almost none at the rim", () => {
    let core = 0;
    let coreCount = 0;
    let rim = 0;
    let rimCount = 0;
    for (let i = 0; i < 4000; i++) {
      const r = radiusOf(disc, i);
      if (r < DISC_RADIUS * 0.15) {
        core += disc.density[i]!;
        coreCount++;
      } else if (r > DISC_RADIUS * 0.85) {
        rim += disc.density[i]!;
        rimCount++;
      }
    }
    expect(core / coreCount).toBeGreaterThan(0.6);
    expect(rim / rimCount).toBeLessThan(0.25);
  });

  it('never asks for zero ink, which would be a particle drawn for nothing', () => {
    for (let i = 0; i < 4000; i++) expect(disc.density[i]).toBeGreaterThan(0);
  });
});

describe('the motes', () => {
  const motes = buildMotes(BUDGET.motes);

  it("stay out of arm's reach", () => {
    /*
     * The furthest instrument sits 0.6 m out and a hand reaches perhaps 0.8.
     * A mote nearer than that is a speck the eye can actually focus on, sitting
     * between the player and a pad — which reads as dirt on the lens rather
     * than as air in the room.
     */
    for (let i = 0; i < BUDGET.motes; i++) {
      expect(radiusOf(motes, i)).toBeGreaterThan(1.0);
    }
  });

  it('are flattened into a room rather than a ball', () => {
    let widest = 0;
    let tallest = 0;
    for (let i = 0; i < BUDGET.motes; i++) {
      widest = Math.max(widest, Math.abs(motes.position[i * 3]!));
      tallest = Math.max(tallest, Math.abs(motes.position[i * 3 + 1]!));
    }
    expect(tallest).toBeLessThan(widest * 0.75);
  });
});

describe('the far field', () => {
  const field = buildField(BUDGET.field);

  it('sits beyond the disc and inside the far plane', () => {
    /*
     * The second half of this is load-bearing and was once wrong: the camera's
     * far plane was 20 m, and geometry past it is not dimmed but clipped in the
     * projection, so the entire shell was drawn and discarded. App.tsx now sets
     * 100; this asserts the cloud still fits inside it.
     */
    for (let i = 0; i < BUDGET.field; i++) {
      const r = radiusOf(field, i);
      expect(r).toBeGreaterThan(DISC_RADIUS);
      expect(r).toBeLessThan(100);
    }
  });
});

describe('the budget', () => {
  it('is affordable enough to share a frame with the instruments', () => {
    // Not a benchmark — a ceiling. Points are fill-rate and everything here is
    // drawn twice, once per eye, inside the same 11 ms as ten fingertips, four
    // poke detectors and a packet. The studio's own room spends 32 000 on the
    // disc alone because the disc is all it is doing.
    const total = BUDGET.disc + BUDGET.field + BUDGET.motes;
    expect(total).toBeLessThanOrEqual(24_000);
  });
});

describe('the ink', () => {
  it('is the reserved absolute, and leaves as one', () => {
    // The identity reserves Absolute Black and Absolute White for the galaxy's
    // core and nothing else. 0 and 1 have to reach the shader unchanged, which
    // is why these are raw triples and never a three Color.
    expect(GALAXY_INK.light).toEqual([0, 0, 0]);
    expect(GALAXY_INK.dark).toEqual([1, 1, 1]);
  });

  it('leaves the arms below the ceiling the core is allowed', () => {
    expect(MAX_DENSITY).toBeGreaterThan(0.9);
    expect(MAX_DENSITY).toBeLessThan(1);
  });
});

describe('the shaders', () => {
  it('size points from the projection actually in force', () => {
    /*
     * The one thing in the vertex shader that a headset breaks if it is got
     * wrong. There are two projections per frame, one per eye, with their own
     * asymmetric frusta — so the projection term has to be applied in the
     * shader. Folding it into the uniform would size every point for a camera
     * that is not the one drawing it.
     */
    expect(GALAXY_VERT).toContain('projectionMatrix[1][1]');
  });

  it('composite as premultiplied «over»', () => {
    expect(GALAXY_FRAG).toContain('vec4(uInk * a, a)');
  });

  it('divides the calibration fov back out of the point size', () => {
    // The studio tuned sizeFactor against its own 55° flat camera. The world
    // size must carry no projection at all, or a headset inherits a desktop's.
    const size = worldPointSize(0.0135);
    const expected = (0.0135 * 2) / (1 / Math.tan((CALIBRATION_FOV * Math.PI) / 360));
    expect(size).toBeCloseTo(expected, 12);
  });
});
