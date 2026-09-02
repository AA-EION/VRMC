// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { PeerConnection, cleanup as rtcCleanup } from 'node-datachannel';
import { DeviceModel, LAUNCHPAD_X } from '@vrmc/devices';
import {
  EventType,
  PacketKind,
  PacketReader,
  PacketWriter,
  generatePairingCode,
  readLedUpdate,
  writeDeviceAdd,
} from '@vrmc/protocol';
import { WebServer } from '@vrmc/web';
import { Router } from '../src/core/Router.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { NullSink, NullSource, SimpleVirtualPort } from '../src/midi/MidiSink.js';
import { Broadcaster } from '../src/net/Broadcaster.js';
import { RtcTransport } from '../src/net/RtcTransport.js';
import { SignalClient } from '../src/net/SignalClient.js';

/**
 * The whole zero-configuration path, end to end.
 *
 * This is the claim the design rests on, so it is tested rather than asserted:
 * a headset that knows nothing but a six-character code can reach a bridge on
 * a private network, play a note into a DAW, and see the DAW's LED writes come
 * back — with no certificate, no DNS record and no port forwarding anywhere in
 * the path. Everything below the browser is the real implementation: the real
 * signalling service, the real polling client, the real transport, and a real
 * DTLS-secured data channel between two independent peers.
 *
 * The one stand-in is the headset itself, which is libdatachannel here rather
 * than a browser. What matters about the browser — that it offers, gathers,
 * and expects a matching answer — is the same on both.
 */

/** A MIDI backend that records what was sent and can inject host traffic. */
class FakePorts {
  readonly opened: string[] = [];
  readonly sinks = new Map<string, NullSink>();
  readonly sources = new Map<string, NullSource>();

  open = async ({ name }: { name: string }) => {
    const sink = new NullSink(name, true);
    const source = new NullSource(name);
    this.sinks.set(name, sink);
    this.sources.set(name, source);
    this.opened.push(name);
    return { port: new SimpleVirtualPort(name, sink, source), ok: true, notes: [] };
  };

  sent(name: string): number[][] {
    return this.sinks.get(name)?.log ?? [];
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

let nextPort = 28900;

/**
 * Stand up a signalling service and a bridge waiting at it.
 *
 * Mirrors what `main()` builds, so a change that breaks the real wiring breaks
 * this too.
 */
async function pairedBridge(): Promise<{
  code: string;
  serviceUrl: string;
  ports: FakePorts;
  devices: DeviceManager;
  bus: Broadcaster;
  rtc: RtcTransport;
}> {
  const code = generatePairingCode(() => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

  const web = new WebServer({
    port: nextPort++,
    host: '127.0.0.1',
    staticDir: new URL('.', import.meta.url).pathname,
  });
  const bound = await web.listen();
  const serviceUrl = `http://127.0.0.1:${bound}`;
  cleanups.push(() => web.close());

  // The bridge has to be registered before it may signal — the endpoint is
  // keyed on a claimed code, not on any string a caller invents.
  const registered = await fetch(`${serviceUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      addresses: ['192.168.1.50'],
      port: 7401,
      label: 'Test Studio Mac',
      version: 'test',
    }),
  });
  expect(registered.status).toBe(200);

  const ports = new FakePorts();
  let bus: Broadcaster | null = null;
  const devices = new DeviceManager(
    {
      onLed: (...a) => bus?.queueLed(...a),
      onRosterChange: () => bus?.sendRoster(devices.roster()),
      onLog: () => {},
    },
    {
      noMidi: false,
      loopbackPattern: /never/,
      portNameTemplate: '{device} {port}',
      openPort: ports.open,
    },
  );

  const router = new Router(devices, { onPong: () => bus?.notePong() });
  const broadcaster = new Broadcaster(router.stats);
  bus = broadcaster;

  const rtc = new RtcTransport(router, { onLog: () => {}, onPeerChange: () => {} });
  broadcaster.add(rtc);
  expect(await rtc.load()).toBe(true);

  const signalling = new SignalClient({
    serviceUrl,
    code,
    answer: (sessionId, offer) => rtc.answer(sessionId, offer),
    onLog: () => {},
  });
  signalling.start();
  cleanups.push(() => {
    signalling.stop();
    rtc.close();
    broadcaster.close();
    devices.removeAll();
  });

  return { code, serviceUrl, ports, devices, bus: broadcaster, rtc };
}

interface FakeHeadset {
  send: (frame: Uint8Array) => void;
  received: Uint8Array[];
  close: () => void;
}

/**
 * A headset, retried.
 *
 * libdatachannel occasionally rejects a perfectly well-formed answer with
 * "Got a remote candidate without ICE transport" when both peers are itself,
 * on one CPU, handshaking back to back. That was chased down to a reproduction
 * with no VRMC code in it at all — two bare peers relaying SDP over a local
 * HTTP server — so it is the library under contention rather than anything
 * here, and the SDP both sides produce was inspected and is correct.
 *
 * It cannot reach a user: the offering peer in production is the browser's own
 * WebRTC stack, and this bridge is only ever the answerer. A native client
 * built on libdatachannel could hit it, and would want this same retry; VRMC
 * ships no such client.
 *
 * So the retry lives here, in the stand-in headset, rather than being worked
 * around in code that would carry it forever for no one's benefit.
 */
async function connectHeadset(serviceUrl: string, code: string): Promise<FakeHeadset> {
  let lastError: unknown;
  // Bounded by the signalling service's own cap of four handshakes per code.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await attemptHandshake(serviceUrl, code, `headset${attempt}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function attemptHandshake(
  serviceUrl: string,
  code: string,
  sessionId: string,
): Promise<FakeHeadset> {
  const pc = new PeerConnection(sessionId, { iceServers: [] });
  const channel = pc.createDataChannel('vrmc', {
    ordered: false,
    maxRetransmits: 0,
  });
  const received: Uint8Array[] = [];
  const inbound = new PacketReader();
  channel.onMessage((msg) => {
    if (typeof msg === 'string') return;
    const bytes = new Uint8Array(msg);
    received.push(bytes);
    // Answer the bridge's latency probe, as the real client does. Without it
    // the desktop audit could never prove the return path works.
    if (inbound.read(bytes, null) === 0 && inbound.header.kind === PacketKind.PING) {
      const w = new PacketWriter();
      w.begin(PacketKind.PONG);
      channel.sendMessageBinary(Buffer.from(w.finish(inbound.header.tClient)));
    }
  });

  const opened = new Promise<void>((resolve) => channel.onOpen(resolve));

  /*
   * Wait for the offer libdatachannel produces on its own.
   *
   * `createDataChannel` already generates the local description and starts
   * gathering, so there is deliberately no `setLocalDescription()` call here:
   * a second one renegotiates, rebuilding the ICE transport underneath an
   * answer that is already in flight. That surfaces as "Got a remote candidate
   * without ICE transport" when the answer lands mid-rebuild — load-dependent,
   * and it failed exactly once, on CI.
   *
   * Polled rather than awaited on the state-change callback: with only local
   * addresses to offer, gathering can be finished before the callback is
   * installed, and the event never comes again.
   */
  const offer = await vi.waitFor(
    () => {
      expect(pc.gatheringState()).toBe('complete');
      const local = pc.localDescription();
      expect(local).not.toBeNull();
      return local!.sdp;
    },
    { timeout: 10_000, interval: 25 },
  );

  // The DTLS fingerprint is what makes the certificate unnecessary: the peers
  // verify each other against it directly, with no authority in between.
  expect(offer).toMatch(/a=fingerprint:sha-256/);

  const posted = await fetch(`${serviceUrl}/api/signal/${code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, offer }),
  });
  expect(posted.status).toBe(202);

  let answer = '';
  const deadline = Date.now() + 20_000;
  while (answer === '' && Date.now() < deadline) {
    const res = await fetch(`${serviceUrl}/api/signal/${code}/${sessionId}`);
    if (res.status === 204) continue;
    expect(res.status).toBe(200);
    answer = ((await res.json()) as { answer: string }).answer;
  }
  expect(answer).not.toBe('');

  try {
    pc.setRemoteDescription(answer, 'answer');
    await opened;
  } catch (err) {
    pc.close();
    throw err;
  }

  cleanups.push(() => {
    channel.close();
    pc.close();
  });

  return {
    send: (frame) => channel.sendMessageBinary(Buffer.from(frame)),
    received,
    close: () => channel.close(),
  };
}

function frame(kind: number, fill: (w: PacketWriter) => void): Uint8Array {
  const w = new PacketWriter();
  w.begin(kind);
  fill(w);
  return w.finish(performance.now()).slice();
}

describe('connecting with nothing but a pairing code', () => {
  it('carries a note into the DAW and LED changes back out', async () => {
    const { code, serviceUrl, ports, devices, bus } = await pairedBridge();
    const headset = await connectHeadset(serviceUrl, code);

    // 1. The headset asks for a Launchpad, and real MIDI ports appear.
    headset.send(frame(PacketKind.DEVICE_ADD, (w) => writeDeviceAdd(w, 30, DeviceModel.LAUNCHPAD_X)));
    await vi.waitFor(() => expect(devices.count).toBe(1), { timeout: 5000 });
    expect(ports.opened).toContain('Launchpad X LPX (DAW)');

    // 2. A pad is struck in the headset, and the DAW sees the note the real
    //    hardware would have sent: bottom-left pad is XY index 11.
    headset.send(
      frame(PacketKind.EVENTS, (w) => {
        w.pushEvent(EventType.NOTE_ON, 0, 11, 100, 0, 30, 0, 0);
      }),
    );
    await vi.waitFor(
      () => expect(ports.sent('Launchpad X LPX (DAW)')).toContainEqual([0x90, 11, 100]),
      { timeout: 5000 },
    );

    // 3. The DAW lights that pad, and the change reaches the headset.
    devices.injectHostMessage(30, LAUNCHPAD_X.dawPortIndex, Uint8Array.of(0x90, 11, 5));

    const reader = new PacketReader();
    /** Every LED write the headset has been told about so far. */
    const litPads = (): number[] => {
      const lit: number[] = [];
      for (const message of headset.received) {
        if (reader.read(message, null) !== 0) continue;
        if (reader.header.kind !== PacketKind.LED_UPDATE) continue;
        readLedUpdate(reader.bodyView(), (i) => lit.push(i));
      }
      return lit;
    };
    await vi.waitFor(() => expect(litPads()).toContain(11), { timeout: 5000 });

    // 4. And the round trip the desktop audit relies on completes.
    const rtt = await bus.pingClients(5000);
    expect(rtt).toBeGreaterThanOrEqual(0);
  }, 40_000);

  it('releases sounding notes when the headset vanishes', async () => {
    const { code, serviceUrl, ports, devices } = await pairedBridge();
    const headset = await connectHeadset(serviceUrl, code);

    headset.send(frame(PacketKind.DEVICE_ADD, (w) => writeDeviceAdd(w, 31, DeviceModel.LAUNCHPAD_X)));
    await vi.waitFor(() => expect(devices.count).toBe(1), { timeout: 5000 });

    headset.send(
      frame(PacketKind.EVENTS, (w) => {
        w.pushEvent(EventType.NOTE_ON, 0, 12, 90, 0, 31, 0, 0);
      }),
    );
    const out = 'Launchpad X LPX (DAW)';
    await vi.waitFor(() => expect(ports.sent(out)).toContainEqual([0x90, 12, 90]), {
      timeout: 5000,
    });

    // A headset that loses power sends no Note Off. If the bridge did not
    // release on disconnect, that voice would sound until the DAW restarted.
    headset.close();
    // Generous, because this waits on libdatachannel noticing a closed channel
    // on its own threads. On a CI runner busy compiling the rest of the
    // workspace that has taken longer than five seconds — a scheduling
    // artefact, not a slow release, so the cure is patience rather than a
    // weaker assertion.
    await vi.waitFor(() => expect(ports.sent(out)).toContainEqual([0x90, 12, 0]), {
      timeout: 20_000,
    });
  }, 40_000);

  it('refuses to broker a handshake for a code no bridge has claimed', async () => {
    const { serviceUrl } = await pairedBridge();
    // Otherwise the signalling endpoint would be an open message queue keyed
    // by any string a caller cared to invent.
    const res = await fetch(`${serviceUrl}/api/signal/WXYZ23`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'x', offer: 'v=0' }),
    });
    expect(res.status).toBe(404);
  }, 20_000);
});

// Tears down libdatachannel's threads once, at the end. Doing it between tests
// would pull the library out from under the next one's peer connections.
afterAll(() => {
  rtcCleanup();
});
