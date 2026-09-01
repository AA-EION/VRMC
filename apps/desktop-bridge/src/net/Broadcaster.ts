// SPDX-License-Identifier: GPL-3.0-only

import {
  PacketKind,
  PacketWriter,
  ledCapacity,
  writeDeviceState,
  writeLedEntry,
  writeLedHeader,
  type DeviceStateEntry,
} from '@vrmc/protocol';
import type { LinkStats } from '../core/Stats.js';

/** Somewhere packets can be sent to every headset it holds. */
export interface PacketSink {
  /** How many headsets this sink can currently reach. */
  readonly clientCount: number;
  send(frame: Uint8Array): void;
}

/**
 * Fans bridge-to-headset traffic out across every transport at once.
 *
 * There are two ways in — a WebSocket for a client on the same machine or a
 * plain-HTTP page, and a WebRTC data channel for one served over HTTPS from the
 * website — and the outbound half is identical for both. Keeping the LED
 * coalescing here rather than in each transport means a burst of writes
 * collapses into one packet regardless of how many transports are listening,
 * and there is exactly one place where the batching rules live.
 */
export class Broadcaster {
  private readonly sinks: PacketSink[] = [];
  private readonly stats: LinkStats;

  /** One reusable writer. Only ever used on this thread. */
  private readonly writer = new PacketWriter();

  /**
   * LED changes accumulated since the last flush.
   *
   * A DAW redrawing a Launchpad emits its writes one LED at a time, so a single
   * scene change can be sixty-odd separate callbacks within a millisecond.
   * Sending a packet each would put sixty frames on the wire for one visual
   * change; coalescing to one packet per tick collapses them. The delay is
   * bounded by the flush interval and is well under a display frame.
   *
   * Keyed by `deviceId * 256 + ledIndex` so a later write to the same LED
   * replaces the earlier one rather than both being sent.
   */
  private readonly pendingLeds = new Map<number, number>();
  private ledFlushTimer: NodeJS.Immediate | null = null;

  /** Resolvers waiting for a client's PONG, for the audit's round-trip test. */
  private readonly pongWaiters = new Set<() => void>();

  constructor(stats: LinkStats) {
    this.stats = stats;
  }

  add(sink: PacketSink): void {
    this.sinks.push(sink);
  }

  get clientCount(): number {
    let total = 0;
    for (const sink of this.sinks) total += sink.clientCount;
    return total;
  }

  /**
   * Queue an LED change for the headset.
   *
   * Called from the MIDI input callback, which is the DAW's thread of control —
   * so it does nothing but record the value and arm a timer.
   */
  queueLed(
    deviceId: number,
    ledIndex: number,
    r: number,
    g: number,
    b: number,
    blink: number,
  ): void {
    if (this.clientCount === 0) return;
    this.pendingLeds.set(
      deviceId * 256 + ledIndex,
      (r & 0x3f) | ((g & 0x3f) << 6) | ((b & 0x3f) << 12) | ((blink & 0x3) << 18),
    );
    if (this.ledFlushTimer === null) {
      // setImmediate rather than a millisecond timer: this fires at the end of
      // the current event-loop turn, so a burst of writes from one DAW redraw
      // coalesces into one packet with no added latency.
      this.ledFlushTimer = setImmediate(() => this.flushLeds());
    }
  }

  /** Send the accumulated LED changes, splitting across packets if needed. */
  private flushLeds(): void {
    this.ledFlushTimer = null;
    if (this.pendingLeds.size === 0) return;

    // Group by device, since one packet carries one device's LEDs.
    const byDevice = new Map<number, Array<[number, number]>>();
    for (const [key, packed] of this.pendingLeds) {
      const deviceId = Math.floor(key / 256);
      const ledIndex = key % 256;
      let list = byDevice.get(deviceId);
      if (list === undefined) {
        list = [];
        byDevice.set(deviceId, list);
      }
      list.push([ledIndex, packed]);
    }
    this.pendingLeds.clear();

    const capacity = ledCapacity();
    for (const [deviceId, entries] of byDevice) {
      for (let start = 0; start < entries.length; start += capacity) {
        const chunk = entries.slice(start, start + capacity);
        const w = this.writer;
        w.begin(PacketKind.LED_UPDATE);
        writeLedHeader(w, deviceId, chunk.length);
        for (const [ledIndex, packed] of chunk) {
          writeLedEntry(
            w,
            ledIndex,
            packed & 0x3f,
            (packed >> 6) & 0x3f,
            (packed >> 12) & 0x3f,
            (packed >> 18) & 0x3,
          );
        }
        this.send(w.finish(performance.now()));
        this.stats.onOutbound(chunk.length);
      }
    }
  }

  /** Push the device roster to every connected headset. */
  sendRoster(entries: readonly DeviceStateEntry[]): void {
    if (this.clientCount === 0) return;
    const w = this.writer;
    w.begin(PacketKind.DEVICE_STATE);
    if (!writeDeviceState(w, entries)) return;
    this.send(w.finish(performance.now()));
  }

  /**
   * Send a PING to every client and resolve when one answers.
   *
   * This is the audit's proof that the link works in both directions: the
   * packet leaves the bridge, the headset receives it, and its reply comes
   * back. A test that only counted inbound packets would pass while the return
   * path — the one LEDs depend on — was broken.
   */
  pingClients(timeoutMs = 2000): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.clientCount === 0) {
        reject(new Error('no headset connected'));
        return;
      }
      const started = performance.now();
      const onPong = (): void => {
        clearTimeout(timer);
        this.pongWaiters.delete(onPong);
        resolve(performance.now() - started);
      };
      const timer = setTimeout(() => {
        this.pongWaiters.delete(onPong);
        reject(new Error(`no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pongWaiters.add(onPong);

      const w = this.writer;
      w.begin(PacketKind.PING);
      this.send(w.finish(performance.now()));
    });
  }

  /** Called when a client answers a PING the bridge sent. */
  notePong(): void {
    for (const waiter of [...this.pongWaiters]) waiter();
  }

  /**
   * Send one frame to every transport.
   *
   * `frame` aliases the writer's buffer, and every sink copies synchronously,
   * so it stays valid across the loop.
   */
  send(frame: Uint8Array): void {
    for (const sink of this.sinks) sink.send(frame);
  }

  close(): void {
    if (this.ledFlushTimer !== null) clearImmediate(this.ledFlushTimer);
    this.ledFlushTimer = null;
    this.pendingLeds.clear();
  }
}
