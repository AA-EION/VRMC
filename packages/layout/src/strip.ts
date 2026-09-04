/**
 * A row of knobs or faders.
 *
 * WHY THIS IS A `ZoneLocator` AT ALL
 * A knob is not poked — it is pinched and dragged, and `KnobControl` already
 * does that. So this does not exist to make knobs pressable. It exists because
 * everything else about a device is expressed as zones: the renderer draws
 * them, the highlighter lights them, and the layout code places the device in
 * the world. A knob row that lived outside that would need its own placement,
 * its own drawing and its own bookkeeping, and would drift out of position the
 * moment the device moved.
 *
 * So the zones describe *where the controls are*. What happens when a hand
 * arrives there is `KnobControl`'s business, and a caller that only wants
 * pokeable zones filters on the role it composed this under.
 */

import { clampInt, type TriggerZone, type ZoneLocator } from './surface.js';

export interface ControlStripOptions {
  count: number;
  /** Width of one control, in metres. */
  width: number;
  /** Height of one control. Faders are tall; knobs are round and so square. */
  height: number;
  /** Gap between adjacent controls. */
  gap: number;
  /** First CC number. They run consecutively from here. */
  baseCc: number;
  /** How far a control stands proud of the surface. */
  raise: number;
  /** Label prefix, e.g. "K" or "F". */
  prefix: string;
}

/** Eight knobs, 20 mm across, on CC 21. */
export const KNOB_ROW_8: ControlStripOptions = {
  count: 8,
  width: 0.02,
  height: 0.02,
  gap: 0.014,
  baseCc: 21,
  raise: 0.008,
  prefix: 'K',
};

/** Nine faders, 60 mm of travel, on CC 41 — eight tracks and a master. */
export const FADER_ROW_9: ControlStripOptions = {
  count: 9,
  width: 0.012,
  height: 0.06,
  gap: 0.022,
  baseCc: 41,
  raise: 0.004,
  prefix: 'F',
};

export class ControlStripLayout implements ZoneLocator {
  readonly zones: readonly TriggerZone[];
  readonly width: number;
  readonly height: number;

  private readonly pitch: number;
  private readonly options: ControlStripOptions;

  constructor(options: ControlStripOptions) {
    this.options = options;
    this.pitch = options.width + options.gap;
    this.width = options.count * this.pitch - options.gap;
    this.height = options.height;

    const zones: TriggerZone[] = [];
    for (let i = 0; i < options.count; i++) {
      zones.push({
        index: i,
        rect: {
          x: i * this.pitch,
          y: 0,
          width: options.width,
          height: options.height,
        },
        /*
         * The CC number, in the field called `note`.
         *
         * Not a lie so much as a narrow name: this field is "the number this
         * zone sends", and for a continuous control that number is a CC. The
         * alternative — a second field that is null for every pad and key —
         * would put a branch in the hot path for the sake of a word.
         */
        note: options.baseCc + i,
        raise: options.raise,
        label: `${options.prefix}${i + 1}`,
        accidental: false,
        row: 0,
        col: i,
      });
    }
    this.zones = zones;
  }

  locate(x: number, y: number): number {
    if (y < 0 || y > this.height) return -1;
    const i = Math.floor(x / this.pitch);
    if (i < 0 || i >= this.options.count) return -1;
    // Inside the control itself, not the gap after it. A strip that claimed its
    // gaps would let a finger between two faders grab whichever came first.
    if (x - i * this.pitch > this.options.width) return -1;
    return clampInt(i, 0, this.options.count - 1);
  }
}
