// SPDX-License-Identifier: GPL-3.0-only

import { requireNative } from '../native.js';

/**
 * Does this build have the native pieces it needs?
 *
 * Worth a flag of its own because the failure is invisible from outside. A
 * packaged bridge whose addons did not load starts cleanly, prints its
 * listening addresses, shows a pairing code — and then silently cannot open a
 * MIDI port or accept a headset. It looks like a network problem from every
 * angle except this one.
 *
 * `--check` is what the release workflow runs against the artifact it just
 * built, and what to ask a user to run when nothing is working.
 */

export interface NativeCheck {
  name: string;
  /** What it is for, in the user's terms. */
  purpose: string;
  ok: boolean;
  detail: string;
  /** False when this build can do its job without it. */
  required: boolean;
}

/**
 * The addons this platform needs.
 *
 * koffi is Windows-only: it is the FFI used to reach the teVirtualMIDI driver,
 * and it has nothing to do on a system with CoreMIDI or ALSA.
 */
function expected(): Array<Omit<NativeCheck, 'ok' | 'detail'>> {
  const checks = [
    { name: '@julusian/midi', purpose: 'virtual MIDI ports', required: true },
    { name: 'node-datachannel', purpose: 'connecting to a headset', required: true },
  ];
  if (process.platform === 'win32') {
    checks.push({ name: 'koffi', purpose: 'the Windows MIDI driver', required: true });
  }
  return checks;
}

/** Try to load each addon and report what happened. */
export function checkNativeModules(): NativeCheck[] {
  return expected().map((check) => {
    try {
      requireNative(check.name);
      return { ...check, ok: true, detail: '' };
    } catch (err) {
      return {
        ...check,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/** Render the checks as lines, and say whether the build is usable. */
export function formatChecks(checks: readonly NativeCheck[]): {
  lines: string[];
  ok: boolean;
} {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => {
    const label = c.name.padEnd(width);
    return c.ok
      ? `  ok    ${label}  ${c.purpose}`
      : `  FAIL  ${label}  ${c.purpose}\n        ${c.detail.split('\n')[0]}`;
  });
  return { lines, ok: checks.every((c) => c.ok || !c.required) };
}
