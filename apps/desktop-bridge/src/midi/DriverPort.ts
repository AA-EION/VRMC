// SPDX-License-Identifier: GPL-3.0-only

/**
 * The driver's ports, dressed as the ports everything else already uses.
 *
 * WHY THIS IS A `VirtualPort`
 * Because then nothing above it changes. `DeviceManager`, the emulator, the
 * note tracker and the roster all speak `VirtualPort`, and whether a Launchpad's
 * MIDI reaches a DAW through a virtual endpoint or through the CoreMIDI driver
 * is a detail of *how the port was opened*. Threading a second concept up
 * through all of that would be a much larger change for no behaviour.
 *
 * WHAT IS DIFFERENT, AND IT IS THE WHOLE POINT
 * A virtual endpoint has no device behind it, so three of them are three
 * devices in a DAW's list. The driver's three are entities of one device, the
 * way the hardware is. Same interface, better presentation.
 *
 * WHEN THE LINK IS DOWN
 * Sends return quietly rather than throwing. The driver comes and goes with
 * MIDIServer, which is launched on demand and exits when idle, so "not
 * connected right now" is an ordinary moment rather than a fault — and a note
 * that throws on its way to a DAW would take a performance down.
 */

import type { DriverLink } from "./DriverLink.js";
import type { MidiSink, MidiSource, VirtualPort } from "./MidiSink.js";
import type { PortOptions, PortResult } from "./openPort.js";
import {
  FrameKind,
  MAX_PORTS_PER_DEVICE,
  encodeAddress,
} from "./driverFraming.js";
import { HARDWARE_MODELS } from "@vrmc/devices";

class DriverSink implements MidiSink {
  readonly backend = "coremidi-driver";
  /**
   * False, and deliberately.
   *
   * `virtual` means "a port this process invented", and these are not — they
   * belong to a device the driver publishes, which outlives this process and
   * which a DAW sees whether the bridge is running or not. Reporting them as
   * virtual would make the startup banner claim something untrue.
   */
  readonly virtual = false;

  constructor(
    readonly name: string,
    private readonly link: DriverLink,
    /** `(device << 4) | port` — see `encodeAddress`. */
    private readonly address: number,
  ) {}

  /**
   * One channel-voice message.
   *
   * The three bytes go into a buffer that belongs to this sink rather than a
   * fresh array: this is the per-note path, and a pad roll is a few hundred a
   * second. Safe because `sendMidi` copies into the frame before returning.
   */
  private readonly three = new Uint8Array(3);

  send(status: number, d1: number, d2: number): void {
    // Two-byte messages carry no d2, and sending a third byte would leave the
    // host one byte out of step for everything after it.
    const length = status >= 0xc0 && status < 0xe0 ? 2 : 3;
    this.three[0] = status;
    this.three[1] = d1;
    this.three[2] = d2;
    this.link.sendMidi(this.address, this.three.subarray(0, length));
  }

  sendRaw(bytes: Uint8Array): void {
    this.link.sendMidi(this.address, bytes);
  }

  close(): void {
    // Nothing to close: the endpoints belong to the driver, and the link is
    // shared by every port. Tearing either down here would take the other
    // ports with it.
  }
}

class DriverSourceEnd implements MidiSource {
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  constructor(readonly name: string) {}
  close(): void {
    this.onMessage = null;
  }
}

/**
 * The set of ports one driver-published device offers.
 *
 * Owns the port-index-to-source mapping, because MIDI arriving from a DAW
 * carries only an index and something has to know which `onMessage` that is.
 */
export class DriverPorts {
  /** Keyed by the packed address, so two devices' port 0 stay apart. */
  private readonly sources = new Map<number, DriverSourceEnd>();
  /** How many ports each device has open, so presence follows the last one. */
  private readonly openPorts = new Map<number, number>();

  constructor(private readonly link: DriverLink) {}

  /** Hand incoming MIDI to whichever port it was addressed to. */
  deliver(address: number, data: Uint8Array): void {
    this.sources.get(address)?.onMessage?.(data);
  }

  /** A port backed by entity `port` of the driver's device `device`. */
  open(name: string, device: number, port: number): VirtualPort {
    const address = encodeAddress(device, port);
    const source = new DriverSourceEnd(name);
    this.sources.set(address, source);
    const sink = new DriverSink(name, this.link, address);

    /*
     * The device appears to a DAW when its first port opens and goes away with
     * its last, rather than on every port.
     *
     * A Launchpad Pro MK3 opens three ports in a row, and telling the driver
     * three times would be three property writes and three moments where a DAW
     * could see a half-built device. Counting is also what makes the closing
     * side right: the device is only absent once every port has gone.
     */
    const before = this.openPorts.get(device) ?? 0;
    this.openPorts.set(device, before + 1);
    if (before === 0) this.setPresent(device, true);

    return {
      name,
      sink,
      source,
      close: () => {
        this.sources.delete(address);
        const left = (this.openPorts.get(device) ?? 1) - 1;
        if (left <= 0) {
          this.openPorts.delete(device);
          this.setPresent(device, false);
        } else {
          this.openPorts.set(device, left);
        }
        source.close();
        sink.close();
      },
    };
  }

  /**
   * Tell the driver whether a DAW should see this device at all.
   *
   * The driver publishes every model it supports at load and marks them
   * absent; this is what turns one on. Without it a Mac with the driver
   * installed would list every Launchpad VRMC can emulate, all the time,
   * whether or not anybody was holding one — the same complaint the ports
   * following the headset was built to answer.
   */
  private setPresent(device: number, present: boolean): void {
    this.link.sendFrame(
      FrameKind.DEVICE_STATE,
      encodeAddress(device, 0),
      Uint8Array.of(present ? 1 : 0),
    );
  }

  /** Forget every port, for when everything is torn down. */
  clear(): void {
    for (const source of this.sources.values()) source.close();
    this.sources.clear();
    for (const device of this.openPorts.keys()) this.setPresent(device, false);
    this.openPorts.clear();
  }
}

/**
 * The models the driver publishes, in the order that is their device index.
 *
 * Generated into the driver from these same specs — see
 * build/driverVectors.mjs, which writes native/coremidi-driver/src/Devices.h —
 * so this list and the driver's are the same list rather than two that must be
 * kept in step by hand. The index here is the device half of the address byte.
 */
export const DRIVER_MODELS: readonly string[] = HARDWARE_MODELS;

/** The device index for a model, or -1 if the driver does not publish it. */
export function driverDeviceIndex(model: string | undefined): number {
  if (model === undefined) return -1;
  return DRIVER_MODELS.indexOf(model);
}

/**
 * Route a port through the driver when that is possible, and to a virtual port
 * otherwise.
 *
 * Wrapping `openBidirectionalPort` rather than replacing it, because "is the
 * driver installed and connected right now" is a question with a different
 * answer minute to minute: MIDIServer loads the driver on demand and exits when
 * idle. A bridge that decided once at startup would open virtual ports for a
 * whole session because the driver happened to be asleep when it looked.
 */
export function driverAwareOpener(
  ports: DriverPorts,
  link: { readonly connected: boolean },
  fallback: (options: PortOptions) => Promise<PortResult>,
): (options: PortOptions) => Promise<PortResult> {
  return async (options) => {
    const device = driverDeviceIndex(options.model);
    const port = options.portIndex;
    if (
      !link.connected ||
      options.noMidi ||
      device < 0 ||
      port === undefined ||
      port >= MAX_PORTS_PER_DEVICE
    ) {
      return fallback(options);
    }
    return {
      port: ports.open(options.name, device, port),
      ok: true,
      notes: ["through the CoreMIDI driver, as one device"],
    };
  };
}
