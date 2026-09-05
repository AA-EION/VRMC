// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  ControlStripLayout,
  FADER_ROW_9,
  KNOB_ROW_8,
} from '../src/strip.js';

/**
 * A row of knobs or faders.
 *
 * These are pinched and dragged rather than poked, so the zones are not there
 * to be pressed — they are there so the renderer, the highlighter and the
 * placement code can treat a knob row as part of the device it belongs to
 * rather than something tracked separately that drifts when the device moves.
 */

describe('a knob row', () => {
  const strip = new ControlStripLayout(KNOB_ROW_8);

  it('has one zone per knob', () => {
    expect(strip.zones).toHaveLength(8);
  });

  it('numbers the CCs consecutively from the base', () => {
    expect(strip.zones.map((z) => z.note)).toEqual([21, 22, 23, 24, 25, 26, 27, 28]);
  });

  it('spans its controls and the gaps between, but no trailing gap', () => {
    // A trailing gap would make the device wider than it is, and the extra
    // millimetres land between it and whatever sits beside it.
    const { width, gap, count } = KNOB_ROW_8;
    expect(strip.width).toBeCloseTo(count * width + (count - 1) * gap, 6);
  });

  it('finds each knob from its own centre', () => {
    for (const zone of strip.zones) {
      expect(
        strip.locate(
          zone.rect.x + zone.rect.width / 2,
          zone.rect.y + zone.rect.height / 2,
        ),
      ).toBe(zone.index);
    }
  });

  it('misses in the gap between two knobs', () => {
    /*
     * The gap is not a control. A strip that divided by the pitch and stopped
     * would answer with whichever knob came first, so a hand resting between
     * two of them would grab one — and 14 mm of gap against 20 mm of knob is a
     * lot of surface to be wrong about.
     */
    const first = strip.zones[0]!;
    const between = first.rect.x + first.rect.width + KNOB_ROW_8.gap / 2;
    expect(strip.locate(between, 0.01)).toBe(-1);
  });

  it('misses above and below the row', () => {
    expect(strip.locate(0.005, -0.01)).toBe(-1);
    expect(strip.locate(0.005, strip.height + 0.01)).toBe(-1);
  });

  it('misses past the last knob', () => {
    expect(strip.locate(strip.width + 0.05, 0.01)).toBe(-1);
  });
});

describe('a fader row', () => {
  const strip = new ControlStripLayout(FADER_ROW_9);

  it('has nine, because the ninth is the master', () => {
    expect(strip.zones).toHaveLength(9);
    expect(strip.zones.map((z) => z.note)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49]);
  });

  it('is taller than it is wide per control, unlike a knob', () => {
    // A fader's zone is its travel. One shaped like a knob would be a control
    // you could only grab at one end of its throw.
    const zone = strip.zones[0]!;
    expect(zone.rect.height).toBeGreaterThan(zone.rect.width);
  });

  it('finds each fader from its own centre', () => {
    for (const zone of strip.zones) {
      expect(
        strip.locate(
          zone.rect.x + zone.rect.width / 2,
          zone.rect.y + zone.rect.height / 2,
        ),
      ).toBe(zone.index);
    }
  });

  it('treats none of them as accidentals', () => {
    // The renderer colours accidentals differently, and a fader drawn as a
    // black key would be a black key.
    expect(strip.zones.every((z) => !z.accidental)).toBe(true);
  });
});
