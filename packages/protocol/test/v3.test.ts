// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  DeviceStatus,
  MAX_LAYOUT_NAME_BYTES,
  PLACEMENT_BYTES,
  PacketKind,
  PacketReader,
  PacketWriter,
  PlacementFlags,
  feelOf,
  normaliseLayoutName,
  readDevicePose,
  readDeviceState,
  readLayoutName,
  readLayoutSave,
  readLayoutState,
  readLinkStats,
  readPlacement,
  isPlausiblePlacement,
  writeDevicePose,
  writeDeviceState,
  writeLayoutName,
  writeLayoutSave,
  writeLayoutState,
  writeLinkStats,
  type DevicePlacement,
  type Layout,
} from '../src/index.js';

/** Build a control packet and hand back its body, as a receiver would see it. */
function roundTrip(kind: number, fill: (w: PacketWriter) => void): Uint8Array {
  const w = new PacketWriter();
  w.begin(kind);
  fill(w);
  const frame = w.finish(0).slice();
  const r = new PacketReader();
  expect(r.read(frame, null)).toBe(0);
  expect(r.header.kind).toBe(kind);
  return r.bodyView();
}

const PLACED: DevicePlacement = {
  deviceId: 17,
  flags: PlacementFlags.PINNED | PlacementFlags.ANCHORED,
  centre: [0.42, 0.95, -0.52],
  yawDeg: -18.5,
  tiltDeg: 48,
};

describe('DEVICE_POSE', () => {
  it('round-trips a placement', () => {
    const body = roundTrip(PacketKind.DEVICE_POSE, (w) => writeDevicePose(w, PLACED));
    const back = readDevicePose(body);
    expect(back).not.toBeNull();
    expect(back!.deviceId).toBe(17);
    expect(back!.flags).toBe(PlacementFlags.PINNED | PlacementFlags.ANCHORED);
    // f32, so exactness is not the claim — a tenth of a millimetre is.
    expect(back!.centre[0]).toBeCloseTo(0.42, 5);
    expect(back!.centre[1]).toBeCloseTo(0.95, 5);
    expect(back!.centre[2]).toBeCloseTo(-0.52, 5);
    expect(back!.yawDeg).toBeCloseTo(-18.5, 4);
    expect(back!.tiltDeg).toBeCloseTo(48, 4);
  });

  it('resolves a placement more finely than a hand can be measured', () => {
    /*
     * The reason f32 is enough, asserted rather than asserted-in-a-comment.
     * Hand tracking's own noise floor is about a millimetre; anything that
     * survives a round trip to well inside that is carrying no error a player
     * could ever produce.
     */
    const fine: DevicePlacement = { ...PLACED, centre: [1.234567, -2.345678, 9.876543] };
    const body = roundTrip(PacketKind.DEVICE_POSE, (w) => writeDevicePose(w, fine));
    const back = readDevicePose(body)!;
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(back.centre[i]! - fine.centre[i]!)).toBeLessThan(1e-5);
    }
  });

  it('refuses a truncated placement rather than half-reading one', () => {
    // Half a placement is a device that moves somewhere nobody put it, which is
    // worse than one that does not move at all.
    expect(readPlacement(new Uint8Array(PLACEMENT_BYTES - 1), 0)).toBeNull();
    expect(readDevicePose(new Uint8Array(0))).toBeNull();
  });

  it('rejects numbers a room cannot contain', () => {
    expect(isPlausiblePlacement(PLACED)).toBe(true);
    expect(isPlausiblePlacement({ ...PLACED, centre: [NaN, 0, 0] })).toBe(false);
    expect(isPlausiblePlacement({ ...PLACED, centre: [0, 1e9, 0] })).toBe(false);
    expect(isPlausiblePlacement({ ...PLACED, tiltDeg: 4000 })).toBe(false);
  });
});

describe('DEVICE_STATE with placements', () => {
  it('keeps «never placed» distinct from «placed at the origin»', () => {
    /*
     * The distinction the presence byte exists for. A device the bridge opened
     * at startup has never been anywhere and belongs at its default pose; one
     * somebody deliberately put at the origin belongs at the origin. Collapsing
     * the two would move every fresh device to the player's feet.
     */
    const origin: DevicePlacement = {
      deviceId: 2,
      flags: PlacementFlags.NONE,
      centre: [0, 0, 0],
      yawDeg: 0,
      tiltDeg: 0,
    };
    const body = roundTrip(PacketKind.DEVICE_STATE, (w) =>
      writeDeviceState(w, [
        { deviceId: 1, status: DeviceStatus.READY, model: 'launchpad-x', detail: 'LPX', placement: null },
        { deviceId: 2, status: DeviceStatus.READY, model: 'launchpad-x', detail: 'LPX', placement: origin },
      ]),
    );
    const back = readDeviceState(body);
    expect(back).toHaveLength(2);
    expect(back[0]!.placement).toBeNull();
    expect(back[1]!.placement).not.toBeNull();
    expect(back[1]!.placement!.centre).toEqual([0, 0, 0]);
  });

  it('round-trips a mixed roster', () => {
    const body = roundTrip(PacketKind.DEVICE_STATE, (w) =>
      writeDeviceState(w, [
        { deviceId: 16, status: DeviceStatus.READY, model: 'launchpad-x', detail: 'a, b', placement: PLACED },
        { deviceId: 17, status: DeviceStatus.FAILED, model: 'launchpad-pro-mk3', detail: 'no ports', placement: null },
      ]),
    );
    const back = readDeviceState(body);
    expect(back).toHaveLength(2);
    expect(back[0]!.model).toBe('launchpad-x');
    expect(back[0]!.placement!.flags & PlacementFlags.PINNED).toBeTruthy();
    expect(back[1]!.status).toBe(DeviceStatus.FAILED);
    expect(back[1]!.detail).toBe('no ports');
    expect(back[1]!.placement).toBeNull();
  });

  it('stops at a truncated entry rather than reporting devices that are not there', () => {
    const full = roundTrip(PacketKind.DEVICE_STATE, (w) =>
      writeDeviceState(w, [
        { deviceId: 16, status: DeviceStatus.READY, model: 'launchpad-x', detail: '', placement: PLACED },
        { deviceId: 17, status: DeviceStatus.READY, model: 'launchpad-x', detail: '', placement: PLACED },
      ]),
    );
    // Cut inside the second entry's placement.
    const cut = full.subarray(0, full.length - 6);
    expect(readDeviceState(cut)).toHaveLength(1);
  });
});

describe('layouts', () => {
  const layout: Layout = {
    name: 'Studio',
    entries: [
      { placement: PLACED, model: 'launchpad-x' },
      {
        placement: { ...PLACED, deviceId: 18, flags: PlacementFlags.NONE, centre: [-0.4, 0.8, -0.5] },
        model: 'launchpad-pro-mk3',
      },
    ],
  };

  it('round-trips a saved arrangement', () => {
    const body = roundTrip(PacketKind.LAYOUT_SAVE, (w) => writeLayoutSave(w, layout));
    const back = readLayoutSave(body);
    expect(back).not.toBeNull();
    expect(back!.name).toBe('Studio');
    expect(back!.entries).toHaveLength(2);
    expect(back!.entries[0]!.model).toBe('launchpad-x');
    expect(back!.entries[1]!.placement.deviceId).toBe(18);
    expect(back!.entries[1]!.placement.centre[0]).toBeCloseTo(-0.4, 5);
  });

  it('stores the model beside each placement', () => {
    /*
     * Device ids are handed out per session and are not stable across a bridge
     * restart, so matching a saved entry to a live device by id alone would put
     * a Launchpad Pro where a Launchpad X had been. The model is what makes a
     * saved arrangement still mean something a week later.
     */
    const body = roundTrip(PacketKind.LAYOUT_SAVE, (w) => writeLayoutSave(w, layout));
    const back = readLayoutSave(body)!;
    expect(back.entries.map((e) => e.model)).toEqual(['launchpad-x', 'launchpad-pro-mk3']);
  });

  it('round-trips the whole set and which one is current', () => {
    const body = roundTrip(PacketKind.LAYOUT_STATE, (w) =>
      writeLayoutState(w, { layouts: [layout, { name: 'Couch', entries: [] }], current: 'Couch' }),
    );
    const back = readLayoutState(body);
    expect(back.current).toBe('Couch');
    expect(back.layouts.map((l) => l.name)).toEqual(['Studio', 'Couch']);
    expect(back.layouts[0]!.entries).toHaveLength(2);
    expect(back.layouts[1]!.entries).toHaveLength(0);
  });

  it('survives having no layouts and nothing current', () => {
    const body = roundTrip(PacketKind.LAYOUT_STATE, (w) =>
      writeLayoutState(w, { layouts: [], current: '' }),
    );
    expect(readLayoutState(body)).toEqual({ layouts: [], current: '' });
  });

  it('round-trips a bare name for apply and delete', () => {
    const body = roundTrip(PacketKind.LAYOUT_APPLY, (w) => writeLayoutName(w, 'Couch'));
    expect(readLayoutName(body)).toBe('Couch');
  });

  it('never cuts a name mid-character', () => {
    // Slicing a UTF-8 buffer by bytes produces a replacement character, and a
    // layout called "Studi<fffd>" is one somebody has to look at and wonder about.
    const long = normaliseLayoutName('永'.repeat(40));
    expect(long).not.toContain('�');
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(MAX_LAYOUT_NAME_BYTES);
    expect(long.length).toBeGreaterThan(0);
  });

  it('tidies whitespace so two names cannot differ invisibly', () => {
    expect(normaliseLayoutName('  Studio   B  ')).toBe('Studio B');
  });
});

describe('LINK_STATS', () => {
  const quality = {
    jitterMs: 3.25,
    peakJitterMs: 11.5,
    lossRatio: 0.0025,
    packets: 123456,
    dropped: 12,
    reordered: 3,
    malformed: 1,
    activeNotes: 4,
  };

  it('round-trips what the bridge measures', () => {
    const body = roundTrip(PacketKind.LINK_STATS, (w) => writeLinkStats(w, quality));
    const back = readLinkStats(body);
    expect(back).not.toBeNull();
    expect(back!.jitterMs).toBeCloseTo(3.25, 5);
    expect(back!.peakJitterMs).toBeCloseTo(11.5, 5);
    expect(back!.lossRatio).toBeCloseTo(0.0025, 6);
    expect(back!.packets).toBe(123456);
    expect(back!.dropped).toBe(12);
    expect(back!.activeNotes).toBe(4);
  });

  it('refuses a short body', () => {
    expect(readLinkStats(new Uint8Array(4))).toBeNull();
  });

  it('reduces to a word somebody mid-phrase can act on', () => {
    /*
     * The thresholds are about feel, not about networking. Under 5 ms nobody
     * hears the variation; past 15 a roll arrives unevenly; any measurable loss
     * means notes are going missing rather than merely arriving late.
     */
    expect(feelOf({ jitterMs: 2, lossRatio: 0 })).toBe('good');
    expect(feelOf({ jitterMs: 9, lossRatio: 0 })).toBe('fair');
    expect(feelOf({ jitterMs: 22, lossRatio: 0 })).toBe('poor');
    expect(feelOf({ jitterMs: 1, lossRatio: 0.05 })).toBe('poor');
  });
});
