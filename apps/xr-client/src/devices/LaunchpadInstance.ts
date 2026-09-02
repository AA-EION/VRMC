// SPDX-License-Identifier: GPL-3.0-only

import { LaunchpadLayout, specFor, type DeviceSpec } from '@vrmc/devices';
import { PokeDetector, type NoteSink } from '@vrmc/interaction';
import {
  DeviceStatus,
  EventFlags,
  EventType,
  PlacementFlags,
  VelocityCurve,
  type DevicePlacement,
} from '@vrmc/protocol';
import {
  surfaceTransform,
  type SurfacePose,
  type SurfaceTransform,
} from '@vrmc/layout';
import type { BridgeLink } from '../net/BridgeLink.js';
import { LedState } from './LedState.js';

/**
 * One emulated Launchpad living in the room.
 *
 * Bundles everything that has to agree about a single device: its geometry, the
 * poke detector reading fingers against it, the LED state the DAW drives, and
 * the transform that both the renderer and the detector are placed by.
 *
 * Note events carry the device's XY control index rather than a MIDI note. The
 * bridge hands that to its emulator, which knows whether a given index is a
 * velocity-sensitive pad or a switch — so the headset never has to.
 */
export class LaunchpadInstance implements NoteSink {
  readonly deviceId: number;
  readonly spec: DeviceSpec;
  readonly layout: LaunchpadLayout;
  readonly leds: LedState;
  readonly detector: PokeDetector;
  /**
   * Where the device is, in world space.
   *
   * Mutable, and deliberately not `readonly` any more: a grab rewrites it every
   * frame. `setPose` is the only thing that may, because the mesh and the
   * detector both read it and a discrepancy between them does not look broken —
   * the pads simply trigger somewhere other than where they appear.
   */
  transform: SurfaceTransform;
  pose: SurfacePose;

  /**
   * Whether grabs pass straight through this device.
   *
   * Not a tidiness setting. A hand playing a pad grid is constantly inside the
   * volume a grab test looks at, and a finger-drum roll is a sequence of
   * near-pinches at speed — so without this a fast passage eventually reads as
   * somebody dragging the instrument off the desk mid-phrase.
   */
  pinned = false;

  /** True once somebody has actually placed this, rather than it defaulting. */
  placed = false;

  /** True when the pose was resolved against a real surface. */
  anchored = false;

  /** What the bridge last said about this device's ports. */
  status: number = DeviceStatus.PENDING;
  detail = '';

  private readonly link: BridgeLink;

  constructor(deviceId: number, spec: DeviceSpec, pose: SurfacePose, link: BridgeLink) {
    this.deviceId = deviceId;
    this.spec = spec;
    this.link = link;
    this.pose = pose;
    this.layout = new LaunchpadLayout(spec);
    this.leds = new LedState(this.layout.zones.length);

    this.detector = new PokeDetector(this.layout, {
      // A Launchpad's pads are small and close together, so sliding between
      // them mid-press is far more often a miss than an intended roll.
      glissando: false,
      // Grid pads are shallow; a smaller release margin keeps them responsive
      // without dipping into the tracking noise floor.
      releaseMargin: 0.0035,
      velocityGamma: VelocityCurve.SOFT,
      // The hardware sends polyphonic aftertouch, so the detector should too.
      aftertouchInterval: spec.polyAftertouch ? 4 : 0,
    });

    this.transform = surfaceTransform(this.layout, pose);
    this.syncDetector();
  }

  /**
   * Move the device.
   *
   * The single path by which a pose changes, so the transform the renderer
   * draws at and the transform the detector inverts can never be derived
   * separately. `placement.ts` is explicit about why that matters: the failure
   * mode is not a visible break but pads that trigger slightly away from where
   * they are drawn, which is far harder to diagnose.
   */
  setPose(pose: SurfacePose): void {
    this.pose = pose;
    this.transform = surfaceTransform(this.layout, pose);
    this.syncDetector();
    this.placed = true;
  }

  /** This device's placement, for the wire. */
  placement(): DevicePlacement {
    return {
      deviceId: this.deviceId,
      flags:
        (this.pinned ? PlacementFlags.PINNED : 0) |
        (this.anchored ? PlacementFlags.ANCHORED : 0),
      centre: [this.pose.centre[0], this.pose.centre[1], this.pose.centre[2]],
      yawDeg: this.pose.yawDeg ?? 0,
      tiltDeg: this.pose.tiltDeg,
    };
  }

  private syncDetector(): void {
    const { origin, quaternion } = this.transform;
    this.detector.setPose(
      origin[0],
      origin[1],
      origin[2],
      quaternion[0],
      quaternion[1],
      quaternion[2],
      quaternion[3],
    );
  }

  /** Apply an LED update from the bridge, addressed by device XY index. */
  applyLed(ledIndex: number, r: number, g: number, b: number, blink: number): void {
    const zone = this.layout.zoneForIndex(ledIndex);
    if (zone < 0) return;
    this.leds.setLed(zone, r, g, b, blink);
  }

  // --- NoteSink: the detector's output ---

  noteOn(zoneIndex: number, controlIndex: number, velocity: number, tOffsetMs: number, flags: number): void {
    // Light it immediately rather than waiting for the DAW to agree. The round
    // trip is short but not instant, and a pad that does not acknowledge a
    // touch until the host says so feels broken rather than remote.
    this.leds.touch(zoneIndex);
    this.link.push(
      EventType.NOTE_ON,
      0,
      controlIndex,
      velocity,
      0,
      this.deviceId,
      flags,
      tOffsetMs,
    );
  }

  noteOff(zoneIndex: number, controlIndex: number, tOffsetMs: number): void {
    this.leds.release(zoneIndex);
    this.link.push(
      EventType.NOTE_OFF,
      0,
      controlIndex,
      0,
      0,
      this.deviceId,
      EventFlags.NONE,
      tOffsetMs,
    );
  }

  aftertouch(_zoneIndex: number, controlIndex: number, pressure: number): void {
    this.link.push(
      EventType.AFTERTOUCH_POLY,
      0,
      controlIndex,
      pressure,
      0,
      this.deviceId,
      EventFlags.NONE,
      0,
    );
  }

  /** Release anything held. Called when the device is removed or torn down. */
  releaseAll(): void {
    this.detector.releaseAll(this);
    this.leds.clear();
  }
}

/** Build an instance for a model, or null if the model is not emulated. */
export function createLaunchpad(
  deviceId: number,
  model: string,
  pose: SurfacePose,
  link: BridgeLink,
): LaunchpadInstance | null {
  const spec = specFor(model);
  return spec === null ? null : new LaunchpadInstance(deviceId, spec, pose, link);
}
