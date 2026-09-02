// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ButtonRole,
  Command,
  ControlKind,
  DEVICE_SPECS,
  LAUNCHPAD_PRO_MK3,
  LAUNCHPAD_X,
  LaunchpadEmulator,
  LaunchpadMode,
  LightingType,
  PALETTE_SIZE,
  buildInquiryReply,
  buildModeMessage,
  buildRgbLedMessage,
  colOf,
  isDeviceInquiry,
  isGridIndex,
  DeviceModel,
  nearestPaletteIndex,
  paletteB,
  paletteG,
  paletteR,
  parseLedMessage,
  readScrollText,
  rowOf,
  specFor,
  to8Bit,
  xy,
  type DeviceSpec,
  LaunchpadLayout,
  type EmulatorObserver,
} from '../src/index.js';

describe('Novation palette', () => {
  it('has 128 entries with index 0 dark and index 3 full white', () => {
    expect(PALETTE_SIZE).toBe(128);
    expect([paletteR(0), paletteG(0), paletteB(0)]).toEqual([0, 0, 0]);
    expect([paletteR(3), paletteG(3), paletteB(3)]).toEqual([63, 63, 63]);
  });

  it('matches the documented primaries', () => {
    // 5 is red, 21 green, 45 blue in Novation's table.
    expect([paletteR(5), paletteG(5), paletteB(5)]).toEqual([63, 0, 0]);
    expect(paletteG(21)).toBe(63);
    expect(paletteB(45)).toBe(63);
  });

  it('keeps every channel inside the hardware 6-bit range', () => {
    for (let i = 0; i < PALETTE_SIZE; i++) {
      for (const c of [paletteR(i), paletteG(i), paletteB(i)]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(63);
      }
    }
  });

  it('masks an out-of-range index rather than returning undefined', () => {
    expect(paletteR(200)).toBe(paletteR(200 & 0x7f));
  });

  it('widens 6-bit to 8-bit so full scale reaches 255', () => {
    expect(to8Bit(0)).toBe(0);
    expect(to8Bit(63)).toBe(255);
    expect(to8Bit(31)).toBeGreaterThan(120);
  });

  it('finds an exact palette index back from its own colour', () => {
    expect(nearestPaletteIndex(63, 0, 0)).toBe(5);
    expect(nearestPaletteIndex(0, 0, 0)).toBe(0);
  });
});

describe('XY addressing', () => {
  it('numbers the grid as row*10 + col with row 1 at the bottom', () => {
    expect(xy(1, 1)).toBe(11);
    expect(xy(8, 8)).toBe(88);
    expect(rowOf(58)).toBe(5);
    expect(colOf(58)).toBe(8);
  });

  it('recognises only the 8x8 as grid positions', () => {
    expect(isGridIndex(11)).toBe(true);
    expect(isGridIndex(88)).toBe(true);
    expect(isGridIndex(91)).toBe(false); // top row
    expect(isGridIndex(19)).toBe(false); // right column
    expect(isGridIndex(9)).toBe(false);
  });
});

describe.each([
  ['Launchpad X', LAUNCHPAD_X],
  ['Launchpad Pro MK3', LAUNCHPAD_PRO_MK3],
])('%s layout', (_name, spec: DeviceSpec) => {
  it('has 64 grid pads addressed 11..88', () => {
    const grid = spec.controls.filter((c) => c.role === ButtonRole.GRID);
    expect(grid).toHaveLength(64);
    for (const c of grid) {
      expect(isGridIndex(c.index)).toBe(true);
      expect(c.kind).toBe(ControlKind.NOTE);
    }
    const indices = new Set(grid.map((c) => c.index));
    expect(indices.size).toBe(64);
    expect(indices.has(11)).toBe(true);
    expect(indices.has(88)).toBe(true);
  });

  it('has a top row on CC 91..98', () => {
    const top = spec.controls.filter((c) => c.role === ButtonRole.FUNCTION);
    expect(top.map((c) => c.index)).toEqual([91, 92, 93, 94, 95, 96, 97, 98]);
    for (const c of top) expect(c.kind).toBe(ControlKind.CC);
  });

  it('has a scene column on CC 19,29..89 running top to bottom', () => {
    const scene = spec.controls.filter((c) => c.role === ButtonRole.SCENE);
    expect(scene.map((c) => c.index)).toEqual([89, 79, 69, 59, 49, 39, 29, 19]);
  });

  it('assigns every control a unique index', () => {
    const seen = new Set<number>();
    for (const c of spec.controls) {
      expect(seen.has(c.index)).toBe(false);
      seen.add(c.index);
    }
  });

  it('has an output-only logo LED that never sends', () => {
    const logo = spec.controls.find((c) => c.role === ButtonRole.LOGO);
    expect(logo?.index).toBe(99);
    expect(logo?.kind).toBe(ControlKind.OUTPUT_ONLY);
  });

  it('presents a DAW port whose index is in range', () => {
    expect(spec.portNames.length).toBeGreaterThanOrEqual(2);
    expect(spec.dawPortIndex).toBeLessThan(spec.portNames.length);
  });
});

/**
 * The ports, checked against the hardware rather than against ourselves.
 *
 * The assertion above is true of any two-port spec and stayed green for the
 * whole time the order was backwards, which is the useful lesson: a test that
 * only restates the code's own shape cannot catch the code being wrong about
 * the world. These name the firmware's answer.
 *
 * Source: CoreFW's USB descriptor
 * (https://github.com/anthonyhfm/launchpad-core-firmware), src/sys/driver/
 * common/usb/descriptors.rs — embedded IN jack 1 is cable 0 and takes string
 * index 4, which every per-model usb.rs sets to the DAW name; jack 2 is cable
 * 1 and takes string index 5, the MIDI name.
 */
describe('the ports, as the hardware presents them', () => {
  const models = Object.entries(DEVICE_SPECS);

  it.each(models)('%s puts the DAW port on cable 0', (_model, spec) => {
    // Not `dawPortIndex < length` — the actual claim is that it is *first*,
    // because a host enumerates ports by cable index and the DAW jack is
    // cable 0 on every model in the firmware.
    expect(spec.dawPortIndex).toBe(0);
    expect(spec.portNames[0]).toContain('DAW');
    expect(spec.portNames[1]).toContain('MIDI');
  });

  it.each(models)('%s names its ports the way the descriptor does', (_model, spec) => {
    // `PREFIX (DAW)` / `PREFIX (MIDI)` — parenthesised, with one shared
    // prefix. A DAW decides what a port is by its name, so a drifting style
    // here is a control surface that stops binding.
    for (const name of spec.portNames) {
      expect(name).toMatch(/^[A-Z0-9 ]+ \((?:DAW|MIDI)\)$/);
    }
    const prefixes = new Set(spec.portNames.map((n) => n.split(' (')[0]));
    expect(prefixes.size).toBe(1);
  });

  it('matches the firmware model for model', () => {
    // Transcribed from each src/sys/driver/<model>/usb.rs. Spelled out rather
    // than derived so that changing a spec cannot quietly change the
    // expectation with it.
    expect(LAUNCHPAD_X.portNames).toEqual(['LPX (DAW)', 'LPX (MIDI)']);
    expect(LAUNCHPAD_PRO_MK3.portNames).toEqual(['PRO MK3 (DAW)', 'PRO MK3 (MIDI)']);
  });
});

describe('Launchpad Pro MK3 extra strips', () => {
  it('adds a left mode column on CC 10..80 and a bottom track row on CC 1..8', () => {
    const left = LAUNCHPAD_PRO_MK3.controls.filter((c) => c.role === ButtonRole.MODE);
    expect(left.map((c) => c.index)).toEqual([80, 70, 60, 50, 40, 30, 20, 10]);
    const bottom = LAUNCHPAD_PRO_MK3.controls.filter((c) => c.role === ButtonRole.TRACK);
    expect(bottom.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('has strips the Launchpad X does not', () => {
    const xRoles = new Set(LAUNCHPAD_X.controls.map((c) => c.role));
    expect(xRoles.has(ButtonRole.MODE)).toBe(false);
    expect(xRoles.has(ButtonRole.TRACK)).toBe(false);
  });
});

describe('device identity', () => {
  it('recognises a Universal Device Inquiry', () => {
    expect(isDeviceInquiry(Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7))).toBe(true);
    expect(isDeviceInquiry(Uint8Array.of(0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7))).toBe(true);
    expect(isDeviceInquiry(Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, 0xf7))).toBe(false);
  });

  it('replies with the Novation id and the model family code', () => {
    const reply = Array.from(buildInquiryReply(LAUNCHPAD_X));
    expect(reply.slice(0, 8)).toEqual([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x00, 0x20, 0x29]);
    // Launchpad X reports family 3, 1.
    expect(reply.slice(8, 10)).toEqual([0x03, 0x01]);
    expect(reply[reply.length - 1]).toBe(0xf7);

    const pro = Array.from(buildInquiryReply(LAUNCHPAD_PRO_MK3));
    expect(pro.slice(8, 10)).toEqual([0x23, 0x01]);
  });

  it('gives the two models different SysEx ids and USB product ids', () => {
    expect(LAUNCHPAD_X.sysexDeviceId).toBe(0x0c);
    expect(LAUNCHPAD_PRO_MK3.sysexDeviceId).toBe(0x0e);
    expect(LAUNCHPAD_X.usbProductId).not.toBe(LAUNCHPAD_PRO_MK3.usbProductId);
    // Both are Focusrite/Novation.
    expect(LAUNCHPAD_X.usbVendorId).toBe(0x1235);
    expect(LAUNCHPAD_PRO_MK3.usbVendorId).toBe(0x1235);
  });

  it('resolves models through the registry', () => {
    expect(specFor('launchpad-x')).toBe(LAUNCHPAD_X);
    expect(specFor('launchpad-pro-mk3')).toBe(LAUNCHPAD_PRO_MK3);
    expect(specFor('keyboard')).toBeNull();
  });
});

describe('LED SysEx parsing', () => {
  const collect = (bytes: number[], spec = LAUNCHPAD_X) => {
    const out: Array<[number, number, number, number, number, number]> = [];
    const applied = parseLedMessage(Uint8Array.from(bytes), spec, (led, type, pal, r, g, b) => {
      out.push([led, type, pal, r, g, b]);
    });
    return { out, applied };
  };

  const head = (spec = LAUNCHPAD_X) => [0xf0, 0x00, 0x20, 0x29, 0x02, spec.sysexDeviceId, 0x03];

  it('parses a static write', () => {
    const { out, applied } = collect([...head(), LightingType.STATIC, 11, 5, 0xf7]);
    expect(applied).toBe(1);
    expect(out[0]!.slice(0, 3)).toEqual([11, LightingType.STATIC, 5]);
  });

  it('parses an RGB write and masks channels to 6 bits', () => {
    const { out } = collect([...head(), LightingType.RGB, 42, 0x7f, 0x20, 0x01, 0xf7]);
    expect(out[0]!.slice(3)).toEqual([0x3f, 0x20, 0x01]);
  });

  it('parses a flashing write carrying two palette entries', () => {
    const out: number[][] = [];
    parseLedMessage(
      Uint8Array.from([...head(), LightingType.FLASHING, 55, 5, 21, 0xf7]),
      LAUNCHPAD_X,
      (led, type, pal, _r, _g, _b, alt) => out.push([led, type, pal, alt]),
    );
    expect(out[0]).toEqual([55, LightingType.FLASHING, 5, 21]);
  });

  it('walks a batch of mixed lighting types in one message', () => {
    const { out, applied } = collect([
      ...head(),
      LightingType.STATIC, 11, 5,
      LightingType.RGB, 12, 63, 0, 0,
      LightingType.PULSING, 13, 21,
      LightingType.FLASHING, 14, 5, 3,
      0xf7,
    ]);
    expect(applied).toBe(4);
    expect(out.map((e) => e[0])).toEqual([11, 12, 13, 14]);
    expect(out.map((e) => e[1])).toEqual([
      LightingType.STATIC,
      LightingType.RGB,
      LightingType.PULSING,
      LightingType.FLASHING,
    ]);
  });

  it('keeps the writes it already parsed when the tail is truncated', () => {
    // A complete static write, then an RGB write missing its blue byte.
    const { out, applied } = collect([
      ...head(),
      LightingType.STATIC, 11, 5,
      LightingType.RGB, 12, 63, 0,
      0xf7,
    ]);
    expect(applied).toBe(1);
    expect(out[0]![0]).toBe(11);
  });

  it('ignores a message addressed to a different model', () => {
    const { applied } = collect([...head(LAUNCHPAD_PRO_MK3), LightingType.STATIC, 11, 5, 0xf7]);
    expect(applied).toBe(0);
  });

  it('round-trips a built RGB message', () => {
    const msg = buildRgbLedMessage(LAUNCHPAD_X, Uint8Array.of(11, 63, 0, 0, 12, 0, 63, 0));
    const out: number[][] = [];
    const applied = parseLedMessage(msg, LAUNCHPAD_X, (led, _t, _p, r, g, b) =>
      out.push([led, r, g, b]),
    );
    expect(applied).toBe(2);
    expect(out).toEqual([
      [11, 63, 0, 0],
      [12, 0, 63, 0],
    ]);
  });
});

describe('LaunchpadEmulator', () => {
  interface Led { index: number; r: number; g: number; b: number; blink: number }

  let leds: Led[];
  let midiOut: number[][];
  let modes: number[];
  let emu: LaunchpadEmulator;

  const observer = (): EmulatorObserver => ({
    onLed: (index, r, g, b, blink) => leds.push({ index, r, g, b, blink }),
    // Copy: the emulator reuses one outgoing buffer.
    onMidiOut: (bytes) => midiOut.push(Array.from(bytes)),
    onModeChange: (m) => modes.push(m),
  });

  beforeEach(() => {
    leds = [];
    midiOut = [];
    modes = [];
    emu = new LaunchpadEmulator(LAUNCHPAD_X, observer());
  });

  it('answers a device inquiry from the host', () => {
    emu.handleHostMessage(Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7));
    expect(midiOut).toHaveLength(1);
    expect(midiOut[0]!.slice(0, 10)).toEqual([
      0xf0, 0x7e, 0x00, 0x06, 0x02, 0x00, 0x20, 0x29, 0x03, 0x01,
    ]);
  });

  it('lights a pad from a Note On velocity, the way Ableton does', () => {
    emu.handleHostMessage(Uint8Array.of(0x90, 11, 5)); // palette 5 = red
    expect(leds).toHaveLength(1);
    expect(leds[0]).toMatchObject({ index: 11, r: 63, g: 0, b: 0, blink: 0 });
  });

  it('distinguishes steady, flashing and pulsing by channel', () => {
    emu.handleHostMessage(Uint8Array.of(0x90, 11, 5)); // ch 1: steady
    emu.handleHostMessage(Uint8Array.of(0x91, 12, 5)); // ch 2: flashing
    emu.handleHostMessage(Uint8Array.of(0x92, 13, 5)); // ch 3: pulsing
    expect(leds.map((l) => l.blink)).toEqual([0, 1, 2]);
  });

  it('lights a CC button from a Control Change', () => {
    emu.handleHostMessage(Uint8Array.of(0xb0, 91, 21));
    expect(leds[0]).toMatchObject({ index: 91, g: 63 });
  });

  it('extinguishes an LED on Note Off', () => {
    emu.handleHostMessage(Uint8Array.of(0x90, 11, 5));
    leds = [];
    emu.handleHostMessage(Uint8Array.of(0x80, 11, 0));
    expect(leds[0]).toMatchObject({ index: 11, r: 0, g: 0, b: 0 });
  });

  it('applies an RGB SysEx write', () => {
    emu.handleHostMessage(
      Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x03, 3, 44, 10, 20, 30, 0xf7),
    );
    expect(leds[0]).toMatchObject({ index: 44, r: 10, g: 20, b: 30 });
  });

  it('does not notify when a write leaves the colour unchanged', () => {
    emu.handleHostMessage(Uint8Array.of(0x90, 11, 5));
    expect(leds).toHaveLength(1);
    emu.handleHostMessage(Uint8Array.of(0x90, 11, 5));
    expect(leds).toHaveLength(1);
  });

  it('reads back the colour it stored', () => {
    emu.handleHostMessage(Uint8Array.of(0x90, 11, 5));
    const out = new Uint8Array(3);
    emu.readLed(11, out, 0);
    expect(Array.from(out)).toEqual([63, 0, 0]);
    expect(emu.paletteOf(11)).toBe(5);
  });

  it('switches mode and clears the surface, as the hardware does', () => {
    emu.handleHostMessage(Uint8Array.of(0x90, 11, 5));
    leds = [];
    emu.handleHostMessage(buildModeMessage(LAUNCHPAD_X, LaunchpadMode.PROGRAMMER));
    expect(emu.currentMode).toBe(LaunchpadMode.PROGRAMMER);
    expect(modes).toEqual([LaunchpadMode.PROGRAMMER]);
    // The lit pad was cleared.
    expect(leds.some((l) => l.index === 11 && l.r === 0)).toBe(true);
  });

  it('ignores a mode message aimed at another model', () => {
    emu.handleHostMessage(buildModeMessage(LAUNCHPAD_PRO_MK3, LaunchpadMode.PROGRAMMER));
    expect(emu.currentMode).toBe(LaunchpadMode.LIVE);
  });

  it('sends Note On for a grid press and velocity 0 for the release', () => {
    emu.press(11, 100);
    expect(midiOut[0]).toEqual([0x90, 11, 100]);
    emu.release(11);
    // The hardware releases pads with Note On velocity 0, not Note Off.
    expect(midiOut[1]).toEqual([0x90, 11, 0]);
  });

  it('sends Control Change 127/0 for a function button', () => {
    emu.press(91, 64);
    expect(midiOut[0]).toEqual([0xb0, 91, 127]);
    emu.release(91);
    expect(midiOut[1]).toEqual([0xb0, 91, 0]);
  });

  it('never sends from the logo LED', () => {
    emu.press(99, 127);
    emu.release(99);
    expect(midiOut).toHaveLength(0);
  });

  it('ignores a release for a pad that was never pressed', () => {
    emu.release(11);
    expect(midiOut).toHaveLength(0);
  });

  it('sends polyphonic aftertouch only while a grid pad is held', () => {
    emu.aftertouch(11, 80);
    expect(midiOut).toHaveLength(0);
    emu.press(11, 100);
    emu.aftertouch(11, 80);
    expect(midiOut[1]).toEqual([0xa0, 11, 80]);
    // Not on the surrounding CC buttons.
    emu.press(91, 127);
    midiOut = [];
    emu.aftertouch(91, 80);
    expect(midiOut).toHaveLength(0);
  });

  it('releases everything held on request', () => {
    emu.press(11, 100);
    emu.press(12, 100);
    midiOut = [];
    emu.releaseAll();
    expect(midiOut).toEqual([
      [0x90, 11, 0],
      [0x90, 12, 0],
    ]);
    midiOut = [];
    emu.releaseAll();
    expect(midiOut).toHaveLength(0);
  });

  it('knows which indices are controls on this model', () => {
    expect(emu.hasControl(11)).toBe(true);
    expect(emu.hasControl(91)).toBe(true);
    // The Launchpad X has no left column; the Pro MK3 does.
    expect(emu.hasControl(10)).toBe(false);
    const pro = new LaunchpadEmulator(LAUNCHPAD_PRO_MK3, observer());
    expect(pro.hasControl(10)).toBe(true);
  });

  it('handles the Pro MK3 track row as CC', () => {
    const pro = new LaunchpadEmulator(LAUNCHPAD_PRO_MK3, observer());
    pro.press(1, 127);
    expect(midiOut[0]).toEqual([0xb0, 1, 127]);
  });

  it('shrugs off truncated and unknown messages', () => {
    expect(() => emu.handleHostMessage(new Uint8Array(0))).not.toThrow();
    expect(() => emu.handleHostMessage(Uint8Array.of(0x90))).not.toThrow();
    expect(() => emu.handleHostMessage(Uint8Array.of(0xf0, 0xf7))).not.toThrow();
    expect(() =>
      emu.handleHostMessage(Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x7f, 0xf7)),
    ).not.toThrow();
    expect(midiOut).toHaveLength(0);
  });

  it('requests a mode from the host on demand', () => {
    emu.requestMode(LaunchpadMode.PROGRAMMER);
    expect(midiOut[0]).toEqual([0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, Command.MODE, 1, 0xf7]);
  });
});

describe('LaunchpadLayout', () => {
  it('sizes the Launchpad X as 9x9 positions, with no left column or bottom row', () => {
    const layout = new LaunchpadLayout(LAUNCHPAD_X);
    // Columns 1..9 and rows 1..9.
    const pitch = LAUNCHPAD_X.padSize + LAUNCHPAD_X.padGap;
    expect(layout.width).toBeCloseTo(9 * LAUNCHPAD_X.padSize + 8 * LAUNCHPAD_X.padGap, 10);
    expect(layout.height).toBeCloseTo(layout.width, 10);
    expect(layout.pitch).toBeCloseTo(pitch, 10);
  });

  it('sizes the Pro MK3 as 10x10, since it has all four edge strips', () => {
    const layout = new LaunchpadLayout(LAUNCHPAD_PRO_MK3);
    const s = LAUNCHPAD_PRO_MK3;
    expect(layout.width).toBeCloseTo(10 * s.padSize + 9 * s.padGap, 10);
  });

  it('excludes the logo, which lights but cannot be pressed', () => {
    const layout = new LaunchpadLayout(LAUNCHPAD_X);
    expect(layout.zones.some((z) => z.note === 99)).toBe(false);
    expect(layout.logoPosition()).not.toBeNull();
  });

  it('carries the device XY index as the zone note', () => {
    const layout = new LaunchpadLayout(LAUNCHPAD_X);
    const zone = layout.zones[layout.zoneForIndex(11)]!;
    expect(zone.note).toBe(11);
    expect(layout.zoneForIndex(88)).toBeGreaterThanOrEqual(0);
    expect(layout.zoneForIndex(99)).toBe(-1);
    expect(layout.zoneForIndex(7)).toBe(-1); // no bottom row on the X
  });

  it('round-trips every control centre back to its own zone', () => {
    for (const spec of [LAUNCHPAD_X, LAUNCHPAD_PRO_MK3]) {
      const layout = new LaunchpadLayout(spec);
      for (const zone of layout.zones) {
        const cx = zone.rect.x + zone.rect.width / 2;
        const cy = zone.rect.y + zone.rect.height / 2;
        expect(layout.locate(cx, cy)).toBe(zone.index);
      }
    }
  });

  it('treats the gutter between pads as a miss', () => {
    const layout = new LaunchpadLayout(LAUNCHPAD_X);
    const gutter = LAUNCHPAD_X.padSize + LAUNCHPAD_X.padGap / 2;
    expect(layout.locate(gutter, 0.005)).toBe(-1);
  });

  it('places the grid above and right of the origin on the Pro MK3', () => {
    // Column 0 and row 0 exist on the Pro MK3, so pad 11 is one pitch in.
    const layout = new LaunchpadLayout(LAUNCHPAD_PRO_MK3);
    const zone = layout.zones[layout.zoneForIndex(11)]!;
    expect(zone.rect.x).toBeCloseTo(layout.pitch, 10);
    expect(zone.rect.y).toBeCloseTo(layout.pitch, 10);
  });

  it('marks the surrounding buttons distinctly from grid pads', () => {
    const layout = new LaunchpadLayout(LAUNCHPAD_X);
    const grid = layout.zones[layout.zoneForIndex(44)]!;
    const top = layout.zones[layout.zoneForIndex(91)]!;
    expect(grid.accidental).toBe(false);
    expect(top.accidental).toBe(true);
    expect(top.label).toBe('Up');
  });
});

describe('text the DAW sends a device to display', () => {
  const spec = specFor(DeviceModel.LAUNCHPAD_X)!;

  /** F0 00 20 29 02 <device> 07 <loop> <speed> <payload…> F7 */
  function textMessage(payload: readonly number[]): Uint8Array {
    return Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, spec.sysexDeviceId, 0x07, 0, 4, ...payload, 0xf7);
  }

  const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

  it('reads the words out', () => {
    expect(readScrollText(textMessage(ascii('Drums')), spec)).toBe('Drums');
  });

  it('drops the control bytes rather than trying to model them', () => {
    /*
     * The payload is ASCII with speed changes and colour markers embedded in
     * it, and the layout of those differs between models. Everything printable
     * is kept and everything else dropped: the result is the words, and a
     * colour marker cannot corrupt them because it was never printable.
     */
    expect(readScrollText(textMessage([0x01, 0x05, ...ascii('Bass'), 0x03]), spec)).toBe('Bass');
  });

  it('answers null for an empty or blank display', () => {
    expect(readScrollText(textMessage([]), spec)).toBeNull();
    expect(readScrollText(textMessage(ascii('   ')), spec)).toBeNull();
  });

  it('ignores anything that is not a text message', () => {
    const led = Uint8Array.of(0xf0, 0x00, 0x20, 0x29, 0x02, spec.sysexDeviceId, 0x03, 11, 5, 0xf7);
    expect(readScrollText(led, spec)).toBeNull();
    expect(readScrollText(Uint8Array.of(0xf0, 0xf7), spec)).toBeNull();
  });

  it('reaches the observer as text', () => {
    const seen: string[] = [];
    const emulator = new LaunchpadEmulator(spec, {
      onLed: () => {},
      onMidiOut: () => {},
      onText: (text) => seen.push(text),
    });
    emulator.handleHostMessage(textMessage(ascii('Session')));
    expect(seen).toEqual(['Session']);
  });
});
