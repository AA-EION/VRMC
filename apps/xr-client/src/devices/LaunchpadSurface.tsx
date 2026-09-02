// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  DoubleSide,
  ExtrudeGeometry,
  type Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  Vector3,
} from 'three';
import type { LaunchpadLayout } from '@vrmc/devices';
import type { LedState } from './LedState.js';
import type { LaunchpadInstance } from './LaunchpadInstance.js';
import { buildTextTexture } from './labels.js';

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

/** How tall a floating label is, in metres, and how far it stands off the top. */
const LABEL_HEIGHT = 0.022;
const LABEL_LIFT = 0.028;

export interface LaunchpadSurfaceProps {
  layout: LaunchpadLayout;
  leds: LedState;
  /**
   * The device itself, so the mesh can follow a pose that moves.
   *
   * The transform is read in the frame loop rather than taken as props,
   * because a held device's pose changes ninety times a second and routing
   * that through React would put a component render on the same frame as note
   * dispatch. It is the same reason the knobs are driven this way.
   */
  device: LaunchpadInstance;
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
  device,
}: LaunchpadSurfaceProps): React.ReactElement {
  const meshRef = useRef<InstancedMesh>(null);
  const groupRef = useRef<Group>(null);
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

    // Follow the pose. Written every frame rather than on change: a held device
    // moves continuously, and comparing first would cost more than the six
    // writes it saves.
    const group = groupRef.current;
    if (group !== null) {
      const { origin, quaternion } = device.transform;
      group.position.set(origin[0], origin[1], origin[2]);
      group.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    }
  });

  /*
   * The DAW's own words, above the device.
   *
   * Rebuilt only when the text changes, which is when somebody switches a view
   * in their DAW — human speed, and nowhere near the frame path.
   */
  const label = useMemo(
    () => buildTextTexture(device.displayText),
    [device.displayText],
  );
  useEffect(() => () => label?.dispose(), [label]);

  const margin = 0.008;
  const bodyW = layout.width + margin * 2;
  const bodyH = layout.height + margin * 2;
  const logo = layout.logoPosition();

  return (
    <group ref={groupRef}>
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

      {label !== null && (
        // Sized from the texture so the glyphs never stretch, and stood off the
        // top edge rather than over the grid: a label across the pads is a
        // label in the way of the thing it is describing.
        <mesh
          position={[layout.width / 2, layout.height + LABEL_LIFT, 0.01]}
          renderOrder={1}
        >
          <planeGeometry
            args={[LABEL_HEIGHT * (label.image.width / label.image.height), LABEL_HEIGHT]}
          />
          <meshBasicMaterial map={label} transparent depthWrite={false} />
        </mesh>
      )}

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
