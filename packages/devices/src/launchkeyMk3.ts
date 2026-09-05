// SPDX-License-Identifier: GPL-3.0-only
//
// USB ids, the identity reply's bytes, the SysEx device id and the port shape
// were read out of Ableton Live's own `Launchkey_MK3` remote script rather than
// recalled — see docs/DEVICES-TO-EMULATE.md for how, and why that is the only
// source that settles them.

import {
  ButtonRole,
  ControlKind,
  DeviceModel,
  type Control,
  type DeviceSpec,
} from './types.js';

/*
 * Control ids, disjoint by construction.
 *
 * A Launchpad's controls all live in one XY namespace, so its id and its MIDI
 * byte are the same number. This device has both notes and CCs, and they
 * overlap: key 41 and fader 6 both send 41, and seventeen such pairs exist. An
 * id space with gaps between the regions costs nothing — the lookup is an array
 * indexed by id — and makes a collision impossible rather than unlikely.
 */
const KEY_ID = 0;
const PAD_ID = 100;
const KNOB_ID = 200;
const FADER_ID = 300;

/**
 * The 16 pads, two rows of eight.
 *
 * Addressed as an XY index like a Launchpad's grid — `row * 10 + col`, row 1 at
 * the bottom — so everything that already walks a Launchpad's controls walks
 * these too. The pads sit at rows 1 and 2 of a notional grid whose other rows
 * this device does not have.
 */
function padControls(): Control[] {
  const out: Control[] = [];
  for (let row = 1; row <= 2; row++) {
    for (let col = 1; col <= 8; col++) {
      const n = (row - 1) * 8 + (col - 1);
      out.push({
        index: PAD_ID + n,
        // Notes 96..111, which is what the hardware sends and what Live's
        // script reads positionally.
        data1: 96 + n,
        kind: ControlKind.NOTE,
        role: ButtonRole.GRID,
        col: col - 1,
        row: row - 1,
        label: '',
      });
    }
  }
  return out;
}

/**
 * Eight rotary knobs, on CC 21..28.
 *
 * Continuous rather than pressed, which is why they are `CC` and not `NOTE`:
 * a knob has no press and no release, only a value, and the emulator's
 * note-tracking must not try to release one.
 */
function knobControls(): Control[] {
  return Array.from({ length: 8 }, (_, i) => ({
    index: KNOB_ID + i,
    data1: 21 + i,
    kind: ControlKind.CC,
    role: ButtonRole.KNOB,
    col: i,
    row: 3,
    label: `K${i + 1}`,
  }));
}

/**
 * Nine faders: eight track faders on CC 41..48, and a master on 49.
 *
 * Nine and not eight. The ninth is the master fader, and a spec that stopped at
 * eight would leave Live's script writing to a control that does not exist —
 * which is silent, because a fader that is never moved looks exactly like one
 * nobody touched.
 */
function faderControls(): Control[] {
  return Array.from({ length: 9 }, (_, i) => ({
    index: FADER_ID + i,
    data1: 41 + i,
    kind: ControlKind.CC,
    role: ButtonRole.FADER,
    col: i,
    row: 4,
    label: i === 8 ? 'MASTER' : `F${i + 1}`,
  }));
}

/** The 49 keys, C2 to C6, as MIDI notes 36..84. */
function keyControls(): Control[] {
  return Array.from({ length: 49 }, (_, i) => ({
    index: KEY_ID + i,
    // C2 to C6.
    data1: 36 + i,
    kind: ControlKind.NOTE,
    role: ButtonRole.KEY,
    col: i,
    row: 0,
    label: '',
  }));
}

/**
 * Novation Launchkey MK3 49.
 *
 * The device this project was missing: a keyboard big enough to play with two
 * hands, with the faders and knobs a mixer wants, and — unlike a generic
 * controller — a script Live already ships, so the faders reach the mixer and
 * the knobs the selected device with nothing assigned.
 */
export const LAUNCHKEY_MK3_49: DeviceSpec = {
  model: DeviceModel.LAUNCHKEY_MK3_49,
  displayName: 'Launchkey MK3 49',

  usbVendorId: 0x1235,
  /*
   * 0x136. Live's script matches product ids 308..311 for the 25, 37, 49 and
   * 61, and the low byte of each is the same number the device reports in its
   * identity reply — 0x136 and 54 for this one. That correspondence is worth
   * noting because it is the check that catches transcribing one of the four.
   */
  usbProductId: 0x136,
  /*
   * 0x0f, from `DISPLAY_HEADER = STD_MSG_HEADER + (15,)` — the display SysEx is
   * `F0 00 20 29 02 0F …`, and byte 5 there is the device id.
   */
  sysexDeviceId: 0x0f,
  /*
   * The bytes Live compares are `00 20 29 36 01 00 00`: the manufacturer, then
   * the model byte 54 (0x36) for the 49, then `MODEL_ID_BYTE_SUFFIX` of
   * `01 00 00` — of which the first byte lands in the family code's second
   * position and the rest in the member code.
   */
  familyCode: [0x36, 0x01],
  firmwareVersion: [0x00, 0x00, 0x00],
  manufacturer: 'Focusrite - Novation',

  /*
   * Two ports, and the DAW port is **second** — `inport(props=[NOTES_CC,
   * REMOTE])` then `inport(props=[NOTES_CC, SCRIPT])` in Live's capabilities.
   *
   * That is a third distinct ordering across three Novation families: the
   * Launchpad X puts DAW first, the Pro MK3 puts it third of three, and this
   * puts it second of two. There is no rule to infer, which is why every spec
   * reads it from the script rather than following the last one.
   */
  portNames: ['LKMK3 MIDI', 'LKMK3 DAW'],
  /*
   * And it names its endpoints directionally, which the Launchpads do not.
   * A host lists the device's *output* as an input, so what Ableton wants
   * selected as its Input is the port called "Out".
   */
  portNamesByDirection: {
    source: ['LKMK3 MIDI Out', 'LKMK3 DAW Out'],
    destination: ['LKMK3 MIDI In', 'LKMK3 DAW In'],
  },
  dawPortIndex: 1,

  controls: [
    ...keyControls(),
    ...padControls(),
    ...knobControls(),
    ...faderControls(),
  ],

  /*
   * Two rows of eight, so the grid is not square. `gridSize` describes the
   * width; anything that assumes a square grid from it is wrong for this
   * device, and `padRows` says so rather than leaving it to be inferred.
   */
  gridSize: 8,
  padRows: 2,
  polyAftertouch: false,
  velocitySensitive: true,

  padSize: 0.022,
  padGap: 0.005,
  padRadius: 0.18,
};
