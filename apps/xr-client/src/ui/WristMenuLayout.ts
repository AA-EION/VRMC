// SPDX-License-Identifier: GPL-3.0-only

import { clampInt, type Rect, type TriggerZone, type ZoneLocator } from '@vrmc/layout';

/**
 * The wrist console's rows, as a `ZoneLocator`.
 *
 * The same shape as every other surface here, which is the point: the poke
 * detector, the renderer and the highlighter all work on it unchanged, so the
 * menu gets the same hysteresis and the same feedback as a pad grid without any
 * of it being written a second time.
 *
 * One column. A grid on a wrist means aiming in two axes at a target that is
 * moving with your own arm, and the whole reason the console is worn rather
 * than floating is that you do not have to go anywhere to reach it — a layout
 * that needs precision gives that back.
 */

/**
 * Row height and width, in metres.
 *
 * A row is a poke target, not a ray target, so the floor is what a fingertip
 * can actually land on rather than what an eye can resolve: about two
 * centimetres. Six of them plus the readout come to roughly twenty
 * centimetres, which is a forearm — any taller and the console runs off the
 * end of the arm it is worn on.
 */
const ROW_HEIGHT = 0.022;
const ROW_WIDTH = 0.1;
const GAP = 0.004;

/**
 * How far the readout above the rows stands.
 *
 * It is not a row: nothing is pressed there. It is where the link's own numbers
 * go, and giving it the height of two rows is what keeps it legible at the
 * distance a wrist actually is.
 */
export const READOUT_HEIGHT = ROW_HEIGHT * 2;

export class WristMenuLayout implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width = ROW_WIDTH;
  readonly height: number;
  readonly rowCount: number;

  private readonly pitch = ROW_HEIGHT + GAP;

  constructor(labels: readonly string[]) {
    this.rowCount = labels.length;
    this.height = this.rowCount * ROW_HEIGHT + (this.rowCount - 1) * GAP + READOUT_HEIGHT + GAP;

    const zones: TriggerZone[] = [];
    for (const [index, label] of labels.entries()) {
      // Read top to bottom, and surface Y grows upward — so the first item is
      // the highest row. The readout sits above all of them.
      const rect: Rect = {
        x: 0,
        y: (this.rowCount - 1 - index) * this.pitch,
        width: ROW_WIDTH,
        height: ROW_HEIGHT,
      };
      zones.push({
        index,
        rect,
        // Nothing here sends MIDI. Zero rather than undefined, so a stray note
        // event would be silent rather than a plausible-looking pitch.
        note: 0,
        raise: 0.005,
        label,
        accidental: false,
        row: index,
        col: 0,
      });
    }
    this.zones = zones;
  }

  locate(x: number, y: number): number {
    if (x < 0 || x > this.width || y < 0) return -1;
    const row = Math.floor(y / this.pitch);
    if (row >= this.rowCount) return -1; // in the readout, which is not a control
    // Inside the gap between two rows rather than on either.
    if (y - row * this.pitch > ROW_HEIGHT) return -1;
    return clampInt(this.rowCount - 1 - row, 0, this.rowCount - 1);
  }
}
