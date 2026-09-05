/**
 * One surface built from several.
 *
 * WHY THIS EXISTS
 * The devices emulated so far are uniform: a Launchpad is one grid at one
 * pitch, a keyboard is one run of keys. A Launchkey is not. It has 49 keys
 * along the bottom, sixteen square pads above them, a row of knobs and a row of
 * faders — four regions with different sizes, different spacings and different
 * shapes, sharing one plane.
 *
 * Rebuilding the poke detector, the highlighter and the router per region would
 * be four of everything. Composing the regions into a single `ZoneLocator`
 * means the surface reads as one device to everything above it, which is what
 * it is: you do not stop playing a Launchkey when your hand crosses from the
 * keys to the pads.
 *
 * ZONE INDICES ARE RENUMBERED, AND THAT IS THE WHOLE DIFFICULTY
 * Each part numbers its own zones from zero, and the composite has to give
 * every zone a unique index while remembering which part it came from — because
 * `note` and the LED state are the part's business, not the composite's. The
 * offsets are stored so a caller can map back.
 */

import type { Rect, TriggerZone, ZoneLocator } from './surface.js';

/** One region of a composite surface, and where it sits. */
export interface SurfacePart {
  /** Identifies the region to callers that care — "keys", "pads", "faders". */
  id: string;
  locator: ZoneLocator;
  /** Offset of this part's origin within the composite, in metres. */
  x: number;
  y: number;
}

/** Where a composite zone came from. */
export interface ZoneOrigin {
  /** The part's `id`. */
  part: string;
  /** Index of the part in the array this was built from. */
  partIndex: number;
  /** The zone's index *within that part*. */
  localIndex: number;
}

export class CompositeLayout implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;

  private readonly parts: readonly SurfacePart[];
  /** Composite zone index -> where it came from. */
  private readonly origins: readonly ZoneOrigin[];
  /** Part index -> the composite index its zone 0 became. */
  private readonly base: readonly number[];

  /**
   * @param renumber optional: given a zone and where it came from, the number
   *   it should carry in `note`.
   *
   *   The sub-layouts number their zones with MIDI values, because that is what
   *   they are for elsewhere. A composite device may need something else — a
   *   Launchkey's zones carry control *ids*, since its notes and CCs overlap
   *   and the id is what the headset sends back. Applying it here rather than
   *   afterwards means there is one array of zones and no second class that
   *   has to keep agreeing with this one.
   */
  constructor(
    parts: readonly SurfacePart[],
    renumber?: (zone: TriggerZone, origin: ZoneOrigin) => number,
  ) {
    this.parts = parts;

    const zones: TriggerZone[] = [];
    const origins: ZoneOrigin[] = [];
    const base: number[] = [];
    let width = 0;
    let height = 0;

    for (const [partIndex, part] of parts.entries()) {
      base.push(zones.length);
      for (const zone of part.locator.zones) {
        const origin: ZoneOrigin = {
          part: part.id,
          partIndex,
          localIndex: zone.index,
        };
        origins.push(origin);
        zones.push({
          ...zone,
          note: renumber === undefined ? zone.note : renumber(zone, origin),
          // Renumbered so `zones[i].index === i` holds for the composite, which
          // everything downstream relies on when it indexes the array directly.
          index: zones.length,
          rect: {
            x: zone.rect.x + part.x,
            y: zone.rect.y + part.y,
            width: zone.rect.width,
            height: zone.rect.height,
          },
        });
      }
      width = Math.max(width, part.x + part.locator.width);
      height = Math.max(height, part.y + part.locator.height);
    }

    this.zones = zones;
    this.origins = origins;
    this.base = base;
    this.width = width;
    this.height = height;
  }

  /**
   * The zone at a point, or -1.
   *
   * Delegates to each part rather than scanning every zone: a part knows how to
   * find its own zone in O(1) — a grid divides, a keyboard indexes a table —
   * and throwing that away for a linear walk over 49 keys plus 16 pads plus
   * seventeen strips, ten fingertips at 90 Hz, is 74k rect tests a second for
   * something four subtractions can do.
   *
   * Parts are tried in order and the first hit wins. They are not expected to
   * overlap; if two ever did, the earlier is the answer, which is at least
   * stable rather than dependent on iteration luck.
   */
  locate(x: number, y: number): number {
    for (const [partIndex, part] of this.parts.entries()) {
      const localX = x - part.x;
      const localY = y - part.y;
      if (
        localX < 0 ||
        localY < 0 ||
        localX > part.locator.width ||
        localY > part.locator.height
      ) {
        continue;
      }
      const local = part.locator.locate(localX, localY);
      if (local >= 0) return this.base[partIndex]! + local;
    }
    return -1;
  }

  /** Where a composite zone came from, or null if the index is out of range. */
  originOf(index: number): ZoneOrigin | null {
    return this.origins[index] ?? null;
  }

  /** Every zone belonging to one part, by its id. */
  zonesOf(partId: string): readonly TriggerZone[] {
    return this.zones.filter((z) => this.origins[z.index]?.part === partId);
  }
}

/** A part's bounding rectangle within the composite. */
export function partBounds(part: SurfacePart): Rect {
  return {
    x: part.x,
    y: part.y,
    width: part.locator.width,
    height: part.locator.height,
  };
}

/**
 * A surface with some of its zones unpokeable.
 *
 * WHY NOT JUST LEAVE THEM OUT
 * Because the zone index is the identity everything shares. The renderer draws
 * `zones[i]`, the LED state lights `zones[i]`, and the poke detector answers
 * with `i`. Removing the knobs from the array would renumber every zone after
 * them, so the surface would draw one control and light another.
 *
 * So the zones stay and the *locating* is masked: a fingertip over a fader
 * finds nothing, and the fader is still drawn, still lit, still there. What
 * grabs it is `KnobControl`, which works in world space and does not consult a
 * locator at all.
 *
 * A poke detector given the unmasked surface would fire a note every time a
 * hand passed through a fader on its way to a key — the faders sit between the
 * keys and the pads, so that is not an edge case but the ordinary path across
 * the instrument.
 */
export function maskPokeable(
  source: ZoneLocator,
  isPokeable: (zoneIndex: number) => boolean,
): ZoneLocator {
  return {
    zones: source.zones,
    width: source.width,
    height: source.height,
    locate(x: number, y: number): number {
      const hit = source.locate(x, y);
      return hit >= 0 && isPokeable(hit) ? hit : -1;
    },
  };
}
