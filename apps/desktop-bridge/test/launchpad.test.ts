// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  DeviceModel,
  LAUNCHPAD_PRO_MK3,
  LAUNCHPAD_X,
  LaunchpadMode,
  buildModeMessage,
} from '@vrmc/devices';
import {
  DeviceId,
  DeviceStatus,
  EventType,
  FIRST_DYNAMIC_DEVICE_ID,
  PacketKind,
  PacketReader,
  PacketWriter,
  readDeviceState,
  readLedUpdate,
  writeDeviceAdd,
  writeDeviceRemove,
} from '@vrmc/protocol';
import { DEFAULT_CONFIG, parseArgs } from '../src/config.js';
import { Router } from '../src/core/Router.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { NullSink, NullSource, SimpleVirtualPort } from '../src/midi/MidiSink.js';
import { Broadcaster } from '../src/net/Broadcaster.js';
import { WsServer } from '../src/net/WsServer.js';

/**
 * A fake MIDI backend that records what was sent and can inject host traffic,
 * standing in for a DAW at the other end of a virtual port.
 */
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

  /** Everything sent out of a port, as raw byte arrays. */
  sent(name: string): number[][] {
    return this.sinks.get(name)?.log ?? [];
  }
}

function makeManager(ports: FakePorts, onLed?: DeviceManagerLed): DeviceManager {
  return new DeviceManager(
    {
      onLed: onLed ?? (() => {}),
      onRosterChange: () => {},
      onLog: () => {},
    },
    {
      noMidi: false,
      loopbackPattern: /never/,
      portNameTemplate: '{device} {port}',
      openPort: ports.open,
    },
  );
}

type DeviceManagerLed = (
  deviceId: number,
  ledIndex: number,
  r: number,
  g: number,
  b: number,
  blink: number,
) => void;

describe('creating and destroying emulated devices', () => {
  it('opens both hardware-named ports for a Launchpad X', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);

    // The names are what a DAW matches on, so they are asserted exactly.
    expect(ports.opened).toEqual(['Launchpad X LPX MIDI', 'Launchpad X LPX DAW']);
    expect(devices.portNamesOf(20)).toEqual(ports.opened);
    expect(devices.roster()).toEqual([
      {
        deviceId: 20,
        status: DeviceStatus.READY,
        model: DeviceModel.LAUNCHPAD_X,
        detail: 'Launchpad X LPX MIDI, Launchpad X LPX DAW',
        // No placement: this manager was built without a Workspace, which is
        // the same answer a device nobody has moved gets from one that has.
        placement: null,
      },
    ]);
  });

  it('opens Pro MK3 ports under its own names', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(21, DeviceModel.LAUNCHPAD_PRO_MK3);
    expect(ports.opened).toEqual([
      'Launchpad Pro MK3 LPProMK3 MIDI',
      'Launchpad Pro MK3 LPProMK3 DAW',
    ]);
  });

  it('honours a custom port naming template', async () => {
    const ports = new FakePorts();
    const devices = new DeviceManager(
      { onLed: () => {}, onRosterChange: () => {}, onLog: () => {} },
      {
        noMidi: false,
        loopbackPattern: /never/,
        portNameTemplate: 'VRMC {port}',
        openPort: ports.open,
      },
    );
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    expect(ports.opened).toEqual(['VRMC LPX MIDI', 'VRMC LPX DAW']);
  });

  it('runs several devices at once without their ids colliding', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    await devices.add(21, DeviceModel.LAUNCHPAD_X);
    await devices.add(22, DeviceModel.LAUNCHPAD_PRO_MK3);
    expect(devices.count).toBe(3);
    expect(devices.roster().map((d) => d.deviceId)).toEqual([20, 21, 22]);
  });

  it('treats re-adding an existing id as a no-op', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    // Re-creating would make the DAW drop its binding to a working device.
    expect(ports.opened).toHaveLength(2);
    expect(devices.count).toBe(1);
  });

  it('closes the ports when a device is removed', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    expect(devices.remove(20)).toBe(true);
    expect(devices.count).toBe(0);
    expect(devices.remove(20)).toBe(false);
  });

  it('releases sounding notes before closing the port', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    const daw = 'Launchpad X LPX DAW';

    devices.handleEvent(20, EventType.NOTE_ON, 0, 11, 100, 0);
    expect(ports.sent(daw)).toContainEqual([0x90, 11, 100]);

    devices.remove(20);
    // A pad left held must be released while the port still exists, or the
    // note is stranded in the DAW with nothing left to turn it off.
    expect(ports.sent(daw)).toContainEqual([0x90, 11, 0]);
  });
});

describe('what a DAW finds without anyone putting the headset on', () => {
  /*
   * The complaint this answers: "Ableton shows it as VRMC".
   *
   * It did, and that was all it could do. A plain port carries notes but
   * matches no control-surface script, so Ableton listed it as a nameless
   * keyboard — no session grid, no lights, nothing to bind — and the only way
   * to get a real device was to spawn one from inside the headset, which is
   * not a place anyone looks when the problem appears in a DAW on a desk.
   */
  it('opens hardware the DAW can recognise, before any headset connects', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);

    await devices.add(DeviceId.PADS, 'VRMC');
    await devices.add(FIRST_DYNAMIC_DEVICE_ID, DEFAULT_CONFIG.startupDevice);

    // Both ports of the real thing, spelled the way a script matches them.
    expect(ports.opened).toContain('Launchpad X LPX DAW');
    expect(ports.opened).toContain('Launchpad X LPX MIDI');
    // And the plain surface is still there for the keys, pads and knobs.
    expect(ports.opened).toContain('VRMC');
  });

  it('answers a Device Inquiry on the startup device, which is how a script confirms', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(FIRST_DYNAMIC_DEVICE_ID, DEFAULT_CONFIG.startupDevice);

    // The universal inquiry every DAW sends before it trusts a port name.
    devices.injectHostMessage(
      FIRST_DYNAMIC_DEVICE_ID,
      LAUNCHPAD_X.dawPortIndex,
      new Uint8Array([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]),
    );

    const replies = ports.sent('Launchpad X LPX DAW').filter((m) => m[0] === 0xf0);
    expect(replies.length).toBeGreaterThan(0);
    // Family code is what selects the script; a wrong one binds nothing.
    expect(replies[0]).toEqual(expect.arrayContaining([...LAUNCHPAD_X.familyCode]));
  });

  it('does not route the plain surfaces through the emulator', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(DeviceId.PADS, 'VRMC');
    devices.alias(DeviceId.KEYS, DeviceId.PADS);
    await devices.add(FIRST_DYNAMIC_DEVICE_ID, DEFAULT_CONFIG.startupDevice);

    // Middle C from the headset's keyboard. A Launchpad reads data1 as an XY
    // index, so had these shared a device this would have lit a pad instead of
    // playing a note.
    devices.handleEvent(DeviceId.KEYS, EventType.NOTE_ON, 0, 60, 100, 0);

    expect(ports.sent('VRMC')).toContainEqual([0x90, 60, 100]);
    expect(ports.sent('Launchpad X LPX DAW')).toHaveLength(0);
  });

  it('can be turned off for someone who only wants the plain port', () => {
    expect(parseArgs(['--device', 'none'])).toMatchObject({ startupDevice: 'none' });
    expect(() => parseArgs(['--device', 'mpc'])).toThrow(/launchpad/);
  });
});

describe('device recognition by the host', () => {
  it('answers a device inquiry with the Launchpad X family code', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);

    // The DAW probes the port it just opened.
    const delivered = devices.injectHostMessage(
      20,
      LAUNCHPAD_X.dawPortIndex,
      Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7),
    );
    expect(delivered).toBe(true);

    const reply = ports.sent('Launchpad X LPX DAW').at(-1)!;
    expect(reply.slice(0, 10)).toEqual([
      0xf0, 0x7e, 0x00, 0x06, 0x02, 0x00, 0x20, 0x29, 0x03, 0x01,
    ]);
  });

  it('answers on the non-DAW port too', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    // A host that probes the wrong port and hears nothing will not bind.
    expect(
      devices.injectHostMessage(20, 0, Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7)),
    ).toBe(true);
    expect(ports.sent('Launchpad X LPX DAW').length).toBeGreaterThan(0);
  });

  it('gives the Pro MK3 its own family code', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(21, DeviceModel.LAUNCHPAD_PRO_MK3);
    devices.injectHostMessage(
      21,
      LAUNCHPAD_PRO_MK3.dawPortIndex,
      Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7),
    );
    const reply = ports.sent('Launchpad Pro MK3 LPProMK3 DAW').at(-1)!;
    expect(reply.slice(8, 10)).toEqual([0x23, 0x01]);
  });
});

describe('LED feedback from the host', () => {
  it('turns a Note On from the DAW into an LED change for the headset', async () => {
    const ports = new FakePorts();
    const leds: number[][] = [];
    const devices = makeManager(ports, (id, i, r, g, b, blink) => leds.push([id, i, r, g, b, blink]));
    await devices.add(20, DeviceModel.LAUNCHPAD_X);

    // Ableton lighting pad 11 red via palette entry 5.
    devices.injectHostMessage(20, LAUNCHPAD_X.dawPortIndex, Uint8Array.of(0x90, 11, 5));
    expect(leds).toEqual([[20, 11, 63, 0, 0, 0]]);
  });

  it('applies an RGB SysEx write', async () => {
    const ports = new FakePorts();
    const leds: number[][] = [];
    const devices = makeManager(ports, (id, i, r, g, b) => leds.push([id, i, r, g, b]));
    await devices.add(20, DeviceModel.LAUNCHPAD_X);

    devices.injectHostMessage(
      20,
      LAUNCHPAD_X.dawPortIndex,
      Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x03, 3, 44, 1, 2, 3, 0xf7),
    );
    expect(leds).toEqual([[20, 44, 1, 2, 3]]);
  });

  it('keeps two devices LED states apart', async () => {
    const ports = new FakePorts();
    const leds: number[][] = [];
    const devices = makeManager(ports, (id, i, r) => leds.push([id, i, r]));
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    await devices.add(21, DeviceModel.LAUNCHPAD_X);

    devices.injectHostMessage(20, LAUNCHPAD_X.dawPortIndex, Uint8Array.of(0x90, 11, 5));
    devices.injectHostMessage(21, LAUNCHPAD_X.dawPortIndex, Uint8Array.of(0x90, 12, 21));
    expect(leds).toEqual([
      [20, 11, 63],
      [21, 12, 0],
    ]);
  });

  it('reports the whole surface for a resync', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    devices.injectHostMessage(20, LAUNCHPAD_X.dawPortIndex, Uint8Array.of(0x90, 11, 5));

    const seen: number[][] = [];
    devices.forEachLed(20, (i, r, g, b) => seen.push([i, r, g, b]));
    expect(seen.length).toBe(LAUNCHPAD_X.controls.length);
    expect(seen).toContainEqual([11, 63, 0, 0]);
  });

  it('follows a mode switch from the host', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    devices.injectHostMessage(
      20,
      LAUNCHPAD_X.dawPortIndex,
      buildModeMessage(LAUNCHPAD_X, LaunchpadMode.PROGRAMMER),
    );
    // Nothing to assert on the wire; the check is that it neither throws nor
    // is mistaken for an LED write.
    expect(devices.count).toBe(1);
  });
});

describe('presses reaching the host', () => {
  it('sends a grid press as Note On and its release as velocity 0', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    const daw = 'Launchpad X LPX DAW';

    devices.handleEvent(20, EventType.NOTE_ON, 0, 55, 100, 0);
    devices.handleEvent(20, EventType.NOTE_OFF, 0, 55, 0, 0);
    expect(ports.sent(daw)).toEqual([
      [0x90, 55, 100],
      [0x90, 55, 0],
    ]);
  });

  it('sends a function button as Control Change', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    devices.handleEvent(20, EventType.NOTE_ON, 0, 91, 64, 0);
    expect(ports.sent('Launchpad X LPX DAW')).toEqual([[0xb0, 91, 127]]);
  });

  it('sends polyphonic aftertouch from sustained pressure', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    await devices.add(20, DeviceModel.LAUNCHPAD_X);
    devices.handleEvent(20, EventType.NOTE_ON, 0, 55, 100, 0);
    devices.handleEvent(20, EventType.AFTERTOUCH_POLY, 0, 55, 90, 0);
    expect(ports.sent('Launchpad X LPX DAW')).toContainEqual([0xa0, 55, 90]);
  });

  it('drops events for a device that does not exist', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    expect(() => devices.handleEvent(99, EventType.NOTE_ON, 0, 11, 100, 0)).not.toThrow();
  });
});

describe('end to end over the WebSocket link', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let nextPort = 28500;

  async function serve(
    devices: DeviceManager,
  ): Promise<{ ws: WsServer; bus: Broadcaster; client: WebSocket }> {
    const router = new Router(devices, {});
    const port = nextPort++;
    const ws = new WsServer(router, { port, host: '127.0.0.1', onLog: () => {} });
    const bus = new Broadcaster(router.stats);
    bus.add(ws);
    ws.deviceCount = () => devices.count;
    await ws.listen();
    cleanups.push(async () => {
      bus.close();
      await ws.close();
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => void client.close());
    await new Promise((resolve) => client.once('open', resolve));
    return { ws, bus, client };
  }

  function send(client: WebSocket, kind: number, fill: (w: PacketWriter) => void): void {
    const w = new PacketWriter();
    w.begin(kind);
    fill(w);
    client.send(w.finish(performance.now()).slice());
  }

  it('spawns a device from the headset and reports it back in the roster', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    const { bus, client } = await serve(devices);

    const rosters: ReturnType<typeof readDeviceState>[] = [];
    const reader = new PacketReader();
    client.on('message', (data: Buffer) => {
      if (reader.read(data, null) !== 0) return;
      if (reader.header.kind === PacketKind.DEVICE_STATE) {
        rosters.push(readDeviceState(reader.bodyView()));
      }
    });

    send(client, PacketKind.DEVICE_ADD, (w) => writeDeviceAdd(w, 30, DeviceModel.LAUNCHPAD_X));

    await vi.waitFor(() => expect(devices.count).toBe(1), { timeout: 2000 });
    expect(ports.opened).toContain('Launchpad X LPX DAW');

    // The roster push tells the headset the ports really opened.
    bus.sendRoster(devices.roster());
    await vi.waitFor(() => expect(rosters.length).toBeGreaterThan(0), { timeout: 2000 });
    const latest = rosters.at(-1)!;
    expect(latest[0]).toMatchObject({ deviceId: 30, status: DeviceStatus.READY });

    send(client, PacketKind.DEVICE_REMOVE, (w) => writeDeviceRemove(w, 30));
    await vi.waitFor(() => expect(devices.count).toBe(0), { timeout: 2000 });

    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  it('delivers an LED change from the DAW all the way to the headset', async () => {
    const ports = new FakePorts();
    let bus: Broadcaster | null = null;
    const devices = makeManager(ports, (id, i, r, g, b, blink) => {
      bus?.queueLed(id, i, r, g, b, blink);
    });
    const served = await serve(devices);
    bus = served.bus;
    const client = served.client;

    const updates: Array<{ deviceId: number; leds: number[][] }> = [];
    const reader = new PacketReader();
    client.on('message', (data: Buffer) => {
      if (reader.read(data, null) !== 0) return;
      if (reader.header.kind !== PacketKind.LED_UPDATE) return;
      const leds: number[][] = [];
      const deviceId = readLedUpdate(reader.bodyView(), (i, r, g, b, blink) =>
        leds.push([i, r, g, b, blink]),
      );
      updates.push({ deviceId, leds });
    });

    await devices.add(30, DeviceModel.LAUNCHPAD_X);

    // The DAW lights a row. Each write arrives separately, as Ableton sends
    // them, and should coalesce into one packet.
    for (let col = 1; col <= 8; col++) {
      devices.injectHostMessage(30, LAUNCHPAD_X.dawPortIndex, Uint8Array.of(0x90, 10 + col, 5));
    }

    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 2000 });
    const all = updates.flatMap((u) => u.leds);
    expect(updates[0]!.deviceId).toBe(30);
    expect(all).toHaveLength(8);
    expect(all[0]).toEqual([11, 63, 0, 0, 0]);
    // Eight writes, one packet: the coalescing worked.
    expect(updates).toHaveLength(1);

    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  it('plays a pad from the headset through to the DAW port', async () => {
    const ports = new FakePorts();
    const devices = makeManager(ports);
    const { client } = await serve(devices);
    await devices.add(30, DeviceModel.LAUNCHPAD_X);

    send(client, PacketKind.EVENTS, (w) => {
      w.pushEvent(EventType.NOTE_ON, 0, 55, 120, 0, 30, 0, 0);
    });

    await vi.waitFor(
      () => expect(ports.sent('Launchpad X LPX DAW')).toContainEqual([0x90, 55, 120]),
      { timeout: 2000 },
    );

    for (const fn of cleanups.splice(0).reverse()) await fn();
  });
});
