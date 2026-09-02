// SPDX-License-Identifier: GPL-3.0-only

import type { PacketWriter } from './codec.js';

/**
 * Receive-side link quality, from the bridge to the headset.
 *
 * The headset can time its own round trip — it stamps a PING and the bridge
 * echoes it back — and that is the only figure it can get on its own. Jitter is
 * the variation in transit time and loss is the gaps in the sequence number,
 * and both are only visible where the packets land. The bridge has computed
 * them since v1 (see `LinkStats` in the bridge's core) and showed them on the
 * desktop dashboard, which is precisely the screen nobody can look at while
 * wearing the headset.
 *
 * Which matters because jitter is the number that decides how the instrument
 * feels. A steady twelve milliseconds of delay is inaudible — players adapt to
 * it within seconds. Twelve that wanders between four and thirty is what makes
 * a part feel unplayable, and «is it lagging or am I early» is not a question
 * anybody can answer from inside without being told.
 */

export interface LinkQuality {
  /** Smoothed inter-arrival jitter, in ms. */
  jitterMs: number;
  /** Largest single deviation since the last window reset, in ms. */
  peakJitterMs: number;
  /** Fraction of expected packets that never arrived, 0..1. */
  lossRatio: number;
  /** Packets the bridge has received this session. */
  packets: number;
  /** Packets presumed lost, inferred from gaps in the sequence number. */
  dropped: number;
  /** Packets that arrived after a later one. UDP only. */
  reordered: number;
  /** Packets the decoder rejected. */
  malformed: number;
  /** Notes the bridge currently believes are sounding. */
  activeNotes: number;
}

/** Three f32 then five u32. */
export const LINK_STATS_BYTES = 3 * 4 + 5 * 4;

export function writeLinkStats(w: PacketWriter, q: LinkQuality): boolean {
  return (
    w.pushFloat32(q.jitterMs) &&
    w.pushFloat32(q.peakJitterMs) &&
    w.pushFloat32(q.lossRatio) &&
    w.pushU32(q.packets) &&
    w.pushU32(q.dropped) &&
    w.pushU32(q.reordered) &&
    w.pushU32(q.malformed) &&
    w.pushU32(q.activeNotes)
  );
}

export function readLinkStats(body: Uint8Array): LinkQuality | null {
  if (body.length < LINK_STATS_BYTES) return null;
  const v = new DataView(body.buffer, body.byteOffset, LINK_STATS_BYTES);
  return {
    jitterMs: v.getFloat32(0, true),
    peakJitterMs: v.getFloat32(4, true),
    lossRatio: v.getFloat32(8, true),
    packets: v.getUint32(12, true),
    dropped: v.getUint32(16, true),
    reordered: v.getUint32(20, true),
    malformed: v.getUint32(24, true),
    activeNotes: v.getUint32(28, true),
  };
}

/**
 * How the link reads, as a word rather than a number.
 *
 * Six figures on a wrist panel is a dashboard, and a dashboard is not what
 * somebody mid-phrase needs; they need to know whether to trust their own
 * timing. The thresholds are about feel rather than about networking: under
 * 5 ms of jitter nobody can hear the variation, past 15 ms a roll starts
 * arriving unevenly, and any measurable loss at all means notes are going
 * missing rather than merely arriving late.
 */
export type LinkFeel = 'good' | 'fair' | 'poor';

export function feelOf(q: Pick<LinkQuality, 'jitterMs' | 'lossRatio'>): LinkFeel {
  if (q.lossRatio > 0.01 || q.jitterMs > 15) return 'poor';
  if (q.lossRatio > 0.001 || q.jitterMs > 5) return 'fair';
  return 'good';
}
