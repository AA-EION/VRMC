// SPDX-License-Identifier: GPL-3.0-only

import { isPairingCode, normalisePairingCode, type PairingLookup } from '@vrmc/protocol';

/**
 * Turning a six-character code into a live connection.
 *
 * The client is served from a public site and the bridge lives on a private
 * network, so the two cannot find each other unaided: a browser cannot
 * enumerate the LAN, and the bridge has no public address. The code is the
 * introduction, and it is the *only* thing the user has to do — no address to
 * type, no certificate to accept, no name to configure. Once the data channel
 * forms, every packet goes straight between the headset and the computer.
 */

export interface ResolvedBridge {
  /** The normalised code, ready to hand to `rtcTransport`. */
  code: string;
  /** Machine name, so the user can confirm they paired the right computer. */
  label: string;
  version: string;
}

export class PairingError extends Error {
  constructor(
    message: string,
    /** True when retrying with the same code might work. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

/** Whether this deployment can broker a connection. Asked once. */
let cachedSupport: boolean | null = null;

async function pairingSupported(): Promise<boolean> {
  if (cachedSupport !== null) return cachedSupport;
  try {
    const res = await fetch('/api/config', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const config = (await res.json()) as { pairing?: boolean };
      cachedSupport = config.pairing === true;
      return cachedSupport;
    }
  } catch {
    // Served from a plain static host with no API behind it.
  }
  cachedSupport = false;
  return false;
}

/**
 * Check a pairing code and find out which computer it belongs to.
 *
 * This only confirms the bridge is registered and names it; the connection
 * itself is made by `rtcTransport`, which negotiates directly with that
 * machine. Doing the lookup first means a mistyped code fails immediately with
 * something readable, rather than after a handshake times out.
 */
export async function resolvePairingCode(input: string): Promise<ResolvedBridge> {
  const code = normalisePairingCode(input);
  if (!isPairingCode(code)) {
    throw new PairingError('That code does not look right — check the characters.', false);
  }

  if (!(await pairingSupported())) {
    throw new PairingError(
      'This site is not configured for pairing. Enter the bridge address instead.',
      false,
    );
  }

  let res: Response;
  try {
    res = await fetch(`/api/pair/${code}`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new PairingError('Could not reach the pairing service.', true);
  }

  if (res.status === 404) {
    throw new PairingError(
      'No computer with that code. Check the VRMC desktop app is running and the code matches.',
      true,
    );
  }
  if (res.status === 429) {
    throw new PairingError('Too many attempts. Wait a moment and try again.', true);
  }
  if (!res.ok) throw new PairingError(`Pairing failed (${res.status}).`, true);

  const found = (await res.json()) as PairingLookup;
  return { code, label: found.label, version: found.version };
}
