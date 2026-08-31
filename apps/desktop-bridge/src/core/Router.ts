import {
  DecodeError,
  EventType,
  MidiStatus,
  PacketKind,
  PacketReader,
  describeDecodeError,
  split14,
  statusForEventType,
  type EventVisitor,
} from '@vrmc/protocol';
import type { MidiSink } from '../midi/MidiSink.js';
import { NoteTracker } from '../midi/NoteTracker.js';
import { LinkStats } from './Stats.js';

/**
 * How a transport answers a PING.
 *
 * The client's own send time is echoed back rather than the sequence number:
 * that lets the client compute the round trip from the reply alone, with no
 * table of outstanding pings to keep (or to leak).
 */
export type PongResponder = (clientTime: number, serverTime: number) => void;

export interface RouterEvents {
  onPanic?: (releasedNotes: number) => void;
  onHello?: (clientName: string) => void;
  onBye?: () => void;
  onMalformed?: (reason: string) => void;
}

/**
 * Turns received packets into MIDI.
 *
 * One router per bridge, shared by every transport. It owns the note bookkeeping
 * so that a note started over UDP and released over WebSocket still balances,
 * and so a disconnect on either transport can release cleanly.
 *
 * The whole path — decode, translate, send — runs synchronously inside the
 * socket's data callback with no allocation and no queueing. Every queue
 * between the wire and the port is latency the player can feel, and every
 * allocation is a future GC pause in the middle of a take.
 */
export class Router {
  readonly stats = new LinkStats();
  readonly notes = new NoteTracker();
  private readonly reader = new PacketReader();
  private sink: MidiSink;
  private readonly events: RouterEvents;

  /**
   * The event visitor, bound once at construction.
   *
   * Passing `this.visit` as a method reference would allocate a bound function
   * per packet; a field arrow function is created once and reused forever.
   */
  private readonly visitor: EventVisitor;

  constructor(sink: MidiSink, events: RouterEvents = {}) {
    this.sink = sink;
    this.events = events;
    this.visitor = (type, channel, data1, data2, _value14, _deviceId, _flags, _tOffsetMs) => {
      this.dispatch(type, channel, data1, data2, _value14);
    };
  }

  /** Swap the MIDI destination at runtime (a port appeared, or was lost). */
  setSink(sink: MidiSink): void {
    if (sink === this.sink) return;
    this.notes.panic(this.sink);
    this.sink = sink;
  }

  get currentSink(): MidiSink {
    return this.sink;
  }

  /**
   * Handle one datagram or WebSocket frame.
   *
   * @param arrivalMs receive timestamp on the bridge's clock
   * @param pong      invoked for PING packets; the transport sends the reply
   */
  handlePacket(data: Uint8Array, arrivalMs: number, pong?: PongResponder): void {
    const err = this.reader.read(data, this.visitor);
    if (err !== DecodeError.OK) {
      this.stats.onMalformed();
      this.events.onMalformed?.(describeDecodeError(err));
      return;
    }

    const h = this.reader.header;
    switch (h.kind) {
      case PacketKind.EVENTS:
        this.stats.onPacket(h.seq, h.tClient, arrivalMs, h.count);
        break;
      case PacketKind.PING:
        pong?.(h.tClient, arrivalMs);
        break;
      case PacketKind.PANIC: {
        const released = this.notes.panic(this.sink);
        this.events.onPanic?.(released);
        break;
      }
      case PacketKind.HELLO: {
        const body = this.reader.bodyView();
        this.events.onHello?.(new TextDecoder().decode(body).replace(/\0+$/, ''));
        break;
      }
      case PacketKind.BYE:
        this.notes.panic(this.sink);
        this.events.onBye?.();
        break;
      default:
        // An unknown kind from a newer client. The version check already passed,
        // so ignore it rather than dropping the connection.
        break;
    }
  }

  /** Release every sounding note. Called on disconnect and shutdown. */
  releaseAll(): number {
    return this.notes.panic(this.sink);
  }

  private dispatch(
    type: number,
    channel: number,
    data1: number,
    data2: number,
    value14: number,
  ): void {
    const ch = channel & 0x0f;

    switch (type) {
      case EventType.NOTE_ON:
        this.notes.onNoteOn(ch, data1, data2);
        this.sink.send(MidiStatus.NOTE_ON | ch, data1, data2);
        return;

      case EventType.NOTE_OFF:
        this.notes.onNoteOff(ch, data1);
        this.sink.send(MidiStatus.NOTE_OFF | ch, data1, data2);
        return;

      case EventType.PITCH_BEND: {
        const { lsb, msb } = split14(value14);
        this.sink.send(MidiStatus.PITCH_BEND | ch, lsb, msb);
        return;
      }

      case EventType.CONTROL_CHANGE_14: {
        // 14-bit CC convention: controller n carries the MSB, n+32 the LSB.
        // Order matters — receivers latch on the MSB, so it goes first.
        const { lsb, msb } = split14(value14);
        this.sink.send(MidiStatus.CONTROL_CHANGE | ch, data1, msb);
        this.sink.send(MidiStatus.CONTROL_CHANGE | ch, (data1 + 32) & 0x7f, lsb);
        return;
      }

      default: {
        const status = statusForEventType(type);
        if (status !== 0) this.sink.send(status | ch, data1, data2);
        return;
      }
    }
  }
}
