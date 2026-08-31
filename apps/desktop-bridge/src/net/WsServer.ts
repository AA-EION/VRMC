import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { PacketKind, PacketWriter } from '@vrmc/protocol';
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

  /** One reusable writer for pong replies. Only ever used on this thread. */
  private readonly replyWriter = new PacketWriter();

  private clients = 0;

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
          port: this.router.currentSink.name,
        }),
      );
    });

    const wss = new WebSocketServer({ server, perMessageDeflate: false });
    this.wss = wss;

    wss.on('connection', (socket, req) => {
      this.clients++;
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
