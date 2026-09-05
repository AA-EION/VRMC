// SPDX-License-Identifier: GPL-3.0-only

import {
  ControlStripLayout,
  KeyboardLayout,
  LAUNCHKEY_25,
  MPC_4X4,
  PadGridLayout,
  type ControlStripOptions,
} from '@vrmc/layout';
import {
  ButtonRole,
  ControlKind,
  DeviceModel,
  type Control,
  type DeviceSpec,
} from './types.js';
import { CompositeSurface, type SurfaceRegion } from './CompositeSurface.js';

/*
 * The VRMC surface: the instrument this project started as.
 *
 * It was not a device. It was two panels and four knobs built directly into the
 * engine, at fixed poses, outside the roster — so it could not be moved with
 * the same gesture as everything else, could not be pinned, could not be
 * anchored to a desk, was not saved in a layout, and above all could not be put
 * away. A player who only wanted a Launchpad had a keyboard and a pad grid in
 * the room regardless.
 *
 * Making it a device is the whole of the change. It is the same keys, the same
 * pads and the same four knobs on the same CCs; what it gains is being one of
 * the things in the room rather than part of the room.
 *
 * It claims no hardware identity, and that is deliberate rather than an
 * omission. No DAW ships a script for a "VRMC", so pretending to be a Novation
 * would load somebody else's script over a device that does not answer it.
 * Its port is a plain one, named by --port-name, and it presents as what it is:
 * a keyboard, a drum grid and four controllers.
 */

const KEY_ID = 0;
const PAD_ID = 100;
const KNOB_ID = 200;

/** The regions' names, for anything that has to tell them apart. */
export const VrmcPart = {
  KEYS: 'keys',
  PADS: 'pads',
  KNOBS: 'knobs',
} as const;

/**
 * Four knobs, on CC 21..24.
 *
 * The same four CCs the surface has always sent, and the same four a Launchkey
 * starts at — so a Live user who has mapped one has mapped the other.
 */
export const VRMC_KNOB_ROW: ControlStripOptions = {
  count: 4,
  width: 0.03,
  height: 0.03,
  gap: 0.026,
  baseCc: 21,
  raise: 0.012,
  prefix: 'K',
};

/** Two octaves from C3, which is where the surface has always started. */
function keyControls(): Control[] {
  return Array.from({ length: LAUNCHKEY_25.keyCount }, (_, i) => ({
    index: KEY_ID + i,
    data1: LAUNCHKEY_25.lowNote + i,
    kind: ControlKind.NOTE,
    role: ButtonRole.KEY,
    col: i,
    row: 0,
    label: '',
  }));
}

/**
 * Sixteen pads, notes 36..51 — General MIDI's drum range, on channel 10.
 *
 * The channel is the region's, not each pad's: see `SurfaceRegion.channel`. It
 * matters because a drum rack listens on 10 and nothing else does, so a pad
 * grid that sent on channel 1 would play the keyboard's instrument.
 */
function padControls(): Control[] {
  return Array.from({ length: MPC_4X4.rows * MPC_4X4.cols }, (_, i) => ({
    index: PAD_ID + i,
    data1: MPC_4X4.baseNote + i,
    kind: ControlKind.NOTE,
    role: ButtonRole.GRID,
    col: i % MPC_4X4.cols,
    row: Math.floor(i / MPC_4X4.cols),
    label: '',
  }));
}

function knobControls(): Control[] {
  return Array.from({ length: VRMC_KNOB_ROW.count }, (_, i) => ({
    index: KNOB_ID + i,
    data1: VRMC_KNOB_ROW.baseCc + i,
    kind: ControlKind.CC,
    role: ButtonRole.KNOB,
    col: i,
    row: 1,
    label: `K${i + 1}`,
  }));
}

/**
 * The VRMC surface.
 *
 * Ids are disjoint by region for the same reason the Launchkey's are: a pad
 * sends note 48 and so does the key an octave up, and an id space that reused
 * the MIDI byte would let an LED or a press resolve to the wrong one. Here the
 * two also differ by channel, which keeps them apart on the wire — but not in
 * any lookup keyed by id, which is where it would actually go wrong.
 */
export const VRMC: DeviceSpec = {
  model: DeviceModel.VRMC,
  displayName: 'VRMC',

  // No hardware to claim. A virtual port cannot present USB ids anyway, and
  // this one is not pretending to be anything that has them.
  usbVendorId: 0,
  usbProductId: 0,
  sysexDeviceId: 0,
  familyCode: [0x00, 0x00],
  firmwareVersion: [0x00, 0x00, 0x00],
  manufacturer: 'EION Studios',

  /*
   * One port, and no DAW protocol on it. The name here is a default: the
   * bridge substitutes --port-name, because this is the port a user may need
   * to name for their own routing.
   */
  portNames: ['VRMC'],
  dawPortIndex: 0,

  controls: [...keyControls(), ...padControls(), ...knobControls()],

  gridSize: MPC_4X4.cols,
  padRows: MPC_4X4.rows,
  // The pads are big and the surface is a drum grid rather than a session
  // view; pressure is worth having and there is no host script to confuse.
  polyAftertouch: true,
  velocitySensitive: true,

  padSize: MPC_4X4.padSize,
  padGap: MPC_4X4.gap,
  padRadius: 0.12,
};

/**
 * Where the three regions sit.
 *
 * Keys along the front edge nearest the player, pads above them on the right,
 * knobs above on the left — the arrangement the two fixed panels had between
 * them, now on one plane so a hand crossing from the keys to the pads stays on
 * the same instrument.
 */
function vrmcRegions(): SurfaceRegion[] {
  const keys = new KeyboardLayout(LAUNCHKEY_25);
  const pads = new PadGridLayout(MPC_4X4);
  const knobs = new ControlStripLayout(VRMC_KNOB_ROW);

  const gutter = 0.02;
  const controlsY = keys.height + gutter;
  const padsX = Math.max(0, keys.width - pads.width);

  return [
    { part: VrmcPart.KEYS, role: ButtonRole.KEY, locator: keys, x: 0, y: 0 },
    {
      part: VrmcPart.PADS,
      role: ButtonRole.GRID,
      locator: pads,
      x: padsX,
      y: controlsY,
      // Channel 10, zero-based. A drum rack listens there and nothing else does.
      channel: 9,
    },
    {
      part: VrmcPart.KNOBS,
      role: ButtonRole.KNOB,
      locator: knobs,
      x: 0,
      y: controlsY + (pads.height - knobs.height) / 2,
      continuous: true,
    },
  ];
}

export class VrmcSurface extends CompositeSurface {
  constructor(spec: DeviceSpec = VRMC) {
    super(spec, vrmcRegions());
  }
}
