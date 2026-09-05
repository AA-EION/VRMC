// SPDX-License-Identifier: GPL-3.0-only

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Loading the compiled addons.
 *
 * `require`, not `await import()`, and the difference is not academic. The
 * released bridge is a single executable produced by pkg, whose snapshot is
 * CommonJS and carries no dynamic-import callback: every `import()` of a native
 * module inside it fails with "A dynamic import callback was not specified".
 * The same code run from source works perfectly, which is why this survived
 * until someone ran the packaged binary — at which point the bridge had no
 * MIDI and no WebRTC, and said so only as "this host may have no MIDI
 * sequencer".
 *
 * A bare `require` is not enough either. Inside a packaged build the bundle
 * lives at a virtual path, so pkg resolves a bare name against the snapshot and
 * never looks at the real filesystem — it says so itself, and asks for an
 * absolute path. The addons are staged beside the executable, so that is where
 * this looks first when packaged.
 *
 * `import.meta.url` is replaced by the bundler with the real path of the
 * bundle, so the ordinary resolution below works the same from source. See
 * build/bundle.mjs.
 */
const requireModule = createRequire(import.meta.url);

/**
 * True when running inside a pkg snapshot.
 *
 * pkg sets `process.pkg`, and the virtual `/snapshot` prefix on `__dirname` is
 * the same signal from the other direction. Either is enough; both is cheap.
 */
function isPackaged(): boolean {
  return (
    (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined ||
    process.execPath.length > 0 && __vrmcSnapshot()
  );
}

/** Whether this bundle is running from pkg's virtual filesystem. */
function __vrmcSnapshot(): boolean {
  try {
    return requireModule.resolve('./native.js').startsWith('/snapshot');
  } catch {
    return false;
  }
}

/**
 * Where a packaged build stages its addons.
 *
 * Two places, because a macOS `.app` cannot use the obvious one. Everywhere
 * else the addons sit beside the executable; inside a bundle they sit in
 * `Contents/Resources`, one level up and across, because `Contents/MacOS`
 * means *executables* to macOS and `codesign` refuses to seal a bundle with
 * ordinary files in there. See build/package.mjs.
 *
 * Both are tried rather than branching on platform: the layout is a fact about
 * the build that produced this binary, not about the machine running it, and a
 * missing addon is expensive enough to be worth one extra failed `require`.
 */
export function stagedPaths(moduleName: string): string[] {
  const parts = ['node_modules', ...moduleName.split('/')];
  const beside = dirname(process.execPath);
  return [join(beside, ...parts), join(beside, '..', 'Resources', ...parts)];
}

/** Why the last `requireNative` call failed, for reporting. */
export class NativeLoadError extends Error {
  constructor(
    readonly moduleName: string,
    cause: unknown,
  ) {
    super(
      `could not load the native module "${moduleName}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'NativeLoadError';
  }
}

/**
 * Load a native addon, or throw `NativeLoadError`.
 *
 * Throws rather than returning null on purpose. A missing addon is the
 * difference between a working bridge and one that silently does nothing, so
 * the reason has to reach a log — callers that can carry on without it catch
 * this and say what they lost.
 */
export function requireNative<T>(moduleName: string): T {
  // The staged copy first when packaged, because a bare name resolves into the
  // snapshot and fails there; the bare name first otherwise, so a checkout uses
  // its own node_modules rather than whatever sits beside the node binary.
  const candidates = isPackaged()
    ? [...stagedPaths(moduleName), moduleName]
    : [moduleName, ...stagedPaths(moduleName)];

  // The first attempt's error is the one worth keeping. The fallback fails
  // with a bare "Cannot find module <name>", which says nothing; the first
  // says what the module itself could not find — its platform binary, say —
  // and reporting the wrong one sent a diagnosis off for an hour.
  let first: unknown;
  for (const candidate of candidates) {
    try {
      return requireModule(candidate) as T;
    } catch (err) {
      if (first === undefined) first = err;
    }
  }
  throw new NativeLoadError(moduleName, first);
}

/**
 * The module, unwrapped if the addon exports itself under `default`.
 *
 * Whether a native addon arrives wrapped depends on how it declares itself and
 * on how it is being loaded, so both shapes have to be accepted.
 */
export function unwrapDefault<T extends object>(mod: T | { default: T }): T {
  const wrapped = mod as { default?: T };
  return wrapped.default !== undefined ? wrapped.default : (mod as T);
}
