// SPDX-License-Identifier: GPL-3.0-only

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
export function buildLaunchkeyLayout(): CompositeLayout {
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
  return new CompositeLayout(parts);
}

/** True for the regions that are pinched and dragged rather than poked. */
export function isContinuousPart(part: string): boolean {
  return part === LaunchkeyPart.KNOBS || part === LaunchkeyPart.FADERS;
}
