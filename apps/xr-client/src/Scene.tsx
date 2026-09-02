import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { Camera, Group, Scene as ThreeScene, WebGLRenderer } from 'three';
import { InstrumentSurface } from './devices/InstrumentSurface.js';
import { LaunchpadSurface } from './devices/LaunchpadSurface.js';
import type { LaunchpadInstance } from './devices/LaunchpadInstance.js';
import type { Engine } from './Engine.js';
import { Backdrop } from './xr/Backdrop.js';
import type { XrMode } from './xr/session.js';
import { ConnectPanel } from './ui/ConnectPanel.js';
import type { KeypadController } from './ui/KeypadController.js';

/**
 * Debug handle, published on `window`.
 *
 * Two uses. It is the seam the headless render test reaches through to inspect
 * the live scene graph, and it is how you introspect a running session from the
 * headset — Quest Browser supports remote devtools, and being able to read the
 * engine's state while wearing the device is worth far more than the handful of
 * bytes it costs.
 */
declare global {
  interface Window {
    __vrmc?: {
      engine: Engine;
      scene: ThreeScene;
      renderer: WebGLRenderer;
      camera: Camera;
      /** Enough of three to project a point, for framing checks. */
      THREE: { Vector3: typeof Vector3 };
    };
  }
}

export interface SceneProps {
  engine: Engine;
  /**
   * The emulated devices to draw.
   *
   * Passed in rather than read off the engine so React knows when the list
   * changed; the engine mutates its own array in place, which a component
   * cannot observe.
   */
  devices: readonly LaunchpadInstance[];
  /**
   * The in-session pairing keypad, or null when it should not be shown.
   *
   * Shown only while disconnected inside a session. A panel floating in front
   * of an instrument that is already working would be in the way.
   */
  keypad?: KeypadView | null;
  /**
   * Which room to draw.
   *
   * `immersive` fades an opaque shell and the galaxy in behind everything;
   * `passthrough` fades them out and leaves the buffer transparent, which is
   * all passthrough has ever been. The session is the same one either way.
   */
  mode?: XrMode;
}

/** What the scene needs in order to draw the keypad. */
export interface KeypadView {
  controller: KeypadController;
  code: string;
  message: string;
  busy: boolean;
}

/**
 * The 3D scene, and the frame loop that drives everything real-time.
 *
 * `useFrame` hands us the `XRFrame` for the current XR animation frame as its
 * third argument. That is the only place hand joint poses can be read from —
 * they are valid for that frame and no other.
 */
export function Scene({
  engine,
  devices,
  keypad = null,
  mode = 'passthrough',
}: SceneProps): React.ReactElement {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    window.__vrmc = { engine, scene, renderer: gl, camera, THREE: { Vector3 } };
    return () => {
      delete window.__vrmc;
    };
  }, [engine, scene, gl, camera]);

  useFrame((_state, delta, xrFrame) => {
    engine.update(xrFrame as XRFrame | undefined, gl.xr.getReferenceSpace(), delta);
  });

  return (
    <>
      {/*
        The room, when there is one. Drawn before anything else and behind
        everything — it is the ground the instruments are read against, not a
        layer over them. In passthrough it costs one invisible mesh and three
        skipped vertex passes.
      */}
      <Backdrop immersive={mode === 'immersive'} />

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

      {/* Emulated hardware. Keyed by device id so React rebuilds a surface only
          when the device itself changes, not when the roster reorders. */}
      {devices.map((device) => (
        <LaunchpadSurface
          key={device.deviceId}
          layout={device.layout}
          leds={device.leds}
          position={device.transform.origin}
          quaternion={device.transform.quaternion}
        />
      ))}

      {keypad !== null && (
        <ConnectPanel
          layout={keypad.controller.layout}
          highlighter={keypad.controller.highlighter}
          code={keypad.code}
          message={keypad.message}
          busy={keypad.busy}
        />
      )}

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
