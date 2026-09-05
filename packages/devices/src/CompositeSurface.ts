// SPDX-License-Identifier: GPL-3.0-only

import type { TriggerZone, ZoneLocator } from '@vrmc/layout';
import { CompositeLayout, type SurfacePart } from '@vrmc/layout';
import { ButtonRole, type DeviceSpec } from './types.js';

/**
 * A device made of several regions on one plane.
 *
 * A Launchpad is one grid at one pitch and needs none of this. A Launchkey and
 * the VRMC surface are both keys, pads and continuous controls sharing a plane,
 * and the only thing that differs between them is which regions, where, and on
 * what channel — so the shape below is the description, and the two devices are
 * two lists of regions rather than two classes that have to keep agreeing.
 */
export interface SurfaceRegion {
  /** Identifies the region to callers that care — "keys", "pads", "knobs". */
  part: string;
  /**
   * Which of the spec's controls fill it.
   *
   * The zones are renumbered to those controls' ids, in order. Matching by
   * role rather than by position means a spec that lists its regions in a
   * different order still lines up, and a mismatch in count throws.
   */
  role: ButtonRole;
  locator: ZoneLocator;
  /** Offset of the region's origin within the surface, in metres. */
  x: number;
  y: number;
  /**
   * Pinched and dragged rather than poked.
   *
   * The poke detector is not given these zones at all. A hand crossing from
   * the keys to the pads passes over the fader row every time, so a detector
   * that could see them would fire a note on the ordinary path across the
   * instrument.
   */
  continuous?: boolean;
  /**
   * The MIDI channel this region sends on, 0-based. Defaults to 0.
   *
   * A property of the region and not of each control in it: a pad grid is on
   * channel 10 because it is a drum rack, which is a fact about the region.
   */
  channel?: number;
  /**
   * True when the DAW can light this region.
   *
   * Only lit regions are addressable by LED index, and for a good reason: a
   * zone carries the number it sends, and on these devices a key and a fader
   * can send the same one. A map over every region would have the second
   * overwrite the first, and an LED meant for a pad could light a key.
   */
  lit?: boolean;
}

/**
 * Build the composite layout for a set of regions.
 *
 * Exported because the layout is worth testing without the surface around it —
 * the geometry is what decides whether a poke lands on the control the player
 * aimed at, and it is wrong in a way that looks fine from outside.
 */
export function buildCompositeLayout(
  spec: DeviceSpec,
  regions: readonly SurfaceRegion[],
): CompositeLayout {
  const parts: SurfacePart[] = regions.map((r) => ({
    id: r.part,
    locator: r.locator,
    x: r.x,
    y: r.y,
  }));

  /*
   * The zones carry control *ids*, not MIDI numbers.
   *
   * The sub-layouts number theirs with MIDI values, because that is what they
   * are for elsewhere. Here those are the wrong numbers: a zone's `note` is
   * what the headset sends back as a control index. With MIDI values a
   * Launchkey would look up key 41 and find fader 6, or the reverse, depending
   * on which the lookup table happened to hold — seventeen controls collide
   * that way — and a VRMC pad on note 48 would find the key of the same pitch.
   */
  const idsByRole = new Map<string, number[]>();
  for (const control of spec.controls) {
    const list = idsByRole.get(control.role) ?? [];
    list.push(control.index);
    idsByRole.set(control.role, list);
  }
  const roleOfPart = new Map(regions.map((r) => [r.part, r.role as string]));

  return new CompositeLayout(parts, (_zone, origin) => {
    const ids = idsByRole.get(roleOfPart.get(origin.part) ?? '') ?? [];
    const id = ids[origin.localIndex];
    if (id === undefined) {
      throw new Error(
        `the ${origin.part} layout has ${origin.localIndex + 1} zones but the ` +
          `spec declares ${ids.length} controls for it`,
      );
    }
    return id;
  });
}

/**
 * A composite device, wearing the interface the renderer already speaks.
 *
 * `LaunchpadLayout` offers three things beyond a bare `ZoneLocator` — the spec
 * it was built from, a device-index-to-zone lookup for LED addressing, and the
 * logo's position — and the renderer uses all three. Providing them here means
 * one renderer draws every device rather than several that drift apart.
 */
export class CompositeSurface implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;
  readonly spec: DeviceSpec;
  readonly composite: CompositeLayout;

  private readonly litZoneByNote: ReadonlyMap<number, number>;
  /** Zone index -> MIDI channel, and zone index -> pinched rather than poked. */
  private readonly channels: Uint8Array;
  private readonly continuousZones: Uint8Array;
  private readonly parts: readonly string[];
  /** Zone index -> the role of the region it belongs to. */
  private readonly roles: readonly ButtonRole[];

  constructor(spec: DeviceSpec, regions: readonly SurfaceRegion[]) {
    this.spec = spec;
    this.composite = buildCompositeLayout(spec, regions);
    this.zones = this.composite.zones;
    this.width = this.composite.width;
    this.height = this.composite.height;

    this.channels = new Uint8Array(this.zones.length);
    this.continuousZones = new Uint8Array(this.zones.length);
    this.parts = this.zones.map((z) => this.composite.originOf(z.index)?.part ?? '');
    const roleOfPart = new Map(regions.map((r) => [r.part, r.role]));
    this.roles = this.parts.map((part) => roleOfPart.get(part) ?? ButtonRole.GRID);

    const lit = new Map<number, number>();
    for (const region of regions) {
      for (const zone of this.composite.zonesOf(region.part)) {
        this.channels[zone.index] = (region.channel ?? 0) & 0x0f;
        if (region.continuous === true) this.continuousZones[zone.index] = 1;
        if (region.lit === true) lit.set(zone.note, zone.index);
      }
    }
    this.litZoneByNote = lit;
  }

  locate(x: number, y: number): number {
    return this.composite.locate(x, y);
  }

  /** The zone an LED message addresses, or -1. See `SurfaceRegion.lit`. */
  zoneForIndex(deviceIndex: number): number {
    return this.litZoneByNote.get(deviceIndex) ?? -1;
  }

  /** Which region a zone belongs to, so callers can route it. */
  partOf(zoneIndex: number): string {
    return this.parts[zoneIndex] ?? '';
  }

  /**
   * What kind of control this zone is.
   *
   * The renderer's question, not the router's: a knob is drawn as a knob and a
   * fader as a cap on a track, and both are the same zone rectangle to
   * everything else.
   */
  roleOf(zoneIndex: number): ButtonRole {
    return this.roles[zoneIndex] ?? ButtonRole.GRID;
  }

  /** True when this zone is pinched and dragged rather than poked. */
  isContinuous(zoneIndex: number): boolean {
    return this.continuousZones[zoneIndex] === 1;
  }

  /** The MIDI channel this zone sends on, 0-based. */
  channelOf(zoneIndex: number): number {
    return this.channels[zoneIndex] ?? 0;
  }

  /** No illuminated logo on a composite device. */
  logoPosition(): { x: number; y: number } | null {
    return null;
  }
}
