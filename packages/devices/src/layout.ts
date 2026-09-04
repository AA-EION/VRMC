// SPDX-License-Identifier: GPL-3.0-only

import { ButtonRole, ControlKind, type Control } from './types.js';

/**
 * Builders for the Launchpad control surface.
 *
 * Both modern Launchpads share the same addressing scheme, inherited from the
 * Launchpad Pro: the surface is a 10x10 grid of possible positions numbered
 * `row * 10 + column`, with row 0 at the bottom and column 0 at the left. The
 * 8x8 of pads occupies 11..88; the surrounding rows and columns take the
 * leftover edges. The four corners are unused.
 *
 * Keeping the hardware's own numbering rather than reindexing to a dense array
 * means every LED SysEx byte and every note number the DAW sends can be used
 * as-is, with no translation layer to get wrong in one direction only.
 */

/** XY index for a position. Row 0 is the bottom, column 0 the left edge. */
export function xy(row: number, col: number): number {
  return row * 10 + col;
}

/** Decode an XY index back to row and column. */
export function rowOf(index: number): number {
  return Math.floor(index / 10);
}

export function colOf(index: number): number {
  return index % 10;
}

/** True for the 64 positions that are actual RGB pads. */
export function isGridIndex(index: number): boolean {
  const r = rowOf(index);
  const c = colOf(index);
  return r >= 1 && r <= 8 && c >= 1 && c <= 8;
}

/** The 8x8 pads, bottom-left first. Notes 11..88. */
export function gridControls(): Control[] {
  const out: Control[] = [];
  for (let row = 1; row <= 8; row++) {
    for (let col = 1; col <= 8; col++) {
      out.push({
        index: xy(row, col),
        kind: ControlKind.NOTE,
        role: ButtonRole.GRID,
        col,
        row,
        label: '',
      });
    }
  }
  return out;
}

/**
 * Top row, CC 91..98.
 *
 * On the Launchpad X these are the arrows plus the layout buttons; the Pro MK3
 * uses the same numbers for its own set. Labels differ, the addressing does not.
 */
export function topRowControls(labels: readonly string[]): Control[] {
  return labels.map((label, i) => ({
    index: xy(9, i + 1),
    kind: ControlKind.CC,
    role: ButtonRole.FUNCTION,
    col: i + 1,
    row: 9,
    label,
  }));
}

/** Right column, CC 19, 29, ... 89. Scene launch, top to bottom. */
export function sceneColumnControls(labels: readonly string[]): Control[] {
  // labels[0] is the topmost button, which is the highest row.
  return labels.map((label, i) => ({
    index: xy(8 - i, 9),
    kind: ControlKind.CC,
    role: ButtonRole.SCENE,
    col: 9,
    row: 8 - i,
    label,
  }));
}

/** Left column, CC 10, 20, ... 80. Pro MK3 mode buttons, top to bottom. */
export function leftColumnControls(labels: readonly string[]): Control[] {
  return labels.map((label, i) => ({
    index: xy(8 - i, 0),
    kind: ControlKind.CC,
    role: ButtonRole.MODE,
    col: 0,
    row: 8 - i,
    label,
  }));
}

/** Bottom row, CC 1..8. Pro MK3 track select. */
export function bottomRowControls(labels: readonly string[]): Control[] {
  return labels.map((label, i) => ({
    index: xy(0, i + 1),
    kind: ControlKind.CC,
    role: ButtonRole.TRACK,
    col: i + 1,
    row: 0,
    label,
  }));
}

/**
 * The logo LED, index 99.
 *
 * Output only — there is no switch under it. Ableton lights it, so an emulator
 * that silently dropped writes to 99 would look subtly wrong.
 */
export function logoControl(): Control {
  return {
    index: 99,
    kind: ControlKind.OUTPUT_ONLY,
    role: ButtonRole.LOGO,
    col: 9,
    row: 9,
    label: '',
  };
}

/**
 * Map from XY index to position in the spec's `controls` array.
 *
 * A 100-entry Int16Array rather than a Map: lookups happen once per incoming
 * MIDI byte and once per LED write, and the index is already a small dense
 * integer.
 */
export function controlLookup(controls: readonly Control[]): Int16Array {
  /*
   * Sized to the ids actually present, not to a fixed 110.
   *
   * 110 was one past a Launchpad's highest XY index — 99 for the logo, with
   * room — and it silently discarded anything above. That was invisible while
   * every device numbered its controls in one XY namespace, and became a
   * Launchkey whose knobs, faders and half its pads did nothing at all: their
   * ids start at 100, the table stopped at 109, and `controlAt` returned null
   * for a control that was right there in the spec.
   *
   * A device is free to number its controls however it likes, so the table
   * follows the spec rather than the spec being expected to fit the table.
   */
  let highest = -1;
  for (const control of controls) {
    if (control.index > highest) highest = control.index;
  }
  const table = new Int16Array(highest + 1).fill(-1);
  for (let i = 0; i < controls.length; i++) {
    const index = controls[i]!.index;
    if (index >= 0) table[index] = i;
  }
  return table;
}
