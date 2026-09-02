// SPDX-License-Identifier: GPL-3.0-only

import { PokeDetector, type FingerFrame, type NoteSink } from '@vrmc/interaction';
import { feelOf, type LinkQuality } from '@vrmc/protocol';
import { SurfaceHighlighter, type SurfaceTheme } from '../devices/InstrumentSurface.js';
import { WRIST_POSE_FLOATS, facingAmount, wristPose } from '../xr/wrist.js';
import type { HandSkeleton } from '../xr/HandSkeleton.js';
import { WristMenuLayout } from './WristMenuLayout.js';

/**
 * The console on the inside of a wrist.
 *
 * WHY IT IS WORN
 * Nothing else in this app is welded to the player. A panel that follows your
 * head is the fastest way to make a room feel like a website with a headset
 * strapped to it, and a panel left floating somewhere is one you have to walk
 * back to. A watch is neither: it is not there until you turn your wrist, and
 * it is gone when you put your arm down.
 *
 * AND IT MUST NEVER STEAL A POKE
 * This is the constraint the whole design answers to. A hand playing a pad grid
 * is a hand making rapid, deliberate stabs at a surface — and the console lives
 * on that same hand. Three things keep them apart, and the first is the one
 * that matters:
 *
 *   1. The detector does not run at all unless the wrist is turned toward the
 *      eye. `facingAmount` returns exactly zero below its threshold, and below
 *      that this class does not call `update`. An arm hanging at a side, or a
 *      hand flat over an instrument, cannot press anything here — there is
 *      nothing running to press.
 *   2. It is on the *left* wrist by default and instruments are in front of the
 *      player, so the volumes barely overlap even when it is open.
 *   3. Its detector is its own. A fingertip crossing the console's plane is
 *      resolved by this detector and an instrument's by that instrument's;
 *      neither consumes the other's, because `FingerFrame` is read rather than
 *      claimed.
 *
 * The gate is checked against the panel's own pose each frame, so it closes the
 * instant the wrist turns away — including mid-press, which releases whatever
 * was held rather than leaving it latched.
 */

export const WRIST_THEME: SurfaceTheme = {
  idle: '#171617',
  idleAccidental: '#222222',
  active: '#f2f0eb',
  plate: '#0b0b0c',
};

/** One row of the console. */
export interface WristItem {
  id: string;
  /** Rebuilt when state changes, so a row can say what it will do. */
  label: () => string;
  run: () => void;
  /** The row reads as «on». */
  live?: () => boolean;
}

export interface WristMenuState {
  /** 0..1 — how open the console is. 0 is closed and not listening. */
  facing: number;
  labels: readonly string[];
  live: readonly boolean[];
  /** The readout above the rows. */
  readout: string;
}

export class WristMenu {
  layout: WristMenuLayout;
  highlighter: SurfaceHighlighter;
  private detector: PokeDetector;
  private items: readonly WristItem[] = [];

  /** The wrist's own frame: position xyz then quaternion xyzw, in world space. */
  readonly pose = new Float32Array(WRIST_POSE_FLOATS);

  /**
   * The panel's surface transform: its bottom-left corner, then the same
   * rotation.
   *
   * A separate thing from `pose`, and the difference is half the console. Every
   * surface in this app puts its local origin at the bottom-left corner —
   * that is what `surfaceTransform` produces and what the poke detector
   * inverts — while a console is naturally placed by its *centre*, over the
   * wrist. Feeding the centre to the detector and drawing from the corner is
   * exactly the failure placement.ts warns about: it does not look broken, the
   * rows simply answer half a panel away from where they are drawn.
   *
   * So the offset is applied once, here, and both the detector and the renderer
   * read this.
   */
  readonly surface = new Float32Array(WRIST_POSE_FLOATS);
  /** 0..1. Zero means closed, and closed means the detector does not run. */
  facing = 0;
  /** True while the pose is usable at all — a hand is being tracked. */
  worn = false;

  /** Which hand it is worn on. */
  handedness: XRHandedness = 'left';

  private quality: LinkQuality | null = null;
  private rttMs = -1;
  /**
   * Something more urgent than the link's health, or ''.
   *
   * The calibration routine's prompts go here rather than into a panel of their
   * own. A guided routine needs one line of instruction at a time, the console
   * already has a line that is read at exactly the right distance, and a second
   * floating panel to say «hit five pads gently» would be a second thing to
   * find while your hands are busy.
   */
  private notice = '';

  onChange: ((state: WristMenuState) => void) | null = null;

  constructor(items: readonly WristItem[]) {
    this.items = items;
    this.layout = new WristMenuLayout(items.map((i) => i.label()));
    this.highlighter = new SurfaceHighlighter(this.layout, WRIST_THEME);
    this.detector = this.buildDetector();
  }

  /** Replace the rows. Rebuilds the surface, so it is for setup, not per frame. */
  setItems(items: readonly WristItem[]): void {
    this.items = items;
    this.layout = new WristMenuLayout(items.map((i) => i.label()));
    this.highlighter = new SurfaceHighlighter(this.layout, WRIST_THEME);
    this.detector = this.buildDetector();
    this.publish();
  }

  /** The link's own figures, for the readout. Set at human speed. */
  setLink(rttMs: number, quality: LinkQuality | null): void {
    this.rttMs = rttMs;
    this.quality = quality;
    this.publish();
  }

  /** Say something more urgent than the link's health. '' restores it. */
  setNotice(text: string): void {
    if (this.notice === text) return;
    this.notice = text;
    this.publish();
  }

  /**
   * Advance one frame.
   *
   * Returns true when the console is open, so the caller can draw it. The
   * detector is only fed while it is: see the note at the top of this file.
   */
  update(
    skeleton: HandSkeleton,
    fingers: FingerFrame,
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    dt: number,
  ): boolean {
    const slot = skeleton.hands.findIndex((h) => h.handedness === this.handedness);
    const binding = slot < 0 ? undefined : skeleton.hands[slot];

    if (binding === undefined || !binding.tracked) {
      this.close();
      this.highlighter.update(dt);
      return false;
    }

    this.worn = wristPose(skeleton.matrices, binding.offset, this.handedness, this.pose);
    if (!this.worn) {
      this.close();
      this.highlighter.update(dt);
      return false;
    }

    const facing = facingAmount(this.pose, eyeX, eyeY, eyeZ);
    const wasOpen = this.facing > 0;
    this.facing = facing;

    if (facing <= 0) {
      // Closed. Release anything held rather than latching it: a wrist turning
      // away mid-press must not leave a row stuck down.
      if (wasOpen) this.close();
      this.highlighter.update(dt);
      return false;
    }

    this.updateSurface();
    this.detector.setPose(
      this.surface[0]!,
      this.surface[1]!,
      this.surface[2]!,
      this.surface[3]!,
      this.surface[4]!,
      this.surface[5]!,
      this.surface[6]!,
    );
    this.detector.update(fingers, this.sink);
    this.highlighter.update(dt);
    return true;
  }

  /** Release everything. For teardown and for the wrist turning away. */
  close(): void {
    if (this.facing !== 0) this.facing = 0;
    this.detector.releaseAll(this.sink);
  }

  get state(): WristMenuState {
    return {
      facing: this.facing,
      labels: this.items.map((i) => i.label()),
      live: this.items.map((i) => i.live?.() ?? false),
      readout: this.readout(),
    };
  }

  /**
   * The link, in words rather than as a dashboard.
   *
   * Six figures on a wrist is a dashboard, and a dashboard is not what somebody
   * mid-phrase needs — they need to know whether to trust their own timing. So
   * it leads with a word, and the numbers that justify it come after it for
   * anybody who wants them.
   */
  private readout(): string {
    if (this.notice !== '') return this.notice;
    if (this.quality === null) {
      return this.rttMs >= 0 ? `${this.rttMs.toFixed(0)} ms · waiting` : 'Not connected';
    }
    const feel = feelOf(this.quality);
    const word = feel === 'good' ? 'Solid' : feel === 'fair' ? 'Usable' : 'Struggling';
    const rtt = this.rttMs >= 0 ? `${this.rttMs.toFixed(0)}` : '—';
    const loss = this.quality.lossRatio * 100;
    return `${word} · ${rtt} ms · ±${this.quality.jitterMs.toFixed(1)} · ${loss.toFixed(loss < 1 ? 2 : 0)}% lost`;
  }

  private readonly sink: NoteSink = {
    noteOn: (zoneIndex) => {
      this.highlighter.strike(zoneIndex, 127);
      this.items[zoneIndex]?.run();
      this.publish();
    },
    noteOff: (zoneIndex) => this.highlighter.release(zoneIndex),
    aftertouch: () => {
      /* Nothing here responds to pressure. */
    },
  };

  /**
   * Slide the panel's frame from its centre to its bottom-left corner.
   *
   * Rotating (-w/2, -h/2, 0) by the panel's own orientation and adding it.
   * Written out rather than going through a matrix, for the same reason
   * everything else on this path is: it runs every frame the console is open.
   */
  private updateSurface(): void {
    const qx = this.pose[3]!;
    const qy = this.pose[4]!;
    const qz = this.pose[5]!;
    const qw = this.pose[6]!;
    const vx = -this.layout.width / 2;
    const vy = -this.layout.height / 2;
    const tx = qy * 0 - qz * vy + qw * vx;
    const ty = qz * vx - qx * 0 + qw * vy;
    const tz = qx * vy - qy * vx;
    this.surface[0] = this.pose[0]! + vx + 2 * (qy * tz - qz * ty);
    this.surface[1] = this.pose[1]! + vy + 2 * (qz * tx - qx * tz);
    this.surface[2] = this.pose[2]! + 2 * (qx * ty - qy * tx);
    this.surface[3] = qx;
    this.surface[4] = qy;
    this.surface[5] = qz;
    this.surface[6] = qw;
  }

  private buildDetector(): PokeDetector {
    return new PokeDetector(this.layout, {
      // Deeper than an instrument's. A panel held up on your own forearm is
      // less steady than a desk, and a row that fires twice is far worse than
      // one that releases a moment late.
      releaseMargin: 0.007,
      // Long, for the same reason, and because nothing here is played in
      // rhythm: the cost of a slow repeat is nil and the cost of a double
      // press is a device spawned twice.
      refractoryMs: 220,
      // Off. A finger sliding down the console would otherwise run every row
      // it passed.
      glissando: false,
      aftertouchInterval: 0,
    });
  }

  private publish(): void {
    this.onChange?.(this.state);
  }
}
