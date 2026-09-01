// SPDX-License-Identifier: GPL-3.0-only

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The two things the menu asks the desktop to do.
 *
 * Both are shelling out to a platform utility rather than pulling in a
 * dependency. Each is one command per platform, they have not changed in
 * fifteen years, and a package for either would be more code in the supply
 * chain than the code it replaced.
 */

/**
 * Open a URL in the user's browser.
 *
 * Detached and with its stdio discarded, because the browser outlives us: a
 * child holding our pipes open would keep the bridge's event loop alive after
 * it had been asked to quit.
 */
export function openUrl(url: string): void {
  // Only ever called with a URL this process built, but validated anyway:
  // handing an arbitrary string to `open` is how a click becomes a command.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [parsed.href]]
      : process.platform === 'win32'
        ? // `start` is a shell builtin, not a program. Going through cmd needs
          // the empty title argument, or a quoted URL is taken as the title.
          ['cmd', ['/c', 'start', '', parsed.href]]
        : ['xdg-open', [parsed.href]];

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // No browser, or no launcher. Nothing useful to do about it from here.
  }
}

/**
 * Put text on the clipboard. Returns false when the platform has no way to.
 *
 * Written through stdin rather than as an argument: an argument would appear
 * in the process list, and while a pairing code is not a secret, it is the
 * thing that lets a headset reach this machine.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? 'pbcopy'
      : process.platform === 'win32'
        ? 'clip'
        : null;
  if (command === null) return false;

  try {
    const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(text);
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    return true;
  } catch {
    return false;
  }
}

/** True when a command exists on this machine. Used to report capability. */
export async function hasCommand(command: string): Promise<boolean> {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
}
