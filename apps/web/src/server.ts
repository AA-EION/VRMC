// SPDX-License-Identifier: GPL-3.0-only

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
  PAIRING_TTL_SECONDS,
  isPairingCode,
  normalisePairingCode,
  type PairingRegistration,
} from '@vrmc/protocol';
import { PairingStore } from './PairingStore.js';
import { RateLimiter } from './RateLimiter.js';
import { SignalStore } from './SignalStore.js';

export interface WebServerOptions {
  port: number;
  host: string;
  /** Directory holding the built XR client. */
  staticDir: string;
  onLog?: (message: string) => void;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY_BYTES = 4096;

/**
 * SDP is much larger than a pairing registration — a description with a dozen
 * ICE candidates runs to a few kilobytes.
 */
const MAX_SDP_BYTES = 64 * 1024;

/** How long a long-poll is held open before answering empty. */
const POLL_TIMEOUT_MS = 20_000;

/**
 * Serves the XR client and brokers pairing, in one process.
 *
 * One process rather than nginx plus a sidecar: the container needs an API now,
 * and running two processes behind a supervisor to avoid writing forty lines of
 * static file serving is a poor trade. Your own reverse proxy sits in front and
 * does the caching anyway.
 */
export class WebServer {
  private readonly options: WebServerOptions;
  private readonly store: PairingStore;
  private readonly signals: SignalStore;
  private readonly limiter: RateLimiter;
  private server: ReturnType<typeof createServer> | null = null;
  private readonly root: string;

  constructor(options: WebServerOptions) {
    this.options = options;
    this.root = resolve(options.staticDir);
    this.store = new PairingStore({ ttlSeconds: PAIRING_TTL_SECONDS, maxEntries: 20000 });
    // A handshake that has not completed in two minutes has failed; the peers
    // will start a fresh one rather than resume this.
    this.signals = new SignalStore({ ttlMs: 120_000, maxPerCode: 4 });
    // Codes are 24^6, so guessing needs millions of attempts; this makes that
    // take years rather than an afternoon, and caps the damage from a bad actor
    // hammering the endpoint.
    this.limiter = new RateLimiter({ windowMs: 60_000, max: 60 });
  }

  async listen(): Promise<number> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.server = server;
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(this.options.port, this.options.host, () => {
        server.removeListener('error', fail);
        ok();
      });
    });
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : this.options.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    // Long polls are held open for twenty seconds. Waiting for them would make
    // every restart take that long, so in-flight connections are dropped —
    // a client whose poll dies simply asks again.
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      return json(res, 200, {
        service: 'vrmc-web',
        pairings: this.store.size,
        handshakes: this.signals.size,
      });
    }

    // Tells the client this deployment can broker a connection, so a build
    // served from a bare static host degrades to manual entry rather than
    // offering a pairing box that could never work.
    if (url.pathname === '/api/config') {
      return json(res, 200, { pairing: true });
    }

    if (url.pathname === '/api/pair' && req.method === 'POST') {
      return this.handleRegister(req, res);
    }

    const lookup = /^\/api\/pair\/([A-Za-z0-9-]{1,16})$/.exec(url.pathname);
    if (lookup !== null && req.method === 'GET') {
      return this.handleLookup(req, res, lookup[1]!);
    }

    if (url.pathname === '/api/pair' && req.method === 'DELETE') {
      return this.handleRelease(req, res);
    }

    const signal = /^\/api\/signal\/([A-Za-z0-9-]{1,16})(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(
      url.pathname,
    );
    if (signal !== null) {
      return this.handleSignal(req, res, signal[1]!, signal[2], url);
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    return this.serveStatic(url.pathname, res);
  }

  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.limiter.allow(clientKey(req))) return json(res, 429, { error: 'slow down' });

    const body = await readBody(req);
    if (body === null) return tooLarge(req, res);

    let registration: PairingRegistration;
    try {
      registration = JSON.parse(body) as PairingRegistration;
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }

    if (!isPairingCode(normalisePairingCode(registration.code ?? ''))) {
      return json(res, 400, { error: 'invalid pairing code' });
    }
    if (!Array.isArray(registration.addresses)) {
      return json(res, 400, { error: 'addresses must be an array' });
    }

    const result = this.store.register({
      ...registration,
      code: normalisePairingCode(registration.code),
      addresses: registration.addresses.slice(0, 8).map(String),
      label: String(registration.label ?? 'VRMC Bridge'),
      version: String(registration.version ?? ''),
      port: Number(registration.port),
    });

    if (!result.ok) return json(res, 400, { error: result.reason });
    return json(res, 200, { ok: true, ttl: PAIRING_TTL_SECONDS });
  }

  private handleLookup(req: IncomingMessage, res: ServerResponse, raw: string): void {
    if (!this.limiter.allow(clientKey(req))) return json(res, 429, { error: 'slow down' });

    const code = normalisePairingCode(raw);
    if (!isPairingCode(code)) return json(res, 400, { error: 'invalid pairing code' });

    const entry = this.store.lookup(code);
    // Deliberately the same response for "never existed" and "expired": telling
    // them apart would let someone probe which codes are live.
    if (entry === null) return json(res, 404, { error: 'no bridge with that code' });

    return json(res, 200, entry);
  }

  private async handleRelease(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.limiter.allow(clientKey(req))) return json(res, 429, { error: 'slow down' });
    const body = await readBody(req);
    if (body === null) return tooLarge(req, res);
    try {
      const { code } = JSON.parse(body) as { code: string };
      this.store.release(normalisePairingCode(code ?? ''));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    return json(res, 200, { ok: true });
  }

  /**
   * Broker one step of the WebRTC handshake.
   *
   *   POST /api/signal/{code}              headset publishes its offer
   *   GET  /api/signal/{code}              bridge waits for an offer
   *   POST /api/signal/{code}/{session}    bridge publishes its answer
   *   GET  /api/signal/{code}/{session}    headset waits for the answer
   *
   * Both GETs are long-polled, so a connection forms as soon as the other side
   * appears rather than on the next poll tick.
   */
  private async handleSignal(
    req: IncomingMessage,
    res: ServerResponse,
    rawCode: string,
    sessionId: string | undefined,
    url: URL,
  ): Promise<void> {
    if (!this.limiter.allow(clientKey(req))) return json(res, 429, { error: 'slow down' });

    const code = normalisePairingCode(rawCode);
    if (!isPairingCode(code)) return json(res, 400, { error: 'invalid pairing code' });

    // Only a code some bridge has actually claimed can be signalled on. Without
    // this the endpoint would be an open message queue keyed by any string.
    if (this.store.lookup(code) === null) {
      return json(res, 404, { error: 'no bridge with that code' });
    }

    if (req.method === 'POST' && sessionId === undefined) {
      const body = await readBody(req, MAX_SDP_BYTES);
      if (body === null) return tooLarge(req, res);
      let offer: string;
      let id: string;
      try {
        const parsed = JSON.parse(body) as { offer?: string; sessionId?: string };
        offer = String(parsed.offer ?? '');
        id = String(parsed.sessionId ?? '');
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (offer.length === 0 || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        return json(res, 400, { error: 'offer and sessionId are required' });
      }
      if (!this.signals.putOffer(code, id, offer)) {
        return json(res, 429, { error: 'too many handshakes in flight for that code' });
      }
      return json(res, 202, { ok: true });
    }

    if (req.method === 'GET' && sessionId === undefined) {
      const session = await this.signals.waitForOffer(code, POLL_TIMEOUT_MS);
      if (session === null) return json(res, 204, {});
      return json(res, 200, { sessionId: session.sessionId, offer: session.offer });
    }

    if (req.method === 'POST' && sessionId !== undefined) {
      const body = await readBody(req, MAX_SDP_BYTES);
      if (body === null) return tooLarge(req, res);
      let answer: string;
      try {
        answer = String((JSON.parse(body) as { answer?: string }).answer ?? '');
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (answer.length === 0) return json(res, 400, { error: 'answer is required' });
      if (!this.signals.putAnswer(code, sessionId, answer)) {
        return json(res, 404, { error: 'unknown session' });
      }
      return json(res, 202, { ok: true });
    }

    if (req.method === 'GET' && sessionId !== undefined) {
      const answer = await this.signals.waitForAnswer(code, sessionId, POLL_TIMEOUT_MS);
      if (answer === null) return json(res, 204, {});
      // The handshake is done and the peers talk directly from here.
      this.signals.release(code, sessionId);
      return json(res, 200, { answer });
    }

    void url;
    return json(res, 405, { error: 'method not allowed' });
  }

  /**
   * Serve a built asset, falling back to the document.
   *
   * The path is resolved and then checked to still sit under the root, which is
   * what stops `..` sequences from reaching outside the served directory.
   */
  private serveStatic(pathname: string, res: ServerResponse): void {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(join(this.root, relative));

    if (!file.startsWith(this.root + sep) && file !== this.root) {
      return text(res, 403, 'forbidden');
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');

    if (!existsSync(file)) {
      // Single-page app: unknown routes get the document so the client can be
      // mounted under any path the proxy chooses.
      file = join(this.root, 'index.html');
      if (!existsSync(file)) return text(res, 404, 'client not built');
    }

    const ext = extname(file);
    const isDoc = ext === '.html';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      // Asset names are content-hashed, so they can be cached forever; the
      // document never can, or a deploy leaves browsers on the old one.
      'cache-control': isDoc ? 'no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${body}\n`);
}

/**
 * Read a bounded request body, or null if it exceeds the cap.
 *
 * On overflow the stream is paused rather than destroyed. Destroying it aborts
 * the connection before the response can be written, so the caller sees a
 * network error instead of the 413 explaining what went wrong — the socket is
 * torn down afterwards, once the response has been sent.
 */
async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}

/** Answer with 413 and then drop the connection, discarding the rest. */
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  json(res, 413, { error: 'body too large' });
  res.on('finish', () => req.destroy());
}

/**
 * Identify a caller for rate limiting.
 *
 * Behind a reverse proxy every request appears to come from the proxy, so the
 * forwarded address is preferred where present. It is client-supplied and
 * therefore spoofable — acceptable here, because the limiter is a brake on
 * accidental hammering and casual guessing, not an authentication boundary.
 */
function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first?.split(',')[0] ?? '').trim() || req.socket.remoteAddress || 'unknown';
}
