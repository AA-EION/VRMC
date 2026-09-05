import { describe, it, expect, beforeEach } from 'vitest';
import {
  CC_ALL_NOTES_OFF,
  CC_ALL_SOUND_OFF,
  DeviceId,
  EventType,
  MidiStatus,
  PacketKind,
  PacketWriter,
  PITCH_BEND_CENTER,
} from '@vrmc/protocol';
import { Router } from '../src/core/Router.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { NullSink, NullSource, SimpleVirtualPort } from '../src/midi/MidiSink.js';
import { NoteTracker } from '../src/midi/NoteTracker.js';
import { DeviceId } from '@vrmc/protocol';

function recording(): NullSink {
  return new NullSink('test', true);
}

/**
 * A manager whose ports are recording stubs.
 *
 * The port factory is injected rather than reached around, so these tests
 * exercise the real creation, routing and teardown paths without needing a MIDI
 * subsystem.
 */
async function managerWith(sink: NullSink): Promise<DeviceManager> {
  const devices = new DeviceManager(
    { onLed: () => {}, onRosterChange: () => {}, onLog: () => {} },
    {
      noMidi: false,
      loopbackPattern: /never/,
      portNameTemplate: '{device} {port}',
      openPort: async ({ name }) => ({
        port: new SimpleVirtualPort(name, sink, new NullSource(name)),
        ok: true,
        notes: [],
      }),
    },
  );
  await devices.add(DeviceId.PADS, 'test');
  return devices;
}

describe('Router event translation', () => {
  let sink: NullSink;
  let router: Router;

  beforeEach(async () => {
    sink = recording();
    router = new Router(await managerWith(sink));
  });

  const send = (fill: (w: PacketWriter) => void, kind = PacketKind.EVENTS): void => {
    const w = new PacketWriter();
    w.begin(kind);
    fill(w);
    router.handlePacket(w.finish(performance.now()), performance.now());
  };

  it('translates note on and off to the right status bytes', () => {
    send((w) => {
      w.pushEvent(EventType.NOTE_ON, 9, 36, 118, 0, DeviceId.PADS, 0, 0);
      w.pushEvent(EventType.NOTE_OFF, 9, 36, 0, 0, DeviceId.PADS, 0, 0);
    });
    expect(sink.log).toEqual([
      [MidiStatus.NOTE_ON | 9, 36, 118],
      [MidiStatus.NOTE_OFF | 9, 36, 0],
    ]);
  });

  it('splits pitch bend into lsb then msb', () => {
    send((w) => w.pushEvent(EventType.PITCH_BEND, 0, 0, 0, PITCH_BEND_CENTER, DeviceId.PADS, 0, 0));
    expect(sink.log).toEqual([[MidiStatus.PITCH_BEND, 0, 64]]);
  });

  it('sends 14-bit CC as an MSB/LSB pair on n and n+32', () => {
    send((w) => w.pushEvent(EventType.CONTROL_CHANGE_14, 2, 1, 0, 16383, DeviceId.PADS, 0, 0));
    expect(sink.log).toEqual([
      [MidiStatus.CONTROL_CHANGE | 2, 1, 127],
      [MidiStatus.CONTROL_CHANGE | 2, 33, 127],
    ]);
  });

  it('emits a single data byte for program change', () => {
    send((w) => w.pushEvent(EventType.PROGRAM_CHANGE, 0, 42, 0, 0, DeviceId.PADS, 0, 0));
    expect(sink.log).toEqual([[MidiStatus.PROGRAM_CHANGE, 42, 0]]);
  });

  it('preserves the order of events inside one packet', () => {
    send((w) => {
      for (let i = 0; i < 8; i++) {
        w.pushEvent(EventType.NOTE_ON, 0, 60 + i, 100, 0, DeviceId.PADS, 0, 0);
      }
    });
    expect(sink.log.map((m) => m[1])).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
  });

  it('counts malformed packets without throwing', () => {
    const junk = new Uint8Array(24);
    junk.fill(0x7f);
    router.handlePacket(junk, performance.now());
    expect(router.stats.malformed).toBe(1);
    expect(sink.log).toHaveLength(0);
  });

  it('answers a PING with the client time echoed back', () => {
    const w = new PacketWriter();
    w.begin(PacketKind.PING);
    let reply: { client: number; server: number } | null = null;
    router.handlePacket(w.finish(4242.5), 9999, (clientTime, serverTime) => {
      reply = { client: clientTime, server: serverTime };
    });
    expect(reply).toEqual({ client: 4242.5, server: 9999 });
  });

  it('releases sounding notes on a PANIC packet', () => {
    send((w) => {
      w.pushEvent(EventType.NOTE_ON, 0, 60, 100, 0, DeviceId.PADS, 0, 0);
      w.pushEvent(EventType.NOTE_ON, 1, 64, 100, 0, DeviceId.PADS, 0, 0);
    });
    expect(router.activeNotes).toBe(2);

    const before = sink.log.length;
    send((w) => void w, PacketKind.PANIC);

    const after = sink.log.slice(before);
    expect(after).toContainEqual([MidiStatus.NOTE_OFF | 0, 60, 0]);
    expect(after).toContainEqual([MidiStatus.NOTE_OFF | 1, 64, 0]);
    expect(router.activeNotes).toBe(0);
  });

  it('ignores an unknown packet kind from a newer client', () => {
    send((w) => void w, 99);
    expect(sink.log).toHaveLength(0);
    expect(router.stats.malformed).toBe(0);
  });
});

describe('Router link statistics', () => {
  it('infers loss from gaps in the sequence number', async () => {
    const router = new Router(await managerWith(recording()));
    const w = new PacketWriter();
    // Send packets 1..6 but drop 3 and 4 in transit.
    for (let i = 1; i <= 6; i++) {
      w.begin();
      w.pushEvent(EventType.NOTE_ON, 0, 60, 100, 0, DeviceId.PADS, 0, 0);
      const frame = w.finish(i * 10);
      if (i === 3 || i === 4) continue;
      router.handlePacket(frame, i * 10, undefined);
    }
    expect(router.stats.dropped).toBe(2);
    expect(router.stats.packets).toBe(4);
    expect(router.stats.lossRatio).toBeCloseTo(2 / 6, 5);
  });

  it('reports near-zero jitter for a perfectly paced stream', async () => {
    const router = new Router(await managerWith(recording()));
    const w = new PacketWriter();
    for (let i = 0; i < 30; i++) {
      w.begin();
      w.pushEvent(EventType.NOTE_ON, 0, 60, 100, 0, DeviceId.PADS, 0, 0);
      // Sent every 11 ms, arriving a constant 5 ms later.
      router.handlePacket(w.finish(i * 11), i * 11 + 5);
    }
    expect(router.stats.jitterMs).toBeLessThan(0.001);
  });

  it('registers jitter when arrival spacing wanders', async () => {
    const router = new Router(await managerWith(recording()));
    const w = new PacketWriter();
    for (let i = 0; i < 30; i++) {
      w.begin();
      w.pushEvent(EventType.NOTE_ON, 0, 60, 100, 0, DeviceId.PADS, 0, 0);
      const wobble = i % 2 === 0 ? 0 : 9;
      router.handlePacket(w.finish(i * 11), i * 11 + 5 + wobble);
    }
    expect(router.stats.jitterMs).toBeGreaterThan(1);
    expect(router.stats.peakJitterMs).toBeGreaterThanOrEqual(9);
  });
});

describe('NoteTracker', () => {
  it('treats note-on with velocity 0 as a note-off', () => {
    const t = new NoteTracker();
    t.onNoteOn(0, 60, 100);
    expect(t.activeNotes).toBe(1);
    t.onNoteOn(0, 60, 0);
    expect(t.activeNotes).toBe(0);
  });

  it('does not double-count a retriggered note', () => {
    const t = new NoteTracker();
    t.onNoteOn(0, 60, 100);
    t.onNoteOn(0, 60, 120);
    expect(t.activeNotes).toBe(1);
    t.onNoteOff(0, 60);
    expect(t.activeNotes).toBe(0);
  });

  it('keeps the same note on different channels apart', () => {
    const t = new NoteTracker();
    t.onNoteOn(0, 60, 100);
    t.onNoteOn(5, 60, 100);
    expect(t.activeNotes).toBe(2);
    expect(t.isHeld(0, 60)).toBe(true);
    expect(t.isHeld(5, 60)).toBe(true);
    expect(t.isHeld(1, 60)).toBe(false);
  });

  it('panic sends an explicit note-off for each held note, then the CCs', () => {
    const t = new NoteTracker();
    const sink = recording();
    t.onNoteOn(0, 60, 100);
    t.onNoteOn(3, 72, 100);
    const released = t.panic(sink);

    expect(released).toBe(2);
    expect(sink.log).toContainEqual([MidiStatus.NOTE_OFF | 0, 60, 0]);
    expect(sink.log).toContainEqual([MidiStatus.NOTE_OFF | 3, 72, 0]);
    // All 16 channels get both safety CCs.
    expect(sink.log.filter((m) => m[1] === CC_ALL_NOTES_OFF)).toHaveLength(16);
    expect(sink.log.filter((m) => m[1] === CC_ALL_SOUND_OFF)).toHaveLength(16);
    expect(t.activeNotes).toBe(0);
  });

  it('still sends the safety CCs when nothing is sounding', () => {
    const t = new NoteTracker();
    const sink = recording();
    expect(t.panic(sink)).toBe(0);
    expect(sink.log).toHaveLength(32);
  });
});
