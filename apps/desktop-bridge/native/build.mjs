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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const out = join(outDir, 'vrmc-tray');
  // -O rather than -Onone: this is a released binary, and the difference in
  // launch time is the difference between the icon being there when the user
  // looks and appearing a moment later.
  const result = await run('swiftc', [
    '-O',
    // The status item API is stable well below the current SDK, and pinning the
    // floor keeps the helper usable on the same macOS versions as the bridge.
    '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx11.0`,
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
  // CI job sets that up with microsoft/setup-msbuild plus vcvarsall; locally,
  // running this outside one is the usual reason it does nothing.
  const rc = await run('rc.exe', ['/?']);
  if (rc === null) {
    console.warn('  ! rc.exe not found; run this from a Developer Command Prompt');
    return false;
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
    `/Fo:${join(outDir, '')}`,
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
