// SPDX-License-Identifier: GPL-3.0-only
//
// The palette tables below are ported from CoreFW
// (https://github.com/anthonyhfm/launchpad-core-firmware), a GPL-3.0-only
// reimplementation of the Novation Launchpad firmware by Anthony Hofmeister.
// VRMC is GPL-3.0-only for the same reason.

/**
 * The Novation velocity palette.
 *
 * Every Launchpad accepts two ways of lighting an LED. The cheap one is an
 * ordinary Note On or Control Change whose *velocity* selects one of 128
 * predefined colours — one message per pad, no SysEx framing. Ableton uses this
 * constantly, so an emulator that only understood the RGB SysEx would show a
 * blank grid in the one situation that matters most.
 *
 * Channels are stored separately and 6-bit (0..63), exactly as the hardware
 * holds them, so a round trip through this table cannot introduce rounding that
 * the real device would not have.
 */

/** Number of entries. Velocity is 7-bit, so every value is in range. */
export const PALETTE_SIZE = 128;

/** Maximum value of a single colour channel on the wire. */
export const CHANNEL_MAX = 63;

const PALETTE_R = new Uint8Array([
  0, 15, 31, 63, 63, 63, 31, 15, 63, 63, 31, 15, 63, 63, 31, 15, 31, 19, 11, 5, 19, 0, 0, 0,
  19, 0, 0, 0, 19, 0, 0, 0, 19, 0, 0, 0, 19, 0, 0, 0, 19, 0, 0, 0, 11, 0, 0, 0, 23, 11, 5, 3,
  63, 63, 31, 15, 63, 63, 31, 15, 63, 39, 31, 11, 0, 0, 0, 0, 0, 7, 23, 7, 63, 47, 43, 23, 3,
  0, 0, 0, 7, 23, 43, 11, 63, 31, 27, 0, 15, 23, 15, 23, 11, 27, 55, 63, 63, 47, 35, 31, 15,
  0, 3, 5, 5, 23, 31, 55, 55, 63, 39, 27, 5, 55, 31, 39, 35, 15, 27, 55, 39, 13, 5, 0, 47, 15,
  43, 19,
]);

const PALETTE_G = new Uint8Array([
  0, 15, 31, 63, 15, 0, 0, 0, 47, 15, 7, 3, 43, 63, 31, 15, 63, 63, 31, 15, 63, 63, 31, 15,
  63, 63, 31, 15, 63, 63, 31, 15, 63, 63, 31, 15, 47, 43, 21, 11, 31, 21, 11, 5, 7, 0, 0, 0,
  15, 0, 0, 0, 15, 0, 0, 0, 15, 0, 0, 0, 3, 15, 19, 11, 15, 15, 7, 0, 15, 0, 15, 3, 0, 63, 59,
  63, 31, 63, 39, 11, 0, 0, 7, 3, 11, 55, 63, 63, 63, 59, 63, 35, 19, 19, 7, 0, 19, 43, 63,
  23, 11, 17, 19, 5, 7, 13, 0, 15, 17, 47, 55, 43, 5, 55, 59, 39, 27, 15, 27, 63, 0, 0, 51,
  15, 43, 11, 19, 3,
]);

const PALETTE_B = new Uint8Array([
  0, 15, 31, 63, 15, 0, 0, 0, 27, 0, 0, 0, 11, 0, 0, 0, 11, 0, 0, 0, 15, 0, 0, 0, 19, 7, 3, 1,
  23, 23, 11, 5, 47, 39, 19, 9, 63, 63, 31, 15, 63, 63, 31, 15, 63, 63, 31, 15, 63, 63, 31,
  15, 63, 63, 31, 15, 27, 19, 11, 7, 0, 0, 0, 0, 0, 7, 27, 63, 15, 47, 19, 5, 0, 11, 0, 0, 0,
  23, 63, 63, 63, 59, 31, 0, 0, 0, 7, 0, 11, 27, 51, 63, 51, 55, 63, 23, 0, 0, 0, 0, 0, 3, 7,
  11, 23, 5, 0, 11, 3, 7, 11, 3, 11, 27, 35, 63, 63, 15, 27, 63, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/**
 * Look up a palette entry, writing 6-bit r/g/b into `out` at `offset`.
 *
 * Writes into a caller-owned buffer rather than returning a tuple: this runs
 * once per lit pad per LED update, and a DAW redrawing a full 8x8 grid at frame
 * rate would otherwise allocate 64 short-lived objects per redraw.
 */
export function paletteInto(index: number, out: Uint8Array, offset: number): void {
  const i = index & 0x7f;
  out[offset] = PALETTE_R[i]!;
  out[offset + 1] = PALETTE_G[i]!;
  out[offset + 2] = PALETTE_B[i]!;
}

/** Red channel of a palette entry, 0..63. */
export function paletteR(index: number): number {
  return PALETTE_R[index & 0x7f]!;
}

/** Green channel of a palette entry, 0..63. */
export function paletteG(index: number): number {
  return PALETTE_G[index & 0x7f]!;
}

/** Blue channel of a palette entry, 0..63. */
export function paletteB(index: number): number {
  return PALETTE_B[index & 0x7f]!;
}

/** Widen a 6-bit hardware channel to 8-bit, for rendering. */
export function to8Bit(channel6: number): number {
  const c = channel6 < 0 ? 0 : channel6 > CHANNEL_MAX ? CHANNEL_MAX : channel6;
  // Replicate the high bits into the low ones so 63 maps to 255 exactly rather
  // than to 252, which would make full white read as slightly grey.
  return (c << 2) | (c >> 4);
}

/**
 * Nearest palette index to a 6-bit RGB triple.
 *
 * Only needed when something must be expressed as a velocity — the reverse
 * direction is the common one. Squared Euclidean distance in RGB is crude
 * colour science but matches how the palette was laid out.
 */
export function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const dr = PALETTE_R[i]! - r;
    const dg = PALETTE_G[i]! - g;
    const db = PALETTE_B[i]! - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
