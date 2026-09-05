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
  manufacturer: 'Focusrite - Novation',

  /*
   * The three ports a stock Launchpad Pro MK3 puts on the bus, in its order.
   *
   * Unlike every other model here the DAW port is *last*. Live's
   * `Launchpad_Pro_MK3.get_capabilities()` asks for three ports in and three
   * out and says what each is for: REMOTE on the first, no props at all on the
   * second, NOTES_CC + SYNC + SCRIPT on the third. That is MIDI, DIN, DAW —
   * so `dawPortIndex` is 2, and anything that assumed index 0 is wrong for
   * this model.
   *
   * `LPProMK3 DIN` carries what the hardware would send out of the two DIN
   * sockets on its back panel. There is no back panel, so nothing is behind
   * this port; it exists because the device is meant to present as the
   * hardware does, and a host that counts ports gets the count it expects.
   * A DAW that routes to it gets the same silence a real Pro MK3 with nothing
   * plugged into its DIN sockets would give.
   *
   * These names were `PRO MK3 (DAW)` / `PRO MK3 (MIDI)`, from CoreFW — which
   * is community firmware naming its own ports, and parenthesises where
   * Novation does not.
   */
  portNames: ['LPProMK3 MIDI', 'LPProMK3 DIN', 'LPProMK3 DAW'],
  dawPortIndex: 2,

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
