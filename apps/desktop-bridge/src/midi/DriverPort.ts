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
    private readonly port: number,
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
    this.link.sendMidi(this.port, this.three.subarray(0, length));
  }

  sendRaw(bytes: Uint8Array): void {
    this.link.sendMidi(this.port, bytes);
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
  private readonly sources = new Map<number, DriverSourceEnd>();

  constructor(private readonly link: DriverLink) {}

  /** Hand incoming MIDI to whichever port it was addressed to. */
  deliver(port: number, data: Uint8Array): void {
    this.sources.get(port)?.onMessage?.(data);
  }

  /** A port backed by entity `index` of the driver's device. */
  open(name: string, index: number): VirtualPort {
    const source = new DriverSourceEnd(name);
    this.sources.set(index, source);
    const sink = new DriverSink(name, this.link, index);
    return {
      name,
      sink,
      source,
      close: () => {
        this.sources.delete(index);
        source.close();
        sink.close();
      },
    };
  }

  /** Forget every port, for when the device is torn down. */
  clear(): void {
    for (const source of this.sources.values()) source.close();
    this.sources.clear();
  }
}
