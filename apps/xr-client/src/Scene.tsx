import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Group } from 'three';
import { InstrumentSurface } from './devices/InstrumentSurface.js';
import type { Engine } from './Engine.js';

export interface SceneProps {
  engine: Engine;
}

/**
 * The 3D scene, and the frame loop that drives everything real-time.
 *
 * `useFrame` hands us the `XRFrame` for the current XR animation frame as its
 * third argument. That is the only place hand joint poses can be read from —
 * they are valid for that frame and no other.
 */
export function Scene({ engine }: SceneProps): React.ReactElement {
  const gl = useThree((state) => state.gl);

  useFrame((_state, delta, xrFrame) => {
    engine.update(xrFrame as XRFrame | undefined, gl.xr.getReferenceSpace(), delta);
  });

  return (
    <>
      {/*
        Lighting is deliberately soft and mostly ambient. In passthrough the
        room's own light is the dominant cue, so a hard key light makes the
        instruments read as pasted on rather than as objects on the desk.
      */}
      <ambientLight intensity={1.1} />
      <directionalLight position={[0.6, 1.8, 0.8]} intensity={1.4} />
      <directionalLight position={[-0.8, 1.2, -0.4]} intensity={0.35} />

      {engine.instruments.map((instrument) => (
        <InstrumentSurface
          key={instrument.id}
          locator={instrument.locator}
          theme={instrument.theme}
          highlighter={instrument.highlighter}
          position={instrument.transform.origin}
          quaternion={instrument.transform.quaternion}
          showLabels={instrument.id === 'pads'}
        />
      ))}

      <Knobs engine={engine} />
    </>
  );
}

/**
 * The pinch-grab knobs.
 *
 * Positions come from the engine rather than being recomputed here, so the knob
 * you see and the knob the grab test looks for cannot drift apart. Rotation is
 * mutated directly in the frame loop: four knobs is few enough that React state
 * would work, and still the wrong shape, since it would put a component render
 * on the same path as note dispatch.
 */
function Knobs({ engine }: { engine: Engine }): React.ReactElement {
  const groupRef = useRef<Group>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (group === null) return;
    for (let i = 0; i < group.children.length; i++) {
      const child = group.children[i];
      if (child === undefined) continue;
      // Sweep 300 degrees, the usual throw of a hardware pot, centred on zero.
      child.rotation.y = (0.5 - engine.knobs.valueOf(i)) * ((300 * Math.PI) / 180);
    }
  });

  return (
    <group ref={groupRef}>
      {engine.knobPositions.map((position, i) => (
        <group key={i} position={position}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.018, 0.02, 0.016, 24]} />
            <meshStandardMaterial color="#39405c" roughness={0.5} metalness={0.3} />
          </mesh>
          {/* Indicator, so the knob's setting is readable at a glance. */}
          <mesh position={[0, 0.013, 0.009]}>
            <boxGeometry args={[0.0025, 0.012, 0.002]} />
            <meshStandardMaterial color="#63e0ff" emissive="#1d6f88" emissiveIntensity={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
