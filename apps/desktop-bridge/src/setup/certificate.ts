// SPDX-License-Identifier: GPL-3.0-only

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDataDir } from './paths.js';

export interface Certificate {
  cert: string;
  key: string;
  /** Paths on disk, which is what the HTTPS server wants. */
  certPath: string;
  keyPath: string;
  /** Names and addresses the certificate is valid for. */
  names: string[];
  /** True when this run had to create or replace it. */
  created: boolean;
}

/**
 * TLS, without the user ever seeing a flag.
 *
 * The bridge has to speak HTTPS whether anyone asks for it or not: WebXR only
 * runs in a secure context, so a client served over plain HTTP loads and then
 * refuses to start a session. Requiring `--tls-cert` made that the user's
 * problem, which for a musician is the wrong problem.
 *
 * So a certificate is generated on first run and kept in the app data
 * directory. It is self-signed, which costs one "not private" warning the first
 * time a headset visits — irreducible without a certificate authority, and a
 * one-time three-tap cost rather than an ongoing one.
 */
const CERT_FILE = 'bridge-cert.pem';
const KEY_FILE = 'bridge-key.pem';
const NAMES_FILE = 'bridge-cert-names.json';

/**
 * Ten years.
 *
 * This certificate secures a link between two machines in one room, and its
 * expiry would surface as a browser error long after anyone remembers where it
 * came from. Renewal has no security value here — nothing trusts this
 * certificate except the headset that was shown it once.
 */
const VALID_DAYS = 3650;

export async function ensureCertificate(localAddresses: string[]): Promise<Certificate> {
  const dir = ensureDataDir();
  const certPath = join(dir, CERT_FILE);
  const keyPath = join(dir, KEY_FILE);
  const namesPath = join(dir, NAMES_FILE);

  // Every name the certificate must cover. A machine that moved networks has a
  // new address, and a certificate that does not name it produces an error the
  // user cannot act on — so the address list is part of the cache key.
  const names = wanted(localAddresses);

  if (existsSync(certPath) && existsSync(keyPath) && existsSync(namesPath)) {
    try {
      const cached = JSON.parse(readFileSync(namesPath, 'utf8')) as string[];
      if (covers(cached, names)) {
        return {
          cert: readFileSync(certPath, 'utf8'),
          key: readFileSync(keyPath, 'utf8'),
          certPath,
          keyPath,
          names: cached,
          created: false,
        };
      }
    } catch {
      // Unreadable cache: fall through and regenerate.
    }
  }

  const { generate } = await import('selfsigned');
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + VALID_DAYS * 86400_000);
  const pems = await generate([{ name: 'commonName', value: 'vrmc.local' }], {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: names.map((n) =>
          // type 7 is an IP address, type 2 a DNS name. Browsers match the
          // address they dialled against the right one, so a mislabelled entry
          // is the same as no entry at all.
          isIpv4(n) ? { type: 7, ip: n } : { type: 2, value: n },
        ),
      },
    ],
  });

  writeFileSync(certPath, pems.cert, { mode: 0o644 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  writeFileSync(namesPath, JSON.stringify(names), { mode: 0o644 });

  return { cert: pems.cert, key: pems.private, certPath, keyPath, names, created: true };
}

/** Names the certificate should carry, given the machine's addresses. */
function wanted(localAddresses: string[]): string[] {
  const names = new Set<string>(['vrmc.local', 'localhost', '127.0.0.1', '::1']);
  for (const address of localAddresses) names.add(address);
  return [...names];
}

/** True if the cached certificate already names everything needed now. */
function covers(cached: string[], needed: string[]): boolean {
  const have = new Set(cached);
  return needed.every((n) => have.has(n));
}

function isIpv4(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}
