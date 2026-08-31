// SPDX-License-Identifier: GPL-3.0-only
//
// Message shapes derived from CoreFW's SysEx handlers
// (https://github.com/anthonyhfm/launchpad-core-firmware).

import { LightingType, NOVATION_SYSEX_ID, type DeviceSpec } from './types.js';

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;

/** Universal, non-realtime SysEx. Used by the Device Inquiry handshake. */
const UNIVERSAL_NON_REALTIME = 0x7e;
const GENERAL_INFORMATION = 0x06;
const IDENTITY_REQUEST = 0x01;
const IDENTITY_REPLY = 0x02;

/** Novation command bytes, following `F0 00 20 29 02 <deviceId>`. */
export const Command = {
  /** Select the active layout in Live mode. */
  SELECT_LAYOUT: 0x00,
  /** Set one or more LEDs. */
  LED: 0x03,
  /** Switch between Live and Programmer mode. */
  MODE: 0x0e,
} as const;

/**
 * Is this a Universal Device Inquiry?
 *
 * `F0 7E <device> 06 01 F7`. The device byte is a channel selector and is
 * usually 0x7F (all devices), so it is matched loosely.
 *
 * This handshake is how a DAW confirms what it is talking to. Ableton opens the
 * port, sends this, and binds its Launchpad script only if the reply carries the
 * right family code — so answering it correctly is the difference between
 * "recognised as a Launchpad" and "an unknown MIDI port".
 */
export function isDeviceInquiry(data: Uint8Array): boolean {
  return (
    data.length === 6 &&
    data[0] === SYSEX_START &&
    data[1] === UNIVERSAL_NON_REALTIME &&
    data[3] === GENERAL_INFORMATION &&
    data[4] === IDENTITY_REQUEST &&
    data[5] === SYSEX_END
  );
}

/**
 * Build the Device Inquiry reply for a device.
 *
 * `F0 7E 00 06 02 00 20 29 <family lsb> <family msb> 00 00 00 <v1> <v2> <v3> F7`
 */
export function buildInquiryReply(spec: DeviceSpec): Uint8Array {
  return Uint8Array.of(
    SYSEX_START,
    UNIVERSAL_NON_REALTIME,
    0x00,
    GENERAL_INFORMATION,
    IDENTITY_REPLY,
    ...NOVATION_SYSEX_ID,
    spec.familyCode[0],
    spec.familyCode[1],
    0x00,
    0x00,
    0x00,
    spec.firmwareVersion[0],
    spec.firmwareVersion[1],
    spec.firmwareVersion[2],
    SYSEX_END,
  );
}

/** True if `data` is a Novation message addressed to this device. */
export function isNovationMessage(data: Uint8Array, spec: DeviceSpec): boolean {
  return (
    data.length >= 7 &&
    data[0] === SYSEX_START &&
    data[1] === NOVATION_SYSEX_ID[0] &&
    data[2] === NOVATION_SYSEX_ID[1] &&
    data[3] === NOVATION_SYSEX_ID[2] &&
    data[4] === 0x02 &&
    data[5] === spec.sysexDeviceId &&
    data[data.length - 1] === SYSEX_END
  );
}

/** The Novation command byte, or -1 if this is not one of ours. */
export function commandOf(data: Uint8Array, spec: DeviceSpec): number {
  return isNovationMessage(data, spec) ? data[6]! : -1;
}

/** Build `F0 00 20 29 02 <id> 0E <mode> F7`. */
export function buildModeMessage(spec: DeviceSpec, mode: number): Uint8Array {
  return Uint8Array.of(
    SYSEX_START,
    ...NOVATION_SYSEX_ID,
    0x02,
    spec.sysexDeviceId,
    Command.MODE,
    mode & 0x7f,
    SYSEX_END,
  );
}

/**
 * Receives each LED write parsed out of a `0x03` message.
 *
 * `paletteIndex` is meaningful for STATIC and PULSING; `r`/`g`/`b` for RGB;
 * FLASHING carries two palette entries, passed as `paletteIndex` and `altIndex`.
 * All colour channels are 6-bit, as on the wire.
 */
export type LedWriteVisitor = (
  ledIndex: number,
  lightingType: number,
  paletteIndex: number,
  r: number,
  g: number,
  b: number,
  altIndex: number,
) => void;

/**
 * Parse a `0x03` LED message, invoking `visit` per LED.
 *
 * One message can carry many writes back to back, each prefixed by its lighting
 * type, and Ableton packs whole rows this way. The lengths differ per type, so
 * the walk has to be driven by the type byte rather than a fixed stride:
 *
 *   00 <led> <palette>              static
 *   01 <led> <colourA> <colourB>    flashing between two palette entries
 *   02 <led> <palette>              pulsing
 *   03 <led> <r> <g> <b>            explicit 6-bit RGB
 *
 * Returns the number of LED writes applied. A malformed tail stops the walk
 * rather than discarding the whole message: the writes already parsed were
 * valid, and dropping them would blank part of a grid the DAW believes it lit.
 */
export function parseLedMessage(
  data: Uint8Array,
  spec: DeviceSpec,
  visit: LedWriteVisitor,
): number {
  if (commandOf(data, spec) !== Command.LED) return 0;

  const end = data.length - 1; // exclusive: skip the trailing F7
  let i = 7;
  let applied = 0;

  while (i < end) {
    const type = data[i]!;
    if (i + 1 >= end) break;
    const led = data[i + 1]!;
    i += 2;

    switch (type) {
      case LightingType.STATIC:
      case LightingType.PULSING: {
        if (i >= end) return applied;
        visit(led, type, data[i]!, 0, 0, 0, 0);
        i += 1;
        applied++;
        break;
      }
      case LightingType.FLASHING: {
        if (i + 1 >= end) return applied;
        visit(led, type, data[i]!, 0, 0, 0, data[i + 1]!);
        i += 2;
        applied++;
        break;
      }
      case LightingType.RGB: {
        if (i + 2 >= end) return applied;
        // Channels are 6-bit; mask rather than trust the sender.
        visit(led, type, 0, data[i]! & 0x3f, data[i + 1]! & 0x3f, data[i + 2]! & 0x3f, 0);
        i += 3;
        applied++;
        break;
      }
      default:
        // An unknown lighting type makes the rest unparseable, since we no
        // longer know the stride.
        return applied;
    }
  }
  return applied;
}

/**
 * Build a `0x03` LED message setting explicit RGB on a run of LEDs.
 *
 * `entries` is packed as [ledIndex, r, g, b] repeating, with 6-bit channels.
 * Used to echo the emulator's state back to a host that asks for it.
 */
export function buildRgbLedMessage(spec: DeviceSpec, entries: Uint8Array): Uint8Array {
  const count = Math.floor(entries.length / 4);
  const out = new Uint8Array(8 + count * 5);
  let o = 0;
  out[o++] = SYSEX_START;
  out[o++] = NOVATION_SYSEX_ID[0];
  out[o++] = NOVATION_SYSEX_ID[1];
  out[o++] = NOVATION_SYSEX_ID[2];
  out[o++] = 0x02;
  out[o++] = spec.sysexDeviceId;
  out[o++] = Command.LED;
  for (let i = 0; i < count; i++) {
    const b = i * 4;
    out[o++] = LightingType.RGB;
    out[o++] = entries[b]! & 0x7f;
    out[o++] = entries[b + 1]! & 0x3f;
    out[o++] = entries[b + 2]! & 0x3f;
    out[o++] = entries[b + 3]! & 0x3f;
  }
  out[o++] = SYSEX_END;
  return out.subarray(0, o);
}
