// SPDX-License-Identifier: GPL-3.0-only

/**
 * Build the Windows MSI.
 *
 * Runs after `build/package.mjs`, over the staged folder it produced: the
 * executable, the native addons beside it, the tray helper, and the licence.
 * The file list is harvested rather than written by hand, because the addons
 * bring a directory tree with them and a hand-maintained list is a list that
 * eventually ships without the MIDI binding in it.
 *
 * Requires the WiX toolset (`dotnet tool install --global wix`). Without it
 * this exits 0 having built nothing: the zip from the packaging step is still a
 * working download, and failing the release over an installer would hold back
 * the macOS and Linux artifacts too.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFragment, walk } from './fragment.mjs';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const repoRoot = join(root, '../..');
const distRoot = join(root, 'build/dist');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
/**
 * MSI versions are three numeric fields; a prerelease suffix is not
 * representable and would be rejected rather than ignored.
 */
const VERSION = (pkg.version ?? '0.0.0').split('-')[0];

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
      ...options,
    });
    return `${stdout}${stderr}`;
  } catch (err) {
    const detail = err?.stderr || err?.stdout || err?.message || String(err);
    console.warn(`  ! ${command} failed:\n${String(detail).trim()}`);
    return null;
  }
}

/** The staged Windows build, or null if packaging has not run. */
async function findStage() {
  if (!existsSync(distRoot)) return null;
  const entries = await readdir(distRoot, { withFileTypes: true });
  const match = entries.find((e) => e.isDirectory() && e.name.includes('windows'));
  return match === undefined ? null : join(distRoot, match.name);
}

// --- go ---

const stage = await findStage();
if (stage === null) {
  console.warn('No staged Windows build found; run `pnpm package windows-x64` first.');
  process.exit(0);
}

const wix = await run('wix', ['--version']);
if (wix === null) {
  console.warn('WiX not found (dotnet tool install --global wix); skipping the MSI.');
  process.exit(0);
}

// The licence has to be RTF for the WiX UI, which will not render Markdown or
// plain text. Wrapping it keeps one LICENSE file as the source of truth.
const licenseText = await readFile(join(repoRoot, 'LICENSE'), 'utf8');
const work = join(root, 'build/installer/out');
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fmodern Courier New;}}\\fs16\n${licenseText
  .replace(/[\\{}]/g, (c) => `\\${c}`)
  .replace(/\r?\n/g, '\\par\n')}}`;
const licenseFile = join(work, 'license.rtf');
await writeFile(licenseFile, rtf, 'ascii');

const files = (await walk(stage)).filter((f) => f !== 'README.txt');
console.log(`Harvested ${files.length} file(s) from ${relative(root, stage)}`);
const fragmentFile = join(work, 'files.wxs');
await writeFile(fragmentFile, buildFragment(files), 'utf8');

await mkdir(join(root, 'build/dist'), { recursive: true });
const output = join(root, `build/dist/VRMC-Setup-${VERSION}.msi`);

const built = await run('wix', [
  'build',
  join(here, 'vrmc.wxs'),
  fragmentFile,
  '-arch',
  'x64',
  '-ext',
  'WixToolset.UI.wixext',
  '-ext',
  'WixToolset.Util.wixext',
  '-d',
  `Version=${VERSION}`,
  '-d',
  `SourceDir=${stage}`,
  '-d',
  `IconFile=${join(repoRoot, 'assets/icon/vrmc.ico')}`,
  '-d',
  `LicenseFile=${licenseFile}`,
  '-o',
  output,
]);

if (built === null) {
  console.warn('The MSI did not build; the zip from the packaging step still works.');
  process.exit(0);
}
console.log(`  -> ${output}`);
