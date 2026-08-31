// SPDX-License-Identifier: GPL-3.0-only
//
// USB identity, SysEx device id and family code cross-checked against CoreFW
// (https://github.com/anthonyhfm/launchpad-core-firmware).

import {
  gridControls,
  logoControl,
  sceneColumnControls,
  topRowControls,
} from './layout.js';
import { DeviceModel, type DeviceSpec } from './types.js';

/**
 * Novation Launchpad X.
 *
 * 8x8 velocity-sensitive RGB pads with polyphonic aftertouch, a top row of
 * eight function buttons and a right column of eight scene launches.
 */
export const LAUNCHPAD_X: DeviceSpec = {
  model: DeviceModel.LAUNCHPAD_X,
  displayName: 'Launchpad X',

  usbVendorId: 0x1235,
  usbProductId: 0x0103,
  sysexDeviceId: 0x0c,
  familyCode: [0x03, 0x01],
  firmwareVersion: [0x09, 0x09, 0x09],

  // Names as the hardware presents them. Ableton's script matches on these, so
  // they are functional strings rather than cosmetic ones.
  portNames: ['LPX MIDI', 'LPX DAW'],
  dawPortIndex: 1,

  controls: [
    ...gridControls(),
    // Top row, left to right, exactly as printed on the device.
    ...topRowControls(['Up', 'Down', 'Left', 'Right', 'Session', 'Note', 'Custom', 'Rec']),
    // Right column, top to bottom.
    ...sceneColumnControls(['>', '>', '>', '>', '>', '>', '>', 'Stop']),
    logoControl(),
  ],

  gridSize: 8,
  polyAftertouch: true,
  velocitySensitive: true,

  // The real device's pads are about 20 mm across on a 24 mm pitch.
  padSize: 0.02,
  padGap: 0.004,
  padRadius: 0.22,
};
