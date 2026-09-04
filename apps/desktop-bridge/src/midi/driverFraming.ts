// SPDX-License-Identifier: GPL-3.0-only

/**
 * The frames the driver and the bridge exchange.
 *
 * WHY A SOCKET AT ALL
 * The driver runs inside MIDIServer; the bridge is a Node process. They are two
 * processes and always will be, because a CoreMIDI driver *must* live in
 * MIDIServer and Node cannot. So every note a DAW writes to the emulated
 * Launchpad, and every note the headset plays, crosses a process boundary — and
 * this is what it crosses as.
 *
 * WHY THIS SHAPE
 * A stream socket carries bytes, not messages: one `write` can arrive as three
 * reads, and three writes as one. MIDI cannot survive that ambiguity — a Note
 * On split across two reads and re-emitted as two fragments is a stuck note, and
 * two SysEx messages coalesced into one read are one malformed message. So every
 * message is length-prefixed, and both sides reassemble.
 *
 * THE HEADER IS FOUR BYTES
 *
 *     0..1  payload length, little-endian uint16
 *     2     port: which of the device's entities this is for
 *     3     kind: see `FrameKind`
 *     4..   payload
 *
 * Little-endian because both ends are always the same machine — this socket
 * never leaves it — and every Mac this runs on is little-endian. Saying so
 * explicitly rather than memcpy'ing a struct is what keeps the C++ and the
 * TypeScript from disagreeing about padding.
 *
 * BOTH SIDES ARE TESTED AGAINST THE SAME VECTORS
 * The C++ half of this lives in native/coremidi-driver/src/Framing.h, written
 * separately, and two implementations of a wire format written from one
 * description is exactly how wire formats drift. `driverFraming.vectors.json`
 * is generated from this file and read by a C++ test, so a disagreement fails
 * the build rather than becoming a stuck note on somebody's machine.
 */

/** Bytes before the payload. */
export const HEADER_BYTES = 4;

/**
 * The largest payload one frame carries.
 *
 * A 16-bit length allows 65535 and this is deliberately smaller. The only
 * thing that approaches it is a SysEx — a full-grid LED update for a Launchpad
 * Pro MK3 is under 500 bytes, and Novation's largest documented message is a
 * palette upload well under 4k. A cap here bounds what a peer can make the
 * other side allocate before it has proven it is sending anything sensible.
 */
export const MAX_PAYLOAD_BYTES = 8192;

/** Total size of the largest legal frame. */
export const MAX_FRAME_BYTES = HEADER_BYTES + MAX_PAYLOAD_BYTES;

export const FrameKind = {
  /**
   * The first frame either side sends. Payload is one byte: the protocol
   * version. A version that is not ours means the app and the installed driver
   * are from different builds, which is entirely possible — the driver lives in
   * the MIDI Drivers folder and outlives any particular app.
   */
  HELLO: 0,
  /** Raw MIDI bytes for `port`. Whole messages only. */
  MIDI: 1,
  /**
   * Keeps the link demonstrably alive. A socket to a process that has been
   * SIGKILLed stays readable-but-silent for a long time, and a bridge that
   * believes a dead driver is connected shows a device that answers nothing.
   */
  PING: 2,
  PONG: 3,
} as const;

export type FrameKindValue = (typeof FrameKind)[keyof typeof FrameKind];

/** The version in the HELLO payload. Bump when the meaning of a frame changes. */
export const PROTOCOL_VERSION = 1;

export interface Frame {
  kind: number;
  port: number;
  payload: Uint8Array;
}

/**
 * Write one frame into `out` at `offset`.
 *
 * Takes a destination rather than allocating, because this runs per MIDI
 * message: a pad roll is a few hundred a second, and a function that allocates
 * two objects each time is a garbage collector pause in the middle of a
 * performance. The bridge's hot paths avoid per-message allocation throughout
 * and this is one of them.
 *
 * @returns bytes written, or -1 if the payload is too long or `out` too small
 */
export function encodeFrame(
  out: Uint8Array,
  offset: number,
  kind: number,
  port: number,
  payload: Uint8Array,
): number {
  const total = HEADER_BYTES + payload.length;
  if (payload.length > MAX_PAYLOAD_BYTES) return -1;
  if (offset + total > out.length) return -1;
  out[offset] = payload.length & 0xff;
  out[offset + 1] = (payload.length >>> 8) & 0xff;
  out[offset + 2] = port & 0xff;
  out[offset + 3] = kind & 0xff;
  out.set(payload, offset + HEADER_BYTES);
  return total;
}

/**
 * Reassembles frames from a byte stream.
 *
 * Holds one growable buffer and slides over it rather than concatenating, so a
 * steady stream of small messages does not reallocate per read.
 */
export class FrameReader {
  private buffer: Uint8Array;
  /** Bytes of `buffer` that are real data, from `start`. */
  private start = 0;
  private end = 0;

  constructor(capacity = MAX_FRAME_BYTES * 4) {
    this.buffer = new Uint8Array(capacity);
  }

  /**
   * Add received bytes and pull out every whole frame they complete.
   *
   * `visit` is called with a view *into* the buffer, valid only for that call.
   * Callers that keep the payload must copy it — which is the right default,
   * because almost every caller here forwards it immediately and copying would
   * be per-message garbage for nothing.
   *
   * @returns false if the stream is unusable and the connection should be
   *   dropped: a length beyond the maximum means the peer is not speaking this
   *   protocol, and there is no resynchronisation point to look for.
   */
  push(chunk: Uint8Array, visit: (frame: Frame) => void): boolean {
    if (!this.ensure(chunk.length)) return false;
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;

    for (;;) {
      const available = this.end - this.start;
      if (available < HEADER_BYTES) break;
      const length =
        this.buffer[this.start]! | (this.buffer[this.start + 1]! << 8);
      if (length > MAX_PAYLOAD_BYTES) return false;
      if (available < HEADER_BYTES + length) break;

      visit({
        port: this.buffer[this.start + 2]!,
        kind: this.buffer[this.start + 3]!,
        payload: this.buffer.subarray(
          this.start + HEADER_BYTES,
          this.start + HEADER_BYTES + length,
        ),
      });
      this.start += HEADER_BYTES + length;
    }

    if (this.start === this.end) {
      // Fully consumed: reset rather than compact, which is the common case.
      this.start = 0;
      this.end = 0;
    }
    return true;
  }

  /** Room for `incoming` more bytes, compacting or growing as needed. */
  private ensure(incoming: number): boolean {
    if (this.end + incoming <= this.buffer.length) return true;

    const used = this.end - this.start;
    if (used + incoming <= this.buffer.length) {
      // A partial frame has slid to the far end. Move it back rather than
      // growing a buffer that is mostly consumed space.
      this.buffer.copyWithin(0, this.start, this.end);
      this.start = 0;
      this.end = used;
      return true;
    }

    /*
     * Growing is bounded by the frame cap: a reader can never need more than
     * one whole frame plus whatever arrived with it. Beyond that the peer is
     * sending something this protocol cannot describe.
     */
    const needed = used + incoming;
    if (needed > MAX_FRAME_BYTES * 8) return false;
    const grown = new Uint8Array(Math.max(needed, this.buffer.length * 2));
    grown.set(this.buffer.subarray(this.start, this.end));
    this.buffer = grown;
    this.start = 0;
    this.end = used;
    return true;
  }
}
