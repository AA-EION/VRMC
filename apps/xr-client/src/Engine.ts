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
import {
  FingerFrame,
  Grabbable,
  KnobControl,
  PokeDetector,
  type ControlSink,
  type GrabSink,
} from '@vrmc/interaction';
import { DeviceId, EventType, PlacementFlags, VelocityCurve } from '@vrmc/protocol';
import { DeviceModel, type DeviceSpec } from '@vrmc/devices';
import {
  FIRST_DYNAMIC_DEVICE_ID,
  MAX_DEVICE_ID,
  normaliseLayoutName,
  type DeviceStateEntry,
  type Layout,
  type LayoutState,
} from '@vrmc/protocol';
import { ClickSynth } from './audio/ClickSynth.js';
import { createLaunchpad, type LaunchpadInstance } from './devices/LaunchpadInstance.js';
import { matchLayout } from './devices/matchLayout.js';
import { BridgeLink } from './net/BridgeLink.js';
import { NoteRouter, type FeedbackSink } from './net/NoteRouter.js';
import {
  KEY_THEME,
  PAD_THEME,
  SurfaceHighlighter,
  type SurfaceTheme,
} from './devices/InstrumentSurface.js';
import { HandTracker } from './xr/handTracking.js';
import { HandSkeleton } from './xr/HandSkeleton.js';
import { KeypadController } from './ui/KeypadController.js';

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
  /**
   * The full twenty-five-joint skeleton, for drawing hands.
   *
   * Separate from `tracker`, and only advanced while something is actually
   * drawing them — see `drawHands`. The tip path above runs every frame because
   * notes depend on it; this one is a rendering cost and is not paid by a
   * player who never leaves passthrough.
   */
  readonly skeleton = new HandSkeleton();

  /**
   * Whether anything is using the hand mesh this frame.
   *
   * True for the whole of a session, and that is a change from what it first
   * was. The mesh started as the full room's feature — passthrough already has
   * your own hands, better than anything we could draw — so the skeleton was
   * only filled there. Then the passthrough silhouette turned out to need the
   * *same* rig, drawn as depth and no colour, which is the official way to make
   * a hand read against the cameras. So both rooms need it, and what is left
   * here is the switch that keeps twenty-five joints per hand off the frame
   * outside a session, where there are no hands to read anyway.
   */
  drawHands = false;
  readonly fingers = new FingerFrame();
  readonly knobs = new KnobControl();
  /**
   * Picking devices up and putting them down.
   *
   * Only emulated hardware is registered. The pad grid, the keyboard and the
   * knobs are one piece of built-in furniture — they are what the app *is* —
   * and a keyboard that can be dragged out of reach is one you then have to go
   * and find.
   */
  readonly grabs = new Grabbable();
  readonly instruments: Instrument[];
  /**
   * World positions of the knobs, kept so the renderer draws them exactly where
   * the grab test looks for them. Recomputing this in the view would be one
   * more chance for the two to disagree.
   */
  readonly knobPositions: Array<[number, number, number]> = [];

  /** Knob index -> CC number. */
  private readonly knobSink: ControlSink;

  /** Emulated hardware, spawned and removed at runtime from the headset. */
  readonly launchpads: LaunchpadInstance[] = [];

  /** The arrangements the bridge is storing, and which one is in use. */
  layouts: LayoutState = { layouts: [], current: '' };

  /** Fires when the stored arrangements change. */
  onLayoutsChanged: (() => void) | null = null;

  /**
   * The arrangement this client has actually put into effect.
   *
   * Tracked so a layout is restored once per page rather than every time the
   * bridge pushes its state — which it does on every save, and re-applying
   * then would undo whatever the player had moved since.
   */
  private appliedLayout = '';

  /** Fires when a device is added or removed, so React can re-render the list. */
  onDevicesChanged: (() => void) | null = null;

  /**
   * Fires when a device is picked up or put down, so the view can show it.
   *
   * Not fired per frame while a device is moving: the mesh follows the pose
   * directly in the frame loop, and a React render on that path would put a
   * component tree rebuild on the same frame as note dispatch.
   */
  onGrabChanged: (() => void) | null = null;

  /**
   * The in-session pairing keypad.
   *
   * Always constructed, only rendered and updated while disconnected. Building
   * it lazily would mean allocating a detector and a highlighter at the moment
   * the link drops — which is precisely when the frame budget is least worth
   * spending on setup.
   */
  keypad: KeypadController | null = null;

  /**
   * Force the pairing panel on screen outside an XR session.
   *
   * The panel only appears in a session, which makes it the one part of the
   * interface you cannot look at while working on a desktop. This is the switch
   * to flip when developing it, and the seam the render test reaches through to
   * prove it actually draws. Set by the app; null before it mounts.
   */
  showKeypad: ((visible: boolean) => void) | null = null;

  /** Next id to hand out. Ids are never reused within a session. */
  private nextDeviceId = FIRST_DYNAMIC_DEVICE_ID;

  /** Set from the session; used to release notes on teardown. */
  private running = false;

  /** Whether the pairing keypad is currently shown and taking input. */
  keypadVisible = false;

  /**
   * Where a grab's output goes.
   *
   * Bound once. `onMove` fires every frame a device is held, so it must not
   * allocate and must not touch the network — it moves the pose and nothing
   * else. The bridge is told once, on release, because a hand carrying an
   * instrument produces a new pose ninety times a second and exactly one of
   * them is worth sending.
   *
   * Public so the render test can drive a grab through the same path a hand
   * does. A test that passed its own sink would exercise `Grabbable` and prove
   * nothing about whether a move reaches the mesh and the detector.
   */
  readonly grabSink: GrabSink;

  constructor() {
    this.link = new BridgeLink();

    this.grabSink = {
      onGrab: () => this.onGrabChanged?.(),
      onMove: (id, centre, yawDeg) => {
        const device = this.launchpads.find((d) => d.deviceId === id);
        if (device === undefined) return;
        device.setPose({
          centre: [centre[0], centre[1], centre[2]],
          tiltDeg: device.pose.tiltDeg,
          yawDeg,
        });
        // Moved by hand, so it is no longer sitting on whatever real surface it
        // was dropped onto — see the anchor path. Saying so here keeps the
        // roster honest about which poses were resolved and which were placed.
        device.anchored = false;
      },
      onRelease: (id) => {
        const device = this.launchpads.find((d) => d.deviceId === id);
        if (device !== undefined) this.link.sendDevicePose(device.placement());
        this.onGrabChanged?.();
      },
    };

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

    // LED traffic is decoded straight into the right device's state. Bound once
    // here rather than per packet: this fires dozens of times per DAW redraw.
    this.link.onLed = (deviceId, ledIndex, r, g, b, blink) => {
      const device = this.launchpads.find((d) => d.deviceId === deviceId);
      device?.applyLed(ledIndex, r, g, b, blink);
    };

    this.link.onDevices = (roster) => this.applyRoster(roster);
    this.link.onLayouts = (state) => this.receiveLayouts(state);
  }

  /**
   * Spawn an emulated device.
   *
   * The headset is the source of truth: this creates the local surface
   * immediately so it can be played at once, and asks the bridge to open the
   * matching MIDI ports. The roster that comes back says whether the DAW can
   * actually see it.
   */
  addDevice(model: string): LaunchpadInstance | null {
    // Past anything already taken. The bridge opens a device of its own at
    // startup and it holds the first dynamic id, so a headset that spawns one
    // before the roster reaches it would otherwise ask for that same id and
    // the bridge would treat the request as a duplicate and do nothing.
    while (this.launchpads.some((d) => d.deviceId === this.nextDeviceId)) this.nextDeviceId++;
    if (this.nextDeviceId > MAX_DEVICE_ID) return null;
    const deviceId = this.nextDeviceId++;
    const instance = createLaunchpad(deviceId, model, this.nextPose(), this.link);
    if (instance === null) return null;
    this.launchpads.push(instance);
    this.registerGrab(instance);
    this.link.requestDeviceAdd(deviceId, model);
    this.onDevicesChanged?.();
    return instance;
  }

  /**
   * Pin or unpin a device.
   *
   * Pinning while a hand is on it takes effect on this frame — `Grabbable`
   * drops a target that becomes pinned — because pinning is usually what
   * somebody reaches for *while* a device is drifting.
   */
  pinDevice(deviceId: number, pinned: boolean): boolean {
    const device = this.launchpads.find((d) => d.deviceId === deviceId);
    if (device === undefined) return false;
    device.pinned = pinned;
    this.syncGrabTarget(device);
    this.link.sendDevicePose(device.placement());
    this.onGrabChanged?.();
    return true;
  }

  /** Remove a device, releasing what it held and closing its ports. */
  removeDevice(deviceId: number): boolean {
    const at = this.launchpads.findIndex((d) => d.deviceId === deviceId);
    if (at < 0) return false;
    const [instance] = this.launchpads.splice(at, 1);
    this.grabs.remove(deviceId, this.grabSink);
    // Release before the ports close, or the notes are stranded in the DAW.
    instance?.releaseAll();
    this.link.requestDeviceRemove(deviceId);
    this.onDevicesChanged?.();
    return true;
  }

  /**
   * Take the bridge's word for what exists.
   *
   * Mostly this is an update to devices this headset spawned. But the bridge
   * opens a Launchpad of its own at startup — so the DAW has a control surface
   * to bind before anyone puts the headset on — and that one arrives here as a
   * device we have never seen. Adopting it is what puts a surface under the
   * lights the DAW is already sending; without it those LEDs are addressed to
   * nothing, and the user is looking at an empty room while Ableton believes a
   * Launchpad is plugged in.
   *
   * Adoption is silent and idempotent: a reconnect replays the same roster,
   * and the second pass finds the device already here.
   */
  private applyRoster(roster: readonly DeviceStateEntry[]): void {
    let changed = false;
    for (const entry of roster) {
      let device = this.launchpads.find((d) => d.deviceId === entry.deviceId);
      if (device === undefined) {
        device = this.adopt(entry.deviceId, entry.model);
        if (device === undefined) continue;
        changed = true;
      }
      if (device.status !== entry.status || device.detail !== entry.detail) {
        device.status = entry.status;
        device.detail = entry.detail;
        changed = true;
      }
      if (this.adoptPlacement(device, entry.placement)) changed = true;
    }
    if (changed) this.onDevicesChanged?.();
  }

  /**
   * Build a surface for a device the bridge already has open.
   *
   * Unlike `addDevice` this asks the bridge for nothing: the ports exist, and
   * a request to create them again would be answered as a no-op at best. It
   * only claims the id, so a device spawned later here cannot collide with it.
   */
  private adopt(deviceId: number, model: string): LaunchpadInstance | undefined {
    const instance = createLaunchpad(deviceId, model, this.nextPose(), this.link);
    if (instance === null) return undefined;
    this.launchpads.push(instance);
    this.registerGrab(instance);
    if (deviceId >= this.nextDeviceId) this.nextDeviceId = deviceId + 1;
    return instance;
  }

  // --- named arrangements ---

  /**
   * Store the room as it stands, under a name.
   *
   * Every emulated device goes in, including pinned ones — pinning is part of
   * an arrangement rather than a thing that happens to it. The built-in
   * surfaces are left out, because they are the app rather than furniture in
   * it: there is nothing to restore and nowhere else for them to be.
   */
  saveLayout(name: string): boolean {
    const clean = normaliseLayoutName(name);
    if (clean === '') return false;
    const layout: Layout = {
      name: clean,
      entries: this.launchpads.map((device) => ({
        placement: device.placement(),
        model: device.spec.model,
      })),
    };
    return this.link.saveLayout(layout);
  }

  deleteLayout(name: string): boolean {
    return this.link.deleteLayout(normaliseLayoutName(name));
  }

  /**
   * Put an arrangement into effect.
   *
   * Matched in two passes, and the second one is the point. A saved entry
   * carries both a device id and a model; ids are handed out per session and
   * are not stable across a restart of the bridge, so matching on id alone
   * would put a Launchpad Pro where a Launchpad X had been the moment anybody
   * restarted anything. So: exact id *and* model first, since that is
   * unambiguous, then whatever is left over matched by model in order.
   *
   * Devices a hand is currently holding are skipped. An arrangement arriving
   * mid-grab must not yank the instrument out from under somebody.
   */
  applyLayout(name: string): boolean {
    const clean = normaliseLayoutName(name);
    const layout = this.layouts.layouts.find((l) => l.name === clean);
    if (layout === undefined) return false;

    // Devices a hand is holding are excluded outright rather than skipped
    // later, so a held Launchpad cannot absorb an entry that another device
    // would otherwise have matched.
    const free = this.launchpads.filter((d) => !this.grabs.isHeld(d.deviceId));
    for (const { device, placement } of matchLayout(
      layout.entries,
      free.map((d) => ({ deviceId: d.deviceId, model: d.spec.model, instance: d })),
    )) {
      const instance = device.instance;
      instance.setPose({
        centre: [placement.centre[0], placement.centre[1], placement.centre[2]],
        yawDeg: placement.yawDeg,
        tiltDeg: placement.tiltDeg,
      });
      instance.pinned = (placement.flags & PlacementFlags.PINNED) !== 0;
      instance.anchored = (placement.flags & PlacementFlags.ANCHORED) !== 0;
      this.syncGrabTarget(instance);
    }

    this.appliedLayout = clean;
    this.layouts = { ...this.layouts, current: clean };
    // Tell the bridge which one is in use, so the next connection restores the
    // same arrangement. It is not being asked to move anything.
    this.link.applyLayout(clean);
    this.onDevicesChanged?.();
    this.onLayoutsChanged?.();
    return true;
  }

  /**
   * Take the bridge's word for what is stored, and restore on arrival.
   *
   * The restore is what makes layouts worth having: the bridge outlives the
   * session and pushes this on every connection, so an arrangement is back
   * before the player has finished putting the headset on. It runs once per
   * named arrangement rather than on every push — the bridge also pushes after
   * a save, and re-applying then would undo everything moved since.
   */
  private receiveLayouts(state: LayoutState): void {
    this.layouts = state;
    this.onLayoutsChanged?.();
    if (state.current !== '' && state.current !== this.appliedLayout) {
      this.applyLayout(state.current);
    }
  }

  /**
   * Put a device where the bridge says it was left.
   *
   * A null placement means nobody has ever moved it, which is a real answer
   * rather than a missing one — the device stays at its default pose instead of
   * being dragged to the origin. And a device currently in somebody's hand is
   * left alone: a roster push arriving mid-grab must not yank the instrument
   * out from under them.
   */
  private adoptPlacement(
    device: LaunchpadInstance,
    placement: DeviceStateEntry['placement'],
  ): boolean {
    if (placement === null) return false;
    if (this.grabs.isHeld(device.deviceId)) return false;

    const pinned = (placement.flags & PlacementFlags.PINNED) !== 0;
    const anchored = (placement.flags & PlacementFlags.ANCHORED) !== 0;
    const same =
      device.placed &&
      device.pinned === pinned &&
      device.pose.centre[0] === placement.centre[0] &&
      device.pose.centre[1] === placement.centre[1] &&
      device.pose.centre[2] === placement.centre[2] &&
      (device.pose.yawDeg ?? 0) === placement.yawDeg &&
      device.pose.tiltDeg === placement.tiltDeg;
    if (same) return false;

    device.setPose({
      centre: [placement.centre[0], placement.centre[1], placement.centre[2]],
      yawDeg: placement.yawDeg,
      tiltDeg: placement.tiltDeg,
    });
    device.pinned = pinned;
    device.anchored = anchored;
    this.syncGrabTarget(device);
    return true;
  }

  /** Make a device grabbable, and keep the target pointing at its pose. */
  private registerGrab(device: LaunchpadInstance): void {
    this.grabs.add({
      id: device.deviceId,
      // The array the grab writes into is the device's own pose array, so a
      // move needs no copy back — `setPose` in the sink reads exactly what the
      // grab just wrote.
      centre: [device.pose.centre[0], device.pose.centre[1], device.pose.centre[2]],
      yawDeg: device.pose.yawDeg ?? 0,
      // Half the diagonal, plus a little: a pinch anywhere on or just off the
      // device takes hold of it, and nothing further away does.
      reach: Math.hypot(device.layout.width, device.layout.height) / 2 + 0.04,
      pinned: device.pinned,
    });
  }

  /**
   * Push a device's pose back into its grab target after something else moved
   * it — a restored layout, a roster push, an anchor resolving.
   *
   * Rebuilt rather than mutated in place: the target list is small and this
   * runs at human speed, and a stale centre is a device that jumps the next
   * time somebody pinches near where it used to be. Only ever called for a
   * device no hand is holding, so the release the removal would announce
   * cannot fire.
   */
  private syncGrabTarget(device: LaunchpadInstance): void {
    this.grabs.remove(device.deviceId, this.grabSink);
    this.registerGrab(device);
  }

  /**
   * Where the next device goes.
   *
   * New devices are placed to the right of the last one, at a comfortable
   * height, rather than stacked on top of each other. Repositioning by hand is
   * a later concern; landing somewhere reachable is the immediate one.
   */
  private nextPose(): SurfacePose {
    const n = this.launchpads.length;
    return {
      centre: [0.42 + n * 0.34, 0.95, -0.52],
      tiltDeg: 48,
    };
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
      // After the tips, and only when something draws them. The two readers are
      // independent: a failure to fill the skeleton cannot affect a note.
      if (this.drawHands) this.skeleton.update(xrFrame, space);
      for (const instrument of this.instruments) {
        instrument.detector.update(this.fingers, instrument.router);
      }
      // Emulated hardware shares the same fingertip frame, so a hand can move
      // between a Launchpad and the keyboard without either losing track of it.
      for (const device of this.launchpads) {
        device.detector.update(this.fingers, device);
      }
      this.knobs.update(this.fingers, this.knobSink);
      // After the detectors, so a frame that both plays a pad and moves a
      // device resolves the note against the pose it was struck at.
      this.grabs.update(this.fingers, this.grabSink);
      // Only while it is on screen. A detector running against a panel nobody
      // can see would still consume every fingertip and could still fire.
      if (this.keypadVisible) this.keypad?.update(this.fingers, dt);
    }

    this.link.endFrame();

    for (const instrument of this.instruments) instrument.highlighter.update(dt);
  }

  /** Called when the session starts. */
  onSessionStart(session: XRSession): void {
    this.running = true;
    this.tracker.syncInputSources(session);
    this.skeleton.syncInputSources(session);
    this.drawHands = true;
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
    for (const device of this.launchpads) device.releaseAll();
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
