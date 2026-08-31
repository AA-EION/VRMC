/**
 * A destination for MIDI bytes.
 *
 * Implementations wrap a platform virtual port. The interface is deliberately
 * byte-level and synchronous: every layer of abstraction between the socket and
 * the port is latency, and any queueing is jitter.
 */
export interface MidiSink {
  /** Name the DAW will show in its MIDI input list. */
  readonly name: string;
  /** Which backend produced this sink, for diagnostics. */
  readonly backend: string;
  /** Whether the port is a true virtual port or a pre-existing loopback. */
  readonly virtual: boolean;

  /**
   * Send one channel-voice message. `d2` is ignored for one-byte messages
   * (program change, channel pressure).
   */
  send(status: number, d1: number, d2: number): void;

  close(): void;
}

/** Swallows everything. Used by `--no-midi` and by tests. */
export class NullSink implements MidiSink {
  readonly name: string;
  readonly backend = 'null';
  readonly virtual = false;
  /** Every message seen, when `record` is on. Tests assert against this. */
  readonly log: number[][] = [];
  private readonly record: boolean;
  count = 0;

  constructor(name = 'VRMC (no MIDI)', record = false) {
    this.name = name;
    this.record = record;
  }

  send(status: number, d1: number, d2: number): void {
    this.count++;
    if (this.record) this.log.push([status, d1, d2]);
  }

  close(): void {}
}
