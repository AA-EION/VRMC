// SPDX-License-Identifier: GPL-3.0-only

import type { TrayItem } from './protocol.js';
import type { AutostartState } from '../setup/autostart.js';

/** Everything the menu shows, gathered by the caller each time it rebuilds. */
export interface TrayState {
  /** Pairing code as displayed, or empty when publishing is off. */
  pairingCode: string;
  /** Whether the pairing service has the current registration. */
  pairingRegistered: boolean;
  /** Headsets connected, across every transport. */
  clients: number;
  /** MIDI devices currently open. */
  devices: number;
  /** True when at least one device has working MIDI ports. */
  midiReady: boolean;
  /** Where the dashboard lives, for the label. */
  dashboardUrl: string;
  autostart: AutostartState;
}

/** Ids the bridge acts on. Kept here so the handler and the menu agree. */
export const TrayAction = {
  COPY_CODE: 'copy-code',
  DASHBOARD: 'dashboard',
  AUTOSTART: 'autostart',
  QUIT: 'quit',
} as const;

/**
 * The whole menu, as one line of state.
 *
 * Written as a pure function so the exact rows a given situation produces can
 * be asserted in a test rather than discovered by squinting at a menu bar on a
 * machine none of the CI runners have.
 *
 * The ordering is the order of the questions people actually have. First "is
 * it working", because that is why they clicked. Then the pairing code, which
 * is the one thing they came here to read. Settings after that, and Quit last
 * where it cannot be hit by accident.
 */
export function buildMenu(state: TrayState): TrayItem[] {
  const items: TrayItem[] = [];

  items.push({ id: 'status', label: statusLine(state), enabled: false });

  if (state.pairingCode !== '') {
    items.push({ id: 'sep-code', label: '', separator: true });
    // Clicking copies it. Typing six characters into a headset while reading
    // them off a screen is exactly when a clipboard helps.
    items.push({
      id: TrayAction.COPY_CODE,
      label: `Pairing code  ${state.pairingCode}`,
    });
    if (!state.pairingRegistered) {
      items.push({ id: 'pair-warn', label: '   not reachable — check the network', enabled: false });
    }
  }

  items.push({ id: 'sep-actions', label: '', separator: true });
  items.push({ id: TrayAction.DASHBOARD, label: 'Open dashboard…' });

  if (state.autostart !== 'unsupported') {
    items.push({
      id: TrayAction.AUTOSTART,
      label: 'Start at login',
      checked: state.autostart === 'on',
    });
  }

  items.push({ id: 'sep-quit', label: '', separator: true });
  items.push({ id: TrayAction.QUIT, label: 'Quit VRMC' });

  return items;
}

/**
 * The one line that answers "is it working".
 *
 * Ordered by what would actually be wrong. No MIDI means nothing can reach the
 * DAW however well the headset is connected, so it outranks everything; a
 * headset that has not connected is next; and only when both are fine is the
 * device count worth reporting.
 */
function statusLine(state: TrayState): string {
  if (!state.midiReady) return 'No MIDI port — see the dashboard';
  if (state.clients === 0) return 'Waiting for a headset';
  const devices =
    state.devices === 1 ? '1 device' : `${state.devices} devices`;
  return `Connected · ${devices}`;
}

/** The hover text. Short: a tooltip is truncated at 128 characters. */
export function buildTooltip(state: TrayState): string {
  return `VRMC — ${statusLine(state)}`;
}
