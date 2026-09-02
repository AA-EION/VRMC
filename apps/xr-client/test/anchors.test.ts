import { describe, it, expect } from 'vitest';
import { localToWorld, surfaceNormal, surfaceTransform, MPC_4X4, PadGridLayout } from '@vrmc/layout';
import {
  FLAT_TILT_DEG,
  SURFACE_BAND,
  SURFACE_CLEARANCE,
  bestSurface,
  isPlayableSurface,
  poseOnSurface,
} from '../src/xr/anchors.js';

const grid = new PadGridLayout(MPC_4X4);
const floating = { centre: [0.4, 0.95, -0.52] as [number, number, number], tiltDeg: 48 };

describe('putting a device down', () => {
  it('lays it flat, face up', () => {
    const pose = poseOnSurface(floating, 0.74, [0, 1.6, 0]);
    expect(pose.tiltDeg).toBe(FLAT_TILT_DEG);
    const n = surfaceNormal(surfaceTransform(grid, pose));
    expect(n[1]).toBeCloseTo(1, 6);
  });

  it('rests it on the surface rather than in it', () => {
    /*
     * The clearance is not fussiness. Hit tests and plane detection both report
     * a surface with a centimetre or so of uncertainty, and a device placed at
     * exactly the reported height sinks into the desk about half the time —
     * which in passthrough reads as the instrument being inside the furniture.
     */
    const pose = poseOnSurface(floating, 0.74, [0, 1.6, 0]);
    expect(pose.centre[1]).toBeGreaterThan(0.74);
    expect(pose.centre[1] - 0.74).toBeCloseTo(SURFACE_CLEARANCE, 9);
  });

  it('keeps it where it was, horizontally', () => {
    // Dropping is a vertical move. A device that also slid sideways is one you
    // then have to go and find.
    const pose = poseOnSurface(floating, 0.74, [0, 1.6, 0]);
    expect(pose.centre[0]).toBeCloseTo(0.4, 9);
    expect(pose.centre[2]).toBeCloseTo(-0.52, 9);
  });

  it('turns its far edge away from the player', () => {
    /*
     * The whole of «drop it on the desk»: a device you then have to turn by
     * hand has not been put down for you. Checked through the transform rather
     * than against the yaw number, since the yaw is only correct in so far as
     * it produces this.
     */
    for (const viewer of [
      [0, 1.6, 0],
      [1.5, 1.6, 0.5],
      [-2, 1.6, -3],
      [0, 1.6, -2],
    ] as Array<[number, number, number]>) {
      const pose = poseOnSurface(floating, 0.74, viewer);
      const t = surfaceTransform(grid, pose);
      const near = localToWorld(t, grid.width / 2, 0, 0);
      const far = localToWorld(t, grid.width / 2, grid.height, 0);
      const distance = (p: [number, number, number]): number =>
        Math.hypot(p[0] - viewer[0], p[2] - viewer[2]);
      expect(distance(far)).toBeGreaterThan(distance(near));
    }
  });

  it('keeps the yaw it had when the player is standing over it', () => {
    // Two numbers that are both nearly zero make atan2 report a direction that
    // is really just noise, and a device that spins as you lean is worse than
    // one that did not turn.
    const above = poseOnSurface({ ...floating, yawDeg: 33 }, 0.74, [0.4, 1.6, -0.52]);
    expect(above.yawDeg).toBe(33);
  });
});

describe('choosing which surface', () => {
  it('takes the highest one under the device', () => {
    // A desk stands above the floor it is on, and the desk is what was meant.
    expect(bestSurface([0.0, 0.45, 0.74], 0.95)).toBe(0.74);
  });

  it('ignores anything above the device', () => {
    expect(bestSurface([1.2, 0.74], 0.95)).toBe(0.74);
  });

  it('refuses the floor and the ceiling', () => {
    /*
     * A room is full of horizontal surfaces and most of them are the floor. A
     * Launchpad placed on the ceiling — or at ankle height — is worse than one
     * left floating where it was, so nothing outside the band a person would
     * actually rest a controller on is used.
     */
    expect(isPlayableSurface(0)).toBe(false);
    expect(isPlayableSurface(2.4)).toBe(false);
    expect(isPlayableSurface(0.74)).toBe(true);
    expect(bestSurface([0, 2.4], 1.5)).toBeNull();
  });

  it('answers null rather than zero when there is nothing to land on', () => {
    // The caller has to treat this as «leave it where it is»; a zero would put
    // the device on the floor.
    expect(bestSurface([], 0.95)).toBeNull();
  });

  it('does not make a device already resting on a surface sink into it', () => {
    // Dropping twice must be idempotent, or each press buries the device by its
    // own clearance.
    const resting = 0.74 + SURFACE_CLEARANCE;
    expect(bestSurface([0.74], resting)).toBe(0.74);
    const pose = poseOnSurface({ centre: [0, resting, 0], tiltDeg: 90 }, 0.74, [0, 1.6, 1]);
    expect(pose.centre[1]).toBeCloseTo(resting, 9);
  });

  it('states a band a person would actually use', () => {
    expect(SURFACE_BAND.low).toBeGreaterThan(0.1);
    expect(SURFACE_BAND.high).toBeLessThan(1.6);
  });
});
