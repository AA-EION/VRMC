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
  /**
   * Where the CoreMIDI driver is installed, if anywhere.
   *
   * Not merely cosmetic: it decides whether the row offers to install or to
   * remove, and those are opposite actions behind one place in the menu.
   */
  driver: DriverState;
  /** Where the dashboard lives, for the label. */
  dashboardUrl: string;
  autostart: AutostartState;
}

/**
 * What the menu knows about the CoreMIDI driver.
 *
 * `unavailable` is the build that ships without one — Windows and Linux, and
 * any macOS build made without running the driver's own build script. It is not
 * an error, and the row is simply absent rather than offering something that
 * cannot happen.
 */
export type DriverState = 'unavailable' | 'absent' | 'user' | 'system';

/** Ids the bridge acts on. Kept here so the handler and the menu agree. */
export const TrayAction = {
  COPY_CODE: 'copy-code',
  DASHBOARD: 'dashboard',
  AUTOSTART: 'autostart',
  INSTALL_DRIVER: 'install-driver',
  UNINSTALL_DRIVER: 'uninstall-driver',
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

  /*
   * One row, two actions, and never both at once.
   *
   * Offering "Install" and "Uninstall" side by side would put a destructive
   * action one slip away from the one people want, for no gain — the state is
   * known, so the menu can simply say what the next step is.
   *
   * The explanatory line under "Install" is there because the benefit is not
   * guessable from the words: what the driver buys is the ports appearing as
   * one device the way real hardware does, and without saying so it reads as
   * an optional extra nobody would choose.
   */
  if (state.driver === 'absent') {
    items.push({ id: TrayAction.INSTALL_DRIVER, label: 'Install the MIDI driver' });
    items.push({
      id: 'driver-why',
      label: '   makes the ports appear as one device',
      enabled: false,
    });
  } else if (state.driver === 'user' || state.driver === 'system') {
    /*
     * Named states, not `!== 'unavailable'`.
     *
     * That was the first version and it was the wrong way round: any state the
     * menu did not recognise — an unset field, a value from a newer build —
     * fell through to offering *removal*. An unknown state must not put a
     * destructive action in front of somebody, and the safe direction here is
     * to say nothing.
     */
    items.push({
      id: TrayAction.UNINSTALL_DRIVER,
      label:
        state.driver === 'system'
          ? 'Remove the MIDI driver (all users)…'
          : 'Remove the MIDI driver',
    });
  }

  if (state.autostart !== 'unsupported') {
    items.push({
      id: TrayAction.AUTOSTART,
      label: 'Start at login',
      // `approval` is registered but held: ticking it would say the bridge
      // comes back after a reboot, and it does not until the user allows it.
      checked: state.autostart === 'on',
    });
    if (state.autostart === 'approval') {
      items.push({
        id: 'autostart-approval',
        label: '   allow it in Settings › General › Login Items',
        enabled: false,
      });
    }
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
