import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  NormalBlending,
  Points,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import {
  BUDGET,
  CLOUD_STYLE,
  GALAXY_FRAG,
  GALAXY_INK,
  GALAXY_VERT,
  MAX_DENSITY,
  PLACEMENT,
  buildDisc,
  buildField,
  buildMotes,
  worldPointSize,
  type Cloud,
} from './galaxy.js';
import { currentTheme, watchTheme, type Theme } from '../brand/theme.js';
import { INK, THEME_TRANSITION } from '../brand/tokens.js';

/**
 * Full VR, inside the passthrough session.
 *
 * THIS IS NOT A SECOND SESSION, AND THAT IS THE WHOLE DESIGN
 * `session.ts` already says how passthrough works: the compositor shows the
 * cameras wherever our frame buffer is transparent, and «a skybox, a clear
 * colour with alpha 1, or a fullscreen quad will each silently turn the app
 * back into VR». That sentence was written as a warning. It is also the
 * feature — going fully immersive is drawing something opaque, and drawing
 * something opaque is a render decision, not a session one.
 *
 * So there is no second `requestSession`, no teardown, and nothing for the
 * MIDI link to notice: the transport, the device roster, the held notes and
 * the hand bindings are all exactly where they were. Ending a session to start
 * another would have dropped every one of them, and the reconnect would have
 * happened while the player was mid-phrase.
 *
 * It also means the switch can be a *crossfade* rather than a cut. The shell
 * below is a sphere around the player in the theme's own surface colour, and
 * its opacity is what the mode toggle actually animates: at 0 the buffer is
 * transparent and the room is the real one; at 1 it is opaque and the room is
 * the galaxy. Everything in between is a dissolve between the two, which is
 * the one thing a session swap could never have given.
 *
 * WHY THE FAR PLANE MOVES
 * The far field sits between 26 and 60 metres out. The camera's far plane was
 * 20, which does not dim it — it clips it away entirely, in the projection,
 * before any depth test runs. So the camera reaches 100 m now. That costs
 * essentially nothing: at instrument range the depth buffer still resolves to
 * about a micron, and the pads are five millimetres apart.
 */

/** How long the crossfade takes — the identity's own theme duration. */
const FADE_MS = THEME_TRANSITION.ms;

/**
 * The crossfade, as a function of the clock rather than an integrator.
 *
 * This started out as the obvious per-frame ease — `f += (target - f) * k` —
 * and that has a defect which is invisible until something reads it twice in
 * one frame. R3F registers `useFrame` callbacks in effect order, and React
 * runs child effects *before* parent ones, so the clouds' callback is called
 * before the backdrop's that owns the value. Integrating meant they rendered a
 * frame behind the shell: at the end of a fade the room reported itself fully
 * transparent while three clouds were still being drawn.
 *
 * Deriving the value from a start time instead makes the question disappear.
 * Every reader in a frame computes the same number from the same clock, in any
 * order, and the endpoint is exact rather than asymptotic — which matters,
 * because a room that is 0.999 opaque is one the compositor is still blending
 * a thousandth of the real world into, and that reads as a dirty lens.
 */
class Crossfade {
  private from = 0;
  private to = 0;
  private startedAt = Number.NEGATIVE_INFINITY;

  /** Aim at 0 or 1. Re-aiming mid-fade starts from wherever it currently is. */
  set(target: number, now: number): void {
    if (target === this.to) return;
    this.from = this.value(now);
    this.to = target;
    this.startedAt = now;
  }

  value(now: number): number {
    const span = now - this.startedAt;
    if (!(span < FADE_MS)) return this.to; // also catches the -Infinity start
    const t = span <= 0 ? 0 : span / FADE_MS;
    // Smoothstep: eased at both ends and near-linear through the middle, which
    // is the shape the identity's own theme curve has.
    return this.from + (this.to - this.from) * t * t * (3 - 2 * t);
  }
}

/** Radius of the shell. Inside the far plane, outside everything else. */
const SHELL_RADIUS = 80;

/** The shell's node name, so the scene can be surveyed by intent. */
export const SHELL_NAME = 'backdrop-shell';

/**
 * The shell's own shader.
 *
 * A `MeshBasicMaterial` would do the job and would also be lit by nothing,
 * tone-mapped by three, and colour-managed on the way — three transformations
 * of a value whose entire point is that it is exactly the surface the flat page
 * paints. This writes the colour and the alpha and stops.
 */
const SHELL_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHELL_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColour;
uniform float uAlpha;
void main() {
  // Premultiplied, like the clouds: the compositor blends our alpha against
  // the cameras, so the colour has to arrive already scaled by it or the room
  // reads as a wash over the real one rather than as a room.
  gl_FragColor = vec4(uColour * uAlpha, uAlpha);
}
`;

export interface BackdropProps {
  /**
   * Whether the immersive room should be showing.
   *
   * A plain boolean, changed at human speed. The animation it drives lives in
   * the frame loop, so flipping this re-renders nothing per frame.
   */
  immersive: boolean;
  /**
   * Told how opaque the room currently is, once per crossfade rather than per
   * frame — the passthrough-only parts of the scene use it to get out of the
   * way, and they need to know when it has finished, not how it is going.
   */
  onOpacityChange?: (opacity: number) => void;
}

export function Backdrop({ immersive, onOpacityChange }: BackdropProps): React.ReactElement {
  const gl = useThree((state) => state.gl);

  /* The three clouds, built once. ~20 000 particles of Float32Array is about
     640 kB and a couple of milliseconds; doing it on the mode toggle would
     spend both at the exact moment the player asked to see something. */
  const disc = useMemo(() => buildDisc(BUDGET.disc), []);
  const field = useMemo(() => buildField(BUDGET.field), []);
  const motes = useMemo(() => buildMotes(BUDGET.motes), []);

  /** 0..1, derived from the clock so every reader in a frame agrees. */
  const crossfade = useMemo(() => new Crossfade(), []);
  /** Last value handed upward, so the callback fires on change and not per frame. */
  const reported = useRef(-1);

  /**
   * The ink, crossing a theme change.
   *
   * It has to cross at the same time as the surface behind it — but not on the
   * same curve. Both endpoints are opposites, so a linear ink over a linear
   * ground would meet in the middle at the same grey and the galaxy would
   * vanish for a frame at the halfway mark. `sqrt` runs the ink ahead of the
   * surface, so there is contrast between them at every instant of the
   * crossing and nothing ever blinks out.
   */
  const ink = useRef(new Vector3(...GALAXY_INK[currentTheme()]));
  const inkFrom = useRef(new Vector3().copy(ink.current));
  const inkTo = useRef(new Vector3().copy(ink.current));
  const shell = useRef(new Color(surfaceOf(currentTheme())));
  const shellFrom = useRef(new Color().copy(shell.current));
  const shellTo = useRef(new Color().copy(shell.current));
  const crossedAt = useRef(Number.POSITIVE_INFINITY);

  useEffect(
    () =>
      watchTheme((next) => {
        inkFrom.current.copy(ink.current);
        inkTo.current.set(...GALAXY_INK[next]);
        shellFrom.current.copy(shell.current);
        shellTo.current.set(surfaceOf(next));
        crossedAt.current = performance.now();
      }),
    [],
  );

  const shellMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SHELL_VERT,
        fragmentShader: SHELL_FRAG,
        uniforms: {
          uColour: { value: new Color().copy(shell.current) },
          uAlpha: { value: 0 },
        },
        transparent: true,
        /*
         * Tests depth, and does not write it.
         *
         * «Painted first, so it can never occlude anything» was the obvious
         * reading and it is wrong, because three does not draw in renderOrder:
         * it draws every opaque object first and only then the transparent
         * ones, sorted among themselves. A transparent shell with the test off
         * is therefore drawn *after* the instruments and straight over them —
         * which showed up as a room in which the pad labels floated correctly
         * and the pads underneath them were solid black, because the labels are
         * transparent and sort after the shell while the pad bodies are opaque
         * and were already buried.
         *
         * Testing fixes it exactly: the shell sits 80 m out, so a fragment with
         * an instrument in front of it fails against the depth that instrument
         * already wrote, and everywhere else the buffer is still at the far
         * plane and the room comes through. It writes nothing itself, so it
         * never occludes the clouds drawn over it.
         */
        depthTest: true,
        depthWrite: false,
        side: BackSide,
        premultipliedAlpha: true,
        blending: NormalBlending,
      }),
    [],
  );

  const shellGeometry = useMemo(() => new SphereGeometry(SHELL_RADIUS, 16, 12), []);
  const shellMesh = useRef<Mesh>(null);

  useEffect(
    () => () => {
      shellGeometry.dispose();
      shellMaterial.dispose();
    },
    [shellGeometry, shellMaterial],
  );

  // Aimed once per toggle rather than re-asserted every frame, so a fade that
  // is already running is never restarted by its own target.
  useEffect(() => {
    crossfade.set(immersive ? 1 : 0, performance.now());
  }, [crossfade, immersive]);

  useFrame(({ camera }) => {
    const now = performance.now();

    // --- the theme crossing ---
    if (crossedAt.current !== Number.POSITIVE_INFINITY) {
      const p = Math.min((now - crossedAt.current) / THEME_TRANSITION.ms, 1);
      ink.current.copy(inkFrom.current).lerp(inkTo.current, Math.sqrt(p));
      shell.current.copy(shellFrom.current).lerp(shellTo.current, p);
      if (p === 1) crossedAt.current = Number.POSITIVE_INFINITY;
    }

    // --- the shell ---
    const mesh = shellMesh.current;
    const alpha = crossfade.value(now);
    if (mesh !== null) {
      mesh.visible = alpha > 0.001;
      // Centred on the head, so the player can never walk out of the room.
      camera.getWorldPosition(mesh.position);
      shellMaterial.uniforms.uAlpha!.value = alpha;
      (shellMaterial.uniforms.uColour!.value as Color).copy(shell.current);
    }

    if (reported.current !== alpha) {
      reported.current = alpha;
      onOpacityChange?.(alpha);
    }
  });

  return (
    <group>
      <mesh
        ref={shellMesh}
        // Named so the scene can be surveyed by intent. The render smoke test
        // counts the instruments' own plain meshes, and a room object that has
        // to be recognised by its material side is a check that breaks the
        // first time the material changes.
        name={SHELL_NAME}
        geometry={shellGeometry}
        material={shellMaterial}
        frustumCulled={false}
        renderOrder={RENDER_ORDER.shell}
      />
      {/*
        The galaxy, placed rather than centred on the player. See PLACEMENT: it
        goes below the standing surface, because standing *in* the plane of a
        galaxy and standing above one are different pictures and only the
        second one is big.
      */}
      <group position={[0, PLACEMENT.y, 0]} rotation={[PLACEMENT.tilt, 0, 0]}>
        {/* Only the disc is spread. The far field at 2.1 would reach 126 m,
            and the camera's far plane is 100 — which clips rather than dims. */}
        <group scale={PLACEMENT.disc.spread}>
          <CloudPoints
            cloud={disc}
            style={CLOUD_STYLE.disc}
            sizeScale={PLACEMENT.disc.sizeScale}
            ink={ink}
            fade={crossfade}
            gl={gl}
            renderOrder={RENDER_ORDER.cloud}
          />
        </group>
        <CloudPoints
          cloud={field}
          style={CLOUD_STYLE.field}
          ink={ink}
          fade={crossfade}
          gl={gl}
          renderOrder={RENDER_ORDER.cloud}
        />
      </group>
      <HeadAnchored>
        <CloudPoints
          cloud={motes}
          style={CLOUD_STYLE.motes}
          ink={ink}
          fade={crossfade}
          gl={gl}
          renderOrder={RENDER_ORDER.cloud}
        />
      </HeadAnchored>
    </group>
  );
}

/**
 * Draw order, stated rather than sorted.
 *
 * Transparency has no correct automatic order here — the clouds carry a huge
 * bounding sphere precisely so they are never frustum-culled, which also makes
 * their sort key meaningless. The shell is the ground, the clouds are drawn
 * over it, and the instruments (which write depth, at three's default order 0)
 * come last and are read against both.
 */
const RENDER_ORDER = { shell: -20, cloud: -10 } as const;

/** The surface each theme paints, from the identity's own two inks. */
function surfaceOf(theme: Theme): string {
  return theme === 'dark' ? INK.sumi : INK.bone;
}

/** The room's own air travels with the player rather than with the galaxy. */
function HeadAnchored({ children }: { children: React.ReactNode }): React.ReactElement {
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = group.current;
    if (g !== null) camera.getWorldPosition(g.position);
  });
  return <group ref={group}>{children}</group>;
}

/** One cloud: a BufferGeometry, a ShaderMaterial, and no per-frame allocation. */
function CloudPoints({
  cloud,
  style,
  sizeScale = 1,
  ink,
  fade,
  gl,
  renderOrder,
}: {
  cloud: Cloud;
  style: { sizeFactor: number; spin: number; twinkle: number };
  /**
   * Point size against the studio's calibration.
   *
   * A point's apparent size falls with distance while the *number* of points
   * does not, so a cloud pushed further out arrives correct in size and wrong
   * in density — which reads as speckle rather than as ink. This restores the
   * grain without touching the count, and it is one number stated where the
   * placement is.
   */
  sizeScale?: number;
  ink: { readonly current: Vector3 };
  fade: Crossfade;
  gl: { getDrawingBufferSize: (v: Vector2) => Vector2 };
  renderOrder: number;
}): React.ReactElement {
  const points = useRef<Points>(null);
  /** Scratch for the buffer size. Allocating a Vector2 a frame would be silly. */
  const buffer = useMemo(() => new Vector2(), []);

  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(cloud.position, 3));
    g.setAttribute('aDensity', new BufferAttribute(cloud.density, 1));
    g.setAttribute('aScale', new BufferAttribute(cloud.scale, 1));
    g.setAttribute('aSeed', new BufferAttribute(cloud.seed, 1));
    // The shader moves points far from their authored positions; skip the
    // frustum test rather than maintain a bounding sphere for it.
    g.boundingSphere = new Sphere(new Vector3(), 1e4);
    return g;
  }, [cloud]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: GALAXY_VERT,
        fragmentShader: GALAXY_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: 1 },
          uSpin: { value: style.spin },
          uTwinkle: { value: style.twinkle },
          uInk: { value: new Vector3().copy(ink.current) },
          uMax: { value: MAX_DENSITY },
          uFade: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        // Tested, so an instrument in front of the galaxy hides it rather than
        // having dust read through a pad.
        depthTest: true,
        blending: NormalBlending,
        premultipliedAlpha: true,
      }),
    [style.spin, style.twinkle, ink],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const worldSize = useMemo(
    () => worldPointSize(style.sizeFactor, sizeScale),
    [style.sizeFactor, sizeScale],
  );

  useFrame(({ clock }) => {
    const u = material.uniforms;
    const alpha = fade.value(performance.now());
    const node = points.current;
    // Nothing to draw, and nothing to compute for it. A cloud at zero opacity
    // still costs a full vertex pass over 18 000 points if it is left visible.
    if (node !== null) node.visible = alpha > 0.001;
    if (alpha <= 0.001) return;

    u.uTime!.value = clock.elapsedTime;
    u.uFade!.value = alpha;
    (u.uInk!.value as Vector3).copy(ink.current);
    // gl_PointSize is in device pixels, so it tracks the buffer actually being
    // drawn into — which three swaps for the XR layer's on session start, at a
    // different size and a pixel ratio of 1.
    u.uSize!.value = gl.getDrawingBufferSize(buffer).y * 0.5 * worldSize;
  });

  return (
    <points
      ref={points}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={renderOrder}
    />
  );
}
