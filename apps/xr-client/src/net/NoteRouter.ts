import type { NoteSink } from '@vrmc/interaction';
import { EventFlags, EventType, type DeviceId } from '@vrmc/protocol';
import type { BridgeLink } from './BridgeLink.js';

/** Notified on every note, for visual highlight and local audio feedback. */
export interface FeedbackSink {
  onNoteOn(zoneIndex: number, note: number, velocity: number): void;
  onNoteOff(zoneIndex: number, note: number): void;
}

/**
 * Sends detector output to the bridge, and to local feedback at the same time.
 *
 * Feedback is deliberately driven from here rather than from a round trip
 * through the DAW. The player needs to see the pad light and hear *something*
 * within a few milliseconds of touching it; waiting for the note to reach the
 * desktop, be rendered by a synth and come back over Wi-Fi audio would put
 * 30-60 ms between the touch and the response, which reads as broken rather
 * than as latency.
 */
export class NoteRouter implements NoteSink {
  private readonly link: BridgeLink;
  private readonly deviceId: DeviceId;
  private readonly feedback: FeedbackSink | null;

  /** MIDI channel, 0-based. */
  channel: number;

  /** Set false to keep playing locally while sending nothing. */
  sendEnabled = true;

  constructor(
    link: BridgeLink,
    deviceId: DeviceId,
    channel: number,
    feedback: FeedbackSink | null = null,
  ) {
    this.link = link;
    this.deviceId = deviceId;
    this.channel = channel;
    this.feedback = feedback;
  }

  noteOn(zoneIndex: number, note: number, velocity: number, tOffsetMs: number, flags: number): void {
    if (this.sendEnabled) {
      this.link.push(
        EventType.NOTE_ON,
        this.channel,
        note,
        velocity,
        0,
        this.deviceId,
        flags,
        tOffsetMs,
      );
    }
    this.feedback?.onNoteOn(zoneIndex, note, velocity);
  }

  noteOff(zoneIndex: number, note: number, tOffsetMs: number): void {
    if (this.sendEnabled) {
      this.link.push(
        EventType.NOTE_OFF,
        this.channel,
        note,
        0,
        0,
        this.deviceId,
        EventFlags.NONE,
        tOffsetMs,
      );
    }
    this.feedback?.onNoteOff(zoneIndex, note);
  }

  aftertouch(zoneIndex: number, note: number, pressure: number): void {
    if (!this.sendEnabled) return;
    this.link.push(
      EventType.AFTERTOUCH_POLY,
      this.channel,
      note,
      pressure,
      0,
      this.deviceId,
      EventFlags.NONE,
      0,
    );
  }
}
