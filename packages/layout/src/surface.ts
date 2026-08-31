/**
 * Every playable device is a flat surface with trigger zones laid out on it.
 *
 * Each surface has a local frame:
 *   +X  across the surface (right, from the player's view)
 *   +Y  up the surface (away from the player, along a key's length)
 *   +Z  out of the surface, toward the player's fingertip
 *
 * A poke is a fingertip crossing z = 0 from positive to negative inside a
 * zone's XY rectangle. Putting every device in this same frame means the
 * detector never needs to know whether it is looking at a pad wall, a tilted
 * keyboard, or a table-top grid — the surface's world transform handles that.
 */

/** An axis-aligned rectangle in surface-local metres. */
export interface Rect {
  /** Left edge (min X). */
  x: number;
  /** Bottom edge (min Y). */
  y: number;
  width: number;
  height: number;
}

/** One playable region: the geometry plus what it sends. */
export interface TriggerZone {
  /** Index into the surface's zone array. Stable for the surface's lifetime. */
  index: number;
  rect: Rect;
  /** MIDI note this zone fires. */
  note: number;
  /** How far the zone stands proud of the surface plane, in metres. */
  raise: number;
  /** Display label, e.g. "C#3" or "PAD 5". */
  label: string;
  /** True for piano accidentals; the renderer colours these differently. */
  accidental: boolean;
  /** Grid position, for lighting effects. -1 when not on a grid. */
  row: number;
  col: number;
}

/**
 * Maps a surface-local point to a zone in O(1).
 *
 * A linear scan over 88 keys per fingertip per frame — 10 fingertips at 90 Hz —
 * is 79k rect tests a second for a job that a lookup table does in one index.
 * The cost matters less than the consistency: a scan's cost varies with layout,
 * and variable per-frame cost is jitter.
 */
export interface ZoneLocator {
  /** All zones, indexed by `TriggerZone.index`. */
  readonly zones: readonly TriggerZone[];
  /** Total surface extent in metres. */
  readonly width: number;
  readonly height: number;
  /** Returns the zone index at (x, y), or -1 if the point misses every zone. */
  locate(x: number, y: number): number;
}

/** Clamp helper used by the locators' bucket arithmetic. */
export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
