// SPDX-License-Identifier: GPL-3.0-only

import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH } from '@vrmc/protocol';
import { clampInt, type Rect, type TriggerZone, type ZoneLocator } from '@vrmc/layout';

/**
 * The keypad for entering a pairing code with your hands.
 *
 * A `ZoneLocator` like any instrument, which is the point: the poke detector,
 * the surface renderer and the highlighter all work on it unchanged, so the
 * keypad gets the same hysteresis, the same sub-frame timing and the same
 * visual feedback as a pad grid without any of that being written twice.
 *
 * The alphabet is the pairing alphabet, so every key on it is a key that can
 * appear in a code — there is nothing to press that could not be part of an
 * answer. Backspace is the one extra.
 */

/** Zone index of the backspace key: the last one, after the alphabet. */
export const BACKSPACE_INDEX = PAIRING_ALPHABET.length;

/** Columns in the grid. 24 characters plus backspace divides evenly by 5. */
const COLS = 5;

/**
 * Key size and spacing, in metres.
 *
 * Larger than a pad. A pad is aimed at deliberately, one finger at a time,
 * with the hand already over the instrument; a keypad is aimed at while reading
 * six characters off a screen across the room, which is a much worse condition
 * for precision. 4 cm keys are about the size of a phone's, at a distance where
 * that is the right comparison.
 */
const KEY_SIZE = 0.04;
const GAP = 0.009;

export class KeypadLayout implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;
  readonly rows: number;

  private readonly pitch = KEY_SIZE + GAP;

  constructor() {
    const labels = [...PAIRING_ALPHABET, '⌫'];
    this.rows = Math.ceil(labels.length / COLS);
    this.width = COLS * KEY_SIZE + (COLS - 1) * GAP;
    this.height = this.rows * KEY_SIZE + (this.rows - 1) * GAP;

    const zones: TriggerZone[] = [];
    for (const [index, label] of labels.entries()) {
      const row = Math.floor(index / COLS);
      const col = index % COLS;
      // Surface Y grows upward, but a keypad is read top to bottom, so the
      // first character has to be the *highest* row rather than the lowest.
      const rect: Rect = {
        x: col * this.pitch,
        y: (this.rows - 1 - row) * this.pitch,
        width: KEY_SIZE,
        height: KEY_SIZE,
      };
      zones.push({
        index,
        rect,
        // Unused: nothing here sends MIDI. Kept at 0 rather than left
        // undefined so a stray note event would be silent rather than a
        // plausible-looking pitch.
        note: 0,
        raise: 0.006,
        label,
        // Backspace is drawn in the darker colour, which is what marks it out
        // as the one key that is not a character.
        accidental: index === BACKSPACE_INDEX,
        row,
        col,
      });
    }
    this.zones = zones;
  }

  /** O(1) grid lookup; a point in the gutter between keys is a miss. */
  locate(x: number, y: number): number {
    if (x < 0 || y < 0 || x > this.width || y > this.height) return -1;
    const col = clampInt(Math.floor(x / this.pitch), 0, COLS - 1);
    const rowFromBottom = clampInt(Math.floor(y / this.pitch), 0, this.rows - 1);

    // Reject the gap rather than snapping to the nearest key: a finger between
    // two characters is a miss, and guessing which one was meant is how a code
    // ends up with a character the user did not press.
    if (x - col * this.pitch > KEY_SIZE) return -1;
    if (y - rowFromBottom * this.pitch > KEY_SIZE) return -1;

    const row = this.rows - 1 - rowFromBottom;
    const index = row * COLS + col;
    return index < this.zones.length ? index : -1;
  }

  /** The character a zone types, or '' for backspace and anything unmapped. */
  characterAt(zoneIndex: number): string {
    if (zoneIndex < 0 || zoneIndex >= BACKSPACE_INDEX) return '';
    return PAIRING_ALPHABET[zoneIndex] ?? '';
  }
}

/**
 * Apply a key press to the code being typed.
 *
 * Pure, so the whole entry behaviour can be asserted without a headset. It
 * stops at the code length rather than scrolling: a code is exactly six
 * characters, and silently dropping the first one as a seventh arrives would
 * turn a typo into a mystery.
 */
export function applyKey(current: string, zoneIndex: number, layout: KeypadLayout): string {
  if (zoneIndex === BACKSPACE_INDEX) return current.slice(0, -1);
  const character = layout.characterAt(zoneIndex);
  if (character === '') return current;
  if (current.length >= PAIRING_CODE_LENGTH) return current;
  return current + character;
}
