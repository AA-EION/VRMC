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
import { dirname, join } from 'node:path';
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

  const to = join(destDir, 'prebuilds', match);
  await mkdir(dirname(to), { recursive: true });
  await cp(join(prebuilds, match), to, { recursive: true });
  // The loader reads these alongside the prebuild directory.
  for (const file of ['package.json', 'binding-options.js', 'index.js', 'dist']) {
    const from = join(dir, file);
    if (existsSync(from)) {
      await cp(from, join(destDir, 'node_modules/@julusian/midi', file), { recursive: true });
    }
  }
  return true;
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
  await cp(addonDir, join(modules, wanted), { recursive: true });

  // Its loader reads this to tell glibc from musl, so it has to come along.
  const libc = await resolvePackageDir('detect-libc', join(libDir, 'package.json'));
  if (libc !== null) await cp(libc, join(modules, 'detect-libc'), { recursive: true });
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
      'npx --yes @yao-pkg/pkg',
      JSON.stringify(join(root, 'build/out/bridge.cjs')),
      `--targets ${target.pkg}`,
      `--output ${JSON.stringify(join(exeDir, exeName))}`,
      '--public',
    ].join(' '),
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );

  const hasMidi = await copyMidiPrebuild(target, exeDir);
  await copyKoffi(target, exeDir);
  const hasRtc = await copyDataChannel(target, exeDir);
  if (!hasMidi) {
    console.warn(`  ! ${target.slug} has no MIDI addon; it will run but open no ports`);
  }
  if (!hasRtc) {
    console.warn(`  ! ${target.slug} has no WebRTC addon; a headset cannot pair with it`);
  }

  if (appDir !== null) {
    await writeFile(join(appDir, 'Info.plist'), infoPlist(), 'utf8');
    // LSBackgroundOnly keeps it out of the Dock; it is a background bridge with
    // no window of its own, and a bouncing icon for one would be noise.
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
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSBackgroundOnly</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

function readmeFor(target) {
  const run =
    target.platform === 'win32'
      ? 'Double-click vrmc-bridge.exe, or run it from a terminal for the log.'
      : target.platform === 'darwin'
        ? [
            'Run "VRMC Bridge.app". It has no window: it runs in the background and',
            'creates MIDI ports.',
            '',
            'macOS will refuse to open it the first time if this build is unsigned.',
            'Right-click the app and choose Open, then confirm.',
          ].join('\n')
        : 'Run ./vrmc-bridge from a terminal.';

  return [
    `VRMC Bridge ${VERSION} (${target.slug})`,
    '',
    'Virtual MIDI bridge for the VRMC mixed-reality controller.',
    '',
    run,
    '',
    'The bridge shows a six-character pairing code. Open the VRMC site in the',
    'headset and type it — that is the whole setup. Devices are created from the',
    'headset; MIDI ports appear and disappear as you add and remove them.',
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
