// SPDX-License-Identifier: GPL-3.0-only

import {
  DecodeError,
  PacketKind,
  PacketReader,
  describeDecodeError,
  readDeviceAdd,
  readDeviceRemove,
  readSysEx,
  type EventVisitor,
} from '@vrmc/protocol';
import type { DeviceManager } from '../devices/DeviceManager.js';
import { LinkStats } from './Stats.js';

/**
 * How a transport answers a PING.
 *
 * The client's own send time is echoed back rather than the sequence number:
 * that lets the client compute the round trip from the reply alone, with no
 * table of outstanding pings to keep (or to leak).
 */
export type PongResponder = (clientTime: number, serverTime: number) => void;

export interface RouterEvents {
  /**
   * A client answered a PING the bridge sent.
   *
   * The bridge normally only *answers* pings; the audit reverses that to prove
   * the return path works, so the reply needs somewhere to land.
   */
  onPong?: () => void;
  onPanic?: (releasedNotes: number) => void;
  onHello?: (clientName: string) => void;
  onBye?: () => void;
  onMalformed?: (reason: string) => void;
  /** A device was added or removed; the roster should be pushed back. */
  onRosterChange?: () => void;
}

/**
 * Turns received packets into MIDI, and device requests into real ports.
 *
 * One router per bridge, shared by every transport. Routing is by device
 * instance id, so several emulated devices can be live at once and a note
 * started on one cannot be released on another.
 *
 * The event path stays synchronous and allocation-free inside the socket
 * callback. Device creation is the exception — opening a port is genuinely
 * asynchronous — so it is dispatched and awaited off to the side rather than
 * blocking the packets behind it.
 */
export class Router {
  readonly stats = new LinkStats();
  private readonly reader = new PacketReader();
  private readonly devices: DeviceManager;
  private readonly events: RouterEvents;

  /**
   * The event visitor, bound once at construction.
   *
   * Passing `this.visit` as a method reference would allocate a bound function
   * per packet; a field arrow function is created once and reused forever.
   */
  private readonly visitor: EventVisitor;

  constructor(devices: DeviceManager, events: RouterEvents = {}) {
    this.devices = devices;
    this.events = events;
    this.visitor = (type, channel, data1, data2, value14, deviceId) => {
      this.devices.handleEvent(deviceId, type, channel, data1, data2, value14);
    };
  }

  /**
   * Handle one datagram or WebSocket frame.
   *
   * @param arrivalMs receive timestamp on the bridge's clock
   * @param pong      invoked for PING packets; the transport sends the reply
   */
  handlePacket(data: Uint8Array, arrivalMs: number, pong?: PongResponder): void {
    const err = this.reader.read(data, this.visitor);
    if (err !== DecodeError.OK) {
      this.stats.onMalformed();
      this.events.onMalformed?.(describeDecodeError(err));
      return;
    }

    const h = this.reader.header;
    switch (h.kind) {
      case PacketKind.EVENTS:
        this.stats.onPacket(h.seq, h.tClient, arrivalMs, h.count);
        break;

      case PacketKind.PING:
        pong?.(h.tClient, arrivalMs);
        break;

      case PacketKind.PONG:
        this.events.onPong?.();
        break;

      case PacketKind.PANIC: {
        const released = this.devices.panicAll();
        this.events.onPanic?.(released);
        break;
      }

      case PacketKind.HELLO:
        this.events.onHello?.(decodeName(this.reader.bodyView()));
        break;

      case PacketKind.BYE:
        this.devices.panicAll();
        this.events.onBye?.();
        break;

      case PacketKind.DEVICE_ADD: {
        const request = readDeviceAdd(this.reader.bodyView());
        if (request === null) {
          this.stats.onMalformed();
          return;
        }
        // Opening a port is genuinely async. Fire it off rather than making
        // every packet queued behind this one wait for a driver call.
        void this.devices
          .add(request.deviceId, request.model)
          .then(() => this.events.onRosterChange?.());
        break;
      }

      case PacketKind.DEVICE_REMOVE: {
        const id = readDeviceRemove(this.reader.bodyView());
        if (id < 0) {
          this.stats.onMalformed();
          return;
        }
        if (this.devices.remove(id)) this.events.onRosterChange?.();
        break;
      }

      case PacketKind.SYSEX: {
        const message = readSysEx(this.reader.bodyView());
        if (message === null) {
          this.stats.onMalformed();
          return;
        }
        this.devices.sendSysEx(message.deviceId, message.bytes);
        break;
      }

      default:
        // An unknown kind from a newer client. The version check already
        // passed, so ignore it rather than dropping the connection.
        break;
    }
  }

  /** Notes sounding across every device. */
  get activeNotes(): number {
    return this.devices.activeNotes;
  }

  /** Release every sounding note across all devices. */
  releaseAll(): number {
    return this.devices.panicAll();
  }
}

const decoder = new TextDecoder();

function decodeName(body: Uint8Array): string {
  return decoder.decode(body).replace(/\0+$/, '');
}
