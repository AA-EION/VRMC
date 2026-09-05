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
import { copyFile, mkdir, rm } from 'node:fs/promises';
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
    // The last 40 lines, not the last 4.
    //
    // Four was enough for a linker error and useless for a compiler one: a
    // swiftc diagnostic ends with the source line, a caret and a doc link, so
    // the tail showed the code and the URL while the sentence saying what was
    // wrong scrolled off. A release failed on that, and the log said only
    // which two lines were involved.
    const detail = err?.stderr || err?.stdout || err?.message || String(err);
    console.warn(`  ! ${command} failed:\n${String(detail).trim().split('\n').slice(-40).join('\n')}`);
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

  const tray = await buildSwift('vrmc-tray', ['macos/main.swift']);
  // The dashboard is the window; the tray is the icon. Neither is required for
  // MIDI, and one failing must not take the other with it.
  const dashboard = await buildSwift('vrmc-dashboard', ['macos/dashboard/main.swift']);
  return tray && dashboard;
}

/**
 * Compile one Swift executable, universal.
 *
 * Two invocations and a `lipo`, because swiftc takes a single `-target`. It is
 * worth the second compile: a helper missing the architecture it is asked to
 * run on does not fail loudly — the tray icon simply never appears, or the
 * dashboard window never opens, with nothing said anywhere.
 *
 * A slice that will not build is not fatal on its own. A machine can be missing
 * the other architecture's SDK stubs, and a build that runs natively is far
 * better than no build at all; what gets shipped is whatever slices exist, and
 * the release workflow asserts that both are present.
 */
async function buildSwift(name, sources) {
  const slices = [];
  for (const arch of ['arm64', 'x86_64']) {
    const sliceOut = join(outDir, `${name}-${arch}`);
    // -O rather than -Onone: these are released binaries, and the difference in
    // launch time is the difference between the window being there when the
    // user looks and appearing a moment later.
    const built = await run('swiftc', [
      '-O',
      '-target',
      `${arch}-apple-macosx${MACOS_DEPLOYMENT_TARGET}`,
      ...sources.map((source) => join(here, source)),
      '-o',
      sliceOut,
    ]);
    if (built !== null) slices.push(sliceOut);
    else console.warn(`  ! ${name}: no ${arch} slice`);
  }
  if (slices.length === 0) return false;

  const out = join(outDir, name);
  if (slices.length === 1) {
    // One architecture is a working binary on that architecture. Copying it
    // rather than lipo'ing keeps the single-slice case from depending on lipo
    // at all.
    await rm(out, { force: true });
    await copyFile(slices[0], out);
  } else if ((await run('lipo', ['-create', ...slices, '-output', out])) === null) {
    return false;
  }
  for (const slice of slices) await rm(slice, { force: true });
  console.log(`  -> ${out}${slices.length === 2 ? ' (universal)' : ` (${slices.length} slice)`}`);
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
