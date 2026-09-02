import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three';
import { INK, THEME_TRANSITION } from '../brand/tokens.js';
import { currentTheme, watchTheme } from '../brand/theme.js';

/**
 * Focus mode: quieting the room without hiding the desk.
 *
 * WHAT THIS IS NOT
 * It is not a passthrough dimmer, because there is no such thing to reach.
 * WebXR gives no control over the compositor's exposure: passthrough is what
 * shows through wherever our buffer is transparent, and the only lever we have
 * is how transparent we leave it. So «dim the room» has exactly one honest
 * implementation — draw something dark over the parts of the view you want
 * quieter, and leave a hole where you do not.
 *
 * Which turns out to be the right shape anyway. What somebody actually wants
 * here is not a darker room; it is the instrument to stop competing with the
 * kitchen behind it, while the desk, the keyboard and the mouse stay perfectly
 * visible. That is an annulus, not a filter: clear in the middle, dense at the
 * edges, and the two joined by a long enough ramp that no edge is visible.
 *
 * It rides the same shell geometry as the room's backdrop and is drawn just
 * after it, so in the full room it dims the galaxy exactly as it dims a real
 * kitchen — the mechanism does not care which it is.
 */

/** How wide the clear centre is, as a fraction of the view. */
const CLEAR = 0.34;

/** …and where the dimming reaches full strength. The gap between is the ramp. */
const EDGE = 0.92;

const VERT = /* glsl */ `
varying vec3 vDirection;
void main() {
  // The direction from the eye to this fragment, in view space. Using the
  // direction rather than screen coordinates is what keeps the hole centred on
  // where somebody is *looking* in each eye, rather than on the middle of a
  // framebuffer that is two eyes wide.
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vDirection = normalize(view.xyz);
  gl_Position = projectionMatrix * view;
}
`;

const FRAG = /* glsl */ `
precision mediump float;
uniform vec3  uColour;
uniform float uStrength;
uniform float uClear;
uniform float uEdge;
varying vec3 vDirection;

void main() {
  // Angle from straight ahead, as a 0..1 figure. -Z is forward in view space.
  float forward = clamp(-vDirection.z, 0.0, 1.0);
  float offAxis = 1.0 - forward;
  float t = smoothstep(uClear, uEdge, offAxis);
  float a = t * uStrength;
  if (a <= 0.002) discard;
  // Premultiplied, like everything else that has to survive the compositor.
  gl_FragColor = vec4(uColour * a, a);
}
`;

export interface FocusVignetteProps {
  /** Whether focus mode is on. */
  enabled: boolean;
  /**
   * How dark the edges go, 0..1.
   *
   * Well short of 1 by default. A vignette that reaches full black is a
   * blindfold with a hole in it, and the point is to quiet the room rather than
   * to remove it — you still want to see somebody walk in.
   */
  strength?: number;
}

/** The name the scene surveys it by. */
export const VIGNETTE_NAME = 'focus-vignette';

export function FocusVignette({
  enabled,
  strength = 0.72,
}: FocusVignetteProps): React.ReactElement {
  const mesh = useRef<Mesh>(null);
  const ink = useRef(new Color(currentTheme() === 'dark' ? INK.sumi : INK.bone));
  const from = useRef(new Color().copy(ink.current));
  const to = useRef(new Color().copy(ink.current));
  const crossedAt = useRef(Number.POSITIVE_INFINITY);
  /** Eased so switching focus mode is not a flinch. */
  const level = useRef(0);

  useEffect(
    () =>
      watchTheme((next) => {
        from.current.copy(ink.current);
        // Dimming with the room's own surface rather than with black: on the
        // light theme a black vignette is a hard edge against Polymer Bone, and
        // the whole point is that no edge is visible.
        to.current.set(next === 'dark' ? INK.sumi : INK.bone);
        crossedAt.current = performance.now();
      }),
    [],
  );

  const geometry = useMemo(() => new SphereGeometry(6, 24, 16), []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uColour: { value: new Color().copy(ink.current) },
          uStrength: { value: 0 },
          uClear: { value: CLEAR },
          uEdge: { value: EDGE },
        },
        transparent: true,
        // Over everything, and occluding nothing. It is a filter on the view
        // rather than an object in the room, so it neither writes nor tests
        // depth — an instrument behind it is dimmed, which is the point.
        depthTest: false,
        depthWrite: false,
        side: BackSide,
        premultipliedAlpha: true,
      }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(({ camera }, delta) => {
    const node = mesh.current;
    if (node === null) return;

    const target = enabled ? strength : 0;
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 6);
    level.current += (target - level.current) * k;
    if (Math.abs(target - level.current) < 0.002) level.current = target;

    node.visible = level.current > 0.002;
    if (!node.visible) return;

    // Centred on the head and turned with it: the clear middle follows where
    // the player is looking, which is where the instrument is.
    camera.getWorldPosition(node.position);
    node.quaternion.copy(camera.quaternion);

    if (crossedAt.current !== Number.POSITIVE_INFINITY) {
      const p = Math.min((performance.now() - crossedAt.current) / THEME_TRANSITION.ms, 1);
      ink.current.copy(from.current).lerp(to.current, p);
      if (p === 1) crossedAt.current = Number.POSITIVE_INFINITY;
    }
    (material.uniforms.uColour!.value as Color).copy(ink.current);
    material.uniforms.uStrength!.value = level.current;
  });

  return (
    <mesh
      ref={mesh}
      name={VIGNETTE_NAME}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={RENDER_ORDER}
    />
  );
}

/**
 * After everything else.
 *
 * It is the last thing applied to the view, so it must be the last thing drawn
 * — including after the galaxy, which it dims exactly as it dims a real room.
 */
const RENDER_ORDER = 1000;
