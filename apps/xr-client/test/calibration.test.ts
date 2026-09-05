import { describe, it, expect } from 'vitest';
import {
  CALIBRATION_STEPS,
  Calibration,
  HITS_PER_STEP,
  median,
} from '../src/ui/Calibration.js';

/** Feed one step's worth of strikes. */
function play(calibration: Calibration, speeds: readonly number[]): void {
  for (const speed of speeds) calibration.record(speed);
}

function fill(calibration: Calibration, speed: number, count = HITS_PER_STEP): void {
  play(calibration, Array.from({ length: count }, () => speed));
}

describe('the median', () => {
  it('throws away the one that was not what they meant', () => {
    /*
     * The reason it is a median and not a mean. Within five attempts at
     * «gently» there is reliably one that was not, and a mean would let that
     * single slam drag the floor of the whole curve up with it.
     */
    expect(median([0.3, 0.31, 0.29, 0.3, 2.4])).toBeCloseTo(0.3, 6);
    const mean = [0.3, 0.31, 0.29, 0.3, 2.4].reduce((a, b) => a + b) / 5;
    expect(mean).toBeGreaterThan(0.7);
  });

  it('handles an even count and an empty one', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('the guided routine', () => {
  it('walks the three steps in order', () => {
    const c = new Calibration();
    c.start();
    expect(c.state.step).toBe('soft');
    fill(c, 0.3);
    expect(c.state.step).toBe('medium');
    fill(c, 0.9);
    expect(c.state.step).toBe('hard');
    fill(c, 2.0);
    expect(c.state.step).toBeNull();
    expect(c.running).toBe(false);
  });

  it('reports progress within a step', () => {
    const c = new Calibration();
    c.start();
    expect(c.state.collected).toBe(0);
    c.record(0.3);
    expect(c.state.collected).toBe(1);
    c.record(0.3);
    expect(c.state.collected).toBe(2);
  });

  it('produces a curve that puts a medium strike in the middle', () => {
    const c = new Calibration();
    c.start();
    fill(c, 0.3);
    fill(c, 0.9);
    fill(c, 2.0);
    const fit = c.state.fit;
    expect(fit).not.toBeNull();
    expect(fit!.minSpeed).toBeCloseTo(0.3, 6);
    expect(fit!.maxSpeed).toBeCloseTo(2.0, 6);
  });

  it('ignores a strike that reported no speed', () => {
    /*
     * The detector flags those — tracking dropped the joint, or the frame
     * hitched — and a zero counted as a very soft hit would drag the floor of
     * the curve down to nothing.
     */
    const c = new Calibration();
    c.start();
    c.record(0);
    c.record(NaN);
    c.record(-1);
    expect(c.state.collected).toBe(0);
    expect(c.state.step).toBe('soft');
  });

  it('says what to do when the three strengths were really one', () => {
    // The usual failure, and one a person can fix on the next attempt — so it
    // is phrased as an instruction rather than as an error.
    const c = new Calibration();
    c.start();
    fill(c, 0.5);
    fill(c, 0.52);
    fill(c, 0.54);
    expect(c.state.fit).toBeNull();
    expect(c.state.problem).toContain('exaggerate');
  });

  it('can be cancelled part-way and started again cleanly', () => {
    const c = new Calibration();
    c.start();
    fill(c, 0.3);
    c.record(0.9);
    c.cancel();
    expect(c.running).toBe(false);

    c.start();
    expect(c.state.step).toBe('soft');
    expect(c.state.collected).toBe(0);
    // The abandoned samples must not survive into the new run.
    fill(c, 0.4);
    fill(c, 1.1);
    fill(c, 2.4);
    expect(c.state.fit!.minSpeed).toBeCloseTo(0.4, 6);
  });

  it('ignores strikes before it has started', () => {
    const c = new Calibration();
    c.record(0.9);
    expect(c.state.collected).toBe(0);
    expect(c.state.fit).toBeNull();
  });

  it('announces every change, so a panel can follow it', () => {
    const c = new Calibration();
    const seen: Array<string | null> = [];
    c.onChange = (state) => seen.push(state.step);
    c.start();
    fill(c, 0.3);
    expect(seen[0]).toBe('soft');
    expect(seen.at(-1)).toBe('medium');
    expect(seen.length).toBe(1 + HITS_PER_STEP);
  });

  it('asks for every step it says it will', () => {
    expect(CALIBRATION_STEPS).toEqual(['soft', 'medium', 'hard']);
  });
});
