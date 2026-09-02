import { describe, it, expect } from 'vitest';
import { MPC_4X4, PadGridLayout } from '@vrmc/layout';
import { DeviceId, EventType, PacketReader, PacketWriter } from '@vrmc/protocol';
import {
  Finger,
  FingerFrame,
  Grabbable,
  PokeDetector,
  type GrabSink,
  type NoteSink,
} from '../src/index.js';

/**
 * Allocation regression tests.
 *
 * The whole real-time design rests on the claim that the per-frame path
 * allocates nothing. That claim is easy to make, easy to believe, and easy to
 * break with one innocuous refactor — a `.map()`, a destructure in a hot loop,
 * an object literal passed to a callback. Asserting it here turns it from an
 * aspiration into something a future change has to consciously defeat.
 *
 * The thresholds are deliberately loose. The point is to catch per-event
 * allocation, which would show up as megabytes, not to police the kilobytes
 * that JIT warmup and the measurement itself contribute.
 */

const gc = globalThis.gc;

/** Retained heap in bytes, after forcing collection. */
function heapAfterGc(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}

describe.skipIf(gc === undefined)('hot path allocation', () => {
  it('encodes and decodes a million events without growing the heap', () => {
    const writer = new PacketWriter();
    const reader = new PacketReader();
    let checksum = 0;
    const visit = (type: number, channel: number, d1: number, d2: number): void => {
      checksum += type + channel + d1 + d2;
    };

    const frames = 100_000;
    const eventsPerFrame = 10;

    // Warm the JIT so compilation does not land inside the measurement.
    for (let i = 0; i < 2000; i++) {
      writer.begin();
      writer.pushEvent(EventType.NOTE_ON, 9, 36, 100, 0, DeviceId.PADS, 0, 0);
      reader.read(writer.finish(i), visit);
    }

    const before = heapAfterGc();
    for (let i = 0; i < frames; i++) {
      writer.begin();
      for (let e = 0; e < eventsPerFrame; e++) {
        writer.pushEvent(EventType.NOTE_ON, 9, 36 + (e % 16), 100, 0, DeviceId.PADS, 0, 1.5);
      }
      reader.read(writer.finish(i * 11.1), visit);
    }
    const growth = heapAfterGc() - before;

    expect(checksum).toBeGreaterThan(0);
    // One million events. Anything allocating per event would be tens of MB.
    expect(growth).toBeLessThan(2 * 1024 * 1024);
  });

  it('runs the poke detector for an hour of playing without growing the heap', () => {
    const grid = new PadGridLayout(MPC_4X4);
    const detector = new PokeDetector(grid);
    detector.setPose(0, 0, 0, 0, 0, 0, 1);
    const frame = new FingerFrame();

    let notes = 0;
    const sink: NoteSink = {
      noteOn: () => void notes++,
      noteOff: () => void notes++,
      aftertouch: () => void notes++,
    };

    const pad = grid.zones[0]!;
    const cx = pad.rect.x + pad.rect.width / 2;
    const cy = pad.rect.y + pad.rect.height / 2;

    // Drum on the pad: a strike every 12 frames, ~7 hits a second.
    const step = (i: number, t: number): void => {
      frame.beginFrame(t, 1 / 90);
      const phase = (i % 12) / 12;
      const depth = phase < 0.5 ? 0.03 - phase * 0.08 : -0.01 + (phase - 0.5) * 0.08;
      frame.setFinger(Finger.RIGHT_INDEX, cx, cy, pad.raise + 0.008 + depth, 0.008);
      detector.update(frame, sink);
    };

    let t = 0;
    for (let i = 0; i < 2000; i++) step(i, (t += 11.1));

    const frames = 300_000; // ~55 minutes at 90 Hz
    const before = heapAfterGc();
    for (let i = 0; i < frames; i++) step(i, (t += 11.1));
    const growth = heapAfterGc() - before;

    expect(notes).toBeGreaterThan(1000);
    expect(growth).toBeLessThan(2 * 1024 * 1024);
  });

  it('grabs and carries a device for an hour without growing the heap', () => {
    /*
     * The grab test runs against every device, every frame, for as long as a
     * session lasts — including while somebody is playing, since a hand on a
     * pad grid is permanently inside the volume it looks at. It is on the same
     * frame as the notes, so it is held to the same standard.
     */
    const grab = new Grabbable();
    for (let i = 0; i < 4; i++) {
      grab.add({ id: i, centre: [i * 0.3, 1, -0.5], yawDeg: 0, reach: 0.2, pinned: false });
    }
    const frame = new FingerFrame();
    let events = 0;
    const sink: GrabSink = {
      onGrab: () => void events++,
      onMove: () => void events++,
      onRelease: () => void events++,
    };

    // Pinch, carry, release, repeat — the whole cycle, not just the idle path.
    const step = (i: number, t: number): void => {
      frame.beginFrame(t, 1 / 90);
      const phase = (i % 180) / 180;
      const separation = phase < 0.5 ? 0.015 : 0.05;
      const x = phase * 0.4;
      frame.setFinger(Finger.LEFT_THUMB, x - separation / 2, 1, -0.5, 0.008);
      frame.setFinger(Finger.LEFT_INDEX, x + separation / 2, 1, -0.5, 0.008);
      frame.setFinger(Finger.RIGHT_THUMB, x - separation / 2, 1, -0.2, 0.008);
      frame.setFinger(Finger.RIGHT_INDEX, x + separation / 2, 1, -0.2, 0.008);
      grab.update(frame, sink);
    };

    let t = 0;
    for (let i = 0; i < 2000; i++) step(i, (t += 11.1));

    const before = heapAfterGc();
    for (let i = 0; i < 300_000; i++) step(i, (t += 11.1));
    const growth = heapAfterGc() - before;

    expect(events).toBeGreaterThan(1000);
    expect(growth).toBeLessThan(2 * 1024 * 1024);
  });
});
