// SPDX-License-Identifier: GPL-3.0-only

/**
 * Deciding what the bridge has forgotten.
 *
 * The bridge closes its MIDI ports once the last client has been gone for the
 * grace period, and closing them takes its devices with them. So a headset
 * returning from a long disconnect gets a roster that no longer mentions the
 * Launchpads it spawned.
 *
 * Adoption cannot fix that on its own: it only ever *adds* what the roster
 * names, and the roster names nothing. Left alone, the device stays drawn and
 * stays pokeable, and every note it sends reaches a bridge with no such id and
 * is dropped without a word — an instrument you can see, touch, and not hear,
 * for the rest of the session.
 *
 * The headset is the side that knows what should exist, so it re-asks. This is
 * that decision, kept separate from the engine because it is worth testing and
 * the engine needs a WebXR session to build.
 */

/** The little of a device this needs. */
export interface KnownDevice {
  deviceId: number;
  model: string;
}

/** The little of a roster entry this needs. */
export interface RosterEntry {
  deviceId: number;
}

/**
 * Devices the headset holds that the roster does not mention.
 *
 * Order follows `local`, so the re-requests go out in the order the devices
 * were spawned and the bridge rebuilds them in the same order.
 *
 * Repeating a request is harmless: `DeviceManager.add` returns early for an id
 * it already has. That matters because a roster pushed by the bridge can cross
 * a spawn still in flight, and this will then ask for a device the bridge is
 * already building — one ignored packet, rather than a reason to track
 * in-flight requests here.
 */
export function devicesMissingFromRoster(
  local: readonly KnownDevice[],
  roster: readonly RosterEntry[],
): KnownDevice[] {
  if (local.length === 0) return [];
  const known = new Set<number>();
  for (const entry of roster) known.add(entry.deviceId);
  return local.filter((device) => !known.has(device.deviceId));
}
