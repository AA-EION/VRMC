// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrayEvent } from '../src/tray/protocol.js';
import { TrayController } from '../src/tray/TrayController.js';
import { buildMenu, buildTooltip, TrayAction, type TrayState } from '../src/tray/menu.js';
import { launchTarget } from '../src/setup/autostart.js';

/**
 * The tray is the bridge's only user interface, and it is the one part that
 * cannot be seen on a CI runner. So the menu is built by a pure function and
 * asserted here row by row, and the process plumbing is exercised against a
 * stand-in helper that speaks the real protocol.
 */

const READY: TrayState = {
  pairingCode: 'K7M-2QX',
  pairingRegistered: true,
  clients: 1,
  devices: 2,
  midiReady: true,
  dashboardUrl: 'http://127.0.0.1:7401/',
  autostart: 'off',
};

function labels(state: TrayState): string[] {
  return buildMenu(state)
    .filter((i) => i.separator !== true)
    .map((i) => i.label);
}

describe('the tray menu', () => {
  it('leads with the answer to "is it working"', () => {
    expect(buildMenu(READY)[0]).toEqual({
      id: 'status',
      label: 'Connected · 2 devices',
      enabled: false,
    });
  });

  it('reports the most damaging problem first', () => {
    // No MIDI beats no headset: a connected headset is worth nothing if
    // nothing can reach the DAW.
    expect(labels({ ...READY, midiReady: false, clients: 0 })[0]).toBe(
      'No MIDI port — see the dashboard',
    );
    expect(labels({ ...READY, clients: 0 })[0]).toBe('Waiting for a headset');
  });

  it('counts one device without the plural', () => {
    expect(labels({ ...READY, devices: 1 })[0]).toBe('Connected · 1 device');
  });

  it('shows the pairing code where it can be copied', () => {
    const code = buildMenu(READY).find((i) => i.id === TrayAction.COPY_CODE);
    expect(code?.label).toBe('Pairing code  K7M-2QX');
    // Enabled, because clicking it copies. A status row would be greyed out.
    expect(code?.enabled).not.toBe(false);
  });

  it('says so when the code is not reachable', () => {
    const items = buildMenu({ ...READY, pairingRegistered: false });
    expect(items.some((i) => i.label.includes('not reachable'))).toBe(true);
  });

  it('omits the code entirely when publishing is off', () => {
    const items = buildMenu({ ...READY, pairingCode: '' });
    expect(items.some((i) => i.id === TrayAction.COPY_CODE)).toBe(false);
    // The rest of the menu still works.
    expect(items.some((i) => i.id === TrayAction.DASHBOARD)).toBe(true);
  });

  it('ticks Start at login only when it is on', () => {
    const off = buildMenu(READY).find((i) => i.id === TrayAction.AUTOSTART);
    expect(off?.checked).toBe(false);
    const on = buildMenu({ ...READY, autostart: 'on' }).find((i) => i.id === TrayAction.AUTOSTART);
    expect(on?.checked).toBe(true);
  });

  it('does not tick Start at login while macOS is still waiting for approval', () => {
    // SMAppService can accept a registration and hold it until the user allows
    // it in Settings. A tick there would promise the bridge comes back after a
    // reboot, which it does not, so the row says where to go instead.
    const items = buildMenu({ ...READY, autostart: 'approval' });
    expect(items.find((i) => i.id === TrayAction.AUTOSTART)?.checked).toBe(false);
    const note = items.find((i) => i.id === 'autostart-approval');
    expect(note?.label).toMatch(/Login Items/);
    expect(note?.enabled).toBe(false);
  });

  it('hides Start at login where it cannot be honoured', () => {
    // Offering a setting that silently does nothing is worse than not offering
    // it: the user believes the bridge will come back and it will not.
    const items = buildMenu({ ...READY, autostart: 'unsupported' });
    expect(items.some((i) => i.id === TrayAction.AUTOSTART)).toBe(false);
  });

  it('puts Quit last, behind a separator', () => {
    const items = buildMenu(READY);
    expect(items.at(-1)?.id).toBe(TrayAction.QUIT);
    expect(items.at(-2)?.separator).toBe(true);
  });

  it('keeps the tooltip inside the platform limit', () => {
    const long: TrayState = { ...READY, devices: 999 };
    // Windows truncates szTip at 128 characters, silently.
    expect(buildTooltip(long).length).toBeLessThan(128);
    expect(buildTooltip(READY)).toBe('VRMC — Connected · 2 devices');
  });
});

describe('reading helper events', () => {
  it('accepts the three shapes a helper can send', () => {
    expect(parseTrayEvent('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseTrayEvent('{"type":"click","id":"quit"}')).toEqual({ type: 'click', id: 'quit' });
    expect(parseTrayEvent('{"type":"quit"}')).toEqual({ type: 'quit' });
  });

  it('returns null rather than throwing on anything else', () => {
    // A misbehaving icon must never take down a bridge mid-performance.
    for (const line of ['', '   ', 'not json', '[]', 'null', '{"type":"click"}', '{"type":42}']) {
      expect(parseTrayEvent(line)).toBeNull();
    }
  });
});

describe('driving a helper process', () => {
  const dirs: string[] = [];
  const controllers: TrayController[] = [];

  afterEach(() => {
    for (const c of controllers.splice(0)) c.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A stand-in for the native helper.
   *
   * It speaks the real protocol over the real pipes, so this exercises the
   * framing, the line splitting and the process lifecycle — everything the
   * controller actually owns. The Swift and the C are tested by running them.
   */
  function fakeHelper(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vrmc-tray-'));
    dirs.push(dir);
    const script = join(dir, 'helper.mjs');
    writeFileSync(
      script,
      `#!/usr/bin/env node
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf('\\n');
  while (at >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    onCommand(JSON.parse(line));
    at = buffer.indexOf('\\n');
  }
});
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
${body}
`,
      { mode: 0o755 },
    );

    // Spawned by path, so it has to be executable and name its interpreter.
    const shim = join(dir, process.platform === 'win32' ? 'vrmc-tray.exe' : 'vrmc-tray');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
    chmodSync(shim, 0o755);
    return shim;
  }

  /** Point the controller at our shim by pretending it sits beside the exe. */
  function controllerFor(
    shim: string,
    events: { clicks: string[]; quits: number; logs: string[] },
  ): TrayController {
    const controller = new TrayController({
      onClick: (id) => events.clicks.push(id),
      onQuit: () => events.quits++,
      onLog: (m) => events.logs.push(m),
    });
    // The controller looks beside process.execPath; the shim is elsewhere, so
    // the lookup is redirected rather than the test copying a file into the
    // Node installation directory.
    const original = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    Object.defineProperty(process, 'execPath', { value: shim, configurable: true });
    try {
      controller.start();
    } finally {
      Object.defineProperty(process, 'execPath', original);
    }
    controllers.push(controller);
    return controller;
  }

  it('sends the menu and receives clicks', async () => {
    const events = { clicks: [] as string[], quits: 0, logs: [] as string[] };
    // Echo back a click for every row that has an id, as though the user had
    // chosen each in turn.
    const shim = fakeHelper(`
send({ type: 'ready' });
function onCommand(command) {
  if (command.type !== 'menu') return;
  for (const item of command.items) {
    if (!item.separator && item.enabled !== false) send({ type: 'click', id: item.id });
  }
}
`);
    const controller = controllerFor(shim, events);
    expect(controller.isRunning).toBe(true);

    controller.setMenu(buildTooltip(READY), buildMenu(READY));
    await vi.waitFor(() => expect(events.clicks).toContain(TrayAction.QUIT), { timeout: 5000 });
    expect(events.clicks).toEqual([
      TrayAction.COPY_CODE,
      TrayAction.DASHBOARD,
      TrayAction.AUTOSTART,
      TrayAction.QUIT,
    ]);
  });

  it('handles several events arriving in one write', async () => {
    const events = { clicks: [] as string[], quits: 0, logs: [] as string[] };
    const shim = fakeHelper(`
function onCommand() {
  // Three events in a single write, which is what a burst of clicks looks
  // like on the wire — the controller has to split them, not take the first.
  process.stdout.write(
    JSON.stringify({ type: 'click', id: 'a' }) + '\\n' +
    JSON.stringify({ type: 'click', id: 'b' }) + '\\n' +
    JSON.stringify({ type: 'quit' }) + '\\n',
  );
}
`);
    const controller = controllerFor(shim, events);
    controller.setMenu('t', []);
    await vi.waitFor(() => expect(events.quits).toBe(1), { timeout: 5000 });
    expect(events.clicks).toEqual(['a', 'b']);
  });

  it('survives a helper that dies', async () => {
    const events = { clicks: [] as string[], quits: 0, logs: [] as string[] };
    const shim = fakeHelper(`
function onCommand() { process.exit(3); }
`);
    const controller = controllerFor(shim, events);
    controller.setMenu('t', []);
    await vi.waitFor(() => expect(controller.isRunning).toBe(false), { timeout: 5000 });
    expect(events.logs.join(' ')).toContain('continuing without an icon');
    // Still callable; the bridge does not have to know the icon went away.
    expect(() => controller.setMenu('t', [])).not.toThrow();
  });

  it('reports no helper rather than failing', () => {
    const events = { clicks: [] as string[], quits: 0, logs: [] as string[] };
    const controller = new TrayController({
      onClick: (id) => events.clicks.push(id),
      onQuit: () => events.quits++,
      onLog: (m) => events.logs.push(m),
    });
    // Nothing named vrmc-tray beside the test runner's node binary.
    expect(controller.start()).toBe(false);
    expect(controller.isRunning).toBe(false);
  });
});

describe('what gets registered to start at login', () => {
  it('registers the bundle, not the executable inside it', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'execPath', {
      value: '/Applications/VRMC Bridge.app/Contents/MacOS/vrmc-bridge',
      configurable: true,
    });
    try {
      // Registering the inner executable would launch it unbundled, losing
      // Info.plist and with it LSUIElement — so it would appear in the Dock.
      expect(launchTarget()).toBe('/Applications/VRMC Bridge.app');
    } finally {
      Object.defineProperty(process, 'execPath', original);
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('registers the executable itself everywhere else', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process, 'execPath', {
      value: 'C:\\Program Files\\VRMC\\vrmc-bridge.exe',
      configurable: true,
    });
    try {
      expect(launchTarget()).toBe('C:\\Program Files\\VRMC\\vrmc-bridge.exe');
    } finally {
      Object.defineProperty(process, 'execPath', original);
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
