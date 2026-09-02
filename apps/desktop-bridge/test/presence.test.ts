// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { PresenceGate } from '../src/core/PresenceGate.js';

/**
 * Ports following the headset.
 *
 * A virtual MIDI port is published system-wide the instant it opens, so this
 * decides whether a Mac running the bridge shows a Launchpad that nobody is
 * playing. The timers are injected: none of this should take real seconds.
 */
function harness(graceMs = 10_000) {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const opened: number[] = [];
  const closed: number[] = [];
  let tick = 0;

  const gate = new PresenceGate({
    graceMs,
    onOpen: async () => {
      opened.push(tick++);
    },
    onClose: () => {
      closed.push(tick++);
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cancelled: false });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      const t = timers[handle as number];
      if (t !== undefined) t.cancelled = true;
    },
  });

  /** Run every timer that is still armed, as if its delay had elapsed. */
  const elapse = (): void => {
    for (const t of timers) {
      if (!t.cancelled) {
        t.cancelled = true;
        t.fn();
      }
    }
  };

  return { gate, opened, closed, timers, elapse };
}

describe('opening', () => {
  it('opens the ports when the first client arrives', async () => {
    const h = harness();
    expect(h.gate.isOpen).toBe(false);
    expect(h.opened).toHaveLength(0);

    await h.gate.update(1);
    expect(h.gate.isOpen).toBe(true);
    expect(h.opened).toHaveLength(1);
  });

  it('opens nothing before anybody connects', async () => {
    // The whole point. The bridge used to publish three CoreMIDI endpoints at
    // startup, so a Mac with it merely running listed a Launchpad X that was
    // not there and could not be played.
    const h = harness();
    await h.gate.update(0);
    expect(h.opened).toHaveLength(0);
    expect(h.closed).toHaveLength(0);
  });

  it('does not open a second set for a second client', async () => {
    // A headset on WebRTC and the dashboard on WebSocket are two clients of
    // one session. Opening again would publish a duplicate set of endpoints
    // under the same names — which CoreMIDI allows, so nothing would complain.
    const h = harness();
    await h.gate.update(1);
    await h.gate.update(2);
    expect(h.opened).toHaveLength(1);
  });

  it('does not open twice when two clients arrive during one slow open', async () => {
    /*
     * Opening is a series of calls into CoreMIDI, and a headset can arrive,
     * drop and return inside that window. Both arrivals would see a gate that
     * had not finished opening.
     */
    let release: (() => void) | null = null;
    const opens: number[] = [];
    const gate = new PresenceGate({
      graceMs: 1000,
      onOpen: () => {
        opens.push(1);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      onClose: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });

    const first = gate.update(1);
    const second = gate.update(2);
    expect(opens).toHaveLength(1);
    release!();
    await Promise.all([first, second]);
    expect(opens).toHaveLength(1);
  });

  it('can try again after a failed open', async () => {
    // A gate that stayed "open" after a failure would never retry, and the
    // session would have no MIDI until the bridge was restarted.
    let attempt = 0;
    const gate = new PresenceGate({
      graceMs: 1000,
      onOpen: async () => {
        attempt++;
        if (attempt === 1) throw new Error('CoreMIDI said no');
      },
      onClose: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });

    await gate.update(1);
    expect(gate.isOpen).toBe(false);
    await gate.update(1);
    expect(attempt).toBe(2);
    expect(gate.isOpen).toBe(true);
  });
});

describe('the grace period', () => {
  it('does not close the moment the last client goes', async () => {
    /*
     * Headset Wi-Fi drops for a second at a time. A DAW that sees a control
     * surface vanish does not wait politely — Ableton unbinds the script, and
     * rebinding is a manual trip through Preferences. So a blip must cost
     * nothing.
     */
    const h = harness();
    await h.gate.update(1);
    await h.gate.update(0);

    expect(h.closed).toHaveLength(0);
    expect(h.gate.isOpen).toBe(true);
    expect(h.gate.isClosing).toBe(true);
  });

  it('closes once the grace period passes with nobody there', async () => {
    const h = harness();
    await h.gate.update(1);
    await h.gate.update(0);
    h.elapse();

    expect(h.closed).toHaveLength(1);
    expect(h.gate.isOpen).toBe(false);
  });

  it('keeps the ports open when a client returns in time', async () => {
    const h = harness();
    await h.gate.update(1);
    await h.gate.update(0);
    await h.gate.update(1);
    h.elapse();

    // Not reopened either: the ports never went, so the DAW's binding held and
    // there was nothing to rebuild.
    expect(h.closed).toHaveLength(0);
    expect(h.opened).toHaveLength(1);
    expect(h.gate.isOpen).toBe(true);
  });

  it('waits the configured time, not some other time', async () => {
    const h = harness(4321);
    await h.gate.update(1);
    await h.gate.update(0);
    expect(h.timers.at(-1)?.ms).toBe(4321);
  });

  it('arms one timer for a flapping connection, not one per drop', async () => {
    // A connection dropping repeatedly should not stack teardowns, or the
    // ports close on the first timer's schedule regardless of who is there.
    const h = harness();
    await h.gate.update(1);
    await h.gate.update(0);
    await h.gate.update(0);
    await h.gate.update(0);
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it('reopens after a real departure', async () => {
    const h = harness();
    await h.gate.update(1);
    await h.gate.update(0);
    h.elapse();
    await h.gate.update(1);

    expect(h.opened).toHaveLength(2);
    expect(h.closed).toHaveLength(1);
    expect(h.gate.isOpen).toBe(true);
  });
});

describe('shutting down', () => {
  it('closes immediately rather than waiting out the grace period', async () => {
    // The process is leaving. Waiting even a tick risks exiting with the ports
    // still published, which leaves them in the DAW until it rescans.
    const h = harness();
    await h.gate.update(1);
    h.gate.dispose();
    expect(h.closed).toHaveLength(1);
  });

  it('cancels a pending close rather than closing twice', async () => {
    const h = harness();
    await h.gate.update(1);
    await h.gate.update(0);
    h.gate.dispose();
    h.elapse();
    expect(h.closed).toHaveLength(1);
  });

  it('does nothing when nothing was ever opened', () => {
    const h = harness();
    h.gate.dispose();
    expect(h.closed).toHaveLength(0);
  });
});

describe('reporting', () => {
  it('says why the ports went, and why they stayed', async () => {
    const onLog = vi.fn();
    const timers: (() => void)[] = [];
    const gate = new PresenceGate({
      graceMs: 10,
      onOpen: async () => {},
      onClose: () => {},
      onLog,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimer: () => {},
    });

    await gate.update(1);
    await gate.update(0);
    await gate.update(1);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('returned within the grace period'));

    await gate.update(0);
    timers.at(-1)!();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('closing the MIDI ports'));
  });
});
