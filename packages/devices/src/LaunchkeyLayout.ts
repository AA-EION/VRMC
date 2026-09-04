// SPDX-License-Identifier: GPL-3.0-only

import type { TriggerZone, ZoneLocator } from '@vrmc/layout';
import { ButtonRole, type DeviceSpec } from './types.js';
import {
  ControlStripLayout,
  CompositeLayout,
  FADER_ROW_9,
  KeyboardLayout,
  KNOB_ROW_8,
  LAUNCHKEY_49,
  PadGridLayout,
  type SurfacePart,
} from '@vrmc/layout';

/**
 * A Launchkey MK3 49 as a pokeable, grabbable surface.
 *
 * Four regions on one plane, laid out as the hardware is: keys along the front
 * edge nearest the player, the pads above them on the right, and the knobs and
 * faders above those on the left. Composing them rather than treating them as
 * four devices is what makes a hand crossing from the keys to the pads a
 * continuous gesture instead of leaving one instrument and arriving at another.
 *
 * The part ids are how everything downstream tells them apart, and they have to
 * be: a pad sends a note through the emulator, a knob sends a 14-bit CC through
 * `KnobControl`, and a key sends a plain note. Same surface, three different
 * destinations.
 */

/** The names each region is known by. */
export const LaunchkeyPart = {
  KEYS: 'keys',
  PADS: 'pads',
  KNOBS: 'knobs',
  FADERS: 'faders',
} as const;

/**
 * The pads: two rows of eight, on notes 96..111.
 *
 * `rowStride` is 8 so the two rows run consecutively — which is what the
 * hardware sends and what Live's script expects to receive. A stride matching
 * the drum-rack convention would be wrong here: these are session pads, not a
 * drum grid, and the script reads them positionally.
 */
const LAUNCHKEY_PADS = {
  rows: 2,
  cols: 8,
  padSize: 0.022,
  gap: 0.005,
  baseNote: 96,
  rowStride: 8,
  raise: 0.005,
};

/**
 * Build the surface.
 *
 * The offsets are the hardware's proportions rather than invented ones: the
 * control rows sit above the keys, and the pads sit to the right of the knobs
 * and faders, which is where they are on the instrument. Getting this wrong is
 * not a cosmetic matter in XR — somebody reaching for a fader by memory finds
 * whatever is actually there.
 */
export function buildLaunchkeyLayout(spec: DeviceSpec): CompositeLayout {
  const keys = new KeyboardLayout(LAUNCHKEY_49);
  const pads = new PadGridLayout(LAUNCHKEY_PADS);
  const knobs = new ControlStripLayout(KNOB_ROW_8);
  const faders = new ControlStripLayout(FADER_ROW_9);

  /** Between the keys and the control rows above them. */
  const gutter = 0.018;
  const controlsY = keys.height + gutter;

  /*
   * The pads sit at the right-hand end, above the top octave, with the knobs
   * and faders to their left. Placing the pads first means their column is
   * fixed and the control rows fill the space to their left rather than the
   * pads floating wherever the controls happen to end.
   */
  const padsX = Math.max(0, keys.width - pads.width);
  const parts: SurfacePart[] = [
    { id: LaunchkeyPart.KEYS, locator: keys, x: 0, y: 0 },
    { id: LaunchkeyPart.PADS, locator: pads, x: padsX, y: controlsY },
    { id: LaunchkeyPart.KNOBS, locator: knobs, x: 0, y: controlsY + faders.height + 0.012 },
    { id: LaunchkeyPart.FADERS, locator: faders, x: 0, y: controlsY },
  ];
  /*
   * The zones carry control *ids*, not MIDI numbers.
   *
   * The sub-layouts number theirs with MIDI values — a keyboard's notes, a
   * strip's CCs — because that is what they are for elsewhere. Here those are
   * the wrong numbers: a zone's `note` is what the headset sends back as a
   * control index, and the bridge looks it up in the spec. With MIDI values it
   * would look up key 41 and find fader 6, or the reverse, depending on which
   * the lookup table happened to hold. Seventeen controls on this device
   * collide that way.
   *
   * Matched by position within a region, because both lists are built in the
   * same ascending order. A length mismatch throws rather than truncating: a
   * keyboard whose top octave silently sent nothing would be very hard to spot.
   */
  const idsByRole = new Map<string, number[]>();
  for (const control of spec.controls) {
    const list = idsByRole.get(control.role) ?? [];
    list.push(control.index);
    idsByRole.set(control.role, list);
  }
  const roleOfPart: Readonly<Record<string, string>> = {
    [LaunchkeyPart.KEYS]: ButtonRole.KEY,
    [LaunchkeyPart.PADS]: ButtonRole.GRID,
    [LaunchkeyPart.KNOBS]: ButtonRole.KNOB,
    [LaunchkeyPart.FADERS]: ButtonRole.FADER,
  };

  return new CompositeLayout(parts, (_zone, origin) => {
    const ids = idsByRole.get(roleOfPart[origin.part] ?? '') ?? [];
    const id = ids[origin.localIndex];
    if (id === undefined) {
      throw new Error(
        `the ${origin.part} layout has ${origin.localIndex + 1} zones but the ` +
          `spec declares ${ids.length} controls for it`,
      );
    }
    return id;
  });
}

/** True for the regions that are pinched and dragged rather than poked. */
export function isContinuousPart(part: string): boolean {
  return part === LaunchkeyPart.KNOBS || part === LaunchkeyPart.FADERS;
}

/**
 * The Launchkey's surface, wearing the interface the renderer already speaks.
 *
 * `LaunchpadLayout` offers three things beyond a bare `ZoneLocator` — the spec
 * it was built from, a device-index-to-zone lookup for LED addressing, and the
 * logo's position — and the renderer uses all three. Providing them here means
 * one renderer draws both devices rather than two that drift apart.
 */
export class LaunchkeySurface implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;
  readonly spec: DeviceSpec;
  readonly composite: CompositeLayout;

  /**
   * Device index -> zone, for the pads only.
   *
   * WHY ONLY THE PADS
   * Because the numbers collide otherwise, and silently. A zone carries the
   * number it sends in `note`: a key sends note 41, and fader 6 sends CC 41.
   * One map over every part would have the second overwrite the first, and an
   * LED meant for a pad could light a key.
   *
   * Only the pads are addressable — they are the only lit controls on this
   * device — so the map covers them and everything else answers -1. That is
   * the honest answer rather than a lucky one: there is no zone for "CC 41 as
   * opposed to note 41" to return.
   */
  private readonly padZoneByNote: ReadonlyMap<number, number>;

  constructor(spec: DeviceSpec) {
    this.spec = spec;
    this.composite = buildLaunchkeyLayout(spec);
    this.zones = this.composite.zones;
    this.width = this.composite.width;
    this.height = this.composite.height;

    const pads = new Map<number, number>();
    for (const zone of this.composite.zonesOf(LaunchkeyPart.PADS)) {
      pads.set(zone.note, zone.index);
    }
    this.padZoneByNote = pads;
  }

  locate(x: number, y: number): number {
    return this.composite.locate(x, y);
  }

  /** The zone an LED message addresses, or -1. See `padZoneByNote`. */
  zoneForIndex(deviceIndex: number): number {
    return this.padZoneByNote.get(deviceIndex) ?? -1;
  }

  /** Which region a zone belongs to, so callers can route it. */
  partOf(zoneIndex: number): string {
    return this.composite.originOf(zoneIndex)?.part ?? '';
  }

  /** No illuminated logo on this one. */
  logoPosition(): { x: number; y: number } | null {
    return null;
  }
}
