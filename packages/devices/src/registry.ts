// SPDX-License-Identifier: GPL-3.0-only

import { LAUNCHKEY_MK3_49 } from './launchkeyMk3.js';
import { LAUNCHPAD_PRO_MK3 } from './launchpadProMk3.js';
import { LAUNCHPAD_X } from './launchpadX.js';
import { DeviceModel, type DeviceSpec } from './types.js';

/** Every emulated hardware device, by model. */
export const DEVICE_SPECS: Readonly<Record<string, DeviceSpec>> = {
  [DeviceModel.LAUNCHPAD_X]: LAUNCHPAD_X,
  [DeviceModel.LAUNCHPAD_PRO_MK3]: LAUNCHPAD_PRO_MK3,
  [DeviceModel.LAUNCHKEY_MK3_49]: LAUNCHKEY_MK3_49,
};

/** Look up a spec, or null for the generic (non-hardware) models. */
export function specFor(model: string): DeviceSpec | null {
  return DEVICE_SPECS[model] ?? null;
}

/** Models that emulate real hardware and therefore create named MIDI ports. */
export const HARDWARE_MODELS: readonly DeviceModel[] = [
  DeviceModel.LAUNCHPAD_X,
  DeviceModel.LAUNCHPAD_PRO_MK3,
  DeviceModel.LAUNCHKEY_MK3_49,
];
