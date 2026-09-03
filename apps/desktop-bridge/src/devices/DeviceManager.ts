// SPDX-License-Identifier: GPL-3.0-only

import {
  LaunchpadEmulator,
  specFor,
  type DeviceSpec,
  type EmulatorObserver,
} from "@vrmc/devices";
import {
  DeviceStatus,
  EventType,
  MidiStatus,
  statusForEventType,
  type DevicePlacement,
  type DeviceStateEntry,
} from "@vrmc/protocol";
import { NoteTracker } from "../midi/NoteTracker.js";
import type { VirtualPort } from "../midi/MidiSink.js";
import {
  openBidirectionalPort,
  type PortOptions,
  type PortResult,
} from "../midi/openPort.js";

/** What the manager reports upward, to be relayed to the headset. */
export interface DeviceEvents {
  /** An emulated device's LED changed. Channels are 6-bit. */
  onLed(
    deviceId: number,
    ledIndex: number,
    r: number,
    g: number,
    b: number,
    blink: number,
  ): void;
  /** A device sent SysEx that the headset may want (rare; mostly diagnostics). */
  onSysEx?(deviceId: number, bytes: Uint8Array): void;
  /** The host sent a device text to display. */
  onText?(deviceId: number, text: string): void;
  /** The roster changed and should be pushed to the headset. */
  onRosterChange(): void;
  onLog(message: string): void;
}

/** One live device: its ports, its emulator, and its note bookkeeping. */
interface DeviceInstance {
  id: number;
  model: string;
  spec: DeviceSpec | null;
  /** Ports in spec order. Generic devices get exactly one. */
  ports: VirtualPort[];
  /** The port carrying the DAW protocol; where the emulator's traffic goes. */
  dawPort: VirtualPort | null;
  emulator: LaunchpadEmulator | null;
  notes: NoteTracker;
  status: number;
  detail: string;
}

/** How the manager obtains a port. Swapped out in tests. */
export type PortOpener = (options: PortOptions) => Promise<PortResult>;

export interface DeviceManagerOptions {
  noMidi: boolean;
  loopbackPattern: RegExp;
  /**
   * Port factory. Defaults to the real platform backends.
   *
   * Injected so device creation can be exercised without a MIDI subsystem —
   * the interesting behaviour here is naming, lifecycle and routing, none of
   * which should need a sound card to test.
   */
  openPort?: PortOpener;
  /**
   * How an emulated device's ports are named.
   *
   * A DAW decides what a port is by its name, so this is functional rather than
   * cosmetic. The default puts the model first — "Launchpad X LPX DAW" — since
   * control-surface scripts generally match on the model name, and the endpoint
   * suffix is what distinguishes the two ports of one device.
   */
  portNameTemplate: string;
  /**
   * Where a device is, if anybody has said.
   *
   * Injected rather than stored here because placement outlives the device: the
   * Workspace keeps it across a remove and re-add, and across a restart of the
   * bridge itself. The manager owns ports and emulators; it has no business
   * also being the memory of where things sit in somebody's room.
   */
  placementOf?: (deviceId: number) => DevicePlacement | null;
}

export const DEFAULT_PORT_NAME_TEMPLATE = "{device} {port}";

/**
 * Creates and destroys virtual MIDI devices on demand.
 *
 * The headset is the source of truth: spawn a Launchpad there and this opens
 * real, correctly named MIDI ports so the DAW discovers it the way it would
 * discover hardware being plugged in; remove it and the ports close, which the
 * DAW sees as an unplug.
 *
 * Everything is torn down carefully rather than dropped. Closing a port with
 * notes still sounding leaves them stuck in the synth with nothing left to
 * release them, so a removal releases first and closes second.
 */
export class DeviceManager {
  private readonly devices = new Map<number, DeviceInstance>();
  /**
   * Extra ids that resolve to an existing device.
   *
   * The three original surfaces — pads, keys and knobs — are one MIDI port
   * between them, the way a single piece of hardware would be, but they keep
   * separate ids so events stay attributable. Aliasing lets both be true
   * without opening three ports that would collide on name.
   */
  private readonly aliases = new Map<number, number>();
  private readonly events: DeviceEvents;
  private readonly options: DeviceManagerOptions;
  private readonly openPort: PortOpener;

  constructor(events: DeviceEvents, options: DeviceManagerOptions) {
    this.events = events;
    this.options = options;
    this.openPort = options.openPort ?? openBidirectionalPort;
  }

  get count(): number {
    return this.devices.size;
  }

  /** Notes sounding across every device. */
  get activeNotes(): number {
    let total = 0;
    for (const d of this.devices.values()) total += d.notes.activeNotes;
    return total;
  }

  has(deviceId: number): boolean {
    return this.devices.has(this.resolve(deviceId));
  }

  /** Route `from` to the device registered as `to`. */
  alias(from: number, to: number): void {
    if (from === to) return;
    this.aliases.set(from, to);
  }

  private resolve(deviceId: number): number {
    return this.aliases.get(deviceId) ?? deviceId;
  }

  /** Roster for a DEVICE_STATE packet. */
  roster(): DeviceStateEntry[] {
    const out: DeviceStateEntry[] = [];
    for (const d of this.devices.values()) {
      out.push({
        deviceId: d.id,
        status: d.status,
        model: d.model,
        detail: d.detail,
        // Null when nobody has placed it, which is a real answer rather than a
        // missing one: the headset puts a never-placed device at its default
        // pose instead of at the player's feet.
        placement: this.options.placementOf?.(d.id) ?? null,
      });
    }
    return out.sort((a, b) => a.deviceId - b.deviceId);
  }

  /**
   * Create a device and its ports.
   *
   * Re-adding an existing id is treated as a no-op rather than an error: the
   * headset may resend the roster after a reconnect, and tearing a working
   * device down to rebuild it identically would make the DAW drop its binding.
   */
  async add(deviceId: number, model: string): Promise<void> {
    if (this.devices.has(deviceId)) return;

    const spec = specFor(model);
    const instance: DeviceInstance = {
      id: deviceId,
      model,
      spec,
      ports: [],
      dawPort: null,
      emulator: null,
      notes: new NoteTracker(),
      status: DeviceStatus.PENDING,
      detail: "",
    };
    this.devices.set(deviceId, instance);
    this.events.onRosterChange();

    const portNames =
      spec === null
        ? [model]
        : spec.portNames.map((p: string) => this.portName(spec, p));

    /*
     * What each endpoint should tell a host about itself.
     *
     * Manufacturer and model only. An earlier version also renamed the
     * endpoint to the bare "LPX (DAW)" and wrote the combined string to
     * `displayName` — which CoreMIDI refused, because the display name is
     * derived rather than stored, and which was unnecessary anyway: a virtual
     * endpoint has no device to combine with, so its display name *is* its own
     * name, and the name it is created with here is already the combined one.
     *
     * Null for a device with no spec: the plain surfaces are not pretending to
     * be hardware, and a port that advertises itself as Novation while
     * behaving as a nameless keyboard is worse than one that claims nothing.
     */
    const identities =
      spec === null
        ? portNames.map(() => null)
        : portNames.map(() => ({
            manufacturer: spec.manufacturer,
            model: spec.displayName,
          }));
    const opened: string[] = [];
    const failures: string[] = [];

    for (const [i, name] of portNames.entries()) {
      const result = await this.openPort({
        name,
        identity: identities[i] ?? null,
        noMidi: this.options.noMidi,
        loopbackPattern: this.options.loopbackPattern,
      } satisfies PortOptions);
      for (const note of result.notes)
        this.events.onLog(`[device ${deviceId}] ${note}`);
      if (result.ok) {
        instance.ports.push(result.port);
        opened.push(result.port.name);
      } else {
        failures.push(name);
        // Keep the port object so sends have somewhere to go; it is a null sink.
        instance.ports.push(result.port);
      }
    }

    if (spec !== null) {
      instance.dawPort =
        instance.ports[spec.dawPortIndex] ?? instance.ports[0] ?? null;
      instance.emulator = this.buildEmulator(instance, spec);
      this.wireInputs(instance, spec);
    } else {
      instance.dawPort = instance.ports[0] ?? null;
    }

    instance.status =
      failures.length === portNames.length
        ? DeviceStatus.FAILED
        : DeviceStatus.READY;
    instance.detail =
      instance.status === DeviceStatus.READY
        ? opened.join(", ")
        : `could not open ${failures.join(", ")}`;
    this.events.onRosterChange();
  }

  /** Destroy a device, releasing anything it was holding first. */
  remove(deviceId: number): boolean {
    const id = this.resolve(deviceId);
    const instance = this.devices.get(id);
    if (instance === undefined) return false;

    instance.emulator?.releaseAll();
    // Release through the port while it still exists. Once it is closed there
    // is nothing left to carry the Note Offs, and whatever was sounding stays
    // sounding until the DAW is restarted.
    if (instance.dawPort !== null) instance.notes.panic(instance.dawPort.sink);
    for (const port of instance.ports) port.close();

    this.devices.delete(id);
    for (const [from, to] of this.aliases) {
      if (to === id) this.aliases.delete(from);
    }
    this.events.onLog(`[device ${id}] removed (${instance.model})`);
    this.events.onRosterChange();
    return true;
  }

  /**
   * Remove everything, closing every port.
   *
   * Called by the presence gate when the last client has been gone for the
   * grace period, and on shutdown. This comment used to say "and when the
   * headset disconnects" while nothing was wired to a disconnect at all —
   * `onPeerChange` reported the count and index.ts discarded it — so the ports
   * outlived the session that owned them.
   */
  removeAll(): void {
    for (const id of [...this.devices.keys()]) this.remove(id);
  }

  /** Release sounding notes on every device without destroying them. */
  panicAll(): number {
    let released = 0;
    for (const d of this.devices.values()) {
      d.emulator?.releaseAll();
      if (d.dawPort !== null) released += d.notes.panic(d.dawPort.sink);
    }
    return released;
  }

  /**
   * Route one input event from the headset.
   *
   * Emulated devices take the XY control index in `data1` and go through their
   * emulator, so the exact wire shape the hardware would produce — Note On with
   * velocity 0 for a pad release, CC for the surrounding buttons — comes out
   * without the headset needing to know any of it. Generic devices pass
   * straight through as plain MIDI.
   */
  handleEvent(
    deviceId: number,
    type: number,
    channel: number,
    data1: number,
    data2: number,
    value14: number,
  ): void {
    const instance = this.devices.get(this.resolve(deviceId));
    if (instance === undefined) return;

    const emulator = instance.emulator;
    if (emulator !== null) {
      switch (type) {
        case EventType.NOTE_ON:
          emulator.press(data1, data2);
          return;
        case EventType.NOTE_OFF:
          emulator.release(data1);
          return;
        case EventType.AFTERTOUCH_POLY:
          emulator.aftertouch(data1, data2);
          return;
        default:
          return;
      }
    }

    const port = instance.dawPort;
    if (port === null) return;
    const ch = channel & 0x0f;
    if (type === EventType.NOTE_ON) {
      instance.notes.onNoteOn(ch, data1, data2);
      port.sink.send(MidiStatus.NOTE_ON | ch, data1, data2);
      return;
    }
    if (type === EventType.NOTE_OFF) {
      instance.notes.onNoteOff(ch, data1);
      port.sink.send(MidiStatus.NOTE_OFF | ch, data1, data2);
      return;
    }
    if (type === EventType.PITCH_BEND) {
      port.sink.send(
        MidiStatus.PITCH_BEND | ch,
        value14 & 0x7f,
        (value14 >> 7) & 0x7f,
      );
      return;
    }
    if (type === EventType.CONTROL_CHANGE_14) {
      port.sink.send(
        MidiStatus.CONTROL_CHANGE | ch,
        data1,
        (value14 >> 7) & 0x7f,
      );
      port.sink.send(
        MidiStatus.CONTROL_CHANGE | ch,
        (data1 + 32) & 0x7f,
        value14 & 0x7f,
      );
      return;
    }
    const status = statusForEventType(type);
    if (status !== 0) port.sink.send(status | ch, data1, data2);
  }

  /** Forward SysEx from the headset to a device's DAW port. */
  sendSysEx(deviceId: number, bytes: Uint8Array): void {
    const instance = this.devices.get(this.resolve(deviceId));
    const port = instance?.dawPort;
    if (port == null) return;
    // MidiSink is a three-byte channel-message interface; SysEx needs the raw
    // path, which only some backends expose.
    port.sink.sendRaw?.(bytes);
  }

  /** Names of the MIDI ports a device opened. For tests and diagnostics. */
  portNamesOf(deviceId: number): string[] {
    const instance = this.devices.get(this.resolve(deviceId));
    return instance === undefined ? [] : instance.ports.map((p) => p.name);
  }

  /** Feed a message to a device as if the host had sent it. For tests. */
  injectHostMessage(
    deviceId: number,
    portIndex: number,
    bytes: Uint8Array,
  ): boolean {
    const instance = this.devices.get(this.resolve(deviceId));
    const source = instance?.ports[portIndex]?.source;
    if (source?.onMessage == null) return false;
    source.onMessage(bytes);
    return true;
  }

  /** Every LED of a device, for a full resync after a headset reconnect. */
  forEachLed(
    deviceId: number,
    visit: (
      ledIndex: number,
      r: number,
      g: number,
      b: number,
      blink: number,
    ) => void,
  ): void {
    const instance = this.devices.get(this.resolve(deviceId));
    const emulator = instance?.emulator;
    const spec = instance?.spec;
    if (emulator == null || spec == null) return;
    const scratch = new Uint8Array(3);
    for (const control of spec.controls) {
      emulator.readLed(control.index, scratch, 0);
      visit(
        control.index,
        scratch[0]!,
        scratch[1]!,
        scratch[2]!,
        emulator.blinkOf(control.index),
      );
    }
  }

  private buildEmulator(
    instance: DeviceInstance,
    spec: DeviceSpec,
  ): LaunchpadEmulator {
    const observer: EmulatorObserver = {
      onLed: (ledIndex, r, g, b, blink) => {
        this.events.onLed(instance.id, ledIndex, r, g, b, blink);
      },
      onMidiOut: (bytes) => {
        const port = instance.dawPort;
        if (port === null) return;
        if (bytes.length >= 1 && bytes[0] === 0xf0) {
          port.sink.sendRaw?.(bytes);
          return;
        }
        if (bytes.length >= 3) {
          // Track notes so a disconnect can release them.
          const status = bytes[0]! & 0xf0;
          if (status === 0x90) {
            if (bytes[2] === 0)
              instance.notes.onNoteOff(bytes[0]! & 0x0f, bytes[1]!);
            else
              instance.notes.onNoteOn(bytes[0]! & 0x0f, bytes[1]!, bytes[2]!);
          }
          port.sink.send(bytes[0]!, bytes[1]!, bytes[2]!);
        }
      },
      onText: (text) => this.events.onText?.(instance.id, text),
      onModeChange: (mode) => {
        this.events.onLog(
          `[device ${instance.id}] ${spec.displayName} entered ${mode === 1 ? "Programmer" : "Live"} mode`,
        );
      },
    };
    return new LaunchpadEmulator(spec, observer);
  }

  /**
   * Feed host traffic into the emulator.
   *
   * Both ports are listened to. Real hardware answers a device inquiry on
   * whichever port it arrives on, and a host that probes the wrong one and
   * hears nothing will not bind its script.
   */
  private wireInputs(instance: DeviceInstance, spec: DeviceSpec): void {
    void spec;
    for (const port of instance.ports) {
      if (port.source === null) continue;
      port.source.onMessage = (bytes) => {
        instance.emulator?.handleHostMessage(bytes);
      };
    }
  }

  private portName(spec: DeviceSpec, portName: string): string {
    return this.options.portNameTemplate
      .replace("{device}", spec.displayName)
      .replace("{port}", portName)
      .replace("{model}", spec.model);
  }
}
