import { dataByteCount } from '@vrmc/protocol';
import type { MidiSink } from './MidiSink.js';

/**
 * Virtual MIDI port via RtMidi (`@julusian/midi`).
 *
 * On macOS this creates a CoreMIDI virtual source: the OS publishes it
 * system-wide the moment it opens, and every DAW picks it up live — Ableton,
 * Logic, REAPER and Pro Tools all show it in their MIDI input list without a
 * restart. On Linux the same call creates an ALSA sequencer port.
 *
 * Windows has no equivalent OS call; see `windowsBackend.ts`.
 */

/** Minimal shape of the RtMidi output we use. Avoids a hard type dependency. */
interface RtMidiOutput {
  openVirtualPort(name: string): void;
  openPort(index: number): void;
  closePort(): void;
  getPortCount(): number;
  getPortName(index: number): string;
  sendMessage(message: number[]): void;
}

interface RtMidiModule {
  Output: new () => RtMidiOutput;
}

/**
 * Load RtMidi. It is an optional dependency, and constructing an `Output`
 * throws outright when the host has no MIDI system at all (a headless CI box
 * with no ALSA sequencer), so both the import and the construction are guarded.
 */
export async function loadRtMidi(): Promise<RtMidiModule | null> {
  try {
    const mod = (await import('@julusian/midi')) as unknown as
      | RtMidiModule
      | { default: RtMidiModule };
    return 'Output' in mod ? mod : mod.default;
  } catch {
    return null;
  }
}

export class RtMidiSink implements MidiSink {
  readonly name: string;
  readonly backend: string;
  readonly virtual: boolean;
  private readonly output: RtMidiOutput;
  private closed = false;

  /**
   * Preallocated message array, reused for every send.
   *
   * RtMidi copies the contents into its own buffer synchronously, so handing it
   * the same array each time is safe — and it keeps a 200-note-per-second drum
   * roll from producing 200 short-lived arrays a second.
   */
  private readonly msg3: number[] = [0, 0, 0];
  private readonly msg2: number[] = [0, 0];

  constructor(output: RtMidiOutput, name: string, backend: string, virtual: boolean) {
    this.output = output;
    this.name = name;
    this.backend = backend;
    this.virtual = virtual;
  }

  send(status: number, d1: number, d2: number): void {
    if (this.closed) return;
    if (dataByteCount(status) === 1) {
      this.msg2[0] = status;
      this.msg2[1] = d1;
      this.output.sendMessage(this.msg2);
    } else {
      this.msg3[0] = status;
      this.msg3[1] = d1;
      this.msg3[2] = d2;
      this.output.sendMessage(this.msg3);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.output.closePort();
    } catch {
      // The port may already be gone if the MIDI system was torn down first.
    }
  }
}

/** Create a CoreMIDI/ALSA virtual source named `name`. */
export async function openVirtualPort(name: string): Promise<MidiSink | null> {
  const midi = await loadRtMidi();
  if (midi === null) return null;
  let output: RtMidiOutput;
  try {
    output = new midi.Output();
  } catch {
    // No MIDI subsystem on this host (headless Linux without ALSA, usually).
    return null;
  }
  try {
    output.openVirtualPort(name);
  } catch {
    try {
      output.closePort();
    } catch {
      /* ignore */
    }
    return null;
  }
  const backend = process.platform === 'darwin' ? 'coremidi' : 'alsa';
  return new RtMidiSink(output, name, backend, true);
}

/**
 * Open an existing hardware or loopback port whose name matches `pattern`.
 *
 * This is the Windows fallback path (attaching to a loopMIDI port the user
 * created) and is also how you'd target a hardware synth directly.
 */
export async function openMatchingPort(pattern: RegExp): Promise<MidiSink | null> {
  const midi = await loadRtMidi();
  if (midi === null) return null;
  let output: RtMidiOutput;
  try {
    output = new midi.Output();
  } catch {
    return null;
  }
  try {
    const count = output.getPortCount();
    for (let i = 0; i < count; i++) {
      const portName = output.getPortName(i);
      if (pattern.test(portName)) {
        output.openPort(i);
        return new RtMidiSink(output, portName, 'loopback', false);
      }
    }
  } catch {
    /* fall through to cleanup */
  }
  try {
    output.closePort();
  } catch {
    /* ignore */
  }
  return null;
}

/** List every MIDI output the host can see. For `--list-ports`. */
export async function listPorts(): Promise<string[]> {
  const midi = await loadRtMidi();
  if (midi === null) return [];
  let output: RtMidiOutput;
  try {
    output = new midi.Output();
  } catch {
    return [];
  }
  const names: string[] = [];
  try {
    const count = output.getPortCount();
    for (let i = 0; i < count; i++) names.push(output.getPortName(i));
  } finally {
    try {
      output.closePort();
    } catch {
      /* ignore */
    }
  }
  return names;
}
