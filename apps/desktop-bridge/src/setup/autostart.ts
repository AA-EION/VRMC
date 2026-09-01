// SPDX-License-Identifier: GPL-3.0-only

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Starting the bridge when the user logs in.
 *
 * A MIDI interface that has to be launched by hand is a MIDI interface people
 * forget to launch, and the failure looks like the headset being broken rather
 * than the bridge being closed. So it starts at login.
 *
 * Both platforms register this **per user**, deliberately. A Windows service or
 * a system-wide LaunchDaemon would need an administrator, would run for every
 * account on the machine, and — on Windows — could not own a tray icon at all,
 * because services run in session 0 with no desktop. Per-user costs nothing,
 * needs no elevation, and puts the bridge in the same session as the DAW it
 * talks to.
 */

export type AutostartState = 'on' | 'off' | 'unsupported';

/** The bundle identifier, and the LaunchAgent's label. */
const LABEL = 'studio.eion.vrmc.bridge';

/** The Windows registry value name under the per-user Run key. */
const RUN_VALUE = 'VRMC';

/**
 * The command that should run at login.
 *
 * Inside a `.app` this must be the bundle, not the executable within it: macOS
 * treats a bare executable from a bundle as a separate, unbundled process,
 * which loses `Info.plist` — and with it `LSUIElement`, so the bridge would
 * appear in the Dock with no window.
 */
export function launchTarget(): string {
  const exe = process.execPath;
  if (process.platform === 'darwin') {
    const marker = '.app/Contents/MacOS/';
    const at = exe.indexOf(marker);
    if (at >= 0) return exe.slice(0, at + 4);
  }
  return exe;
}

/** True when this build can manage its own autostart. */
export function autostartSupported(): boolean {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
  // Running from `node dist/index.js` during development would register the
  // Node binary, which on the next login would start Node with no arguments.
  return !/[/\\]node(\.exe)?$/i.test(process.execPath);
}

function agentPath(): string {
  return join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
}

/**
 * The LaunchAgent property list.
 *
 * `KeepAlive` is deliberately absent. It would restart the bridge the moment
 * the user quit it from the menu bar, which turns a Quit item into a button
 * that appears to do nothing.
 */
function agentPlist(target: string): string {
  const program =
    target.endsWith('.app')
      ? // `open -a` launches the bundle properly, so Info.plist applies.
        ['/usr/bin/open', '-a', target]
      : [target];
  const args = program.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Whether the bridge is currently registered to start at login. */
export async function autostartState(): Promise<AutostartState> {
  if (!autostartSupported()) return 'unsupported';

  if (process.platform === 'darwin') {
    return existsSync(agentPath()) ? 'on' : 'off';
  }

  try {
    const { stdout } = await run('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      RUN_VALUE,
    ]);
    return stdout.includes(RUN_VALUE) ? 'on' : 'off';
  } catch {
    // `reg query` exits non-zero when the value does not exist, which is the
    // ordinary "not registered" answer rather than a failure.
    return 'off';
  }
}

/** Register the bridge to start at login. Returns false if it could not. */
export async function enableAutostart(): Promise<boolean> {
  if (!autostartSupported()) return false;
  const target = launchTarget();

  if (process.platform === 'darwin') {
    const path = agentPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, agentPlist(target), 'utf8');
      // Load it now so the setting takes effect without a logout. `bootstrap`
      // is the modern spelling; `load` is kept for older systems, and both
      // failing is not fatal — the agent still runs at the next login.
      await run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, path]).catch(
        () => run('launchctl', ['load', '-w', path]),
      );
      return true;
    } catch {
      return false;
    }
  }

  try {
    await run('reg', [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      RUN_VALUE,
      '/t',
      'REG_SZ',
      // Quoted, because Program Files has a space in it and an unquoted path
      // would be read as a command plus arguments.
      '/d',
      `"${target}"`,
      '/f',
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Stop the bridge starting at login. */
export async function disableAutostart(): Promise<boolean> {
  if (!autostartSupported()) return false;

  if (process.platform === 'darwin') {
    const path = agentPath();
    try {
      if (existsSync(path)) {
        await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`]).catch(
          () => run('launchctl', ['unload', '-w', path]),
        );
        unlinkSync(path);
      }
      return true;
    } catch {
      return false;
    }
  }

  try {
    await run('reg', [
      'delete',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      RUN_VALUE,
      '/f',
    ]);
    return true;
  } catch {
    // Already absent; that is the state the caller asked for.
    return true;
  }
}

/** Flip the setting, returning the state it ended in. */
export async function toggleAutostart(): Promise<AutostartState> {
  const state = await autostartState();
  if (state === 'unsupported') return state;
  if (state === 'on') {
    await disableAutostart();
    return 'off';
  }
  await enableAutostart();
  return (await autostartState()) === 'on' ? 'on' : 'off';
}
