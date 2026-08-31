import { describe, it, expect, beforeEach } from 'vitest';
import { Finger, FingerFrame, KnobControl, type ControlSink } from '../src/index.js';

class Recorder implements ControlSink {
  values: Array<{ index: number; value: number }> = [];
  grabs: number[] = [];
  releases: number[] = [];
  onValue(index: number, value14: number): void {
    this.values.push({ index, value: value14 });
  }
  onGrab(index: number): void {
    this.grabs.push(index);
  }
  onRelease(index: number): void {
    this.releases.push(index);
  }
  clear(): void {
    this.values = [];
    this.grabs = [];
    this.releases = [];
  }
}

describe('KnobControl', () => {
  let knobs: KnobControl;
  let sink: Recorder;
  let frame: FingerFrame;
  let t = 0;

  /** Place the right hand's thumb and index at a point, `gap` apart. */
  function hand(x: number, y: number, z: number, gap: number): void {
    t += 11;
    frame.beginFrame(t, 1 / 90);
    frame.setFinger(Finger.RIGHT_THUMB, x, y + gap / 2, z, 0.008);
    frame.setFinger(Finger.RIGHT_INDEX, x, y - gap / 2, z, 0.008);
    knobs.update(frame, sink);
  }

  const PINCHED = 0.015;
  const OPEN = 0.08;

  beforeEach(() => {
    knobs = new KnobControl();
    sink = new Recorder();
    frame = new FingerFrame();
    t = 0;
  });

  it('grabs a knob when a pinch closes within reach of it', () => {
    const k = knobs.addKnob(0, 1, -0.5, 0.5);
    hand(0, 1, -0.5, OPEN);
    expect(sink.grabs).toHaveLength(0);
    hand(0, 1, -0.5, PINCHED);
    expect(sink.grabs).toEqual([k]);
    expect(knobs.isHeld(k)).toBe(true);
  });

  it('ignores a pinch too far from any knob', () => {
    knobs.addKnob(0, 1, -0.5);
    hand(0, 1.5, -0.5, PINCHED);
    expect(sink.grabs).toHaveLength(0);
  });

  it('maps upward drag to a rising value and downward to falling', () => {
    const k = knobs.addKnob(0, 1, -0.5, 0.5);
    hand(0, 1, -0.5, PINCHED);
    sink.clear();

    // Half the travel distance upward: value should climb by ~0.5.
    hand(0, 1 + knobs.options.travel / 2, -0.5, PINCHED);
    expect(knobs.valueOf(k)).toBeCloseTo(1.0, 2);

    hand(0, 1 - knobs.options.travel / 2, -0.5, PINCHED);
    expect(knobs.valueOf(k)).toBeCloseTo(0.0, 2);
  });

  it('clamps at both ends of the range', () => {
    const k = knobs.addKnob(0, 1, -0.5, 0.5);
    hand(0, 1, -0.5, PINCHED);
    hand(0, 5, -0.5, PINCHED);
    expect(knobs.valueOf(k)).toBe(1);
    hand(0, -5, -0.5, PINCHED);
    expect(knobs.valueOf(k)).toBe(0);
  });

  it('does not jump when a knob is grabbed away from its current value', () => {
    const k = knobs.addKnob(0, 1, -0.5, 0.25);
    // Pinch well above the knob centre but still in range.
    hand(0, 1.04, -0.5, PINCHED);
    // The value must not snap to match the hand's absolute height.
    expect(knobs.valueOf(k)).toBe(0.25);
    expect(sink.values).toHaveLength(0);
  });

  it('holds the grab through pinch jitter, releasing only past the wider gap', () => {
    const k = knobs.addKnob(0, 1, -0.5, 0.5);
    hand(0, 1, -0.5, PINCHED);
    sink.clear();

    // Drift into the band between the close and open thresholds.
    const between = (knobs.options.pinchClose + knobs.options.pinchOpen) / 2;
    for (let i = 0; i < 10; i++) hand(0, 1, -0.5, between);
    expect(sink.releases).toHaveLength(0);
    expect(knobs.isHeld(k)).toBe(true);

    hand(0, 1, -0.5, OPEN);
    expect(sink.releases).toEqual([k]);
    expect(knobs.isHeld(k)).toBe(false);
  });

  it('releases when hand tracking drops out', () => {
    const k = knobs.addKnob(0, 1, -0.5);
    hand(0, 1, -0.5, PINCHED);
    sink.clear();
    t += 11;
    frame.beginFrame(t, 1 / 90);
    knobs.update(frame, sink);
    expect(sink.releases).toEqual([k]);
  });

  it('emits 14-bit values across the full range', () => {
    const k = knobs.addKnob(0, 1, -0.5, 0);
    hand(0, 1, -0.5, PINCHED);
    sink.clear();
    hand(0, 1 + knobs.options.travel, -0.5, PINCHED);
    const last = sink.values[sink.values.length - 1]!;
    expect(last.index).toBe(k);
    expect(last.value).toBe(16383);
  });

  it('picks the nearest knob when two are within reach', () => {
    knobs.addKnob(0, 1, -0.5);
    const near = knobs.addKnob(0.03, 1, -0.5);
    hand(0.028, 1, -0.5, PINCHED);
    expect(sink.grabs).toEqual([near]);
  });

  it('does not let a second hand steal a held knob', () => {
    const k = knobs.addKnob(0, 1, -0.5, 0.5);
    t += 11;
    frame.beginFrame(t, 1 / 90);
    frame.setFinger(Finger.RIGHT_THUMB, 0, 1 + PINCHED / 2, -0.5, 0.008);
    frame.setFinger(Finger.RIGHT_INDEX, 0, 1 - PINCHED / 2, -0.5, 0.008);
    frame.setFinger(Finger.LEFT_THUMB, 0, 1 + PINCHED / 2, -0.5, 0.008);
    frame.setFinger(Finger.LEFT_INDEX, 0, 1 - PINCHED / 2, -0.5, 0.008);
    knobs.update(frame, sink);
    expect(sink.grabs).toEqual([k]);
  });

  it('releaseAll drops every held control', () => {
    const k = knobs.addKnob(0, 1, -0.5);
    hand(0, 1, -0.5, PINCHED);
    sink.clear();
    knobs.releaseAll(sink);
    expect(sink.releases).toEqual([k]);
    knobs.releaseAll(sink);
    expect(sink.releases).toHaveLength(1);
  });
});
