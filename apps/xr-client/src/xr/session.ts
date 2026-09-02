/**
 * WebXR session setup for Quest 3 passthrough.
 *
 * Two things make this a *mixed reality* app rather than a VR one:
 *
 *  1. The session mode is `immersive-ar`. On Quest 3 that hands back a session
 *     whose `environmentBlendMode` is `alpha-blend` — the compositor shows the
 *     full-colour passthrough cameras behind whatever we draw.
 *
 *  2. Nothing opaque is drawn behind the instruments. Passthrough is not a
 *     layer we render; it is what shows through wherever our frame buffer is
 *     transparent. A skybox, a clear colour with alpha 1, or a fullscreen quad
 *     will each silently turn the app back into VR. That is why the renderer is
 *     configured with `alpha: true` and a clear alpha of 0.
 *
 * Point 2 is also how full VR works, and it is worth being explicit that this
 * is deliberate rather than a happy accident. Going fully immersive does not
 * request a different session: it draws the opaque shell that point 2 warns
 * about, and fades it in. See `Backdrop.tsx`. A session swap would have torn
 * down the reference space, the input sources and — because the page's connect
 * effect is keyed to the engine — nothing about the MIDI link at all, but it
 * would still have taken the player out of the headset's rendering for as long
 * as the runtime took to hand back a second session, mid-phrase.
 */

export interface XrSupport {
  /** `navigator.xr` exists at all. */
  hasWebXR: boolean;
  /** The device can run an immersive-ar (passthrough) session. */
  hasPassthrough: boolean;
  /** Immersive VR, as a fallback for headsets without passthrough. */
  hasVR: boolean;
  /** Why XR is unavailable, when it is. */
  reason: string;
}

/**
 * Features we ask for.
 *
 * `hand-tracking` is required: the whole instrument is finger-poke driven, and
 * a session without it would launch into something unplayable. Better to fail
 * the request and say so than to start and disappoint.
 *
 * `local-floor` is optional because we do not depend on knowing floor height —
 * the panels are placed relative to the viewer. Asking for it as *required*
 * would fail the session on runtimes that cannot establish a floor, for a
 * feature we only use as a nicety.
 */
const SESSION_INIT: XRSessionInit = {
  requiredFeatures: ['hand-tracking'],
  optionalFeatures: [
    'local-floor',
    'bounded-floor',
    'anchors',
    'plane-detection',
    // Dropping a device onto the real desk needs a ray cast against the room,
    // and a feature that is not asked for here cannot be used later however
    // well the runtime supports it — `requestHitTestSource` on a session
    // without it simply rejects. Quest's browser has backed hit testing with
    // the Depth API since Horizon 40.4, so it resolves without waiting for a
    // scene mesh to exist.
    'hit-test',
    // Environment occlusion. Optional in the strongest sense: it is best-effort
    // even where it is supported (see `Occlusion.tsx`), and the app is
    // completely usable without it.
    'depth-sensing',
  ],
  /*
   * Only read when 'depth-sensing' is granted, and both fields are required by
   * the spec whenever it is asked for — a request that omits them is rejected
   * outright, which would take the whole session down with it rather than just
   * the feature.
   *
   * GPU first because that is the only mode three can consume: WebXRManager
   * initialises its depth-sensing module solely when `session.depthUsage` is
   * 'gpu-optimized'. 'luminance-alpha' first because every user agent that
   * supports the API at all must support it, so the preference list can never
   * come back empty.
   */
  depthSensing: {
    usagePreference: ['gpu-optimized', 'cpu-optimized'],
    dataFormatPreference: ['luminance-alpha', 'float32'],
  },
};

/**
 * Which room the player is in.
 *
 * Not which session: there is one session and it is always `immersive-ar` where
 * the device can give us one. This is a rendering state, switchable at any
 * moment without the link, the roster or a held note noticing.
 */
export type XrMode = 'passthrough' | 'immersive';

export async function detectSupport(): Promise<XrSupport> {
  const xr = navigator.xr;
  if (!xr) {
    return {
      hasWebXR: false,
      hasPassthrough: false,
      hasVR: false,
      reason:
        'This browser has no WebXR support. Open the page in Meta Quest Browser on the headset.',
    };
  }

  const [hasPassthrough, hasVR] = await Promise.all([
    xr.isSessionSupported('immersive-ar').catch(() => false),
    xr.isSessionSupported('immersive-vr').catch(() => false),
  ]);

  return {
    hasWebXR: true,
    hasPassthrough,
    hasVR,
    reason: hasPassthrough
      ? ''
      : hasVR
        ? 'This headset supports VR but not passthrough. The instruments will appear on a black background.'
        : 'No immersive session is available on this device.',
  };
}

export interface StartedSession {
  session: XRSession;
  /** True when the compositor is actually blending with the real world. */
  passthrough: boolean;
}

/**
 * Request an immersive session, preferring passthrough.
 *
 * Must be called from a user gesture; the browser rejects the request
 * otherwise, and the rejection reads as a permissions error rather than as the
 * gesture requirement it actually is.
 */
export async function startSession(): Promise<StartedSession> {
  const xr = navigator.xr;
  if (!xr) throw new Error('WebXR is not available in this browser.');

  try {
    const session = await xr.requestSession('immersive-ar', SESSION_INIT);
    return { session, passthrough: isBlending(session) };
  } catch (arError) {
    // Fall back to VR so a Quest 2 or a desktop runtime can still play, just
    // without the room behind it.
    try {
      const session = await xr.requestSession('immersive-vr', SESSION_INIT);
      return { session, passthrough: false };
    } catch {
      throw arError instanceof Error ? arError : new Error(String(arError));
    }
  }
}

/** Whether the compositor is blending our output with the cameras. */
export function isBlending(session: XRSession): boolean {
  const mode = session.environmentBlendMode;
  return mode === 'alpha-blend' || mode === 'additive';
}
