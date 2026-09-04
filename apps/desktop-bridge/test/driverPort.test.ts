// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, vi } from "vitest";
import {
  DRIVER_MODEL,
  DRIVER_PORT_COUNT,
  DriverPorts,
  driverAwareOpener,
} from "../src/midi/DriverPort.js";
import { LAUNCHPAD_PRO_MK3, specFor } from "@vrmc/devices";
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
  const link = {
    sendMidi: (port: number, data: Uint8Array) => {
      sent.push({ port, data: [...data] });
      return true;
    },
  } as unknown as DriverLink;
  return { ports: new DriverPorts(link), sent };
}

describe("sending to a DAW", () => {
  it("sends a note on the entity the port was opened for", () => {
    const h = harness();
    const daw = h.ports.open("LPProMK3 DAW", 2);
    daw.sink.send(0x90, 60, 100);
    expect(h.sent).toEqual([{ port: 2, data: [0x90, 60, 100] }]);
  });

  it("keeps two ports apart", () => {
    /*
     * The Pro MK3's MIDI port and DAW port carry unrelated conversations — one
     * is notes, the other the control-surface protocol. Crossing them would
     * make a DAW's script see note data and a track see SysEx.
     */
    const h = harness();
    const midi = h.ports.open("LPProMK3 MIDI", 0);
    const daw = h.ports.open("LPProMK3 DAW", 2);
    midi.sink.send(0x90, 60, 1);
    daw.sink.send(0xb0, 7, 2);
    expect(h.sent).toEqual([
      { port: 0, data: [0x90, 60, 1] },
      { port: 2, data: [0xb0, 7, 2] },
    ]);
  });

  it("sends two bytes for the messages that have two", () => {
    // Program change and channel pressure carry no second data byte. A third
    // byte would leave the host one out of step for everything after it.
    const h = harness();
    const port = h.ports.open("p", 0);
    port.sink.send(0xc0, 5, 0);
    port.sink.send(0xd0, 64, 0);
    expect(h.sent.map((s) => s.data)).toEqual([
      [0xc0, 5],
      [0xd0, 64],
    ]);
  });

  it("still sends three for the messages that have three", () => {
    const h = harness();
    const port = h.ports.open("p", 0);
    for (const status of [0x80, 0x90, 0xa0, 0xb0, 0xe0]) {
      port.sink.send(status, 1, 2);
    }
    expect(h.sent.every((s) => s.data.length === 3)).toBe(true);
  });

  it("carries SysEx whole, which is how a Launchpad is lit", () => {
    const h = harness();
    const port = h.ports.open("p", 2);
    const sysex = Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x03, 0xf7);
    port.sink.sendRaw?.(sysex);
    expect(h.sent[0]!.data).toEqual([...sysex]);
  });

  it("does not reuse one buffer across two sends in a way that corrupts them", () => {
    // The three-byte buffer is reused per sink on purpose — this is the
    // per-note path. That is only safe because the link copies before
    // returning, so this pins the assumption rather than leaving it implied.
    const h = harness();
    const port = h.ports.open("p", 1);
    port.sink.send(0x90, 60, 100);
    port.sink.send(0x90, 62, 20);
    expect(h.sent).toEqual([
      { port: 1, data: [0x90, 60, 100] },
      { port: 1, data: [0x90, 62, 20] },
    ]);
  });
});

describe("receiving from a DAW", () => {
  it("delivers to the port the message was addressed to", () => {
    const h = harness();
    const midi = h.ports.open("LPProMK3 MIDI", 0);
    const daw = h.ports.open("LPProMK3 DAW", 2);
    const onMidi = vi.fn();
    const onDaw = vi.fn();
    midi.source!.onMessage = onMidi;
    daw.source!.onMessage = onDaw;

    h.ports.deliver(2, Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7));
    expect(onDaw).toHaveBeenCalledTimes(1);
    expect(onMidi).not.toHaveBeenCalled();
  });

  it("drops a message for a port nobody opened, rather than throwing", () => {
    // The driver publishes three entities whether or not the bridge has opened
    // all three, so this is an ordinary arrival and not a fault.
    const h = harness();
    h.ports.open("p", 0);
    expect(() => h.ports.deliver(2, Uint8Array.of(0x90, 60, 1))).not.toThrow();
  });

  it("stops delivering to a closed port", () => {
    const h = harness();
    const port = h.ports.open("p", 1);
    const onMessage = vi.fn();
    port.source!.onMessage = onMessage;
    port.close();
    h.ports.deliver(1, Uint8Array.of(0x90, 60, 1));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("lets a port be reopened on the same entity after a close", () => {
    // A device removed and respawned is the ordinary case — the headset does
    // it — and a stale mapping would leave the new port silent.
    const h = harness();
    h.ports.open("p", 1).close();
    const again = h.ports.open("p", 1);
    const onMessage = vi.fn();
    again.source!.onMessage = onMessage;
    h.ports.deliver(1, Uint8Array.of(0x90, 60, 1));
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
    expect(h.ports.open("p", 0).sink.virtual).toBe(false);
  });

  it("names its backend, so a log says which route the MIDI took", () => {
    const h = harness();
    expect(h.ports.open("p", 0).sink.backend).toBe("coremidi-driver");
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
    const a = h.ports.open("a", 0);
    const b = h.ports.open("b", 1);
    const onB = vi.fn();
    b.source!.onMessage = onB;

    a.close();

    b.sink.send(0x90, 60, 1);
    expect(h.sent).toEqual([{ port: 1, data: [0x90, 60, 1] }]);
    h.ports.deliver(1, Uint8Array.of(0xb0, 7, 9));
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
      model: DRIVER_MODEL,
      portIndex: 2,
      ...over,
    }) as never;

  it("uses the driver when it is connected and the model matches", async () => {
    const o = opener(true);
    const result = await o.open(options());
    expect(o.fallback).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    result.port.sink.send(0x90, 60, 1);
    expect(o.sent).toEqual([{ port: 2, data: [0x90, 60, 1] }]);
  });

  it("falls back to a virtual port when the driver is not connected", async () => {
    const o = opener(false);
    await o.open(options());
    expect(o.fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back for a model the driver does not publish", async () => {
    /*
     * The driver creates one fixed device, so a Launchpad X has no entity to
     * be carried on. Routing it through anyway would put an X's notes on a
     * device a DAW has been told is a Pro MK3.
     */
    const o = opener(true);
    await o.open(options({ model: "launchpad-x" }));
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

  it("falls back for a port index the driver's device does not have", async () => {
    // A spec with more ports than the driver publishes would otherwise address
    // an entity that is not there, and the MIDI would go nowhere silently.
    const o = opener(true);
    await o.open(options({ portIndex: DRIVER_PORT_COUNT }));
    expect(o.fallback).toHaveBeenCalledTimes(1);
  });

  it("matches the port count of the spec it claims to carry", () => {
    /*
     * The bridge addresses the driver's entities by the *spec's* port index, so
     * these two numbers being equal is what makes that addressing correct. They
     * live in different files in different languages, so assert it rather than
     * trusting both to be edited together.
     */
    expect(LAUNCHPAD_PRO_MK3.portNames).toHaveLength(DRIVER_PORT_COUNT);
    expect(specFor(DRIVER_MODEL)).not.toBeNull();
  });
});
