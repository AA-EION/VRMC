// SPDX-License-Identifier: GPL-3.0-only

import { nearestPaletteIndex, paletteB, paletteG, paletteR } from './palette.js';
import {
  Command,
  buildInquiryReply,
  buildModeMessage,
  commandOf,
  isDeviceInquiry,
  parseLedMessage,
  readScrollText,
} from './sysex.js';
import { controlLookup, isGridIndex } from './layout.js';
import {
  ControlKind,
  LaunchpadMode,
  LightingType,
  type DeviceSpec,
} from './types.js';

/** Notified when the surface's appearance or state changes. */
export interface EmulatorObserver {
  /**
   * An LED changed. Channels are 6-bit.
   *
   * `blink` is 0 for steady, 1 for flashing and 2 for pulsing. The renderer
   * animates those itself rather than the emulator ticking them — animation is
   * a frame-rate concern and belongs where the frames are.
   */
  onLed(ledIndex: number, r: number, g: number, b: number, blink: number): void;
  /** Bytes to send to the host on the DAW port. */
  onMidiOut(bytes: Uint8Array): void;
  /** The device switched between Live and Programmer mode. */
  onModeChange?(mode: number): void;
  /**
   * The host sent text for the device to display.
   *
   * Real hardware scrolls this across the grid. There is nothing to scroll it
   * across here — the grid is showing the DAW's own colours — so it is passed
   * up to be shown as a label instead, which is more legible than a Launchpad
   * has ever managed.
   */
  onText?(text: string): void;
}

const LED_SLOTS = 110;
/** Per LED: r, g, b, blink type, alternate palette index for flashing. */
const LED_STRIDE = 5;

/**
 * A Launchpad, as far as the host can tell.
 *
 * Holds the LED state and speaks the device's half of the conversation: it
 * answers the Device Inquiry that makes a DAW recognise it, tracks Live versus
 * Programmer mode, applies every LED write the host sends, and turns physical
 * presses into the notes and CCs the hardware would have sent.
 *
 * Deliberately transport-agnostic and free of timers. It is driven by the
 * bridge on the desktop, but the same class runs in the headset to predict what
 * the surface should look like, and neither copy should be able to drift from
 * the other because one of them had a clock.
 */
export class LaunchpadEmulator {
  readonly spec: DeviceSpec;

  /** r,g,b,blink,alt per LED index, addressed by the device's own XY number. */
  private readonly leds = new Uint8Array(LED_SLOTS * LED_STRIDE);
  /** XY index -> position in spec.controls. */
  private readonly lookup: Int16Array;
  private readonly observer: EmulatorObserver;

  private mode: number = LaunchpadMode.LIVE;

  /** Pads currently held, so a reset can release them. */
  private readonly pressed = new Uint8Array(LED_SLOTS);

  /** Scratch for outgoing 3-byte messages; reused to avoid per-note garbage. */
  private readonly out3 = new Uint8Array(3);

  constructor(spec: DeviceSpec, observer: EmulatorObserver) {
    this.spec = spec;
    this.observer = observer;
    this.lookup = controlLookup(spec.controls);
  }

  get currentMode(): number {
    return this.mode;
  }

  /** True if this XY index is a control on this device. */
  hasControl(ledIndex: number): boolean {
    return ledIndex >= 0 && ledIndex < this.lookup.length && this.lookup[ledIndex]! >= 0;
  }

  /** Current colour of an LED, 6-bit, written into `out` at `offset`. */
  readLed(ledIndex: number, out: Uint8Array, offset: number): void {
    const b = ledIndex * LED_STRIDE;
    out[offset] = this.leds[b]!;
    out[offset + 1] = this.leds[b + 1]!;
    out[offset + 2] = this.leds[b + 2]!;
  }

  /** Blink type of an LED: 0 steady, 1 flashing, 2 pulsing. */
  blinkOf(ledIndex: number): number {
    return this.leds[ledIndex * LED_STRIDE + 3]!;
  }

  // --- Host -> device ---

  /**
   * Handle one complete MIDI message from the host.
   *
   * Accepts both channel-voice messages and SysEx. Running status is not
   * handled: USB-MIDI frames every message with its own status byte, and this
   * emulator sits behind a bridge that does the same.
   */
  handleHostMessage(data: Uint8Array): void {
    if (data.length === 0) return;

    if (data[0] === 0xf0) {
      this.handleSysEx(data);
      return;
    }

    if (data.length < 3) return;
    const status = data[0]! & 0xf0;
    const channel = data[0]! & 0x0f;
    const d1 = data[1]!;
    const d2 = data[2]!;

    // Note Off, on any channel, extinguishes the LED.
    if (status === 0x80) {
      this.setPalette(d1, 0, LightingType.STATIC);
      return;
    }

    // Note On and Control Change both light an LED from the velocity byte,
    // selecting a palette entry. This is how Ableton lights most of the grid —
    // an emulator that only implemented the RGB SysEx would sit dark through
    // normal use.
    //
    // The channel picks the behaviour, and the numbering is the trap: channel 1
    // is steady, channel 2 flashes and channel 3 pulses, which as zero-based
    // nibbles are 0, 1 and 2. Ableton uses all three — pulsing for a queued
    // clip, flashing for one that is recording — so treating every channel as
    // steady would lose the distinction a performer relies on.
    if (status === 0x90 || status === 0xb0) {
      const lighting =
        channel === 1
          ? LightingType.FLASHING
          : channel === 2
            ? LightingType.PULSING
            : LightingType.STATIC;
      this.setPalette(d1, d2, lighting);
    }
  }

  private handleSysEx(data: Uint8Array): void {
    if (isDeviceInquiry(data)) {
      // The handshake that makes the DAW load its Launchpad script.
      this.observer.onMidiOut(buildInquiryReply(this.spec));
      return;
    }

    const command = commandOf(data, this.spec);
    if (command < 0) return;

    switch (command) {
      case Command.MODE: {
        if (data.length >= 9) this.setMode(data[7]!);
        break;
      }
      case Command.LED: {
        parseLedMessage(data, this.spec, (led, type, palette, r, g, b, alt) => {
          if (type === LightingType.RGB) {
            this.writeLed(led, r, g, b, 0, 0);
          } else if (type === LightingType.FLASHING) {
            this.writeLed(led, paletteR(palette), paletteG(palette), paletteB(palette), 1, alt);
          } else {
            this.writeLed(
              led,
              paletteR(palette),
              paletteG(palette),
              paletteB(palette),
              type === LightingType.PULSING ? 2 : 0,
              palette,
            );
          }
        });
        break;
      }
      case Command.TEXT: {
        const text = readScrollText(data, this.spec);
        if (text !== null) this.observer.onText?.(text);
        break;
      }
      case Command.SELECT_LAYOUT:
        // Layout selection only changes what Live mode does internally; the
        // host still addresses LEDs the same way, so there is nothing to
        // emulate beyond not rejecting it.
        break;
      default:
        break;
    }
  }

  private setPalette(ledIndex: number, paletteIndex: number, blink: number): void {
    this.writeLed(
      ledIndex,
      paletteR(paletteIndex),
      paletteG(paletteIndex),
      paletteB(paletteIndex),
      blink === LightingType.STATIC ? 0 : blink === LightingType.FLASHING ? 1 : 2,
      paletteIndex,
    );
  }

  private writeLed(
    ledIndex: number,
    r: number,
    g: number,
    b: number,
    blink: number,
    alt: number,
  ): void {
    if (ledIndex < 0 || ledIndex >= LED_SLOTS) return;
    const base = ledIndex * LED_STRIDE;
    const leds = this.leds;
    if (
      leds[base] === r &&
      leds[base + 1] === g &&
      leds[base + 2] === b &&
      leds[base + 3] === blink
    ) {
      return; // unchanged; do not wake the renderer
    }
    leds[base] = r;
    leds[base + 1] = g;
    leds[base + 2] = b;
    leds[base + 3] = blink;
    leds[base + 4] = alt;
    this.observer.onLed(ledIndex, r, g, b, blink);
  }

  setMode(mode: number): void {
    const next = mode === LaunchpadMode.PROGRAMMER ? LaunchpadMode.PROGRAMMER : LaunchpadMode.LIVE;
    if (next === this.mode) return;
    this.mode = next;
    // Real hardware clears the surface when the mode changes; matching that
    // avoids leaving stale Live-mode lighting under a programmer-mode app.
    this.clearAllLeds();
    this.observer.onModeChange?.(next);
  }

  /** Ask the host to put the device into a mode. Used when re-syncing. */
  requestMode(mode: number): void {
    this.observer.onMidiOut(buildModeMessage(this.spec, mode));
  }

  clearAllLeds(): void {
    for (let i = 0; i < LED_SLOTS; i++) {
      const base = i * LED_STRIDE;
      if (
        this.leds[base] === 0 &&
        this.leds[base + 1] === 0 &&
        this.leds[base + 2] === 0 &&
        this.leds[base + 3] === 0
      ) {
        continue;
      }
      this.leds[base] = 0;
      this.leds[base + 1] = 0;
      this.leds[base + 2] = 0;
      this.leds[base + 3] = 0;
      this.observer.onLed(i, 0, 0, 0, 0);
    }
  }

  // --- Device -> host ---

  /**
   * Report a press. `velocity` is 1..127; the CC controls send 127 regardless,
   * as the hardware's non-pad buttons are switches rather than sensors.
   */
  press(ledIndex: number, velocity: number): void {
    const control = this.controlAt(ledIndex);
    if (control === null || control.kind === ControlKind.OUTPUT_ONLY) return;
    this.pressed[ledIndex] = 1;
    const v = velocity < 1 ? 1 : velocity > 127 ? 127 : velocity;
    this.emit(
      control.kind === ControlKind.CC ? 0xb0 : 0x90,
      ledIndex,
      control.kind === ControlKind.CC ? 127 : v,
    );
  }

  release(ledIndex: number): void {
    const control = this.controlAt(ledIndex);
    if (control === null || control.kind === ControlKind.OUTPUT_ONLY) return;
    if (this.pressed[ledIndex] === 0) return;
    this.pressed[ledIndex] = 0;
    // The hardware sends Note On with velocity 0 for pad releases, not Note
    // Off. Some host scripts match on that exact shape.
    this.emit(control.kind === ControlKind.CC ? 0xb0 : 0x90, ledIndex, 0);
  }

  /** Polyphonic aftertouch from sustained finger pressure, 0..127. */
  aftertouch(ledIndex: number, pressure: number): void {
    if (!this.spec.polyAftertouch) return;
    if (!isGridIndex(ledIndex)) return;
    if (this.pressed[ledIndex] === 0) return;
    this.emit(0xa0, ledIndex, pressure < 0 ? 0 : pressure > 127 ? 127 : pressure);
  }

  /** Release everything held. Called when the device is removed or reset. */
  releaseAll(): void {
    for (let i = 0; i < LED_SLOTS; i++) {
      if (this.pressed[i] === 1) this.release(i);
    }
  }

  /** Nearest palette index to an LED's current colour, for host queries. */
  paletteOf(ledIndex: number): number {
    const base = ledIndex * LED_STRIDE;
    return nearestPaletteIndex(this.leds[base]!, this.leds[base + 1]!, this.leds[base + 2]!);
  }

  private controlAt(ledIndex: number): DeviceSpec['controls'][number] | null {
    if (ledIndex < 0 || ledIndex >= this.lookup.length) return null;
    const at = this.lookup[ledIndex]!;
    return at < 0 ? null : this.spec.controls[at]!;
  }

  private emit(status: number, data1: number, data2: number): void {
    this.out3[0] = status;
    this.out3[1] = data1 & 0x7f;
    this.out3[2] = data2 & 0x7f;
    this.observer.onMidiOut(this.out3);
  }
}
