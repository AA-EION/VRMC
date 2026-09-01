// SPDX-License-Identifier: GPL-3.0-only

/**
 * Fixed-window request limiter.
 *
 * Guards the pairing endpoints against someone enumerating codes. The code
 * space is 24^6, so even a modest limit turns a feasible attack into an
 * infeasible one; the point is to make guessing cost time, not to be a
 * general-purpose traffic shaper.
 */
export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();
  private readonly options: Required<RateLimiterOptions>;

  constructor(options: RateLimiterOptions) {
    this.options = { now: () => Date.now(), ...options };
  }

  allow(key: string): boolean {
    const now = this.options.now();
    const entry = this.counts.get(key);

    if (entry === undefined || entry.resetAt <= now) {
      // Sweep on window roll rather than on a timer, so an idle server does no
      // work and a busy one pays only when it is already handling a request.
      if (this.counts.size > 10_000) {
        for (const [k, v] of this.counts) {
          if (v.resetAt <= now) this.counts.delete(k);
        }
      }
      this.counts.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return true;
    }

    if (entry.count >= this.options.max) return false;
    entry.count++;
    return true;
  }
}
