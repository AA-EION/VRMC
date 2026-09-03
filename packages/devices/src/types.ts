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
  /** Device LED/button number. */
  index: number;
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
  /** Index into `portNames` of the port the DAW protocol runs on. */
  dawPortIndex: number;

  // --- Surface ---
  controls: readonly Control[];
  /** Grid width and height in pads, excluding the surrounding buttons. */
  gridSize: number;
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
