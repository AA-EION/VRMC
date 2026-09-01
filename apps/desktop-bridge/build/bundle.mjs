// SPDX-License-Identifier: GPL-3.0-only

/**
 * Bundle the bridge into a single CommonJS file for packaging.
 *
 * CJS rather than ESM because the packager snapshots a CommonJS module graph;
 * an ESM entry would be loaded from disk at runtime, which defeats the point of
 * a single file.
 *
 * The native addons are deliberately left external. They are `.node` binaries
 * that cannot be bundled into JavaScript at all — they are copied next to the
 * executable instead and resolved at runtime.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'build/out/bridge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Keep names: the MIDI backends probe for functions by name through FFI.
  keepNames: true,
  // node-datachannel is external for the same reason, and additionally because
  // its loader picks a platform package by inspecting the running system —
  // logic a bundler would have to resolve at build time and cannot.
  external: ['@julusian/midi', 'koffi', 'node-datachannel'],
  /*
   * Give `import.meta.url` a real value in the CommonJS output.
   *
   * esbuild otherwise replaces `import.meta` with `{}` when the format is cjs,
   * which turns `createRequire(import.meta.url)` into `createRequire(undefined)`
   * — and with it every native addon load. The bundle's own path is what the
   * addon resolution should be relative to, so that is what it gets.
   */
  define: {
    'import.meta.url': '__vrmcBundleUrl',
  },
  banner: {
    js: [
      '/* VRMC bridge — GPL-3.0-only. https://github.com/AA-EION/VRMC */',
      "const __vrmcBundleUrl = require('node:url').pathToFileURL(__filename).href;",
    ].join('\n'),
  },
  logLevel: 'info',
});
