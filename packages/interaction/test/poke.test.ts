import { describe, it, expect, beforeEach } from 'vitest';
import { KeyboardLayout, LAUNCHKEY_25, MPC_4X4, PadGridLayout } from '@vrmc/layout';
import { EventFlags } from '@vrmc/protocol';
import { Finger, FingerFrame, PokeDetector, type NoteSink } from '../src/index.js';

interface OnEvent { kind: 'on'; zone: number; note: number; velocity: number; tOffsetMs: number; flags: number }
interface OffEvent { kind: 'off'; zone: number; note: number }
interface AtEvent { kind: 'at'; zone: number; note: number; pressure: number }
type Rec = OnEvent | OffEvent | AtEvent;

/** Test-only recorder. The real sink writes straight into a packet. */
class Recorder implements NoteSink {
  events: Rec[] = [];
  noteOn(zone: number, note: number, velocity: number, tOffsetMs: number, flags: number): void {
    this.events.push({ kind: 'on', zone, note, velocity, tOffsetMs, flags });
  }
  noteOff(zone: number, note: number): void {
    this.events.push({ kind: 'off', zone, note });
  }
  aftertouch(zone: number, note: number, pressure: number): void {
    this.events.push({ kind: 'at', zone, note, pressure });
  }
  get ons(): OnEvent[] { return this.events.filter((e): e is OnEvent => e.kind === 'on'); }
  get offs(): OffEvent[] { return this.events.filter((e): e is OffEvent => e.kind === 'off'); }
  get pressures(): AtEvent[] { return this.events.filter((e): e is AtEvent => e.kind === 'at'); }
  clear(): void { this.events = []; }
}

const FRAME_DT = 1 / 90; // Quest 3 runs hand tracking at 90 Hz.
const RADIUS = 0.008;

/** Drives one fingertip through a sequence of world-space positions. */
class Rig {
  readonly frame = new FingerFrame();
  readonly sink = new Recorder();
  private t = 1000;

  constructor(readonly detector: PokeDetector) {}

  /** Step one frame with the finger at a world position. */
  step(x: number, y: number, z: number, finger: number = Finger.RIGHT_INDEX, dt = FRAME_DT): void {
    this.t += dt * 1000;
    this.frame.beginFrame(this.t, dt);
    this.frame.setFinger(finger, x, y, z, RADIUS);
    this.detector.update(this.frame, this.sink);
  }

  /** Step one frame with no hands tracked at all. */
  stepUntracked(dt = FRAME_DT): void {
    this.t += dt * 1000;
    this.frame.beginFrame(this.t, dt);
    this.detector.update(this.frame, this.sink);
  }

  /** Move the finger from z=`from` to z=`to` over `frames` steps. */
  sweepZ(x: number, y: number, from: number, to: number, frames: number, finger?: number): void {
    for (let i = 1; i <= frames; i++) {
      this.step(x, y, from + ((to - from) * i) / frames, finger);
    }
  }
}

/** Surface-local z that puts the fingertip exactly `depth` above a zone's face. */
function zForDepth(raise: number, depth: number): number {
  return raise + RADIUS + depth;
}

describe('PokeDetector on a pad grid', () => {
  const grid = new PadGridLayout(MPC_4X4);
  const pad0 = grid.zones[0]!;
  const cx = pad0.rect.x + pad0.rect.width / 2;
  const cy = pad0.rect.y + pad0.rect.height / 2;
  const raise = pad0.raise;

  let detector: PokeDetector;
  let rig: Rig;

  beforeEach(() => {
    detector = new PokeDetector(grid);
    detector.setPose(0, 0, 0, 0, 0, 0, 1); // identity: local === world
    rig = new Rig(detector);
  });

  it('fires note on when a finger crosses the pad face, and off when it leaves', () => {
    rig.sweepZ(cx, cy, zForDepth(raise, 0.05), zForDepth(raise, -0.005), 6);
    expect(rig.sink.ons).toHaveLength(1);
    expect(rig.sink.ons[0]!.note).toBe(36);
    expect(rig.sink.ons[0]!.zone).toBe(0);

    rig.sweepZ(cx, cy, zForDepth(raise, -0.005), zForDepth(raise, 0.05), 6);
    expect(rig.sink.offs).toHaveLength(1);
    expect(rig.sink.offs[0]!.note).toBe(36);
  });

  it('scales velocity with strike speed', () => {
    // Slow approach: 5 cm over 12 frames.
    rig.sweepZ(cx, cy, zForDepth(raise, 0.05), zForDepth(raise, -0.004), 12);
    const slow = rig.sink.ons[0]!.velocity;
    rig.sink.clear();

    detector.releaseAll(rig.sink);
    rig.sink.clear();
    // Fast approach: same distance in 2 frames.
    rig.step(cx, cy, zForDepth(raise, 0.08));
    rig.sweepZ(cx, cy, zForDepth(raise, 0.05), zForDepth(raise, -0.004), 2);
    const fast = rig.sink.ons[0]!.velocity;

    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThanOrEqual(1);
    expect(fast).toBeLessThanOrEqual(127);
  });

  it('does not retrigger on tracking jitter around the surface plane', () => {
    rig.sweepZ(cx, cy, zForDepth(raise, 0.03), zForDepth(raise, -0.001), 5);
    expect(rig.sink.ons).toHaveLength(1);
    rig.sink.clear();

    // Dither by +/-1 mm across the plane, as a still hand does.
    for (let i = 0; i < 40; i++) {
      const jitter = i % 2 === 0 ? 0.001 : -0.001;
      rig.step(cx, cy, zForDepth(raise, jitter));
    }
    expect(rig.sink.ons).toHaveLength(0);
    expect(rig.sink.offs).toHaveLength(0);
  });

  it('releases a held note when hand tracking drops out', () => {
    rig.sweepZ(cx, cy, zForDepth(raise, 0.03), zForDepth(raise, -0.004), 5);
    expect(rig.sink.ons).toHaveLength(1);
    rig.sink.clear();

    rig.stepUntracked();
    expect(rig.sink.offs).toHaveLength(1);
    expect(rig.sink.offs[0]!.note).toBe(36);
  });

  it('releases a held note when the finger slides off the surface entirely', () => {
    rig.sweepZ(cx, cy, zForDepth(raise, 0.03), zForDepth(raise, -0.004), 5);
    rig.sink.clear();
    rig.step(grid.width + 0.05, cy, zForDepth(raise, -0.004));
    expect(rig.sink.offs).toHaveLength(1);
  });

  it('honours the refractory window between strikes on one pad', () => {
    const d = new PokeDetector(grid, { refractoryMs: 100 });
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const r = new Rig(d);
    r.sweepZ(cx, cy, zForDepth(raise, 0.02), zForDepth(raise, -0.004), 3);
    expect(r.sink.ons).toHaveLength(1);
    // Bounce straight back out and in again, well inside 100 ms.
    r.sweepZ(cx, cy, zForDepth(raise, -0.004), zForDepth(raise, 0.02), 3);
    r.sweepZ(cx, cy, zForDepth(raise, 0.02), zForDepth(raise, -0.004), 3);
    expect(r.sink.ons).toHaveLength(1);
  });

  it('reports a sub-frame timing offset within the frame it fired', () => {
    rig.sweepZ(cx, cy, zForDepth(raise, 0.04), zForDepth(raise, -0.004), 5);
    const on = rig.sink.ons[0]!;
    expect(on.tOffsetMs).toBeGreaterThanOrEqual(0);
    expect(on.tOffsetMs).toBeLessThanOrEqual(FRAME_DT * 1000);
  });

  it('flags velocity as estimated when the frame hitches', () => {
    // A 200 ms frame: the finite difference across it is meaningless.
    rig.step(cx, cy, zForDepth(raise, 0.04), Finger.RIGHT_INDEX, 0.2);
    rig.step(cx, cy, zForDepth(raise, -0.004), Finger.RIGHT_INDEX, 0.2);
    const on = rig.sink.ons[0];
    expect(on).toBeDefined();
    expect(on!.flags & EventFlags.ESTIMATED_VELOCITY).toBeTruthy();
  });

  it('tracks two fingers on two pads independently', () => {
    const pad5 = grid.zones[5]!;
    const bx = pad5.rect.x + pad5.rect.width / 2;
    const by = pad5.rect.y + pad5.rect.height / 2;

    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      const z = zForDepth(raise, 0.03 - 0.034 * t);
      rig.frame.beginFrame(2000 + i * FRAME_DT * 1000, FRAME_DT);
      rig.frame.setFinger(Finger.RIGHT_INDEX, cx, cy, z, RADIUS);
      rig.frame.setFinger(Finger.LEFT_INDEX, bx, by, z, RADIUS);
      detector.update(rig.frame, rig.sink);
    }
    const notes = rig.sink.ons.map((e) => e.note).sort((a, b) => a - b);
    expect(notes).toEqual([36, 41]);
  });

  it('emits nothing while the finger hovers without breaking the plane', () => {
    for (let i = 0; i < 20; i++) rig.step(cx, cy, zForDepth(raise, 0.01));
    expect(rig.sink.events).toHaveLength(0);
  });

  it('ignores a poke landing in the gutter between pads', () => {
    const gutterX = MPC_4X4.padSize + MPC_4X4.gap / 2;
    rig.sweepZ(gutterX, cy, zForDepth(raise, 0.03), zForDepth(raise, -0.004), 5);
    expect(rig.sink.ons).toHaveLength(0);
  });

  it('releaseAll clears every held note', () => {
    rig.sweepZ(cx, cy, zForDepth(raise, 0.03), zForDepth(raise, -0.004), 5);
    rig.sink.clear();
    detector.releaseAll(rig.sink);
    expect(rig.sink.offs).toHaveLength(1);
    // Idempotent: a second call has nothing left to release.
    rig.sink.clear();
    detector.releaseAll(rig.sink);
    expect(rig.sink.offs).toHaveLength(0);
  });
});

describe('PokeDetector aftertouch', () => {
  const grid = new PadGridLayout(MPC_4X4);
  const pad0 = grid.zones[0]!;
  const cx = pad0.rect.x + pad0.rect.width / 2;
  const cy = pad0.rect.y + pad0.rect.height / 2;

  it('rises with sustained depth and does not repeat an unchanged value', () => {
    const d = new PokeDetector(grid, { aftertouchInterval: 1 });
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const rig = new Rig(d);
    rig.sweepZ(cx, cy, zForDepth(pad0.raise, 0.02), zForDepth(pad0.raise, -0.002), 4);
    rig.sink.clear();

    rig.step(cx, cy, zForDepth(pad0.raise, -0.010));
    rig.step(cx, cy, zForDepth(pad0.raise, -0.018));
    const rising = rig.sink.pressures;
    expect(rising.length).toBeGreaterThanOrEqual(2);
    expect(rising[rising.length - 1]!.pressure).toBeGreaterThan(rising[0]!.pressure);

    // Holding perfectly still must not keep sending the same value.
    rig.sink.clear();
    for (let i = 0; i < 10; i++) rig.step(cx, cy, zForDepth(pad0.raise, -0.018));
    expect(rig.sink.pressures).toHaveLength(0);
  });

  it('can be switched off entirely', () => {
    const d = new PokeDetector(grid, { aftertouchInterval: 0 });
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const rig = new Rig(d);
    rig.sweepZ(cx, cy, zForDepth(pad0.raise, 0.02), zForDepth(pad0.raise, -0.02), 6);
    expect(rig.sink.pressures).toHaveLength(0);
  });
});

describe('PokeDetector on a keyboard', () => {
  const kb = new KeyboardLayout(LAUNCHKEY_25);

  it('plays a glissando across white keys when a pressed finger slides', () => {
    const d = new PokeDetector(kb, { glissando: true });
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const rig = new Rig(d);

    const c = kb.zones[0]!; // C2, a white key
    const y = 0.02; // in front of the black-key band
    const z = zForDepth(c.raise, -0.003);
    rig.step(c.rect.x + 0.005, y, zForDepth(c.raise, 0.02));
    rig.step(c.rect.x + 0.005, y, z);
    expect(rig.sink.ons.map((e) => e.note)).toEqual([48]);

    // Slide right across the next three white keys while staying pressed.
    for (const zone of [kb.zones[2]!, kb.zones[4]!, kb.zones[5]!]) {
      rig.step(zone.rect.x + zone.rect.width / 2, y, z);
    }
    expect(rig.sink.ons.map((e) => e.note)).toEqual([48, 50, 52, 53]);
    // Each new note is preceded by a release of the previous one.
    expect(rig.sink.offs.map((e) => e.note)).toEqual([48, 50, 52]);
  });

  it('does not retrigger while sliding when glissando is off', () => {
    const d = new PokeDetector(kb, { glissando: false });
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const rig = new Rig(d);
    const c = kb.zones[0]!;
    const y = 0.02;
    const z = zForDepth(c.raise, -0.003);
    rig.step(c.rect.x + 0.005, y, zForDepth(c.raise, 0.02));
    rig.step(c.rect.x + 0.005, y, z);
    rig.step(kb.zones[2]!.rect.x + 0.005, y, z);
    expect(rig.sink.ons.map((e) => e.note)).toEqual([48]);
    expect(rig.sink.offs.map((e) => e.note)).toEqual([48]);
  });

  it('hits the black key rather than the white one beneath it', () => {
    const d = new PokeDetector(kb);
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const rig = new Rig(d);
    const cSharp = kb.zones[1]!;
    const x = cSharp.rect.x + cSharp.rect.width / 2;
    const y = cSharp.rect.y + cSharp.rect.height / 2;
    rig.sweepZ(x, y, zForDepth(cSharp.raise, 0.03), zForDepth(cSharp.raise, -0.003), 5);
    expect(rig.sink.ons).toHaveLength(1);
    expect(rig.sink.ons[0]!.note).toBe(49);
  });
});

describe('PokeDetector surface pose', () => {
  const grid = new PadGridLayout(MPC_4X4);
  const pad0 = grid.zones[0]!;
  const lx = pad0.rect.x + pad0.rect.width / 2;
  const ly = pad0.rect.y + pad0.rect.height / 2;

  it('transforms world positions through a translated and rotated surface', () => {
    // Rotate 90 deg about Y: surface +Z (its outward normal) now points along
    // world -X, and surface +X points along world +Z.
    const s = Math.SQRT1_2;
    const d = new PokeDetector(grid);
    d.setPose(1, 1.2, -0.5, 0, s, 0, s);
    const rig = new Rig(d);

    // Build the world point for a given surface-local point by hand:
    //   world = pose + R * local,  R = rotY(90deg)
    //   R * (x,y,z) = (z, y, -x)
    const toWorld = (x: number, y: number, z: number): [number, number, number] => [
      1 + z,
      1.2 + y,
      -0.5 - x,
    ];

    for (let i = 1; i <= 5; i++) {
      const depth = 0.03 - 0.034 * (i / 5);
      const [wx, wy, wz] = toWorld(lx, ly, zForDepth(pad0.raise, depth));
      rig.step(wx, wy, wz);
    }
    expect(rig.sink.ons).toHaveLength(1);
    expect(rig.sink.ons[0]!.note).toBe(36);
  });

  it('does not fire for a point that is only correct before the transform', () => {
    const s = Math.SQRT1_2;
    const d = new PokeDetector(grid);
    d.setPose(1, 1.2, -0.5, 0, s, 0, s);
    const rig = new Rig(d);
    // Feed raw local coordinates as if they were world coordinates.
    for (let i = 1; i <= 5; i++) {
      rig.step(lx, ly, zForDepth(pad0.raise, 0.03 - 0.034 * (i / 5)));
    }
    expect(rig.sink.ons).toHaveLength(0);
  });
});

describe('PokeDetector across keys of differing height', () => {
  const kb = new KeyboardLayout(LAUNCHKEY_25);

  /**
   * Black keys stand 10 mm proud of the white keys, so a fingertip hovering
   * just above a white key is physically *inside* a black key it slides over.
   * Triggering there is correct — on real hardware you would have struck the
   * side of the key — and this pins that down as intended rather than
   * accidental, since the two zones reference different strike planes.
   */
  it('triggers a black key when a hovering finger slides into its raised body', () => {
    const d = new PokeDetector(kb);
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const rig = new Rig(d);

    const white = kb.zones[0]!; // C2
    const black = kb.zones[1]!; // C#2, raised
    const y = kb.height - 0.01; // deep in the black-key band

    // Hover 2 mm above the white key surface, twice so prevDepth is primed.
    const hoverZ = zForDepth(white.raise, 0.002);
    rig.step(white.rect.x + 0.002, y, hoverZ);
    rig.step(white.rect.x + 0.002, y, hoverZ);
    expect(rig.sink.ons).toHaveLength(0);

    // Slide sideways at the same height, onto the black key.
    rig.step(black.rect.x + black.rect.width / 2, y, hoverZ);
    expect(rig.sink.ons.map((e) => e.note)).toEqual([49]);
  });

  it('lets a finger glide along the front of the keys without hitting accidentals', () => {
    const d = new PokeDetector(kb);
    d.setPose(0, 0, 0, 0, 0, 0, 1);
    const rig = new Rig(d);

    const white = kb.zones[0]!;
    const hoverZ = zForDepth(white.raise, 0.002);
    const y = 0.01; // in front of the black-key band

    for (let x = 0.002; x < kb.width - 0.002; x += 0.003) {
      rig.step(x, y, hoverZ);
    }
    expect(rig.sink.ons).toHaveLength(0);
  });
});
