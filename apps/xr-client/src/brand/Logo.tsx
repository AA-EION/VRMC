/**
 * The EION Studios symbol, in the `ink` variant.
 *
 * Inline rather than an `<img src="/brand/…">`, and that is not a size
 * optimisation. The `ink` variant's whole point is that it takes
 * `currentColor` — it is Sumi on Bone in light and Bone on Sumi in dark, and it
 * crosses a theme change on exactly the same curve as the text beside it. An
 * external SVG in an `<img>` cannot see the page's colour at all, so it would
 * need a fixed fill and would then be the one element that snaps while
 * everything around it eases.
 *
 * The path is the original vector from the identity kit
 * (`EION_Simbolo_Tinta.svg`), unmodified. It is never redrawn or traced.
 */

export interface LogoProps {
  /** Rendered height in CSS pixels. The viewBox carries the aspect ratio. */
  className?: string;
  title?: string;
}

export function Logo({ className, title = 'EION Studios' }: LogoProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 117.781 111.867"
      fill="none"
      role="img"
      aria-label={title}
    >
      <path
        d="M 45.359 0.000 L 0.000 96.176 L 32.504 96.176 L 25.105 111.867 L 117.781 111.867 L 72.820 15.691 L 70.465 15.691 L 66.328 24.461 L 78.078 49.531 L 78.074 49.535 L 102.973 102.387 L 40.270 102.387 L 62.824 54.762 L 77.867 86.695 L 52.637 86.695 L 47.793 96.176 L 92.676 96.176 L 47.711 0.000 Z M 46.598 20.316 L 57.434 43.320 L 36.977 86.695 L 15.164 86.695 Z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  );
}
