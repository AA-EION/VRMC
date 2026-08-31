/**
 * Receive-side link quality.
 *
 * The bridge cannot measure true one-way latency: that needs the two clocks
 * related to each other, and the client is where the round trip is timed. What
 * it *can* measure without any clock sync is inter-arrival jitter — the
 * variation in transit time — because the sender's clock cancels out of the
 * difference. This is the same estimator RTP uses (RFC 3550 §6.4.1):
 *
 *     D(i,j) = (Rj - Ri) - (Sj - Si)
 *     J     += (|D(i,j)| - J) / 16
 *
 * Jitter is the number that matters for feel. A steady 12 ms of delay is
 * inaudible — players adapt to it within seconds. 12 ms that wanders between 4
 * and 30 is what makes a part feel unplayable, and it is what shows up here.
 */
export class LinkStats {
  packets = 0;
  events = 0;
  /** Packets presumed lost, inferred from gaps in the sequence number. */
  dropped = 0;
  /** Packets that arrived after a later one. UDP only. */
  reordered = 0;
  /** Packets rejected by the decoder. */
  malformed = 0;

  /** Smoothed inter-arrival jitter, in ms. */
  jitterMs = 0;
  /** Largest single |D| seen since the last reset, in ms. */
  peakJitterMs = 0;

  private lastSeq = -1;
  private lastArrival = 0;
  private lastSent = 0;
  private primed = false;

  /**
   * Record a packet's arrival.
   *
   * @param seq       sender's sequence number
   * @param sentMs    sender's clock at send
   * @param arrivalMs our clock at receive
   */
  onPacket(seq: number, sentMs: number, arrivalMs: number, eventCount: number): void {
    this.packets++;
    this.events += eventCount;

    if (this.lastSeq >= 0) {
      const delta = (seq - this.lastSeq) | 0;
      if (delta > 1) {
        this.dropped += delta - 1;
      } else if (delta <= 0) {
        this.reordered++;
      }
    }
    if (seq > this.lastSeq || this.lastSeq < 0) this.lastSeq = seq;

    if (this.primed) {
      const transit = arrivalMs - this.lastArrival - (sentMs - this.lastSent);
      const d = transit < 0 ? -transit : transit;
      if (d > this.peakJitterMs) this.peakJitterMs = d;
      this.jitterMs += (d - this.jitterMs) / 16;
    }
    this.lastArrival = arrivalMs;
    this.lastSent = sentMs;
    this.primed = true;
  }

  onMalformed(): void {
    this.malformed++;
  }

  /** Fraction of expected packets that never arrived, 0..1. */
  get lossRatio(): number {
    const expected = this.packets + this.dropped;
    return expected > 0 ? this.dropped / expected : 0;
  }

  /** Reset the windowed figures, keeping lifetime counters. */
  resetWindow(): void {
    this.peakJitterMs = 0;
  }

  summary(): string {
    return (
      `${this.packets} pkt / ${this.events} ev · ` +
      `jitter ${this.jitterMs.toFixed(2)} ms (peak ${this.peakJitterMs.toFixed(2)}) · ` +
      `loss ${(this.lossRatio * 100).toFixed(2)}%` +
      (this.malformed > 0 ? ` · ${this.malformed} malformed` : '') +
      (this.reordered > 0 ? ` · ${this.reordered} reordered` : '')
    );
  }
}
