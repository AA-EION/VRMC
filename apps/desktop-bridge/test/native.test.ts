// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { stagedPaths } from '../src/native.js';

/**
 * Where a packaged build looks for its native addons.
 *
 * Worth testing on its own because of what breaking it looks like: not a crash
 * and not a failed build, but a bridge that starts cleanly, prints its
 * addresses, shows a pairing code, and can open no MIDI port and accept no
 * headset. That has shipped from this repo once already.
 *
 * These are pure path joins against `process.execPath`, so the test sets that
 * and reads the answer — no filesystem, and it runs the same on any platform,
 * which matters because the layout being checked is macOS-only and no macOS
 * machine is involved in running the suite.
 */
const REAL_EXEC_PATH = process.execPath;

function pretendExecutableIsAt(path: string): void {
  Object.defineProperty(process, 'execPath', { value: path, configurable: true });
}

afterEach(() => pretendExecutableIsAt(REAL_EXEC_PATH));

describe('finding the staged addons', () => {
  it('looks beside the executable, which is where a zip build puts them', () => {
    pretendExecutableIsAt('/opt/vrmc/vrmc-bridge');
    expect(stagedPaths('node-datachannel')[0]).toBe('/opt/vrmc/node_modules/node-datachannel');
  });

  it('also looks in Contents/Resources, which is where a .app puts them', () => {
    /*
     * Not beside the executable, and that is not a preference. `Contents/MacOS`
     * means executables to macOS, and `codesign` enforces it: sealing a bundle
     * with a node_modules tree in there fails on the first .gyp or .md it
     * reaches, with "code object is not signed at all". Nothing can sign a
     * .gyp, so the tree lives in Resources and this is how it is found.
     */
    pretendExecutableIsAt('/Applications/VRMC Bridge.app/Contents/MacOS/vrmc-bridge');
    const resolved = stagedPaths('@julusian/midi').map((p) => p.replace(/\/[^/]+\/\.\.\//, '/'));
    expect(resolved).toContain(
      '/Applications/VRMC Bridge.app/Contents/Resources/node_modules/@julusian/midi',
    );
  });

  it('splits a scoped package into its two path segments', () => {
    // `@julusian/midi` is a directory inside a directory on disk, not a file
    // with a slash in its name — join() would happily produce either.
    pretendExecutableIsAt('/opt/vrmc/vrmc-bridge');
    expect(stagedPaths('@julusian/midi')[0]).toBe(
      join('/opt/vrmc', 'node_modules', '@julusian', 'midi'),
    );
  });

  it('offers the bundle layout as well as the flat one, never instead of it', () => {
    /*
     * Both, always. Which layout a binary was built into is a fact about the
     * build, not about the machine running it, so branching on
     * `process.platform` here would be asking the wrong question — and the cost
     * of trying both is one `require` that throws.
     */
    pretendExecutableIsAt('/opt/vrmc/vrmc-bridge');
    const paths = stagedPaths('koffi');
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe('/opt/vrmc/node_modules/koffi');
    expect(dirname(paths[1]!)).toContain('Resources');
  });
});
