import {
  EVENT_BYTES,
  HEADER_BYTES,
  MAGIC,
  MAX_EVENTS_PER_PACKET,
  MAX_PACKET_BYTES,
  PROTOCOL_VERSION,
  PacketKind,
} from './constants.js';

/**
 * Callback invoked once per decoded event. Receives primitives only — passing a
 * struct would mean allocating (or mutating shared state), and primitives stay
 * in registers. Never retain these values past the call; copy what you need.
 */
export type EventVisitor = (
  type: number,
  channel: number,
  data1: number,
  data2: number,
  value14: number,
  deviceId: number,
  flags: number,
  tOffsetMs: number,
) => void;

export interface PacketHeader {
  kind: number;
  seq: number;
  count: number;
  /** Sender's clock at packet close, in ms (fractional). */
  tClient: number;
}

/** Reasons `PacketReader.read` rejects a datagram. */
export const DecodeError = {
  OK: 0,
  TOO_SHORT: 1,
  BAD_MAGIC: 2,
  BAD_VERSION: 3,
  TRUNCATED_BODY: 4,
  TOO_MANY_EVENTS: 5,
} as const;
export type DecodeError = (typeof DecodeError)[keyof typeof DecodeError];

/*
 * Packet layout (little-endian throughout):
 *
 *   offset  size  field
 *   0       2     magic          0x4D56
 *   2       1     version
 *   3       1     kind           PacketKind
 *   4       4     seq            monotonic, wraps at 2^32
 *   8       8     tClient        f64 ms, sender clock at packet close
 *   16      ..    body           kind-specific
 *
 * There is deliberately no event-count field. Both transports are
 * message-oriented — a UDP datagram and a WebSocket binary frame each carry
 * their own length — so the count is derived as (length - 16) / 12. A count
 * byte would be a second source of truth that can disagree with the real
 * length, which is exactly the kind of ambiguity that turns a corrupt packet
 * into a stuck note instead of a clean reject.
 *
 * EVENTS body — a whole number of 12-byte records, each:
 *
 *   0       1     type           EventType
 *   1       1     channel        0..15
 *   2       1     data1          note number / CC number
 *   3       1     data2          velocity / CC value
 *   4       2     value14        u16, 0..16383 for pitch bend & 14-bit CC
 *   6       1     deviceId       DeviceId
 *   7       1     flags          EventFlags bitfield
 *   8       4     tOffsetMs      f32, ms *before* tClient that this event fired
 *
 * `tOffsetMs` is what makes sub-frame timing possible. A pad struck early in a
 * frame and one struck late both leave in the same packet; without the offset
 * the bridge would quantise them to the packet boundary, smearing a fast roll
 * into a flam. The bridge subtracts it to recover the true strike order.
 */

/**
 * Builds packets into a single preallocated buffer.
 *
 * One writer per connection, reused for the lifetime of the session. `begin()`
 * resets the cursor; `pushEvent()` appends; `finish()` returns a view of the
 * bytes to hand to the socket. The returned views are cached per length so even
 * `subarray` — which allocates a small view object — is amortised to zero.
 */
export class PacketWriter {
  private readonly buffer: ArrayBuffer;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  /** Cached `subarray` views indexed by byte length, so finish() never allocates. */
  private readonly frameViews: Array<Uint8Array | undefined>;
  private cursor = HEADER_BYTES;
  private count = 0;
  private seq = 0;
  private open = false;

  constructor() {
    this.buffer = new ArrayBuffer(MAX_PACKET_BYTES);
    this.bytes = new Uint8Array(this.buffer);
    this.view = new DataView(this.buffer);
    this.frameViews = new Array(MAX_PACKET_BYTES + 1);
    this.view.setUint16(0, MAGIC, true);
    this.bytes[2] = PROTOCOL_VERSION;
    this.bytes[3] = PacketKind.EVENTS;
  }

  /** Packets closed so far. Receivers use gaps in this to detect UDP loss. */
  get sequence(): number {
    return this.seq;
  }

  /** True once the packet is full and must be flushed before more events fit. */
  get isFull(): boolean {
    return this.count >= MAX_EVENTS_PER_PACKET;
  }

  get eventCount(): number {
    return this.count;
  }

  /** Start a new packet of the given kind. */
  begin(kind: number = PacketKind.EVENTS): void {
    this.cursor = HEADER_BYTES;
    this.count = 0;
    this.open = true;
    this.bytes[3] = kind;
  }

  /**
   * Append one event. Returns false if the packet is already full — the caller
   * must `finish()`, send, and `begin()` a fresh packet before retrying.
   *
   * @param tOffsetMs ms *before* the packet timestamp that the event occurred.
   */
  pushEvent(
    type: number,
    channel: number,
    data1: number,
    data2: number,
    value14: number,
    deviceId: number,
    flags: number,
    tOffsetMs: number,
  ): boolean {
    if (this.count >= MAX_EVENTS_PER_PACKET) return false;
    const o = this.cursor;
    const b = this.bytes;
    b[o] = type & 0xff;
    b[o + 1] = channel & 0x0f;
    b[o + 2] = data1 & 0x7f;
    b[o + 3] = data2 & 0x7f;
    this.view.setUint16(o + 4, value14 & 0x3fff, true);
    b[o + 6] = deviceId & 0xff;
    b[o + 7] = flags & 0xff;
    this.view.setFloat32(o + 8, tOffsetMs, true);
    this.cursor = o + EVENT_BYTES;
    this.count++;
    return true;
  }

  /**
   * Close the packet and return the bytes to transmit.
   *
   * The returned view aliases the writer's internal buffer and is only valid
   * until the next `begin()`. Socket `send()` on both `ws` and `dgram` copies
   * synchronously, so handing it straight to the socket is safe; anything that
   * defers must copy first.
   */
  finish(tClient: number): Uint8Array {
    this.open = false;
    this.seq = (this.seq + 1) >>> 0;
    this.view.setUint32(4, this.seq, true);
    this.view.setFloat64(8, tClient, true);
    const len = this.cursor;
    let frame = this.frameViews[len];
    if (frame === undefined) {
      frame = this.bytes.subarray(0, len);
      this.frameViews[len] = frame;
    }
    return frame;
  }

  /** Append raw bytes to the body (HELLO payload, PONG timestamp, ...). */
  pushRaw(src: Uint8Array): boolean {
    if (this.cursor + src.length > MAX_PACKET_BYTES) return false;
    this.bytes.set(src, this.cursor);
    this.cursor += src.length;
    return true;
  }

  /** Append a single byte to the body. */
  pushU8(v: number): boolean {
    if (this.cursor + 1 > MAX_PACKET_BYTES) return false;
    this.bytes[this.cursor++] = v & 0xff;
    return true;
  }

  /** Append a little-endian u16 to the body. */
  pushU16(v: number): boolean {
    if (this.cursor + 2 > MAX_PACKET_BYTES) return false;
    this.view.setUint16(this.cursor, v & 0xffff, true);
    this.cursor += 2;
    return true;
  }

  /** Bytes written to the body so far, excluding the header. */
  get bodyLength(): number {
    return this.cursor - HEADER_BYTES;
  }

  /** Append a little-endian u32 to the body. */
  pushU32(v: number): boolean {
    if (this.cursor + 4 > MAX_PACKET_BYTES) return false;
    this.view.setUint32(this.cursor, v >>> 0, true);
    this.cursor += 4;
    return true;
  }

  /**
   * Append an f32 to the body.
   *
   * f32 rather than f64 for every spatial quantity on the wire. A single
   * precision float carries about seven significant digits, which over a room
   * ten metres across resolves to under a micrometre — several orders below
   * what hand tracking can measure and far below what anyone can place a
   * Launchpad to. The other half of a f64 would be describing noise.
   */
  pushFloat32(v: number): boolean {
    if (this.cursor + 4 > MAX_PACKET_BYTES) return false;
    this.view.setFloat32(this.cursor, v, true);
    this.cursor += 4;
    return true;
  }

  /** Append an f64 to the body. Used by PONG's server timestamp. */
  pushFloat64(v: number): boolean {
    if (this.cursor + 8 > MAX_PACKET_BYTES) return false;
    this.view.setFloat64(this.cursor, v, true);
    this.cursor += 8;
    return true;
  }

  /** True while a packet is in progress. */
  get isOpen(): boolean {
    return this.open;
  }
}

/**
 * Decodes packets in place. Holds no per-packet state beyond the last header,
 * so a single reader serves every connection on the server.
 */
export class PacketReader {
  readonly header: PacketHeader = { kind: 0, seq: 0, count: 0, tClient: 0 };
  private view: DataView | null = null;
  private bytes: Uint8Array | null = null;

  /**
   * Validate and walk a datagram, invoking `visit` per event.
   *
   * Returns a `DecodeError`. On OK, `this.header` describes the packet. The
   * visitor is only called for EVENTS packets; other kinds carry their payload
   * in the body, reachable via `bodyView()`.
   */
  read(data: Uint8Array, visit: EventVisitor | null): DecodeError {
    if (data.length < HEADER_BYTES) return DecodeError.TOO_SHORT;

    // Reuse the DataView when the same backing buffer comes back (the common
    // case: sockets hand us slices of one recycled receive buffer).
    let view = this.view;
    if (view === null || view.buffer !== data.buffer) {
      view = new DataView(data.buffer);
      this.view = view;
    }
    this.bytes = data;
    const base = data.byteOffset;

    if (view.getUint16(base, true) !== MAGIC) return DecodeError.BAD_MAGIC;
    if (data[2] !== PROTOCOL_VERSION) return DecodeError.BAD_VERSION;

    const h = this.header;
    h.kind = data[3]!;
    h.seq = view.getUint32(base + 4, true);
    h.tClient = view.getFloat64(base + 8, true);
    h.count = 0;

    if (h.kind !== PacketKind.EVENTS) return DecodeError.OK;

    // Length is the single source of truth for how many events are present.
    const bodyBytes = data.length - HEADER_BYTES;
    if (bodyBytes % EVENT_BYTES !== 0) return DecodeError.TRUNCATED_BODY;
    const count = bodyBytes / EVENT_BYTES;
    if (count > MAX_EVENTS_PER_PACKET) return DecodeError.TOO_MANY_EVENTS;
    h.count = count;

    if (visit === null) return DecodeError.OK;

    // `ro` indexes the Uint8Array (relative); `ao` indexes the backing
    // ArrayBuffer the DataView spans (absolute). Node hands us Buffers that are
    // windows into a shared 8 KiB slab, so the two differ by `base`.
    for (let i = 0; i < count; i++) {
      const ro = HEADER_BYTES + i * EVENT_BYTES;
      const ao = base + ro;
      visit(
        data[ro]!,
        data[ro + 1]!,
        data[ro + 2]!,
        data[ro + 3]!,
        view.getUint16(ao + 4, true),
        data[ro + 6]!,
        data[ro + 7]!,
        view.getFloat32(ao + 8, true),
      );
    }
    return DecodeError.OK;
  }

  /** Body bytes of the packet last read, for non-EVENTS kinds. */
  bodyView(): Uint8Array {
    const b = this.bytes;
    if (b === null) return EMPTY;
    return b.subarray(HEADER_BYTES);
  }

  /** Read an f64 from the body at `offset`. Returns NaN if out of range. */
  bodyFloat64(offset: number): number {
    const b = this.bytes;
    const v = this.view;
    if (b === null || v === null) return NaN;
    if (HEADER_BYTES + offset + 8 > b.length) return NaN;
    return v.getFloat64(b.byteOffset + HEADER_BYTES + offset, true);
  }
}

const EMPTY = new Uint8Array(0);

/** Human-readable decode failure, for logs only. */
export function describeDecodeError(e: DecodeError): string {
  switch (e) {
    case DecodeError.OK:
      return 'ok';
    case DecodeError.TOO_SHORT:
      return 'packet shorter than header';
    case DecodeError.BAD_MAGIC:
      return 'bad magic (not a VRMC packet)';
    case DecodeError.BAD_VERSION:
      return 'protocol version mismatch';
    case DecodeError.TRUNCATED_BODY:
      return 'body length is not a whole number of events';
    case DecodeError.TOO_MANY_EVENTS:
      return 'event count exceeds protocol maximum';
    default:
      return 'unknown';
  }
}
