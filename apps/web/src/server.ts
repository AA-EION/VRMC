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

export interface WebServerOptions {
  port: number;
  host: string;
  /** Directory holding the built XR client. */
  staticDir: string;
  /** Wildcard domain whose subdomains resolve to private addresses. */
  lanDomain: string;
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
  private readonly limiter: RateLimiter;
  private server: ReturnType<typeof createServer> | null = null;
  private readonly root: string;

  constructor(options: WebServerOptions) {
    this.options = options;
    this.root = resolve(options.staticDir);
    this.store = new PairingStore({ ttlSeconds: PAIRING_TTL_SECONDS, maxEntries: 20000 });
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
    await new Promise<void>((ok) => {
      if (this.server === null) return ok();
      this.server.close(() => ok());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      return json(res, 200, { service: 'vrmc-web', pairings: this.store.size });
    }

    // Lets the client build LAN hostnames without the domain being compiled in,
    // so one build serves any deployment.
    if (url.pathname === '/api/config') {
      return json(res, 200, { lanDomain: this.options.lanDomain });
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

    return json(res, 200, { ...entry, lanDomain: this.options.lanDomain });
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
async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
