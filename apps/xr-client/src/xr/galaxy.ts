/**
 * The room behind the instruments — EION Studios' galaxy, in a headset.
 *
 * Ported from the studio's own `src/components/Galaxy.tsx`: three GPU point
 * clouds, one draw call each, no textures and no post-processing. Everything
 * that moves does so inside the vertex shader, so the CPU cost per frame is a
 * handful of uniform writes — which is the only reason this can share a frame
 * with hand tracking and note dispatch at 90 Hz.
 *
 * The geometry is built once at startup from a deterministic PRNG, so the
 * galaxy is the same one every session rather than a new sky each time you put
 * the headset on.
 *
 * WHY THE INK IS AN ABSOLUTE
 * The identity reserves Absolute Black and Absolute White for exactly one
 * element — the galaxy's core — and nothing else may reach them. That is why
 * the colour is carried here as a raw sRGB triple and never as a `Color`:
 * three's colour management would take it into linear space on the way to the
 * shader, and 0 and 1 have to leave as 0 and 1.
 *
 * This module deliberately imports nothing. It is arithmetic and shader source,
 * so it can be tested without a GL context — see test/galaxy.test.ts.
 */

/** The two absolutes, as raw sRGB. Index by the resolved theme. */
export const GALAXY_INK: Record<'light' | 'dark', readonly [number, number, number]> = {
  /** Absolute Black over Polymer Bone. */
  light: [0, 0, 0],
  /** Absolute White over Sumi Black. */
  dark: [1, 1, 1],
};

/**
 * How far the ink may go where it is thickest. 0.96 rather than 1: the core
 * still resolves to the absolute once a few particles overlap, and the number
 * is really a ceiling on the *arms*, which are what the instruments have to
 * stay readable against.
 */
export const MAX_DENSITY = 0.96;

/** How far the disc reaches, in metres. */
export const DISC_RADIUS = 9;

/**
 * The particle budget.
 *
 * Deliberately below what the studio's own room spends (32 000 disc particles),
 * and the difference is not caution — it is that the two scenes are paying for
 * different things. There, the galaxy is the frame's only real work. Here it
 * shares 11 ms with ten fingertips being read, four poke detectors, a packet
 * being written and up to a hundred and sixty instanced pads, and it is the
 * only one of those that can be made cheaper without the instrument getting
 * worse. Points are fill-rate, and fill-rate is what a standalone GPU runs out
 * of first when it is drawing everything twice.
 *
 * The nebula is cut outright rather than reduced. It is a *halo* — the grey
 * between the disc and the page when both are seen from outside — and from
 * inside the cloud there is no «between»: several hundred blobs tens of pixels
 * across, drawn twice a frame, buy nothing anybody can see.
 */
export const BUDGET = { disc: 18000, field: 1200, motes: 900 } as const;

/** Both hands of the shader need this; stated once. */
export const POINT_SIZE_CAP = 72;

/* ---- the clouds ---------------------------------------------------------- */

export interface Cloud {
  position: Float32Array;
  density: Float32Array;
  scale: Float32Array;
  seed: Float32Array;
}

/**
 * Deterministic PRNG — a linear congruential generator, seeded per cloud.
 *
 * `Math.random()` would give a different galaxy on every entry, which sounds
 * harmless and is not: the room is a fixed backdrop a player positions
 * instruments against, and one that reshuffles itself every session is a room they
 * never learn.
 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function empty(count: number): Cloud {
  return {
    position: new Float32Array(count * 3),
    density: new Float32Array(count),
    scale: new Float32Array(count),
    seed: new Float32Array(count),
  };
}

/** The spiral disc: solid ink at the core, thinning to grey and then to nothing. */
export function buildDisc(count: number = BUDGET.disc): Cloud {
  const rand = rng(0x1e04);
  const out = empty(count);
  const BRANCHES = 5;
  const SPIN = 1.05;

  for (let i = 0; i < count; i++) {
    // ^1.8 packs particles toward the centre — a real bulge, not a ring.
    const t = Math.pow(rand(), 1.8);
    const r = t * DISC_RADIUS;
    const branch = ((i % BRANCHES) / BRANCHES) * Math.PI * 2;
    const spin = r * SPIN;
    // Scatter grows with radius, so the arms fray at their edges.
    const spread = 0.22 + r * 0.13;
    const jitter = (): number => Math.pow(rand(), 2.6) * (rand() < 0.5 ? 1 : -1) * spread;

    out.position[i * 3] = Math.cos(branch + spin) * r + jitter();
    // The disc is thin, and thinnest far out.
    out.position[i * 3 + 1] = jitter() * 0.55 * (1 / (1 + r * 0.3));
    out.position[i * 3 + 2] = Math.sin(branch + spin) * r + jitter();

    // The manual's ramp, read from the inside out: full ink at the core, half
    // by the middle of the arms, almost nothing at the rim. ^1.35 keeps the
    // fall gentle enough that the greys between are a gradient, not a boundary.
    out.density[i] = Math.max(0.03, 1 - Math.pow(t, 1.35) * 0.97);
    out.scale[i] = (0.35 + rand() * 0.9) * (1 + (1 - t) * 1.6);
    out.seed[i] = rand();
  }
  return out;
}

/** The rest of the universe — a cold shell of distant specks. */
export function buildField(count: number = BUDGET.field): Cloud {
  const rand = rng(0x5c0d);
  const out = empty(count);

  for (let i = 0; i < count; i++) {
    // Uniform on a sphere.
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const k = Math.sqrt(1 - u * u);
    const r = 26 + Math.pow(rand(), 0.6) * 34;
    out.position[i * 3] = k * Math.cos(th) * r;
    out.position[i * 3 + 1] = u * r * 0.7;
    out.position[i * 3 + 2] = k * Math.sin(th) * r;
    out.density[i] = 0.18 + rand() * 0.4;
    out.scale[i] = 0.9 + rand() * 2.4;
    out.seed[i] = rand();
  }
  return out;
}

/**
 * The air in the room — motes on a shell around the player.
 *
 * A room is not an empty void; it has air in it, and dust is how you know a
 * space is a space rather than a backdrop. These are pushed out past arm's
 * reach on purpose: a mote between an eye and a pad, at a distance the eye can
 * actually focus on, is a speck on the instrument.
 */
export function buildMotes(count: number = BUDGET.motes): Cloud {
  const rand = rng(0x3f11);
  const out = empty(count);

  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const k = Math.sqrt(1 - u * u);
    // Nothing nearer than 2.8 m; the furthest instrument sits at 0.6 m.
    const r = 2.8 + Math.pow(rand(), 0.7) * 15;

    out.position[i * 3] = k * Math.cos(th) * r;
    // Flattened: a room has a floor and a ceiling, and a spherical fill reads
    // as being inside a ball rather than inside a room.
    out.position[i * 3 + 1] = u * r * 0.4;
    out.position[i * 3 + 2] = k * Math.sin(th) * r;

    out.density[i] = 0.09 + (r / 18) * 0.11;
    out.scale[i] = 0.9 + rand() * 2;
    out.seed[i] = rand();
  }
  return out;
}

/* ---- the shader ---------------------------------------------------------- */

/**
 * `uSize` is half the drawing buffer's height times the point's world size.
 *
 * The projection term is applied inside the shader rather than folded into the
 * uniform, and in a headset that is not a nicety: there are two projections per
 * frame, one per eye, with their own asymmetric frusta, and neither of them is
 * the one any CPU-side calibration was done against. Folding the projection in
 * would size every point for a camera that is not drawing it.
 */
export const GALAXY_VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uSpin;
uniform float uTwinkle;

attribute float aDensity;
attribute float aScale;
attribute float aSeed;

varying float vDensity;

void main() {
  vec3 pos = position;

  // Differential rotation — the core turns faster than the rim, which is what
  // makes a disc read as a galaxy rather than as a spinning decal.
  float r = length(pos.xz);
  float a = uTime * uSpin / (0.55 + r * 0.30);
  float s = sin(a), c = cos(a);
  pos.xz = mat2(c, -s, s, c) * pos.xz;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 1.0 - uTwinkle + uTwinkle * (0.5 + 0.5 * sin(uTime * 1.7 + aSeed * 47.0));

  gl_PointSize = clamp(
    uSize * projectionMatrix[1][1] * aScale * tw / max(-mv.z, 0.001), 0.0, ${POINT_SIZE_CAP}.0);

  vDensity = aDensity;
}
`;

/**
 * Premultiplied «over».
 *
 * `uInk` is the flat ink and `uMax` is the ceiling the densest part of the core
 * may reach. The fragment multiplies the colour by its own alpha, so three is
 * set to (ONE, ONE_MINUS_SRC_ALPHA) — the correct «over» operator, and the one
 * the compositor then uses again on the way to the passthrough cameras.
 *
 * Because every particle carries the same colour, «over» is order-independent
 * here: stacking n layers of one ink does not depend on the order they stack
 * in. That is what lets depth sorting stay off and each cloud stay one draw.
 */
export const GALAXY_FRAG = /* glsl */ `
precision mediump float;
uniform vec3  uInk;
uniform float uMax;
uniform float uFade;
varying float vDensity;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);              // squared — avoids the sqrt
  if (r > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r);
  a *= a;                           // tight core, soft falloff
  a *= vDensity * uMax * uFade;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(uInk * a, a); // premultiplied — see the material
}
`;

/**
 * Turn a point size calibrated against one field of view into a world size the
 * shader can apply either eye's projection to.
 *
 * The studio's numbers were tuned against its flat camera at 55°. Dividing that
 * calibration back out leaves a figure with no projection baked into it.
 */
export const CALIBRATION_FOV = 55;

export function worldPointSize(sizeFactor: number, sizeScale = 1): number {
  return (sizeFactor * sizeScale * 2) / (1 / Math.tan((CALIBRATION_FOV * Math.PI) / 360));
}

/** Per-cloud shader constants, as the studio calibrated them. */
export const CLOUD_STYLE = {
  disc: { sizeFactor: 0.0135, spin: 0.075, twinkle: 0.12 },
  field: { sizeFactor: 0.0115, spin: 0.006, twinkle: 0.3 },
  motes: { sizeFactor: 0.0135, spin: 0.008, twinkle: 0.35 },
} as const;

/**
 * Where the galaxy sits relative to the player, and this is the studio's own
 * number rather than a chosen one.
 *
 * The disc is authored in the XZ plane, so it is already flat and «laying it
 * down» is the absence of a rotation rather than a second galaxy. What matters
 * is that it goes well *below* the player rather than at their feet: standing
 * in the plane of a galaxy and standing above one are different pictures, and
 * only the second reads as big. Further down and further out is what distance
 * does.
 *
 * `spread` moves the particles apart without touching their size — the group is
 * scaled, so `sizeScale` puts back the apparent size that the extra distance
 * takes away. The particle count is fixed, so spreading thins the cloud by the
 * square; past about 2.5 the arms stop being ink and start being speckle.
 *
 * The far field is deliberately *not* spread. At 2.1 its shell would reach 126
 * metres and the camera's far plane is 100, which does not dim it — it clips
 * it, entirely, in the projection.
 */
export const PLACEMENT = {
  /** Metres below the standing surface. */
  y: -2.4,
  /** Off the room's own axes, so it never reads as having been aligned to one. */
  tilt: -0.06,
  disc: { spread: 2.1, sizeScale: 1.45 },
} as const;
