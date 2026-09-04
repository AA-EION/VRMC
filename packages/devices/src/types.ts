// SPDX-License-Identifier: GPL-3.0-only

/**
 * Device identity and layout, shared by the emulator, the bridge and the
 * renderer.
 *
 * Identity matters more than it looks. A DAW does not ask "are you a
 * Launchpad?" — it matches the MIDI port name, and then confirms with a
 * Universal Device Inquiry whose reply carries a family code. Get either wrong
 * and Ableton's Launchpad script simply never binds, with no error anywhere.
 * The constants here are what make the emulation recognisable.
 */

export const DeviceModel = {
  /** The original VRMC pad grid. Generic; no hardware identity. */
  PAD_GRID: 'pad-grid',
  /** The original VRMC piano keyboard. Generic. */
  KEYBOARD: 'keyboard',
  LAUNCHPAD_X: 'launchpad-x',
  LAUNCHPAD_PRO_MK3: 'launchpad-pro-mk3',
  /** Novation Launchkey MK3 49: keys, pads, knobs and faders. */
  LAUNCHKEY_MK3_49: 'launchkey-mk3-49',
} as const;
export type DeviceModel = (typeof DeviceModel)[keyof typeof DeviceModel];

/** What a button does, so the renderer can label and colour it sensibly. */
export const ButtonRole = {
  /** One of the 8x8 RGB pads. */
  GRID: 'grid',
  /** Top row: transport and layout selection. */
  FUNCTION: 'function',
  /** Right column: scene launch. */
  SCENE: 'scene',
  /** Left column: mode selection (Pro MK3). */
  MODE: 'mode',
  /** Bottom row: track select (Pro MK3). */
  TRACK: 'track',
  /** The illuminated logo. Output only — it is not a button. */
  LOGO: 'logo',
  /** A rotary control. Continuous, not a press. */
  KNOB: 'knob',
  /** A linear control. Continuous, not a press. */
  FADER: 'fader',
  /** A piano key. */
  KEY: 'key',
  /** Transport and mode buttons that are not on the grid. */
  TRANSPORT: 'transport',
} as const;
export type ButtonRole = (typeof ButtonRole)[keyof typeof ButtonRole];

/** How a control reports being pressed. */
export const ControlKind = {
  /** Note On / Note Off, velocity sensitive. */
  NOTE: 'note',
  /** Control Change, 127 on press and 0 on release. */
  CC: 'cc',
  /** Lights only; never sends. */
  OUTPUT_ONLY: 'output',
} as const;
export type ControlKind = (typeof ControlKind)[keyof typeof ControlKind];

/**
 * One addressable control.
 *
 * `index` is the device's own LED/button number — the "XY" value, where the
 * 8x8 grid is `row * 10 + column` with row 1 at the bottom. Both the LED SysEx
 * and the note/CC messages use this same number, which is what makes the
 * scheme worth keeping rather than translating to a dense array.
 */
export interface Control {
  /**
   * The control's id on this device: what an LED addresses and what the
   * headset sends back when it is touched.
   *
   * On a Launchpad this is also the MIDI data byte, because its controls live
   * in one XY namespace and the hardware sends that number directly. On a
   * device with both notes and CCs it cannot be: a Launchkey's key 41 and its
   * sixth fader both send 41, one as a note and one as a CC, and seventeen
   * such pairs collide. Ids are unique; `data1` is what goes on the wire.
   */
  index: number;
  /**
   * The MIDI data byte this control sends, when that differs from its id.
   *
   * Absent means they are the same, which is every Launchpad control and is
   * why nothing had to say so until a keyboard arrived.
   */
  data1?: number;
  kind: ControlKind;
  role: ButtonRole;
  /** Column 0..8 from the left, for layout. */
  col: number;
  /** Row 0..8 from the bottom, for layout. */
  row: number;
  /** Short label, e.g. "Session" or ">". Empty for plain grid pads. */
  label: string;
}

export interface DeviceSpec {
  model: DeviceModel;
  /** Shown in the headset UI. */
  displayName: string;

  // --- Hardware identity ---
  /** USB vendor id. Informational; a virtual port cannot present one. */
  usbVendorId: number;
  usbProductId: number;
  /** Byte 5 of the Novation SysEx header, after `F0 00 20 29 02`. */
  sysexDeviceId: number;
  /**
   * Family code in the Device Inquiry reply, little-endian pair. This is what a
   * DAW reads to decide which control-surface script to load.
   */
  familyCode: readonly [number, number];
  /** Firmware version reported in the inquiry reply. */
  firmwareVersion: readonly [number, number, number];

  /**
   * The USB manufacturer string, as the hardware reports it.
   *
   * Not decoration: on macOS this is published as the endpoint's
   * `kMIDIPropertyManufacturer`, which is one of the few identity fields a
   * virtual endpoint is allowed to carry. Taken from CoreFW's per-model
   * `usb.rs`, where it is the same for every Launchpad.
   */
  manufacturer: string;

  /**
   * MIDI port names, in the order the hardware presents them.
   *
   * Real Launchpads expose two ports: a "DAW" port carrying the session
   * protocol and a "MIDI" port behaving as a plain instrument. Ableton looks
   * for both by name, so the emulation creates both.
   *
   * The order is not presentational. A USB-MIDI device's ports are cables on
   * one endpoint pair, and a host enumerates them by cable index — so this
   * array is a claim about the descriptor, and it was wrong: it had MIDI first
   * until it was checked against
   * [CoreFW](https://github.com/anthonyhfm/launchpad-core-firmware), whose jack
   * table puts the DAW jack on cable 0 for all six models. `dawPortIndex` is
   * therefore 0 everywhere, and a test asserts that rather than leaving it to
   * each spec to get right.
   */
  portNames: readonly string[];
  /**
   * Per-direction port names, when the hardware names them differently.
   *
   * The Launchpads call a port the same thing whichever way MIDI is flowing —
   * `LPX DAW` is both the source and the destination. A Launchkey does not: its
   * endpoints are `LKMK3 DAW Out` and `LKMK3 DAW In`, named from the *device's*
   * point of view, so what a DAW lists as an input is the one called "Out".
   *
   * Absent means `portNames` is used for both, which is the common case. When
   * present the arrays run parallel to `portNames`.
   *
   * `source` is what the device sends *from* — a host's input. `destination` is
   * what it receives *on* — a host's output. Naming them by role rather than by
   * direction is deliberate: "in" and "out" mean opposite things depending on
   * which end of the cable you are standing at, and that ambiguity is exactly
   * what makes these two arrays easy to swap.
   */
  portNamesByDirection?: {
    readonly source: readonly string[];
    readonly destination: readonly string[];
  };
  /** Index into `portNames` of the port the DAW protocol runs on. */
  dawPortIndex: number;

  // --- Surface ---
  controls: readonly Control[];
  /** Grid width in pads, excluding the surrounding buttons. */
  gridSize: number;
  /**
   * Grid height in pads, when it is not square.
   *
   * Absent means square, which every Launchpad is. A Launchkey's pads are two
   * rows of eight, and anything reading only `gridSize` would draw it as an
   * 8x8 — sixty-four pads where there are sixteen.
   */
  padRows?: number;
  /** Whether the pads report polyphonic aftertouch. */
  polyAftertouch: boolean;
  /** Whether the pads are velocity sensitive. */
  velocitySensitive: boolean;

  // --- Physical dimensions, in metres, for the XR renderer ---
  padSize: number;
  padGap: number;
  /** Corner radius of a grid pad, as a fraction of pad size. */
  padRadius: number;
}

/** Novation's SysEx manufacturer id. */
export const NOVATION_SYSEX_ID = [0x00, 0x20, 0x29] as const;

/** Launchpad operating modes. */
export const LaunchpadMode = {
  /**
   * The device runs its own session behaviour and lights its own LEDs.
   * Ableton drives this mode over the DAW port.
   */
  LIVE: 0,
  /**
   * Every control reports its XY number and every LED is host-controlled.
   * This is the mode custom software asks for.
   */
  PROGRAMMER: 1,
} as const;
export type LaunchpadMode = (typeof LaunchpadMode)[keyof typeof LaunchpadMode];

/** LED lighting types in the `0x03` SysEx command. */
export const LightingType = {
  STATIC: 0,
  FLASHING: 1,
  PULSING: 2,
  RGB: 3,
} as const;
