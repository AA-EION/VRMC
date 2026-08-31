import { listPorts, openMatchingPort, openVirtualPort } from './coreMidiBackend.js';
import { NullSink, type MidiSink } from './MidiSink.js';
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
  sink: MidiSink;
  /** What was tried and what happened, for the startup banner. */
  notes: string[];
}

/**
 * Open the best available MIDI destination for this platform.
 *
 * The fallback chain is ordered by how little the user has to do:
 *   macOS/Linux — a real virtual port, created by us, needing no setup at all.
 *   Windows     — teVirtualMIDI if its driver is present, else an existing
 *                 loopMIDI port, else nothing.
 *
 * Failing to find a port is not fatal. The bridge runs on with a null sink so
 * the network side can still be tested and the banner can explain what to
 * install; exiting here would leave a user staring at a closed terminal.
 */
export async function openBestPort(options: PortOptions): Promise<PortResult> {
  const notes: string[] = [];

  if (options.noMidi) {
    notes.push('MIDI output disabled by --no-midi.');
    return { sink: new NullSink(), notes };
  }

  if (process.platform === 'win32') {
    const te = await openTeVirtualMidiPort(options.name);
    if (te !== null) {
      notes.push(`Created virtual port "${te.name}" via teVirtualMIDI.`);
      return { sink: te, notes };
    }
    notes.push('teVirtualMIDI driver not found; looking for an existing loopback port.');

    const loop = await openMatchingPort(options.loopbackPattern);
    if (loop !== null) {
      notes.push(`Attached to existing port "${loop.name}".`);
      return { sink: loop, notes };
    }

    const available = await listPorts();
    notes.push(
      available.length > 0
        ? `No matching loopback port. Ports seen: ${available.join(', ')}`
        : 'No MIDI output ports found on this system.',
    );
    notes.push('Install loopMIDI and create a port named "VRMC", then restart the bridge.');
    return { sink: new NullSink(), notes };
  }

  const virtualPort = await openVirtualPort(options.name);
  if (virtualPort !== null) {
    const api = process.platform === 'darwin' ? 'CoreMIDI' : 'ALSA';
    notes.push(`Created ${api} virtual port "${virtualPort.name}".`);
    return { sink: virtualPort, notes };
  }

  notes.push(
    process.platform === 'darwin'
      ? 'Could not create a CoreMIDI port. Is another copy of the bridge running?'
      : 'Could not create an ALSA port. This host may have no MIDI sequencer (/dev/snd/seq).',
  );
  return { sink: new NullSink(), notes };
}

export { listPorts, WINDOWS_LOOPBACK_PATTERN };
