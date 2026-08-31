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
  options: { pixelsPerMetre?: number; color?: string; accidentalColor?: string } = {},
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
    // Canvas Y grows downward; the surface's Y grows upward.
    const cyMetres = zone.rect.y + zone.rect.height * (zone.accidental ? 0.5 : 0.12);
    const cy = canvas.height - (cyMetres / locator.height) * canvas.height;

    ctx.fillStyle = zone.accidental
      ? (options.accidentalColor ?? 'rgba(255,255,255,0.72)')
      : (options.color ?? 'rgba(20,22,28,0.68)');
    ctx.fillText(zone.label, cx, cy);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  return texture;
}
