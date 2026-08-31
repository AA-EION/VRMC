// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  DeviceStatus,
  HEADER_BYTES,
  PacketKind,
  PacketReader,
  PacketWriter,
  ledCapacity,
  readDeviceAdd,
  readDeviceRemove,
  readDeviceState,
  readLedUpdate,
  readSysEx,
  writeDeviceAdd,
  writeDeviceRemove,
  writeDeviceState,
  writeLedEntry,
  writeLedHeader,
  writeSysEx,
} from '../src/index.js';

/** Build a control packet and hand back its body, as a receiver would see it. */
function roundTrip(kind: number, fill: (w: PacketWriter) => void): Uint8Array {
  const w = new PacketWriter();
  w.begin(kind);
  fill(w);
  const frame = w.finish(0).slice();
  const r = new PacketReader();
  expect(r.read(frame, null)).toBe(0);
  expect(r.header.kind).toBe(kind);
  return r.bodyView();
}

describe('DEVICE_ADD', () => {
  it('round-trips a device id and model name', () => {
    const body = roundTrip(PacketKind.DEVICE_ADD, (w) => {
      writeDeviceAdd(w, 17, 'launchpad-pro-mk3');
    });
    expect(readDeviceAdd(body)).toEqual({ deviceId: 17, model: 'launchpad-pro-mk3' });
  });

  it('rejects a truncated body rather than inventing a model', () => {
    expect(readDeviceAdd(new Uint8Array(0))).toBeNull();
    expect(readDeviceAdd(Uint8Array.of(17, 40, 0x61))).toBeNull();
  });

  it('refuses a model name that will not fit in one byte of length', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.DEVICE_ADD);
    expect(writeDeviceAdd(w, 1, 'x'.repeat(300))).toBe(false);
  });
});

describe('DEVICE_REMOVE', () => {
  it('round-trips a device id', () => {
    const body = roundTrip(PacketKind.DEVICE_REMOVE, (w) => writeDeviceRemove(w, 42));
    expect(readDeviceRemove(body)).toBe(42);
  });

  it('reports -1 for an empty body', () => {
    expect(readDeviceRemove(new Uint8Array(0))).toBe(-1);
  });
});

describe('DEVICE_STATE', () => {
  it('round-trips several devices with their status and detail', () => {
    const entries = [
      { deviceId: 16, status: DeviceStatus.READY, model: 'launchpad-x', detail: 'LPX MIDI, LPX DAW' },
      { deviceId: 17, status: DeviceStatus.FAILED, model: 'launchpad-pro-mk3', detail: 'no driver' },
      { deviceId: 18, status: DeviceStatus.PENDING, model: 'keyboard', detail: '' },
    ];
    const body = roundTrip(PacketKind.DEVICE_STATE, (w) => {
      expect(writeDeviceState(w, entries)).toBe(true);
    });
    expect(readDeviceState(body)).toEqual(entries);
  });

  it('returns an empty roster for an empty body', () => {
    expect(readDeviceState(new Uint8Array(0))).toEqual([]);
  });

  it('stops cleanly at a truncated entry instead of throwing', () => {
    // Claims three devices but only carries one.
    const body = Uint8Array.of(3, 16, DeviceStatus.READY, 1, 0x78, 0);
    const out = readDeviceState(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.model).toBe('x');
  });
});

describe('LED_UPDATE', () => {
  it('round-trips a batch of LEDs', () => {
    const body = roundTrip(PacketKind.LED_UPDATE, (w) => {
      writeLedHeader(w, 16, 3);
      writeLedEntry(w, 11, 63, 0, 0, 0);
      writeLedEntry(w, 12, 0, 63, 0, 1);
      writeLedEntry(w, 88, 0, 0, 63, 2);
    });
    const seen: number[][] = [];
    const deviceId = readLedUpdate(body, (i, r, g, b, blink) => seen.push([i, r, g, b, blink]));
    expect(deviceId).toBe(16);
    expect(seen).toEqual([
      [11, 63, 0, 0, 0],
      [12, 0, 63, 0, 1],
      [88, 0, 0, 63, 2],
    ]);
  });

  it('carries a full Launchpad redraw in a single packet', () => {
    // 64 grid pads plus the surrounding buttons is comfortably under capacity.
    expect(ledCapacity()).toBeGreaterThanOrEqual(110);

    const body = roundTrip(PacketKind.LED_UPDATE, (w) => {
      writeLedHeader(w, 16, 110);
      for (let i = 0; i < 110; i++) writeLedEntry(w, i, i & 0x3f, 0, 0, 0);
    });
    let count = 0;
    readLedUpdate(body, () => count++);
    expect(count).toBe(110);
  });

  it('stops at the end of a truncated body rather than reading past it', () => {
    // Header claims 5 entries; only 2 follow.
    const body = Uint8Array.of(16, 5, 0, 11, 1, 2, 3, 0, 12, 4, 5, 6, 0);
    let count = 0;
    expect(readLedUpdate(body, () => count++)).toBe(16);
    expect(count).toBe(2);
  });

  it('reports -1 for a body too short to hold a header', () => {
    expect(readLedUpdate(Uint8Array.of(1, 2), () => {})).toBe(-1);
  });
});

describe('SYSEX', () => {
  it('round-trips a device inquiry reply', () => {
    const sysex = Uint8Array.of(0xf0, 0x7e, 0x00, 0x06, 0x02, 0x00, 0x20, 0x29, 0x03, 0x01, 0xf7);
    const body = roundTrip(PacketKind.SYSEX, (w) => writeSysEx(w, 16, sysex));
    const read = readSysEx(body);
    expect(read?.deviceId).toBe(16);
    expect(Array.from(read!.bytes)).toEqual(Array.from(sysex));
  });

  it('carries a long dump that would not fit in an events packet', () => {
    const big = new Uint8Array(1500);
    big.fill(0x42);
    big[0] = 0xf0;
    big[big.length - 1] = 0xf7;
    const body = roundTrip(PacketKind.SYSEX, (w) => {
      expect(writeSysEx(w, 20, big)).toBe(true);
    });
    const read = readSysEx(body);
    expect(read?.bytes.length).toBe(1500);
  });

  it('rejects a body whose declared length overruns it', () => {
    expect(readSysEx(Uint8Array.of(16, 0xff, 0xff, 0xf0, 0xf7))).toBeNull();
    expect(readSysEx(Uint8Array.of(16))).toBeNull();
  });
});

describe('control packet framing', () => {
  it('tracks body length as it is written', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.DEVICE_ADD);
    expect(w.bodyLength).toBe(0);
    writeDeviceAdd(w, 1, 'abc');
    expect(w.bodyLength).toBe(5); // id + len + 3 chars
    expect(w.finish(0).length).toBe(HEADER_BYTES + 5);
  });

  it('refuses to overrun the control buffer', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.SYSEX);
    const huge = new Uint8Array(8192);
    expect(writeSysEx(w, 1, huge)).toBe(false);
  });
});
