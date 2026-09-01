// SPDX-License-Identifier: GPL-3.0-only

/**
 * Waits at the pairing service for a headset that wants to connect.
 *
 * The bridge sits behind a router with no public address, so it cannot be
 * dialled — it has to reach out and wait. It long-polls the signalling
 * endpoint; when a headset posts an offer, the poll returns immediately, the
 * bridge answers, and the two negotiate a direct connection between
 * themselves. From that point the service is not involved in anything.
 *
 * Note what does *not* travel through here: audio, MIDI, or any packet the
 * instrument produces. Two SDP blobs cross this service per connection, and
 * they describe how to reach a private address that is useless to anyone
 * outside the network it names.
 */

export interface SignalClientOptions {
  /** Base URL of the pairing service. */
  serviceUrl: string;
  /** This bridge's pairing code, normalised. */
  code: string;
  /** Produce an SDP answer for an offer. Rejects if the offer is unusable. */
  answer: (sessionId: string, offer: string) => Promise<string>;
  onLog: (message: string) => void;
}

/**
 * How long a poll is allowed to hang before we give up on it.
 *
 * The service holds a poll for 20 s, so this only fires when the request is
 * genuinely wedged — a captive portal, a proxy that swallows the response —
 * rather than on the ordinary empty answer.
 */
const POLL_TIMEOUT_MS = 30_000;

/** Backoff after a failed poll, in ms. The last value repeats. */
const BACKOFF_MS = [1000, 2000, 5000, 15_000] as const;

export class SignalClient {
  private readonly options: SignalClientOptions;
  private running = false;
  private failures = 0;
  private controller: AbortController | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private lastError = '';

  constructor(options: SignalClientOptions) {
    this.options = options;
  }

  get error(): string {
    return this.lastError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    if (this.sleepTimer !== null) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const handled = await this.pollOnce();
        // A poll that returned nothing is the normal case, not a failure —
        // resetting the backoff here is what keeps a quiet bridge polling
        // continuously rather than drifting out to fifteen-second gaps.
        this.failures = 0;
        this.lastError = '';
        if (!handled) continue;
      } catch (err) {
        if (!this.running) return;
        const message = err instanceof Error ? err.message : String(err);
        // Reported once per outage rather than once per attempt: a bridge left
        // running with no internet should not fill the log every second.
        if (this.lastError !== message) {
          this.options.onLog(`signalling unavailable: ${message}`);
          this.lastError = message;
        }
        await this.sleep(BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!);
        this.failures++;
      }
    }
  }

  /** One long poll. Returns true if an offer was handled. */
  private async pollOnce(): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(this.url(), { signal: controller.signal });
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }

    // 204 is the service saying "nobody yet" at the end of its hold. Poll again.
    if (res.status === 204) return false;
    if (res.status === 404) {
      // The registration lapsed — the publisher refreshes it on its own timer,
      // so wait a beat rather than hammering.
      throw new Error('this bridge is not registered yet');
    }
    if (!res.ok) throw new Error(`signalling returned ${res.status}`);

    const { sessionId, offer } = (await res.json()) as { sessionId?: string; offer?: string };
    if (typeof sessionId !== 'string' || typeof offer !== 'string' || offer.length === 0) {
      throw new Error('malformed offer');
    }

    await this.respond(sessionId, offer);
    return true;
  }

  private async respond(sessionId: string, offer: string): Promise<void> {
    let answer: string;
    try {
      answer = await this.options.answer(sessionId, offer);
    } catch (err) {
      // Do not post anything: the headset's poll times out, it sees no answer
      // and offers again. Posting a broken answer would make it fail slower.
      this.options.onLog(
        `could not answer a headset: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const res = await fetch(`${this.url()}/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`could not post an answer (${res.status})`);
  }

  private url(): string {
    return new URL(
      `/api/signal/${encodeURIComponent(this.options.code)}`,
      this.options.serviceUrl,
    ).toString();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepTimer = setTimeout(resolve, ms);
      this.sleepTimer.unref();
    });
  }
}
