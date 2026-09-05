// SPDX-License-Identifier: GPL-3.0-only

/**
 * The bridge's end of the link to the CoreMIDI driver.
 *
 * WHY THERE IS A SOCKET
 * A CoreMIDI driver must live inside MIDIServer, and Node cannot. So the two
 * halves of the emulated Launchpad are always two processes: the driver owns
 * the device a DAW sees, and the bridge owns everything else — the headset,
 * the emulator, the LED state. Every message crosses this.
 *
 * WHICH WAY THINGS GO
 *   DAW → driver's destination → `Send()` → socket → here → headset
 *   headset → here → socket → driver → `MIDIReceived()` → DAW
 *
 * WHY THE BRIDGE LISTENS AND THE DRIVER CONNECTS
 * The driver's lifetime is not ours: MIDIServer loads it on demand and exits
 * when idle, so it comes and goes many times in a session. The bridge is the
 * long-lived side, so it holds the listening socket and the driver reconnects
 * to it — which also means a driver that starts before the bridge simply
 * retries, rather than the bridge having to discover a socket that is not
 * there yet.
 *
 * WHERE THE SOCKET LIVES
 * Under the user's own Application Support directory, in a directory created
 * 0700. Not /tmp: that is world-writable, and a socket there lets any local
 * account inject MIDI into the performance or read every note played. The
 * per-user path is also the right scope — MIDIServer runs as the logged-in
 * user, so there is exactly one pairing to make.
 *
 * ONLY ONE DRIVER AT A TIME
 * A second connection replaces the first. Two MIDIServers is not a thing that
 * happens, but a stale connection from a MIDIServer that was killed is, and
 * the alternative — refusing the new one — would leave the device dead until
 * the bridge restarted.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FrameKind,
  FrameReader,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
} from "./driverFraming.js";

/** Where the driver looks for us. Must match kSocketPath in the driver. */
export function driverSocketPath(home = homedir()): string {
  return join(home, "Library/Application Support/VRMC/driver.sock");
}

export interface DriverLinkEvents {
  /** MIDI arrived from a DAW, on `port`. */
  onMidi(port: number, data: Uint8Array): void;
  /** The driver connected or went away; the device follows this. */
  onConnected(connected: boolean): void;
  onLog(message: string): void;
}

export class DriverLink {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private readonly reader = new FrameReader();
  private readonly path: string;
  private readonly events: DriverLinkEvents;

  /**
   * One scratch buffer for outgoing frames.
   *
   * Reused rather than allocated per message: a pad roll is a few hundred
   * messages a second and this is on that path. Safe because `send` writes and
   * hands the bytes to the socket synchronously before returning.
   */
  private readonly scratch = new Uint8Array(HEADER_BYTES + MAX_PAYLOAD_BYTES);

  constructor(events: DriverLinkEvents, path = driverSocketPath()) {
    this.events = events;
    this.path = path;
  }

  /** True while a driver is connected and has said hello. */
  get connected(): boolean {
    return this.socket !== null;
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Explicitly, because mkdir's mode is masked by the process umask and a
    // 0755 directory here is the difference this comment is about.
    await chmod(dirname(this.path), 0o700).catch(() => {});
    // A socket file survives a crash and then refuses to bind. Removing it is
    // safe: if a live server still held it, binding would fail anyway.
    await rm(this.path, { force: true });

    const server = createServer((socket) => this.accept(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(this.path, 0o600).catch(() => {});
    this.events.onLog(`listening for the CoreMIDI driver on ${this.path}`);
  }

  private accept(socket: Socket): void {
    if (this.socket !== null) {
      // A MIDIServer that was killed leaves a connection that will never send
      // anything again. The new one is the real one.
      this.events.onLog("a second driver connected; dropping the first");
      this.socket.destroy();
    }
    this.socket = socket;
    this.reader.push(new Uint8Array(0), () => {});
    // Nagle would coalesce a Note On with whatever came next, which on a
    // control surface is a visible delay for no bandwidth worth saving.
    socket.setNoDelay(true);

    socket.on("data", (chunk: Buffer) => {
      const ok = this.reader.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        (frame) => this.handle(frame.kind, frame.port, frame.payload),
      );
      if (!ok) {
        this.events.onLog("the driver sent something this protocol cannot read");
        socket.destroy();
      }
    });

    const done = (): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.events.onLog("the CoreMIDI driver disconnected");
      this.events.onConnected(false);
    };
    socket.on("close", done);
    socket.on("error", done);

    this.send(FrameKind.HELLO, 0, Uint8Array.of(PROTOCOL_VERSION));
    this.events.onLog("the CoreMIDI driver connected");
    this.events.onConnected(true);
  }

  private handle(kind: number, port: number, payload: Uint8Array): void {
    switch (kind) {
      case FrameKind.MIDI:
        this.events.onMidi(port, payload);
        break;
      case FrameKind.HELLO: {
        const version = payload[0];
        if (version !== PROTOCOL_VERSION) {
          /*
           * Not fatal, and said out loud. The driver lives in the MIDI Drivers
           * folder and outlives any particular app, so an app and a driver
           * from different builds is an ordinary situation rather than a
           * corrupt one — and the person seeing a device that behaves oddly
           * deserves to be told which half is old.
           */
          this.events.onLog(
            `the installed driver speaks version ${String(version)}, this app speaks ${PROTOCOL_VERSION};` +
              " reinstall it from the tray menu",
          );
        }
        break;
      }
      case FrameKind.PING:
        this.send(FrameKind.PONG, 0, EMPTY);
        break;
      case FrameKind.PONG:
        break;
      default:
        // An unknown kind from a newer driver. Ignoring it is what lets the
        // format grow without every old build refusing to talk to a new one.
        break;
    }
  }

  /**
   * Send MIDI to the driver, for it to hand a DAW.
   *
   * @returns false when nothing is connected, which is the ordinary state when
   *   the driver is not installed — callers fall back to virtual ports.
   */
  sendMidi(address: number, data: Uint8Array): boolean {
    return this.send(FrameKind.MIDI, address, data);
  }

  /** Send any frame. For device presence, which is not MIDI. */
  sendFrame(kind: number, address: number, payload: Uint8Array): boolean {
    return this.send(kind, address, payload);
  }

  private send(kind: number, port: number, payload: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null) return false;
    const written = encodeFrame(this.scratch, 0, kind, port, payload);
    if (written < 0) {
      // Only reachable for a payload over the cap — a SysEx larger than any
      // Launchpad message. Dropping one message beats desynchronising the
      // stream by writing a header whose length does not match its body.
      this.events.onLog(`dropped an oversized message (${payload.length} bytes)`);
      return false;
    }
    return socket.write(this.scratch.subarray(0, written));
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.path, { force: true });
  }
}

const EMPTY = new Uint8Array(0);
