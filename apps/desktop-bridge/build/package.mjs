// SPDX-License-Identifier: GPL-3.0-only

/**
 * Build distributable bridges for macOS, Windows and Linux.
 *
 * Two things make this more than "run a packager":
 *
 * 1. **Native addons cannot be embedded.** `@julusian/midi`, `koffi` and
 *    `node-datachannel` are compiled `.node` binaries. They are copied next to
 *    the executable and loaded from there at runtime.
 *
 * 2. **They are also platform specific.** The MIDI and FFI addons ship
 *    prebuilds for every platform in a single install, so one machine can
 *    assemble every target for those. `node-datachannel` does not: its addons
 *    are separate optional packages, and a package manager installs only the
 *    one matching the machine it runs on. So a complete build has to happen on
 *    the OS it targets, which is what the release workflow does. Either way
 *    nothing is compiled here — binaries are only selected and copied.
 *
 * A macOS `.app` is assembled by hand: it is a directory with an `Info.plist`
 * and the executable under `Contents/MacOS`, and it is ad-hoc signed once
 * everything is in place — see `codesign.mjs` for why that is not optional on
 * Apple Silicon. It is still quarantined on download; ad-hoc signing changes
 * the refusal from "damaged" to the ordinary unidentified-developer prompt,
 * which is a thing a person can get past. See docs/PACKAGING.md.
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, rm, writeFile, chmod, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { infoPlist } from './infoPlist.mjs';
import { signBundle, unsignableEntries, verifyBundle } from './codesign.mjs';

const exec = promisify(execCb);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outRoot = join(root, 'build/dist');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version ?? '0.0.0';

/**
 * Targets to build. `pkg` names the Node build; `slug` names the output.
 *
 * Node 22 rather than 20, because pkg-fetch publishes no `node20-win-x64` base
 * binary — the download 404s, pkg silently falls back to compiling Node from
 * source, and that fails on a runner with no C++ toolchain configured for it.
 * Every node22 base exists for every platform here, and 22 is the LTS the
 * project builds and tests on anyway.
 *
 * If a target ever 404s again the symptom is the same: a long build that ends
 * in a compiler error rather than a download error. `assertBaseAvailable` below
 * turns that back into the truth.
 */
const TARGETS = [
  { slug: 'macos-arm64', pkg: 'node22-macos-arm64', platform: 'darwin', arch: 'arm64' },
  /*
   * Buildable, but not released.
   *
   * The app targets macOS 26, and the Intel Macs that run macOS 26 are a
   * handful of late models. An Intel slice built to that floor would reach
   * almost nobody, and one built to a lower floor would be a second product
   * with a different set of APIs available to it. It stays here because the
   * packaging works and someone may want it locally; the release workflow does
   * not ask for it.
   */
  { slug: 'macos-x64', pkg: 'node22-macos-x64', platform: 'darwin', arch: 'x64' },
  { slug: 'windows-x64', pkg: 'node22-win-x64', platform: 'win32', arch: 'x64' },
  { slug: 'linux-x64', pkg: 'node22-linux-x64', platform: 'linux', arch: 'x64' },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = only.length > 0 ? TARGETS.filter((t) => only.includes(t.slug)) : TARGETS;

/**
 * Locate a package's directory, following pnpm's symlinks.
 *
 * `from` is the manifest to resolve relative to. It matters under pnpm, whose
 * strict layout only links a package's *own* dependencies beside it: a
 * transitive optional package is invisible from the workspace root and has to
 * be looked for from the package that depends on it.
 */
async function resolvePackageDir(name, from = join(root, 'package.json')) {
  const require = (await import('node:module')).createRequire(from);
  try {
    // Resolve the manifest rather than the entry point: the entry may be
    // nested in dist/ and we want the package root.
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Packages with an `exports` map may not expose their manifest at all, so
    // fall back to the entry point and walk up to the root that declares it.
    try {
      let dir = dirname(require.resolve(name));
      for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, 'package.json'))) {
          const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
          if (manifest.name === name) return dir;
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    } catch {
      // Not installed on this machine.
    }
    return null;
  }
}

/**
 * Copy the prebuilt addon for one platform.
 *
 * `@julusian/midi` lays its prebuilds out as `prebuilds/midi-<platform>-<arch>`.
 * Returns true if one was found — a missing prebuild is reported rather than
 * silently producing a binary that cannot open a MIDI port.
 */
/**
 * Should this path be left out of the staged copy?
 *
 * `node_modules/.bin` is the one that matters. pnpm fills it with shell shims
 * for a package's build-time tools — `pkg-prebuilds-copy` and
 * `pkg-prebuilds-verify` under `@julusian/midi` — which resolve relative to a
 * store layout the stage does not have, and which nothing here would run
 * anyway: the bridge shells out to no dependency.
 *
 * They are not merely dead weight. `codesign` walks the whole bundle when it
 * seals it, treats that directory as a subcomponent, and refuses the entire
 * app with "bundle format unrecognized, invalid, or unsuitable" — naming the
 * `.bin` directory and nothing about why. That failed a release.
 */
function isBuildDetritus(src) {
  const name = basename(src);
  return name === '.bin' || name === '.tmp' || name === '.package-lock.json';
}

/** `fs.cp` filter form of the above: keep everything that is not detritus. */
const keepRuntimeFiles = (src) => !isBuildDetritus(src);

async function copyMidiPrebuild(target, destDir) {
  const dir = await resolvePackageDir('@julusian/midi');
  if (dir === null) return false;
  const prebuilds = join(dir, 'prebuilds');
  if (!existsSync(prebuilds)) return false;

  const wanted = `midi-${target.platform}-${target.arch}`;
  const available = await readdir(prebuilds);
  const match = available.find((d) => d === wanted);
  if (match === undefined) {
    console.warn(`  ! no prebuild ${wanted} (have: ${available.join(', ')})`);
    return false;
  }

  const pkgDest = join(destDir, 'node_modules/@julusian/midi');
  await mkdir(dirname(pkgDest), { recursive: true });

  /*
   * The whole package, minus the prebuilds for other platforms.
   *
   * Copied wholesale rather than file by file. A hand-written list of the
   * package's internals is a list that rots: one written against an earlier
   * version omitted `load-native.js`, and the result was a build that staged
   * the addon, looked complete, and failed at the first require — reporting
   * itself as a machine with no MIDI system.
   *
   * The exclusion is worth keeping, though: the other platforms' binaries are
   * the bulk of the package and none of them can run here.
   */
  const prebuildRoot = join(dir, 'prebuilds');
  await cp(dir, pkgDest, {
    recursive: true,
    filter: (src) =>
      src !== prebuildRoot && !src.startsWith(prebuildRoot + sep) && keepRuntimeFiles(src),
  });

  // The one prebuild this target needs, in both places its loader may look:
  // inside the package, and beside the executable.
  for (const root of [join(pkgDest, 'prebuilds'), join(destDir, 'prebuilds')]) {
    await mkdir(root, { recursive: true });
    await cp(join(prebuilds, match), join(root, match), { recursive: true });
  }

  // Its own dependencies, which it requires the moment it is loaded.
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const seen = new Set(['@julusian/midi']);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await stageDependencies(
      dependency,
      join(dir, 'package.json'),
      join(destDir, 'node_modules'),
      seen,
    );
  }
  return true;
}

/**
 * Copy a package and the runtime dependencies it needs to load.
 *
 * The addons are not self-contained: `@julusian/midi` requires `tslib` and
 * `pkg-prebuilds` at load time, and `node-datachannel` requires `detect-libc`.
 * Staging the addon without them produces a build that fails at the first
 * `require` with a message naming a package nobody has heard of — which is
 * exactly how a packaged bridge came to report itself as a machine with no
 * MIDI system.
 *
 * Walks the dependency graph rather than listing them, because the list is
 * theirs to change and a hand-maintained copy of it silently rots.
 */
async function stageDependencies(name, fromManifest, destModules, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);

  const dir = await resolvePackageDir(name, fromManifest);
  if (dir === null) {
    console.warn(`  ! ${name} is not installed; the addon may fail to load`);
    return;
  }

  const to = join(destModules, ...name.split('/'));
  if (!existsSync(to)) {
    await mkdir(dirname(to), { recursive: true });
    await cp(dir, to, { recursive: true, filter: keepRuntimeFiles });
  }

  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await stageDependencies(dependency, join(dir, 'package.json'), destModules, seen);
  }
}

/**
 * The platform package holding libdatachannel's addon for a target.
 *
 * The Linux entry assumes glibc, which every CI runner and desktop distribution
 * that matters here uses; a musl build would need the `-musl` variant.
 */
const DATACHANNEL_PACKAGE = {
  'darwin-arm64': '@node-datachannel/darwin-arm64',
  'darwin-x64': '@node-datachannel/darwin-x64',
  'win32-x64': '@node-datachannel/win32-x64-msvc',
  'win32-arm64': '@node-datachannel/win32-arm64-msvc',
  'linux-x64': '@node-datachannel/linux-x64-gnu',
  'linux-arm64': '@node-datachannel/linux-arm64-gnu',
};

/**
 * Copy node-datachannel and the addon for one platform.
 *
 * Unlike the MIDI addon, these prebuilds are separate optional packages that a
 * package manager only installs for the machine it is running on. That is why
 * the release workflow builds each target on its own runner: a Linux box simply
 * does not have the macOS binary to copy. A target packaged without it is
 * reported rather than shipped silently, because the failure it would cause —
 * a headset that can never connect — looks like a network problem, not a
 * packaging one.
 */
async function copyDataChannel(target, destDir) {
  const wanted = DATACHANNEL_PACKAGE[`${target.platform}-${target.arch}`];
  if (wanted === undefined) return false;

  const pkgDir = await resolvePackageDir('node-datachannel');
  if (pkgDir === null) return false;

  const addonDir = await resolvePackageDir(wanted, join(pkgDir, 'package.json'));
  if (addonDir === null) {
    console.warn(`  ! ${wanted} is not installed; skipping the WebRTC addon`);
    return false;
  }

  const modules = join(destDir, 'node_modules');
  await mkdir(modules, { recursive: true });
  for (const file of ['package.json', 'dist']) {
    await cp(join(pkgDir, file), join(modules, 'node-datachannel', file), { recursive: true });
  }
  // Only this platform's addon: the other eight are a hundred megabytes of
  // binaries for machines that will never run this build.
  await cp(addonDir, join(modules, wanted), { recursive: true, filter: keepRuntimeFiles });

  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  const seen = new Set(['node-datachannel', wanted]);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await stageDependencies(dependency, join(pkgDir, 'package.json'), modules, seen);
  }
  return true;
}

/**
 * Copy the tray helper, if one was built for this platform.
 *
 * Built by `native/build.mjs` on the machine that runs it — unlike the addons
 * there is nothing to select, because these are native GUI binaries against
 * AppKit and the Win32 shell and have to be compiled where they will run.
 *
 * Its absence is not an error. The bridge runs headless without it: no menu
 * bar icon, everything else working, which is a far better outcome than a
 * build that fails over an icon.
 */
async function copyTrayHelper(target, destDir) {
  if (target.platform !== process.platform || target.arch !== process.arch) return false;
  const name = target.platform === 'win32' ? 'vrmc-tray.exe' : 'vrmc-tray';
  const built = join(root, 'native/build', name);
  if (!existsSync(built)) return false;
  const to = join(destDir, name);
  await cp(built, to);
  if (target.platform !== 'win32') await chmod(to, 0o755);
  return true;
}

/**
 * Copy koffi, the FFI used to reach the Windows teVirtualMIDI driver.
 *
 * Windows-only: on macOS and Linux the MIDI addon talks to CoreMIDI and ALSA
 * directly and there is nothing for an FFI to do.
 */
async function copyKoffi(target, destDir) {
  // Windows needs it to reach the teVirtualMIDI driver; macOS needs it to
  // publish the endpoint identity through CoreMIDI. Linux needs neither, and
  // staging an FFI with nothing to call is dead weight in the download.
  if (target.platform !== 'win32' && target.platform !== 'darwin') return false;
  const dir = await resolvePackageDir('koffi');
  if (dir === null) {
    console.warn('  ! koffi is not installed');
    return false;
  }
  await cp(dir, join(destDir, 'node_modules/koffi'), {
    recursive: true,
    filter: keepRuntimeFiles,
  });

  /*
   * koffi's actual binary lives in a separate package, exactly as
   * node-datachannel's does: `@koromix/koffi-win32-x64` and friends, resolved
   * from koffi's own manifest. Copying koffi alone stages a loader with
   * nothing to load.
   */
  const platformPackage = `@koromix/koffi-${target.platform}-${target.arch}`;
  const addonDir = await resolvePackageDir(platformPackage, join(dir, 'package.json'));
  if (addonDir === null) {
    console.warn(`  ! ${platformPackage} is not installed`);
    return false;
  }
  await cp(addonDir, join(destDir, 'node_modules', ...platformPackage.split('/')), {
    recursive: true,
    filter: keepRuntimeFiles,
  });

  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const seen = new Set(['koffi', platformPackage]);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await stageDependencies(
      dependency,
      join(dir, 'package.json'),
      join(destDir, 'node_modules'),
      seen,
    );
  }
  return true;
}

/**
 * The packager's own entry point.
 *
 * Run through `process.execPath` rather than through a shell shim: the shim is
 * `pkg.CMD` on Windows and `pkg` elsewhere, and going straight to the
 * JavaScript sidesteps both that and whatever happens to be on PATH.
 */
async function pkgBinary() {
  const dir = await resolvePackageDir('@yao-pkg/pkg');
  if (dir === null) {
    throw new Error('@yao-pkg/pkg is not installed; run pnpm install');
  }
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pkg;
  if (entry === undefined) throw new Error('@yao-pkg/pkg declares no bin entry');
  return join(dir, entry);
}

/**
 * Confirm the packager can actually get a base binary for this target.
 *
 * pkg's own failure mode here is genuinely misleading: a 404 on the base binary
 * is not fatal to it, so it falls back to compiling Node from source, and the
 * error that eventually surfaces is a compiler complaint about Visual Studio.
 * Two release builds were spent reading that before anyone read the 404 three
 * hundred lines above it.
 *
 * The asset is checked against the release rather than against pkg-fetch's own
 * manifest, because the manifest is not the truth: it lists
 * `node-v20.20.2-win-x64`, which is exactly the binary that 404s. Only the
 * release knows what was published.
 */
async function assertBaseAvailable(target) {
  // Resolved from pkg's own manifest, not the bridge's: pkg-fetch is pkg's
  // dependency, and under pnpm's layout it is invisible from anywhere else.
  // Getting that wrong makes this check silently pass on everything.
  const pkgDir = await resolvePackageDir('@yao-pkg/pkg');
  const dir =
    pkgDir === null
      ? null
      : await resolvePackageDir('@yao-pkg/pkg-fetch', join(pkgDir, 'package.json'));
  if (dir === null) return;

  let shas;
  let version;
  try {
    shas = JSON.parse(await readFile(join(dir, 'lib-es5/expected-shas.json'), 'utf8'));
    version = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return; // Not something to fail a build over; pkg will say its piece.
  }

  // `node22-win-x64` -> the `node-v22.x.y-win-x64` asset that carries it.
  const parsed = /^node(\d+)-(.+)$/.exec(target.pkg);
  if (parsed === null) return;
  const [, major, platform] = parsed;
  const name = Object.keys(shas).find(
    (k) => k.startsWith(`node-v${major}.`) && k.endsWith(`-${platform}`),
  );
  if (name === undefined) {
    throw new Error(`pkg-fetch knows no base binary named for ${target.pkg}`);
  }

  // The release tag is the first two fields of pkg-fetch's own version.
  const [tagMajor, tagMinor] = String(version).split('.');
  const url = `https://github.com/yao-pkg/pkg-fetch/releases/download/v${tagMajor}.${tagMinor}/${name}`;

  let status;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
  } catch {
    // Offline, or a proxy in the way. Say nothing and let pkg try: a network
    // problem here is not evidence about what was published.
    return;
  }

  if (status === 404) {
    throw new Error(
      `pkg-fetch has no ${name} in v${tagMajor}.${tagMinor}, so ${target.pkg} cannot be built ` +
        'without compiling Node from source. Pick a Node major that is published for this platform.',
    );
  }
}

async function buildTarget(target) {
  await assertBaseAvailable(target);
  const stage = join(outRoot, `vrmc-bridge-${VERSION}-${target.slug}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const exeName = target.platform === 'win32' ? 'vrmc-bridge.exe' : 'vrmc-bridge';
  // A .app puts the executable inside the bundle; everything else sits at the
  // top level of the folder the user unzips.
  const appDir =
    target.platform === 'darwin' ? join(stage, 'VRMC Bridge.app/Contents') : null;
  const exeDir = appDir === null ? stage : join(appDir, 'MacOS');

  /*
   * Where the staged addons go, which on macOS is NOT beside the executable.
   *
   * `Contents/MacOS` does not mean "next to the program" to macOS. It means
   * executables, and `codesign` enforces that literally: sealing the bundle, it
   * treats every file in there as a code object that must already carry its own
   * signature. Stage `node_modules` in it and sealing fails with
   *
   *     VRMC Bridge.app: code object is not signed at all
   *     In subcomponent: .../@julusian/midi/binding.gyp
   *
   * naming whichever ordinary text file it reached first. There is no way to
   * satisfy that — `codesign` will not sign a .gyp — so the tree has to live
   * somewhere the bundle format expects data. `Contents/Resources` is that
   * place: its contents are sealed wholesale into CodeResources, and the .node
   * binaries inside it still get their own signatures. It is where Electron
   * puts unpacked native modules, for the same reason.
   *
   * Off macOS there is no bundle and everything sits beside the executable.
   */
  const libDir = appDir === null ? stage : join(appDir, 'Resources');
  await mkdir(exeDir, { recursive: true });
  await mkdir(libDir, { recursive: true });

  console.log(`\n== ${target.slug} ==`);
  await exec(
    [
      // The pinned dependency, resolved directly, rather than `npx --yes`
      // fetching whatever is newest. A different pkg brings a different
      // pkg-fetch, which knows a different set of Node base binaries — and the
      // first Windows release build spent ten minutes discovering that by
      // trying to compile Node from source.
      JSON.stringify(process.execPath),
      JSON.stringify(await pkgBinary()),
      JSON.stringify(join(root, 'build/out/bridge.cjs')),
      `--targets ${target.pkg}`,
      `--output ${JSON.stringify(join(exeDir, exeName))}`,
      '--public',
    ].join(' '),
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );

  const hasMidi = await copyMidiPrebuild(target, libDir);
  const hasKoffi = await copyKoffi(target, libDir);
  const hasRtc = await copyDataChannel(target, libDir);
  // The tray helper is a real executable, so it does belong in Contents/MacOS.
  const hasTray = await copyTrayHelper(target, exeDir);

  /*
   * Refuse to produce a build that cannot work.
   *
   * These were warnings, and every one of them was ignored: a build shipped
   * with no MIDI and no WebRTC while the console said so in yellow and the
   * exit status said everything was fine. A missing addon is not a degraded
   * build, it is a bridge that starts up and does nothing, so it fails here.
   *
   * The tray helper is the one genuine warning. Losing it costs the menu bar
   * icon and nothing else — the bridge still carries MIDI, which is what it is
   * for. The release workflow asserts it separately, where the toolchain to
   * build one is supposed to exist.
   */
  const missing = [];
  if (!hasMidi) missing.push('the MIDI addon (@julusian/midi): it could open no ports');
  if (!hasRtc) missing.push('the WebRTC addon (node-datachannel): no headset could pair');
  if (target.platform === 'win32' && !hasKoffi) {
    missing.push('koffi: the Windows MIDI driver could not be reached');
  }
  if (missing.length > 0) {
    throw new Error(
      `${target.slug} is missing ${missing.length === 1 ? 'a native library' : 'native libraries'}:\n` +
        missing.map((m) => `    - ${m}`).join('\n'),
    );
  }
  if (!hasTray && target.platform !== 'linux') {
    console.warn(`  ! ${target.slug} has no tray helper; run \`pnpm tray\` first`);
  }

  if (appDir !== null) {
    await writeFile(join(appDir, 'Info.plist'), infoPlist(VERSION), 'utf8');
    // The icon is what Finder shows in Applications and what the Get Info
    // panel uses. The menu bar draws its own, so this is never seen there.
    const icns = join(root, '../../assets/icon/vrmc.icns');
    if (existsSync(icns)) {
      await mkdir(join(appDir, 'Resources'), { recursive: true });
      await cp(icns, join(appDir, 'Resources/vrmc.icns'));
    }
    await chmod(join(exeDir, exeName), 0o755);
    // Last, and it has to be last: a signature seals what is under it, so
    // anything written into the bundle afterwards invalidates it.
    await signApp(join(stage, 'VRMC Bridge.app'));
  } else if (target.platform !== 'win32') {
    await chmod(join(exeDir, exeName), 0o755);
  }

  await cp(join(root, '../../LICENSE'), join(stage, 'LICENSE'));
  await writeFile(join(stage, 'README.txt'), readmeFor(target), 'utf8');
  console.log(`  -> ${stage}`);
}


/**
 * Ad-hoc sign the assembled bundle.
 *
 * Skipped, loudly, where `codesign` does not exist — which is every machine
 * that is not a Mac. A macOS build can be *assembled* anywhere (the addons all
 * ship prebuilds), and there is no reason to make that impossible; but a build
 * produced that way must not be handed to anybody, because it is the exact
 * build that says "damaged". The release workflow runs on macOS and verifies
 * the signature afterwards, so the artifact people actually download cannot
 * reach them this way.
 */
async function signApp(appPath) {
  if (!(await hasCodesign())) {
    console.warn(
      '  ! codesign is not available, so "VRMC Bridge.app" is unsigned.\n' +
        '    It will report itself as damaged on Apple Silicon. Build on macOS to release.',
    );
    return;
  }

  const entries = await listBundle(appPath);

  const unsignable = unsignableEntries(entries);
  if (unsignable.length > 0) {
    throw new Error(
      'The bundle contains build tooling that codesign cannot classify, and it ' +
        'would refuse the whole app with "bundle format unrecognized, invalid, ' +
        'or unsuitable" while naming only the directory:\n' +
        unsignable.map((e) => `  ${e}`).join('\n') +
        '\nExclude it where it is staged — see isBuildDetritus above.',
    );
  }

  const run = (command, args) =>
    exec(`${command} ${args.map((a) => JSON.stringify(a)).join(' ')}`);

  await signBundle(appPath, entries, { run, log: (line) => console.log(line) });
  await verifyBundle(appPath, { run });
  console.log('  signed ad-hoc and verified');
}

/** Every path inside the bundle, relative to it. */
async function listBundle(appPath) {
  const out = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      // Symlinks are not followed and not signed: a bundle that contains one
      // has it sealed by the enclosing signature, and following it would leave
      // the walk somewhere outside the bundle entirely.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else out.push(relative);
    }
  };
  await walk(appPath, '');
  return out;
}

let codesignAvailable = null;
async function hasCodesign() {
  if (codesignAvailable !== null) return codesignAvailable;
  try {
    await exec('command -v codesign');
    codesignAvailable = true;
  } catch {
    codesignAvailable = false;
  }
  return codesignAvailable;
}

function readmeFor(target) {
  const run =
    target.platform === 'win32'
      ? [
          'Run the installer (VRMC-Setup.msi) if you have one; it puts VRMC in',
          'Program Files and starts it at login.',
          '',
          'Otherwise run vrmc-bridge.exe directly. Look for the VRMC icon in the',
          'notification area, which shows the pairing code to type in the headset.',
        ].join('\n')
      : target.platform === 'darwin'
        ? [
            'Drag "VRMC Bridge.app" to your Applications folder, then open it.',
            '',
            'That is the whole installation. It has no window: look for the VRMC',
            'icon in the menu bar, which shows the pairing code to type in the',
            'headset. Opening it also sets it to start at login, which you can',
            'turn off from the same menu.',
            '',
            'The first time you open it, macOS will say Apple cannot verify it.',
            'That is expected: this build is signed ad-hoc rather than with a',
            'paid Developer ID, so it is not notarised.',
            '',
            'Open it once and let it be blocked, then go to System Settings >',
            'Privacy & Security and press "Open Anyway" next to the message',
            'about VRMC. Right-clicking and choosing Open no longer works as a',
            'bypass on macOS 15 and later.',
            '',
            'If it instead says the app is *damaged*, the download lost its',
            'signature somewhere. Clear the quarantine flag and open it again:',
            '',
            '  xattr -dr com.apple.quarantine "/Applications/VRMC Bridge.app"',
          ].join('\n')
        : 'Run ./vrmc-bridge from a terminal.';

  return [
    `VRMC Bridge ${VERSION} (${target.slug})`,
    '',
    'Virtual MIDI bridge for the VRMC mixed-reality controller.',
    '',
    run,
    '',
    'Open the VRMC site in the headset and type the six-character pairing code —',
    'that is the whole setup. Devices are created from the headset; MIDI ports',
    'appear and disappear on this computer as you add and remove them.',
    '',
    'GPL-3.0-only. See LICENSE.',
    'Launchpad protocol details derive from CoreFW:',
    'https://github.com/anthonyhfm/launchpad-core-firmware',
  ].join('\n');
}

await rm(outRoot, { recursive: true, force: true });
for (const target of targets) {
  await buildTarget(target);
}
console.log(`\nDone. Output in ${outRoot}`);
