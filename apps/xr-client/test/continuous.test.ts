// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeviceModel,
  LaunchkeySurface,
  specFor,
  VrmcPart,
  VrmcSurface,
} from '@vrmc/devices';
import { FingerFrame, Finger } from '@vrmc/interaction';
import { localToWorld, type SurfacePose } from '@vrmc/layout';
import { EventType } from '@vrmc/protocol';
import { LaunchpadInstance } from '../src/devices/LaunchpadInstance.js';
import type { BridgeLink } from '../src/net/BridgeLink.js';

/**
 * Knobs and faders, from a fingertip to the bytes on the wire.
 *
 * Two things can go wrong here and neither one looks broken. A continuous
 * control routed through the poke detector still *responds* — it just sends a
 * note the instant a hand crosses it, so playing the keys underneath fires the
 * faders. And a knob that sends its control id instead of its MIDI number
 * still sends a well-formed CC, to the wrong controller: id 200 arrives as
 * CC 200, which is not a CC at all.
 *
 * So the assertions are about the number that leaves, not about something
 * having happened.
 */

interface Sent {
  type: number;
  channel: number;
  data1: number;
  data2: number;
  value14: number;
  deviceId: number;
}

class FakeLink {
  readonly sent: Sent[] = [];

  push(
    type: number,
    channel: number,
    data1: number,
    data2: number,
    value14: number,
    deviceId: number,
    _flags: number,
    _tOffsetMs: number,
  ): boolean {
    this.sent.push({ type, channel, data1, data2, value14, deviceId });
    return true;
  }
}

const POSE: SurfacePose = { centre: [0, 1, -0.4], tiltDeg: 60, yawDeg: 0 };
const DEVICE_ID = 3;

let link: FakeLink;
let device: LaunchpadInstance;
let surface: LaunchkeySurface;

beforeEach(() => {
  const spec = specFor(DeviceModel.LAUNCHKEY_MK3_49);
  if (spec === null) throw new Error('the Launchkey spec is missing');
  link = new FakeLink();
  device = new LaunchpadInstance(DEVICE_ID, spec, POSE, link as unknown as BridgeLink);
  surface = device.layout as LaunchkeySurface;
});

/** Zone indices of one region, in the order the hardware numbers them. */
function zonesOfPart(part: string): number[] {
  return surface.zones.filter((z) => surface.partOf(z.index) === part).map((z) => z.index);
}

/** World position of a zone's centre, offset along the surface normal. */
function above(zoneIndex: number, byMetres: number): [number, number, number] {
  const zone = surface.zones[zoneIndex]!;
  const w = localToWorld(
    device.transform,
    zone.rect.x + zone.rect.width / 2,
    zone.rect.y + zone.rect.height / 2,
    zone.raise + byMetres,
  );
  return [w[0]!, w[1]!, w[2]!];
}

/** One frame of a right-hand pinch centred on `at`, drag included. */
function pinchFrame(at: readonly [number, number, number], t: number): FingerFrame {
  const frame = new FingerFrame();
  frame.beginFrame(t, 1 / 90);
  // 10 mm apart: inside `pinchClose` (22 mm) and staying inside `pinchOpen`.
  frame.setFinger(Finger.RIGHT_THUMB, at[0] - 0.005, at[1], at[2], 0.008);
  frame.setFinger(Finger.RIGHT_INDEX, at[0] + 0.005, at[1], at[2], 0.008);
  return frame;
}

/**
 * Grab a control at its centre, drag the hand `dy` metres, and let go.
 *
 * The release matters: a pinch holds whatever it latched onto until it opens,
 * so without it a second call would keep driving the first control no matter
 * where the hand had moved. That is the hardware's behaviour and the bug this
 * helper would otherwise hide.
 */
function dragControl(zoneIndex: number, dy: number): void {
  const [x, y, z] = above(zoneIndex, 0);
  device.updateContinuous(pinchFrame([x, y, z], 0));
  device.updateContinuous(pinchFrame([x, y + dy, z], 11));
  device.updateContinuous(openFrame([x, y + dy, z], 22));
}

/** The same hand with its fingers apart, which releases whatever it held. */
function openFrame(at: readonly [number, number, number], t: number): FingerFrame {
  const frame = new FingerFrame();
  frame.beginFrame(t, 1 / 90);
  frame.setFinger(Finger.RIGHT_THUMB, at[0] - 0.05, at[1], at[2], 0.008);
  frame.setFinger(Finger.RIGHT_INDEX, at[0] + 0.05, at[1], at[2], 0.008);
  return frame;
}

describe('the Launchkey s continuous controls', () => {
  it('sends the MIDI CC number, not the control id', () => {
    const faders = zonesOfPart('faders');
    // The sixth fader. Its id is 305 and it sends CC 46 — and note 46 is a key
    // this device also has, which is the collision the id space exists for.
    dragControl(faders[5]!, 0.05);

    const ccs = link.sent.filter((e) => e.type === EventType.CONTROL_CHANGE_14);
    expect(ccs.length).toBeGreaterThan(0);
    for (const event of ccs) {
      expect(event.data1).toBe(46);
      expect(event.deviceId).toBe(DEVICE_ID);
    }
  });

  it('numbers every knob and fader as the hardware does', () => {
    const knobs = zonesOfPart('knobs');
    const faders = zonesOfPart('faders');
    expect(knobs).toHaveLength(8);
    expect(faders).toHaveLength(9);

    const seen: number[] = [];
    for (const zone of [...knobs, ...faders]) {
      link.sent.length = 0;
      dragControl(zone, 0.05);
      const cc = link.sent.find((e) => e.type === EventType.CONTROL_CHANGE_14);
      expect(cc, `zone ${zone} sent nothing`).toBeDefined();
      seen.push(cc!.data1);
    }

    // CC 21..28 for the knobs, 41..49 for the faders including the master.
    expect(seen).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28,
      41, 42, 43, 44, 45, 46, 47, 48, 49,
    ]);
  });

  it('carries the drag into the value, in 14 bits', () => {
    const faders = zonesOfPart('faders');
    // Controls start at half. A quarter of the 0.25 m travel is +0.25 of range.
    dragControl(faders[0]!, 0.0625);
    const cc = link.sent.find((e) => e.type === EventType.CONTROL_CHANGE_14);
    expect(cc).toBeDefined();
    expect(cc!.value14).toBe(Math.round(0.75 * 16383));
  });

  it('follows the device when it is moved', () => {
    const faders = zonesOfPart('faders');
    device.setPose({ centre: [1.5, 1, -0.4], tiltDeg: 60, yawDeg: 0 });
    // `above` reads the new transform, so a knob left behind at the old pose
    // is simply out of grab range and sends nothing.
    dragControl(faders[2]!, 0.05);
    const cc = link.sent.find((e) => e.type === EventType.CONTROL_CHANGE_14);
    expect(cc).toBeDefined();
    expect(cc!.data1).toBe(43);
  });
});

describe('the poke detector on a device with faders', () => {
  /** Push a fingertip through a zone over two frames. */
  function poke(zoneIndex: number): void {
    const [ax, ay, az] = above(zoneIndex, 0.04);
    const [tx, ty, tz] = above(zoneIndex, -0.006);

    const first = new FingerFrame();
    first.beginFrame(0, 1 / 90);
    first.setFinger(Finger.RIGHT_INDEX, ax, ay, az, 0.008);
    device.detector.update(first, device);

    const second = new FingerFrame();
    second.beginFrame(11, 1 / 90);
    second.setFinger(Finger.RIGHT_INDEX, tx, ty, tz, 0.008);
    device.detector.update(second, device);
  }

  it('fires a note when a pad is struck', () => {
    poke(zonesOfPart('pads')[0]!);
    const notes = link.sent.filter((e) => e.type === EventType.NOTE_ON);
    expect(notes).toHaveLength(1);
    // Notes carry the control id; the bridge's emulator turns it into a byte.
    expect(notes[0]!.data1).toBe(100);
  });

  it('stays silent when a hand crosses a fader', () => {
    // The faders sit between the keys and the pads, so this is the ordinary
    // path across the instrument rather than an unlucky one.
    poke(zonesOfPart('faders')[3]!);
    expect(link.sent.filter((e) => e.type === EventType.NOTE_ON)).toHaveLength(0);
  });

  it('stays silent when a hand crosses a knob', () => {
    poke(zonesOfPart('knobs')[0]!);
    expect(link.sent.filter((e) => e.type === EventType.NOTE_ON)).toHaveLength(0);
  });

  it('still plays the keys', () => {
    poke(zonesOfPart('keys')[24]!);
    const notes = link.sent.filter((e) => e.type === EventType.NOTE_ON);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data1).toBe(24);
  });
});

describe('the VRMC surface, as a device', () => {
  let vrmcLink: FakeLink;
  let vrmc: LaunchpadInstance;
  let vrmcSurface: VrmcSurface;

  beforeEach(() => {
    const spec = specFor(DeviceModel.VRMC);
    if (spec === null) throw new Error('the VRMC spec is missing');
    vrmcLink = new FakeLink();
    vrmc = new LaunchpadInstance(9, spec, POSE, vrmcLink as unknown as BridgeLink);
    vrmcSurface = vrmc.layout as VrmcSurface;
  });

  /** Zone indices of one region. */
  function region(part: string): number[] {
    return vrmcSurface.zones
      .filter((z) => vrmcSurface.partOf(z.index) === part)
      .map((z) => z.index);
  }

  let clock = 0;

  /** Push a fingertip through a zone, lifting the hand away first. */
  function poke(zoneIndex: number): void {
    const zone = vrmcSurface.zones[zoneIndex]!;
    const at = (dz: number): [number, number, number] => {
      const w = localToWorld(
        vrmc.transform,
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
        zone.raise + dz,
      );
      return [w[0]!, w[1]!, w[2]!];
    };

    // Out of tracking between strikes, so the second one is approached rather
    // than teleported into from wherever the last one ended. A hand that jumps
    // across the surface without lifting is not a thing a player can do, and
    // the detector is entitled to disbelieve it.
    const away = new FingerFrame();
    away.beginFrame((clock += 11), 1 / 90);
    vrmc.detector.update(away, vrmc);

    const [ax, ay, az] = at(0.04);
    const [tx, ty, tz] = at(-0.006);
    const first = new FingerFrame();
    first.beginFrame((clock += 11), 1 / 90);
    first.setFinger(Finger.RIGHT_INDEX, ax, ay, az, 0.008);
    vrmc.detector.update(first, vrmc);
    const second = new FingerFrame();
    second.beginFrame((clock += 11), 1 / 90);
    second.setFinger(Finger.RIGHT_INDEX, tx, ty, tz, 0.008);
    vrmc.detector.update(second, vrmc);
  }

  it('sends the pads on channel 10 and the keys on 1', () => {
    /*
     * The failure this rules out is audible but not obviously wrong: a drum
     * rack listens on channel 10 and nothing else does, so pads sent on 1
     * arrive at the keyboard's instrument and play as pitches. It sounds like
     * a bad patch rather than like a routing bug.
     *
     * The bridge has no emulator for this device — it is not pretending to be
     * hardware — so whatever channel is stamped here is the channel that
     * reaches the DAW.
     */
    poke(region(VrmcPart.PADS)[0]!);
    poke(region(VrmcPart.KEYS)[0]!);
    const notes = vrmcLink.sent.filter((e) => e.type === EventType.NOTE_ON);
    expect(notes).toHaveLength(2);
    expect(notes[0]!.channel).toBe(9);
    expect(notes[1]!.channel).toBe(0);
  });

  it('releases a pad on the channel it pressed it on', () => {
    // A Note Off on the wrong channel leaves the drum voice ringing, which is
    // the one case where the mismatch is not merely wrong but permanent.
    const pad = region(VrmcPart.PADS)[0]!;
    poke(pad);
    vrmc.releaseAll();
    const offs = vrmcLink.sent.filter(
      (e) => e.type === EventType.NOTE_OFF || (e.type === EventType.NOTE_ON && e.value14 === 0),
    );
    expect(offs.length).toBeGreaterThan(0);
    for (const off of offs) expect(off.channel).toBe(9);
  });

  it('sends its knobs on CC 21..24', () => {
    const knobs = region(VrmcPart.KNOBS);
    expect(knobs).toHaveLength(4);
    const seen: number[] = [];
    for (const zone of knobs) {
      vrmcLink.sent.length = 0;
      dragKnob(vrmc, vrmcSurface, zone, 0.05);
      const cc = vrmcLink.sent.find((e) => e.type === EventType.CONTROL_CHANGE_14);
      expect(cc, `zone ${zone} sent nothing`).toBeDefined();
      seen.push(cc!.data1);
    }
    expect(seen).toEqual([21, 22, 23, 24]);
  });

  it('keeps a hand crossing the knobs from playing a note', () => {
    poke(region(VrmcPart.KNOBS)[0]!);
    expect(vrmcLink.sent.filter((e) => e.type === EventType.NOTE_ON)).toHaveLength(0);
  });
});

/** Grab a control on any device at its centre, drag, and let go. */
function dragKnob(
  device: LaunchpadInstance,
  surface: { zones: readonly { index: number; rect: { x: number; y: number; width: number; height: number }; raise: number }[] },
  zoneIndex: number,
  dy: number,
): void {
  const zone = surface.zones[zoneIndex]!;
  const w = localToWorld(
    device.transform,
    zone.rect.x + zone.rect.width / 2,
    zone.rect.y + zone.rect.height / 2,
    zone.raise,
  );
  const at: [number, number, number] = [w[0]!, w[1]!, w[2]!];
  device.updateContinuous(pinchFrame(at, 0));
  device.updateContinuous(pinchFrame([at[0], at[1] + dy, at[2]], 11));
  device.updateContinuous(openFrame([at[0], at[1] + dy, at[2]], 22));
}
