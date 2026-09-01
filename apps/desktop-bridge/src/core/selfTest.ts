// SPDX-License-Identifier: GPL-3.0-only

import { specFor } from '@vrmc/devices';
import { DeviceStatus, EventType } from '@vrmc/protocol';
import type { DeviceManager } from '../devices/DeviceManager.js';
import type { SelfTestResult } from '../net/dashboard.js';

/** The slice of WsServer the audit needs. Narrow, so tests can stand it in. */
export interface AuditTarget {
  readonly clientCount: number;
  pingClients(timeoutMs?: number): Promise<number>;
  queueLed(deviceId: number, ledIndex: number, r: number, g: number, b: number, blink: number): void;
}

/** Shown on the dashboard. Kept in step with the package manifest by hand. */
export const BRIDGE_VERSION = '0.1.0';

/**
 * One leg of the audit.
 *
 * Each test exercises a single hop, so a failure names the broken link rather
 * than reporting that "it does not work". The three hops are: the bridge can
 * reach the headset and hear it reply; the bridge can push LED state the
 * headset will render; and the bridge can put a note into the DAW.
 */
export async function runSelfTest(
  what: string,
  ws: AuditTarget,
  devices: DeviceManager,
): Promise<SelfTestResult> {
  switch (what) {
    case 'headset': {
      if (ws.clientCount === 0) return { ok: false, detail: 'no headset connected' };
      const rtt = await ws.pingClients();
      return { ok: true, detail: `round trip ${rtt.toFixed(1)} ms` };
    }

    case 'leds': {
      if (ws.clientCount === 0) return { ok: false, detail: 'no headset connected' };
      // Only emulated hardware has LEDs. Picking the first ready device would
      // happily "succeed" against the generic pad surface and light nothing,
      // which is the one outcome an audit must never produce.
      const target = devices
        .roster()
        .find((d) => d.status === DeviceStatus.READY && specFor(d.model) !== null);
      if (target === undefined) {
        return { ok: false, detail: 'no device with LEDs — add a Launchpad in the headset' };
      }
      // Sweep the bottom row of the grid. Visible in the headset without being
      // mistaken for something the DAW did, and it is undone a moment later.
      for (let col = 1; col <= 8; col++) {
        ws.queueLed(target.deviceId, 10 + col, 63, 0, 40, 0);
      }
      setTimeout(() => {
        for (let col = 1; col <= 8; col++) ws.queueLed(target.deviceId, 10 + col, 0, 0, 0, 0);
      }, 1200);
      return { ok: true, detail: `lit 8 pads on device ${target.deviceId} for a moment` };
    }

    case 'midi': {
      const target = devices.roster().find((d) => d.status === DeviceStatus.READY);
      if (target === undefined) return { ok: false, detail: 'no MIDI port open' };
      // Middle C, brief. On an emulated Launchpad this is control index 11 —
      // the bottom-left pad — which its emulator turns into the right message.
      const note = 11;
      devices.handleEvent(target.deviceId, EventType.NOTE_ON, 0, note, 100, 0);
      setTimeout(() => {
        devices.handleEvent(target.deviceId, EventType.NOTE_OFF, 0, note, 0, 0);
      }, 250);
      return { ok: true, detail: `sent a note on "${target.detail || target.model}"` };
    }

    default:
      return { ok: false, detail: `unknown test "${what}"` };
  }
}
