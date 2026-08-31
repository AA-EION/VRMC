// SPDX-License-Identifier: GPL-3.0-only

/**
 * Build distributable bridges for macOS, Windows and Linux.
 *
 * Two things make this more than "run a packager":
 *
 * 1. **Native addons cannot be embedded.** `@julusian/midi` and `koffi` are
 *    compiled `.node` binaries. They are copied next to the executable and
 *    loaded from there at runtime.
 *
 * 2. **They are also platform specific.** Fortunately both ship prebuilds for
 *    every platform in a single install, so a Linux machine already has the
 *    macOS and Windows binaries on disk and can assemble all three targets.
 *    That is cross-*packaging*, not cross-compiling — nothing is built here,
 *    only selected and copied.
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

/** Locate a package's directory, following pnpm's symlinks. */
async function resolvePackageDir(name) {
  const require = (await import('node:module')).createRequire(join(root, 'package.json'));
  try {
    // Resolve the manifest rather than the entry point: the entry may be
    // nested in dist/ and we want the package root.
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
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
  if (!hasMidi) {
    console.warn(`  ! ${target.slug} has no MIDI addon; it will run but open no ports`);
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
    'The bridge prints the address to enter in the headset. Devices are created',
    'from the headset; MIDI ports appear and disappear as you add and remove them.',
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
