// SPDX-License-Identifier: GPL-3.0-only

import { PacketKind, PacketWriter } from '@vrmc/protocol';
import type { Router } from '../core/Router.js';
import type { PacketSink } from './Broadcaster.js';

/**
 * WebRTC data channel transport.
 *
 * This is how a headset on a public web page reaches a bridge on a private
 * network, and it removes an entire category of setup. A WebSocket from an
 * HTTPS page needs a certificate that a public authority signed for whatever
 * host it dials — impossible for a machine on someone's LAN without owning DNS
 * and shipping a wildcard key to every user. WebRTC peers authenticate by
 * exchanging DTLS fingerprints through the signalling channel instead, so no
 * certificate authority is involved at any point.
 *
 * It is also simply the better transport. The channel is unordered and
 * unreliable, which is what MIDI wants: a lost note is stale by the time it
 * could be retransmitted, and TCP's in-order delivery means one dropped packet
 * stalls every packet behind it — an audible gap followed by a burst of late
 * notes. That was the compromise the WebSocket forced, and it is now gone.
 */

/** The slice of node-datachannel this uses, declared to avoid a hard type dep. */
interface RtcDataChannel {
  onMessage(cb: (msg: Buffer | string) => void): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  sendMessageBinary(data: Buffer): boolean;
  close(): void;
  isOpen(): boolean;
}

interface RtcPeerConnection {
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onGatheringStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (channel: RtcDataChannel) => void): void;
  setRemoteDescription(sdp: string, type: string): void;
  gatheringState(): string;
  localDescription(): { sdp: string; type: string } | null;
  close(): void;
}

interface RtcModule {
  PeerConnection: new (name: string, config: { iceServers: string[] }) => RtcPeerConnection;
  cleanup?: () => void;
}

export interface RtcOptions {
  onLog: (message: string) => void;
  /** Notified when a peer connects or disconnects. */
  onPeerChange: (connected: number) => void;
}

/** One connected headset. */
interface Peer {
  id: string;
  pc: RtcPeerConnection;
  channel: RtcDataChannel | null;
}

export class RtcTransport implements PacketSink {
  private readonly router: Router;
  private readonly options: RtcOptions;
  private readonly peers = new Map<string, Peer>();
  private rtc: RtcModule | null = null;

  /** Reused for replies; only ever touched on the main thread. */
  private readonly replyWriter = new PacketWriter();

  constructor(router: Router, options: RtcOptions) {
    this.router = router;
    this.options = options;
  }

  /** The `PacketSink` half: how many headsets are reachable right now. */
  get clientCount(): number {
    return this.peerCount;
  }

  get peerCount(): number {
    let open = 0;
    for (const peer of this.peers.values()) {
      if (peer.channel?.isOpen() === true) open++;
    }
    return open;
  }

  /** True once the native library loaded; false means WebRTC is unavailable. */
  async load(): Promise<boolean> {
    if (this.rtc !== null) return true;
    try {
      const mod = (await import('node-datachannel')) as unknown as RtcModule & {
        default?: RtcModule;
      };
      this.rtc = mod.default ?? mod;
      return true;
    } catch (err) {
      this.options.onLog(
        `WebRTC unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Answer a headset's offer.
   *
   * Returns the complete SDP answer once ICE gathering finishes. Gathering is
   * awaited rather than trickled: on a local network it takes a fraction of a
   * second, and a single exchange is far less to get wrong than a stream of
   * candidate messages through a polling service.
   */
  async answer(sessionId: string, offer: string, timeoutMs = 8000): Promise<string> {
    if (!(await this.load()) || this.rtc === null) {
      throw new Error('WebRTC is not available on this machine');
    }

    // No ICE servers: both peers are on the same network, so host candidates
    // are all that is needed. It also means no third party is contacted while
    // connecting — nothing about this leaves the LAN.
    const pc = new this.rtc.PeerConnection(`vrmc-${sessionId}`, { iceServers: [] });
    const peer: Peer = { id: sessionId, pc, channel: null };
    this.peers.set(sessionId, peer);

    pc.onDataChannel((channel) => this.attach(peer, channel));

    pc.onStateChange((state) => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.dropPeer(sessionId, `connection ${state}`);
      }
    });

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.dropPeer(sessionId, 'timed out gathering candidates');
        reject(new Error('timed out preparing an answer'));
      }, timeoutMs);

      /** Hand back the answer, once, whichever way we noticed it was ready. */
      const deliver = (): void => {
        if (settled) return;
        const local = pc.localDescription();
        if (local === null) return;
        settled = true;
        clearTimeout(timer);
        resolve(local.sdp);
      };

      pc.onGatheringStateChange((state) => {
        if (state === 'complete') deliver();
      });

      try {
        pc.setRemoteDescription(offer, 'offer');
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        this.dropPeer(sessionId, 'bad offer');
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      // On a machine with only local addresses there is nothing to gather, so
      // this can already be finished — and the callback above fires on the
      // library's own thread, which may have raced past it. Checking directly
      // costs nothing and is the difference between connecting instantly and
      // hanging until the timeout.
      if (pc.gatheringState() === 'complete') deliver();
    });
  }

  private attach(peer: Peer, channel: RtcDataChannel): void {
    peer.channel = channel;

    channel.onOpen(() => {
      this.options.onLog(`headset connected over WebRTC (${peer.id})`);
      this.options.onPeerChange(this.peerCount);
    });

    channel.onMessage((msg) => {
      if (typeof msg === 'string') return;
      const arrival = performance.now();
      this.router.handlePacket(msg, arrival, (clientTime, serverTime) => {
        this.sendPong(peer, clientTime, serverTime);
      });
    });

    channel.onClosed(() => {
      this.dropPeer(peer.id, 'channel closed');
    });
  }

  /** Send bytes to every connected headset. */
  send(frame: Uint8Array): void {
    const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    for (const peer of this.peers.values()) {
      if (peer.channel?.isOpen() === true) peer.channel.sendMessageBinary(buffer);
    }
  }

  private sendPong(peer: Peer, clientTime: number, serverTime: number): void {
    const w = this.replyWriter;
    w.begin(PacketKind.PONG);
    w.pushFloat64(serverTime);
    const frame = w.finish(clientTime);
    peer.channel?.sendMessageBinary(
      Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
    );
  }

  private dropPeer(sessionId: string, reason: string): void {
    const peer = this.peers.get(sessionId);
    if (peer === undefined) return;
    this.peers.delete(sessionId);
    try {
      peer.channel?.close();
      peer.pc.close();
    } catch {
      // Already torn down by the library.
    }
    // The headset is gone and cannot send the Note Offs it owes; releasing
    // here is what stops a voice hanging in the DAW until it is restarted.
    const released = this.router.releaseAll();
    this.options.onLog(
      `headset disconnected (${reason})` +
        (released > 0 ? `; released ${released} stuck note(s)` : ''),
    );
    this.options.onPeerChange(this.peerCount);
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.dropPeer(id, 'shutting down');
    this.rtc?.cleanup?.();
  }
}
