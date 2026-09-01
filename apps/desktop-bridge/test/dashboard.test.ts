// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { DeviceModel } from '@vrmc/devices';
import { DeviceId, DeviceStatus, PacketKind, PacketReader, PacketWriter } from '@vrmc/protocol';
import { Router } from '../src/core/Router.js';
import { runSelfTest } from '../src/core/selfTest.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { NullSink, NullSource, SimpleVirtualPort } from '../src/midi/MidiSink.js';
import { WsServer } from '../src/net/WsServer.js';
import type { DashboardStatus } from '../src/net/dashboard.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

let nextPort = 28700;

async function serve(): Promise<{ ws: WsServer; devices: DeviceManager; port: number }> {
  const devices = new DeviceManager(
    { onLed: (...a) => ws.queueLed(...a), onRosterChange: () => {}, onLog: () => {} },
    {
      noMidi: false,
      loopbackPattern: /never/,
      portNameTemplate: '{device} {port}',
      openPort: async ({ name }) => ({
        port: new SimpleVirtualPort(name, new NullSink(name, true), new NullSource(name)),
        ok: true,
        notes: [],
      }),
    },
  );
  const router = new Router(devices, { onPong: () => ws.notePong() });
  const port = nextPort++;
  const ws = new WsServer(router, { port, host: '127.0.0.1', onLog: () => {} });
  ws.deviceCount = () => devices.count;
  ws.statusProvider = (): DashboardStatus => ({
    version: 'test',
    addresses: ['192.168.1.50'],
    wsPort: port,
    udpPort: port + 1,
    secure: false,
    clients: ws.clientCount,
    devices: devices.roster(),
    lastPacketAgoMs: router.stats.lastPacketAt === 0 ? null : Date.now() - router.stats.lastPacketAt,
    packetsIn: router.stats.packets,
    packetsOut: router.stats.packetsOut,
    eventsIn: router.stats.events,
    ledsOut: router.stats.ledsOut,
    jitterMs: router.stats.jitterMs,
    peakJitterMs: router.stats.peakJitterMs,
    lossRatio: router.stats.lossRatio,
    malformed: router.stats.malformed,
    midiAvailable: true,
    pairingCode: 'K7M-2QX',
    pairingRegistered: true,
    pairingError: '',
    siteUrl: 'https://vrmc.eionstudios.com',
    lanUrls: ['wss://192-168-1-50.lan.example.com:7401'],
  });
  ws.selfTest = (what) => runSelfTest(what, ws, devices);
  await ws.listen();
  cleanups.push(() => ws.close());
  return { ws, devices, port };
}

describe('dashboard', () => {
  it('serves the page to loopback', async () => {
    const { port } = await serve();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('VRMC BRIDGE');
    expect(body).toContain('/api/selftest');
  });

  it('never caches the page, so a restart is not served a stale one', async () => {
    const { port } = await serve();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('reports status as JSON', async () => {
    const { port, devices } = await serve();
    await devices.add(40, DeviceModel.LAUNCHPAD_X);

    const status = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as DashboardStatus;
    expect(status.wsPort).toBe(port);
    expect(status.clients).toBe(0);
    expect(status.lastPacketAgoMs).toBeNull();
    expect(status.devices).toContainEqual(
      expect.objectContaining({ deviceId: 40, status: DeviceStatus.READY }),
    );
  });

  it('answers the reachability probe to anyone', async () => {
    const { port } = await serve();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { service: string }).service).toBe('vrmc-bridge');
  });

  it('404s an unknown path rather than serving the page', async () => {
    const { port } = await serve();
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });
});

describe('audit self-tests', () => {
  const run = async (port: number, what: string): Promise<{ ok: boolean; detail: string }> =>
    (await (
      await fetch(`http://127.0.0.1:${port}/api/selftest?what=${what}`, { method: 'POST' })
    ).json()) as { ok: boolean; detail: string };

  it('reports a missing headset rather than hanging', async () => {
    const { port } = await serve();
    const result = await run(port, 'headset');
    expect(result).toEqual({ ok: false, detail: 'no headset connected' });
  });

  it('rejects an unknown test', async () => {
    const { port } = await serve();
    expect((await run(port, 'nonsense')).ok).toBe(false);
  });

  it('proves the round trip when a headset answers', async () => {
    const { port } = await serve();

    // Stand in for the headset: reply to the bridge's PING with a PONG, which
    // is what the client's link layer does.
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((r) => client.once('open', r));
    const reader = new PacketReader();
    client.on('message', (data: Buffer) => {
      if (reader.read(data, null) !== 0) return;
      if (reader.header.kind !== PacketKind.PING) return;
      const w = new PacketWriter();
      w.begin(PacketKind.PONG);
      client.send(w.finish(reader.header.tClient).slice());
    });

    const result = await run(port, 'headset');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/round trip [\d.]+ ms/);
  });

  it('times out rather than waiting forever on a silent headset', async () => {
    const { port } = await serve();
    // Connect but never answer, as a wedged client would.
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((r) => client.once('open', r));

    const result = await run(port, 'headset');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no reply');
  }, 10000);

  it('needs a device before it can light LEDs', async () => {
    const { port } = await serve();
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((r) => client.once('open', r));
    expect((await run(port, 'leds')).ok).toBe(false);
  });

  it('sends a note to the DAW and releases it', async () => {
    const { port, devices } = await serve();
    await devices.add(40, DeviceModel.LAUNCHPAD_X);

    const result = await run(port, 'midi');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('sent a note');

    // The note must be released; a self-test that strands a voice is worse
    // than no self-test.
    await new Promise((r) => setTimeout(r, 400));
    expect(devices.activeNotes).toBe(0);
  });

  it('counts LED pushes as outbound traffic', async () => {
    const { port, devices, ws } = await serve();
    await devices.add(40, DeviceModel.LAUNCHPAD_X);
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((r) => client.once('open', r));

    expect((await run(port, 'leds')).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    const status = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as DashboardStatus;
    expect(status.ledsOut).toBeGreaterThan(0);
    expect(ws.clientCount).toBe(1);
  });
});

describe('the generic surfaces still work alongside', () => {
  it('keeps device 1 reserved for the built-in pads', async () => {
    const { devices } = await serve();
    await devices.add(DeviceId.PADS, 'VRMC');
    expect(devices.roster()[0]?.deviceId).toBe(DeviceId.PADS);
  });
});
