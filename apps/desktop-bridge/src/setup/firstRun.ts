// SPDX-License-Identifier: GPL-3.0-only

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enableAutostart, autostartSupported } from './autostart.js';
import { ensureDataDir } from './paths.js';

const MARKER = 'installed';

/**
 * What happens the first time someone opens the app.
 *
 * The goal is that dragging VRMC to Applications and double-clicking it is the
 * entire installation. No installer, no terminal, no settings pane, no
 * explanation of what a LaunchAgent is — the icon appears in the menu bar, the
 * pairing code is there, and it comes back after a reboot.
 *
 * So the first run registers the login item itself. That is a real decision
 * made on the user's behalf, and it is defensible only because it is exactly
 * what opening a background MIDI interface means, it is visible as a ticked
 * item in the menu the moment they look, and one click undoes it. It happens
 * once: the marker below means a user who turns it off does not find it back
 * on tomorrow.
 */

export interface FirstRunResult {
  /** True when this was the first launch on this machine. */
  first: boolean;
  /** True when the login item was registered as part of it. */
  registered: boolean;
  /** Why nothing was registered, when nothing was. */
  reason: string;
}

/**
 * Whether the app is running from somewhere its path will stay valid.
 *
 * A login item records an absolute path. Registering one for a copy still
 * running from a mounted disk image, or from a Downloads folder the user is
 * about to tidy, produces a login item that fails silently at every boot —
 * worse than none, because it looks like it is set up.
 */
export function inStableLocation(): boolean {
  const path = process.execPath;
  if (process.platform === 'darwin') {
    return path.startsWith('/Applications/') || path.startsWith(`${homeApplications()}/`);
  }
  if (process.platform === 'win32') {
    // Installed by the MSI under Program Files, rather than run from a
    // download or a USB stick.
    return /\\Program Files( \(x86\))?\\/i.test(path);
  }
  return false;
}

function homeApplications(): string {
  return join(process.env.HOME ?? '', 'Applications');
}

/**
 * Run the first-launch setup, at most once.
 *
 * Never throws and never blocks startup on failure: a bridge that will not
 * start because it could not write a plist is a much worse outcome than one
 * the user has to launch by hand.
 */
export async function runFirstLaunch(): Promise<FirstRunResult> {
  let marker: string;
  try {
    marker = join(ensureDataDir(), MARKER);
  } catch {
    return { first: false, registered: false, reason: 'no writable data directory' };
  }

  if (existsSync(marker)) return { first: false, registered: false, reason: '' };

  // Written before the work, not after. A failure part-way through must not
  // leave the app trying to install itself on every launch.
  try {
    writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    return { first: true, registered: false, reason: 'could not record first launch' };
  }

  if (!autostartSupported()) {
    return { first: true, registered: false, reason: 'not a packaged build' };
  }
  if (!inStableLocation()) {
    return {
      first: true,
      registered: false,
      reason:
        process.platform === 'darwin'
          ? 'move VRMC to your Applications folder to have it start at login'
          : 'run the installer to have VRMC start at login',
    };
  }

  const ok = await enableAutostart();
  return {
    first: true,
    registered: ok,
    reason: ok ? '' : 'could not register the login item',
  };
}
