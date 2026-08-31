import type { ZoneLocator } from '@vrmc/layout';
import { DEFAULT_VELOCITY, EventFlags, speedToVelocity, VelocityCurve } from '@vrmc/protocol';
import { FingerFrame, MAX_FINGERS } from './fingers.js';

/**
 * Receives note events as the detector produces them.
 *
 * Deliberately push-based with primitive arguments: returning a list of events
 * would allocate an array and an object per note, every frame, in the one place
 * on the Quest where a GC pause is audible.
 */
export interface NoteSink {
  noteOn(zoneIndex: number, note: number, velocity: number, tOffsetMs: number, flags: number): void;
  noteOff(zoneIndex: number, note: number, tOffsetMs: number): void;
  /** Polyphonic pressure from sustained finger depth, 0..127. */
  aftertouch(zoneIndex: number, note: number, pressure: number): void;
}

export interface PokeOptions {
  /**
   * Hysteresis, in metres. A note fires when the fingertip crosses the key
   * surface and releases only once it climbs back this far above it.
   *
   * Hand tracking jitters by roughly a millimetre even when the hand is still.
   * With no hysteresis a fingertip resting exactly on the plane retriggers on
   * that noise — a machine-gun stutter that is the single most common way a
   * hand-tracked instrument fails. 4 mm sits above the noise floor without
   * being noticeable as latency on release.
   */
  releaseMargin: number;

  /**
   * Minimum time between two strikes on the same zone by the same finger, in
   * ms. Guards against a bounce at the moment of crossing.
   */
  refractoryMs: number;

  /** Depth below the surface, in metres, that maps to full aftertouch. */
  aftertouchDepth: number;

  /** Frames between aftertouch updates. 0 disables aftertouch entirely. */
  aftertouchInterval: number;

  /** Velocity curve exponent. See `VelocityCurve`. */
  velocityGamma: number;

  /**
   * Whether sliding a pressed finger from one zone to another retriggers.
   *
   * On a keyboard this is a glissando and players expect it. On a pad grid it
   * is a finger roll. Both are real techniques, so it defaults on.
   */
  glissando: boolean;

  /**
   * Velocity for a glissando note, as a fraction of the velocity that started
   * the slide. A gliss is quieter than a deliberate strike.
   */
  glissandoScale: number;

  /**
   * Longest frame, in seconds, for which a finite-difference velocity is
   * trusted. Past this the frame is assumed to have hitched and the strike is
   * flagged as estimated.
   */
  maxTrustedDt: number;
}

export const DEFAULT_POKE_OPTIONS: PokeOptions = {
  releaseMargin: 0.004,
  refractoryMs: 28,
  aftertouchDepth: 0.02,
  aftertouchInterval: 3,
  velocityGamma: VelocityCurve.NATURAL,
  glissando: true,
  glissandoScale: 0.72,
  maxTrustedDt: 0.05,
};

/** Samples of approach speed kept per finger for peak detection. */
const VELOCITY_HISTORY = 4;

/**
 * Detects finger pokes against one flat surface and turns them into notes.
 *
 * One instance per playable surface (the pad grid, the keyboard). Each frame,
 * call `update()` with the shared `FingerFrame`; it transforms every tracked
 * fingertip into surface-local space, asks the layout which zone it is over,
 * and tracks the press state machine per finger.
 *
 * The whole update is allocation-free and branch-light: cost is O(fingers), not
 * O(zones), because the layout resolves a point to a zone by arithmetic.
 */
export class PokeDetector {
  readonly options: PokeOptions;
  private readonly locator: ZoneLocator;

  // --- Surface pose (world space) ---
  private px = 0;
  private py = 0;
  private pz = 0;
  private qx = 0;
  private qy = 0;
  private qz = 0;
  private qw = 1;

  // --- Per-finger state ---
  /** Zone the finger is currently holding, or -1. */
  private readonly heldZone = new Int16Array(MAX_FINGERS).fill(-1);
  /** Signed distance above the held/hovered surface last frame, in metres. */
  private readonly prevDepth = new Float32Array(MAX_FINGERS);
  /** Whether prevDepth holds a usable value. */
  private readonly hasPrev = new Uint8Array(MAX_FINGERS);
  /**
   * Timestamp of this finger's last note-on, for the refractory window.
   *
   * f64, not f32: these are `performance.now()` values, and float32 runs out of
   * mantissa past ~16.7 million ms. A page left open for five hours would start
   * quantising the refractory comparison to several milliseconds, which is the
   * kind of bug that only appears during a long session and looks like the
   * hardware misbehaving.
   */
  private readonly lastStrikeMs = new Float64Array(MAX_FINGERS).fill(-1e9);
  /** Ring of recent approach speeds (m/s) per finger, for peak detection. */
  private readonly speedHistory = new Float32Array(MAX_FINGERS * VELOCITY_HISTORY);
  private readonly speedCursor = new Uint8Array(MAX_FINGERS);
  /** Velocity the current hold started with, for scaling glissando notes. */
  private readonly holdVelocity = new Uint8Array(MAX_FINGERS);
  /** Last aftertouch value sent, to suppress duplicates. */
  private readonly lastPressure = new Uint8Array(MAX_FINGERS).fill(255);

  private frameCounter = 0;

  /** Scratch for the world -> local transform. Reused every call. */
  private readonly local = new Float32Array(3);

  constructor(locator: ZoneLocator, options: Partial<PokeOptions> = {}) {
    this.locator = locator;
    this.options = { ...DEFAULT_POKE_OPTIONS, ...options };
  }

  /**
   * Set the surface's world pose. Call whenever the panel moves (the user
   * grabbed and repositioned it), not every frame.
   */
  setPose(
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void {
    this.px = px;
    this.py = py;
    this.pz = pz;
    this.qx = qx;
    this.qy = qy;
    this.qz = qz;
    this.qw = qw;
  }

  /**
   * Advance one frame. Emits note on/off and aftertouch into `sink`.
   */
  update(frame: FingerFrame, sink: NoteSink): void {
    this.frameCounter++;
    const dt = frame.dt;
    const dtMs = dt * 1000;
    const trustDt = dt > 0 && dt <= this.options.maxTrustedDt;

    for (let f = 0; f < MAX_FINGERS; f++) {
      if (frame.tracked[f] === 0) {
        // Tracking dropped mid-press. Release rather than leave a note ringing:
        // a stuck note outlives the session and has to be cleared by hand.
        this.releaseIfHeld(f, sink, 0);
        this.hasPrev[f] = 0;
        continue;
      }

      const o = f * 3;
      this.toLocal(frame.position[o]!, frame.position[o + 1]!, frame.position[o + 2]!);
      const lx = this.local[0]!;
      const ly = this.local[1]!;
      // The tracked joint is the bone centre; contact happens a finger-radius
      // earlier. Without this the player has to push visibly through the key.
      const lz = this.local[2]! - frame.radius[f]!;

      const zone = this.locator.locate(lx, ly);
      const held = this.heldZone[f]!;

      if (zone < 0) {
        // Off the surface entirely: release anything held and reset history.
        this.releaseIfHeld(f, sink, 0);
        this.hasPrev[f] = 0;
        continue;
      }

      const raise = this.locator.zones[zone]!.raise;
      const depth = lz - raise; // > 0 above the key, < 0 pressed in

      // Track approach speed along the surface normal.
      if (this.hasPrev[f] === 1 && trustDt) {
        const speed = (this.prevDepth[f]! - depth) / dt; // + when descending
        const c = this.speedCursor[f]!;
        this.speedHistory[f * VELOCITY_HISTORY + c] = speed;
        this.speedCursor[f] = (c + 1) % VELOCITY_HISTORY;
      }

      if (held >= 0) {
        if (held !== zone) {
          // Slid sideways onto a different key while still pressed.
          this.releaseIfHeld(f, sink, 0);
          if (this.options.glissando && depth <= 0) {
            const v = Math.max(
              1,
              Math.round(this.holdVelocity[f]! * this.options.glissandoScale) || DEFAULT_VELOCITY,
            );
            this.strike(f, zone, v, 0, EventFlags.NONE, frame.timestamp, sink);
          }
        } else if (depth > this.options.releaseMargin) {
          // Climbed back out past the hysteresis band.
          this.releaseIfHeld(f, sink, 0);
        } else if (this.options.aftertouchInterval > 0 && depth < 0) {
          this.maybeAftertouch(f, zone, depth, sink);
        }
      } else if (depth <= 0 && this.hasPrev[f] === 1 && this.prevDepth[f]! > 0) {
        // Crossed the surface this frame: a strike.
        const sinceStrike = frame.timestamp - this.lastStrikeMs[f]!;
        if (sinceStrike >= this.options.refractoryMs) {
          const prev = this.prevDepth[f]!;
          // Where in the frame the crossing happened, 0..1 from prev to now.
          const span = prev - depth;
          const t = span > 1e-9 ? prev / span : 1;
          const tOffsetMs = trustDt ? (1 - t) * dtMs : 0;

          let flags = EventFlags.NONE;
          let speed = this.peakSpeed(f);
          if (!trustDt || speed <= 0) {
            speed = 0;
            flags |= EventFlags.ESTIMATED_VELOCITY;
          }
          const velocity =
            flags & EventFlags.ESTIMATED_VELOCITY
              ? DEFAULT_VELOCITY
              : speedToVelocity(speed, this.options.velocityGamma);

          this.strike(f, zone, velocity, tOffsetMs, flags, frame.timestamp, sink);
        }
      }

      this.prevDepth[f] = depth;
      this.hasPrev[f] = 1;
    }
  }

  /**
   * Release every held note. Call when the surface is hidden, the session ends,
   * or the transport drops — anything that would otherwise strand a note on.
   */
  releaseAll(sink: NoteSink): void {
    for (let f = 0; f < MAX_FINGERS; f++) {
      this.releaseIfHeld(f, sink, 0);
      this.hasPrev[f] = 0;
    }
  }

  /** Zone a finger is currently holding, or -1. For the renderer's highlight. */
  heldZoneOf(finger: number): number {
    return this.heldZone[finger] ?? -1;
  }

  // --- internals ---

  private strike(
    f: number,
    zone: number,
    velocity: number,
    tOffsetMs: number,
    flags: number,
    now: number,
    sink: NoteSink,
  ): void {
    this.heldZone[f] = zone;
    this.holdVelocity[f] = velocity;
    this.lastStrikeMs[f] = now;
    this.lastPressure[f] = 255;
    sink.noteOn(zone, this.locator.zones[zone]!.note, velocity, tOffsetMs, flags);
  }

  private releaseIfHeld(f: number, sink: NoteSink, tOffsetMs: number): void {
    const zone = this.heldZone[f]!;
    if (zone < 0) return;
    this.heldZone[f] = -1;
    this.lastPressure[f] = 255;
    sink.noteOff(zone, this.locator.zones[zone]!.note, tOffsetMs);
  }

  private maybeAftertouch(f: number, zone: number, depth: number, sink: NoteSink): void {
    if (this.frameCounter % this.options.aftertouchInterval !== 0) return;
    let t = -depth / this.options.aftertouchDepth;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const pressure = Math.round(t * 127);
    // Only send on change: a held finger otherwise floods the wire with
    // identical pressure messages that some DAWs handle poorly.
    if (pressure === this.lastPressure[f]) return;
    this.lastPressure[f] = pressure;
    sink.aftertouch(zone, this.locator.zones[zone]!.note, pressure);
  }

  /**
   * Peak approach speed over the last few frames.
   *
   * The instantaneous finite difference at the crossing frame is noisy, and it
   * systematically under-reads a fast strike: the finger has already begun to
   * decelerate against the (imaginary) surface by the time it crosses. Taking
   * the peak of the approach recovers the speed the player actually meant.
   */
  private peakSpeed(f: number): number {
    let best = 0;
    const base = f * VELOCITY_HISTORY;
    for (let i = 0; i < VELOCITY_HISTORY; i++) {
      const v = this.speedHistory[base + i]!;
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * World -> surface-local, written into `this.local`.
   *
   * Rotating by the conjugate of the surface's orientation. Written out longhand
   * rather than via a matrix so it neither allocates nor touches a library.
   */
  private toLocal(wx: number, wy: number, wz: number): void {
    const vx = wx - this.px;
    const vy = wy - this.py;
    const vz = wz - this.pz;

    // Conjugate quaternion: negate the vector part.
    const qx = -this.qx;
    const qy = -this.qy;
    const qz = -this.qz;
    const qw = this.qw;

    // v' = v + 2 * (qv x (qv x v + w*v))
    const tx = qy * vz - qz * vy + qw * vx;
    const ty = qz * vx - qx * vz + qw * vy;
    const tz = qx * vy - qy * vx + qw * vz;

    this.local[0] = vx + 2 * (qy * tz - qz * ty);
    this.local[1] = vy + 2 * (qz * tx - qx * tz);
    this.local[2] = vz + 2 * (qx * ty - qy * tx);
  }
}
