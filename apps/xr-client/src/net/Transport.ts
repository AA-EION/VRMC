// SPDX-License-Identifier: GPL-3.0-only

/**
 * The two ways the headset can reach a bridge.
 *
 * `BridgeLink` speaks the VRMC protocol and knows nothing about how the bytes
 * get there, which is what lets the same batching, backpressure and reconnect
 * logic serve a WebSocket on localhost and a WebRTC data channel across the
 * room.
 */
export interface Transport {
  /** Where this goes, for the status panel. */
  readonly label: string;
  readonly isOpen: boolean;
  /** Bytes handed over but not yet sent. Drives the load shedding. */
  readonly bufferedAmount: number;
  onMessage: ((bytes: Uint8Array) => void) | null;
  onClose: ((reason: string) => void) | null;
  send(bytes: Uint8Array): void;
  close(): void;
}

/**
 * Opens a transport, resolving only once it can carry packets.
 *
 * A factory rather than an object because reconnecting means starting over:
 * for WebRTC that is a fresh offer, a fresh answer and a fresh data channel,
 * and none of the previous attempt's state is reusable.
 */
export type TransportFactory = () => Promise<Transport>;

/** How long to wait for a connection before giving up on it. */
const CONNECT_TIMEOUT_MS = 8000;

// --- WebSocket ---

class WebSocketTransport implements Transport {
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  constructor(
    private readonly socket: WebSocket,
    readonly label: string,
  ) {
    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      this.onMessage?.(new Uint8Array(event.data));
    };
    socket.onclose = (event: CloseEvent) => {
      this.onClose?.(event.reason || 'connection closed');
    };
    socket.onerror = null;
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  send(bytes: Uint8Array): void {
    if (this.isOpen) this.socket.send(bytes);
  }

  close(): void {
    this.socket.onmessage = null;
    this.socket.onclose = null;
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close();
  }
}

/**
 * Connect to a bridge by URL.
 *
 * Kept for a client running on the same machine as the bridge, and for
 * development. It cannot serve the hosted site: a page on HTTPS may not open a
 * plain `ws://` connection, and a bridge on a home network has no name a
 * certificate authority would ever sign for. That is what the data channel
 * below exists to solve.
 */
export function webSocketTransport(url: string): TransportFactory {
  return () =>
    new Promise<Transport>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        // Thrown synchronously for a malformed URL, or for ws:// from an HTTPS
        // page — the mixed-content block that catches out every first attempt.
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      socket.binaryType = 'arraybuffer';

      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          socket.close();
          reject(new Error(`${url} did not answer`));
        });
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => settle(() => resolve(new WebSocketTransport(socket, url)));
      // The error event carries no detail by design — it would leak
      // cross-origin information — so there is nothing more useful to report.
      socket.onerror = () => settle(() => reject(new Error(`could not reach ${url}`)));
      socket.onclose = () => settle(() => reject(new Error(`${url} closed the connection`)));
    });
}

// --- WebRTC data channel ---

class DataChannelTransport implements Transport {
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private closed = false;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
    readonly label: string,
  ) {
    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      this.onMessage?.(new Uint8Array(event.data));
    };
    channel.onclose = () => this.fail('the connection closed');
    channel.onerror = () => this.fail('the connection failed');
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.fail(`connection ${state}`);
      }
    };
  }

  get isOpen(): boolean {
    return !this.closed && this.channel.readyState === 'open';
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  send(bytes: Uint8Array): void {
    if (!this.isOpen) return;
    // The data channel's typings ask for a view over a plain ArrayBuffer,
    // which is exactly what the packet writer produces — it just cannot prove
    // it, because a Uint8Array may in general sit on shared memory.
    this.channel.send(bytes as Uint8Array<ArrayBuffer>);
  }

  close(): void {
    this.closed = true;
    this.channel.onmessage = null;
    this.channel.onclose = null;
    this.channel.onerror = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.channel.close();
      this.pc.close();
    } catch {
      // Already torn down.
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}

export interface RtcOptions {
  /** Told what the handshake is doing, so the UI can say something useful. */
  onProgress?: (message: string) => void;
  /** Overall budget for the handshake. */
  timeoutMs?: number;
}

/**
 * Connect to a bridge by pairing code, over a WebRTC data channel.
 *
 * This is the path that made the certificate problem disappear. A WebSocket
 * from an HTTPS page must dial a host a public authority has signed for, which
 * a computer on someone's home network can never be without that person owning
 * a domain and installing a certificate. WebRTC peers instead exchange DTLS
 * fingerprints through the signalling exchange and verify each other directly,
 * so there is no authority in the picture and nothing for the user to set up:
 * they read six characters off the desktop app and type them in.
 *
 * The channel is deliberately unordered and unreliable, which is what MIDI
 * wants. A note that arrives late is worse than one that never arrives, and
 * TCP's in-order delivery means a single lost packet stalls everything behind
 * it — a gap in the music followed by a burst of notes that are all wrong.
 */
export function rtcTransport(code: string, options: RtcOptions = {}): TransportFactory {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const progress = options.onProgress ?? ((): void => {});

  return async () => {
    const deadline = performance.now() + timeoutMs;
    const sessionId = newSessionId();

    // No ICE servers. Both peers are on the same network, so their host
    // candidates are enough — and it means nothing outside the LAN is
    // contacted while connecting, not even to discover an address.
    const pc = new RTCPeerConnection({ iceServers: [] });

    try {
      const channel = pc.createDataChannel('vrmc', {
        ordered: false,
        maxRetransmits: 0,
      });
      channel.binaryType = 'arraybuffer';

      const opened = waitForOpen(channel, deadline);

      progress('Preparing the connection…');
      await pc.setLocalDescription(await pc.createOffer());
      // Gather before offering, rather than trickling candidates: on a local
      // network this takes a fraction of a second, and one exchange through a
      // polling service is far less to get wrong than a stream of them.
      await gatheringComplete(pc, Math.min(3000, deadline - performance.now()));

      const offer = pc.localDescription?.sdp;
      if (offer === undefined) throw new Error('could not describe this headset');

      progress('Calling the computer…');
      await postOffer(code, sessionId, offer);

      const answer = await pollForAnswer(code, sessionId, deadline);
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });

      progress('Connecting…');
      await opened;
      return new DataChannelTransport(pc, channel, `pairing code ${code}`);
    } catch (err) {
      pc.close();
      throw err;
    }
  };
}

/** A handshake identifier the signalling path will accept. */
function newSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function waitForOpen(channel: RTCDataChannel, deadline: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the computer did not finish connecting')),
      Math.max(1000, deadline - performance.now()),
    );
    channel.onopen = () => {
      clearTimeout(timer);
      channel.onopen = null;
      resolve();
    };
  });
}

/**
 * Wait for ICE gathering to finish, or for `timeoutMs` — whichever is first.
 *
 * Timing out is not a failure. Host candidates are available immediately and
 * they are the ones that matter on a LAN; anything still outstanding is a
 * reflexive candidate we did not ask for and do not need.
 */
function gatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, Math.max(500, timeoutMs));
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function postOffer(code: string, sessionId: string, offer: string): Promise<void> {
  const res = await fetch(`/api/signal/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, offer }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    throw new Error('That computer is not reachable. Is the VRMC desktop app running?');
  }
  if (!res.ok) throw new Error(`Could not start the handshake (${res.status}).`);
}

/**
 * Long-poll for the bridge's answer until the deadline.
 *
 * The service holds each request open, so this is one or two requests in
 * practice rather than a poll loop — but it is written as a loop because a
 * proxy in between may cut a long request short, and the right response to
 * that is simply to ask again.
 */
async function pollForAnswer(code: string, sessionId: string, deadline: number): Promise<string> {
  while (performance.now() < deadline) {
    const res = await fetch(
      `/api/signal/${encodeURIComponent(code)}/${encodeURIComponent(sessionId)}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (res.status === 204) continue;
    if (!res.ok) throw new Error(`The handshake failed (${res.status}).`);
    const { answer } = (await res.json()) as { answer?: string };
    if (typeof answer === 'string' && answer.length > 0) return answer;
  }
  throw new Error('The computer did not answer. Check the VRMC desktop app is running.');
}
