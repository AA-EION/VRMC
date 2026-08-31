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
  optionalFeatures: ['local-floor', 'bounded-floor', 'anchors', 'plane-detection'],
};

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
