// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "vitest/config";

/**
 * Run this package's tests in forked processes, not worker threads.
 *
 * These tests load native addons — node-datachannel above all, plus
 * `@julusian/midi` and koffi — and node-datachannel starts its own threads.
 * Vitest's default `threads` pool tears a suite down by ending a worker
 * *thread*, and ending one while a native library still has threads of its own
 * running is how you get
 *
 *     The futex facility returned an unexpected error code.
 *     Error: Worker exited unexpectedly (tinypool)
 *
 * which is not an assertion failing: the file's tests had all passed, and the
 * run still exited non-zero. It took a CI failure on a green diff to place it,
 * because the crash names tinypool rather than the addon and lands on whichever
 * file happened to be finishing.
 *
 * `forks` ends a suite by ending a *process*, and a process exit does not have
 * to negotiate with anyone else's threads. It costs a little startup time per
 * file and buys a suite that does not fail for reasons unrelated to the code.
 *
 * This was written while the WebRTC test still called `cleanup()` from
 * node-datachannel in `afterAll`, and forks alone did not stop the crashing:
 * measured over twenty runs it was still 1/20. Dropping that call is what took
 * it to 0/20 — see the comment on `afterAll` in test/webrtc.test.ts. The pool
 * stays because it is the right one for a package that loads three native
 * addons, and because it is faster, not because it was the fix.
 */
export default defineConfig({
  test: {
    pool: "forks",
  },
});
