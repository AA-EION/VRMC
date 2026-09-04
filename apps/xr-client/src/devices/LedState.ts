// SPDX-License-Identifier: GPL-3.0-only

import { Color, type InstancedMesh } from 'three';
import { to8Bit } from '@vrmc/devices';

/**
 * Per-LED colour for one emulated device, and the animation on top of it.
 *
 * The DAW owns these colours: it decides that a clip is playing green or queued
 * amber, and the surface's job is to show that faithfully. So unlike the pad
 * grid's highlighter — which invents a flash because nothing else would — this
 * mostly renders what it is told.
 *
 * The exception is blinking. Flashing and pulsing are states the hardware
 * animates itself; the host sets them once and expects the device to keep
 * going. Doing that here rather than in the emulator keeps the animation at
 * frame rate where it belongs, and keeps the emulator free of clocks so the
 * copy on the desktop and the copy in the headset cannot drift.
 */

/** Blink modes, matching the LED SysEx lighting types. */
export const Blink = { STEADY: 0, FLASHING: 1, PULSING: 2 } as const;

/** Flashes per second for a flashing LED. Roughly the hardware's rate. */
const FLASH_HZ = 2;
/** Cycles per second for a pulsing LED. */
const PULSE_HZ = 1;
/** Floor of the pulse envelope, so a pulsing pad never goes fully dark. */
const PULSE_FLOOR = 0.25;

/** Seconds a released control takes to fade back to its host-set colour. */
const TOUCH_FADE = 0.14;

/** What an unlit control looks like unless the device says otherwise. */
const DEFAULT_REST = [0.055, 0.06, 0.075] as const;

export class LedState {
  /** Target colour per zone, 0..1 linear-ish, as three floats. */
  private readonly base: Float32Array;
  /**
   * What a zone looks like with nothing lighting it.
   *
   * An unlit control still has to be visible as a physical object — on a real
   * Launchpad the plastic catches the room's light, and in passthrough the
   * same has to be faked or the grid dissolves into holes.
   *
   * Per zone rather than one constant because the devices are no longer all
   * pad grids. A piano key is bone-white and its accidentals near-black; a
   * keyboard rendered at a pad grid's dark resting colour is a row of dark
   * rectangles you cannot read the shape of, which is what it looked like the
   * first time the VRMC surface was drawn this way.
   */
  private readonly rest: Float32Array;
  /** Blink mode per zone. */
  private readonly blink: Uint8Array;
  /** Local press overlay: seconds of fade remaining once released. */
  private readonly press: Float32Array;
  /** 1 while a finger is on the control. */
  private readonly held: Uint8Array;

  private mesh: InstancedMesh | null = null;
  private readonly scratch = new Color();
  /** True when something changed and the instance buffer must be rewritten. */
  private dirty = true;
  /** True while any zone is animating, so a static surface costs nothing. */
  private animating = false;

  readonly zoneCount: number;

  constructor(zoneCount: number) {
    this.zoneCount = zoneCount;
    this.base = new Float32Array(zoneCount * 3);
    this.rest = new Float32Array(zoneCount * 3);
    for (let i = 0; i < zoneCount; i++) {
      this.rest[i * 3] = DEFAULT_REST[0];
      this.rest[i * 3 + 1] = DEFAULT_REST[1];
      this.rest[i * 3 + 2] = DEFAULT_REST[2];
    }
    this.blink = new Uint8Array(zoneCount);
    this.press = new Float32Array(zoneCount);
    this.held = new Uint8Array(zoneCount);
  }

  /**
   * Set a zone's unlit colour, 0..1 per channel.
   *
   * Set once when the device is built, from what the control physically is —
   * not from anything the DAW says, which goes through `setLed`.
   */
  setRest(zoneIndex: number, r: number, g: number, b: number): void {
    if (zoneIndex < 0 || zoneIndex >= this.zoneCount) return;
    const o = zoneIndex * 3;
    this.rest[o] = r;
    this.rest[o + 1] = g;
    this.rest[o + 2] = b;
    this.dirty = true;
  }

  attach(mesh: InstancedMesh | null): void {
    this.mesh = mesh;
    this.dirty = true;
  }

  /**
   * Set a zone's colour from the device's 6-bit channels.
   *
   * Called once per LED per update, straight out of the network decode, so it
   * does no work beyond storing and flagging.
   */
  setLed(zoneIndex: number, r6: number, g6: number, b6: number, blink: number): void {
    if (zoneIndex < 0 || zoneIndex >= this.zoneCount) return;
    const o = zoneIndex * 3;
    this.base[o] = to8Bit(r6) / 255;
    this.base[o + 1] = to8Bit(g6) / 255;
    this.base[o + 2] = to8Bit(b6) / 255;
    this.blink[zoneIndex] = blink;
    this.dirty = true;
    if (blink !== Blink.STEADY) this.animating = true;
  }

  /**
   * Brighten a zone while the player is touching it.
   *
   * Purely local. The DAW will usually light the pad a moment later, but "a
   * moment later" is a network round trip, and a surface that does not
   * acknowledge a touch until the host agrees feels broken rather than remote.
   *
   * Stays lit for as long as the finger is down, like the pad grid's
   * highlighter: a control you are holding has to look held.
   */
  touch(zoneIndex: number): void {
    if (zoneIndex < 0 || zoneIndex >= this.zoneCount) return;
    this.held[zoneIndex] = 1;
    this.press[zoneIndex] = TOUCH_FADE;
    this.dirty = true;
    this.animating = true;
  }

  /** Start the fade back once the finger lifts. */
  release(zoneIndex: number): void {
    if (zoneIndex < 0 || zoneIndex >= this.zoneCount) return;
    this.held[zoneIndex] = 0;
    this.press[zoneIndex] = TOUCH_FADE;
    this.dirty = true;
    this.animating = true;
  }

  /** Clear every LED, e.g. when the device is removed. */
  clear(): void {
    this.base.fill(0);
    this.blink.fill(0);
    this.press.fill(0);
    this.held.fill(0);
    this.dirty = true;
  }

  /**
   * Write colours into the instance buffer. Call once per frame.
   *
   * @param dt   seconds since the last frame
   * @param time seconds since start, for the blink phase
   */
  update(dt: number, time: number): void {
    const mesh = this.mesh;
    if (mesh === null) return;

    // Fade the local press overlay, except where a finger is still down.
    let stillPressing = false;
    for (let i = 0; i < this.zoneCount; i++) {
      if (this.held[i] === 1) {
        stillPressing = true;
        continue;
      }
      const remaining = this.press[i]!;
      if (remaining <= 0) continue;
      const next = remaining - dt;
      this.press[i] = next > 0 ? next : 0;
      if (next > 0) stillPressing = true;
      this.dirty = true;
    }

    let anyBlinking = false;
    for (let i = 0; i < this.zoneCount; i++) {
      if (this.blink[i] !== Blink.STEADY) {
        anyBlinking = true;
        break;
      }
    }
    this.animating = stillPressing || anyBlinking;

    if (!this.dirty && !this.animating) return;

    // Two phases shared by every zone, so the maths is done once per frame
    // rather than once per LED.
    const flashOn = Math.floor(time * FLASH_HZ * 2) % 2 === 0;
    const pulse = PULSE_FLOOR + (1 - PULSE_FLOOR) * (0.5 + 0.5 * Math.sin(time * PULSE_HZ * Math.PI * 2));

    for (let i = 0; i < this.zoneCount; i++) {
      const o = i * 3;
      let r = this.base[o]!;
      let g = this.base[o + 1]!;
      let b = this.base[o + 2]!;

      const mode = this.blink[i]!;
      if (mode === Blink.FLASHING) {
        if (!flashOn) {
          r = 0;
          g = 0;
          b = 0;
        }
      } else if (mode === Blink.PULSING) {
        r *= pulse;
        g *= pulse;
        b *= pulse;
      }

      const pressing = this.held[i] === 1 ? TOUCH_FADE : this.press[i]!;
      if (pressing > 0) {
        const mix = Math.min(1, pressing / TOUCH_FADE);
        r += (1 - r) * mix;
        g += (1 - g) * mix;
        b += (1 - b) * mix;
      }

      // Lit colour over the control's own unlit one, so a dark pad and a white
      // key both start from what they are and brighten from there.
      const rr = this.rest[o]!;
      const rg = this.rest[o + 1]!;
      const rb = this.rest[o + 2]!;
      this.scratch.setRGB(
        rr + r * (1 - rr),
        rg + g * (1 - rg),
        rb + b * (1 - rb),
      );
      mesh.setColorAt(i, this.scratch);
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    this.dirty = false;
  }
}
