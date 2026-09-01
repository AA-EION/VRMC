// SPDX-License-Identifier: GPL-3.0-only

/**
 * Brokers the WebRTC handshake between a headset and a bridge.
 *
 * Only the handshake. Two SDP blobs cross this service — an offer and an
 * answer — and once the data channel forms, every MIDI packet goes directly
 * between the two machines on their own network. Nothing musical is ever
 * relayed, and there is no fallback that would quietly start relaying it.
 *
 * Why this exists at all: a browser cannot enumerate the local network, so it
 * has no way to address the bridge. WebRTC solves the *security* half — peers
 * authenticate by DTLS fingerprint, needing no certificate authority — but not
 * the introduction. That is what the pairing code and this store are for.
 */

export interface SignalSession {
  sessionId: string;
  offer: string;
  answer: string | null;
  createdAt: number;
}

export interface SignalStoreOptions {
  /** How long an unanswered session survives, in ms. */
  ttlMs: number;
  /** Most sessions per code, capping a client that opens many. */
  maxPerCode: number;
  now?: () => number;
}

type Waiter = (session: SignalSession) => void;

export class SignalStore {
  private readonly sessions = new Map<string, Map<string, SignalSession>>();
  /** Bridges long-polling for an offer, keyed by pairing code. */
  private readonly offerWaiters = new Map<string, Set<Waiter>>();
  /** Headsets long-polling for an answer, keyed by `code/sessionId`. */
  private readonly answerWaiters = new Map<string, Set<Waiter>>();
  private readonly options: Required<SignalStoreOptions>;

  constructor(options: SignalStoreOptions) {
    this.options = { now: () => Date.now(), ...options };
  }

  /**
   * Record an offer from a headset.
   *
   * If a bridge is already waiting, it is handed the offer immediately — which
   * is what makes connecting feel instant rather than costing a poll interval.
   */
  putOffer(code: string, sessionId: string, offer: string): boolean {
    this.sweep();
    let forCode = this.sessions.get(code);
    if (forCode === undefined) {
      forCode = new Map();
      this.sessions.set(code, forCode);
    }
    if (!forCode.has(sessionId) && forCode.size >= this.options.maxPerCode) return false;

    const session: SignalSession = {
      sessionId,
      offer,
      answer: null,
      createdAt: this.options.now(),
    };
    forCode.set(sessionId, session);

    const waiting = this.offerWaiters.get(code);
    if (waiting !== undefined) {
      for (const waiter of waiting) waiter(session);
      this.offerWaiters.delete(code);
    }
    return true;
  }

  /** Record a bridge's answer, waking whichever headset is waiting. */
  putAnswer(code: string, sessionId: string, answer: string): boolean {
    const session = this.sessions.get(code)?.get(sessionId);
    if (session === undefined) return false;
    session.answer = answer;

    const key = `${code}/${sessionId}`;
    const waiting = this.answerWaiters.get(key);
    if (waiting !== undefined) {
      for (const waiter of waiting) waiter(session);
      this.answerWaiters.delete(key);
    }
    return true;
  }

  /**
   * Wait for an offer on `code`, resolving null at `timeoutMs`.
   *
   * Long-polling rather than an interval: a bridge that polls every second adds
   * up to a second to every connection for no benefit, and one that polls
   * faster is just busier.
   */
  waitForOffer(code: string, timeoutMs: number): Promise<SignalSession | null> {
    const pending = this.pendingOffer(code);
    if (pending !== null) return Promise.resolve(pending);

    return new Promise((resolve) => {
      const waiter: Waiter = (session) => {
        clearTimeout(timer);
        resolve(session);
      };
      const timer = setTimeout(() => {
        this.offerWaiters.get(code)?.delete(waiter);
        resolve(null);
      }, timeoutMs);
      // Do not hold the process open on a poll that nobody is waiting for.
      timer.unref?.();

      let set = this.offerWaiters.get(code);
      if (set === undefined) {
        set = new Set();
        this.offerWaiters.set(code, set);
      }
      set.add(waiter);
    });
  }

  /** Wait for the answer to one session. */
  waitForAnswer(code: string, sessionId: string, timeoutMs: number): Promise<string | null> {
    const session = this.sessions.get(code)?.get(sessionId);
    if (session?.answer != null) return Promise.resolve(session.answer);

    const key = `${code}/${sessionId}`;
    return new Promise((resolve) => {
      const waiter: Waiter = (s) => {
        clearTimeout(timer);
        resolve(s.answer);
      };
      const timer = setTimeout(() => {
        this.answerWaiters.get(key)?.delete(waiter);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();

      let set = this.answerWaiters.get(key);
      if (set === undefined) {
        set = new Set();
        this.answerWaiters.set(key, set);
      }
      set.add(waiter);
    });
  }

  /** An offer on this code that has not been answered, if any. */
  private pendingOffer(code: string): SignalSession | null {
    const forCode = this.sessions.get(code);
    if (forCode === undefined) return null;
    for (const session of forCode.values()) {
      if (session.answer === null) return session;
    }
    return null;
  }

  /** Discard a finished session; the data channel is direct from here on. */
  release(code: string, sessionId: string): void {
    const forCode = this.sessions.get(code);
    forCode?.delete(sessionId);
    if (forCode?.size === 0) this.sessions.delete(code);
  }

  get size(): number {
    let total = 0;
    for (const forCode of this.sessions.values()) total += forCode.size;
    return total;
  }

  sweep(): number {
    const cutoff = this.options.now() - this.options.ttlMs;
    let removed = 0;
    for (const [code, forCode] of this.sessions) {
      for (const [id, session] of forCode) {
        if (session.createdAt < cutoff) {
          forCode.delete(id);
          removed++;
        }
      }
      if (forCode.size === 0) this.sessions.delete(code);
    }
    return removed;
  }
}
