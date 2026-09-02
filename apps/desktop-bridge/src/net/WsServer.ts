import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { PacketKind, PacketWriter } from '@vrmc/protocol';
import type { Router } from '../core/Router.js';
import type { PacketSink } from './Broadcaster.js';
import { dashboardHtml, type DashboardStatus, type SelfTestResult } from './dashboard.js';

export interface WsOptions {
  port: number;
  host: string;
  /** Paths to a TLS cert/key pair. When set, the server speaks wss://. */
  tlsCert?: string;
  tlsKey?: string;
  onLog: (message: string) => void;
  /**
   * Called with the live client count whenever it changes.
   *
   * The MIDI ports follow it: they exist while somebody is connected and not
   * otherwise, so a Mac running the bridge alone does not list instruments
   * nobody can play. See core/PresenceGate.ts. RtcTransport reports the same
   * thing through `onPeerChange`; only the sum of the two means anything.
   */
  onClientChange?: (clients: number) => void;
}

/**
 * WebSocket transport, and the host of the local dashboard.
 *
 * This is no longer how a headset arrives. A page served over HTTPS cannot open
 * a plain `ws://` connection — browsers block it as mixed content — and a
 * computer on a home network cannot have a certificate a public authority
 * would sign, so the hosted client reaches the bridge over a WebRTC data
 * channel instead (see RtcTransport). What is left here is the case where the
 * client and the bridge are on the same machine, where `ws://` is already a
 * secure context: the dashboard, and development.
 *
 * TCP is a poor fit for MIDI — one lost packet stalls every packet behind it —
 * which is another reason the data channel is the primary path. On a loopback
 * connection there is nothing to lose, so it does not matter here. The settings
 * that do matter are below.
 */
export class WsServer implements PacketSink {
  private wss: WebSocketServer | null = null;
  private http: HttpServer | null = null;
  private readonly options: WsOptions;
  private readonly router: Router;

  /** One reusable writer for replies. Only ever used on this thread. */
  private readonly replyWriter = new PacketWriter();

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
      this.options.onClientChange?.(this.clients);
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
        this.options.onClientChange?.(this.clients);
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
   * Send to every client. This is the `PacketSink` half of the transport.
   *
   * `frame` aliases the caller's buffer, and `ws.send` copies synchronously, so
   * it stays valid across the loop.
   */
  send(frame: Uint8Array): void {
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
