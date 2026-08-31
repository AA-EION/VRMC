import {
  EventType,
  PacketKind,
  PacketReader,
  PacketWriter,
  MAX_EVENTS_PER_PACKET,
  readDeviceState,
  readLedUpdate,
  writeDeviceAdd,
  writeDeviceRemove,
  type DeviceStateEntry,
  type LedVisitor,
} from '@vrmc/protocol';

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
  /** Events discarded because the socket could not keep up. */
  eventsDropped: number;
  url: string;
  lastError: string;
}

/**
 * How much unsent data may sit in the socket before we start shedding load.
 *
 * A backed-up socket means the link cannot carry what we are producing. The
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
 * WebSocket link from the headset to the desktop bridge.
 *
 * Events are batched into one packet per rendered frame rather than sent
 * individually. At 90 Hz a frame is 11 ms, and every event in it carries its
 * own sub-frame offset, so batching costs no timing accuracy — while sending
 * ten separate packets for a ten-finger chord would cost ten syscalls and ten
 * lots of framing overhead for data that all belongs to the same instant.
 */
export class BridgeLink {
  private socket: WebSocket | null = null;
  private url: string;
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

  /** Bound once, so decoding an LED packet allocates nothing. */
  private readonly ledVisitor: LedVisitor;
  /** Device id of the LED packet currently being decoded. */
  private ledDeviceId = 0;

  constructor(url: string) {
    this.url = url;
    this.ledVisitor = (ledIndex, r, g, b, blink) => {
      this.onLed?.(this.ledDeviceId, ledIndex, r, g, b, blink);
    };
  }

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  status(): LinkStatus {
    return {
      state: this.state,
      rttMs: this.rttMs,
      bestRttMs: Number.isFinite(this.bestRttMs) ? this.bestRttMs : -1,
      packetsSent: this.packetsSent,
      eventsSent: this.eventsSent,
      eventsDropped: this.eventsDropped,
      url: this.url,
      lastError: this.lastError,
    };
  }

  connect(url?: string): void {
    if (url !== undefined) this.url = url;
    this.closedByUs = false;
    this.attempt = 0;
    this.open();
  }

  private open(): void {
    this.cleanupSocket();
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      // Thrown synchronously for a malformed URL, or for ws:// from an HTTPS
      // page — the mixed-content block that catches out every first deployment.
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState('failed');
      return;
    }

    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      this.sendHello();
      this.startPinging();
    };

    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      this.handleMessage(new Uint8Array(event.data));
    };

    socket.onerror = () => {
      // The event carries no detail by design (it would leak cross-origin
      // information), so there is nothing more useful to record here.
      this.lastError = 'connection error';
    };

    socket.onclose = (event: CloseEvent) => {
      this.stopPinging();
      if (this.closedByUs) {
        this.setState('idle');
        return;
      }
      if (event.reason) this.lastError = event.reason;
      this.scheduleReconnect();
    };
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
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;

    socket.send(this.writer.finish(performance.now()));
    this.packetsSent++;
    this.eventsSent += count;
  }

  /** True while the socket has more queued than it should. */
  private isCongested(): boolean {
    const socket = this.socket;
    return socket !== null && socket.bufferedAmount > BACKPRESSURE_BYTES;
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
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    const w = this.controlWriter;
    w.begin(PacketKind.DEVICE_ADD);
    if (!writeDeviceAdd(w, deviceId, model)) return false;
    socket.send(w.finish(performance.now()));
    return true;
  }

  /** Ask the bridge to destroy a device and close its ports. */
  requestDeviceRemove(deviceId: number): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    const w = this.controlWriter;
    w.begin(PacketKind.DEVICE_REMOVE);
    if (!writeDeviceRemove(w, deviceId)) return false;
    socket.send(w.finish(performance.now()));
    return true;
  }

  private sendHello(): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const w = this.controlWriter;
    w.begin(PacketKind.HELLO);
    w.pushRaw(new TextEncoder().encode(navigator.userAgent.slice(0, 96)));
    socket.send(w.finish(performance.now()));
  }

  private sendControl(kind: number): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const w = this.controlWriter;
    w.begin(kind);
    socket.send(w.finish(performance.now()));
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
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPinging();
    if (this.isOpen) this.sendControl(PacketKind.BYE);
    this.cleanupSocket();
    this.setState('idle');
  }

  private cleanupSocket(): void {
    const socket = this.socket;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    this.socket = null;
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
