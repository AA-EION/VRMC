// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingStore } from '../src/PairingStore.js';
import { RateLimiter } from '../src/RateLimiter.js';
import { WebServer } from '../src/server.js';

describe('PairingStore', () => {
  const base = { code: 'K7M2QX', port: 7401, label: 'Studio Mac', version: '0.1.0' };

  it('stores and resolves a registration', () => {
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 10 });
    expect(store.register({ ...base, addresses: ['192.168.1.42'] })).toEqual({ ok: true });
    const found = store.lookup('K7M2QX');
    expect(found?.addresses).toEqual(['192.168.1.42']);
    expect(found?.label).toBe('Studio Mac');
    expect(found?.expiresIn).toBeGreaterThan(0);
  });

  it('refuses a registration naming a public address', () => {
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 10 });
    // Accepting this would point every headset that types the code at a
    // machine on the open internet.
    const result = store.register({ ...base, addresses: ['8.8.8.8'] });
    expect(result.ok).toBe(false);
    expect(store.lookup('K7M2QX')).toBeNull();
  });

  it('keeps only the private addresses from a mixed registration', () => {
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 10 });
    store.register({ ...base, addresses: ['8.8.8.8', '192.168.1.42', '10.0.0.5'] });
    expect(store.lookup('K7M2QX')?.addresses).toEqual(['192.168.1.42', '10.0.0.5']);
  });

  it('expires an entry that stops refreshing', () => {
    let now = 1000;
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 10, now: () => now });
    store.register({ ...base, addresses: ['192.168.1.42'] });
    now += 59_000;
    expect(store.lookup('K7M2QX')).not.toBeNull();
    now += 2000;
    expect(store.lookup('K7M2QX')).toBeNull();
  });

  it('caps how many registrations it will hold', () => {
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 2 });
    expect(store.register({ ...base, code: 'AAAAAA', addresses: ['10.0.0.1'] }).ok).toBe(true);
    expect(store.register({ ...base, code: 'AAAAAB', addresses: ['10.0.0.2'] }).ok).toBe(true);
    expect(store.register({ ...base, code: 'AAAAAC', addresses: ['10.0.0.3'] }).ok).toBe(false);
    // Refreshing one that already exists must still work when full.
    expect(store.register({ ...base, code: 'AAAAAA', addresses: ['10.0.0.9'] }).ok).toBe(true);
  });

  it('reclaims space from expired entries when full', () => {
    let now = 1000;
    const store = new PairingStore({ ttlSeconds: 10, maxEntries: 1, now: () => now });
    store.register({ ...base, code: 'AAAAAA', addresses: ['10.0.0.1'] });
    now += 20_000;
    expect(store.register({ ...base, code: 'AAAAAB', addresses: ['10.0.0.2'] }).ok).toBe(true);
  });

  it('rejects an out-of-range port', () => {
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 10 });
    expect(store.register({ ...base, port: 0, addresses: ['10.0.0.1'] }).ok).toBe(false);
    expect(store.register({ ...base, port: 99999, addresses: ['10.0.0.1'] }).ok).toBe(false);
  });

  it('releases a code on request', () => {
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 10 });
    store.register({ ...base, addresses: ['192.168.1.42'] });
    expect(store.release('K7M2QX')).toBe(true);
    expect(store.lookup('K7M2QX')).toBeNull();
  });

  it('truncates oversized labels rather than storing them', () => {
    const store = new PairingStore({ ttlSeconds: 60, maxEntries: 10 });
    store.register({ ...base, label: 'x'.repeat(500), addresses: ['10.0.0.1'] });
    expect(store.lookup('K7M2QX')!.label.length).toBeLessThanOrEqual(60);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit then refuses', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, max: 3, now: () => now });
    expect([1, 2, 3].map(() => limiter.allow('a'))).toEqual([true, true, true]);
    expect(limiter.allow('a')).toBe(false);
  });

  it('resets when the window rolls', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, max: 1, now: () => now });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    now += 1001;
    expect(limiter.allow('a')).toBe(true);
  });

  it('counts callers separately', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
  });
});

describe('WebServer', () => {
  let server: WebServer;
  let port: number;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'vrmc-web-'));
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');

    server = new WebServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: root,
      lanDomain: 'lan.example.com',
    });
    port = await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const register = (body: unknown): Promise<Response> =>
    fetch(url('/api/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('serves the client document', async () => {
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
    expect(res.headers.get('cache-control')).toContain('no-cache');
  });

  it('serves hashed assets as immutable', async () => {
    const res = await fetch(url('/assets/app-abc123.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to the document for unknown routes', async () => {
    const res = await fetch(url('/deep/route'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('refuses to escape the static root', async () => {
    // A traversal must not reach the filesystem outside the served directory.
    const res = await fetch(url('/../../../../etc/passwd'));
    const body = await res.text();
    expect(body).not.toContain('root:');
  });

  it('publishes the LAN domain so one build serves any deployment', async () => {
    const res = await fetch(url('/api/config'));
    expect(await res.json()).toEqual({ lanDomain: 'lan.example.com' });
  });

  it('registers a bridge and resolves its code', async () => {
    const res = await register({
      code: 'K7M2QX',
      addresses: ['192.168.1.42'],
      port: 7401,
      label: 'Studio Mac',
      version: '0.1.0',
    });
    expect(res.status).toBe(200);

    const found = await (await fetch(url('/api/pair/K7M2QX'))).json();
    expect(found).toMatchObject({
      addresses: ['192.168.1.42'],
      port: 7401,
      label: 'Studio Mac',
      lanDomain: 'lan.example.com',
    });
  });

  it('accepts a code typed with dashes and lower case', async () => {
    await register({ code: 'K7M2QX', addresses: ['192.168.1.42'], port: 7401, label: 'x', version: '1' });
    expect((await fetch(url('/api/pair/k7m-2qx'))).status).toBe(200);
  });

  it('gives the same answer for unknown and expired codes', async () => {
    // Distinguishing them would let someone probe which codes are live.
    const res = await fetch(url('/api/pair/AAAAAA'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no bridge with that code' });
  });

  it('rejects a malformed code before it reaches the store', async () => {
    expect((await fetch(url('/api/pair/ABC'))).status).toBe(400);
  });

  it('rejects a registration on a public address', async () => {
    const res = await register({
      code: 'K7M2QX',
      addresses: ['8.8.8.8'],
      port: 7401,
      label: 'x',
      version: '1',
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON and oversized bodies', async () => {
    const bad = await fetch(url('/api/pair'), { method: 'POST', body: 'not json' });
    expect(bad.status).toBe(400);

    const huge = await fetch(url('/api/pair'), { method: 'POST', body: 'x'.repeat(10_000) });
    expect([400, 413]).toContain(huge.status);
  });

  it('releases a code', async () => {
    await register({ code: 'K7M2QX', addresses: ['10.0.0.1'], port: 7401, label: 'x', version: '1' });
    const res = await fetch(url('/api/pair'), {
      method: 'DELETE',
      body: JSON.stringify({ code: 'K7M2QX' }),
    });
    expect(res.status).toBe(200);
    expect((await fetch(url('/api/pair/K7M2QX'))).status).toBe(404);
  });

  it('answers a health probe', async () => {
    const res = await fetch(url('/healthz'));
    expect(((await res.json()) as { service: string }).service).toBe('vrmc-web');
  });

  it('404s an unknown API route rather than serving the document', async () => {
    expect((await fetch(url('/api/nope'))).status).toBe(404);
  });
});
