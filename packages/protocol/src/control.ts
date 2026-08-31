// SPDX-License-Identifier: GPL-3.0-only

import { HEADER_BYTES, LED_ENTRY_BYTES, MAX_CONTROL_BYTES } from './constants.js';
import type { PacketWriter } from './codec.js';

/**
 * Variable-length control frames: device lifecycle, LED updates, SysEx.
 *
 * These live apart from `codec.ts` on purpose. That file is the fixed-width
 * note path, where every byte position is known ahead of time and nothing
 * allocates. Control traffic is variable length and needs a cursor, so mixing
 * the two would drag the hot path's structure down to the slower one's.
 *
 * The LED path still matters for performance: a DAW redrawing a Launchpad grid
 * sends bursts of dozens of LEDs, and it happens while the user is playing. So
 * reading is visitor-based here too, with no per-LED object.
 */

/** How a device is doing on the bridge. */
export const DeviceStatus = {
  /** Requested; ports not open yet. */
  PENDING: 0,
  /** MIDI ports are open and the DAW can see it. */
  READY: 1,
  /** Could not create the ports. `detail` says why. */
  FAILED: 2,
} as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- DEVICE_ADD ---

/** Body: deviceId, model length, model name. */
export function writeDeviceAdd(w: PacketWriter, deviceId: number, model: string): boolean {
  const bytes = encoder.encode(model);
  if (bytes.length > 255) return false;
  return w.pushU8(deviceId) && w.pushU8(bytes.length) && w.pushRaw(bytes);
}

export interface DeviceAdd {
  deviceId: number;
  model: string;
}

export function readDeviceAdd(body: Uint8Array): DeviceAdd | null {
  if (body.length < 2) return null;
  const len = body[1]!;
  if (body.length < 2 + len) return null;
  return { deviceId: body[0]!, model: decoder.decode(body.subarray(2, 2 + len)) };
}

// --- DEVICE_REMOVE ---

export function writeDeviceRemove(w: PacketWriter, deviceId: number): boolean {
  return w.pushU8(deviceId);
}

export function readDeviceRemove(body: Uint8Array): number {
  return body.length >= 1 ? body[0]! : -1;
}

// --- DEVICE_STATE ---

export interface DeviceStateEntry {
  deviceId: number;
  status: number;
  model: string;
  /** Port names when ready, or the reason when failed. */
  detail: string;
}

export function writeDeviceState(w: PacketWriter, entries: readonly DeviceStateEntry[]): boolean {
  if (!w.pushU8(entries.length)) return false;
  for (const e of entries) {
    const model = encoder.encode(e.model);
    const detail = encoder.encode(e.detail.slice(0, 200));
    if (
      !w.pushU8(e.deviceId) ||
      !w.pushU8(e.status) ||
      !w.pushU8(model.length) ||
      !w.pushRaw(model) ||
      !w.pushU8(detail.length) ||
      !w.pushRaw(detail)
    ) {
      return false;
    }
  }
  return true;
}

export function readDeviceState(body: Uint8Array): DeviceStateEntry[] {
  const out: DeviceStateEntry[] = [];
  if (body.length < 1) return out;
  const count = body[0]!;
  let o = 1;
  for (let i = 0; i < count; i++) {
    if (o + 3 > body.length) break;
    const deviceId = body[o]!;
    const status = body[o + 1]!;
    const modelLen = body[o + 2]!;
    o += 3;
    if (o + modelLen > body.length) break;
    const model = decoder.decode(body.subarray(o, o + modelLen));
    o += modelLen;
    if (o >= body.length) break;
    const detailLen = body[o]!;
    o += 1;
    if (o + detailLen > body.length) break;
    const detail = decoder.decode(body.subarray(o, o + detailLen));
    o += detailLen;
    out.push({ deviceId, status, model, detail });
  }
  return out;
}

// --- LED_UPDATE ---

/**
 * Body: deviceId, u16 count, then `count` entries of
 * [ledIndex, r, g, b, blink]. Colour channels are 6-bit, as the hardware holds
 * them; widening to 8-bit is the renderer's job.
 */
export function writeLedHeader(w: PacketWriter, deviceId: number, count: number): boolean {
  return w.pushU8(deviceId) && w.pushU16(count);
}

export function writeLedEntry(
  w: PacketWriter,
  ledIndex: number,
  r: number,
  g: number,
  b: number,
  blink: number,
): boolean {
  return (
    w.pushU8(ledIndex) && w.pushU8(r) && w.pushU8(g) && w.pushU8(b) && w.pushU8(blink)
  );
}

/** Most LED entries that still fit after the header. */
export function ledCapacity(): number {
  return Math.floor((MAX_CONTROL_BYTES - HEADER_BYTES - 3) / LED_ENTRY_BYTES);
}

export type LedVisitor = (
  ledIndex: number,
  r: number,
  g: number,
  b: number,
  blink: number,
) => void;

/**
 * Walk an LED_UPDATE body. Returns the device id, or -1 if malformed.
 *
 * Allocation-free: the visitor takes primitives, so a 64-LED redraw costs no
 * garbage on the headset, where it lands mid-performance.
 */
export function readLedUpdate(body: Uint8Array, visit: LedVisitor): number {
  if (body.length < 3) return -1;
  const deviceId = body[0]!;
  const count = body[1]! | (body[2]! << 8);
  let o = 3;
  for (let i = 0; i < count; i++) {
    if (o + LED_ENTRY_BYTES > body.length) break;
    visit(body[o]!, body[o + 1]!, body[o + 2]!, body[o + 3]!, body[o + 4]!);
    o += LED_ENTRY_BYTES;
  }
  return deviceId;
}

// --- SYSEX ---

/** Body: deviceId, u16 length, raw bytes. */
export function writeSysEx(w: PacketWriter, deviceId: number, bytes: Uint8Array): boolean {
  return w.pushU8(deviceId) && w.pushU16(bytes.length) && w.pushRaw(bytes);
}

/**
 * Read a SysEx body.
 *
 * Returns a view aliasing `body`, valid only until the receive buffer is
 * reused. Callers that keep it must copy.
 */
export function readSysEx(body: Uint8Array): { deviceId: number; bytes: Uint8Array } | null {
  if (body.length < 3) return null;
  const len = body[1]! | (body[2]! << 8);
  if (body.length < 3 + len) return null;
  return { deviceId: body[0]!, bytes: body.subarray(3, 3 + len) };
}
