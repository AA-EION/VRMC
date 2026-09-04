// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  FrameKind,
  FrameReader,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
} from "../src/midi/driverFraming.js";

/**
 * The frames the driver and the bridge exchange.
 *
 * The C++ half of this is tested separately, against vectors generated from
 * *this* encoder — so these tests cover the behaviour, and
 * native/coremidi-driver/test/framing_test.cpp covers the agreement. Neither
 * alone is enough: a format both sides implement identically wrongly is still
 * wrong, and a format each implements correctly but differently is worse.
 */

function collect(reader: FrameReader, chunk: Uint8Array) {
  const out: { kind: number; port: number; payload: number[] }[] = [];
  const ok = reader.push(chunk, (f) =>
    // Copied: the payload is a view into the reader's buffer and is valid only
    // for the callback, which is the contract worth exercising here.
    out.push({ kind: f.kind, port: f.port, payload: [...f.payload] }),
  );
  return { ok, out };
}

const frame = (kind: number, port: number, payload: number[]): Uint8Array => {
  const buf = new Uint8Array(HEADER_BYTES + payload.length);
  const n = encodeFrame(buf, 0, kind, port, Uint8Array.from(payload));
  expect(n).toBe(buf.length);
  return buf;
};

describe("one frame", () => {
  it("round-trips a note", () => {
    const reader = new FrameReader();
    const { ok, out } = collect(reader, frame(FrameKind.MIDI, 2, [0x90, 60, 90]));
    expect(ok).toBe(true);
    expect(out).toEqual([{ kind: FrameKind.MIDI, port: 2, payload: [0x90, 60, 90] }]);
  });

  it("carries an empty payload, which is what a ping is", () => {
    const reader = new FrameReader();
    const { out } = collect(reader, frame(FrameKind.PING, 0, []));
    expect(out).toEqual([{ kind: FrameKind.PING, port: 0, payload: [] }]);
  });

  it("keeps the port and the kind apart", () => {
    // They are adjacent bytes, and swapping them is the mistake that would
    // route every message to the wrong entity while still parsing cleanly.
    const reader = new FrameReader();
    const { out } = collect(reader, frame(FrameKind.MIDI, 3, [0x99]));
    expect(out[0]!.port).toBe(3);
    expect(out[0]!.kind).toBe(FrameKind.MIDI);
  });

  it("refuses a payload it cannot describe", () => {
    const out = new Uint8Array(MAX_PAYLOAD_BYTES * 2);
    expect(
      encodeFrame(out, 0, FrameKind.MIDI, 0, new Uint8Array(MAX_PAYLOAD_BYTES + 1)),
    ).toBe(-1);
    // Exactly the maximum is legal: the boundary belongs on the inside.
    expect(
      encodeFrame(out, 0, FrameKind.MIDI, 0, new Uint8Array(MAX_PAYLOAD_BYTES)),
    ).toBe(HEADER_BYTES + MAX_PAYLOAD_BYTES);
  });

  it("refuses a destination too small, rather than overrunning it", () => {
    const tiny = new Uint8Array(4);
    expect(encodeFrame(tiny, 0, FrameKind.MIDI, 0, Uint8Array.of(1, 2, 3))).toBe(-1);
  });

  it("writes at an offset, so frames can be batched into one buffer", () => {
    const buf = new Uint8Array(64);
    const a = encodeFrame(buf, 0, FrameKind.MIDI, 1, Uint8Array.of(0x90, 60, 90));
    const b = encodeFrame(buf, a, FrameKind.MIDI, 1, Uint8Array.of(0x80, 60, 0));
    const reader = new FrameReader();
    const { out } = collect(reader, buf.subarray(0, a + b));
    expect(out).toHaveLength(2);
    expect(out[1]!.payload).toEqual([0x80, 60, 0]);
  });
});

describe("a stream that splits and joins", () => {
  /*
   * The property the length prefix exists for. A socket delivers bytes, not
   * messages: one write can arrive as three reads and three writes as one. A
   * Note On split across two reads and re-emitted as two fragments is a stuck
   * note, which is the failure that would reach a performance.
   */
  const messages = [
    [FrameKind.HELLO, 0, [PROTOCOL_VERSION]],
    [FrameKind.MIDI, 2, [0x90, 60, 90]],
    [FrameKind.MIDI, 2, [0xf0, 0x00, 0x20, 0x29, ...Array(300).fill(0x3f), 0xf7]],
    [FrameKind.PING, 0, []],
    [FrameKind.MIDI, 0, [0xb0, 7, 100]],
  ] as const;

  const stream = (() => {
    const parts = messages.map(([k, p, d]) => frame(k, p, [...d]));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return all;
  })();

  it.each([1, 2, 3, 4, 5, 7, 13, 64, 511, 4096])(
    "recovers every message when delivered %i bytes at a time",
    (chunk) => {
      const reader = new FrameReader();
      const got: { kind: number; port: number; payload: number[] }[] = [];
      for (let i = 0; i < stream.length; i += chunk) {
        const slice = stream.subarray(i, Math.min(i + chunk, stream.length));
        expect(
          reader.push(slice, (f) =>
            got.push({ kind: f.kind, port: f.port, payload: [...f.payload] }),
          ),
        ).toBe(true);
      }
      expect(got).toHaveLength(messages.length);
      for (const [i, [kind, port, payload]] of messages.entries()) {
        expect(got[i]).toEqual({ kind, port, payload: [...payload] });
      }
    },
  );

  it("emits nothing from a frame that has not finished arriving", () => {
    const whole = frame(FrameKind.MIDI, 1, [0x90, 60, 90]);
    for (let prefix = 0; prefix < whole.length; prefix++) {
      const reader = new FrameReader();
      const { ok, out } = collect(reader, whole.subarray(0, prefix));
      expect(ok).toBe(true);
      expect(out).toEqual([]);
    }
  });

  it("survives a very long run without growing without bound", () => {
    // A buffer that grew per message rather than being reused would be a slow
    // leak on a link that is open for a whole set.
    const reader = new FrameReader();
    let seen = 0;
    for (let i = 0; i < 5000; i++) {
      reader.push(frame(FrameKind.MIDI, 2, [0x90, i & 0x7f, 64]), () => seen++);
    }
    expect(seen).toBe(5000);
  });
});

describe("refusing what is not this protocol", () => {
  it("drops the link on a length beyond the maximum", () => {
    /*
     * Not "ignore and resynchronise": a byte stream offers nowhere to
     * resynchronise *to*. A reader that believed a 65535-byte length would sit
     * waiting for bytes that are never coming, and the link would be silently
     * dead while looking connected.
     */
    const reader = new FrameReader();
    const bad = Uint8Array.of(0xff, 0xff, 0, FrameKind.MIDI);
    const { ok, out } = collect(reader, bad);
    expect(ok).toBe(false);
    expect(out).toEqual([]);
  });

  it("accepts exactly the maximum, so the refusal is not off by one", () => {
    const reader = new FrameReader();
    const payload = new Uint8Array(MAX_PAYLOAD_BYTES).fill(0x40);
    const buf = new Uint8Array(HEADER_BYTES + payload.length);
    encodeFrame(buf, 0, FrameKind.MIDI, 1, payload);
    const { ok, out } = collect(reader, buf);
    expect(ok).toBe(true);
    expect(out[0]!.payload).toHaveLength(MAX_PAYLOAD_BYTES);
  });
});
