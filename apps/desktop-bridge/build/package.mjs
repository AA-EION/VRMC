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
 * and the executable under `Contents/MacOS`. Note that an unsigned app is
 * quarantined by Gatekeeper on download — see docs/PACKAGING.md.
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, rm, writeFile, chmod, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execCb);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outRoot = join(root, 'build/dist');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version ?? '0.0.0';

/** Targets to build. `pkg` names the Node build; `slug` names the output. */
const TARGETS = [
  { slug: 'macos-arm64', pkg: 'node20-macos-arm64', platform: 'darwin', arch: 'arm64' },
  { slug: 'macos-x64', pkg: 'node20-macos-x64', platform: 'darwin', arch: 'x64' },
  { slug: 'windows-x64', pkg: 'node20-win-x64', platform: 'win32', arch: 'x64' },
  { slug: 'linux-x64', pkg: 'node20-linux-x64', platform: 'linux', arch: 'x64' },
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
    filter: (src) => src !== prebuildRoot && !src.startsWith(prebuildRoot + sep),
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
    await cp(dir, to, { recursive: true });
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

  const libDir = await resolvePackageDir('node-datachannel');
  if (libDir === null) return false;

  const addonDir = await resolvePackageDir(wanted, join(libDir, 'package.json'));
  if (addonDir === null) {
    console.warn(`  ! ${wanted} is not installed; skipping the WebRTC addon`);
    return false;
  }

  const modules = join(destDir, 'node_modules');
  await mkdir(modules, { recursive: true });
  for (const file of ['package.json', 'dist']) {
    await cp(join(libDir, file), join(modules, 'node-datachannel', file), { recursive: true });
  }
  // Only this platform's addon: the other eight are a hundred megabytes of
  // binaries for machines that will never run this build.
  await cp(addonDir, join(modules, wanted), { recursive: true });

  const manifest = JSON.parse(await readFile(join(libDir, 'package.json'), 'utf8'));
  const seen = new Set(['node-datachannel', wanted]);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await stageDependencies(dependency, join(libDir, 'package.json'), modules, seen);
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

/** Copy koffi's prebuilt binding for a platform. Windows-only in practice. */
async function copyKoffi(target, destDir) {
  if (target.platform !== 'win32') return false;
  const dir = await resolvePackageDir('koffi');
  if (dir === null) return false;
  await cp(dir, join(destDir, 'node_modules/koffi'), { recursive: true });
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

async function buildTarget(target) {
  const stage = join(outRoot, `vrmc-bridge-${VERSION}-${target.slug}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const exeName = target.platform === 'win32' ? 'vrmc-bridge.exe' : 'vrmc-bridge';
  // A .app puts the executable inside the bundle; everything else sits at the
  // top level of the folder the user unzips.
  const appDir =
    target.platform === 'darwin' ? join(stage, 'VRMC Bridge.app/Contents') : null;
  const exeDir = appDir === null ? stage : join(appDir, 'MacOS');
  await mkdir(exeDir, { recursive: true });

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
      // Fail rather than fall back to building Node from source. That fallback
      // needs a full C++ toolchain, takes tens of minutes, and on a runner
      // without one fails anyway — long after the real problem, which is a
      // base binary that could not be downloaded.
      '--no-native-build',
      '--public',
    ].join(' '),
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );

  const hasMidi = await copyMidiPrebuild(target, exeDir);
  await copyKoffi(target, exeDir);
  const hasRtc = await copyDataChannel(target, exeDir);
  const hasTray = await copyTrayHelper(target, exeDir);
  if (!hasMidi) {
    console.warn(`  ! ${target.slug} has no MIDI addon; it will run but open no ports`);
  }
  if (!hasRtc) {
    console.warn(`  ! ${target.slug} has no WebRTC addon; a headset cannot pair with it`);
  }
  if (!hasTray && target.platform !== 'linux') {
    console.warn(`  ! ${target.slug} has no tray helper; run \`pnpm tray\` first`);
  }

  if (appDir !== null) {
    await writeFile(join(appDir, 'Info.plist'), infoPlist(), 'utf8');
    // The icon is what Finder shows in Applications and what the Get Info
    // panel uses. The menu bar draws its own, so this is never seen there.
    const icns = join(root, '../../assets/icon/vrmc.icns');
    if (existsSync(icns)) {
      await mkdir(join(appDir, 'Resources'), { recursive: true });
      await cp(icns, join(appDir, 'Resources/vrmc.icns'));
    }
    await chmod(join(exeDir, exeName), 0o755);
  } else if (target.platform !== 'win32') {
    await chmod(join(exeDir, exeName), 0o755);
  }

  await cp(join(root, '../../LICENSE'), join(stage, 'LICENSE'));
  await writeFile(join(stage, 'README.txt'), readmeFor(target), 'utf8');
  console.log(`  -> ${stage}`);
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>VRMC Bridge</string>
  <key>CFBundleDisplayName</key><string>VRMC Bridge</string>
  <key>CFBundleIdentifier</key><string>studio.eion.vrmc.bridge</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>vrmc-bridge</string>
  <key>CFBundleIconFile</key><string>vrmc.icns</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!--
    LSUIElement, not LSBackgroundOnly.

    Both hide the Dock tile, but LSBackgroundOnly forbids any user interface at
    all — including the status item, which simply never appears. LSUIElement is
    the tray-only policy: a menu bar item, no Dock icon, no application menu,
    and no window that could steal focus from the DAW.
  -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
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
            'macOS will refuse to open it the first time if this build is',
            'unsigned. Right-click the app and choose Open, then confirm.',
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
