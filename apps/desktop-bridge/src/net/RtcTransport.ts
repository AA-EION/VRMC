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
  /** Fires if the channel never opens, so a stalled peer is not kept. */
  openTimer: NodeJS.Timeout | null;
}

/**
 * How long a headset has to finish connecting after being answered.
 *
 * An answered peer that never opens its channel is holding an ICE agent, a
 * socket and a thread for a connection that is not coming. The client retries
 * on its own — a rejected answer or a failed handshake schedules a fresh one —
 * so without this every retry would leave another dead peer behind, and a
 * headset that could not connect would slowly starve the bridge of the
 * resources it needs to answer the attempt that finally works.
 *
 * Generous relative to a LAN handshake, which is well under a second.
 */
const OPEN_TIMEOUT_MS = 15_000;

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
    const peer: Peer = { id: sessionId, pc, channel: null, openTimer: null };
    // Replacing an earlier attempt from the same session drops the old peer
    // rather than orphaning it in the library.
    if (this.peers.has(sessionId)) this.dropPeer(sessionId, 'superseded by a new offer');
    this.peers.set(sessionId, peer);

    peer.openTimer = setTimeout(() => {
      if (peer.channel?.isOpen() !== true) this.dropPeer(sessionId, 'never finished connecting');
    }, OPEN_TIMEOUT_MS);
    peer.openTimer.unref?.();

    pc.onDataChannel((channel) => this.attach(peer, channel));

    pc.onStateChange((state) => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.dropPeer(sessionId, `connection ${state}`);
      }
    });

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const fail = (message: string, reason: string): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        this.dropPeer(sessionId, reason);
        reject(new Error(message));
      };

      /**
       * Hand back the answer once it is genuinely finished.
       *
       * Both conditions matter. Gathering being complete is not enough on its
       * own: immediately after the offer is applied, before libdatachannel has
       * built the answer on its own thread, the gatherer can already report
       * complete while `localDescription` still holds nothing useful. Reading
       * it then yields a description the offering peer rejects — it arrives
       * without the transport its candidates belong to, and the connection
       * fails with an error that names neither side.
       *
       * Checking the type is what makes that unambiguous: only an answer will
       * do, and only after gathering has finished producing its candidates.
       */
      const ready = (): boolean => {
        if (settled) return true;
        if (pc.gatheringState() !== 'complete') return false;
        const local = pc.localDescription();
        if (local === null || local.type !== 'answer') return false;
        settled = true;
        clearInterval(poll);
        resolve(local.sdp);
        return true;
      };

      /*
       * Polled rather than driven by the gathering callback.
       *
       * The callback fires on the library's own thread and can run before it
       * is installed — on a machine with only host candidates there is nothing
       * to gather, so the transition happens almost immediately — and a
       * connection that waits for an event already past hangs until the
       * timeout. Twenty milliseconds is far below anything a person notices
       * and immune to both orderings.
       */
      const started = Date.now();
      const poll = setInterval(() => {
        if (ready()) return;
        if (Date.now() - started > timeoutMs) {
          fail('timed out preparing an answer', 'timed out gathering candidates');
        }
      }, 20);
      poll.unref?.();

      try {
        pc.setRemoteDescription(offer, 'offer');
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), 'bad offer');
        return;
      }

      ready();
    });
  }

  private attach(peer: Peer, channel: RtcDataChannel): void {
    peer.channel = channel;

    channel.onOpen(() => {
      if (peer.openTimer !== null) {
        clearTimeout(peer.openTimer);
        peer.openTimer = null;
      }
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
    if (peer.openTimer !== null) {
      clearTimeout(peer.openTimer);
      peer.openTimer = null;
    }
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

  /**
   * Close every peer this transport owns.
   *
   * Deliberately *not* the library's own `cleanup()`. That is a global
   * teardown — it destroys every peer connection in the process and stops the
   * internal threads — so calling it from an instance method means closing one
   * transport quietly breaks any other. The bridge only has one today, which
   * is why this was harmless in production and showed up as a flaky test: two
   * transports in one process, and the second was created while the library
   * was still tearing itself down from the first.
   *
   * The process exits immediately after this on shutdown, which is when the
   * library's threads go away anyway.
   */
  close(): void {
    for (const id of [...this.peers.keys()]) this.dropPeer(id, 'shutting down');
  }
}
