import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { ZoneLocator } from '@vrmc/layout';

/**
 * Render a surface's zone labels into a single canvas texture.
 *
 * One texture for the whole panel rather than a text mesh per key: text
 * geometry would mean loading a font, building glyph meshes, and adding dozens
 * of draw calls to a scene that has to hold 90 fps on a mobile GPU. A canvas
 * drawn once at startup costs one texture and no per-frame work at all.
 */
export function buildLabelTexture(
  locator: ZoneLocator,
  options: { pixelsPerMetre?: number; idle?: string; idleAccidental?: string } = {},
): CanvasTexture | null {
  const ppm = options.pixelsPerMetre ?? 2048;
  const width = Math.ceil(locator.width * ppm);
  const height = Math.ceil(locator.height * ppm);
  if (width <= 0 || height <= 0) return null;

  const canvas = document.createElement('canvas');
  // Cap the texture so a 61-key layout cannot ask for something the GPU refuses.
  const scale = Math.min(1, 2048 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const fontPx = Math.max(10, Math.round(canvas.height * 0.055));
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, sans-serif`;

  for (const zone of locator.zones) {
    const cx = ((zone.rect.x + zone.rect.width / 2) / locator.width) * canvas.width;
    // Where the label sits along the zone, as a fraction from its near edge.
    //
    // A roughly square zone is a pad, and its label belongs in the middle. A
    // tall narrow one is a piano key, where the far end is under the player's
    // hand and only the front strip is ever visible — so the label goes there.
    const aspect = zone.rect.width / zone.rect.height;
    const anchor = aspect > 0.7 && aspect < 1.4 ? 0.5 : zone.accidental ? 0.5 : 0.12;
    // Canvas Y grows downward; the surface's Y grows upward.
    const cyMetres = zone.rect.y + zone.rect.height * anchor;
    const cy = canvas.height - (cyMetres / locator.height) * canvas.height;

    // Pick the ink from the surface it sits on. A fixed colour only works for
    // one theme: dark text is invisible on the pad grid's navy, and light text
    // vanishes on a white key.
    const surface = zone.accidental
      ? (options.idleAccidental ?? '#161a28')
      : (options.idle ?? '#eef1f6');
    ctx.fillStyle = isLight(surface) ? 'rgba(18,20,26,0.70)' : 'rgba(255,255,255,0.78)';
    ctx.fillText(zone.label, cx, cy);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Relative luminance of a `#rrggbb` colour, thresholded.
 *
 * Rec. 709 coefficients rather than a plain mean: the eye is far more sensitive
 * to green than to blue, and averaging would call the pad grid's navy lighter
 * than it looks.
 */
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return true;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}


/**
 * Render one line of text into a canvas texture, for a floating label.
 *
 * The same reasoning as the zone labels above: a canvas drawn once when the
 * text changes costs one texture and no per-frame work, where glyph meshes
 * would mean a font load and a pile of draw calls in a scene that has to hold
 * 90 fps on a mobile GPU. Text arrives when somebody changes a view in their
 * DAW, which is human speed.
 */
export function buildTextTexture(
  text: string,
  options: { ink?: string; ground?: string } = {},
): CanvasTexture | null {
  if (text === '') return null;
  const canvas = document.createElement('canvas');
  // Fixed height, width from the text: a label is as wide as its words and the
  // mesh is scaled to match, so glyphs never stretch.
  const height = 128;
  const fontPx = Math.round(height * 0.52);
  const ctx0 = canvas.getContext('2d');
  if (ctx0 === null) return null;
  const font = `500 ${fontPx}px Inter, system-ui, -apple-system, sans-serif`;
  ctx0.font = font;
  const padding = fontPx * 0.7;
  canvas.width = Math.min(2048, Math.ceil(ctx0.measureText(text).width + padding * 2));
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  // Re-set: resizing the canvas resets every context property.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = options.ground ?? 'rgba(11, 11, 12, 0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // The identity's hairline, at this scale.
  ctx.strokeStyle = options.ink ?? '#f2f0eb';
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.globalAlpha = 1;

  ctx.fillStyle = options.ink ?? '#f2f0eb';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.04);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  return texture;
}
