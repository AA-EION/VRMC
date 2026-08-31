import { isAccidental, noteName } from '@vrmc/protocol';
import type { Rect, TriggerZone, ZoneLocator } from './surface.js';

export interface KeyboardOptions {
  /** Lowest MIDI note. Should be a natural, or the leftmost black key overhangs. */
  lowNote: number;
  /** Number of keys, counting accidentals. 25 / 37 / 49 / 61 are the usual sizes. */
  keyCount: number;
  /** Width of one white key, in metres. A real piano key is 23.5 mm. */
  whiteWidth: number;
  /** Front-to-back length of a white key, in metres. */
  whiteLength: number;
  /** Width of a black key. Traditionally a little over half a white key. */
  blackWidth: number;
  /** Front-to-back length of a black key. */
  blackLength: number;
  /** How far a white key stands proud of the surface plane. */
  whiteRaise: number;
  /** How far a black key stands proud. Must exceed whiteRaise to be reachable. */
  blackRaise: number;
}

/** Novation Launchkey 25: two octaves from C2, full-size keys. */
export const LAUNCHKEY_25: KeyboardOptions = {
  lowNote: 48,
  keyCount: 25,
  whiteWidth: 0.0225,
  whiteLength: 0.125,
  blackWidth: 0.012,
  blackLength: 0.08,
  whiteRaise: 0.004,
  blackRaise: 0.014,
};

/** Launchkey 49: four octaves from C1. */
export const LAUNCHKEY_49: KeyboardOptions = {
  ...LAUNCHKEY_25,
  lowNote: 36,
  keyCount: 49,
};

/**
 * How far each accidental sits from the white-key boundary it straddles, as a
 * fraction of a white key's width.
 *
 * On a real keyboard black keys are not centred on the boundary: the three keys
 * of the F#-G#-A# group and the two of C#-D# are each spread so the remaining
 * white-key tails stay equal in width. Copying this matters more in XR than on
 * hardware — with no physical edge to feel, the eye is the only guide to where
 * a key ends, so the spacing has to match what a player expects to see.
 */
const BLACK_KEY_OFFSET: Readonly<Record<number, number>> = {
  1: -1 / 18, // C#
  3: +1 / 18, // D#
  6: -1 / 12, // F#
  8: 0, //      G#
  10: +1 / 12, // A#
};

/**
 * A piano-style keyboard.
 *
 * Zones are built in ascending MIDI order, so `zones[i].note === lowNote + i`
 * and a note maps back to its zone by subtraction — no search either way.
 */
export class KeyboardLayout implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;
  readonly options: KeyboardOptions;

  /** Y at which the black-key band starts; below this only whites are hittable. */
  readonly blackBandStartY: number;

  /** Number of white keys in the range. */
  readonly whiteCount: number;

  /** boundary index -> zone index of the black key there, or -1. */
  private readonly blackAtBoundary: Int16Array;
  /** white ordinal -> zone index. */
  private readonly whiteZone: Int16Array;

  constructor(options: KeyboardOptions = LAUNCHKEY_25) {
    this.options = options;
    const { lowNote, keyCount, whiteWidth, whiteLength, blackWidth, blackLength } = options;

    const zones: TriggerZone[] = [];
    let white = 0;
    for (let i = 0; i < keyCount; i++) {
      if (!isAccidental(lowNote + i)) white++;
    }
    this.whiteCount = white;
    this.width = white * whiteWidth;
    this.height = whiteLength;
    this.blackBandStartY = whiteLength - blackLength;

    this.blackAtBoundary = new Int16Array(white + 2).fill(-1);
    this.whiteZone = new Int16Array(white).fill(-1);

    let w = 0;
    for (let i = 0; i < keyCount; i++) {
      const note = lowNote + i;
      const accidental = isAccidental(note);
      let rect: Rect;
      if (accidental) {
        // Sits at the boundary to the right of the `w` whites placed so far.
        const offset = BLACK_KEY_OFFSET[((note % 12) + 12) % 12] ?? 0;
        const centre = w * whiteWidth + offset * whiteWidth;
        rect = {
          x: centre - blackWidth / 2,
          y: this.blackBandStartY,
          width: blackWidth,
          height: blackLength,
        };
        if (w < this.blackAtBoundary.length) this.blackAtBoundary[w] = i;
      } else {
        rect = { x: w * whiteWidth, y: 0, width: whiteWidth, height: whiteLength };
        this.whiteZone[w] = i;
        w++;
      }
      zones.push({
        index: i,
        rect,
        note,
        raise: accidental ? options.blackRaise : options.whiteRaise,
        label: noteName(note),
        accidental,
        row: accidental ? 1 : 0,
        col: accidental ? -1 : w - 1,
      });
    }
    this.zones = zones;
  }

  /**
   * Exact O(1) hit test — arithmetic only, no lookup grid, no scan.
   *
   * Black keys overlay the back of the white keys and stand higher, so they win
   * wherever both could match. Below the black band the test is a single
   * division.
   */
  locate(x: number, y: number): number {
    if (x < 0 || y < 0 || x > this.width || y > this.height) return -1;
    const { whiteWidth, blackWidth } = this.options;

    if (y >= this.blackBandStartY) {
      // A point can only be inside the black key at the nearest white boundary,
      // because black keys are narrower than the spacing between boundaries.
      const boundary = Math.round(x / whiteWidth);
      if (boundary >= 0 && boundary < this.blackAtBoundary.length) {
        const zoneIndex = this.blackAtBoundary[boundary]!;
        if (zoneIndex >= 0) {
          const r = this.zones[zoneIndex]!.rect;
          if (x >= r.x && x <= r.x + blackWidth) return zoneIndex;
        }
      }
    }

    const wi = Math.floor(x / whiteWidth);
    if (wi < 0 || wi >= this.whiteCount) return -1;
    return this.whiteZone[wi]!;
  }

  /** Zone index for a MIDI note, or -1 when the note is outside the range. */
  zoneForNote(note: number): number {
    const i = note - this.options.lowNote;
    return i >= 0 && i < this.zones.length ? i : -1;
  }
}
