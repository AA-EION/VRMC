// SPDX-License-Identifier: GPL-3.0-only

import { LaunchpadLayout, specFor, type DeviceSpec } from '@vrmc/devices';
import { PokeDetector, type NoteSink } from '@vrmc/interaction';
import { DeviceStatus, EventFlags, EventType, VelocityCurve } from '@vrmc/protocol';
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
  readonly transform: SurfaceTransform;
  pose: SurfacePose;

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
