// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  buildLaunchkeyLayout,
  isContinuousPart,
  LaunchkeyPart,
} from '../src/LaunchkeyLayout.js';
import { LAUNCHKEY_MK3_49 } from '../src/launchkeyMk3.js';
import { ButtonRole } from '../src/types.js';

/**
 * The Launchkey's surface.
 *
 * Four regions on one plane. What is worth testing here is not that the numbers
 * are pretty but that the surface agrees with the *spec* — the two are written
 * separately, and a layout with eight faders under a spec with nine is a
 * control Live writes to that nobody can reach.
 */
const layout = buildLaunchkeyLayout();

const spec = LAUNCHKEY_MK3_49;
const countIn = (part: string): number => layout.zonesOf(part).length;
const specCount = (role: string): number =>
  spec.controls.filter((c) => c.role === role).length;

describe('the surface matches the spec it is for', () => {
  /*
   * Each of these is a count that exists twice — once as controls the device
   * declares to a DAW, once as zones a hand can reach. They are written in
   * different files for different purposes, and a mismatch is silent: the DAW
   * side works, and the control simply is not there to touch.
   */
  it('has a zone for every key', () => {
    expect(countIn(LaunchkeyPart.KEYS)).toBe(specCount(ButtonRole.KEY));
  });

  it('has a zone for every pad', () => {
    expect(countIn(LaunchkeyPart.PADS)).toBe(specCount(ButtonRole.GRID));
  });

  it('has a zone for every knob', () => {
    expect(countIn(LaunchkeyPart.KNOBS)).toBe(specCount(ButtonRole.KNOB));
  });

  it('has a zone for all nine faders, including the master', () => {
    expect(countIn(LaunchkeyPart.FADERS)).toBe(specCount(ButtonRole.FADER));
    expect(countIn(LaunchkeyPart.FADERS)).toBe(9);
  });

  it('sends the CC numbers the spec declares, for the knobs and faders', () => {
    // The zones carry the CC in `note`. If these disagreed, a knob would move
    // a parameter the DAW believes belongs to a different control.
    const knobCcs = layout.zonesOf(LaunchkeyPart.KNOBS).map((z) => z.note);
    const specKnobCcs = spec.controls
      .filter((c) => c.role === ButtonRole.KNOB)
      .map((c) => c.index);
    expect(knobCcs).toEqual(specKnobCcs);

    const faderCcs = layout.zonesOf(LaunchkeyPart.FADERS).map((z) => z.note);
    const specFaderCcs = spec.controls
      .filter((c) => c.role === ButtonRole.FADER)
      .map((c) => c.index);
    expect(faderCcs).toEqual(specFaderCcs);
  });
});

describe('the geometry', () => {
  it('locates every zone from its own centre', () => {
    /*
     * The check that catches an offset applied to the drawing but not to the
     * lookup. In a headset that is a surface whose faders answer where the
     * knobs are, and it looks perfectly normal until somebody reaches.
     */
    for (const zone of layout.zones) {
      const hit = layout.locate(
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
      );
      expect(hit, `${zone.label} at ${zone.rect.x},${zone.rect.y}`).toBe(zone.index);
    }
  });

  it('puts the keys along the front edge', () => {
    // Nearest the player, as on the instrument. Anything else and the keys are
    // out of reach behind the controls.
    for (const zone of layout.zonesOf(LaunchkeyPart.KEYS)) {
      expect(zone.rect.y).toBeLessThan(0.2);
    }
  });

  it('puts the control rows above the keys, not on them', () => {
    const keyTop = Math.max(
      ...layout.zonesOf(LaunchkeyPart.KEYS).map((z) => z.rect.y + z.rect.height),
    );
    for (const part of [LaunchkeyPart.KNOBS, LaunchkeyPart.FADERS, LaunchkeyPart.PADS]) {
      for (const zone of layout.zonesOf(part)) {
        expect(zone.rect.y, `${part} overlaps the keys`).toBeGreaterThanOrEqual(keyTop);
      }
    }
  });

  it('puts the knobs above the faders, as on the hardware', () => {
    const knobY = Math.min(...layout.zonesOf(LaunchkeyPart.KNOBS).map((z) => z.rect.y));
    const faderTop = Math.max(
      ...layout.zonesOf(LaunchkeyPart.FADERS).map((z) => z.rect.y + z.rect.height),
    );
    expect(knobY).toBeGreaterThanOrEqual(faderTop);
  });

  it('keeps the pads clear of the knobs and faders', () => {
    // They share a row of the surface, so overlapping would mean one region
    // answering for the other — and `locate` resolves ties by part order, so
    // the failure would be consistent and completely wrong.
    const padLeft = Math.min(...layout.zonesOf(LaunchkeyPart.PADS).map((z) => z.rect.x));
    const controlsRight = Math.max(
      ...[...layout.zonesOf(LaunchkeyPart.KNOBS), ...layout.zonesOf(LaunchkeyPart.FADERS)].map(
        (z) => z.rect.x + z.rect.width,
      ),
    );
    expect(padLeft).toBeGreaterThanOrEqual(controlsRight);
  });

  it('is about the size of the instrument it copies', () => {
    // A Launchkey 49 is roughly 700 mm across. A surface an order out would be
    // unreachable or a toy, and neither shows up in any other assertion.
    expect(layout.width).toBeGreaterThan(0.5);
    expect(layout.width).toBeLessThan(0.9);
    expect(layout.height).toBeGreaterThan(0.15);
    expect(layout.height).toBeLessThan(0.45);
  });
});

describe('which regions are pinched rather than poked', () => {
  it('names the knobs and faders, and nothing else', () => {
    // The keys and pads go through the poke detector; these go through
    // KnobControl. Getting it wrong means a fader you can only tap.
    expect(isContinuousPart(LaunchkeyPart.KNOBS)).toBe(true);
    expect(isContinuousPart(LaunchkeyPart.FADERS)).toBe(true);
    expect(isContinuousPart(LaunchkeyPart.KEYS)).toBe(false);
    expect(isContinuousPart(LaunchkeyPart.PADS)).toBe(false);
  });
});
