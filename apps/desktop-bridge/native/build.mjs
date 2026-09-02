// SPDX-License-Identifier: GPL-3.0-only

/**
 * Compile the tray helper for the machine this runs on.
 *
 * Only for the host platform, and deliberately so: these are native GUI
 * binaries against AppKit and the Win32 shell, so unlike the prebuilt addons
 * there is nothing to select and copy — they have to be compiled where they
 * will run. That is what the release workflow's per-OS matrix is for.
 *
 * Nothing here is fatal. A missing toolchain means no tray icon, which is a
 * cosmetic loss: the bridge runs headless and the dashboard still works. So
 * this reports what it could not do and exits 0, rather than failing a build
 * over an icon.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACOS_DEPLOYMENT_TARGET } from './target.mjs';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'build');

/** Run a command, returning its output or null if it failed. */
async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      cwd: here,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
    return `${stdout}${stderr}`;
  } catch (err) {
    const detail = err?.stderr || err?.stdout || err?.message || String(err);
    console.warn(`  ! ${command} failed: ${String(detail).trim().split('\n').slice(-4).join('\n')}`);
    return null;
  }
}

async function buildMacOS() {
  const swift = await run('swiftc', ['--version']);
  if (swift === null) {
    console.warn('  ! swiftc not found; install the Xcode command line tools');
    return false;
  }

  /*
   * Refuse an SDK that cannot build what we target.
   *
   * swiftc's own message for this ("deployment target is newer than SDK") is
   * clear enough, but it arrives after a compile and among other output. The
   * cause is always the same and always environmental — a runner image or an
   * Xcode a version behind — so it is worth naming before anything is built.
   */
  const sdk = await run('xcrun', ['--sdk', 'macosx', '--show-sdk-version']);
  const sdkVersion = sdk === null ? '' : sdk.trim();
  if (sdkVersion !== '' && Number.parseFloat(sdkVersion) < Number.parseFloat(MACOS_DEPLOYMENT_TARGET)) {
    console.warn(
      `  ! the macOS ${sdkVersion} SDK cannot build for macOS ${MACOS_DEPLOYMENT_TARGET};` +
        ' install Xcode 26 or build on a macos-26 runner',
    );
    return false;
  }

  const out = join(outDir, 'vrmc-tray');
  // -O rather than -Onone: this is a released binary, and the difference in
  // launch time is the difference between the icon being there when the user
  // looks and appearing a moment later.
  const result = await run('swiftc', [
    '-O',
    '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx${MACOS_DEPLOYMENT_TARGET}`,
    join(here, 'macos/main.swift'),
    '-o',
    out,
  ]);
  if (result === null) return false;
  console.log(`  -> ${out}`);
  return true;
}

async function buildWindows() {
  // rc.exe and cl.exe are only on PATH inside a Developer Command Prompt. The
  // release workflow enters one with vcvars64.bat; locally, running this
  // outside one is the usual reason it does nothing.
  //
  // Probed with `where` rather than by running them: rc.exe answers `/?` with
  // a non-zero status, so using its exit code would report a perfectly good
  // toolchain as missing.
  for (const tool of ['rc.exe', 'cl.exe']) {
    if ((await run('where.exe', [tool])) === null) {
      console.warn(`  ! ${tool} not found; run this from a Developer Command Prompt`);
      return false;
    }
  }
  const res = join(outDir, 'tray.res');
  const compiled = await run('rc.exe', ['/nologo', `/fo${res}`, join(here, 'windows/tray.rc')]);
  if (compiled === null) return false;

  const out = join(outDir, 'vrmc-tray.exe');
  const built = await run('cl.exe', [
    '/nologo',
    '/O2',
    '/W3',
    join(here, 'windows/tray.c'),
    res,
    `/Fe:${out}`,
    // No colon after /Fo: unlike /Fe, that spelling is undocumented. The
    // trailing separator is what makes it a directory rather than a filename.
    `/Fo${outDir}${sep}`,
    '/link',
    // GUI subsystem, so launching it never flashes a console window. stdin and
    // stdout still work: the parent hands us pipes regardless of subsystem.
    '/SUBSYSTEM:WINDOWS',
    'user32.lib',
    'shell32.lib',
  ]);
  if (built === null) return false;
  console.log(`  -> ${out}`);
  return true;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

console.log(`Building the tray helper for ${process.platform}-${process.arch}`);
let ok = false;
if (process.platform === 'darwin') ok = await buildMacOS();
else if (process.platform === 'win32') ok = await buildWindows();
else console.log('  no tray helper for this platform; the bridge runs headless');

if (!ok && process.platform !== 'linux') {
  console.warn('  the bridge will run without a tray icon');
}
// Always succeed: see the note at the top.
void existsSync(outDir);
