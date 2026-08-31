// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  DoubleSide,
  ExtrudeGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  Vector3,
} from 'three';
import type { LaunchpadLayout } from '@vrmc/devices';
import type { LedState } from './LedState.js';

/**
 * Build a rounded-square pad, extruded to a shallow depth.
 *
 * A Launchpad's pads are unmistakably rounded squares, and a plain box reads as
 * a generic grid instead of the instrument being emulated. three's core has no
 * rounded box, so the profile is drawn as a `Shape` and extruded — one geometry
 * shared by every instance, so the extra vertices cost one upload, not 81.
 */
function roundedPadGeometry(size: number, radiusFraction: number, depth: number): ExtrudeGeometry {
  const r = Math.min(size / 2, size * radiusFraction);
  const half = size / 2;
  const shape = new Shape();
  shape.moveTo(-half + r, -half);
  shape.lineTo(half - r, -half);
  shape.quadraticCurveTo(half, -half, half, -half + r);
  shape.lineTo(half, half - r);
  shape.quadraticCurveTo(half, half, half - r, half);
  shape.lineTo(-half + r, half);
  shape.quadraticCurveTo(-half, half, -half, half - r);
  shape.lineTo(-half, -half + r);
  shape.quadraticCurveTo(-half, -half, -half + r, -half);

  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 4,
  });
  // Extrude runs along +Z from 0; centre it so instance transforms can treat
  // the pad's middle as its origin.
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

export interface LaunchpadSurfaceProps {
  layout: LaunchpadLayout;
  leds: LedState;
  /** World position of the surface's local origin (its bottom-left corner). */
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/**
 * Renders one emulated Launchpad.
 *
 * Every control is an instance of the same rounded pad, so a 9x9 or 10x10
 * surface is a single draw call and several devices at once stay affordable on
 * a mobile GPU. Colours come from `LedState`, which the DAW drives.
 */
export function LaunchpadSurface({
  layout,
  leds,
  position,
  quaternion,
}: LaunchpadSurfaceProps): React.ReactElement {
  const meshRef = useRef<InstancedMesh>(null);
  const spec = layout.spec;

  const geometry = useMemo(
    () => roundedPadGeometry(spec.padSize, spec.padRadius, 0.005),
    [spec.padSize, spec.padRadius],
  );

  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        // Instance colours multiply into this, so it must start white.
        color: '#ffffff',
        roughness: 0.42,
        metalness: 0.0,
        // No emissive term, despite these being LEDs.
        //
        // `emissive` is a single uniform shared by every instance — three only
        // multiplies `instanceColor` into the diffuse — so any emissive glow
        // would apply equally to all 80 pads and wash the whole surface white
        // regardless of what the DAW lit. The scene's ambient light is strong
        // enough to carry the colours, and the rounded edges still catch the
        // directional light, which is what makes them read as objects.
      }),
    [],
  );

  const bodyMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#0a0c12',
        roughness: 0.85,
        metalness: 0.15,
        transparent: true,
        opacity: 0.88,
        side: DoubleSide,
      }),
    [],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const matrix = new Matrix4();
    const translation = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3(1, 1, 1);

    for (const zone of layout.zones) {
      translation.set(
        zone.rect.x + zone.rect.width / 2,
        zone.rect.y + zone.rect.height / 2,
        zone.raise,
      );
      // The surrounding function buttons are physically smaller and rounder
      // than the grid pads. Scaling the shared geometry down is enough to read
      // as that distinction without a second mesh.
      const s = zone.accidental ? 0.74 : 1;
      scale.set(s, s, 1);
      matrix.compose(translation, rotation, scale);
      mesh.setMatrixAt(zone.index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = layout.zones.length;
    leds.attach(mesh);
    return () => leds.attach(null);
  }, [layout, leds]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      bodyMaterial.dispose();
    },
    [geometry, material, bodyMaterial],
  );

  useFrame((state, delta) => {
    leds.update(delta, state.clock.elapsedTime);
  });

  const margin = 0.008;
  const bodyW = layout.width + margin * 2;
  const bodyH = layout.height + margin * 2;
  const logo = layout.logoPosition();

  return (
    <group position={position} quaternion={quaternion}>
      {/* The chassis. Slightly translucent so the desk shows through and the
          device sits in the room rather than on top of it. */}
      <mesh position={[layout.width / 2, layout.height / 2, -0.005]} material={bodyMaterial}>
        <boxGeometry args={[bodyW, bodyH, 0.01]} />
      </mesh>

      <instancedMesh
        ref={meshRef}
        args={[geometry, material, layout.zones.length]}
        frustumCulled={false}
      />

      {logo !== null && (
        <mesh position={[logo.x, logo.y, 0.002]}>
          <circleGeometry args={[spec.padSize * 0.3, 16]} />
          <meshStandardMaterial
            color="#1a2033"
            emissive="#2a4a6a"
            emissiveIntensity={0.4}
            roughness={0.5}
          />
        </mesh>
      )}
    </group>
  );
}
