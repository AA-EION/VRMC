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
  manufacturer: 'Focusrite - Novation',

  // The names a stock Launchpad X puts on the bus, and the order Live expects
  // them in. These were `LPX (DAW)` / `LPX (MIDI)` — CoreFW's strings, which
  // are its own: it is community firmware, and it parenthesises where Novation
  // does not. Novation's own Ableton setup guide names the ports `LPX DAW` and
  // `LPX MIDI`, and Live's Launchpad_X script lists two in and two out with
  // SCRIPT on the first pair and REMOTE on the second, which is the DAW port
  // first.
  portNames: ['LPX DAW', 'LPX MIDI'],
  dawPortIndex: 0,

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
