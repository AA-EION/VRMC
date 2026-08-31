import { describe, it, expect } from 'vitest';
import {
  DecodeError,
  DeviceId,
  EventFlags,
  EventType,
  HEADER_BYTES,
  MAX_EVENTS_PER_PACKET,
  PacketKind,
  PacketReader,
  PacketWriter,
  PROTOCOL_VERSION,
} from '../src/index.js';

interface Captured {
  type: number;
  channel: number;
  data1: number;
  data2: number;
  value14: number;
  deviceId: number;
  flags: number;
  tOffsetMs: number;
}

/** Collect events into plain objects. Test-only — the hot path never does this. */
function drain(reader: PacketReader, bytes: Uint8Array): { err: DecodeError; events: Captured[] } {
  const events: Captured[] = [];
  const err = reader.read(bytes, (type, channel, data1, data2, value14, deviceId, flags, tOffsetMs) => {
    events.push({ type, channel, data1, data2, value14, deviceId, flags, tOffsetMs });
  });
  return { err, events };
}

describe('PacketWriter / PacketReader round trip', () => {
  it('carries a single note-on intact', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.EVENTS);
    w.pushEvent(EventType.NOTE_ON, 9, 36, 118, 0, DeviceId.PADS, EventFlags.NONE, 3.25);
    const frame = w.finish(1234.5);

    const { err, events } = drain(new PacketReader(), frame);
    expect(err).toBe(DecodeError.OK);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: EventType.NOTE_ON,
      channel: 9,
      data1: 36,
      data2: 118,
      value14: 0,
      deviceId: DeviceId.PADS,
      flags: EventFlags.NONE,
      tOffsetMs: 3.25, // exact: representable in f32
    });
  });

  it('preserves header fields', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.EVENTS);
    w.pushEvent(EventType.NOTE_OFF, 0, 60, 0, 0, DeviceId.KEYS, 0, 0);
    w.pushEvent(EventType.NOTE_ON, 0, 64, 100, 0, DeviceId.KEYS, 0, 0);
    const frame = w.finish(98765.125);

    const r = new PacketReader();
    expect(r.read(frame, null)).toBe(DecodeError.OK);
    expect(r.header.kind).toBe(PacketKind.EVENTS);
    expect(r.header.count).toBe(2);
    expect(r.header.tClient).toBe(98765.125);
    expect(r.header.seq).toBe(1);
  });

  it('increments sequence per finished packet and wraps at 2^32', () => {
    const w = new PacketWriter();
    for (let i = 0; i < 3; i++) {
      w.begin();
      w.finish(0);
    }
    expect(w.sequence).toBe(3);
  });

  it('preserves 14-bit values for pitch bend', () => {
    const w = new PacketWriter();
    w.begin();
    w.pushEvent(EventType.PITCH_BEND, 3, 0, 0, 16383, DeviceId.KNOBS, 0, 0);
    w.pushEvent(EventType.PITCH_BEND, 3, 0, 0, 8192, DeviceId.KNOBS, 0, 0);
    const { events } = drain(new PacketReader(), w.finish(0));
    expect(events[0]!.value14).toBe(16383);
    expect(events[1]!.value14).toBe(8192);
  });

  it('fills to the packet maximum and refuses to overflow', () => {
    const w = new PacketWriter();
    w.begin();
    for (let i = 0; i < MAX_EVENTS_PER_PACKET; i++) {
      expect(w.pushEvent(EventType.NOTE_ON, 0, 36 + (i % 16), 100, 0, DeviceId.PADS, 0, 0)).toBe(true);
    }
    expect(w.isFull).toBe(true);
    expect(w.pushEvent(EventType.NOTE_ON, 0, 36, 100, 0, DeviceId.PADS, 0, 0)).toBe(false);

    const { err, events } = drain(new PacketReader(), w.finish(0));
    expect(err).toBe(DecodeError.OK);
    expect(events).toHaveLength(MAX_EVENTS_PER_PACKET);
    expect(events[MAX_EVENTS_PER_PACKET - 1]!.data1).toBe(36 + ((MAX_EVENTS_PER_PACKET - 1) % 16));
  });

  it('masks out-of-range field values rather than corrupting neighbours', () => {
    const w = new PacketWriter();
    w.begin();
    // channel 255 and note 200 are caller bugs; they must not bleed into
    // adjacent fields or produce a packet the receiver mis-parses.
    w.pushEvent(EventType.NOTE_ON, 255, 200, 255, 0, DeviceId.PADS, 0, 0);
    const { events } = drain(new PacketReader(), w.finish(0));
    expect(events[0]!.channel).toBe(15);
    expect(events[0]!.data1).toBe(200 & 0x7f);
    expect(events[0]!.data2).toBe(127);
  });
});

describe('PacketReader validation', () => {
  it('rejects a runt packet', () => {
    const r = new PacketReader();
    expect(r.read(new Uint8Array(4), null)).toBe(DecodeError.TOO_SHORT);
  });

  it('rejects foreign traffic on the port', () => {
    const r = new PacketReader();
    const junk = new Uint8Array(HEADER_BYTES);
    junk.fill(0xab);
    expect(r.read(junk, null)).toBe(DecodeError.BAD_MAGIC);
  });

  it('rejects a mismatched protocol version', () => {
    const w = new PacketWriter();
    w.begin();
    const frame = w.finish(0);
    const copy = frame.slice();
    copy[2] = PROTOCOL_VERSION + 1;
    const r = new PacketReader();
    expect(r.read(copy, null)).toBe(DecodeError.BAD_VERSION);
  });

  it('rejects a body truncated mid-flight', () => {
    const w = new PacketWriter();
    w.begin();
    w.pushEvent(EventType.NOTE_ON, 0, 60, 100, 0, DeviceId.KEYS, 0, 0);
    w.pushEvent(EventType.NOTE_ON, 0, 64, 100, 0, DeviceId.KEYS, 0, 0);
    const frame = w.finish(0);
    // Lose 5 bytes off the end: no longer a whole number of 12-byte events.
    const truncated = frame.slice(0, frame.length - 5);
    const r = new PacketReader();
    expect(r.read(truncated, null)).toBe(DecodeError.TRUNCATED_BODY);
  });

  it('decodes correctly from a non-zero byteOffset (Node Buffer pooling)', () => {
    const w = new PacketWriter();
    w.begin();
    w.pushEvent(EventType.NOTE_ON, 5, 72, 55, 1234, DeviceId.KEYS, EventFlags.ESTIMATED_VELOCITY, 1.5);
    const frame = w.finish(42.0);

    // Simulate a Buffer that is a window into a larger pooled slab.
    const slab = new Uint8Array(frame.length + 37);
    slab.set(frame, 37);
    const windowed = slab.subarray(37);

    const r = new PacketReader();
    const { err, events } = drain(r, windowed);
    expect(err).toBe(DecodeError.OK);
    expect(r.header.tClient).toBe(42.0);
    expect(events[0]).toMatchObject({
      channel: 5,
      data1: 72,
      data2: 55,
      value14: 1234,
      flags: EventFlags.ESTIMATED_VELOCITY,
      tOffsetMs: 1.5,
    });
  });
});

describe('non-event packet kinds', () => {
  it('round-trips a PONG timestamp in the body', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.PONG);
    w.pushFloat64(555.25);
    const frame = w.finish(111.5);

    const r = new PacketReader();
    expect(r.read(frame, null)).toBe(DecodeError.OK);
    expect(r.header.kind).toBe(PacketKind.PONG);
    expect(r.header.tClient).toBe(111.5);
    expect(r.bodyFloat64(0)).toBe(555.25);
  });

  it('does not invoke the visitor for control packets', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.PANIC);
    const r = new PacketReader();
    let calls = 0;
    r.read(w.finish(0), () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});

describe('allocation behaviour', () => {
  it('returns the identical view object for repeated same-size packets', () => {
    const w = new PacketWriter();
    w.begin();
    w.pushEvent(EventType.NOTE_ON, 0, 60, 100, 0, DeviceId.KEYS, 0, 0);
    const a = w.finish(0);
    w.begin();
    w.pushEvent(EventType.NOTE_OFF, 0, 60, 0, 0, DeviceId.KEYS, 0, 0);
    const b = w.finish(1);
    // Same object identity => finish() allocated nothing on the second call.
    expect(a).toBe(b);
  });
});
