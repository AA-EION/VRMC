// SPDX-License-Identifier: GPL-3.0-only

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where the native helper lives, in the order worth trying.
 *
 * Packaged first: beside the executable is where the packaging step puts it,
 * and inside a `.app` that is `Contents/MacOS`, the same directory. Then the
 * build output, so `pnpm start` during development picks up a helper compiled
 * by `native/build.mjs` without anything being installed.
 *
 * Shared because the helper now has two callers. It draws the menu bar icon,
 * and it registers the login item — the latter because the supported API for
 * that is SMAppService, which is Swift-only and needs a bundle to point at,
 * and this executable is already inside one.
 */
export function helperCandidates(): string[] {
  const name = process.platform === 'win32' ? 'vrmc-tray.exe' : 'vrmc-tray';
  const beside = dirname(process.execPath);
  const out: string[] = [join(beside, name)];

  // Only meaningful when running from source; in a packaged binary this
  // resolves inside the virtual filesystem and simply does not exist.
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    out.push(join(here, '../../native/build', name));
  } catch {
    // No import.meta.url under some bundlers; the packaged path above stands.
  }
  return out;
}

/** The helper's path, or null when this build has none. */
export function findHelper(): string | null {
  return helperCandidates().find((p) => existsSync(p)) ?? null;
}
