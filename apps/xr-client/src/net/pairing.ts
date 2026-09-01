// SPDX-License-Identifier: GPL-3.0-only

import {
  bridgeUrl,
  isPairingCode,
  normalisePairingCode,
  type PairingLookup,
} from '@vrmc/protocol';

/**
 * Turning a pairing code into a bridge URL.
 *
 * The client is served from a public site and the bridge lives on a private
 * network, so the two cannot find each other unaided: a browser cannot
 * enumerate the LAN, and the bridge has no public address. The code is the
 * introduction. Once it resolves, every packet goes straight to the LAN.
 */

export interface ResolvedBridge {
  /** Candidate wss:// URLs, best first. */
  urls: string[];
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

/** The site's LAN wildcard domain, fetched once and remembered. */
let cachedDomain: string | null = null;

async function lanDomain(): Promise<string> {
  if (cachedDomain !== null) return cachedDomain;
  try {
    const res = await fetch('/api/config', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const config = (await res.json()) as { lanDomain?: string };
      if (typeof config.lanDomain === 'string' && config.lanDomain.length > 0) {
        cachedDomain = config.lanDomain;
        return cachedDomain;
      }
    }
  } catch {
    // Served from somewhere without the pairing service — fall through.
  }
  throw new PairingError(
    'This site is not configured for pairing. Enter the bridge address instead.',
    false,
  );
}

/**
 * Resolve a pairing code to the bridge's LAN addresses.
 *
 * Every address the bridge reported becomes a candidate, because a machine with
 * both Wi-Fi and Ethernet has several and only the one sharing a network with
 * the headset will actually connect.
 */
export async function resolvePairingCode(input: string): Promise<ResolvedBridge> {
  const code = normalisePairingCode(input);
  if (!isPairingCode(code)) {
    throw new PairingError('That code does not look right — check the characters.', false);
  }

  const domain = await lanDomain();

  let res: Response;
  try {
    res = await fetch(`/api/pair/${code}`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new PairingError('Could not reach the pairing service.', true);
  }

  if (res.status === 404) {
    throw new PairingError(
      'No bridge with that code. Check the desktop app is running and the code matches.',
      true,
    );
  }
  if (res.status === 429) {
    throw new PairingError('Too many attempts. Wait a moment and try again.', true);
  }
  if (!res.ok) throw new PairingError(`Pairing failed (${res.status}).`, true);

  const found = (await res.json()) as PairingLookup & { lanDomain?: string };
  const useDomain = found.lanDomain ?? domain;
  const urls = found.addresses.map((a) => bridgeUrl(a, found.port, useDomain));
  if (urls.length === 0) {
    throw new PairingError('That bridge reported no usable address.', true);
  }
  return { urls, label: found.label, version: found.version };
}

/**
 * Try each candidate and keep the first that opens.
 *
 * A machine on both Wi-Fi and Ethernet publishes several addresses, and only
 * one shares a network with the headset. Racing them costs a few seconds at
 * worst and saves asking the user which interface their computer is using —
 * a question no musician should have to answer.
 */
export async function firstReachable(urls: string[], timeoutMs = 4000): Promise<string> {
  const attempts = urls.map(
    (url) =>
      new Promise<string>((resolve, reject) => {
        let socket: WebSocket;
        try {
          socket = new WebSocket(url);
        } catch {
          reject(new Error(`${url} rejected`));
          return;
        }
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error(`${url} timed out`));
        }, timeoutMs);
        socket.onopen = () => {
          clearTimeout(timer);
          // Close the probe; the link layer opens its own connection. Keeping
          // this one would leave the bridge counting a client that never
          // speaks, and its disconnect would release notes mid-performance.
          socket.close();
          resolve(url);
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`${url} unreachable`));
        };
      }),
  );

  const results = await Promise.allSettled(attempts);
  for (const result of results) {
    if (result.status === 'fulfilled') return result.value;
  }
  throw new PairingError(
    'Found the bridge but could not reach it. Are the headset and computer on the same network?',
    true,
  );
}
