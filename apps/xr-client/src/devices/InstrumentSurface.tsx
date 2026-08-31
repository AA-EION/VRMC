import { useEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { ZoneLocator } from '@vrmc/layout';
import { buildLabelTexture } from './labels.js';

export interface SurfaceTheme {
  /** Base colour of a resting zone. */
  idle: string;
  /** Base colour of an accidental (black key). */
  idleAccidental: string;
  /** Colour a zone flashes to when struck. */
  active: string;
  /** Backing plate colour. */
  plate: string;
}

export const PAD_THEME: SurfaceTheme = {
  idle: '#2b3350',
  idleAccidental: '#161a28',
  active: '#63e0ff',
  plate: '#0b0e17',
};

export const KEY_THEME: SurfaceTheme = {
  idle: '#eef1f6',
  idleAccidental: '#14161f',
  active: '#63e0ff',
  plate: '#0b0e17',
};

/** Seconds a released zone takes to fade back to its resting colour. */
const FADE_SECONDS = 0.18;

/**
 * A handle for driving zone highlights from the frame loop.
 *
 * Highlighting is done by writing instance colours directly, never through
 * React state. A `setState` per note would re-render the tree on the audio-rate
 * path, and at ten notes a frame that is exactly the stall you cannot afford.
 */
export class SurfaceHighlighter {
  private mesh: InstancedMesh | null = null;
  private readonly idle: Color[];
  private readonly active: Color;
  /**
   * Remaining fade time per zone, in seconds. Only meaningful once a zone has
   * been released — a held zone stays at full brightness and does not fade.
   */
  private readonly fade: Float32Array;
  /** 1 while a finger is on the zone. */
  private readonly held: Uint8Array;
  private readonly scratch = new Color();

  constructor(locator: ZoneLocator, theme: SurfaceTheme) {
    const idleColor = new Color(theme.idle);
    const idleAccidental = new Color(theme.idleAccidental);
    this.idle = locator.zones.map((z) => (z.accidental ? idleAccidental : idleColor));
    this.active = new Color(theme.active);
    this.fade = new Float32Array(locator.zones.length);
    this.held = new Uint8Array(locator.zones.length);
  }

  attach(mesh: InstancedMesh | null): void {
    this.mesh = mesh;
    if (mesh !== null) this.paintAll();
  }

  /**
   * Light a zone and keep it lit for as long as the finger is on it.
   *
   * A key you are holding down has to look held — that is how you see which
   * notes are sounding, and it is what the sustained sound is telling you
   * anyway. Only the release starts the fade.
   */
  strike(zoneIndex: number, _velocity: number): void {
    if (zoneIndex < 0 || zoneIndex >= this.fade.length) return;
    this.held[zoneIndex] = 1;
    this.fade[zoneIndex] = FADE_SECONDS;
    this.paint(zoneIndex, 1);
  }

  /** Begin the fade back to the resting colour. */
  release(zoneIndex: number): void {
    if (zoneIndex < 0 || zoneIndex >= this.fade.length) return;
    this.held[zoneIndex] = 0;
    this.fade[zoneIndex] = FADE_SECONDS;
  }

  /** Fade released zones. Call once per frame with the frame delta in seconds. */
  update(dt: number): void {
    const mesh = this.mesh;
    if (mesh === null) return;
    let dirty = false;
    for (let i = 0; i < this.fade.length; i++) {
      if (this.held[i] === 1) continue; // stays lit until released
      const remaining = this.fade[i]!;
      if (remaining <= 0) continue;
      const next = remaining - dt;
      this.fade[i] = next > 0 ? next : 0;
      this.paint(i, next > 0 ? next / FADE_SECONDS : 0);
      dirty = true;
    }
    if (dirty && mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  /** True while a zone is lit because a finger is on it. */
  isHeld(zoneIndex: number): boolean {
    return this.held[zoneIndex] === 1;
  }

  private paint(zoneIndex: number, mix: number): void {
    const mesh = this.mesh;
    if (mesh === null) return;
    this.scratch.copy(this.idle[zoneIndex] ?? this.active).lerp(this.active, mix);
    mesh.setColorAt(zoneIndex, this.scratch);
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  private paintAll(): void {
    for (let i = 0; i < this.idle.length; i++) this.paint(i, 0);
  }
}

export interface InstrumentSurfaceProps {
  locator: ZoneLocator;
  theme: SurfaceTheme;
  highlighter: SurfaceHighlighter;
  /** World position of the surface's local origin (its bottom-left corner). */
  position: [number, number, number];
  /** World orientation as a quaternion (x, y, z, w). */
  quaternion: [number, number, number, number];
  showLabels?: boolean;
}

/**
 * Renders one playable surface: a backing plate plus an instanced mesh of zones.
 *
 * Every zone is one instance of a unit cube, scaled and placed by its own
 * matrix. 64 pads or 49 keys therefore cost a single draw call, which is what
 * makes room for the frame budget the tracking and network work need.
 */
export function InstrumentSurface({
  locator,
  theme,
  highlighter,
  position,
  quaternion,
  showLabels = true,
}: InstrumentSurfaceProps): React.ReactElement {
  const meshRef = useRef<InstancedMesh>(null);

  const geometry = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        roughness: 0.55,
        metalness: 0.05,
        // Instance colours multiply into this, so it must start white.
        color: '#ffffff',
      }),
    [],
  );

  const labelTexture = useMemo(
    () =>
      showLabels
        ? buildLabelTexture(locator, {
            idle: theme.idle,
            idleAccidental: theme.idleAccidental,
          })
        : null,
    [locator, showLabels, theme.idle, theme.idleAccidental],
  );

  const plateMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: theme.plate,
        roughness: 0.8,
        metalness: 0.1,
        transparent: true,
        // Kept translucent on purpose: this is a mixed-reality instrument, and
        // seeing the desk through it is what keeps it in the room rather than
        // floating on top of it.
        opacity: 0.62,
        side: DoubleSide,
      }),
    [theme.plate],
  );

  // Place each zone's instance. Runs once per layout, never per frame.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const matrix = new Matrix4();
    const translation = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();

    for (const zone of locator.zones) {
      const depth = Math.max(zone.raise, 0.002);
      translation.set(
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
        depth / 2,
      );
      scale.set(zone.rect.width * 0.94, zone.rect.height * 0.94, depth);
      matrix.compose(translation, rotation, scale);
      mesh.setMatrixAt(zone.index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = locator.zones.length;
    highlighter.attach(mesh);
    return () => highlighter.attach(null);
  }, [locator, highlighter]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
      plateMaterial.dispose();
      labelTexture?.dispose();
    };
  }, [geometry, material, plateMaterial, labelTexture]);

  const margin = 0.012;
  const plateW = locator.width + margin * 2;
  const plateH = locator.height + margin * 2;

  /*
   * Labels sit just above the tallest zone, not on the backing plate.
   *
   * The zones are raised boxes, so a label plane at the plate's depth is behind
   * their front faces and is simply occluded — which renders as no labels at
   * all rather than as anything that looks wrong.
   */
  const labelZ = locator.zones.reduce((max, z) => Math.max(max, z.raise), 0) + 0.0008;

  return (
    <group position={position} quaternion={quaternion}>
      {/* Backing plate, sunk just behind the zones. */}
      <mesh position={[locator.width / 2, locator.height / 2, -0.004]} material={plateMaterial}>
        <boxGeometry args={[plateW, plateH, 0.008]} />
      </mesh>

      {labelTexture !== null && (
        <mesh position={[locator.width / 2, locator.height / 2, labelZ]}>
          <planeGeometry args={[locator.width, locator.height]} />
          <meshBasicMaterial map={labelTexture} transparent depthWrite={false} />
        </mesh>
      )}

      <instancedMesh
        ref={meshRef}
        args={[geometry, material, locator.zones.length]}
        frustumCulled={false}
      />
    </group>
  );
}
