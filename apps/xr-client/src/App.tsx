import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import type { WebGLRenderer } from 'three';
import { Engine } from './Engine.js';
import type { LaunchpadInstance } from './devices/LaunchpadInstance.js';
import { Scene } from './Scene.js';
import { Overlay } from './ui/Overlay.js';
import type { LinkStatus } from './net/BridgeLink.js';
import {
  detectSupport,
  isBlending,
  startSession,
  type XrMode,
  type XrSupport,
} from './xr/session.js';
import { PairingError, resolvePairingCode } from './net/pairing.js';
import { rtcTransport, webSocketTransport } from './net/Transport.js';
import { KeypadController } from './ui/KeypadController.js';
import { preloadHands } from './xr/Hands.js';
import type { DepthSensingState } from './xr/Occlusion.js';

/**
 * Remember the pairing code between visits.
 *
 * This is what makes the setup a one-time step: the code identifies the
 * computer, the computer keeps the same code across restarts, and every later
 * visit reconnects without anyone typing anything.
 */
const CODE_STORAGE_KEY = 'vrmc.pairingCode';

/** Remember a manually entered address, for the advanced path. */
const URL_STORAGE_KEY = 'vrmc.bridgeUrl';

/**
 * Remember which room the player likes.
 *
 * Someone who works in the full room wants the full room the next time too,
 * and the alternative is asking them to make the same choice at the start of
 * every session — which is the kind of thing this project exists not to do.
 */
const MODE_STORAGE_KEY = 'vrmc.xrMode';

/** Remember whether environment occlusion was asked for. */
const DEPTH_STORAGE_KEY = 'vrmc.depthOcclusion';

/** Read a remembered value, tolerating storage being unavailable. */
function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    // Private browsing, or storage disabled.
    return '';
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not fatal; the value just will not survive the visit.
  }
}

/**
 * Desktop preview viewpoint: roughly where a seated player's eyes are,
 * looking down at the panels on the desk.
 */
const PREVIEW_CAMERA: [number, number, number] = [0, 1.32, 0.42];
const PREVIEW_TARGET: [number, number, number] = [0, 0.86, -0.45];

function defaultBridgeUrl(): string {
  const saved = recall(URL_STORAGE_KEY);
  if (saved !== '') return saved;
  // Same host as the page is the right guess when the client is served by the
  // bridge itself; the scheme has to match, or the browser blocks the socket.
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname || '127.0.0.1'}:7401`;
}

export function App(): React.ReactElement {
  const [bridgeUrl, setBridgeUrl] = useState(defaultBridgeUrl);
  const engine = useMemo(() => new Engine(), []);
  const rendererRef = useRef<WebGLRenderer | null>(null);

  const [support, setSupport] = useState<XrSupport | null>(null);
  // The engine mutates its device array in place, which React cannot observe,
  // so it publishes a snapshot whenever the roster changes.
  const [devices, setDevices] = useState<readonly LaunchpadInstance[]>([]);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingNote, setPairingNote] = useState('');
  /** Name of the paired computer, once one is known. */
  const [pairedLabel, setPairedLabel] = useState('');
  /** What the in-session keypad is showing. */
  const [typedCode, setTypedCode] = useState('');
  /** Shows the pairing panel outside a session. See Engine.showKeypad. */
  const [forceKeypad, setForceKeypad] = useState(false);
  const [status, setStatus] = useState<LinkStatus>(() => engine.link.status());
  const [sessionActive, setSessionActive] = useState(false);
  const [passthrough, setPassthrough] = useState(false);
  /*
   * Which room is showing. Not which session — see xr/session.ts and
   * xr/Backdrop.tsx. This flips freely at any point, in or out of a session,
   * and nothing about the link, the roster or a sounding note depends on it.
   */
  const [mode, setMode] = useState<XrMode>(() =>
    recall(MODE_STORAGE_KEY) === 'immersive' ? 'immersive' : 'passthrough',
  );
  /*
   * Environment occlusion, off unless asked for.
   *
   * The hand silhouette is not covered by this and is not optional — it is how
   * passthrough is supposed to look. This is the room's own depth, which is
   * best-effort on every runtime that has it. See xr/Occlusion.tsx.
   */
  const [depthOcclusion, setDepthOcclusion] = useState(
    () => recall(DEPTH_STORAGE_KEY) === 'on',
  );
  const [depthState, setDepthState] = useState<DepthSensingState>('off');
  const [error, setError] = useState('');

  useEffect(() => {
    void detectSupport().then(setSupport);
  }, []);

  useEffect(() => {
    engine.onDevicesChanged = () => setDevices([...engine.launchpads]);
    return () => {
      engine.onDevicesChanged = null;
    };
  }, [engine]);

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

  /*
   * Reconnect on load, without asking.
   *
   * A code we already have is the strongest signal: it names a specific
   * computer that keeps the same code across restarts, so the right thing is
   * to start the handshake immediately and have the instrument playable by the
   * time the headset is on. Failing that, a page served over plain HTTP is
   * almost certainly the bridge's own dashboard or a dev server, where a
   * WebSocket back to the same host is the obvious guess. On the hosted site
   * with no saved code there is nothing to guess — the pairing box is the
   * first thing on the page, and that is the whole first-run flow.
   */
  useEffect(() => {
    const code = recall(CODE_STORAGE_KEY);
    if (code !== '') {
      setPairingNote('Reconnecting to your computer…');
      engine.link.connect(
        rtcTransport(code, { onProgress: setPairingNote }),
        `pairing code ${code}`,
      );
    } else if (location.protocol !== 'https:') {
      engine.link.connect(webSocketTransport(bridgeUrl), bridgeUrl);
    }
    return () => engine.dispose();
    // Connect once on mount; reconnects go through pairing or the address box.
  }, [engine]);

  // Confirm the connection where the user is looking — the pairing card —
  // rather than only in the link statistics further down.
  useEffect(() => {
    if (status.state !== 'open') return;
    setPairingNote(pairedLabel === '' ? 'Connected.' : `Connected to ${pairedLabel}.`);
  }, [status.state, pairedLabel]);

  const handleConnect = useCallback(() => {
    remember(URL_STORAGE_KEY, bridgeUrl);
    // An address entered by hand replaces the paired computer, or the next
    // visit would silently go back to the code instead.
    remember(CODE_STORAGE_KEY, '');
    setPairedLabel('');
    setPairingNote('');
    setError('');
    engine.link.connect(webSocketTransport(bridgeUrl), bridgeUrl);
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

      // Both hand files, now rather than when the room is first entered: a
      // hand that arrives three frames after you look for it is a hand you
      // noticed arriving.
      preloadHands();

      setSessionActive(true);
      setPassthrough(blending || isBlending(session));
      setError('');
      engine.onSessionStart(session);

      const onInputSourcesChange = (): void => {
        engine.tracker.syncInputSources(session);
        engine.skeleton.syncInputSources(session);
      };
      session.addEventListener('inputsourceschange', onInputSourcesChange);

      session.addEventListener(
        'end',
        () => {
          session.removeEventListener('inputsourceschange', onInputSourcesChange);
          // The session is gone but the notes it started are not: release them
          // before anything else, or the DAW holds them until it is restarted.
          engine.allNotesOff();
          engine.drawHands = false;
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

  const handleMode = useCallback((next: XrMode) => {
    setMode(next);
    remember(MODE_STORAGE_KEY, next);
  }, []);

  const handleDepthOcclusion = useCallback((next: boolean) => {
    setDepthOcclusion(next);
    remember(DEPTH_STORAGE_KEY, next ? 'on' : 'off');
  }, []);

  /**
   * Turn a pairing code into a live connection.
   *
   * The code is remembered, so this is a one-time step: every later visit
   * reconnects to the same computer on its own and the code is never needed
   * again. It is checked against the service first so a mistyped code says so
   * immediately, rather than after a handshake quietly times out.
   */
  const handlePair = useCallback(
    async (input: string) => {
      setPairingBusy(true);
      setPairingNote('Looking up the code…');
      let found;
      try {
        found = await resolvePairingCode(input);
      } catch (err) {
        const message =
          err instanceof PairingError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setPairingNote('');
        setError(message);
        return;
      } finally {
        setPairingBusy(false);
      }

      setPairedLabel(found.label);
      remember(CODE_STORAGE_KEY, found.code);
      setError('');
      setPairingNote(`Found ${found.label}. Connecting…`);
      engine.link.connect(
        rtcTransport(found.code, { onProgress: setPairingNote }),
        `${found.label} · ${found.code}`,
      );
    },
    [engine],
  );

  /*
   * The keypad the user types a code on with their hands.
   *
   * Built once and kept, rather than created when it is first needed: the
   * moment it is needed is the moment a link dropped mid-session, and
   * allocating a detector and a highlighter then would spend frame budget
   * exactly when the user is least willing to forgive a hitch.
   *
   * It is wired to `handlePair`, so typing six characters in the headset does
   * precisely what typing them on the page does — one path, not two.
   */
  // handlePair is rebuilt whenever its dependencies change; the keypad is not,
  // so it calls through a ref rather than capturing a stale copy.
  const handlePairRef = useRef(handlePair);
  useEffect(() => {
    handlePairRef.current = handlePair;
  }, [handlePair]);

  const keypad = useMemo(
    () =>
      new KeypadController({
        onCode: setTypedCode,
        onSubmit: (code) => void handlePairRef.current(code),
        // The same click the instruments use. A key that makes no sound feels
        // like one that did not register, and there is nothing else to confirm
        // a press by touch.
        onKey: () => engine.synth.strike(84, 40),
      }),
    [engine],
  );

  useEffect(() => {
    engine.keypad = keypad;
  }, [engine, keypad]);

  /*
   * Show the keypad only when it is the thing standing in the way.
   *
   * In a session, not connected, and not already busy connecting. Outside a
   * session the overlay's own entry box is right there; when connected, a
   * panel floating in front of the instruments would just be in the way.
   */
  const keypadVisible = (sessionActive || forceKeypad) && status.state !== 'open';
  useEffect(() => {
    engine.showKeypad = setForceKeypad;
    return () => {
      engine.showKeypad = null;
    };
  }, [engine]);

  useEffect(() => {
    engine.keypadVisible = keypadVisible;
    keypad.setBusy(pairingBusy);
    // A code left half-typed from a previous attempt should not be waiting
    // there the next time the panel appears.
    if (!keypadVisible) keypad.clear();
  }, [engine, keypad, keypadVisible, pairingBusy]);

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
      {/*
        The canvas is wrapped so it can be taken out of flow. React Three
        Fiber renders its own full-height container div, which would otherwise
        occupy a screen's worth of layout and push the whole panel below the
        fold — leaving a first-time user looking at an empty page.
      */}
      <div className="scene">
      <Canvas
        // alpha:true is what lets passthrough show through. With an opaque
        // buffer the compositor has nothing to blend and the room disappears.
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
        // Only used outside XR — in a session the headset drives the camera.
        // It still has to frame the instruments, or the page looks broken
        // before you put the headset on: aimed straight down -Z from standing
        // height, the panels sit below the frustum and nothing is visible.
        /*
         * far reaches 100 m because the galaxy's far field lives between 26
         * and 60 (see xr/galaxy.ts). At 20 that shell was not dimmed but
         * clipped, in the projection, before any depth test ran. The precision
         * cost is nil at the range that matters: with near at 1 cm the depth
         * buffer still resolves to about a micron half a metre out, and the
         * pads are five millimetres apart.
         */
        camera={{ fov: 60, near: 0.01, far: 100, position: PREVIEW_CAMERA }}
        onCreated={({ gl, scene, camera }) => {
          rendererRef.current = gl;
          gl.setClearAlpha(0);
          // Any background at all would sit in front of the passthrough
          // cameras, turning a mixed-reality app back into a VR one.
          scene.background = null;
          camera.lookAt(...PREVIEW_TARGET);
          camera.updateProjectionMatrix();
        }}
      >
        <Scene
          engine={engine}
          devices={devices}
          mode={mode}
          depthOcclusion={depthOcclusion}
          onDepthState={setDepthState}
          keypad={
            keypadVisible
              ? {
                  controller: keypad,
                  code: typedCode,
                  message: error !== '' ? error : pairingNote,
                  busy: pairingBusy,
                }
              : null
          }
        />
      </Canvas>
      </div>

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
        mode={mode}
        onModeChange={handleMode}
        depthOcclusion={depthOcclusion}
        onDepthOcclusionChange={handleDepthOcclusion}
        depthState={depthState}
        devices={devices}
        onAddDevice={(model) => engine.addDevice(model)}
        onRemoveDevice={(id) => engine.removeDevice(id)}
        onPair={(code) => void handlePair(code)}
        pairingBusy={pairingBusy}
        pairingNote={pairingNote}
      />
    </>
  );
}
