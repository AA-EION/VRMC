import {
  EventType,
  PacketKind,
  PacketReader,
  PacketWriter,
  MAX_EVENTS_PER_PACKET,
  readDeviceState,
  readLayoutState,
  readLedUpdate,
  readLinkStats,
  writeDeviceAdd,
  writeDevicePose,
  writeDeviceRemove,
  writeLayoutName,
  writeLayoutSave,
  type DevicePlacement,
  type DeviceStateEntry,
  type Layout,
  type LayoutState,
  type LedVisitor,
  type LinkQuality,
} from '@vrmc/protocol';
import type { Transport, TransportFactory } from './Transport.js';

export type LinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface LinkStatus {
  state: LinkState;
  /** Most recent round trip, in ms. -1 before the first pong. */
  rttMs: number;
  /** Best round trip seen. The floor the link is capable of. */
  bestRttMs: number;
  /** Packets sent this session. */
  packetsSent: number;
  eventsSent: number;
  /** Events discarded because the link could not keep up. */
  eventsDropped: number;
  /** Where the link points, for display. */
  url: string;
  lastError: string;
  /**
   * What the bridge sees from its end, or null before the first push.
   *
   * Round trip above is measured here; jitter and loss are not measurable here
   * at all. They are the variation in transit time and the gaps in the sequence
   * number, both of which only exist where the packets land.
   */
  quality: LinkQuality | null;
}

/**
 * How much unsent data may sit in the transport before we start shedding load.
 *
 * A backed-up link cannot carry what we are producing. The
 * wrong response is to keep queueing: every queued packet delays the ones
 * behind it, so a moment of congestion turns into seconds of steadily worse
 * latency and the instrument feels like it is lagging further behind the
 * longer you play. Better to drop what is least musically important and stay
 * current.
 */
const BACKPRESSURE_BYTES = 8 * 1024;

/** Interval between latency probes. */
const PING_INTERVAL_MS = 1000;

/** Reconnect backoff, in ms. Repeats the last value once exhausted. */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;

/**
 * The link from the headset to the desktop bridge.
 *
 * Transport-agnostic on purpose: it drives a WebSocket when the client runs on
 * the same machine as the bridge, and a WebRTC data channel when it is served
 * from the website, and neither the batching nor the reconnect logic below
 * knows or cares which.
 *
 * Events are batched into one packet per rendered frame rather than sent
 * individually. At 90 Hz a frame is 11 ms, and every event in it carries its
 * own sub-frame offset, so batching costs no timing accuracy — while sending
 * ten separate packets for a ten-finger chord would cost ten syscalls and ten
 * lots of framing overhead for data that all belongs to the same instant.
 */
export class BridgeLink {
  private transport: Transport | null = null;
  private factory: TransportFactory | null = null;
  /** Bumped per connect, so a slow handshake cannot revive a stale attempt. */
  private generation = 0;
  private label = '';
  private readonly writer = new PacketWriter();
  private readonly reader = new PacketReader();
  private readonly controlWriter = new PacketWriter();

  private state: LinkState = 'idle';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  private rttMs = -1;
  private bestRttMs = Number.POSITIVE_INFINITY;
  private packetsSent = 0;
  private eventsSent = 0;
  private eventsDropped = 0;
  private lastError = '';
  private quality: LinkQuality | null = null;

  /** Whether a packet is currently accumulating events. */
  private batching = false;

  /** Called whenever the status changes enough for the UI to care. */
  onStatus: ((status: LinkStatus) => void) | null = null;

  /**
   * Called for each LED the bridge reports as changed.
   *
   * Set once at startup, not per packet: this fires dozens of times per DAW
   * redraw, and allocating a closure per update would put garbage on the frame
   * path it shares with the note loop.
   */
  onLed: ((deviceId: number, ledIndex: number, r: number, g: number, b: number, blink: number) => void) | null =
    null;

  /** Called when the bridge reports its device roster. */
  onDevices: ((devices: DeviceStateEntry[]) => void) | null = null;

  /** Called when the bridge reports its stored arrangements. */
  onLayouts: ((state: LayoutState) => void) | null = null;

  /** Bound once, so decoding an LED packet allocates nothing. */
  private readonly ledVisitor: LedVisitor;
  /** Device id of the LED packet currently being decoded. */
  private ledDeviceId = 0;

  constructor() {
    this.ledVisitor = (ledIndex, r, g, b, blink) => {
      this.onLed?.(this.ledDeviceId, ledIndex, r, g, b, blink);
    };
  }

  get isOpen(): boolean {
    return this.transport?.isOpen === true;
  }

  status(): LinkStatus {
    return {
      state: this.state,
      rttMs: this.rttMs,
      bestRttMs: Number.isFinite(this.bestRttMs) ? this.bestRttMs : -1,
      packetsSent: this.packetsSent,
      eventsSent: this.eventsSent,
      eventsDropped: this.eventsDropped,
      url: this.label,
      lastError: this.lastError,
      quality: this.quality,
    };
  }

  /**
   * Point the link at a bridge and keep it there.
   *
   * `label` is what the status panel shows. The factory is kept, not the
   * transport it produced: reconnecting re-runs it, which for a data channel
   * means a fresh handshake — the only way to rebuild one.
   */
  connect(factory: TransportFactory, label: string): void {
    this.factory = factory;
    this.label = label;
    this.closedByUs = false;
    this.attempt = 0;
    this.open();
  }

  private open(): void {
    const factory = this.factory;
    if (factory === null) return;
    this.teardownTransport();
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const generation = ++this.generation;
    factory().then(
      (transport) => {
        // A connect() while this was in flight already started a newer attempt;
        // this one's transport would otherwise sit open and unreferenced.
        if (generation !== this.generation || this.closedByUs) {
          transport.close();
          return;
        }
        this.transport = transport;
        this.label = transport.label;
        transport.onMessage = (bytes) => this.handleMessage(bytes);
        transport.onClose = (reason) => {
          if (generation !== this.generation) return;
          this.transport = null;
          this.stopPinging();
          if (this.closedByUs) {
            this.setState('idle');
            return;
          }
          this.lastError = reason;
          this.scheduleReconnect();
        };
        this.attempt = 0;
        this.lastError = '';
        this.setState('open');
        this.sendHello();
        this.startPinging();
      },
      (err: unknown) => {
        if (generation !== this.generation || this.closedByUs) return;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.scheduleReconnect();
      },
    );
  }

  private handleMessage(bytes: Uint8Array): void {
    if (this.reader.read(bytes, null) !== 0) return;

    switch (this.reader.header.kind) {
      case PacketKind.PONG: {
        // The bridge echoes our own send time in the header, so the round trip
        // is just the difference — no table of outstanding pings to keep.
        const rtt = performance.now() - this.reader.header.tClient;
        this.rttMs = rtt;
        if (rtt < this.bestRttMs) this.bestRttMs = rtt;
        this.notify();
        return;
      }
      case PacketKind.LED_UPDATE: {
        const body = this.reader.bodyView();
        if (body.length < 3) return;
        this.ledDeviceId = body[0]!;
        readLedUpdate(body, this.ledVisitor);
        return;
      }
      case PacketKind.DEVICE_STATE: {
        // Roster changes are rare and human-paced, so allocating here is fine.
        this.onDevices?.(readDeviceState(this.reader.bodyView()));
        return;
      }
      case PacketKind.LAYOUT_STATE: {
        this.onLayouts?.(readLayoutState(this.reader.bodyView()));
        return;
      }
      case PacketKind.LINK_STATS: {
        const quality = readLinkStats(this.reader.bodyView());
        if (quality === null) return;
        this.quality = quality;
        // Once a second, so this is a status push rather than a frame-path
        // cost — which is why it is allowed to allocate and to notify.
        this.notify();
        return;
      }
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  // --- sending ---

  /**
   * Open a batch for this frame. Call once at the top of the frame loop.
   */
  beginFrame(): void {
    if (!this.isOpen || this.batching) return;
    this.writer.begin(PacketKind.EVENTS);
    this.batching = true;
  }

  /**
   * Queue one event into the current frame's packet.
   *
   * Returns false if it was dropped — either there is no open batch, or the
   * packet is full and the caller should not keep trying.
   */
  push(
    type: number,
    channel: number,
    data1: number,
    data2: number,
    value14: number,
    deviceId: number,
    flags: number,
    tOffsetMs: number,
  ): boolean {
    if (!this.batching) return false;

    if (this.isCongested()) {
      // Shed the least musically important traffic first. Losing an aftertouch
      // update costs a little expression; losing a Note Off strands a voice, so
      // note messages are never dropped here.
      if (type === EventType.AFTERTOUCH_POLY || type === EventType.AFTERTOUCH_CHANNEL) {
        this.eventsDropped++;
        return false;
      }
    }

    if (this.writer.isFull) {
      // 64 events in one frame means something is wrong upstream; flush what we
      // have and start a fresh packet rather than silently discarding.
      this.endFrame();
      this.beginFrame();
      if (!this.batching) {
        this.eventsDropped++;
        return false;
      }
    }

    return this.writer.pushEvent(type, channel, data1, data2, value14, deviceId, flags, tOffsetMs);
  }

  /** Send this frame's packet, if it has anything in it. */
  endFrame(): void {
    if (!this.batching) return;
    this.batching = false;
    const count = this.writer.eventCount;
    if (count === 0) return;
    const transport = this.transport;
    if (transport === null || !transport.isOpen) return;

    transport.send(this.writer.finish(performance.now()));
    this.packetsSent++;
    this.eventsSent += count;
  }

  /** True while the transport has more queued than it should. */
  private isCongested(): boolean {
    const transport = this.transport;
    return transport !== null && transport.bufferedAmount > BACKPRESSURE_BYTES;
  }

  /** Ask the bridge to silence everything. Sent on panic and on teardown. */
  sendPanic(): void {
    this.sendControl(PacketKind.PANIC);
  }

  /**
   * Ask the bridge to create a device, which makes real MIDI ports appear.
   *
   * Sent outside the frame batch: device creation is a user action at human
   * speed, and mixing it into the note packet would delay it behind a frame.
   */
  requestDeviceAdd(deviceId: number, model: string): boolean {
    const transport = this.transport;
    if (transport === null || !transport.isOpen) return false;
    const w = this.controlWriter;
    w.begin(PacketKind.DEVICE_ADD);
    if (!writeDeviceAdd(w, deviceId, model)) return false;
    transport.send(w.finish(performance.now()));
    return true;
  }

  /**
   * Tell the bridge where a device now is.
   *
   * Sent when a grab settles rather than per frame. A hand moving an instrument
   * produces a new pose ninety times a second and the bridge needs exactly one
   * of them — the last — so this is called by the release, not by the drag.
   */
  sendDevicePose(placement: DevicePlacement): boolean {
    const transport = this.transport;
    if (transport === null || !transport.isOpen) return false;
    const w = this.controlWriter;
    w.begin(PacketKind.DEVICE_POSE);
    if (!writeDevicePose(w, placement)) return false;
    transport.send(w.finish(performance.now()));
    return true;
  }

  /** Store the current arrangement under a name. */
  saveLayout(layout: Layout): boolean {
    return this.sendLayout(PacketKind.LAYOUT_SAVE, (w) => writeLayoutSave(w, layout));
  }

  /** Forget a stored arrangement. */
  deleteLayout(name: string): boolean {
    return this.sendLayout(PacketKind.LAYOUT_DELETE, (w) => writeLayoutName(w, name));
  }

  /**
   * Record which arrangement is now in use.
   *
   * The headset has already applied it; this is what lets the next connection
   * hand back the same one.
   */
  applyLayout(name: string): boolean {
    return this.sendLayout(PacketKind.LAYOUT_APPLY, (w) => writeLayoutName(w, name));
  }

  private sendLayout(kind: number, fill: (w: PacketWriter) => boolean): boolean {
    const transport = this.transport;
    if (transport === null || !transport.isOpen) return false;
    const w = this.controlWriter;
    w.begin(kind);
    if (!fill(w)) return false;
    transport.send(w.finish(performance.now()));
    return true;
  }

  /** Ask the bridge to destroy a device and close its ports. */
  requestDeviceRemove(deviceId: number): boolean {
    const transport = this.transport;
    if (transport === null || !transport.isOpen) return false;
    const w = this.controlWriter;
    w.begin(PacketKind.DEVICE_REMOVE);
    if (!writeDeviceRemove(w, deviceId)) return false;
    transport.send(w.finish(performance.now()));
    return true;
  }

  private sendHello(): void {
    const transport = this.transport;
    if (transport === null || !transport.isOpen) return;
    const w = this.controlWriter;
    w.begin(PacketKind.HELLO);
    w.pushRaw(new TextEncoder().encode(navigator.userAgent.slice(0, 96)));
    transport.send(w.finish(performance.now()));
  }

  private sendControl(kind: number): void {
    const transport = this.transport;
    if (transport === null || !transport.isOpen) return;
    const w = this.controlWriter;
    w.begin(kind);
    transport.send(w.finish(performance.now()));
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = setInterval(() => this.sendControl(PacketKind.PING), PING_INTERVAL_MS);
    this.sendControl(PacketKind.PING);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Close the link, releasing any sounding notes first. */
  disconnect(): void {
    this.closedByUs = true;
    // Retires any handshake still in flight, so its transport is closed on
    // arrival rather than quietly connecting after we said goodbye.
    this.generation++;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPinging();
    if (this.isOpen) this.sendControl(PacketKind.BYE);
    this.teardownTransport();
    this.setState('idle');
  }

  private teardownTransport(): void {
    const transport = this.transport;
    if (transport === null) return;
    transport.onMessage = null;
    transport.onClose = null;
    transport.close();
    this.transport = null;
  }

  private setState(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.notify();
  }

  private notify(): void {
    this.onStatus?.(this.status());
  }
}

export { MAX_EVENTS_PER_PACKET };
