// SPDX-License-Identifier: GPL-3.0-only

/**
 * Pairing: how a headset on a public web page finds a bridge on a private LAN.
 *
 * The constraint that shapes all of this: a page served over HTTPS may only
 * open `wss://`, and the browser will only accept a certificate it already
 * trusts. It never navigates to the bridge, so there is no moment at which a
 * user could accept a self-signed one — the handshake simply fails.
 *
 * The way out is a real certificate on a hostname that resolves to a private
 * address. `192-168-1-42.lan.example.com` is a public DNS name, answered with
 * `192.168.1.42`, and covered by a genuine wildcard certificate. The headset
 * connects straight to the LAN with no warning, and no traffic goes near the
 * internet.
 *
 * What remains is telling the headset *which* address, since a browser cannot
 * enumerate the local network. That is the pairing code: a short string the
 * bridge publishes alongside its addresses, which the user types once.
 */

/**
 * Alphabet for pairing codes.
 *
 * No 0/O, 1/I/L, 5/S, 8/B, U/V. These are read off a screen and typed on a
 * floating keyboard by someone wearing a headset, where a misread character
 * costs a retry with no clue as to which one was wrong.
 */
export const PAIRING_ALPHABET = '23479ACDEFGHJKMNPQRTWXYZ';

/** Characters per code. 24^6 is about 191 million — ample against guessing. */
export const PAIRING_CODE_LENGTH = 6;

/** How long a registration stays valid without a refresh, in seconds. */
export const PAIRING_TTL_SECONDS = 120;

/** Generate a pairing code from a source of random bytes. */
export function generatePairingCode(randomBytes: (n: number) => Uint8Array): string {
  const alphabet = PAIRING_ALPHABET;
  // Reject values in the final partial block so every character stays equally
  // likely; a plain modulo would quietly bias the first few letters.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return out;
}

/**
 * Normalise a code as typed: upper case, and drop the separators.
 *
 * Deliberately no attempt to "correct" confusable characters. The alphabet
 * already excludes *both* halves of every confusable pair — there is no O to
 * mistake for 0, because neither is ever in a code — so a code containing one
 * was misread rather than mistyped, and there is no valid character to map it
 * to. Guessing would turn a clear "that is not a valid code" into a silent
 * lookup failure against someone else's code.
 */
export function normalisePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, PAIRING_CODE_LENGTH);
}

/** Format a code for display, split for readability: `K7M-2QX`. */
export function formatPairingCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/** True if `code` could be a valid pairing code. */
export function isPairingCode(code: string): boolean {
  if (code.length !== PAIRING_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!PAIRING_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** True for the private ranges a bridge can legitimately be reached on. */
export function isPrivateAddress(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Carrier-grade NAT, which some mesh networks use.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// --- Pairing service API ---

/** What a bridge publishes about itself. */
export interface PairingRegistration {
  code: string;
  /** Private IPv4 addresses the bridge is listening on. */
  addresses: string[];
  port: number;
  /** Shown in the client so the user can confirm they paired the right machine. */
  label: string;
  version: string;
}

/** What the client gets back when it resolves a code. */
export interface PairingLookup {
  addresses: string[];
  port: number;
  label: string;
  version: string;
  /** Seconds until this registration goes stale. */
  expiresIn: number;
}
