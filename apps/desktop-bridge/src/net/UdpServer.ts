import { createSocket, type Socket } from 'node:dgram';
import { PacketKind, PacketWriter, MAX_PACKET_BYTES } from '@vrmc/protocol';
import type { Router } from '../core/Router.js';

export interface UdpOptions {
  port: number;
  host: string;
  onLog: (message: string) => void;
}

/**
 * UDP transport — the path a native client uses (the Unity build under
 * `unity/`, or anything else that can open a socket).
 *
 * UDP is the right transport for this traffic and TCP is a compromise we accept
 * only because browsers give us no choice. A control message has a useful life
 * of a few milliseconds: if a Note On is lost, the correct response is to carry
 * on, because by the time TCP has noticed and retransmitted it, the moment it
 * belonged to has passed. Worse, TCP's in-order delivery means one lost packet
 * stalls every packet behind it — a single dropped frame becomes an audible
 * gap followed by a burst of late notes.
 *
 * Losing a Note Off is the one case that does real damage, and that is handled
 * where it belongs: the bridge's `NoteTracker` releases anything left sounding.
 */
export class UdpServer {
  private socket: Socket | null = null;
  private readonly router: Router;
  private readonly options: UdpOptions;
  private readonly replyWriter = new PacketWriter();

  /** Last peer to send us anything, so pongs have somewhere to go. */
  private peerAddress: string | null = null;
  private peerPort = 0;

  constructor(router: Router, options: UdpOptions) {
    this.router = router;
    this.options = options;
  }

  async listen(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (msg, rinfo) => {
      const arrival = performance.now();
      this.peerAddress = rinfo.address;
      this.peerPort = rinfo.port;
      this.router.handlePacket(msg, arrival, (clientTime, serverTime) => {
        this.sendPong(clientTime, serverTime);
      });
    });

    socket.on('error', (err) => {
      this.options.onLog(`udp error: ${err.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.options.port, this.options.host, () => {
        socket.removeListener('error', reject);
        // Enlarge the kernel receive buffer. The default is small enough that a
        // burst — ten fingers landing on a chord inside one frame — can be
        // dropped by the OS before Node ever sees it.
        try {
          socket.setRecvBufferSize(MAX_PACKET_BYTES * 256);
        } catch {
          // Not permitted on every platform; the default still works.
        }
        resolve();
      });
    });
  }

  private sendPong(clientTime: number, serverTime: number): void {
    if (this.peerAddress === null) return;
    const w = this.replyWriter;
    w.begin(PacketKind.PONG);
    w.pushFloat64(serverTime);
    const frame = w.finish(clientTime);
    // dgram copies synchronously on send, so the shared writer buffer is safe.
    this.socket?.send(frame, this.peerPort, this.peerAddress);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.socket === null) return resolve();
      this.socket.close(() => resolve());
    });
  }
}
