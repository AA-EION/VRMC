import { describe, it, expect } from 'vitest';
import { isAccidental } from '@vrmc/protocol';
import { KeyboardLayout, LAUNCHKEY_25, MPC_4X4, PadGridLayout, LAUNCHPAD_8X8 } from '../src/index.js';

describe('PadGridLayout', () => {
  const grid = new PadGridLayout(MPC_4X4);

  it('builds a full grid with MPC note numbering', () => {
    expect(grid.zones).toHaveLength(16);
    // Bottom-left is C1; the grid walks right then up.
    expect(grid.zones[0]!.note).toBe(36);
    expect(grid.zones[3]!.note).toBe(39);
    expect(grid.zones[4]!.note).toBe(40); // start of the second row
    expect(grid.zones[15]!.note).toBe(51);
  });

  it('locates the pad under a point at each corner', () => {
    const { padSize } = MPC_4X4;
    expect(grid.locate(0.001, 0.001)).toBe(0);
    expect(grid.locate(padSize - 0.001, padSize - 0.001)).toBe(0);
    expect(grid.locate(grid.width - 0.001, grid.height - 0.001)).toBe(15);
  });

  it('treats the gutter between pads as a miss', () => {
    const { padSize, gap } = MPC_4X4;
    const inGutter = padSize + gap * 0.5;
    expect(grid.locate(inGutter, 0.01)).toBe(-1);
    expect(grid.locate(0.01, inGutter)).toBe(-1);
  });

  it('rejects points outside the surface', () => {
    expect(grid.locate(-0.01, 0.01)).toBe(-1);
    expect(grid.locate(0.01, -0.01)).toBe(-1);
    expect(grid.locate(grid.width + 0.01, 0.01)).toBe(-1);
    expect(grid.locate(0.01, grid.height + 0.01)).toBe(-1);
  });

  it('round-trips every zone centre back to its own index', () => {
    for (const zone of grid.zones) {
      const cx = zone.rect.x + zone.rect.width / 2;
      const cy = zone.rect.y + zone.rect.height / 2;
      expect(grid.locate(cx, cy)).toBe(zone.index);
    }
  });

  it('supports an 8x8 Launchpad grid', () => {
    const lp = new PadGridLayout(LAUNCHPAD_8X8);
    expect(lp.zones).toHaveLength(64);
    for (const zone of lp.zones) {
      const cx = zone.rect.x + zone.rect.width / 2;
      const cy = zone.rect.y + zone.rect.height / 2;
      expect(lp.locate(cx, cy)).toBe(zone.index);
    }
  });
});

describe('KeyboardLayout', () => {
  const kb = new KeyboardLayout(LAUNCHKEY_25);

  it('spans 25 keys from C2 with 15 white keys', () => {
    expect(kb.zones).toHaveLength(25);
    expect(kb.zones[0]!.note).toBe(48);
    expect(kb.zones[24]!.note).toBe(72);
    // Two octaves of naturals (7 each) plus the top C.
    expect(kb.whiteCount).toBe(15);
    expect(kb.width).toBeCloseTo(15 * LAUNCHKEY_25.whiteWidth, 10);
  });

  it('marks accidentals and raises them above the whites', () => {
    const cSharp = kb.zones[1]!;
    expect(cSharp.accidental).toBe(true);
    expect(cSharp.label).toBe('C#2'); // MIDI 49, with 60 = C3
    expect(cSharp.raise).toBeGreaterThan(kb.zones[0]!.raise);
  });

  it('maps note to zone by subtraction in both directions', () => {
    for (const zone of kb.zones) {
      expect(kb.zoneForNote(zone.note)).toBe(zone.index);
    }
    expect(kb.zoneForNote(47)).toBe(-1);
    expect(kb.zoneForNote(73)).toBe(-1);
  });

  it('round-trips every key centre back to its own index', () => {
    for (const zone of kb.zones) {
      const cx = zone.rect.x + zone.rect.width / 2;
      const cy = zone.rect.y + zone.rect.height / 2;
      expect(kb.locate(cx, cy)).toBe(zone.index);
    }
  });

  it('gives black keys priority where they overlap a white key', () => {
    const cSharp = kb.zones[1]!;
    const cx = cSharp.rect.x + cSharp.rect.width / 2;
    // Deep in the black-key band: the accidental wins.
    expect(kb.locate(cx, kb.height - 0.005)).toBe(1);
    // Same X but in front of the black keys: the white key underneath wins.
    const front = kb.locate(cx, 0.005);
    expect(front).toBeGreaterThanOrEqual(0);
    expect(kb.zones[front]!.accidental).toBe(false);
  });

  it('finds a white key in the gap between two black keys', () => {
    // D natural's tail between C# and D#, sampled in the black-key band.
    const d = kb.zones[2]!;
    const cx = d.rect.x + d.rect.width / 2;
    const hit = kb.locate(cx, kb.height - 0.005);
    expect(hit).toBe(2);
  });

  it('never reports an accidental in front of the black band', () => {
    const step = 0.0005;
    for (let x = 0; x < kb.width; x += step) {
      const hit = kb.locate(x, kb.blackBandStartY - 0.001);
      expect(hit).toBeGreaterThanOrEqual(0);
      expect(kb.zones[hit]!.accidental).toBe(false);
    }
  });

  it('keeps black keys inside the surface and non-overlapping', () => {
    const blacks = kb.zones.filter((z) => z.accidental);
    for (const b of blacks) {
      expect(b.rect.x).toBeGreaterThanOrEqual(0);
      expect(b.rect.x + b.rect.width).toBeLessThanOrEqual(kb.width);
    }
    for (let i = 1; i < blacks.length; i++) {
      const prev = blacks[i - 1]!;
      const cur = blacks[i]!;
      expect(cur.rect.x).toBeGreaterThan(prev.rect.x + prev.rect.width);
    }
  });

  it('assigns accidentals per the standard pattern across the range', () => {
    for (const zone of kb.zones) {
      expect(zone.accidental).toBe(isAccidental(zone.note));
    }
  });
});
