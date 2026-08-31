import { EventType, MidiStatus } from './constants.js';

/**
 * Map a protocol event type to its MIDI status nibble.
 * Returns 0 for types that expand to something other than one channel message
 * (CONTROL_CHANGE_14 becomes a CC pair) — callers must special-case those.
 */
export function statusForEventType(type: number): number {
  switch (type) {
    case EventType.NOTE_OFF:
      return MidiStatus.NOTE_OFF;
    case EventType.NOTE_ON:
      return MidiStatus.NOTE_ON;
    case EventType.AFTERTOUCH_POLY:
      return MidiStatus.AFTERTOUCH_POLY;
    case EventType.CONTROL_CHANGE:
      return MidiStatus.CONTROL_CHANGE;
    case EventType.PROGRAM_CHANGE:
      return MidiStatus.PROGRAM_CHANGE;
    case EventType.AFTERTOUCH_CHANNEL:
      return MidiStatus.AFTERTOUCH_CHANNEL;
    case EventType.PITCH_BEND:
      return MidiStatus.PITCH_BEND;
    default:
      return 0;
  }
}

/** How many data bytes follow the status byte for a given status nibble. */
export function dataByteCount(status: number): 1 | 2 {
  const nibble = status & 0xf0;
  return nibble === MidiStatus.PROGRAM_CHANGE || nibble === MidiStatus.AFTERTOUCH_CHANNEL ? 1 : 2;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** "C3", "F#4"... MIDI note 60 is C3 in the Yamaha/Ableton convention. */
export function noteName(note: number): string {
  const n = note | 0;
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 2}`;
}

/** True for the five black keys of each octave. */
export function isAccidental(note: number): boolean {
  const pc = ((note % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

/** Split a 14-bit value into MIDI (lsb, msb) for pitch bend / hi-res CC. */
export function split14(value: number): { lsb: number; msb: number } {
  const v = Math.max(0, Math.min(16383, value | 0));
  return { lsb: v & 0x7f, msb: (v >> 7) & 0x7f };
}

/** Pitch bend centre. */
export const PITCH_BEND_CENTER = 8192;
