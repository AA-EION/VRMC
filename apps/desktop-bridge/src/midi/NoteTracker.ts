import { CC_ALL_NOTES_OFF, CC_ALL_SOUND_OFF, MidiStatus } from '@vrmc/protocol';
import type { MidiSink } from './MidiSink.js';

const CHANNELS = 16;
const NOTES = 128;

/**
 * Remembers which notes are sounding so none can be stranded.
 *
 * A stuck note is the characteristic failure of any wireless MIDI controller:
 * the Note On arrives, the Wi-Fi hiccups or the headset sleeps, and the Note
 * Off never does. The synth holds that voice until the user hunts down a panic
 * button. Because only the bridge sees every message, only the bridge can
 * guarantee the matching Note Off — so it keeps the books and releases
 * everything on disconnect.
 *
 * Held notes live in a 16x128 bitset over a flat Uint8Array: one byte per
 * (channel, note), 2 KiB total, O(1) to update and cheap to sweep.
 */
export class NoteTracker {
  private readonly held = new Uint8Array(CHANNELS * NOTES);
  /** Live count, so `panic` can exit immediately when nothing is sounding. */
  private heldCount = 0;

  get activeNotes(): number {
    return this.heldCount;
  }

  /** Record a Note On. Velocity 0 counts as a Note Off, per the MIDI spec. */
  onNoteOn(channel: number, note: number, velocity: number): void {
    if (velocity === 0) {
      this.onNoteOff(channel, note);
      return;
    }
    const i = (channel & 0x0f) * NOTES + (note & 0x7f);
    if (this.held[i] === 0) {
      this.held[i] = 1;
      this.heldCount++;
    }
  }

  onNoteOff(channel: number, note: number): void {
    const i = (channel & 0x0f) * NOTES + (note & 0x7f);
    if (this.held[i] === 1) {
      this.held[i] = 0;
      this.heldCount--;
    }
  }

  /** True if this exact note is currently sounding. */
  isHeld(channel: number, note: number): boolean {
    return this.held[(channel & 0x0f) * NOTES + (note & 0x7f)] === 1;
  }

  /**
   * Release everything currently sounding.
   *
   * Sends an explicit Note Off for each held note rather than relying on CC 123
   * alone: All Notes Off is widely implemented but not universally, and some
   * plugins ignore it while sustain is down. The per-note offs are what
   * actually guarantee silence; the CCs that follow are the belt and braces.
   *
   * Returns the number of notes released.
   */
  panic(sink: MidiSink): number {
    const released = this.heldCount;
    if (released > 0) {
      for (let ch = 0; ch < CHANNELS; ch++) {
        const base = ch * NOTES;
        for (let note = 0; note < NOTES; note++) {
          if (this.held[base + note] === 1) {
            this.held[base + note] = 0;
            sink.send(MidiStatus.NOTE_OFF | ch, note, 0);
          }
        }
      }
      this.heldCount = 0;
    }
    for (let ch = 0; ch < CHANNELS; ch++) {
      sink.send(MidiStatus.CONTROL_CHANGE | ch, CC_ALL_NOTES_OFF, 0);
      sink.send(MidiStatus.CONTROL_CHANGE | ch, CC_ALL_SOUND_OFF, 0);
    }
    return released;
  }
}
