import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PacketKind,
  PacketWriter,
  ledCapacity,
  writeDeviceState,
  writeLedEntry,
  writeLedHeader,
  type DeviceStateEntry,
} from '@vrmc/protocol';
import type { Router } from '../core/Router.js';

export interface WsOptions {
  port: number;
  host: string;
  /** Paths to a TLS cert/key pair. When set, the server speaks wss://. */
  tlsCert?: string;
  tlsKey?: string;
  onLog: (message: string) => void;
}

/**
 * WebSocket transport — the path a WebXR client uses.
 *
 * A browser cannot open a UDP socket, so for the WebXR build this is the only
 * option. That is less of a compromise than it sounds on a quiet 5 GHz link:
 * TCP's cost is retransmission delay under loss, and on a clean local network
 * carrying a few kB/s there is very little loss to retransmit. The settings
 * that actually matter are below.
 *
 * TLS matters here for a reason that catches people out: a page served over
 * HTTPS cannot open a plain `ws://` connection — browsers block it as mixed
 * content — and WebXR itself only runs in a secure context. So a client hosted
 * on a public HTTPS site can only reach a bridge that speaks `wss://`. Pass
 * --tls-cert/--tls-key to enable it. See docs/WEB-DEPLOYMENT.md.
 */
export class WsServer {
  private wss: WebSocketServer | null = null;
  private http: HttpServer | null = null;
  private readonly options: WsOptions;
  private readonly router: Router;

  /** One reusable writer for replies. Only ever used on this thread. */
  private readonly replyWriter = new PacketWriter();

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
  private ledFlushTimer: NodeJS.Timeout | null = null;

  private clients = 0;
  private readonly sockets = new Set<WebSocket>();

  constructor(router: Router, options: WsOptions) {
    this.router = router;
    this.options = options;
  }

  get clientCount(): number {
    return this.clients;
  }

  get secure(): boolean {
    return Boolean(this.options.tlsCert && this.options.tlsKey);
  }

  async listen(): Promise<void> {
    const { port, host, tlsCert, tlsKey, onLog } = this.options;

    const server =
      tlsCert && tlsKey
        ? createHttpsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) })
        : createHttpServer();
    this.http = server as HttpServer;

    // A plain GET is answered so the user can point a browser at the bridge to
    // confirm it is reachable — and, over TLS, so they can accept a
    // self-signed certificate before the WebSocket handshake needs it.
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          service: 'vrmc-bridge',
          transport: 'websocket',
          secure: this.secure,
          clients: this.clients,
          devices: this.deviceCount(),
        }),
      );
    });

    const wss = new WebSocketServer({ server, perMessageDeflate: false });
    this.wss = wss;

    wss.on('connection', (socket, req) => {
      this.clients++;
      this.sockets.add(socket);
      const peer = req.socket.remoteAddress ?? 'unknown';

      // Nagle batches small writes to save packets. Our packets *are* small and
      // we want each one out immediately, so it must go.
      req.socket.setNoDelay(true);

      onLog(`client connected from ${peer} (${this.clients} active)`);

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (!isBinary) return;
        const arrival = performance.now();
        const bytes = toBytes(data);
        if (bytes === null) return;
        this.router.handlePacket(bytes, arrival, (clientTime, serverTime) => {
          this.sendPong(socket, clientTime, serverTime);
        });
      });

      socket.on('close', () => {
        this.clients--;
        this.sockets.delete(socket);
        // The client is gone and cannot send the Note Offs it owes. Release
        // whatever it left sounding, or the synth holds those voices forever.
        const released = this.router.releaseAll();
        onLog(
          `client ${peer} disconnected` +
            (released > 0 ? `; released ${released} stuck note(s)` : ''),
        );
      });

      socket.on('error', (err: Error) => {
        onLog(`client ${peer} error: ${err.message}`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** How many devices the bridge currently has open. Set by the owner. */
  deviceCount: () => number = () => 0;

  /**
   * Queue an LED change for the headset.
   *
   * Called from the MIDI input callback, which is the DAW's thread of control —
   * so it does nothing but record the value and arm a timer.
   */
  queueLed(deviceId: number, ledIndex: number, r: number, g: number, b: number, blink: number): void {
    if (this.clients === 0) return;
    this.pendingLeds.set(
      deviceId * 256 + ledIndex,
      (r & 0x3f) | ((g & 0x3f) << 6) | ((b & 0x3f) << 12) | ((blink & 0x3) << 18),
    );
    if (this.ledFlushTimer === null) {
      // setImmediate rather than a millisecond timer: this fires at the end of
      // the current event-loop turn, so a burst of writes from one DAW redraw
      // coalesces into one packet with no added latency.
      this.ledFlushTimer = setImmediate(() => this.flushLeds()) as unknown as NodeJS.Timeout;
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
        const w = this.replyWriter;
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
        this.broadcast(w.finish(performance.now()));
      }
    }
  }

  /** Push the device roster to every connected headset. */
  sendRoster(entries: readonly DeviceStateEntry[]): void {
    if (this.clients === 0) return;
    const w = this.replyWriter;
    w.begin(PacketKind.DEVICE_STATE);
    if (!writeDeviceState(w, entries)) return;
    this.broadcast(w.finish(performance.now()));
  }

  /**
   * Send to every client.
   *
   * `frame` aliases the writer's buffer, and `ws.send` copies synchronously, so
   * it stays valid across the loop.
   */
  private broadcast(frame: Uint8Array): void {
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(frame, { binary: true });
    }
  }

  private sendPong(socket: WebSocket, clientTime: number, serverTime: number): void {
    const w = this.replyWriter;
    w.begin(PacketKind.PONG);
    w.pushFloat64(serverTime);
    // finish() stamps the client's own send time into the header, so the client
    // can derive the round trip from this reply alone.
    socket.send(w.finish(clientTime), { binary: true });
  }

  async close(): Promise<void> {
    if (this.ledFlushTimer !== null) clearImmediate(this.ledFlushTimer as unknown as NodeJS.Immediate);
    this.wss?.clients.forEach((c) => c.terminate());
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (this.http === null) return resolve();
      this.http.close(() => resolve());
    });
  }
}

/** Normalise the several shapes `ws` can hand a message handler. */
function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return null;
}
