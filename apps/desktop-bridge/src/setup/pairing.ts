// SPDX-License-Identifier: GPL-3.0-only

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_TTL_SECONDS,
  formatPairingCode,
  generatePairingCode,
  type PairingRegistration,
} from '@vrmc/protocol';
import { ensureDataDir } from './paths.js';

export interface PairingOptions {
  /** Base URL of the pairing service, e.g. https://vrmc.eionstudios.com */
  serviceUrl: string;
  port: number;
  version: string;
  /** Supplies the machine's current private addresses. */
  addresses: () => string[];
  onLog: (message: string) => void;
}

const CODE_FILE = 'pairing-code.txt';

/**
 * Publishes this bridge's pairing code so a headset can find it.
 *
 * A browser cannot enumerate the local network, and the bridge has no public
 * address, so the two cannot discover each other unaided. The code is the
 * introduction: the bridge posts it alongside its LAN addresses, the user types
 * six characters in the headset, and from then on the connection is direct.
 *
 * Nothing musical passes through the service — it hands over an address and
 * gets out of the way. Registrations expire in a couple of minutes, so a bridge
 * that stops running stops being findable without anything having to clean up.
 */
export class PairingPublisher {
  readonly code: string;
  private readonly options: PairingOptions;
  private timer: NodeJS.Timeout | null = null;
  private lastError = '';
  private registered = false;

  constructor(options: PairingOptions) {
    this.options = options;
    this.code = loadOrCreateCode();
  }

  /** The code as shown to the user. */
  get displayCode(): string {
    return formatPairingCode(this.code);
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  get error(): string {
    return this.lastError;
  }

  /**
   * Start publishing, and keep the registration fresh.
   *
   * Refreshed at a third of the expiry so a single failed request never makes
   * the bridge unreachable — there are two more attempts before it lapses.
   */
  start(): void {
    void this.publish();
    const interval = Math.max(15_000, (PAIRING_TTL_SECONDS * 1000) / 3);
    this.timer = setInterval(() => void this.publish(), interval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (!this.registered) return;
    // Withdraw on the way out, so a code stops resolving the moment the bridge
    // is closed rather than lingering until it expires.
    try {
      await fetch(new URL('/api/pair', this.options.serviceUrl), {
        method: 'DELETE',
        // The registration is posted with this header and withdrawn without
        // it, which is the kind of asymmetry a body parser refuses on: most
        // reject a JSON body that does not say it is JSON, and the withdrawal
        // then fails silently and the code lingers until it expires — which is
        // exactly the outcome the comment above says this avoids.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: this.code }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // The service being unreachable at shutdown is not worth reporting; the
      // registration expires on its own.
    }
  }

  private async publish(): Promise<void> {
    const addresses = this.options.addresses();
    if (addresses.length === 0) {
      this.lastError = 'no LAN address to publish';
      this.registered = false;
      return;
    }

    const registration: PairingRegistration = {
      code: this.code,
      addresses,
      port: this.options.port,
      label: hostname(),
      version: this.options.version,
    };

    try {
      const res = await fetch(new URL('/api/pair', this.options.serviceUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(registration),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`${res.status} ${detail.slice(0, 120)}`);
      }
      if (!this.registered) {
        this.options.onLog(`pairing code ${this.displayCode} is live`);
      }
      this.registered = true;
      this.lastError = '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only reported on the transition, so a bridge running offline does not
      // fill the log with the same line every 40 seconds.
      if (this.registered || this.lastError === '') {
        this.options.onLog(`pairing service unreachable: ${message}`);
      }
      this.registered = false;
      this.lastError = message;
    }
  }
}

/**
 * Load this machine's code, creating one on first run.
 *
 * The code is stable across restarts on purpose: a user who wrote it down, or
 * whose headset remembers it, should not have to re-pair because the bridge was
 * restarted.
 */
function loadOrCreateCode(): string {
  const path = join(ensureDataDir(), CODE_FILE);
  if (existsSync(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved.length > 0) return saved;
  }
  const code = generatePairingCode((n) => new Uint8Array(randomBytes(n)));
  writeFileSync(path, code, { mode: 0o600 });
  return code;
}
