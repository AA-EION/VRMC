// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, LinearFilter, SRGBColorSpace, DoubleSide, MeshBasicMaterial } from 'three';
import { PAIRING_CODE_LENGTH, formatPairingCode } from '@vrmc/protocol';
import { localToWorld, surfaceTransform, type SurfacePose } from '@vrmc/layout';
import { InstrumentSurface, type SurfaceHighlighter } from '../devices/InstrumentSurface.js';
import type { KeypadLayout } from './KeypadLayout.js';
import type { SurfaceTheme } from '../devices/InstrumentSurface.js';

/**
 * The pairing keypad, rendered inside the immersive session.
 *
 * Without this, a user who enters XR before connecting has to take the headset
 * off, type six characters on a page they can no longer see, and put it back
 * on — which is exactly the kind of thing this project exists not to make
 * people do. The panel floats in front of them and is poked with a finger,
 * using the same detector that plays the instruments.
 */

export const KEYPAD_THEME: SurfaceTheme = {
  idle: '#243050',
  // Backspace, marked as an accidental so it reads as the odd one out.
  idleAccidental: '#3a2030',
  active: '#63e0ff',
  plate: '#080b13',
};

/**
 * Where the panel floats.
 *
 * Nearer the player than any instrument and higher than all of them. It has to
 * be, for two reasons: it must not intersect the pad grid or the keyboard,
 * which sit at z = -0.58 and -0.36; and it is read before it is touched, so it
 * belongs at something closer to eye level than a surface you play.
 */
export const KEYPAD_POSE: SurfacePose = { centre: [0, 1.18, -0.26], tiltDeg: 50 };

export interface ConnectPanelProps {
  layout: KeypadLayout;
  highlighter: SurfaceHighlighter;
  /** Characters entered so far. */
  code: string;
  /** What the panel should say above the keys. */
  message: string;
  /** True while a connection attempt is in flight. */
  busy: boolean;
}

/**
 * Draw the readout above the keypad.
 *
 * A canvas texture rather than text geometry, for the same reason the key
 * labels are: glyph meshes would mean a font load and dozens of draw calls in
 * a scene that has to hold 90 fps on a mobile GPU.
 *
 * Redrawn only when the code or the message changes — a few times per session,
 * at the speed a person types — so it never touches the frame path.
 */
function drawReadout(code: string, message: string, busy: boolean): CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  // Tall enough for a message under the slots. At 320 the error line sat on
  // the panel's own border and was clipped by it.
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  ctx.fillStyle = '#080b13';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#2b3350';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#7b86a8';
  ctx.font = '600 44px system-ui, -apple-system, sans-serif';
  ctx.fillText('Enter the code from the VRMC app', canvas.width / 2, 56);

  // Slots rather than a bare string: six boxes show how many characters are
  // wanted, which is the question people actually have while typing a code.
  const slotW = 108;
  const slotGap = 18;
  const totalW = PAIRING_CODE_LENGTH * slotW + (PAIRING_CODE_LENGTH - 1) * slotGap;
  const startX = (canvas.width - totalW) / 2;
  const slotY = 104;
  const slotH = 136;

  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const x = startX + i * (slotW + slotGap);
    const filled = i < code.length;
    ctx.fillStyle = filled ? '#131a2b' : '#0d111c';
    ctx.fillRect(x, slotY, slotW, slotH);
    // The next slot is outlined in the accent colour, so there is never any
    // doubt about where the next character will land.
    ctx.strokeStyle = i === code.length && !busy ? '#63e0ff' : '#2b3350';
    ctx.lineWidth = i === code.length && !busy ? 5 : 3;
    ctx.strokeRect(x, slotY, slotW, slotH);

    if (filled) {
      ctx.fillStyle = '#eef1f6';
      ctx.font = '700 76px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(code[i]!, x + slotW / 2, slotY + slotH / 2 + 4);
    }
  }

  if (message !== '') {
    ctx.fillStyle = busy ? '#63e0ff' : '#ffb0a0';
    ctx.font = '500 36px system-ui, -apple-system, sans-serif';
    // Clipped rather than wrapped: a second line would change the panel's
    // height every time a message appeared, moving the keys under the user's
    // hand mid-reach.
    ctx.fillText(clip(ctx, message, canvas.width - 80), canvas.width / 2, 320);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/** Trim text with an ellipsis so it fits `maxWidth`. */
function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export function ConnectPanel({
  layout,
  highlighter,
  code,
  message,
  busy,
}: ConnectPanelProps): React.ReactElement {
  const transform = useMemo(() => surfaceTransform(layout, KEYPAD_POSE), [layout]);

  const readout = useMemo(() => drawReadout(code, message, busy), [code, message, busy]);
  const readoutRef = useRef<CanvasTexture | null>(null);

  // The previous texture holds a canvas and a GPU allocation; typing six
  // characters would otherwise leave six of each behind.
  useEffect(() => {
    const previous = readoutRef.current;
    readoutRef.current = readout;
    return () => {
      previous?.dispose();
    };
  }, [readout]);
  useEffect(() => () => readoutRef.current?.dispose(), []);

  const readoutMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        map: readout,
        transparent: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    [readout],
  );
  useEffect(() => () => readoutMaterial.dispose(), [readoutMaterial]);

  // The readout sits above the keys in the surface's own frame, so it tilts
  // with them and stays square to the player at any angle.
  const readoutHeight = layout.width * (400 / 1024);
  const readoutCentre = localToWorld(
    transform,
    layout.width / 2,
    layout.height + 0.012 + readoutHeight / 2,
    0.001,
  );

  return (
    <>
      <InstrumentSurface
        locator={layout}
        theme={KEYPAD_THEME}
        highlighter={highlighter}
        position={transform.origin}
        quaternion={transform.quaternion}
      />
      {readout !== null && (
        <mesh
          position={readoutCentre}
          quaternion={transform.quaternion}
          material={readoutMaterial}
        >
          <planeGeometry args={[layout.width, readoutHeight]} />
        </mesh>
      )}
    </>
  );
}

/** The formatted code, for the panel's message line. */
export function displayCode(code: string): string {
  return code.length === PAIRING_CODE_LENGTH ? formatPairingCode(code) : code;
}
