// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH, isPairingCode } from '@vrmc/protocol';
import { applyKey, BACKSPACE_INDEX, KeypadLayout } from '../src/ui/KeypadLayout.js';

/**
 * The in-session keypad's geometry and entry rules.
 *
 * Both are worth testing away from a headset: the geometry is what decides
 * whether a poke lands on the character the user aimed at, and getting it
 * wrong produces a panel that types the wrong letter rather than one that
 * obviously does not work.
 */

const layout = new KeypadLayout();

/** Centre of a key, in surface-local metres. */
function centre(index: number): [number, number] {
  const zone = layout.zones[index]!;
  return [zone.rect.x + zone.rect.width / 2, zone.rect.y + zone.rect.height / 2];
}

describe('the keypad layout', () => {
  it('offers every character a code can contain, and nothing else', () => {
    const characters = layout.zones
      .slice(0, BACKSPACE_INDEX)
      .map((z) => z.label)
      .join('');
    expect(characters).toBe(PAIRING_ALPHABET);
    // Nothing to press that could not be part of an answer.
    expect(layout.zones).toHaveLength(PAIRING_ALPHABET.length + 1);
    expect(layout.zones[BACKSPACE_INDEX]?.label).toBe('⌫');
  });

  it('reads top to bottom, not bottom to top', () => {
    // Surface Y grows upward, so the natural loop puts the first character at
    // the bottom — which would show the alphabet upside down.
    const first = layout.zones[0]!;
    const last = layout.zones[BACKSPACE_INDEX]!;
    expect(first.rect.y).toBeGreaterThan(last.rect.y);
    expect(first.row).toBe(0);
    expect(first.col).toBe(0);
  });

  it('locates the centre of every key', () => {
    for (const zone of layout.zones) {
      const [x, y] = centre(zone.index);
      expect(layout.locate(x, y)).toBe(zone.index);
    }
  });

  it('treats the gap between keys as a miss', () => {
    // A finger between two characters is a miss. Snapping to the nearest is
    // how a code ends up with a letter the user did not press.
    const a = layout.zones[0]!;
    const gapX = a.rect.x + a.rect.width + 0.004;
    const [, y] = centre(0);
    expect(layout.locate(gapX, y)).toBe(-1);
  });

  it('misses cleanly outside the panel', () => {
    expect(layout.locate(-0.01, 0.05)).toBe(-1);
    expect(layout.locate(0.05, -0.01)).toBe(-1);
    expect(layout.locate(layout.width + 0.01, 0.05)).toBe(-1);
    expect(layout.locate(0.05, layout.height + 0.01)).toBe(-1);
  });

  it('has no zone outside its own bounds', () => {
    for (const zone of layout.zones) {
      expect(zone.rect.x).toBeGreaterThanOrEqual(0);
      expect(zone.rect.y).toBeGreaterThanOrEqual(0);
      expect(zone.rect.x + zone.rect.width).toBeLessThanOrEqual(layout.width + 1e-9);
      expect(zone.rect.y + zone.rect.height).toBeLessThanOrEqual(layout.height + 1e-9);
    }
  });

  it('uses keys big enough to hit with a tracked finger', () => {
    // Hand tracking is accurate to a few millimetres at arm's length, and the
    // user is reading the code off another screen while aiming.
    const zone = layout.zones[0]!;
    expect(zone.rect.width).toBeGreaterThanOrEqual(0.03);
  });

  it('maps zones to characters and back', () => {
    for (const [index, character] of [...PAIRING_ALPHABET].entries()) {
      expect(layout.characterAt(index)).toBe(character);
    }
    expect(layout.characterAt(BACKSPACE_INDEX)).toBe('');
    expect(layout.characterAt(-1)).toBe('');
    expect(layout.characterAt(999)).toBe('');
  });
});

describe('typing a code', () => {
  const indexOf = (character: string): number => PAIRING_ALPHABET.indexOf(character);

  it('appends characters as they are pressed', () => {
    let code = '';
    for (const character of 'K7M2QX') {
      code = applyKey(code, indexOf(character), layout);
    }
    expect(code).toBe('K7M2QX');
    expect(isPairingCode(code)).toBe(true);
  });

  it('deletes on backspace', () => {
    expect(applyKey('K7M', BACKSPACE_INDEX, layout)).toBe('K7');
  });

  it('does nothing on backspace with an empty field', () => {
    expect(applyKey('', BACKSPACE_INDEX, layout)).toBe('');
  });

  it('stops at the code length rather than scrolling', () => {
    // Dropping the first character as a seventh arrives would turn a typo into
    // a mystery: the field would look right and mean something else.
    const full = 'K7M2QX';
    expect(full).toHaveLength(PAIRING_CODE_LENGTH);
    expect(applyKey(full, indexOf('A'), layout)).toBe(full);
  });

  it('still deletes once the field is full', () => {
    expect(applyKey('K7M2QX', BACKSPACE_INDEX, layout)).toBe('K7M2Q');
  });

  it('ignores a press that is not on a key', () => {
    expect(applyKey('K7', -1, layout)).toBe('K7');
    expect(applyKey('K7', 999, layout)).toBe('K7');
  });

  it('can only ever produce a valid code', () => {
    // Every key is from the pairing alphabet, so six presses is always
    // something the service will accept as well-formed — a mistyped code
    // fails as "no such computer", never as "not a code".
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
      code = applyKey(code, i, layout);
    }
    expect(isPairingCode(code)).toBe(true);
  });
});
