// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, vi } from "vitest";
import {
  DRIVER_MODELS,
  DriverPorts,
  driverAwareOpener,
  driverDeviceIndex,
} from "../src/midi/DriverPort.js";
import { FrameKind, deviceOf, encodeAddress, portOf } from "../src/midi/driverFraming.js";
import { DEVICE_SPECS, DeviceModel, HARDWARE_MODELS } from "@vrmc/devices";
import type { DriverLink } from "../src/midi/DriverLink.js";

/**
 * The driver's ports, wearing the interface everything else already speaks.
 *
 * The value of this shape is that `DeviceManager`, the emulator and the roster
 * need no knowledge of the driver at all — so what is worth testing is that the
 * disguise is complete and that the routing underneath it is right.
 */

function harness() {
  const sent: { port: number; data: number[] }[] = [];
  const frames: { kind: number; address: number; payload: number[] }[] = [];
  const link = {
    sendMidi: (port: number, data: Uint8Array) => {
      sent.push({ port, data: [...data] });
      return true;
    },
    sendFrame: (kind: number, address: number, payload: Uint8Array) => {
      frames.push({ kind, address, payload: [...payload] });
      return true;
    },
  } as unknown as DriverLink;
  return { ports: new DriverPorts(link), sent, frames };
}

/** The Pro MK3's device index, and its DAW port. */
const PRO = driverDeviceIndex(DeviceModel.LAUNCHPAD_PRO_MK3);
const X = driverDeviceIndex(DeviceModel.LAUNCHPAD_X);

describe("sending to a DAW", () => {
  it("sends a note on the entity the port was opened for", () => {
    const h = harness();
    const daw = h.ports.open("LPProMK3 DAW", PRO, 2);
    daw.sink.send(0x90, 60, 100);
    expect(h.sent).toEqual([{ port: encodeAddress(PRO, 2), data: [0x90, 60, 100] }]);
  });

  it("keeps two ports apart", () => {
    /*
     * The Pro MK3's MIDI port and DAW port carry unrelated conversations — one
     * is notes, the other the control-surface protocol. Crossing them would
     * make a DAW's script see note data and a track see SysEx.
     */
    const h = harness();
    const midi = h.ports.open("LPProMK3 MIDI", PRO, 0);
    const daw = h.ports.open("LPProMK3 DAW", PRO, 2);
    midi.sink.send(0x90, 60, 1);
    daw.sink.send(0xb0, 7, 2);
    expect(h.sent).toEqual([
      { port: encodeAddress(PRO, 0), data: [0x90, 60, 1] },
      { port: encodeAddress(PRO, 2), data: [0xb0, 7, 2] },
    ]);
  });

  it("sends two bytes for the messages that have two", () => {
    // Program change and channel pressure carry no second data byte. A third
    // byte would leave the host one out of step for everything after it.
    const h = harness();
    const port = h.ports.open("p", PRO, 0);
    port.sink.send(0xc0, 5, 0);
    port.sink.send(0xd0, 64, 0);
    expect(h.sent.map((s) => s.data)).toEqual([
      [0xc0, 5],
      [0xd0, 64],
    ]);
  });

  it("still sends three for the messages that have three", () => {
    const h = harness();
    const port = h.ports.open("p", PRO, 0);
    for (const status of [0x80, 0x90, 0xa0, 0xb0, 0xe0]) {
      port.sink.send(status, 1, 2);
    }
    expect(h.sent.every((s) => s.data.length === 3)).toBe(true);
  });

  it("carries SysEx whole, which is how a Launchpad is lit", () => {
    const h = harness();
    const port = h.ports.open("p", PRO, 2);
    const sysex = Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x03, 0xf7);
    port.sink.sendRaw?.(sysex);
    expect(h.sent[0]!.data).toEqual([...sysex]);
  });

  it("does not reuse one buffer across two sends in a way that corrupts them", () => {
    // The three-byte buffer is reused per sink on purpose — this is the
    // per-note path. That is only safe because the link copies before
    // returning, so this pins the assumption rather than leaving it implied.
    const h = harness();
    const port = h.ports.open("p", PRO, 1);
    port.sink.send(0x90, 60, 100);
    port.sink.send(0x90, 62, 20);
    expect(h.sent).toEqual([
      { port: encodeAddress(PRO, 1), data: [0x90, 60, 100] },
      { port: encodeAddress(PRO, 1), data: [0x90, 62, 20] },
    ]);
  });
});

describe("receiving from a DAW", () => {
  it("delivers to the port the message was addressed to", () => {
    const h = harness();
    const midi = h.ports.open("LPProMK3 MIDI", PRO, 0);
    const daw = h.ports.open("LPProMK3 DAW", PRO, 2);
    const onMidi = vi.fn();
    const onDaw = vi.fn();
    midi.source!.onMessage = onMidi;
    daw.source!.onMessage = onDaw;

    h.ports.deliver(encodeAddress(PRO, 2), Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7));
    expect(onDaw).toHaveBeenCalledTimes(1);
    expect(onMidi).not.toHaveBeenCalled();
  });

  it("drops a message for a port nobody opened, rather than throwing", () => {
    // The driver publishes three entities whether or not the bridge has opened
    // all three, so this is an ordinary arrival and not a fault.
    const h = harness();
    h.ports.open("p", PRO, 0);
    expect(() => h.ports.deliver(encodeAddress(PRO, 2), Uint8Array.of(0x90, 60, 1))).not.toThrow();
  });

  it("stops delivering to a closed port", () => {
    const h = harness();
    const port = h.ports.open("p", PRO, 1);
    const onMessage = vi.fn();
    port.source!.onMessage = onMessage;
    port.close();
    h.ports.deliver(encodeAddress(PRO, 1), Uint8Array.of(0x90, 60, 1));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("lets a port be reopened on the same entity after a close", () => {
    // A device removed and respawned is the ordinary case — the headset does
    // it — and a stale mapping would leave the new port silent.
    const h = harness();
    h.ports.open("p", PRO, 1).close();
    const again = h.ports.open("p", PRO, 1);
    const onMessage = vi.fn();
    again.source!.onMessage = onMessage;
    h.ports.deliver(encodeAddress(PRO, 1), Uint8Array.of(0x90, 60, 1));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});

describe("what it tells the rest of the bridge", () => {
  it("does not claim to be a virtual port", () => {
    /*
     * `virtual` means "a port this process invented". These are not: they
     * belong to a device the driver publishes, which a DAW sees whether the
     * bridge is running or not. Claiming otherwise would make the startup
     * banner say something untrue.
     */
    const h = harness();
    expect(h.ports.open("p", PRO, 0).sink.virtual).toBe(false);
  });

  it("names its backend, so a log says which route the MIDI took", () => {
    const h = harness();
    expect(h.ports.open("p", PRO, 0).sink.backend).toBe("coremidi-driver");
  });

  it("closing a port does not silence the others, in either direction", () => {
    /*
     * The link and the endpoints are shared, so a close that tore either down
     * would take the whole device with it.
     *
     * Both directions on purpose. A first version checked only that the other
     * port could still *send*, and a `close` that dropped every source — so
     * nothing could still *receive* — passed it. The receiving half is the one
     * a shared map can break.
     */
    const h = harness();
    const a = h.ports.open("a", PRO, 0);
    const b = h.ports.open("b", PRO, 1);
    const onB = vi.fn();
    b.source!.onMessage = onB;

    a.close();

    b.sink.send(0x90, 60, 1);
    expect(h.sent).toEqual([{ port: encodeAddress(PRO, 1), data: [0x90, 60, 1] }]);
    h.ports.deliver(encodeAddress(PRO, 1), Uint8Array.of(0xb0, 7, 9));
    expect(onB).toHaveBeenCalledTimes(1);
  });
});

/**
 * Choosing between the driver and a virtual port.
 *
 * The decision is per port and not once at startup, because MIDIServer loads
 * the driver on demand and exits when idle — so "is it there" has a different
 * answer minute to minute. A bridge that decided at startup would open virtual
 * ports for a whole session because the driver happened to be asleep.
 */
describe("which route a port takes", () => {
  const fallbackResult = {
    port: { name: "virtual", sink: {}, source: null, close: () => {} },
    ok: true,
    notes: ["virtual"],
  } as never;

  function opener(connected: boolean) {
    const h = harness();
    const fallback = vi.fn(async () => fallbackResult);
    return {
      ...h,
      fallback,
      open: driverAwareOpener(h.ports, { connected }, fallback),
    };
  }

  const options = (over: Record<string, unknown> = {}) =>
    ({
      name: "Launchpad Pro MK3 LPProMK3 DAW",
      noMidi: false,
      loopbackPattern: /never/,
      model: DeviceModel.LAUNCHPAD_PRO_MK3,
      portIndex: 2,
      ...over,
    }) as never;

  it("uses the driver when it is connected and the model matches", async () => {
    const o = opener(true);
    const result = await o.open(options());
    expect(o.fallback).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    result.port.sink.send(0x90, 60, 1);
    expect(o.sent).toEqual([{ port: encodeAddress(PRO, 2), data: [0x90, 60, 1] }]);
  });

  it("falls back to a virtual port when the driver is not connected", async () => {
    const o = opener(false);
    await o.open(options());
    expect(o.fallback).toHaveBeenCalledTimes(1);
  });

  it("carries a Launchpad X too, on its own device", async () => {
    /*
     * The driver publishes every model in the spec list, not one. An X routed
     * onto the Pro MK3's device index would put its notes on a device a DAW
     * has been told is a different instrument — silently.
     */
    const o = opener(true);
    const result = await o.open(options({ model: DeviceModel.LAUNCHPAD_X, portIndex: 0 }));
    expect(o.fallback).not.toHaveBeenCalled();
    result.port.sink.send(0x90, 60, 1);
    expect(deviceOf(o.sent[0]!.port)).toBe(X);
    expect(deviceOf(o.sent[0]!.port)).not.toBe(PRO);
  });

  it("falls back for a model that is not emulated hardware at all", async () => {
    const o = opener(true);
    await o.open(options({ model: "surface-64" }));
    expect(o.fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back for the plain surfaces, which have no model at all", async () => {
    const o = opener(true);
    await o.open(options({ model: undefined, portIndex: undefined }));
    expect(o.fallback).toHaveBeenCalledTimes(1);
  });

  it("respects --no-midi, which must open nothing anywhere", async () => {
    // Otherwise the flag that exists to test the network path without touching
    // MIDI would publish a device and send real notes to a DAW.
    const o = opener(true);
    await o.open(options({ noMidi: true }));
    expect(o.fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back for a port index the address byte cannot hold", async () => {
    // Sixteen ports is the whole low nibble. Beyond it the index would wrap
    // into another port of the same device — silently the wrong instrument.
    const o = opener(true);
    await o.open(options({ portIndex: 16 }));
    expect(o.fallback).toHaveBeenCalledTimes(1);
  });

  it("publishes exactly the models the bridge can emulate", () => {
    /*
     * The driver's device table is generated from these same specs, and the
     * index into this list is the device half of the address byte. If the two
     * ever disagreed, MIDI would arrive at the wrong instrument with nothing
     * to say so.
     */
    expect([...DRIVER_MODELS]).toEqual([...HARDWARE_MODELS]);
    for (const model of DRIVER_MODELS) {
      expect(DEVICE_SPECS[model]).toBeDefined();
      expect(driverDeviceIndex(model)).toBeGreaterThanOrEqual(0);
    }
  });

  it("fits every model's ports in the address byte", () => {
    // The packing gives each half four bits. A spec outgrowing that has to be
    // caught here rather than by notes going to the wrong port.
    expect(DRIVER_MODELS.length).toBeLessThanOrEqual(16);
    for (const model of DRIVER_MODELS) {
      expect(DEVICE_SPECS[model]!.portNames.length).toBeLessThanOrEqual(16);
    }
  });
});

/**
 * Telling the driver which instruments the headset is actually holding.
 *
 * The driver publishes every model it supports the moment it loads and marks
 * them all absent, because CoreMIDI's header says a driver should toggle
 * `kMIDIPropertyOffline` rather than add and remove devices — that way a DAW's
 * binding survives an instrument being put away and fetched back.
 *
 * Which makes this the piece that decides whether a Mac with the driver
 * installed lists every Launchpad VRMC can emulate all the time, or only the
 * ones somebody is playing. That was the original complaint.
 */
describe("device presence", () => {
  const present = (h: ReturnType<typeof harness>) =>
    h.frames.filter((f) => f.kind === FrameKind.DEVICE_STATE);

  it("marks a device present when its first port opens", () => {
    const h = harness();
    h.ports.open("LPProMK3 MIDI", PRO, 0);
    expect(present(h)).toEqual([
      { kind: FrameKind.DEVICE_STATE, address: encodeAddress(PRO, 0), payload: [1] },
    ]);
  });

  it("says so once, not once per port", () => {
    // A Pro MK3 opens three ports in a row. Three property writes would be
    // three moments where a DAW could see a half-built device.
    const h = harness();
    h.ports.open("a", PRO, 0);
    h.ports.open("b", PRO, 1);
    h.ports.open("c", PRO, 2);
    expect(present(h)).toHaveLength(1);
  });

  it("marks it absent only when the last port closes", () => {
    const h = harness();
    const a = h.ports.open("a", PRO, 0);
    const b = h.ports.open("b", PRO, 1);
    a.close();
    expect(present(h)).toHaveLength(1); // still just the arrival
    b.close();
    expect(present(h).at(-1)).toEqual({
      kind: FrameKind.DEVICE_STATE,
      address: encodeAddress(PRO, 0),
      payload: [0],
    });
  });

  it("keeps two devices' presence apart", () => {
    /*
     * Putting a Launchpad X away must not take a Pro MK3 with it. They are
     * separate devices to a DAW and separate bindings to a control-surface
     * script.
     */
    const h = harness();
    const x = h.ports.open("LPX DAW", X, 0);
    h.ports.open("LPProMK3 DAW", PRO, 2);
    x.close();

    const states = present(h);
    expect(states).toHaveLength(3);
    expect(states.at(-1)).toEqual({
      kind: FrameKind.DEVICE_STATE,
      address: encodeAddress(X, 0),
      payload: [0],
    });
    // The Pro MK3 was never told to go away.
    expect(
      states.filter((s) => deviceOf(s.address) === PRO && s.payload[0] === 0),
    ).toHaveLength(0);
  });

  it("addresses presence at the device, whichever port triggered it", () => {
    // The port half is unused for this frame; sending it with a stray port
    // would still decode to the right device, but only by luck.
    const h = harness();
    h.ports.open("the DAW port", PRO, 2);
    expect(portOf(present(h)[0]!.address)).toBe(0);
    expect(deviceOf(present(h)[0]!.address)).toBe(PRO);
  });

  it("marks a device present again after it was put away", () => {
    // Spawning, removing and respawning is what the wrist menu does.
    const h = harness();
    h.ports.open("a", PRO, 0).close();
    h.ports.open("a", PRO, 0);
    expect(present(h).map((f) => f.payload[0])).toEqual([1, 0, 1]);
  });

  it("clears everything on teardown", () => {
    const h = harness();
    h.ports.open("a", PRO, 0);
    h.ports.open("b", X, 0);
    h.ports.clear();
    const gone = present(h).filter((f) => f.payload[0] === 0);
    expect(gone.map((f) => deviceOf(f.address)).sort()).toEqual([PRO, X].sort());
  });
});
