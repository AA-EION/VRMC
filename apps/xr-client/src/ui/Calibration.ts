import { fitVelocityCurve, type VelocityFit } from '@vrmc/protocol';

/**
 * The guided routine that fits the velocity curve to one person's hands.
 *
 * `VelocityCurve`'s presets are a guess at an average hand, and hand tracking
 * makes the spread between people much wider than it is on hardware: there is
 * no surface to stop against, so how fast a finger is travelling when it
 * crosses the plane is personal style rather than a property of the
 * instrument. Somebody who plays lightly can be a factor of three below
 * somebody who does not, and the presets are wrong for both in opposite
 * directions.
 *
 * Three strikes, because the curve has three degrees of freedom and each one
 * pins a single sample: soft sets the floor, hard sets the ceiling, and medium
 * decides how the range between them is distributed.
 *
 * SEVERAL HITS PER STEP, AND THE MEDIAN OF THEM
 * One strike is not a measurement. Hand tracking loses a joint occasionally,
 * and a person asked to hit something softly will produce one that was harder
 * than they meant within the first three attempts. The median of five throws
 * both away without needing to decide which was which — a mean would let a
 * single mistimed slam drag the whole calibration with it.
 */

export type CalibrationStep = 'soft' | 'medium' | 'hard';

export const CALIBRATION_STEPS: readonly CalibrationStep[] = ['soft', 'medium', 'hard'];

/** How many strikes each step collects before moving on. */
export const HITS_PER_STEP = 5;

/** What to say at each step. Plain, and about intent rather than about numbers. */
export const CALIBRATION_PROMPT: Record<CalibrationStep, string> = {
  soft: 'Play five pads as gently as you would for a ghost note.',
  medium: 'Now five at a comfortable, normal strength.',
  hard: 'Now five as hard as you would ever actually play.',
};

export interface CalibrationState {
  step: CalibrationStep | null;
  /** Strikes recorded for the current step. */
  collected: number;
  /** The fitted curve, once all three steps are done. */
  fit: VelocityFit | null;
  /** Set when the routine finished without a usable fit. */
  problem: string;
}

export class Calibration {
  private readonly samples: Record<CalibrationStep, number[]> = {
    soft: [],
    medium: [],
    hard: [],
  };
  private index = -1;
  private fit: VelocityFit | null = null;
  private problem = '';

  onChange: ((state: CalibrationState) => void) | null = null;

  start(): void {
    this.samples.soft = [];
    this.samples.medium = [];
    this.samples.hard = [];
    this.index = 0;
    this.fit = null;
    this.problem = '';
    this.publish();
  }

  cancel(): void {
    this.index = -1;
    this.publish();
  }

  get running(): boolean {
    return this.index >= 0 && this.index < CALIBRATION_STEPS.length;
  }

  get state(): CalibrationState {
    const step = this.running ? (CALIBRATION_STEPS[this.index] ?? null) : null;
    return {
      step,
      collected: step === null ? 0 : this.samples[step].length,
      fit: this.fit,
      problem: this.problem,
    };
  }

  /**
   * Record one strike's approach speed, in m/s.
   *
   * A strike that reported no speed is ignored rather than counted as a very
   * soft one. The detector flags those — tracking dropped the joint, or the
   * frame hitched — and a zero in the soft bucket would drag the floor of the
   * whole curve down to nothing.
   */
  record(speed: number): void {
    if (!this.running) return;
    if (!Number.isFinite(speed) || speed <= 0) return;
    const step = CALIBRATION_STEPS[this.index]!;
    const bucket = this.samples[step];
    bucket.push(speed);
    if (bucket.length >= HITS_PER_STEP) this.index++;
    if (!this.running) this.finish();
    this.publish();
  }

  private finish(): void {
    const fit = fitVelocityCurve({
      soft: median(this.samples.soft),
      medium: median(this.samples.medium),
      hard: median(this.samples.hard),
    });
    if (fit === null) {
      // Said as something to do rather than as a failure. The usual cause is
      // three strengths that were really one, which is a thing a person can
      // fix by exaggerating on the next attempt.
      this.problem =
        'Those three came out too alike to tell apart. Try again, and exaggerate the difference between the gentle ones and the hard ones.';
      this.fit = null;
      return;
    }
    this.fit = fit;
    this.problem = '';
  }

  private publish(): void {
    this.onChange?.(this.state);
  }
}

/**
 * The middle value.
 *
 * A mean would let one mistimed slam drag the whole calibration with it, and
 * within five attempts at "gently" there is reliably one that was not.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
