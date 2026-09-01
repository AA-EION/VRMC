#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { WebServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const staticDir = process.env.STATIC_DIR ?? '/srv/client';

const server = new WebServer({ port, host, staticDir });

const log = (m: string): void => {
  process.stdout.write(`${new Date().toISOString()}  ${m}\n`);
};

server
  .listen()
  .then((bound) => {
    log(`vrmc-web listening on ${host}:${bound}`);
    log(`serving client from ${staticDir}`);
    log('pairing and WebRTC signalling are enabled');
  })
  .catch((err: unknown) => {
    log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal} — shutting down`);
    void server.close().then(() => process.exit(0));
  });
}
