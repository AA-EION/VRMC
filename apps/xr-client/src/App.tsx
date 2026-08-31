import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import type { WebGLRenderer } from 'three';
import { Engine } from './Engine.js';
import { Scene } from './Scene.js';
import { Overlay } from './ui/Overlay.js';
import type { LinkStatus } from './net/BridgeLink.js';
import { detectSupport, isBlending, startSession, type XrSupport } from './xr/session.js';

/** Remember the bridge address between visits; it rarely changes. */
const URL_STORAGE_KEY = 'vrmc.bridgeUrl';

function defaultBridgeUrl(): string {
  try {
    const saved = localStorage.getItem(URL_STORAGE_KEY);
    if (saved !== null && saved !== '') return saved;
  } catch {
    // Private browsing, or storage disabled. Fall through to the default.
  }
  // Same host as the page is the right guess when the client is served by the
  // bridge itself; the scheme has to match, or the browser blocks the socket.
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname || '127.0.0.1'}:7401`;
}

export function App(): React.ReactElement {
  const [bridgeUrl, setBridgeUrl] = useState(defaultBridgeUrl);
  const engine = useMemo(() => new Engine(bridgeUrl), []);
  const rendererRef = useRef<WebGLRenderer | null>(null);

  const [support, setSupport] = useState<XrSupport | null>(null);
  const [status, setStatus] = useState<LinkStatus>(() => engine.link.status());
  const [sessionActive, setSessionActive] = useState(false);
  const [passthrough, setPassthrough] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void detectSupport().then(setSupport);
  }, []);

  // Status pushes are event-driven, but the round-trip figure updates on every
  // pong. Sampling on a timer keeps that off React's critical path and out of
  // the render loop; twice a second is as fast as the number is readable.
  useEffect(() => {
    const id = setInterval(() => setStatus(engine.link.status()), 500);
    engine.link.onStatus = (next) => setStatus(next);
    return () => {
      clearInterval(id);
      engine.link.onStatus = null;
    };
  }, [engine]);

  useEffect(() => {
    engine.link.connect(bridgeUrl);
    return () => engine.dispose();
    // Connect once on mount; reconnects go through the Connect button.
  }, [engine]);

  const handleConnect = useCallback(() => {
    try {
      localStorage.setItem(URL_STORAGE_KEY, bridgeUrl);
    } catch {
      // Not fatal; the address just will not be remembered.
    }
    setError('');
    engine.link.connect(bridgeUrl);
  }, [bridgeUrl, engine]);

  const handleEnterXR = useCallback(async () => {
    const renderer = rendererRef.current;
    if (renderer === null) {
      setError('The 3D canvas is not ready yet.');
      return;
    }
    try {
      const { session, passthrough: blending } = await startSession();

      renderer.xr.enabled = true;
      // 'local-floor' puts the origin on the floor, so the panel heights in the
      // engine mean what they say. Runtimes without it fall back to 'local',
      // where y is measured from the headset instead.
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);

      setSessionActive(true);
      setPassthrough(blending || isBlending(session));
      setError('');
      engine.onSessionStart(session);

      const onInputSourcesChange = (): void => engine.tracker.syncInputSources(session);
      session.addEventListener('inputsourceschange', onInputSourcesChange);

      session.addEventListener(
        'end',
        () => {
          session.removeEventListener('inputsourceschange', onInputSourcesChange);
          // The session is gone but the notes it started are not: release them
          // before anything else, or the DAW holds them until it is restarted.
          engine.allNotesOff();
          setSessionActive(false);
          setPassthrough(false);
        },
        { once: true },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        `Could not start the XR session: ${message}. Hand tracking must be enabled in the headset's settings.`,
      );
    }
  }, [engine]);

  const handlePanic = useCallback(() => engine.allNotesOff(), [engine]);

  // A headset going to sleep, or the user switching apps, leaves notes ringing
  // on the desktop. Release on the way out.
  useEffect(() => {
    const release = (): void => engine.allNotesOff();
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') release();
    });
    return () => window.removeEventListener('pagehide', release);
  }, [engine]);

  return (
    <>
      <Canvas
        // alpha:true is what lets passthrough show through. With an opaque
        // buffer the compositor has nothing to blend and the room disappears.
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 60, near: 0.01, far: 20, position: [0, 1.5, 0.6] }}
        onCreated={({ gl, scene }) => {
          rendererRef.current = gl;
          gl.setClearAlpha(0);
          // Any background at all would sit in front of the cameras.
          scene.background = null;
        }}
      >
        <Scene engine={engine} />
      </Canvas>

      <Overlay
        support={support}
        status={status}
        sessionActive={sessionActive}
        passthrough={passthrough}
        bridgeUrl={bridgeUrl}
        error={error}
        onBridgeUrlChange={setBridgeUrl}
        onConnect={handleConnect}
        onEnterXR={() => void handleEnterXR()}
        onPanic={handlePanic}
      />
    </>
  );
}
