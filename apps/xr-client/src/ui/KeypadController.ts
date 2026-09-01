// SPDX-License-Identifier: GPL-3.0-only

import { PokeDetector, type FingerFrame, type NoteSink } from '@vrmc/interaction';
import { PAIRING_CODE_LENGTH } from '@vrmc/protocol';
import { surfaceTransform } from '@vrmc/layout';
import { SurfaceHighlighter } from '../devices/InstrumentSurface.js';
import { KEYPAD_POSE, KEYPAD_THEME } from './ConnectPanel.js';
import { applyKey, BACKSPACE_INDEX, KeypadLayout } from './KeypadLayout.js';

export interface KeypadEvents {
  /** The typed code changed. */
  onCode: (code: string) => void;
  /** Six characters are in; try them. */
  onSubmit: (code: string) => void;
  /** A key was struck, for the click. */
  onKey: (zoneIndex: number) => void;
}

/**
 * Typing a pairing code with your hands.
 *
 * Driven by the same `PokeDetector` as the instruments, deliberately: the
 * hysteresis, the refractory period and the sub-frame timing that stop a
 * resting fingertip from machine-gunning a pad are exactly what stop it
 * machine-gunning a letter, and none of that is worth reimplementing for a
 * keypad.
 *
 * The code submits itself at six characters. There is no Connect button because
 * there is nothing left to decide: the length is fixed and known, so a button
 * would only be one more thing to find and press with a tracked finger.
 */
export class KeypadController {
  readonly layout = new KeypadLayout();
  readonly highlighter: SurfaceHighlighter;
  private readonly detector: PokeDetector;
  private readonly events: KeypadEvents;
  private readonly sink: NoteSink;

  private code = '';
  /** True while a connection attempt is in flight; keys are ignored then. */
  private busy = false;

  constructor(events: KeypadEvents) {
    this.events = events;
    this.highlighter = new SurfaceHighlighter(this.layout, KEYPAD_THEME);

    const { origin, quaternion } = surfaceTransform(this.layout, KEYPAD_POSE);
    this.detector = new PokeDetector(this.layout, {
      // Deeper hysteresis than an instrument's. Someone reaching out to a
      // floating panel holds their hand less steadily than over a desk, and a
      // letter that repeats itself is far more annoying than one that releases
      // a moment late.
      releaseMargin: 0.006,
      // Longer than an instrument's, for the same reason: a double-typed
      // character costs a backspace and the user's confidence in the panel,
      // where a missed one costs only another press. Not much longer, though —
      // this is per finger rather than per key, so a value chosen to stop a
      // bounce on one key also caps how fast the next one can be typed.
      refractoryMs: 90,
      // Off. On an instrument a finger sliding across zones is a glissando and
      // players want it; here it would type every key it brushed past.
      glissando: false,
      // Nothing here responds to pressure, so this is work the frame path can
      // simply not do.
      aftertouchInterval: 0,
    });
    this.detector.setPose(
      origin[0],
      origin[1],
      origin[2],
      quaternion[0],
      quaternion[1],
      quaternion[2],
      quaternion[3],
    );

    this.sink = {
      noteOn: (zoneIndex) => this.press(zoneIndex),
      noteOff: (zoneIndex) => this.highlighter.release(zoneIndex),
      aftertouch: () => {
        // A keypad has no use for pressure, and reporting it would only put
        // work on the frame path.
      },
    };
  }

  get value(): string {
    return this.code;
  }

  /** Advance one frame. `dt` is seconds, for the key highlight fade. */
  update(fingers: FingerFrame, dt: number): void {
    this.detector.update(fingers, this.sink);
    this.highlighter.update(dt);
  }

  /**
   * Lock the keypad while a connection is attempted.
   *
   * Without this, a user who pokes a seventh key during the handshake would
   * clear the field they just filled in, and it would look as though the panel
   * had lost their code.
   */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /** Empty the field, after a failure or when the panel is dismissed. */
  clear(): void {
    if (this.code === '') return;
    this.code = '';
    this.events.onCode('');
  }

  /** Release anything the detector thinks is held. Called on session end. */
  releaseAll(): void {
    this.detector.releaseAll(this.sink);
  }

  private press(zoneIndex: number): void {
    this.highlighter.strike(zoneIndex, 127);
    this.events.onKey(zoneIndex);
    if (this.busy) return;

    const next = applyKey(this.code, zoneIndex, this.layout);
    if (next === this.code) return;
    this.code = next;
    this.events.onCode(next);

    // Submitting on the sixth character rather than on a button: the length is
    // fixed, so the moment it is complete there is nothing else to ask.
    if (next.length === PAIRING_CODE_LENGTH && zoneIndex !== BACKSPACE_INDEX) {
      this.events.onSubmit(next);
    }
  }
}
