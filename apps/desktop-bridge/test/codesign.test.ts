// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain JS build tooling, deliberately untyped.
import {
  isNestedCode,
  signBundle,
  signingPlan,
  unsignableEntries,
  verifyBundle,
} from '../build/codesign.mjs';

/**
 * Ad-hoc signing the app bundle.
 *
 * `codesign` does not exist on this machine and the bundle it signs is built on
 * a macOS runner, so what is tested here is the part that decides *what gets
 * signed and in what order* — because that is the part that fails silently.
 * `codesign` will happily sign a bundle before its nested code and say nothing;
 * only `--verify` ever mentions it, and by then the artifact is published.
 */

/**
 * A listing of the assembled bundle, taken from a real build log.
 *
 * The `node_modules` entries are the point. An earlier fixture here was the
 * idealised bundle — a flat `Contents/MacOS` with four binaries in it — and it
 * passed every test below while the real thing failed on the runner, because
 * packaging stages the addons' own dependency trees underneath and those are
 * several hundred `.js`, `.h`, `.gypi` and `.md` files. A fixture that omits
 * the awkward half of the input tests the easy half of the code.
 */
const BUNDLE = [
  'Contents/Info.plist',
  'Contents/MacOS/vrmc-bridge',
  'Contents/MacOS/vrmc-tray',
  'Contents/MacOS/midi.node',
  'Contents/MacOS/node_datachannel.node',
  'Contents/MacOS/koffi.node',
  'Contents/MacOS/prebuilds/midi-darwin-arm64/node-napi-v7.node',
  'Contents/MacOS/node_modules/tslib/tslib.js',
  'Contents/MacOS/node_modules/tslib/README.md',
  'Contents/MacOS/node_modules/node-addon-api/napi.h',
  'Contents/MacOS/node_modules/node-addon-api/common.gypi',
  'Contents/MacOS/node_modules/node-datachannel/package.json',
  'Contents/MacOS/node_modules/detect-libc/LICENSE',
  'Contents/Resources/vrmc.icns',
];

/** Everything in BUNDLE that genuinely needs its own signature. */
const SIGNABLE = [
  'Contents/MacOS/vrmc-tray',
  'Contents/MacOS/midi.node',
  'Contents/MacOS/node_datachannel.node',
  'Contents/MacOS/koffi.node',
  'Contents/MacOS/prebuilds/midi-darwin-arm64/node-napi-v7.node',
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

  it('signs an addon staged in a subdirectory', () => {
    // The MIDI prebuild is copied to `prebuilds/<platform>/` rather than beside
    // the executable, so a rule that only looked at Contents/MacOS directly
    // would leave the one addon that opens MIDI ports unsigned.
    expect(isNestedCode('Contents/MacOS/prebuilds/midi-darwin-arm64/node-napi-v7.node')).toBe(
      true,
    );
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

  it('does not sign the addons\' own dependency trees', () => {
    /*
     * This is the bug the flat fixture hid. `Contents/MacOS` is executables by
     * definition of the bundle format — the *directory* is, and the tree
     * beneath it is not. Packaging stages tslib, node-addon-api and detect-libc
     * under there, and a rule of "starts with Contents/MacOS/" signed every
     * README and header in them, one `codesign` process each, before failing.
     */
    expect(isNestedCode('Contents/MacOS/node_modules/tslib/README.md')).toBe(false);
    expect(isNestedCode('Contents/MacOS/node_modules/node-addon-api/napi.h')).toBe(false);
    expect(isNestedCode('Contents/MacOS/node_modules/node-addon-api/common.gypi')).toBe(false);
    expect(isNestedCode('Contents/MacOS/node_modules/node-datachannel/package.json')).toBe(false);
    expect(isNestedCode('Contents/MacOS/node_modules/tslib/tslib.js')).toBe(false);
  });

  it('leaves the main executable to the bundle', () => {
    /*
     * The trap. `codesign` given the path of a bundle's CFBundleExecutable does
     * not sign that file — it signs the enclosing bundle. So listing it as
     * nested code signs the whole app partway through the plan, before the rest
     * of the nested code exists in signed form, and the bundle signature that
     * follows is sealing over work that was not done yet.
     *
     * On the runner it did not even get that far: signing the bundle early made
     * codesign walk the whole thing, and it failed there. The message named a
     * directory of symlinks and said nothing about ordering.
     */
    expect(isNestedCode('Contents/MacOS/vrmc-bridge')).toBe(false);
    // It is only special because the plist says so. A helper with any other
    // name beside it is ordinary nested code.
    expect(isNestedCode('Contents/MacOS/vrmc-bridge', 'something-else')).toBe(true);
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
      'Contents/MacOS/vrmc-tray',
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
    expect(new Set(plan)).toEqual(new Set([...SIGNABLE, '']));
  });

  it('runs one codesign per binary, not one per file', () => {
    /*
     * Fourteen entries in, five of them code. The failing build ran a codesign
     * process against every file it had staged — around three hundred of them,
     * a few seconds of runner time to attach signatures to text files that
     * cannot carry one meaningfully and that a copy would strip anyway.
     */
    expect(signingPlan(BUNDLE)).toHaveLength(SIGNABLE.length + 1);
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

describe('what codesign will not look at', () => {
  it('finds the build tooling that fails the whole app', () => {
    /*
     * The real one. pnpm leaves `pkg-prebuilds-copy` and `pkg-prebuilds-verify`
     * shell shims in `@julusian/midi/node_modules/.bin`, packaging copied the
     * package wholesale, and codesign refused the entire bundle over them —
     * with a sentence that names the directory and explains nothing.
     */
    expect(
      unsignableEntries([
        'Contents/MacOS/midi.node',
        'Contents/MacOS/node_modules/@julusian/midi/node_modules/.bin/pkg-prebuilds-copy',
        'Contents/MacOS/node_modules/@julusian/midi/node_modules/.tmp/scratch',
      ]),
    ).toEqual([
      'Contents/MacOS/node_modules/@julusian/midi/node_modules/.bin/pkg-prebuilds-copy',
      'Contents/MacOS/node_modules/@julusian/midi/node_modules/.tmp/scratch',
    ]);
  });

  it('passes a bundle that has none', () => {
    expect(unsignableEntries(BUNDLE)).toEqual([]);
  });

  it('does not fire on a file that merely looks like one', () => {
    // The segment has to be the whole directory name — a package legitimately
    // called `dotbin` or a file named `x.bin` is not build tooling.
    expect(unsignableEntries(['Contents/MacOS/node_modules/dotbin/index.js'])).toEqual([]);
    expect(unsignableEntries(['Contents/Resources/firmware.bin'])).toEqual([]);
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
