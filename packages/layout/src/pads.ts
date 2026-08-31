import { clampInt, type Rect, type TriggerZone, type ZoneLocator } from './surface.js';

export interface PadGridOptions {
  rows: number;
  cols: number;
  /** Edge length of one square pad, in metres. */
  padSize: number;
  /** Gap between adjacent pads, in metres. */
  gap: number;
  /**
   * MIDI note of the bottom-left pad. 36 (C1) is the MPC/Ableton drum-rack
   * convention and is what Ableton's Drum Rack maps to by default.
   */
  baseNote: number;
  /**
   * Note step between vertically adjacent rows. The MPC walks straight up in
   * chromatic order (step === cols). Ableton's Push and the Launchpad's
   * "session" mode use other strides; 4 or 5 gives an isomorphic layout where
   * the same chord shape works in every key.
   */
  rowStride: number;
  /** How far a pad stands proud of the surface, in metres. */
  raise: number;
}

/** Akai MPC style: 4x4, chromatic from C1, 50 mm pads. */
export const MPC_4X4: PadGridOptions = {
  rows: 4,
  cols: 4,
  padSize: 0.05,
  gap: 0.008,
  baseNote: 36,
  rowStride: 4,
  raise: 0.006,
};

/** Novation Launchpad style: 8x8, 40 mm pads. */
export const LAUNCHPAD_8X8: PadGridOptions = {
  rows: 8,
  cols: 8,
  padSize: 0.04,
  gap: 0.006,
  baseNote: 36,
  rowStride: 8,
  raise: 0.005,
};

/**
 * A uniform grid of square pads.
 *
 * Because the grid is regular, `locate` is pure arithmetic — divide by the
 * pitch, floor, bounds-check — with no table and no branchy search.
 */
export class PadGridLayout implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;
  readonly options: PadGridOptions;

  /** Centre-to-centre spacing. */
  private readonly pitch: number;

  constructor(options: PadGridOptions = MPC_4X4) {
    this.options = options;
    const { rows, cols, padSize, gap } = options;
    this.pitch = padSize + gap;
    // n pads and n-1 gaps: the outer edges are flush with the surface bounds.
    this.width = cols * padSize + (cols - 1) * gap;
    this.height = rows * padSize + (rows - 1) * gap;

    const zones: TriggerZone[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        const note = options.baseNote + row * options.rowStride + col;
        const rect: Rect = {
          x: col * this.pitch,
          y: row * this.pitch,
          width: padSize,
          height: padSize,
        };
        zones.push({
          index,
          rect,
          note,
          raise: options.raise,
          label: `PAD ${index + 1}`,
          accidental: false,
          row,
          col,
        });
      }
    }
    this.zones = zones;
  }

  /**
   * O(1) grid lookup. Points landing in the gap between pads return -1 rather
   * than snapping to the nearest pad: a finger in the gutter is a miss, and
   * inventing a hit there would make the grid feel mushy.
   */
  locate(x: number, y: number): number {
    if (x < 0 || y < 0 || x > this.width || y > this.height) return -1;
    const { rows, cols, padSize } = this.options;
    const col = clampInt(Math.floor(x / this.pitch), 0, cols - 1);
    const row = clampInt(Math.floor(y / this.pitch), 0, rows - 1);
    // Reject the gap: distance from the cell origin must be within the pad.
    if (x - col * this.pitch > padSize) return -1;
    if (y - row * this.pitch > padSize) return -1;
    if (row >= rows || col >= cols) return -1;
    return row * cols + col;
  }

  /** Zone index for a grid position, or -1 when out of range. */
  atRowCol(row: number, col: number): number {
    const { rows, cols } = this.options;
    if (row < 0 || col < 0 || row >= rows || col >= cols) return -1;
    return row * cols + col;
  }
}
