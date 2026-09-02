// SPDX-License-Identifier: GPL-3.0-only
//
// USB identity, SysEx device id, family code and the surrounding button
// addressing were cross-checked against CoreFW
// (https://github.com/anthonyhfm/launchpad-core-firmware), whose Pro MK3
// button remap table confirms the 11..88 grid plus the four edge strips.

import {
  bottomRowControls,
  gridControls,
  leftColumnControls,
  logoControl,
  sceneColumnControls,
  topRowControls,
} from './layout.js';
import { DeviceModel, type DeviceSpec } from './types.js';

/**
 * Novation Launchpad Pro MK3.
 *
 * The full surface: the 8x8 grid plus all four edge strips. The left column
 * selects a mode, the bottom row selects a track, and the extra hardware over
 * the Launchpad X is mostly sequencer control that reaches the host as ordinary
 * CC presses — so it needs the addressing to be right rather than any special
 * behaviour here.
 */
export const LAUNCHPAD_PRO_MK3: DeviceSpec = {
  model: DeviceModel.LAUNCHPAD_PRO_MK3,
  displayName: 'Launchpad Pro MK3',

  usbVendorId: 0x1235,
  usbProductId: 0x0123,
  sysexDeviceId: 0x0e,
  familyCode: [0x23, 0x01],
  firmwareVersion: [0x09, 0x09, 0x09],

  // DAW first, then MIDI — the cable order in CoreFW's descriptor, same as
  // every other model. The Pro MK3 presents a third port carrying DIN output,
  // which a virtual device cannot usefully emulate, so two are created.
  portNames: ['PRO MK3 (DAW)', 'PRO MK3 (MIDI)'],
  dawPortIndex: 0,

  controls: [
    ...gridControls(),
    ...topRowControls(['Up', 'Down', 'Left', 'Right', 'Session', 'Note', 'Chord', 'Custom']),
    ...sceneColumnControls(['>', '>', '>', '>', '>', '>', '>', '>']),
    // Left column, top to bottom: the mode strip.
    ...leftColumnControls([
      'Shift',
      'Click',
      'Undo',
      'Delete',
      'Quantise',
      'Duplicate',
      'Double',
      'Record',
    ]),
    // Bottom row, left to right: track control.
    ...bottomRowControls([
      'Rec Arm',
      'Mute',
      'Solo',
      'Volume',
      'Pan',
      'Sends',
      'Device',
      'Stop Clip',
    ]),
    logoControl(),
  ],

  gridSize: 8,
  polyAftertouch: true,
  velocitySensitive: true,

  // Slightly larger pads than the X, on a correspondingly wider pitch.
  padSize: 0.021,
  padGap: 0.0045,
  padRadius: 0.2,
};
