/**
 * EION Studios' identity, as code — edición 2026.2, «Monocromo».
 *
 * Ported from the studio's own `src/brand/tokens.ts`, which is the part of the
 * brand book a program can enforce. Nothing under `src/` should hard-code a hex
 * value, a tracking figure or a spacing number: it reads them from here, and
 * `brand.css` publishes the same constants as custom properties so the
 * stylesheet and the TypeScript cannot disagree.
 *
 * Only the part VRMC actually uses is carried over. The logo variants, the
 * clear-space ratios and the archived spectral gradient stay in the studio's
 * repository, because this app draws one mark in one variant and has no print
 * surface to reproduce.
 *
 * The identity is monochrome, and that is load-bearing rather than decorative:
 * with colour gone, tone, weight, rule and space are the only signals left, so
 * they are stated exactly instead of being chosen per component.
 */

/* ---- 01 · Paleta — dos tintas -------------------------------------------- */

/**
 * Two inks and one reserved absolute per theme. Everything else on screen is
 * one of the two at a stated percentage, which is why there is no third hex.
 *
 * `Polymer Bone` is the custom white: the midpoint between a clean bone-white
 * and a matte polymer white. Warm enough not to glare, neutral enough never to
 * read as cream.
 */
export const INK = {
  /** Background in light, text in dark. */
  bone: '#f2f0eb',
  /** Text in light, background in dark. A sharp black, not an absolute one. */
  sumi: '#0b0b0c',
} as const;

/**
 * Reserved. In the studio's own room only the galaxy's core is allowed to
 * reach an absolute; here it is the same exception for the same object — see
 * `xr/Galaxy.ts`. Page chrome never reaches these.
 */
export const ABSOLUTE = { black: '#000000', white: '#ffffff' } as const;

/**
 * The neutral ramp — every tone the identity owns between its two inks.
 *
 * Each row is Sumi mixed into Bone (light) and Bone mixed into Sumi (dark), and
 * the two mixes are deliberately *not* the same percentage. sRGB mixing is not
 * perceptually symmetric: 60 % of Sumi in Bone lands at 4.9 : 1 against the
 * light surface, while 60 % of Bone in Sumi lands at 6.5 : 1 against the dark
 * one — matching the numbers would leave the dark theme reading a full step
 * brighter all the way down. So the pair is matched on **contrast against its
 * own surface**, and the mix is whatever gets it there.
 *
 * `cr` is that contrast, identical in both themes by construction.
 */
export const RAMP = [
  { role: 'ink', use: 'body text, the mark, a solid button', light: '#0b0b0c', dark: '#f2f0eb', cr: 17.3 },
  { role: 'ink-2', use: 'secondary text, hints', light: '#4b4b4a', dark: '#a3a29f', cr: 7.7 },
  { role: 'ink-3', use: 'metadata, labels, section indices', light: '#686866', dark: '#807f7d', cr: 4.9 },
  { role: 'ink-4', use: 'ghosted: a state, never a first reading', light: '#9e9c9a', dark: '#4f4f4e', cr: 2.4 },
  { role: 'line-2', use: 'the rule when it has to be noticed', light: '#b5b4b1', dark: '#3e3d3d', cr: 1.82 },
  { role: 'line', use: 'the rule everything is divided by', light: '#cbc9c5', dark: '#2e2e2e', cr: 1.45 },
] as const;

/**
 * The surfaces. Not ramp steps: in the light theme a raised panel goes *past*
 * Bone toward white, which is off the ramp's other end entirely.
 */
export const SURFACE = {
  base: { light: '#f2f0eb', dark: '#0b0b0c' },
  raise: { light: '#f6f4f1', dark: '#171617' },
  inset: { light: '#e4e2de', dark: '#222222' },
} as const;

/* ---- 04 · Sistema tipográfico -------------------------------------------- */

/**
 * Two faces, and the manual sanctions no third.
 *
 * Inter is named first and *not* fetched. The studio's site self-hosts it; this
 * app is loaded over Wi-Fi by a headset that is about to run a 90 Hz render
 * loop, and a webfont is one more thing standing between a cold start and a
 * playable instrument. Where Inter is already installed it is used; where it is
 * not, the system's UI face is close enough for a settings panel, and the
 * hierarchy below survives the substitution because it is carried by weight,
 * tracking and space rather than by the shapes themselves.
 */
export const FONT = {
  text: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Ceremonial only: the 永音 seal. */
  jp: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif",
  /** Not a brand face. Numbers that have to line up — latency, counts, codes. */
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/**
 * The hierarchy. With colour gone this table *is* the hierarchy, so the numbers
 * are stated rather than chosen per component. `track` is in em; the manual
 * writes tracking in Illustrator's 1/1000 em, so «+220» divides by 1000.
 */
export const TYPE = {
  display: { weight: 300, track: -0.02, leading: 1.0 },
  titular: { weight: 400, track: 0.0, leading: 1.08 },
  eyebrow: { weight: 500, track: 0.22, transform: 'uppercase' },
  cuerpo: { weight: 400, track: 0, leading: 1.7 },
  dato: { weight: 400, track: 0.04, numeric: 'tabular-nums' },
} as const;

/* ---- 05 · Retícula y ritmo ----------------------------------------------- */

/** 4 px base unit. Every margin, gap and pad is a multiple of it. */
export const SPACE = { base: 4, scale: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192] } as const;

/**
 * Corner radius. 2026.2 removes the bubble: panels are cut, not rounded.
 * `hair` is the only radius allowed, and it exists so a 1 px rule does not look
 * chipped at its corners — not to soften anything.
 */
export const RADIUS = { none: 0, hair: 2 } as const;

/** Rules are hairlines. There is no second border weight. */
export const RULE = { hairline: 1 } as const;

/* ---- 06 · Tema ----------------------------------------------------------- */

/**
 * How long a theme change takes, and on what curve. Long and near-linear on
 * purpose: the eye should register that the page has changed state, never that
 * something happened *to* it.
 */
export const THEME_TRANSITION = { ms: 720, ease: 'cubic-bezier(0.32, 0.08, 0.24, 1)' } as const;

/* ---- 07 · Elementos gráficos --------------------------------------------- */

/** The seal. Never translated, never replaced by its romanisation. */
export const SEAL = '永音';
