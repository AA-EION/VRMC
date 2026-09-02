// SPDX-License-Identifier: GPL-3.0-only

/**
 * Ad-hoc code signing for the macOS app bundle.
 *
 * WHY THE APP SAID "DAMAGED"
 * Not because anything was damaged. On Apple Silicon every Mach-O binary must
 * carry a valid signature to execute at all — the kernel refuses to map an
 * unsigned one — and when Gatekeeper finds a quarantined bundle whose code it
 * cannot validate, the message it shows is "damaged and can't be opened. You
 * should move it to the Bin." It is the same dialog you would get for a
 * genuinely corrupt download, which is why it sends people looking for a
 * corrupt download.
 *
 * `@yao-pkg/pkg` already ad-hoc signs the executable it produces, so the bridge
 * binary itself was fine. What was not signed was everything assembled around
 * it: the `@julusian/midi`, `koffi` and `node-datachannel` addons and the Swift
 * tray helper are all copied in *after* that, and the bundle they sit in was
 * never sealed. A bundle with unsigned nested code is a bundle Gatekeeper
 * cannot validate.
 *
 * WHAT AD-HOC SIGNING DOES AND DOES NOT BUY
 * It is a signature with no identity behind it — `codesign --sign -`. It makes
 * the code loadable and the bundle internally consistent, which is what turns
 * "damaged" into the ordinary "Apple could not verify this app is free of
 * malware" dialog. It is *not* notarisation: a downloaded build is still
 * quarantined and still needs one deliberate approval from the person
 * installing it. That is a real limitation and the README says so plainly
 * rather than implying the warning has gone away.
 *
 * The alternative is a Developer ID certificate and a notarisation round trip,
 * which needs a paid Apple account and secrets in CI. When that exists, only
 * `identity` below changes — the order of operations is the same.
 *
 * ORDER MATTERS, AND IT IS THE THING MOST EASILY GOT WRONG
 * A signature seals everything beneath it, so signing has to run inside-out:
 * every nested binary first, the bundle last. Sign the bundle first and the
 * next nested signature invalidates it — silently, because `codesign` is
 * perfectly happy to sign things in the wrong order and only `--verify` ever
 * mentions it. `signingPlan` below is that ordering, and it is a pure function
 * so it can be tested without a Mac.
 *
 * `--deep` is deliberately not used. Apple deprecated it, and it papers over
 * exactly the ordering question this file is about.
 */

import { BUNDLE_EXECUTABLE } from './infoPlist.mjs';

/** Extensions that are Mach-O code even though they are not executables. */
const CODE_EXTENSIONS = ['.node', '.dylib', '.so'];

/** Where a bundle keeps its executables. */
const MACOS_DIR = 'Contents/MacOS/';

/**
 * Is this path something `codesign` has to sign in its own right?
 *
 * Nested code is anything loadable: the addons wherever they were staged, any
 * dylib beside them, and the helper executables sitting directly next to the
 * main one. Everything else is a resource, sealed by the bundle's own
 * signature rather than carrying one — and asking `codesign` to sign a picture
 * or a README fails the build for no reason.
 *
 * TWO THINGS HERE ARE NOT OBVIOUS, AND BOTH BROKE A RELEASE
 *
 * `Contents/MacOS` is executables *by definition of the bundle format*, which
 * is true of the directory itself and emphatically not of the tree beneath it.
 * The staged addons bring their own `node_modules` — tslib, node-addon-api,
 * detect-libc — a few hundred `.js`, `.h`, `.gypi` and `.md` files that a rule
 * of "starts with Contents/MacOS/" signed one by one before failing, because
 * that prefix does not mean "is a program". So: the directory, not the subtree.
 *
 * That tree now lives in `Contents/Resources` where it belongs, and the rule
 * still has to be the narrow one — `Contents/MacOS` holds two executables
 * today and a helper dropped in beside them tomorrow should be signed, while
 * anything that ever gets staged under it should not be. The addons are caught
 * by extension wherever they are, which is the honest reason to match on one.
 *
 * And the main executable is excluded deliberately. `codesign` on the path of a
 * bundle's `CFBundleExecutable` does not sign that file — it signs the
 * enclosing bundle, which is a documented shortcut and a trap here: it means a
 * plan that lists it as nested code signs the whole bundle partway through,
 * before the rest of the nested code has been signed at all. The bundle's own
 * pass covers it, last, which is where it belongs.
 */
export function isNestedCode(relativePath, mainExecutable = BUNDLE_EXECUTABLE) {
  if (relativePath === MACOS_DIR + mainExecutable) return false;
  const lower = relativePath.toLowerCase();
  if (CODE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  if (!relativePath.startsWith(MACOS_DIR)) return false;
  // Directly in Contents/MacOS — not somewhere in the tree under it.
  return !relativePath.slice(MACOS_DIR.length).includes('/');
}

/**
 * The order to sign in: nested code deepest-first, then the bundle itself.
 *
 * Deepest-first among the nested files too. The addons do nest — they are
 * staged under `Contents/Resources/node_modules`, several levels down — and a
 * framework or a helper app would nest further still, so the general case is
 * worth one comparator.
 *
 * @param entries relative paths inside the bundle, in any order
 * @param mainExecutable the bundle's CFBundleExecutable, which is *not* signed
 *   on its own — see `isNestedCode`
 * @returns relative paths to sign, then `''` standing for the bundle root
 */
export function signingPlan(entries, mainExecutable = BUNDLE_EXECUTABLE) {
  const nested = entries
    .filter((entry) => isNestedCode(entry, mainExecutable))
    .sort((a, b) => {
      const byDepth = depthOf(b) - depthOf(a);
      // Depth first, then name — so the plan is stable and a diff of it is
      // readable rather than reordering itself between runs.
      return byDepth !== 0 ? byDepth : a.localeCompare(b);
    });
  // '' is the bundle. Last, always: it seals everything above.
  return [...nested, ''];
}

function depthOf(path) {
  return path.split('/').length;
}

/**
 * Sign a bundle ad-hoc, inside out.
 *
 * `run` is injected so the plan can be exercised without a Mac; in the build it
 * is `execFile`. `identity` defaults to `-`, which is what makes it ad-hoc —
 * pass a Developer ID here the day one exists and nothing else changes.
 */
export async function signBundle(
  bundlePath,
  entries,
  { run, identity = '-', log = () => {}, mainExecutable = BUNDLE_EXECUTABLE },
) {
  const plan = signingPlan(entries, mainExecutable);
  for (const relative of plan) {
    const target = relative === '' ? bundlePath : `${bundlePath}/${relative}`;
    // --force because several of these arrive already signed: pkg signs the
    // executable it produced, swiftc ad-hoc signs the tray helper as it links
    // it, and a prebuilt addon may carry the signature of whoever built it.
    // Replacing all of them with one identity is the point — a bundle signed
    // by two parties validates as neither.
    // --timestamp=none because an ad-hoc signature cannot be timestamped, and
    // asking for one reaches Apple's timestamp server and fails on an offline
    // or rate-limited runner.
    await run('codesign', ['--force', '--sign', identity, '--timestamp=none', target]);
    log(`  signed ${relative === '' ? '(bundle)' : relative}`);
  }
  return plan;
}

/** Directories that are build tooling, not part of a shipped app. */
const NOT_RUNTIME = ['.bin', '.tmp'];

/**
 * Anything in the bundle that `codesign` will refuse to look at.
 *
 * This exists because of how the refusal reads. `codesign` given a bundle with
 * a `node_modules/.bin` in it fails the *whole app* with:
 *
 *     bundle format unrecognized, invalid, or unsuitable
 *     In subcomponent: .../@julusian/midi/node_modules/.bin
 *
 * which names a directory, says nothing about what is wrong with it, and
 * attaches the complaint to whichever `codesign` call happened to be walking
 * the bundle at the time — so it reads as a fault in the binary being signed.
 * It cost a release build to work out that it meant "there is a directory of
 * shell scripts in here and I do not know what it is".
 *
 * Packaging does not stage these any more. This is the belt: if one reappears
 * — a new dependency, a changed pnpm layout — the build says which file and
 * why, instead of repeating that sentence.
 *
 * @param entries relative paths inside the bundle
 * @returns the offending paths, empty when the bundle is clean
 */
export function unsignableEntries(entries) {
  return entries.filter((entry) =>
    entry.split('/').some((segment) => NOT_RUNTIME.includes(segment)),
  );
}

/**
 * Prove the signature is real.
 *
 * `--strict` and `--deep` on *verification* — unlike on signing, where --deep
 * is deprecated — because this is the only place the inside-out order is
 * actually checked. A bundle signed in the wrong order signs without complaint
 * and fails here, which is the whole reason this runs in CI.
 */
export async function verifyBundle(bundlePath, { run }) {
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundlePath]);
}
