// SPDX-License-Identifier: GPL-3.0-only

import { LAUNCHKEY_MK3_49 } from './launchkeyMk3.js';
import { LAUNCHPAD_PRO_MK3 } from './launchpadProMk3.js';
import { LAUNCHPAD_X } from './launchpadX.js';
import { VRMC } from './vrmc.js';
import { DeviceModel, type DeviceSpec } from './types.js';

/** Every emulated hardware device, by model. */
export const DEVICE_SPECS: Readonly<Record<string, DeviceSpec>> = {
  [DeviceModel.LAUNCHPAD_X]: LAUNCHPAD_X,
  [DeviceModel.LAUNCHPAD_PRO_MK3]: LAUNCHPAD_PRO_MK3,
  [DeviceModel.LAUNCHKEY_MK3_49]: LAUNCHKEY_MK3_49,
  [DeviceModel.VRMC]: VRMC,
};

/** Look up a spec, or null for the generic (non-hardware) models. */
export function specFor(model: string): DeviceSpec | null {
  return DEVICE_SPECS[model] ?? null;
}

/**
 * Models that emulate real hardware and therefore create named MIDI ports.
 *
 * The VRMC surface has a spec like these do — controls, a layout, a size — but
 * it is not on this list, and that is the distinction the bridge acts on. A
 * device here opens the ports its spec names, publishes a manufacturer and
 * model, answers a Device Inquiry and speaks its protocol through an emulator.
 * One that is not opens a single plain port and passes plain MIDI, because
 * there is no host script to talk to and claiming otherwise would load
 * somebody else's script over a device that cannot answer it.
 */
export const HARDWARE_MODELS: readonly DeviceModel[] = [
  DeviceModel.LAUNCHPAD_X,
  DeviceModel.LAUNCHPAD_PRO_MK3,
  DeviceModel.LAUNCHKEY_MK3_49,
];

/** True when this model emulates real hardware. See `HARDWARE_MODELS`. */
export function isHardwareModel(model: string): boolean {
  return (HARDWARE_MODELS as readonly string[]).includes(model);
}
