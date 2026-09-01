import { describe, it, expect, afterEach } from 'vitest';
import { createSocket } from 'node:dgram';
import { WebSocket } from 'ws';
import {
  DeviceId,
  EventType,
  MidiStatus,
  PacketKind,
  PacketReader,
  PacketWriter,
} from '@vrmc/protocol';
import { DeviceId } from '@vrmc/protocol';
import { Router } from '../src/core/Router.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { NullSink, NullSource, SimpleVirtualPort } from '../src/midi/MidiSink.js';

/** Manager whose ports are recording stubs. See router.test.ts. */
async function managerWith(sink: NullSink): Promise<DeviceManager> {
  const devices = new DeviceManager(
    { onLed: () => {}, onRosterChange: () => {}, onLog: () => {} },
    {
      noMidi: false,
      loopbackPattern: /never/,
      portNameTemplate: '{device} {port}',
      openPort: async ({ name }) => ({
        port: new SimpleVirtualPort(name, sink, new NullSource(name)),
        ok: true,
        notes: [],
      }),
    },
  );
  await devices.add(DeviceId.PADS, 'test');
  return devices;
}
import { UdpServer } from '../src/net/UdpServer.js';
import { WsServer } from '../src/net/WsServer.js';

/**
 * These run the real servers over real sockets on the loopback interface. The
 * unit tests prove the translation is right; these prove the bytes survive the
 * trip, which is where framing and buffer-offset bugs actually show up.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** Ports well outside the ephemeral range, to avoid collisions in CI. */
let nextPort = 28400;
const takePort = (): number => nextPort++;

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function notePacket(note: number, velocity: number): Uint8Array {
  const w = new PacketWriter();
  w.begin(PacketKind.EVENTS);
  w.pushEvent(EventType.NOTE_ON, 0, note, velocity, 0, DeviceId.PADS, 0, 0);
  // Copy: the writer's view is only valid until the next begin().
  return w.finish(performance.now()).slice();
}

describe('WebSocket transport', () => {
  it('carries note events from a client through to the MIDI sink', async () => {
    const sink = new NullSink('test', true);
    const router = new Router(await managerWith(sink));
    const port = takePort();
    const server = new WsServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((resolve) => client.once('open', resolve));

    client.send(notePacket(36, 100));
    client.send(notePacket(38, 64));
    await waitFor(() => sink.log.length >= 2);

    expect(sink.log[0]).toEqual([MidiStatus.NOTE_ON, 36, 100]);
    expect(sink.log[1]).toEqual([MidiStatus.NOTE_ON, 38, 64]);
    expect(router.stats.packets).toBe(2);
  });

  it('replies to a PING so the client can measure its round trip', async () => {
    const router = new Router(await managerWith(new NullSink()));
    const port = takePort();
    const server = new WsServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((resolve) => client.once('open', resolve));

    const sentAt = 1234.5;
    const w = new PacketWriter();
    w.begin(PacketKind.PING);
    client.send(w.finish(sentAt).slice());

    const reply = await new Promise<Buffer>((resolve) =>
      client.once('message', (data: Buffer) => resolve(data)),
    );
    const reader = new PacketReader();
    reader.read(reply, null);
    expect(reader.header.kind).toBe(PacketKind.PONG);
    expect(reader.header.tClient).toBe(sentAt);
    expect(reader.bodyFloat64(0)).toBeGreaterThan(0);
  });

  it('releases held notes when a client disconnects without sending note offs', async () => {
    const sink = new NullSink('test', true);
    const router = new Router(await managerWith(sink));
    const port = takePort();
    const server = new WsServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => client.once('open', resolve));

    client.send(notePacket(60, 100));
    await waitFor(() => router.activeNotes === 1);

    // Yank the connection mid-note, as a headset going to sleep would.
    client.terminate();
    await waitFor(() => router.activeNotes === 0);

    expect(sink.log).toContainEqual([MidiStatus.NOTE_OFF, 60, 0]);
  });

  it('serves a reachability probe over plain HTTP', async () => {
    const router = new Router(await managerWith(new NullSink('Port Name')));
    const port = takePort();
    const server = new WsServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    // `/` is the dashboard now; `/healthz` is the probe, and unlike the
    // dashboard it answers non-loopback callers so a headset can use it.
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = (await res.json()) as { service: string; secure: boolean };
    expect(res.status).toBe(200);
    expect(body.service).toBe('vrmc-bridge');
    expect(body.secure).toBe(false);
  });

  it('ignores text frames rather than trying to parse them', async () => {
    const sink = new NullSink('test', true);
    const router = new Router(await managerWith(sink));
    const port = takePort();
    const server = new WsServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((resolve) => client.once('open', resolve));

    client.send('hello, are you a midi bridge?');
    client.send(notePacket(41, 90));
    await waitFor(() => sink.log.length >= 1);

    expect(sink.log).toEqual([[MidiStatus.NOTE_ON, 41, 90]]);
    expect(router.stats.malformed).toBe(0);
  });
});

describe('UDP transport', () => {
  it('carries note events from a datagram through to the MIDI sink', async () => {
    const sink = new NullSink('test', true);
    const router = new Router(await managerWith(sink));
    const port = takePort();
    const server = new UdpServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    const client = createSocket('udp4');
    cleanups.push(() => void client.close());
    client.send(notePacket(48, 111), port, '127.0.0.1');
    await waitFor(() => sink.log.length >= 1);

    expect(sink.log[0]).toEqual([MidiStatus.NOTE_ON, 48, 111]);
  });

  it('decodes correctly despite Node handing us pooled buffers', async () => {
    // Regression guard: dgram delivers Buffers that may be windows into a
    // shared slab, so every read must respect byteOffset.
    const sink = new NullSink('test', true);
    const router = new Router(await managerWith(sink));
    const port = takePort();
    const server = new UdpServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    const client = createSocket('udp4');
    cleanups.push(() => void client.close());
    for (let i = 0; i < 24; i++) client.send(notePacket(36 + i, 100), port, '127.0.0.1');
    await waitFor(() => sink.log.length >= 24);

    expect(sink.log.map((m) => m[1])).toEqual(
      Array.from({ length: 24 }, (_, i) => 36 + i),
    );
  });

  it('answers a PING back to the sending peer', async () => {
    const router = new Router(await managerWith(new NullSink()));
    const port = takePort();
    const server = new UdpServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    await server.listen();
    cleanups.push(() => server.close());

    const client = createSocket('udp4');
    cleanups.push(() => void client.close());
    const got = new Promise<Buffer>((resolve) => client.once('message', resolve));

    const w = new PacketWriter();
    w.begin(PacketKind.PING);
    client.send(w.finish(777.25).slice(), port, '127.0.0.1');

    const reader = new PacketReader();
    reader.read(await got, null);
    expect(reader.header.kind).toBe(PacketKind.PONG);
    expect(reader.header.tClient).toBe(777.25);
  });
});
