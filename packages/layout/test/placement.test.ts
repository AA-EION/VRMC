import { describe, it, expect } from 'vitest';
import { MPC_4X4, PadGridLayout } from '../src/pads.js';
import { localToWorld, surfaceNormal, surfaceTransform } from '../src/placement.js';

const grid = new PadGridLayout(MPC_4X4);

describe('surfaceTransform', () => {
  it('leaves an untilted panel upright, facing the player', () => {
    const t = surfaceTransform(grid, { centre: [0, 1, -0.5], tiltDeg: 0 });
    // Identity rotation. Compared component-wise because Math.sin(-0) is -0,
    // which is numerically identical to 0 but not deep-equal to it.
    expect(t.quaternion[0]).toBeCloseTo(0, 12);
    expect(t.quaternion[1]).toBeCloseTo(0, 12);
    expect(t.quaternion[2]).toBeCloseTo(0, 12);
    expect(t.quaternion[3]).toBeCloseTo(1, 12);
    // Origin is the bottom-left corner, half the extents from the centre.
    expect(t.origin[0]).toBeCloseTo(-grid.width / 2, 10);
    expect(t.origin[1]).toBeCloseTo(1 - grid.height / 2, 10);
    expect(t.origin[2]).toBeCloseTo(-0.5, 10);

    const n = surfaceNormal(t);
    expect(n[0]).toBeCloseTo(0, 10);
    expect(n[1]).toBeCloseTo(0, 10);
    expect(n[2]).toBeCloseTo(1, 10); // toward the player, at +Z
  });

  it('points a fully tilted panel face-up, as if lying on the desk', () => {
    const t = surfaceTransform(grid, { centre: [0, 0.75, -0.4], tiltDeg: 90 });
    const n = surfaceNormal(t);
    expect(n[0]).toBeCloseTo(0, 10);
    expect(n[1]).toBeCloseTo(1, 10); // straight up
    expect(n[2]).toBeCloseTo(0, 10);
  });

  it('tilts partway to a normal between up and toward the player', () => {
    const t = surfaceTransform(grid, { centre: [0, 0.9, -0.5], tiltDeg: 45 });
    const n = surfaceNormal(t);
    expect(n[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('round-trips the surface centre back through localToWorld', () => {
    for (const tiltDeg of [0, 30, 45, 74, 90]) {
      const centre: [number, number, number] = [0.2, 0.85, -0.45];
      const t = surfaceTransform(grid, { centre, tiltDeg });
      const back = localToWorld(t, grid.width / 2, grid.height / 2, 0);
      expect(back[0]).toBeCloseTo(centre[0], 10);
      expect(back[1]).toBeCloseTo(centre[1], 10);
      expect(back[2]).toBeCloseTo(centre[2], 10);
    }
  });

  it('produces a unit quaternion at every tilt', () => {
    for (let tiltDeg = 0; tiltDeg <= 90; tiltDeg += 7.5) {
      const [x, y, z, w] = surfaceTransform(grid, { centre: [0, 1, -1], tiltDeg }).quaternion;
      expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 12);
    }
  });

  it('moves a point along the local normal in the same direction as the normal', () => {
    const t = surfaceTransform(grid, { centre: [0, 0.8, -0.4], tiltDeg: 60 });
    const onSurface = localToWorld(t, 0.02, 0.02, 0);
    const above = localToWorld(t, 0.02, 0.02, 0.05);
    const n = surfaceNormal(t);
    for (let axis = 0; axis < 3; axis++) {
      expect(above[axis] - onSurface[axis]).toBeCloseTo(n[axis] * 0.05, 10);
    }
  });
});
