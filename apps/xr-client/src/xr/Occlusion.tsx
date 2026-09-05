import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Mesh } from 'three';

/**
 * Making the real world read correctly against what we draw.
 *
 * There are two separate problems here and only one of them has a good answer.
 *
 * ── HANDS ─────────────────────────────────────────────────────────────────
 * The good answer, and it is the official one. Meta's own Depth API
 * documentation is explicit that the environment depth map has hands *removed*
 * from it and replaced with approximate background depth, because the depth
 * sensor's resolution gives soft, wrong edges around fingers — and that the way
 * to occlude hands properly is to render the tracked hand mesh as an occluder,
 * which is what gives sharp boundaries. Meta also warns that depth-based hand
 * occlusion degrades badly at close range, and this instrument is entirely
 * close range: fingers on a pad forty centimetres out.
 *
 * So the hands are drawn with `colorWrite` off. They write depth and no colour,
 * which means the frame buffer stays transparent where a hand is — so the
 * compositor shows the real hand there, through the cameras, and the pad behind
 * it fails the depth test and is not drawn. The silhouette is exactly the shape
 * of the hand the runtime is tracking, with no shader trickery and nothing
 * faked. See `Hands.tsx`, which draws the same rig either way, because a
 * silhouette that is not exactly the drawn hand's shape is one that shows a
 * seam the moment you switch rooms.
 *
 * Worth being clear about what this changes, because passthrough already looked
 * roughly right: it did not. The instrument chassis are translucent, so a hand
 * behind a Launchpad showed through dimly — a ghost under glass, not a hand
 * behind an object. There was no depth relationship at all.
 *
 * ── THE ROOM ──────────────────────────────────────────────────────────────
 * The honest answer is: available, best-effort, and off by default.
 *
 * WebXR's `depth-sensing` is real on Quest 3 and three has built-in support for
 * it. Both come with caveats that are not ours to fix from here:
 *
 *   · three's occlusion pass blits the depth texture into the depth buffer with
 *     screen UVs, which ignores the difference between the depth camera's field
 *     of view and the display's. mrdoob/three.js#28877 is open against exactly
 *     this, and lists the symptoms: misregistration, flicker, and no feathering
 *     at the edges. The fix belongs upstream, in the pass itself.
 *   · it only engages for `gpu-optimized` usage, which is why session.ts asks
 *     for that first.
 *
 * And one interaction that *is* ours, which is why this is refused outright in
 * the full room rather than merely discouraged: `WebXRManager.updateCamera`
 * replaces `camera.far` with `depthSensing.depthFar` as soon as the depth
 * texture exists. Meta's Depth API reaches about five metres. The galaxy's disc
 * is nineteen metres out and its far field sixty, so switching depth sensing on
 * inside the immersive room would not dim the sky — it would clip it away
 * entirely, which is the same failure the camera's far plane already caused
 * once. There is nothing to occlude against in there anyway.
 */

export interface OcclusionProps {
  /**
   * Whether the player has asked for environment occlusion.
   *
   * Off by default, and honestly labelled in the interface. The hand occluder
   * above is not optional and is not covered by this — it is how passthrough is
   * supposed to look.
   */
  enabled: boolean;
  /**
   * True only in passthrough. Forced rather than advised: see the note about
   * `depthFar` above.
   */
  available: boolean;
  /** Told what actually happened, so the interface can stop promising it. */
  onState?: (state: DepthSensingState) => void;
}

export type DepthSensingState =
  | 'off'
  /** Asked for, but the session did not grant the feature. */
  | 'unsupported'
  /** Granted, and the runtime is handing us depth frames. */
  | 'active'
  /** Granted, but no depth frame has arrived yet. */
  | 'waiting';

export function EnvironmentOcclusion({
  enabled,
  available,
  onState,
}: OcclusionProps): React.ReactElement | null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const [state, setState] = useState<DepthSensingState>('off');
  /** The mesh three hands us, once it has one. Ours to add and remove. */
  const attached = useRef<Mesh | null>(null);

  useEffect(() => {
    onState?.(state);
  }, [onState, state]);

  useEffect(() => {
    // Leaving the room, or switching it off, must take the pass out of the
    // scene — a full-screen depth blit left behind would keep writing depth
    // over everything for the rest of the session.
    if (enabled && available) return;
    const mesh = attached.current;
    if (mesh !== null) {
      mesh.removeFromParent();
      attached.current = null;
    }
    setState('off');
  }, [enabled, available]);

  useFrame(() => {
    if (!enabled || !available) return;

    const xr = gl.xr;
    const session = xr.getSession();
    if (session === null) return;

    // `enabledFeatures` is the only truthful answer to «did we get it». A
    // request lists preferences; the session says what was granted, and asking
    // for a feature is not the same as having it.
    const granted = session.enabledFeatures?.includes('depth-sensing') ?? false;
    if (!granted) {
      setState('unsupported');
      return;
    }

    if (!xr.hasDepthSensing()) {
      // Granted, but no frame yet. Normal for the first moments of a session.
      setState('waiting');
      return;
    }

    const mesh = xr.getDepthSensingMesh();
    if (mesh === null) {
      setState('waiting');
      return;
    }
    if (attached.current !== mesh) {
      attached.current?.removeFromParent();
      // Drawn before everything: it writes gl_FragDepth from the runtime's own
      // depth texture, and what it writes is what the rest of the scene is then
      // tested against.
      mesh.renderOrder = RENDER_ORDER.environment;
      mesh.frustumCulled = false;
      scene.add(mesh);
      attached.current = mesh;
    }
    setState('active');
  });

  return null;
}

/**
 * Where the occluders sit in the draw order.
 *
 * Both are opaque and both write depth, so they are in the opaque list — which
 * three sorts by `renderOrder` first. The environment pass goes first because
 * it establishes the room's depth; the hands go next because a hand in front of
 * a real surface must still hide it; instruments come last, at three's default
 * zero, and are tested against both.
 */
export const RENDER_ORDER = { environment: -40, hands: -30 } as const;
