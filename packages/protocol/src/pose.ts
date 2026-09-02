// SPDX-License-Identifier: GPL-3.0-only

/**
 * Where a device sits in the room, on the wire.
 *
 * Shared by three kinds — `DEVICE_POSE`, the roster in `DEVICE_STATE`, and the
 * saved arrangements in `LAYOUT_STATE` — because all three are answering the
 * same question and a second encoding of it would be a second thing to keep in
 * step.
 *
 * ORIENTATION IS TWO NUMBERS, NOT FOUR
 * A quaternion would be the general answer and it is the wrong one here. What
 * it adds over yaw and tilt is roll, and a rolled Launchpad is a Launchpad you
 * cannot play: the grid stops being a grid the moment its rows stop being
 * level. Hand tracking will happily hand you thirty degrees of wrist roll that
 * the person holding the device never intended, so a format that cannot carry
 * roll is a format that cannot save it by accident either.
 *
 * The same reasoning is why this is a *pose* and not a transform. The renderer
 * and the poke detector both derive their matrices from it through
 * `surfaceTransform`, which is what keeps the surface you see and the surface
 * that answers your finger in the same place.
 */

import type { PacketWriter } from './codec.js';

/** Flag bits carried alongside a placement. */
export const PlacementFlags = {
  NONE: 0,
  /**
   * Grabs pass straight through this device.
   *
   * The point is not to protect a setting; it is that a hand playing a pad
   * grid is constantly inside the volume a grab test looks at, and without
   * this a fast roll eventually reads as someone taking hold of the
   * instrument and dragging it off the desk mid-phrase.
   */
  PINNED: 1 << 0,
  /**
   * The pose was resolved against a real surface rather than guessed.
   *
   * Kept so a reconnect can tell the difference between a device somebody put
   * on their actual desk and one that landed at a default height. The anchor
   * itself never crosses the wire — an `XRAnchor` means nothing outside the
   * session that created it — so this is the fact, not the handle.
   */
  ANCHORED: 1 << 1,
} as const;

/** One device's placement. */
export interface DevicePlacement {
  deviceId: number;
  flags: number;
  /** World position of the surface's centre, in metres. */
  centre: [number, number, number];
  /** Rotation about world Y, in degrees. 0 faces the player's start heading. */
  yawDeg: number;
  /** Tilt in degrees: 0 stands vertical, 90 lies flat with its face up. */
  tiltDeg: number;
}

/** deviceId, flags, then five f32: cx, cy, cz, yaw, tilt. */
export const PLACEMENT_BYTES = 1 + 1 + 5 * 4;

export function writePlacement(w: PacketWriter, p: DevicePlacement): boolean {
  return (
    w.pushU8(p.deviceId) &&
    w.pushU8(p.flags) &&
    w.pushFloat32(p.centre[0]) &&
    w.pushFloat32(p.centre[1]) &&
    w.pushFloat32(p.centre[2]) &&
    w.pushFloat32(p.yawDeg) &&
    w.pushFloat32(p.tiltDeg)
  );
}

/**
 * Read a placement from `body` at `offset`, or null if it does not fit.
 *
 * Returns null rather than a partly filled object on truncation. A placement
 * with two of its three coordinates read is a device that moves somewhere
 * nobody put it, which is worse than one that does not move at all.
 */
export function readPlacement(body: Uint8Array, offset: number): DevicePlacement | null {
  if (offset + PLACEMENT_BYTES > body.length) return null;
  const view = new DataView(body.buffer, body.byteOffset + offset, PLACEMENT_BYTES);
  return {
    deviceId: view.getUint8(0),
    flags: view.getUint8(1),
    centre: [view.getFloat32(2, true), view.getFloat32(6, true), view.getFloat32(10, true)],
    yawDeg: view.getFloat32(14, true),
    tiltDeg: view.getFloat32(18, true),
  };
}

/** Whether a placement's numbers are ones a room can actually contain. */
export function isPlausiblePlacement(p: DevicePlacement): boolean {
  const finite = (v: number): boolean => Number.isFinite(v);
  return (
    p.centre.every(finite) &&
    finite(p.yawDeg) &&
    finite(p.tiltDeg) &&
    // Ten metres in any direction from the origin. Not a guard against a
    // hostile sender — the bridge is on the same desk — but against a NaN or an
    // uninitialised buffer putting a Launchpad somewhere it can never be
    // reached from, which needs the app reinstalled to undo.
    p.centre.every((v) => Math.abs(v) <= 10) &&
    Math.abs(p.tiltDeg) <= 180
  );
}
