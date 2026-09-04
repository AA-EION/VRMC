// SPDX-License-Identifier: GPL-3.0-only

import {
  DeviceModel,
  isContinuousPart,
  LaunchkeySurface,
  LaunchpadLayout,
  specFor,
  type DeviceSpec,
} from '@vrmc/devices';

/**
 * What the renderer needs of a surface, beyond locating a zone.
 *
 * The two implementations answer these identically and nothing else has to
 * know which it is holding.
 */
export type DeviceSurface = LaunchpadLayout | LaunchkeySurface;
import {
  KnobControl,
  PokeDetector,
  type ControlSink,
  type FingerFrame,
  type NoteSink,
} from '@vrmc/interaction';
import {
  DeviceStatus,
  EventFlags,
  EventType,
  PlacementFlags,
  VelocityCurve,
  type DevicePlacement,
} from '@vrmc/protocol';
import {
  localToWorld,
  localToWorldInto,
  maskPokeable,
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
  /**
   * The surface, which is not always a Launchpad's.
   *
   * A `LaunchpadLayout` for the grids, a `LaunchkeySurface` for the keyboard —
   * both answer the same three questions beyond a bare locator (the spec, the
   * LED index lookup, the logo), so one renderer draws either. Typed as the
   * union rather than as a bare `ZoneLocator` because the renderer needs those
   * three, and widening it here would only move the problem.
   */
  readonly layout: DeviceSurface;
  readonly leds: LedState;

  /**
   * The zones that are pinched rather than poked, and their `KnobControl`.
   *
   * Empty for every Launchpad, which has no continuous controls at all — the
   * whole of this costs those devices one empty Set and one early return.
   */
  private readonly continuous: ReadonlySet<number>;
  private readonly knobs = new KnobControl();
  /** Knob index -> the zone it belongs to, so a value can name its control. */
  private readonly knobZones: number[] = [];
  private readonly knobSink: ControlSink;
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

  /**
   * The last text the DAW sent this device, or ''.
   *
   * Real hardware scrolls it across the grid a character at a time. There is
   * nothing to scroll it across here — the grid is showing the DAW's own
   * colours — so it is drawn as a label above the device, which is more
   * legible than a Launchpad has ever managed.
   */
  displayText = '';

  /** What the bridge last said about this device's ports. */
  status: number = DeviceStatus.PENDING;
  detail = '';

  private readonly link: BridgeLink;

  /**
   * Told about each strike, with the world position of the pad that was hit.
   *
   * Emulated hardware had no tactile audio at all: the built-in surfaces
   * clicked and a Launchpad — the device most people actually play — was
   * silent until the DAW answered. A virtual pad has no edge to feel, so
   * without something immediate you cannot tell a hit from a near miss.
   */
  onStrike: ((note: number, velocity: number, at: Float32Array) => void) | null = null;

  /** Scratch for a struck pad's world position. One per device, not per note. */
  private readonly strikeAt = new Float32Array(3);

  constructor(deviceId: number, spec: DeviceSpec, pose: SurfacePose, link: BridgeLink) {
    this.deviceId = deviceId;
    this.spec = spec;
    this.link = link;

    /*
     * A knob's value is sent as the MIDI CC itself, not as a control id.
     *
     * Unlike a press, which the bridge hands to the emulator to turn into a
     * message, a 14-bit CC goes straight to the port — so the number sent has
     * to be the one a DAW will act on. `data1` is that number; the id would
     * arrive as some other CC entirely.
     */
    this.knobSink = {
      onValue: (knobIndex: number, value14: number, flags: number) => {
        const zone = this.layout.zones[this.knobZones[knobIndex] ?? -1];
        const control =
          zone === undefined
            ? undefined
            : spec.controls.find((c) => c.index === zone.note);
        const cc = control?.data1 ?? control?.index;
        if (cc === undefined) return;
        this.link.push(
          EventType.CONTROL_CHANGE_14,
          0,
          cc,
          0,
          value14,
          this.deviceId,
          flags,
          0,
        );
      },
      onGrab: () => {},
      onRelease: () => {},
    };
    this.pose = pose;
    this.layout = buildSurface(spec);
    this.leds = new LedState(this.layout.zones.length);

    /*
     * The detector sees only the pokeable zones.
     *
     * A Launchkey's faders sit between its keys and its pads, so a hand
     * crossing the instrument passes over them constantly — a detector given
     * the whole surface would fire a note every time, which is the ordinary
     * path across the device rather than an edge case. The zones stay in the
     * array so they are still drawn and still lit; only locating is masked.
     */
    this.continuous = continuousZones(this.layout);
    this.detector = new PokeDetector(
      this.continuous.size === 0
        ? this.layout
        : maskPokeable(this.layout, (i: number) => !this.continuous.has(i)),
      {
      // A Launchpad's pads are small and close together, so sliding between
      // them mid-press is far more often a miss than an intended roll.
      glissando: false,
      // Grid pads are shallow; a smaller release margin keeps them responsive
      // without dipping into the tracking noise floor.
      releaseMargin: 0.0035,
      velocityGamma: VelocityCurve.SOFT,
      // The hardware sends polyphonic aftertouch, so the detector should too.
      aftertouchInterval: spec.polyAftertouch ? 4 : 0,
    },
    );

    this.transform = surfaceTransform(this.layout, pose);
    this.syncDetector();
    this.buildKnobs();
  }

  /**
   * Register the knobs and faders with `KnobControl`, in world space.
   *
   * They are pinched and dragged rather than poked, so they do not go through
   * the detector at all — `KnobControl` works from fingertip positions and a
   * grab radius, and knows nothing about surfaces. Which is why they have to be
   * repositioned whenever the device moves: nothing else would.
   */
  private buildKnobs(): void {
    if (this.continuous.size === 0) return;
    for (const zoneIndex of this.continuous) {
      const zone = this.layout.zones[zoneIndex]!;
      const world = localToWorld(
        this.transform,
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
        zone.raise,
      );
      this.knobZones.push(zoneIndex);
      this.knobs.addKnob(world[0], world[1], world[2], 0.5);
    }
  }

  /** Move every knob to follow the device. */
  private placeKnobs(): void {
    for (const [i, zoneIndex] of this.knobZones.entries()) {
      const zone = this.layout.zones[zoneIndex]!;
      const world = localToWorld(
        this.transform,
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
        zone.raise,
      );
      this.knobs.setKnobPosition(i, world[0], world[1], world[2]);
    }
  }

  /**
   * Advance the continuous controls.
   *
   * Separate from the detector's update because they consume the same fingertip
   * frame in different ways — one looks for a surface crossing, the other for a
   * pinch — and a hand can legitimately be doing both at once on a device this
   * size.
   */
  updateContinuous(frame: FingerFrame): void {
    if (this.knobZones.length === 0) return;
    this.knobs.update(frame, this.knobSink);
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
    // The knobs live in world space, so they do not follow the surface on their
    // own. A device moved without this keeps its faders where it used to be.
    this.placeKnobs();
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

    const zone = this.layout.zones[zoneIndex];
    if (this.onStrike !== null && zone !== undefined) {
      localToWorldInto(
        this.transform,
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
        zone.raise,
        this.strikeAt,
      );
      // Pitched by the control index rather than by a MIDI note, since a
      // Launchpad's grid does not carry one — it is a position on a surface,
      // and the click only has to make a run legible.
      this.onStrike(48 + (controlIndex % 36), velocity, this.strikeAt);
    }
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

/**
 * The surface a spec describes.
 *
 * A Launchpad is one uniform grid, so its controls' rows and columns are
 * enough. A Launchkey is four regions at different scales and cannot be
 * described that way at all — 49 keys and 8 pads on one pitch would put them
 * in the same row, at the same size.
 */
function buildSurface(spec: DeviceSpec): DeviceSurface {
  return spec.model === DeviceModel.LAUNCHKEY_MK3_49
    ? new LaunchkeySurface(spec)
    : new LaunchpadLayout(spec);
}

/**
 * Which zones are pinched rather than poked.
 *
 * Asked of the surface rather than assumed from the model, so a device that
 * gains a fader row later needs no change here.
 */
function continuousZones(surface: DeviceSurface): ReadonlySet<number> {
  if (!(surface instanceof LaunchkeySurface)) return EMPTY_ZONES;
  const out = new Set<number>();
  for (const zone of surface.zones) {
    if (isContinuousPart(surface.partOf(zone.index))) out.add(zone.index);
  }
  return out;
}

const EMPTY_ZONES: ReadonlySet<number> = new Set<number>();

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
