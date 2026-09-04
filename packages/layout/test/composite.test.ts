// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import { CompositeLayout, type SurfacePart } from '../src/composite.js';
import { KeyboardLayout, LAUNCHKEY_25 } from '../src/keys.js';
import { PadGridLayout, MPC_4X4 } from '../src/pads.js';

/**
 * One surface built from several.
 *
 * A Launchkey is four regions on one plane — keys, pads, knobs, faders — with
 * different sizes and spacings, and it has to read as a single device to the
 * poke detector, because you do not stop playing when your hand crosses from
 * the keys to the pads.
 *
 * The renumbering is the whole difficulty: each part numbers its zones from
 * zero, and the composite has to make them unique while remembering where each
 * came from.
 */

const keys = new KeyboardLayout(LAUNCHKEY_25);
const pads = new PadGridLayout(MPC_4X4);

function build(): CompositeLayout {
  return new CompositeLayout([
    { id: 'keys', locator: keys, x: 0, y: 0 },
    { id: 'pads', locator: pads, x: 0, y: keys.height + 0.02 },
  ]);
}

describe('composing', () => {
  it('holds every zone from every part', () => {
    const c = build();
    expect(c.zones).toHaveLength(keys.zones.length + pads.zones.length);
  });

  it('renumbers so a zone can be found by its own index', () => {
    /*
     * `zones[i].index === i` is relied on everywhere downstream — the
     * highlighter and the router both index the array directly with what
     * `locate` returned. Two parts each numbering from zero would collide.
     */
    const c = build();
    for (const [i, zone] of c.zones.entries()) expect(zone.index).toBe(i);
  });

  it('remembers which part each zone came from, and its index there', () => {
    // The note and the LED state belong to the part, not the composite, so
    // mapping back has to be possible.
    const c = build();
    const first = c.originOf(0)!;
    expect(first.part).toBe('keys');
    expect(first.localIndex).toBe(0);

    const firstPad = c.originOf(keys.zones.length)!;
    expect(firstPad.part).toBe('pads');
    expect(firstPad.localIndex).toBe(0);
  });

  it('keeps each part\'s notes, rather than renumbering those too', () => {
    // The index is the composite's business; the note is the device's.
    const c = build();
    expect(c.zones[0]!.note).toBe(keys.zones[0]!.note);
    expect(c.zones[keys.zones.length]!.note).toBe(pads.zones[0]!.note);
  });

  it('offsets each part\'s rectangles into the shared plane', () => {
    const c = build();
    const padZone = c.zones[keys.zones.length]!;
    expect(padZone.rect.y).toBeCloseTo(pads.zones[0]!.rect.y + keys.height + 0.02, 6);
    // And leaves the untranslated axis alone.
    expect(padZone.rect.x).toBeCloseTo(pads.zones[0]!.rect.x, 6);
  });

  it('spans everything it contains', () => {
    const c = build();
    expect(c.height).toBeCloseTo(keys.height + 0.02 + pads.height, 6);
    expect(c.width).toBeCloseTo(Math.max(keys.width, pads.width), 6);
  });
});

describe('finding a zone', () => {
  it('finds a key by a point in the keys region', () => {
    const c = build();
    const zone = keys.zones[5]!;
    const hit = c.locate(
      zone.rect.x + zone.rect.width / 2,
      zone.rect.y + zone.rect.height / 2,
    );
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(c.originOf(hit)!.part).toBe('keys');
    expect(c.originOf(hit)!.localIndex).toBe(5);
  });

  it('finds a pad by a point in the pads region', () => {
    const c = build();
    const zone = pads.zones[3]!;
    const hit = c.locate(
      zone.rect.x + zone.rect.width / 2,
      zone.rect.y + zone.rect.height / 2 + keys.height + 0.02,
    );
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(c.originOf(hit)!.part).toBe('pads');
    expect(c.originOf(hit)!.localIndex).toBe(3);
  });

  it('agrees with the zone rectangles it published', () => {
    /*
     * The strongest check available without a headset: every zone's own centre
     * must locate back to that zone. An offset applied to the rectangles but
     * not to the lookup — or the reverse — passes every test above and fails
     * this one, and in a headset it is a surface whose pads are drawn in one
     * place and answer in another.
     */
    const c = build();
    for (const zone of c.zones) {
      const hit = c.locate(
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
      );
      expect(hit, `zone ${zone.index} (${zone.label})`).toBe(zone.index);
    }
  });

  it('misses cleanly outside every part', () => {
    const c = build();
    expect(c.locate(-0.5, 0.1)).toBe(-1);
    expect(c.locate(0.1, -0.5)).toBe(-1);
    expect(c.locate(c.width + 0.5, c.height + 0.5)).toBe(-1);
  });

  it('misses in the gap between two parts', () => {
    // The 20 mm strip between the keys and the pads is not playable, and a
    // composite that clamped to the nearest part would fire the wrong zone
    // from a finger resting in the gap.
    const c = build();
    expect(c.locate(keys.width / 2, keys.height + 0.01)).toBe(-1);
  });

  it('lists a part\'s zones', () => {
    const c = build();
    expect(c.zonesOf('pads')).toHaveLength(pads.zones.length);
    expect(c.zonesOf('keys')).toHaveLength(keys.zones.length);
    expect(c.zonesOf('nothing')).toHaveLength(0);
  });
});

describe('an empty or single part', () => {
  it('composes nothing without falling over', () => {
    const c = new CompositeLayout([]);
    expect(c.zones).toHaveLength(0);
    expect(c.locate(0, 0)).toBe(-1);
  });

  it('passes a single part through unchanged', () => {
    const only: SurfacePart[] = [{ id: 'pads', locator: pads, x: 0, y: 0 }];
    const c = new CompositeLayout(only);
    expect(c.width).toBeCloseTo(pads.width, 6);
    for (const [i, zone] of c.zones.entries()) {
      expect(zone.note).toBe(pads.zones[i]!.note);
    }
  });
});
