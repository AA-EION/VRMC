// SPDX-License-Identifier: GPL-3.0-only

import { isPrivateAddress, type PairingLookup, type PairingRegistration } from '@vrmc/protocol';

/**
 * Short-lived record of which bridge answers to which pairing code.
 *
 * The service exists only to introduce two machines that cannot otherwise find
 * each other: a browser cannot enumerate the local network, and the bridge has
 * no public address. Once the headset knows the LAN address, every MIDI packet
 * goes directly between them — nothing musical ever passes through here.
 *
 * So this holds as little as possible, for as short a time as possible. Entries
 * are in memory, expire in a couple of minutes without a refresh, and vanish
 * entirely on restart. There is no database because there is nothing worth
 * persisting: a bridge that is still running re-registers within seconds.
 */

export interface StoredEntry extends PairingRegistration {
  expiresAt: number;
}

export interface PairingStoreOptions {
  ttlSeconds: number;
  /** Most codes held at once, as a cap on memory from a hostile client. */
  maxEntries: number;
  now?: () => number;
}

export class PairingStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly options: Required<PairingStoreOptions>;

  constructor(options: PairingStoreOptions) {
    this.options = { now: () => Date.now(), ...options };
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Record a bridge's addresses against its code.
   *
   * Public addresses are refused. Accepting one would let a registration point
   * every headset that types that code at a machine on the open internet, which
   * is both a way to attack a third party and a way to leak a user's traffic.
   */
  register(registration: PairingRegistration): { ok: true } | { ok: false; reason: string } {
    const addresses = registration.addresses.filter(isPrivateAddress);
    if (addresses.length === 0) {
      return { ok: false, reason: 'no private LAN address in registration' };
    }
    if (registration.port < 1 || registration.port > 65535) {
      return { ok: false, reason: 'port out of range' };
    }

    this.sweep();
    if (!this.entries.has(registration.code) && this.entries.size >= this.options.maxEntries) {
      return { ok: false, reason: 'too many active registrations' };
    }

    this.entries.set(registration.code, {
      ...registration,
      addresses,
      label: registration.label.slice(0, 60),
      version: registration.version.slice(0, 24),
      expiresAt: this.options.now() + this.options.ttlSeconds * 1000,
    });
    return { ok: true };
  }

  /** Resolve a code, or null if it is unknown or stale. */
  lookup(code: string): PairingLookup | null {
    const entry = this.entries.get(code);
    if (entry === undefined) return null;
    const remaining = entry.expiresAt - this.options.now();
    if (remaining <= 0) {
      this.entries.delete(code);
      return null;
    }
    return {
      addresses: entry.addresses,
      port: entry.port,
      label: entry.label,
      version: entry.version,
      expiresIn: Math.round(remaining / 1000),
    };
  }

  /** Forget a code, for a bridge shutting down cleanly. */
  release(code: string): boolean {
    return this.entries.delete(code);
  }

  /** Drop everything expired. Called on write, so idle memory stays flat. */
  sweep(): number {
    const now = this.options.now();
    let removed = 0;
    for (const [code, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(code);
        removed++;
      }
    }
    return removed;
  }
}
