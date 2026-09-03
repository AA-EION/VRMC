// SPDX-License-Identifier: GPL-3.0-only

import { requireNative } from '../native.js';
import { openVirtualPort } from '../midi/coreMidiBackend.js';
import { coreMidiIdentityError, readIdentity } from '../midi/coreMidiIdentity.js';

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
 * koffi is the FFI layer, and what it is for differs by platform: on Windows
 * it reaches the teVirtualMIDI driver and nothing works without it; on macOS
 * it publishes the hardware identity on an endpoint, which is polish rather
 * than function. Linux needs it for neither.
 */
function expected(): Array<Omit<NativeCheck, 'ok' | 'detail'>> {
  const checks = [
    { name: '@julusian/midi', purpose: 'virtual MIDI ports', required: true },
    { name: 'node-datachannel', purpose: 'connecting to a headset', required: true },
  ];
  if (process.platform === 'win32') {
    checks.push({ name: 'koffi', purpose: 'the Windows MIDI driver', required: true });
  }
  if (process.platform === 'darwin') {
    checks.push({ name: 'koffi', purpose: 'publishing the device identity', required: false });
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

/**
 * Prove the endpoint identity actually reaches CoreMIDI.
 *
 * This is here rather than in the unit tests because it cannot be anywhere
 * else: no machine that runs this project's test suite has CoreMIDI, so a
 * test could only assert against a mock of the thing most likely to be wrong.
 * The failure mode it guards is silent — `MIDIObjectSetStringProperty` given a
 * property id CoreMIDI does not recognise sets *something* and returns
 * success, so a wrong constant looks exactly like a working one from the
 * inside. Only a round trip through the real framework can tell.
 *
 * `--check` runs it on macOS, which the release workflow already runs against
 * the artifact it just built.
 *
 * Not required: the identity is metadata, and a port with no manufacturer
 * still plays. It is reported rather than fatal so that losing the polish
 * cannot fail a release, while a regression is still visible in the log.
 */
export async function checkEndpointIdentity(): Promise<NativeCheck | null> {
  if (process.platform !== 'darwin') return null;

  const check = {
    name: 'CoreMIDI identity',
    purpose: 'the device identity a host reads',
    required: false,
  };

  // A name nothing else could be using, so the search cannot find somebody
  // else's port and report their metadata as ours.
  const probeName = `VRMC identity probe ${process.pid}`;
  const want = {
    name: 'LPX (DAW)',
    displayName: probeName,
    manufacturer: 'Focusrite - Novation',
    model: 'Launchpad X',
  };

  const sink = await openVirtualPort(probeName, want);
  if (sink === null) {
    return { ...check, ok: false, detail: 'could not open a probe port' };
  }
  try {
    // Read back under the *new* name: stamping renames the endpoint, which is
    // itself part of what is being verified.
    const got = readIdentity(want.name);
    if (got === null) {
      const why = coreMidiIdentityError();
      return { ...check, ok: false, detail: why === '' ? 'endpoint not found after stamping' : why };
    }
    const wrong = (['name', 'displayName', 'manufacturer', 'model'] as const).filter(
      (key) => got[key] !== want[key],
    );
    return wrong.length === 0
      ? { ...check, ok: true, detail: '' }
      : {
          ...check,
          ok: false,
          detail: wrong.map((k) => `${k}: wanted "${want[k]}", read "${got[k]}"`).join('; '),
        };
  } finally {
    sink.close();
  }
}
