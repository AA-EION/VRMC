import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
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
import { dashboardHtml, type DashboardStatus, type SelfTestResult } from './dashboard.js';

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

    server.on('request', (req, res) => {
      void this.handleHttp(req, res);
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

  /** Supplies everything the dashboard shows. Set by the owner at startup. */
  statusProvider: (() => DashboardStatus) | null = null;

  /** Runs one audit leg. Set by the owner. */
  selfTest: ((what: string) => Promise<SelfTestResult>) | null = null;

  /** Resolvers waiting for a client's PONG, for the audit's round-trip test. */
  private readonly pongWaiters = new Set<() => void>();

  /**
   * Serve the dashboard, the status JSON and the self-tests.
   *
   * Everything except the reachability probe is restricted to loopback. The
   * WebSocket has to accept LAN connections — that is the whole point — but the
   * dashboard can trigger MIDI and reveal the machine's addresses, and nothing
   * on the network besides the person at the keyboard has business doing that.
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const local = isLoopback(req.socket.remoteAddress ?? '');

    // Answered for anyone, including over TLS, so a headset can confirm the
    // bridge is reachable and accept a self-signed certificate before the
    // WebSocket handshake needs it.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'vrmc-bridge', secure: this.secure }));
      return;
    }

    if (!local) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('The VRMC dashboard is only reachable from this computer.\n');
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(dashboardHtml());
      return;
    }

    if (url.pathname === '/api/status') {
      const status = this.statusProvider?.() ?? null;
      res.writeHead(status === null ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status ?? { error: 'status unavailable' }));
      return;
    }

    if (url.pathname === '/api/selftest' && req.method === 'POST') {
      const what = url.searchParams.get('what') ?? '';
      const runner = this.selfTest;
      const result: SelfTestResult =
        runner === null
          ? { ok: false, detail: 'self-tests are not wired up' }
          : await runner(what).catch((err: unknown) => ({
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
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
      if (this.clients === 0) {
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

      const w = this.replyWriter;
      w.begin(PacketKind.PING);
      this.broadcast(w.finish(performance.now()));
    });
  }

  /** Called when a client answers a PING the bridge sent. */
  notePong(): void {
    for (const waiter of [...this.pongWaiters]) waiter();
  }

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
        this.router.stats.onOutbound(chunk.length);
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

/**
 * Whether a connection came from this machine.
 *
 * Node reports IPv4 loopback over a dual-stack socket as `::ffff:127.0.0.1`, so
 * the mapped form has to be recognised too, or the dashboard would refuse the
 * very browser it exists for.
 */
function isLoopback(address: string): boolean {
  if (address === '::1' || address === '127.0.0.1') return true;
  if (address.startsWith('::ffff:')) return isLoopback(address.slice(7));
  return address.startsWith('127.');
}

/** Normalise the several shapes `ws` can hand a message handler. */
function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return null;
}
