// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  generatePairingCode,
  isPairingCode,
  isPrivateAddress,
  normalisePairingCode,
} from '../src/index.js';

/** Deterministic byte source, so the generator can be checked exactly. */
function bytesFrom(values: number[]): (n: number) => Uint8Array {
  let i = 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = values[i++ % values.length]!;
    return out;
  };
}

describe('pairing codes', () => {
  it('excludes every confusable character from the alphabet', () => {
    // Both halves of each pair are gone, so nothing can be misread into
    // something else that is also valid.
    for (const ch of ['0', 'O', '1', 'I', 'L', '5', 'S', '8', 'B', 'U', 'V']) {
      expect(PAIRING_ALPHABET).not.toContain(ch);
    }
    expect(new Set(PAIRING_ALPHABET).size).toBe(PAIRING_ALPHABET.length);
  });

  it('generates codes of the right length from the alphabet', () => {
    const code = generatePairingCode(bytesFrom([0, 1, 2, 3, 4, 5]));
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(isPairingCode(code)).toBe(true);
  });

  it('rejects biased bytes rather than folding them in', () => {
    // 24 * 10 = 240, so bytes 240..255 must be discarded; a modulo would map
    // them onto the first characters and make those likelier.
    const code = generatePairingCode(bytesFrom([250, 251, 252, 253, 254, 255, 0, 0, 0, 0, 0, 0]));
    expect(code).toBe(PAIRING_ALPHABET[0]!.repeat(PAIRING_CODE_LENGTH));
  });

  it('produces a roughly uniform distribution', () => {
    // Every byte value once: each alphabet character should appear a similar
    // number of times, which a modulo bias would visibly skew.
    const counts = new Map<string, number>();
    const source = bytesFrom([...Array(256).keys()]);
    for (let i = 0; i < 400; i++) {
      for (const ch of generatePairingCode(source)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const values = [...counts.values()];
    expect(counts.size).toBe(PAIRING_ALPHABET.length);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.6);
  });

  it('normalises case and separators as typed', () => {
    expect(normalisePairingCode('k7m-2qx')).toBe('K7M2QX');
    expect(normalisePairingCode('K7M 2QX')).toBe('K7M2QX');
    expect(normalisePairingCode('  k7m2qx  ')).toBe('K7M2QX');
  });

  it('does not invent a correction for a misread character', () => {
    // O is not in the alphabet and neither is 0, so there is nothing to map it
    // to. It must fail clearly rather than resolve to someone else's code.
    const typed = normalisePairingCode('K7M2QO');
    expect(isPairingCode(typed)).toBe(false);
  });

  it('rejects codes of the wrong length or with stray characters', () => {
    expect(isPairingCode('K7M2Q')).toBe(false);
    expect(isPairingCode('K7M2QXX')).toBe(false);
    expect(isPairingCode('K7M2Q!')).toBe(false);
  });

  it('formats a code split for reading off a screen', () => {
    expect(formatPairingCode('K7M2QX')).toBe('K7M-2QX');
  });
});

describe('bridge addresses', () => {
  it('recognises the private ranges a bridge can live on', () => {
    expect(isPrivateAddress('192.168.1.42')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
  });

  it('rejects public and malformed addresses', () => {
    // A registration naming a public address would point other users' headsets
    // at a stranger's machine.
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('192.169.1.1')).toBe(false);
    expect(isPrivateAddress('not.an.ip.addr')).toBe(false);
    expect(isPrivateAddress('1.2.3')).toBe(false);
  });
});
