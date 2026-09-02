// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain JS build tooling, deliberately untyped.
import { infoPlist } from '../build/infoPlist.mjs';
// @ts-expect-error -- plain JS build tooling, deliberately untyped.
import { MACOS_DEPLOYMENT_TARGET } from '../native/target.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error -- plain JS build tooling, deliberately untyped.
import { buildFragment, walk } from '../build/installer/fragment.mjs';

/**
 * The installer's file manifest.
 *
 * WiX is not installed on most machines and cannot run at all on the Linux CI
 * job, so the MSI itself is built only on the Windows runner. What is tested
 * here is the part that decides *which files go in* — because a bug there
 * produces an installer that builds cleanly, installs without complaint, and
 * is missing the MIDI binding.
 */

/** The shape build/package.mjs actually produces for Windows. */
const STAGED = [
  'vrmc-bridge.exe',
  'vrmc-tray.exe',
  'LICENSE',
  'README.txt',
  'prebuilds/midi-win32-x64/node-napi-v8.node',
  'node_modules/@julusian/midi/package.json',
  'node_modules/@julusian/midi/dist/index.js',
  'node_modules/koffi/index.js',
  'node_modules/koffi/build/koffi/win32_x64/koffi.node',
  'node_modules/node-datachannel/package.json',
  'node_modules/node-datachannel/dist/cjs/lib/index.cjs',
  'node_modules/@node-datachannel/win32-x64-msvc/node_datachannel.node',
  'node_modules/detect-libc/lib/detect-libc.js',
];

describe('the macOS app bundle', () => {
  const plist = infoPlist('1.2.3');

  /** Value of a `<key>k</key><string>v</string>` pair. */
  const value = (key: string): string | null => {
    const at = plist.indexOf(`<key>${key}</key>`);
    if (at < 0) return null;
    const match = /<string>([^<]*)<\/string>/.exec(plist.slice(at));
    return match?.[1] ?? null;
  };
  const isTrue = (key: string): boolean =>
    new RegExp(`<key>${key}</key>\\s*<true/>`).test(plist);

  it('declares the same macOS floor the helper is compiled against', () => {
    // Compiled against one version and declared as another is how an app
    // launches on a system and then calls a symbol that is not there.
    expect(value('LSMinimumSystemVersion')).toBe(MACOS_DEPLOYMENT_TARGET);
  });

  it('is a menu bar app, not a background-only one', () => {
    // LSBackgroundOnly forbids all UI, status item included, so the icon would
    // simply never appear and the bridge would have no interface at all.
    expect(isTrue('LSUIElement')).toBe(true);
    // The comment beside the key names it; the key itself must be absent.
    expect(plist).not.toContain('<key>LSBackgroundOnly</key>');
  });

  it('explains why it wants the local network, since macOS quotes it', () => {
    const reason = value('NSLocalNetworkUsageDescription') ?? '';
    expect(reason).toMatch(/headset/i);
    expect(reason.length).toBeGreaterThan(20);
  });

  it('opts out of App Nap, which would throttle MIDI', () => {
    expect(isTrue('NSAppSleepDisabled')).toBe(true);
  });

  it('runs the bridge, not the tray helper', () => {
    expect(value('CFBundleExecutable')).toBe('vrmc-bridge');
    expect(value('CFBundleIdentifier')).toBe('studio.eion.vrmc.bridge');
    expect(value('CFBundleShortVersionString')).toBe('1.2.3');
  });

  it('is parseable XML', () => {
    // Cheap structural check: every tag opened is closed, in order.
    const stack: string[] = [];
    for (const match of plist.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      const [, closing, name, selfClosing] = match;
      if (name === undefined || name === 'xml' || name === '!DOCTYPE') continue;
      if (selfClosing === '/') continue;
      if (closing === '/') expect(stack.pop()).toBe(name);
      else stack.push(name);
    }
    expect(stack).toEqual([]);
  });
});

describe('the installer file manifest', () => {
  const xml: string = buildFragment(STAGED);

  it('includes every staged file', () => {
    for (const file of STAGED) {
      const windowsPath = file.replace(/\//g, '\\');
      expect(xml).toContain(`$(var.SourceDir)\\${windowsPath}`);
    }
  });

  it('gives each file its own component', () => {
    // One component per file is what lets an upgrade replace files
    // individually and an uninstall remove exactly what it installed.
    const components = xml.match(/<Component /g) ?? [];
    expect(components).toHaveLength(STAGED.length);
    const keyPaths = xml.match(/KeyPath="yes"/g) ?? [];
    expect(keyPaths).toHaveLength(STAGED.length);
  });

  it('declares nested directories inside their parents', () => {
    // The addons are several levels deep. A flat declaration would put
    // koffi.node directly in the install folder, where its loader never
    // looks — an installer that works until the first Windows MIDI call.
    const deep = xml.indexOf('dir_node_modules_koffi_build_koffi_win32_x64');
    const parent = xml.indexOf('dir_node_modules_koffi_build');
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(deep).toBeGreaterThan(parent);

    // Its closing tag comes after the child's, i.e. it encloses it.
    const tail = xml.slice(deep);
    expect(tail).toContain('</Directory>');
  });

  it('names each directory by its own segment, not its path', () => {
    expect(xml).toContain('Name="win32_x64"');
    expect(xml).toContain('Name="node_modules"');
    expect(xml).not.toContain('Name="node_modules/koffi"');
  });

  it('declares every directory exactly once', () => {
    // `node_modules` is the parent of four separate branches. Declaring it
    // per branch would produce duplicate directory ids and fail the build.
    const declarations = xml.match(/<Directory Id="dir_node_modules"/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it('produces ids WiX will accept', () => {
    // Identifiers may only hold letters, digits, underscores and periods —
    // and a path separator or a dash in a package name would silently produce
    // an invalid one.
    for (const id of xml.match(/Id="([^"]+)"/g) ?? []) {
      const value = id.slice(4, -1);
      if (value.startsWith('$')) continue;
      expect(value).toMatch(/^[A-Za-z_][A-Za-z0-9_.]*$/);
    }
  });

  it('is well-formed enough to nest correctly', () => {
    const opens = (xml.match(/<Directory /g) ?? []).length;
    const closes = (xml.match(/<\/Directory>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('escapes a directory name that would break the XML', () => {
    const odd = buildFragment(['a&b/c.txt']);
    expect(odd).toContain('Name="a&amp;b"');
  });

  it('handles a flat build with no subdirectories', () => {
    const flat = buildFragment(['vrmc-bridge.exe', 'LICENSE']);
    expect(flat).toContain('<Component Id="cmp_0" Directory="INSTALLFOLDER"');
    expect(flat).not.toContain('<Directory ');
  });
});

describe('harvesting a staged build', () => {
  it('walks the tree and returns relative paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vrmc-stage-'));
    try {
      for (const file of STAGED) {
        const full = join(dir, file);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, 'x');
      }
      const found: string[] = await walk(dir);
      expect(found.sort()).toEqual([...STAGED].sort());
      // Forward slashes regardless of platform: buildFragment converts them,
      // and mixing separators is how a path stops matching.
      expect(found.every((f) => !f.includes('\\'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
