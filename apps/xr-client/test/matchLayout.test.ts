import { describe, it, expect } from 'vitest';
import { PlacementFlags, type DevicePlacement, type Layout } from '@vrmc/protocol';
import { matchLayout } from '../src/devices/matchLayout.js';

function placement(deviceId: number, x: number): DevicePlacement {
  return {
    deviceId,
    flags: PlacementFlags.NONE,
    centre: [x, 0.95, -0.52],
    yawDeg: 0,
    tiltDeg: 48,
  };
}

function entry(deviceId: number, model: string, x: number): Layout['entries'][number] {
  return { placement: placement(deviceId, x), model };
}

const X = 'launchpad-x';
const PRO = 'launchpad-pro-mk3';

describe('matching a saved arrangement to what is actually here', () => {
  it('matches on id and model when nothing has changed', () => {
    const matched = matchLayout(
      [entry(16, X, 0.4), entry(17, PRO, -0.4)],
      [
        { deviceId: 16, model: X },
        { deviceId: 17, model: PRO },
      ],
    );
    expect(matched).toHaveLength(2);
    expect(matched[0]!.device.deviceId).toBe(16);
    expect(matched[0]!.placement.centre[0]).toBeCloseTo(0.4);
    expect(matched[1]!.device.deviceId).toBe(17);
  });

  it('falls back to the model when the ids have moved', () => {
    /*
     * The case the model exists for. Ids are handed out per session and are not
     * stable across a restart of the bridge, so a layout saved yesterday can
     * arrive today with every id different.
     */
    const matched = matchLayout(
      [entry(16, X, 0.4), entry(17, PRO, -0.4)],
      [
        { deviceId: 32, model: X },
        { deviceId: 33, model: PRO },
      ],
    );
    expect(matched).toHaveLength(2);
    expect(matched.find((m) => m.device.model === X)!.placement.centre[0]).toBeCloseTo(0.4);
    expect(matched.find((m) => m.device.model === PRO)!.placement.centre[0]).toBeCloseTo(-0.4);
  });

  it('never puts a Pro where an X was, even when the id says so', () => {
    /*
     * The failure the two-pass match exists to prevent, and the reason the id
     * pass requires the model to agree as well. An id collision between a saved
     * entry and a different piece of hardware is exactly what a bridge restart
     * produces.
     */
    const matched = matchLayout(
      [entry(16, X, 0.4)],
      [{ deviceId: 16, model: PRO }],
    );
    expect(matched).toHaveLength(0);
  });

  it('keeps two of the same model in the order they were saved', () => {
    // Two Launchpad X's have nothing to tell them apart but their order, so
    // taking them in order is what keeps their left-right relationship.
    const matched = matchLayout(
      [entry(90, X, -0.5), entry(91, X, 0.5)],
      [
        { deviceId: 16, model: X },
        { deviceId: 17, model: X },
      ],
    );
    expect(matched).toHaveLength(2);
    expect(matched[0]!.device.deviceId).toBe(16);
    expect(matched[0]!.placement.centre[0]).toBeCloseTo(-0.5);
    expect(matched[1]!.device.deviceId).toBe(17);
    expect(matched[1]!.placement.centre[0]).toBeCloseTo(0.5);
  });

  it('prefers an exact match over an earlier model-only one', () => {
    /*
     * Both passes matter and their order matters. The first entry could be
     * satisfied by either device on model alone; running the exact pass over
     * everything first means device 17 keeps the entry that actually names it.
     */
    const matched = matchLayout(
      [entry(99, X, -0.5), entry(17, X, 0.5)],
      [
        { deviceId: 16, model: X },
        { deviceId: 17, model: X },
      ],
    );
    const seventeen = matched.find((m) => m.device.deviceId === 17)!;
    expect(seventeen.placement.centre[0]).toBeCloseTo(0.5);
    const sixteen = matched.find((m) => m.device.deviceId === 16)!;
    expect(sixteen.placement.centre[0]).toBeCloseTo(-0.5);
  });

  it('drops an entry for hardware that is not here', () => {
    const matched = matchLayout(
      [entry(16, X, 0.4), entry(17, PRO, -0.4)],
      [{ deviceId: 16, model: X }],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]!.device.model).toBe(X);
  });

  it('leaves a device the arrangement said nothing about alone', () => {
    /*
     * Not the same as saying it should move. An arrangement that named two
     * devices has no opinion about a third, and moving it somewhere neutral
     * would be inventing one.
     */
    const devices = [
      { deviceId: 16, model: X },
      { deviceId: 17, model: PRO },
    ];
    const matched = matchLayout([entry(16, X, 0.4)], devices);
    expect(matched).toHaveLength(1);
    expect(matched.some((m) => m.device.deviceId === 17)).toBe(false);
  });

  it('never uses one device twice', () => {
    const matched = matchLayout(
      [entry(16, X, 0.1), entry(16, X, 0.2), entry(16, X, 0.3)],
      [{ deviceId: 16, model: X }],
    );
    expect(matched).toHaveLength(1);
    expect(new Set(matched.map((m) => m.device.deviceId)).size).toBe(1);
  });

  it('handles an empty arrangement and an empty room', () => {
    expect(matchLayout([], [{ deviceId: 16, model: X }])).toHaveLength(0);
    expect(matchLayout([entry(16, X, 0)], [])).toHaveLength(0);
  });
});
