// SPDX-License-Identifier: GPL-3.0-only

import {
  listPorts,
  openMatchingPort,
  openVirtualInput,
  openVirtualPort as openVirtualOutput,
  rtMidiLoadError,
} from './coreMidiBackend.js';
import type { EndpointIdentity } from './coreMidiIdentity.js';
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
  /**
   * Endpoint names, when the hardware names the two halves differently.
   *
   * A Launchpad calls its port the same thing whichever way MIDI flows. A
   * Launchkey does not: its endpoints are `LKMK3 DAW Out` and `LKMK3 DAW In`,
   * named from the device's point of view — so what Ableton lists as an
   * *input*, and tells the user to select, is the one called "Out".
   *
   * Both default to `name`, which is the common case and every Launchpad.
   */
  sourceName?: string;
  destinationName?: string;
  /**
   * The hardware identity to publish on the endpoint, on macOS.
   *
   * Null for the plain surfaces, which are not pretending to be anything. See
   * coreMidiIdentity.ts for what CoreMIDI does and does not let an application
   * claim here.
   */
  identity?: EndpointIdentity | null;
  /** Skip MIDI entirely and discard messages. For testing the network path. */
  noMidi: boolean;
  /** Windows: pattern for the loopback port to fall back to. */
  loopbackPattern: RegExp;
  /**
   * Which emulated model this port belongs to, and which of its ports it is.
   *
   * Only the CoreMIDI driver route needs these, and it needs both: the driver
   * publishes one specific device, so a port can only go through it if the
   * model matches, and the entity to use is the port's index within that
   * model's spec. Optional because the plain surfaces have neither.
   */
  model?: string;
  portIndex?: number;
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

  /*
   * The destination is what the *host* writes to, so it takes the destination
   * name; the source is what the host reads. Which is the point at which the
   * two are easy to swap, and swapping them puts "Out" on the port a DAW sends
   * to — the exact thing Novation's own setup instructions tell people not to
   * pick.
   */
  const destinationName = options.destinationName ?? options.name;
  const sourceName = options.sourceName ?? options.name;

  const sink = await openVirtualOutput(destinationName, options.identity);
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
          ? `Could not create a CoreMIDI port named "${destinationName}". Is one already open?`
          : 'Could not create an ALSA port. This host may have no MIDI sequencer (/dev/snd/seq).',
    );
    return { port: nullPort(options.name), ok: false, notes };
  }

  // The input half is best-effort: without it the device plays but stays dark,
  // which is worth reporting and not worth failing over.
  const source = await openVirtualInput(sourceName, options.identity);
  if (source === null) {
    notes.push(`Created "${destinationName}" as output only; LED feedback unavailable.`);
  } else {
    const api = process.platform === 'darwin' ? 'CoreMIDI' : 'ALSA';
    notes.push(
      sourceName === destinationName
        ? `Created ${api} port "${options.name}" (in and out).`
        : `Created ${api} ports "${sourceName}" and "${destinationName}".`,
    );
  }

  // Metadata, so its absence is a note rather than a failure — but a silent
  // absence would be undiagnosable, since nothing about the port looks wrong.
  const identityError = (sink as { identityError?: string }).identityError ?? '';
  if (identityError !== '') {
    notes.push(`Could not publish the hardware identity: ${identityError}`);
  }

  return { port: new SimpleVirtualPort(options.name, sink, source), ok: true, notes };
}

function nullPort(name: string): VirtualPort {
  return new SimpleVirtualPort(name, new NullSink(name), new NullSource(name));
}

export { listPorts, WINDOWS_LOOPBACK_PATTERN };
