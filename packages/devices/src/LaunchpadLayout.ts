// SPDX-License-Identifier: GPL-3.0-only

import type { Rect, TriggerZone, ZoneLocator } from '@vrmc/layout';
import { ButtonRole, ControlKind, type DeviceSpec } from './types.js';

/**
 * A Launchpad as a pokeable surface.
 *
 * Implements the same `ZoneLocator` contract as the pad grid and the keyboard,
 * so the existing poke detector drives it unchanged — velocity from approach
 * speed, hysteresis, glissando and release-on-tracking-loss all come for free
 * rather than being reimplemented per device.
 *
 * A zone's `note` carries the device's own XY index rather than a MIDI note.
 * The bridge feeds that straight to the emulator, which decides whether it
 * becomes a Note On or a Control Change — so the headset never has to know
 * which of the surrounding buttons are CCs.
 */
export class LaunchpadLayout implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;
  readonly spec: DeviceSpec;

  /** Centre-to-centre spacing of adjacent controls. */
  readonly pitch: number;

  private readonly minCol: number;
  private readonly minRow: number;
  private readonly cols: number;
  private readonly rows: number;

  /** Device XY index -> position in `zones`, or -1. */
  private readonly byIndex: Int16Array;
  /** Grid cell (row * cols + col) -> position in `zones`, or -1. */
  private readonly byCell: Int16Array;

  constructor(spec: DeviceSpec) {
    this.spec = spec;
    this.pitch = spec.padSize + spec.padGap;

    // Bounds come from the controls that actually exist: the Launchpad X has
    // no left column or bottom row, so hard-coding a 10x10 extent would leave
    // it floating inside a surface with two empty edges.
    let minCol = Number.POSITIVE_INFINITY;
    let maxCol = Number.NEGATIVE_INFINITY;
    let minRow = Number.POSITIVE_INFINITY;
    let maxRow = Number.NEGATIVE_INFINITY;
    for (const c of spec.controls) {
      if (c.col < minCol) minCol = c.col;
      if (c.col > maxCol) maxCol = c.col;
      if (c.row < minRow) minRow = c.row;
      if (c.row > maxRow) maxRow = c.row;
    }
    this.minCol = minCol;
    this.minRow = minRow;
    this.cols = maxCol - minCol + 1;
    this.rows = maxRow - minRow + 1;

    this.width = this.cols * spec.padSize + (this.cols - 1) * spec.padGap;
    this.height = this.rows * spec.padSize + (this.rows - 1) * spec.padGap;

    this.byIndex = new Int16Array(110).fill(-1);
    this.byCell = new Int16Array(this.cols * this.rows).fill(-1);

    const zones: TriggerZone[] = [];
    for (const control of spec.controls) {
      // The logo is lit but has no switch under it, so it is drawn and never
      // hit-tested.
      if (control.kind === ControlKind.OUTPUT_ONLY) continue;

      const col = control.col - minCol;
      const row = control.row - minRow;
      const rect: Rect = {
        x: col * this.pitch,
        y: row * this.pitch,
        width: spec.padSize,
        height: spec.padSize,
      };
      const zoneIndex = zones.length;
      zones.push({
        index: zoneIndex,
        rect,
        // The device's own control number, not a MIDI note.
        note: control.index,
        raise: control.role === ButtonRole.GRID ? 0.004 : 0.003,
        label: control.label,
        accidental: control.role !== ButtonRole.GRID,
        row,
        col,
      });
      this.byIndex[control.index] = zoneIndex;
      this.byCell[row * this.cols + col] = zoneIndex;
    }
    this.zones = zones;
  }

  /**
   * O(1) lookup, the same arithmetic the pad grid uses.
   *
   * A point in the gutter between controls is a miss rather than snapping to
   * the nearest one: the gaps on a Launchpad are wide enough to aim between,
   * and inventing a hit there would make the grid feel imprecise.
   */
  locate(x: number, y: number): number {
    if (x < 0 || y < 0 || x > this.width || y > this.height) return -1;
    const col = Math.floor(x / this.pitch);
    const row = Math.floor(y / this.pitch);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    if (x - col * this.pitch > this.spec.padSize) return -1;
    if (y - row * this.pitch > this.spec.padSize) return -1;
    return this.byCell[row * this.cols + col]!;
  }

  /** Zone position for a device XY index, or -1. */
  zoneForIndex(deviceIndex: number): number {
    return deviceIndex >= 0 && deviceIndex < this.byIndex.length
      ? this.byIndex[deviceIndex]!
      : -1;
  }

  /** Where the logo sits in local coordinates, or null if the model has none. */
  logoPosition(): { x: number; y: number } | null {
    const logo = this.spec.controls.find((c) => c.role === ButtonRole.LOGO);
    if (logo === undefined) return null;
    return {
      x: (logo.col - this.minCol) * this.pitch + this.spec.padSize / 2,
      y: (logo.row - this.minRow) * this.pitch + this.spec.padSize / 2,
    };
  }
}
