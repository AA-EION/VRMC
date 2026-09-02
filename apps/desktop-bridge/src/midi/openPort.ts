// SPDX-License-Identifier: GPL-3.0-only

import {
  listPorts,
  openMatchingPort,
  openVirtualInput,
  openVirtualPort as openVirtualOutput,
  rtMidiLoadError,
} from './coreMidiBackend.js';
import {
  NullSink,
  NullSource,
  SimpleVirtualPort,
  type VirtualPort,
} from './MidiSink.js';
import { openTeVirtualMidiPort, WINDOWS_LOOPBACK_PATTERN } from './windowsBackend.js';

export interface PortOptions {
  /** Name the DAW will display. */
  name: string;
  /** Skip MIDI entirely and discard messages. For testing the network path. */
  noMidi: boolean;
  /** Windows: pattern for the loopback port to fall back to. */
  loopbackPattern: RegExp;
}

export interface PortResult {
  port: VirtualPort;
  /** True when a real, host-visible port was created. */
  ok: boolean;
  /** What was tried and what happened, for the startup banner. */
  notes: string[];
}

/**
 * Open one bidirectional virtual port.
 *
 * A device is more than an output. A Launchpad is lit by the host, and it is
 * only recognised at all because it answers an inquiry the host sends — both of
 * which arrive on the input half. So a port that could only send would produce
 * a device that appears in the DAW and then behaves like a dead one.
 *
 * The platforms get there differently. CoreMIDI and ALSA have no notion of a
 * bidirectional endpoint, so two are created under one name and the pair reads
 * as a single device. teVirtualMIDI's ports are inherently bidirectional and
 * deliver host traffic through a driver callback.
 */
export async function openBidirectionalPort(options: PortOptions): Promise<PortResult> {
  const notes: string[] = [];

  if (options.noMidi) {
    const sink = new NullSink(options.name);
    return {
      port: new SimpleVirtualPort(options.name, sink, new NullSource(options.name)),
      ok: false,
      notes: ['MIDI output disabled by --no-midi.'],
    };
  }

  if (process.platform === 'win32') {
    const te = await openTeVirtualMidiPort(options.name);
    if (te !== null) {
      notes.push(`Created virtual port "${te.name}" via teVirtualMIDI.`);
      return { port: te, ok: true, notes };
    }
    notes.push('teVirtualMIDI driver not found; looking for an existing loopback port.');

    const loop = await openMatchingPort(options.loopbackPattern);
    if (loop !== null) {
      notes.push(`Attached to existing port "${loop.name}".`);
      // A loopMIDI port the user made by hand has an input side too, but its
      // name is whatever they chose, so it cannot be matched reliably. Output
      // only: the device will play but its LEDs will not light.
      notes.push('Attached output only — LED feedback needs the teVirtualMIDI driver.');
      return { port: new SimpleVirtualPort(loop.name, loop, null), ok: true, notes };
    }

    const available = await listPorts();
    notes.push(
      available.length > 0
        ? `No matching loopback port. Ports seen: ${available.join(', ')}`
        : 'No MIDI output ports found on this system.',
    );
    notes.push('Install loopMIDI (which ships the teVirtualMIDI driver) and restart the bridge.');
    return { port: nullPort(options.name), ok: false, notes };
  }

  const sink = await openVirtualOutput(options.name);
  if (sink === null) {
    // The addon failing to load and the host having no MIDI system produce the
    // same missing port, and pointing at the wrong one costs a long detour:
    // a packaged build whose addon could not be found once reported itself as
    // a machine with no ALSA sequencer.
    const loadError = rtMidiLoadError();
    notes.push(
      loadError !== ''
        ? `The MIDI library did not load: ${loadError}`
        : process.platform === 'darwin'
          ? `Could not create a CoreMIDI port named "${options.name}". Is one already open?`
          : 'Could not create an ALSA port. This host may have no MIDI sequencer (/dev/snd/seq).',
    );
    return { port: nullPort(options.name), ok: false, notes };
  }

  // The input half is best-effort: without it the device plays but stays dark,
  // which is worth reporting and not worth failing over.
  const source = await openVirtualInput(options.name);
  if (source === null) {
    notes.push(`Created "${options.name}" as output only; LED feedback unavailable.`);
  } else {
    const api = process.platform === 'darwin' ? 'CoreMIDI' : 'ALSA';
    notes.push(`Created ${api} port "${options.name}" (in and out).`);
  }

  return { port: new SimpleVirtualPort(options.name, sink, source), ok: true, notes };
}

function nullPort(name: string): VirtualPort {
  return new SimpleVirtualPort(name, new NullSink(name), new NullSource(name));
}

export { listPorts, WINDOWS_LOOPBACK_PATTERN };
