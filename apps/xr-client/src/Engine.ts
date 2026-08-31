import {
  KeyboardLayout,
  LAUNCHKEY_25,
  localToWorld,
  MPC_4X4,
  PadGridLayout,
  surfaceTransform,
  type SurfacePose,
  type SurfaceTransform,
  type ZoneLocator,
} from '@vrmc/layout';
import { FingerFrame, KnobControl, PokeDetector, type ControlSink } from '@vrmc/interaction';
import { DeviceId, EventType, VelocityCurve } from '@vrmc/protocol';
import { ClickSynth } from './audio/ClickSynth.js';
import { BridgeLink } from './net/BridgeLink.js';
import { NoteRouter, type FeedbackSink } from './net/NoteRouter.js';
import {
  KEY_THEME,
  PAD_THEME,
  SurfaceHighlighter,
  type SurfaceTheme,
} from './devices/InstrumentSurface.js';
import { HandTracker } from './xr/handTracking.js';

/** Everything needed to render and drive one instrument. */
export interface Instrument {
  id: 'pads' | 'keys';
  locator: ZoneLocator;
  detector: PokeDetector;
  highlighter: SurfaceHighlighter;
  router: NoteRouter;
  theme: SurfaceTheme;
  pose: SurfacePose;
  transform: SurfaceTransform;
}

/**
 * Default placement, chosen to match how the hardware being emulated actually
 * sits on a desk: keys nearest and nearly flat, the pad grid behind them and
 * angled up toward the player, the way a controller on a low stand would be.
 */
const KEYS_POSE: SurfacePose = { centre: [0, 0.76, -0.36], tiltDeg: 74 };
const PADS_POSE: SurfacePose = { centre: [0, 0.92, -0.58], tiltDeg: 42 };

/** CC numbers the four knobs send, matching a Launchkey's default map. */
const KNOB_CCS = [21, 22, 23, 24] as const;

/**
 * Owns every piece of per-frame state.
 *
 * Deliberately a plain class outside React. The frame loop touches hand poses,
 * detector state, packet buffers and instance colours 90 times a second; routing
 * any of that through component state would re-render the tree on the same path
 * that has to stay allocation-free. React drives the parts that change at human
 * speed — connection status, settings — and nothing else.
 */
export class Engine {
  readonly link: BridgeLink;
  readonly synth = new ClickSynth();
  readonly tracker = new HandTracker();
  readonly fingers = new FingerFrame();
  readonly knobs = new KnobControl();
  readonly instruments: Instrument[];
  /**
   * World positions of the knobs, kept so the renderer draws them exactly where
   * the grab test looks for them. Recomputing this in the view would be one
   * more chance for the two to disagree.
   */
  readonly knobPositions: Array<[number, number, number]> = [];

  /** Knob index -> CC number. */
  private readonly knobSink: ControlSink;

  /** Set from the session; used to release notes on teardown. */
  private running = false;

  constructor(url: string) {
    this.link = new BridgeLink(url);

    this.instruments = [
      this.buildInstrument(
        'keys',
        new KeyboardLayout(LAUNCHKEY_25),
        KEY_THEME,
        KEYS_POSE,
        DeviceId.KEYS,
        0,
        // A keyboard rewards a firmer curve: the extra travel makes soft
        // playing controllable instead of accidental.
        VelocityCurve.NATURAL,
      ),
      this.buildInstrument(
        'pads',
        new PadGridLayout(MPC_4X4),
        PAD_THEME,
        PADS_POSE,
        DeviceId.PADS,
        // Channel 10 (index 9) is the General MIDI drum channel, which is what
        // a drum rack expects to receive on.
        9,
        VelocityCurve.SOFT,
      ),
    ];

    this.knobSink = {
      onValue: (index, value14, flags) => {
        const cc = KNOB_CCS[index] ?? 21;
        this.link.push(EventType.CONTROL_CHANGE_14, 0, cc, 0, value14, DeviceId.KNOBS, flags, 0);
      },
      onGrab: () => {},
      onRelease: () => {},
    };

    this.placeKnobs();
  }

  /** Instruments, in render order. */
  get keys(): Instrument {
    return this.instruments[0]!;
  }

  get pads(): Instrument {
    return this.instruments[1]!;
  }

  /**
   * Advance one frame.
   *
   * @param xrFrame  the frame from the XR animation loop, if in a session
   * @param space    the reference space poses should be expressed in
   * @param dt       seconds since the previous frame
   */
  update(xrFrame: XRFrame | undefined, space: XRReferenceSpace | null, dt: number): void {
    // Open the batch first so every event this frame produces rides in one
    // packet, then close it once — regardless of which path produced events.
    this.link.beginFrame();

    if (xrFrame !== undefined && space !== null) {
      this.fingers.beginFrame(performance.now(), dt);
      this.tracker.update(xrFrame, space, this.fingers);
      for (const instrument of this.instruments) {
        instrument.detector.update(this.fingers, instrument.router);
      }
      this.knobs.update(this.fingers, this.knobSink);
    }

    this.link.endFrame();

    for (const instrument of this.instruments) instrument.highlighter.update(dt);
  }

  /** Called when the session starts. */
  onSessionStart(session: XRSession): void {
    this.running = true;
    this.tracker.syncInputSources(session);
    this.synth.start();
    this.synth.resume();
  }

  /**
   * Release everything and tell the bridge to silence itself.
   *
   * Called when the session ends or the page unloads. The local detectors are
   * released first so their state matches, then a PANIC covers anything the
   * bridge believes is still sounding.
   */
  allNotesOff(): void {
    this.link.beginFrame();
    for (const instrument of this.instruments) {
      instrument.detector.releaseAll(instrument.router);
    }
    this.knobs.releaseAll(this.knobSink);
    this.link.endFrame();
    this.link.sendPanic();
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  dispose(): void {
    this.allNotesOff();
    this.link.disconnect();
    this.synth.close();
  }

  private buildInstrument(
    id: Instrument['id'],
    locator: ZoneLocator,
    theme: SurfaceTheme,
    pose: SurfacePose,
    deviceId: DeviceId,
    channel: number,
    velocityGamma: number,
  ): Instrument {
    const highlighter = new SurfaceHighlighter(locator, theme);
    const feedback: FeedbackSink = {
      onNoteOn: (zoneIndex, note, velocity) => {
        highlighter.strike(zoneIndex, velocity);
        this.synth.strike(note, velocity);
      },
      onNoteOff: (zoneIndex) => highlighter.release(zoneIndex),
    };

    const detector = new PokeDetector(locator, { velocityGamma });
    const transform = surfaceTransform(locator, pose);
    const { origin, quaternion } = transform;
    // The mesh is drawn at this transform and the detector inverts it, so both
    // are fed from the same source rather than each deriving its own.
    detector.setPose(
      origin[0],
      origin[1],
      origin[2],
      quaternion[0],
      quaternion[1],
      quaternion[2],
      quaternion[3],
    );

    return {
      id,
      locator,
      detector,
      highlighter,
      router: new NoteRouter(this.link, deviceId, channel, feedback),
      theme,
      pose,
      transform,
    };
  }

  /** Put a row of knobs above the pad grid, in world space. */
  private placeKnobs(): void {
    const pads = this.instruments[1];
    if (pads === undefined) return;
    const spacing = 0.075;
    const count = KNOB_CCS.length;
    for (let i = 0; i < count; i++) {
      const localX = pads.locator.width / 2 + (i - (count - 1) / 2) * spacing;
      const localY = pads.locator.height + 0.06;
      const world = localToWorld(pads.transform, localX, localY, 0.02);
      this.knobs.addKnob(world[0], world[1], world[2], 0.5);
      this.knobPositions.push(world);
    }
  }
}
