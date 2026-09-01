// SPDX-License-Identifier: GPL-3.0-only

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Where the bridge keeps state between runs.
 *
 * Each platform has one conventional place for this, and using it matters
 * beyond tidiness: an app that scatters files next to its executable breaks the
 * moment it is installed into Program Files or /Applications, where a normal
 * user has no write access.
 */
export function dataDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'VRMC');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'VRMC');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'vrmc');
  }
}

/** Create the data directory if it is missing, and return it. */
export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
