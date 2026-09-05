// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  buildLaunchkeyLayout,
  isContinuousPart,
  LaunchkeyPart,
  LaunchkeySurface,
} from '../src/LaunchkeyLayout.js';
import { LAUNCHKEY_MK3_49 } from '../src/launchkeyMk3.js';
import { ButtonRole } from '../src/types.js';
import { LaunchpadEmulator } from '../src/LaunchpadEmulator.js';

/**
 * The Launchkey's surface.
 *
 * Four regions on one plane. What is worth testing here is not that the numbers
 * are pretty but that the surface agrees with the *spec* — the two are written
 * separately, and a layout with eight faders under a spec with nine is a
 * control Live writes to that nobody can reach.
 */
const layout = buildLaunchkeyLayout(LAUNCHKEY_MK3_49);

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

  it('carries the control ids the spec declares, for the knobs and faders', () => {
    /*
     * Ids, not CCs. The zone's `note` is what the headset sends back as a
     * control index; the MIDI byte lives in the spec as `data1`. Conflating
     * them is what let key 41 and fader 6 be the same control.
     */
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

/**
 * The surface, wearing the interface the renderer speaks.
 *
 * One renderer for both devices rather than two that drift, which means the
 * composite has to answer the three questions a `LaunchpadLayout` answers.
 */
describe('the renderer-facing surface', () => {
  const surface = new LaunchkeySurface(LAUNCHKEY_MK3_49);

  it('exposes the same zones as the layout it wraps', () => {
    expect(surface.zones).toHaveLength(layout.zones.length);
    expect(surface.width).toBeCloseTo(layout.width, 6);
  });

  it('addresses an LED to the right pad', () => {
    const pad = surface.zones.find(
      (z) => surface.partOf(z.index) === LaunchkeyPart.PADS,
    )!;
    expect(surface.zoneForIndex(pad.note)).toBe(pad.index);
  });

  it('addresses LEDs by control id, which cannot collide', () => {
    /*
     * The pads are the only lit controls here, and they are addressed by id.
     * Ids are disjoint by region, so unlike the MIDI bytes — where key 41 and
     * fader 6 are both 41 — there is no number that could mean two things.
     */
    const pads = layout.zonesOf(LaunchkeyPart.PADS);
    for (const pad of pads) expect(surface.zoneForIndex(pad.note)).toBe(pad.index);

    // Nothing else answers, because nothing else lights.
    for (const part of [LaunchkeyPart.KEYS, LaunchkeyPart.KNOBS, LaunchkeyPart.FADERS]) {
      for (const zone of layout.zonesOf(part)) {
        expect(surface.zoneForIndex(zone.note), `${part} should not be addressable`).toBe(-1);
      }
    }
  });

  it('answers -1 for a number no control uses', () => {
    expect(surface.zoneForIndex(9999)).toBe(-1);
    expect(surface.zoneForIndex(-1)).toBe(-1);
  });

  it('has no logo to light', () => {
    expect(surface.logoPosition()).toBeNull();
  });

  it('says which region a zone belongs to', () => {
    for (const zone of surface.zones) {
      expect(surface.partOf(zone.index)).not.toBe('');
    }
  });
});

/**
 * What actually goes on the wire when a Launchkey control is touched.
 *
 * The tests above check that the ids are disjoint and that the spec and the
 * layout agree. None of them checks the bytes — and the bytes are the point,
 * because the id is an internal handle and the MIDI number is what a DAW acts
 * on. An emulator that sent the id would put control 300 on a wire whose data
 * bytes only go to 127.
 */
describe('the MIDI a Launchkey emits', () => {
  const emitted: number[][] = [];
  const emulator = new LaunchpadEmulator(LAUNCHKEY_MK3_49, {
    onMidiOut: (bytes) => emitted.push([...bytes]),
    onLedChange: () => {},
    onText: () => {},
    onModeChange: () => {},
  });

  const controlsOf = (role: string) =>
    LAUNCHKEY_MK3_49.controls.filter((c) => c.role === role);

  const press = (index: number): number[] => {
    emitted.length = 0;
    emulator.press(index, 100);
    return emitted[0] ?? [];
  };

  it('sends a key as a Note On at its own pitch', () => {
    const middle = controlsOf(ButtonRole.KEY)[24]!;
    const [status, data1, data2] = press(middle.index);
    expect(status).toBe(0x90);
    expect(data1).toBe(middle.data1);
    expect(data2).toBe(100);
  });

  it('sends a knob as a Control Change on its own CC', () => {
    const knob = controlsOf(ButtonRole.KNOB)[0]!;
    const [status, data1] = press(knob.index);
    expect(status).toBe(0xb0);
    expect(data1).toBe(21);
  });

  it('sends CC 41 and note 41 from the two different controls that share 41', () => {
    /*
     * The collision, end to end: the *first* fader sends CC 41 and the sixth
     * key sends note 41. They shared a control index until the id and the wire
     * byte were separated, so the emulator's lookup returned whichever was
     * built first and one of them emitted the other's message.
     *
     * Both are found by the number they send rather than by position — an
     * earlier version of this reached for fader [5] on the assumption that
     * "fader 41" meant the sixth, and it sends 46.
     */
    const fader = controlsOf(ButtonRole.FADER).find((c) => c.data1 === 41)!;
    const [faderStatus, faderData] = press(fader.index);
    expect(faderStatus).toBe(0xb0);
    expect(faderData).toBe(41);

    const key = controlsOf(ButtonRole.KEY).find((c) => c.data1 === 41)!;
    const [keyStatus, keyData] = press(key.index);
    expect(keyStatus).toBe(0x90);
    expect(keyData).toBe(41);
  });

  it('never puts a control id on the wire', () => {
    /*
     * The ids run past 127 by design, and a MIDI data byte is seven bits. An
     * emulator sending the id would have every knob and fader arrive as some
     * other number entirely — 300 masked to 44 — which is a plausible-looking
     * CC and therefore the worst kind of wrong.
     */
    for (const control of LAUNCHKEY_MK3_49.controls) {
      const [, data1] = press(control.index);
      expect(data1, `control ${control.index} (${control.role})`).toBe(control.data1);
      expect(data1).toBeLessThanOrEqual(127);
    }
  });

  it('releases with the same number it pressed with', () => {
    // A release that named a different control leaves a note sounding forever.
    const key = controlsOf(ButtonRole.KEY)[10]!;
    emulator.press(key.index, 100);
    emitted.length = 0;
    emulator.release(key.index);
    expect(emitted[0]).toEqual([0x90, key.data1, 0]);
  });
});
