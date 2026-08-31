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

  /**
   * Send a complete message of any length, for SysEx.
   *
   * Optional because not every backend can carry it: a loopMIDI port attached
   * by name works, but the fallback paths may not. Callers must cope with its
   * absence rather than assume SysEx got through — an emulated Launchpad whose
   * identity reply is silently dropped looks like a device the DAW refuses to
   * recognise, with nothing in the logs to say why.
   */
  sendRaw?(bytes: Uint8Array): void;

  close(): void;
}

/**
 * A source of MIDI from the host.
 *
 * Every emulated Launchpad needs one: the DAW drives its LEDs, and the device
 * inquiry that makes the DAW recognise it at all arrives this way.
 */
export interface MidiSource {
  readonly name: string;
  /**
   * Called with each complete message from the host.
   *
   * The buffer is owned by the backend and is only valid for the duration of
   * the call; anything retained must be copied.
   */
  onMessage: ((bytes: Uint8Array) => void) | null;
  close(): void;
}

/**
 * A bidirectional virtual port, as a piece of hardware presents it.
 *
 * Real devices expose a matched input and output under one name. Emulating that
 * means creating both a virtual source and a virtual destination with the same
 * name, so the DAW sees the pair it expects rather than a lone one-way port.
 */
export interface VirtualPort {
  readonly name: string;
  readonly sink: MidiSink;
  readonly source: MidiSource | null;
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

  sendRaw(bytes: Uint8Array): void {
    this.count++;
    if (this.record) this.log.push(Array.from(bytes));
  }

  close(): void {}
}

/** A source that never delivers anything. Pairs with `NullSink`. */
export class NullSource implements MidiSource {
  readonly name: string;
  onMessage: ((bytes: Uint8Array) => void) | null = null;

  constructor(name = 'VRMC (no MIDI)') {
    this.name = name;
  }

  /** Inject a message, as if the host had sent it. For tests. */
  emit(bytes: Uint8Array): void {
    this.onMessage?.(bytes);
  }

  close(): void {
    this.onMessage = null;
  }
}

/** Pairs a sink and a source under one name. */
export class SimpleVirtualPort implements VirtualPort {
  constructor(
    readonly name: string,
    readonly sink: MidiSink,
    readonly source: MidiSource | null,
  ) {}

  close(): void {
    this.source?.close();
    this.sink.close();
  }
}
