// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain JS build tooling, deliberately untyped.
import { isNestedCode, signBundle, signingPlan, verifyBundle } from '../build/codesign.mjs';

/**
 * Ad-hoc signing the app bundle.
 *
 * `codesign` does not exist on this machine and the bundle it signs is built on
 * a macOS runner, so what is tested here is the part that decides *what gets
 * signed and in what order* — because that is the part that fails silently.
 * `codesign` will happily sign a bundle before its nested code and say nothing;
 * only `--verify` ever mentions it, and by then the artifact is published.
 */

/** A realistic listing of the assembled bundle. */
const BUNDLE = [
  'Contents/Info.plist',
  'Contents/MacOS/vrmc-bridge',
  'Contents/MacOS/vrmc-tray',
  'Contents/MacOS/midi.node',
  'Contents/MacOS/node_datachannel.node',
  'Contents/MacOS/koffi.node',
  'Contents/Resources/vrmc.icns',
];

describe('what needs its own signature', () => {
  it('signs every loadable binary', () => {
    // The addons are Mach-O code even though they are not executables, and an
    // unsigned one inside a quarantined bundle is a hard failure on Apple
    // Silicon rather than a warning.
    expect(isNestedCode('Contents/MacOS/midi.node')).toBe(true);
    expect(isNestedCode('Contents/Frameworks/libthing.dylib')).toBe(true);
    expect(isNestedCode('Contents/MacOS/vrmc-tray')).toBe(true);
  });

  it('leaves resources to the bundle seal', () => {
    /*
     * An .icns carries no signature of its own — it is sealed by the bundle's.
     * Asking codesign to sign a picture fails the build for no reason, which is
     * a good way to make somebody delete the signing step.
     */
    expect(isNestedCode('Contents/Resources/vrmc.icns')).toBe(false);
    expect(isNestedCode('Contents/Info.plist')).toBe(false);
  });
});

describe('the order', () => {
  it('signs the bundle last, always', () => {
    /*
     * The whole point. A signature seals what is under it, so signing the
     * bundle before its nested code means the next nested signature
     * invalidates the bundle's — and nothing says so until a user downloads it.
     */
    const plan = signingPlan(BUNDLE);
    expect(plan.at(-1)).toBe('');
    expect(plan.filter((p: string) => p === '')).toHaveLength(1);
  });

  it('signs deeper code before shallower', () => {
    const plan = signingPlan([
      'Contents/MacOS/vrmc-bridge',
      'Contents/Frameworks/Helper.app/Contents/MacOS/helper',
      'Contents/Frameworks/libthing.dylib',
    ]);
    const depth = (p: string): number => p.split('/').length;
    const nested = plan.slice(0, -1) as string[];
    for (let i = 1; i < nested.length; i++) {
      expect(depth(nested[i]!)).toBeLessThanOrEqual(depth(nested[i - 1]!));
    }
  });

  it('covers every binary in the bundle and nothing else', () => {
    const plan = signingPlan(BUNDLE);
    expect(new Set(plan)).toEqual(
      new Set([
        'Contents/MacOS/vrmc-bridge',
        'Contents/MacOS/vrmc-tray',
        'Contents/MacOS/midi.node',
        'Contents/MacOS/node_datachannel.node',
        'Contents/MacOS/koffi.node',
        '',
      ]),
    );
  });

  it('is stable, so two runs produce the same plan', () => {
    // A plan that reorders itself between runs makes a diff of the build log
    // useless for working out what changed.
    const shuffled = [...BUNDLE].reverse();
    expect(signingPlan(BUNDLE)).toEqual(signingPlan(shuffled));
  });

  it('still signs the bundle when there is no nested code at all', () => {
    expect(signingPlan(['Contents/Info.plist'])).toEqual(['']);
  });
});

describe('the codesign invocation', () => {
  /** Record what would have been run. */
  function recorder(): { calls: string[][]; run: (c: string, a: string[]) => Promise<void> } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (command, args) => {
        calls.push([command, ...args]);
      },
    };
  }

  it('replaces signatures rather than adding to them', async () => {
    /*
     * Several of these arrive already signed: pkg signs the executable it
     * produced, swiftc ad-hoc signs the tray helper as it links it, and a
     * prebuilt addon may carry the signature of whoever built it. A bundle
     * signed by two parties validates as neither, so --force is what makes them
     * one.
     */
    const { calls, run } = recorder();
    await signBundle('/tmp/VRMC Bridge.app', BUNDLE, { run });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe('codesign');
      expect(call).toContain('--force');
    }
  });

  it('signs ad-hoc by default, and takes a real identity when there is one', async () => {
    const adHoc = recorder();
    await signBundle('/tmp/app.app', ['Contents/MacOS/x'], { run: adHoc.run });
    expect(adHoc.calls[0]).toContain('-');

    // The day a Developer ID exists, this is the only thing that changes.
    const real = recorder();
    await signBundle('/tmp/app.app', ['Contents/MacOS/x'], {
      run: real.run,
      identity: 'Developer ID Application: EION Studios',
    });
    expect(real.calls[0]).toContain('Developer ID Application: EION Studios');
  });

  it('asks for no timestamp', async () => {
    // An ad-hoc signature cannot be timestamped, and asking for one reaches
    // Apple's timestamp server — which fails on an offline or rate-limited
    // runner, turning a working build into a red release.
    const { calls, run } = recorder();
    await signBundle('/tmp/app.app', ['Contents/MacOS/x'], { run });
    expect(calls[0]).toContain('--timestamp=none');
  });

  it('does not use --deep to sign', async () => {
    /*
     * Apple deprecated it, and it papers over the ordering question this whole
     * module exists to answer — it signs nested code in an order it chooses,
     * and quietly does nothing for code it does not recognise as nested.
     */
    const { calls, run } = recorder();
    await signBundle('/tmp/app.app', BUNDLE, { run });
    for (const call of calls) expect(call).not.toContain('--deep');
  });

  it('targets each path under the bundle, and the bundle itself', async () => {
    const { calls, run } = recorder();
    await signBundle('/tmp/VRMC Bridge.app', ['Contents/MacOS/midi.node'], { run });
    expect(calls[0]!.at(-1)).toBe('/tmp/VRMC Bridge.app/Contents/MacOS/midi.node');
    expect(calls[1]!.at(-1)).toBe('/tmp/VRMC Bridge.app');
  });

  it('verifies strictly and deeply, which is where a bad order is caught', async () => {
    // --deep is wrong for signing and right for verifying: this is the only
    // step that actually checks the inside-out order held.
    const { calls, run } = recorder();
    await verifyBundle('/tmp/app.app', { run });
    expect(calls[0]).toEqual([
      'codesign',
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      '/tmp/app.app',
    ]);
  });
});
