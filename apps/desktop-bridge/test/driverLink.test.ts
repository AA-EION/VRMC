// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, vi, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriverLink } from "../src/midi/DriverLink.js";
import {
  FrameKind,
  FrameReader,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
} from "../src/midi/driverFraming.js";

/**
 * The link, over a real socket.
 *
 * The framing has its own tests and so do the ports; what is untested without
 * this is the join between them — that the bridge actually listens, that a
 * connection is noticed, that bytes written by something pretending to be the
 * driver arrive as messages, and that the socket file does not outlive the
 * process.
 *
 * That join is worth a real socket rather than a mock. The one time this was
 * assembled without it, every piece was tested and nothing was connected: the
 * link was never constructed anywhere in the bridge, so a driver would have
 * connected to a socket nobody was listening on. A mocked server would have
 * been just as green.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "vrmc-link-"));
  const path = join(dir, "driver.sock");
  const midi: { port: number; data: number[] }[] = [];
  const connections: boolean[] = [];

  const link = new DriverLink(
    {
      onMidi: (port, data) => midi.push({ port, data: [...data] }),
      onConnected: (c) => connections.push(c),
      onLog: () => {},
    },
    path,
  );
  await link.start();
  cleanup.push(async () => {
    await link.stop();
    await rm(dir, { recursive: true, force: true });
  });
  return { link, path, midi, connections };
}

/** A stand-in for the driver: connects, and speaks the real frame format. */
async function fakeDriver(path: string) {
  const socket: Socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const received: { kind: number; port: number; payload: number[] }[] = [];
  const reader = new FrameReader();
  socket.on("data", (chunk: Buffer) => {
    reader.push(new Uint8Array(chunk), (f) =>
      received.push({ kind: f.kind, port: f.port, payload: [...f.payload] }),
    );
  });
  cleanup.push(async () => {
    socket.destroy();
  });

  const send = (kind: number, port: number, payload: number[]): void => {
    const buf = new Uint8Array(HEADER_BYTES + payload.length);
    encodeFrame(buf, 0, kind, port, Uint8Array.from(payload));
    socket.write(buf);
  };
  return { socket, received, send };
}

describe("the link, over a real socket", () => {
  it("listens, and notices a driver connecting", async () => {
    const h = await harness();
    expect(h.link.connected).toBe(false);
    await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    expect(h.connections).toEqual([true]);
  });

  it("greets the driver with the protocol version", async () => {
    // A driver installed by one build and an app from another is ordinary —
    // the driver lives in the MIDI Drivers folder and outlives any app — so
    // both sides say which version they speak.
    const h = await harness();
    const driver = await fakeDriver(h.path);
    await vi.waitFor(() => expect(driver.received).toHaveLength(1));
    expect(driver.received[0]).toEqual({
      kind: FrameKind.HELLO,
      port: 0,
      payload: [PROTOCOL_VERSION],
    });
  });

  it("carries MIDI from the driver to the bridge", async () => {
    const h = await harness();
    const driver = await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    driver.send(FrameKind.MIDI, 2, [0x90, 60, 100]);
    await vi.waitFor(() =>
      expect(h.midi).toEqual([{ port: 2, data: [0x90, 60, 100] }]),
    );
  });

  it("carries MIDI from the bridge to the driver", async () => {
    const h = await harness();
    const driver = await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    expect(h.link.sendMidi(1, Uint8Array.of(0xb0, 7, 64))).toBe(true);
    await vi.waitFor(() =>
      expect(
        driver.received.filter((f) => f.kind === FrameKind.MIDI),
      ).toEqual([{ kind: FrameKind.MIDI, port: 1, payload: [0xb0, 7, 64] }]),
    );
  });

  it("carries a SysEx whole, which is how a Launchpad is lit", async () => {
    const h = await harness();
    const driver = await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    const sysex = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x03, ...Array(400).fill(0x2a), 0xf7];
    driver.send(FrameKind.MIDI, 2, sysex);
    await vi.waitFor(() => expect(h.midi[0]?.data).toEqual(sysex));
  });

  it("answers a ping, so a driver can tell a live link from a wedged one", async () => {
    const h = await harness();
    const driver = await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    driver.send(FrameKind.PING, 0, []);
    await vi.waitFor(() =>
      expect(driver.received.some((f) => f.kind === FrameKind.PONG)).toBe(true),
    );
  });

  it("reports the driver going away", async () => {
    const h = await harness();
    const driver = await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    driver.socket.destroy();
    await vi.waitFor(() => expect(h.link.connected).toBe(false));
    expect(h.connections).toEqual([true, false]);
  });

  it("sends nothing when no driver is connected, rather than throwing", async () => {
    // The ordinary state on a machine with no driver installed, and on every
    // machine while MIDIServer is idle. A note that threw on its way to a DAW
    // would take a performance down.
    const h = await harness();
    expect(h.link.sendMidi(0, Uint8Array.of(0x90, 60, 1))).toBe(false);
  });

  it("lets a second driver replace a stale first one", async () => {
    /*
     * A MIDIServer that was killed leaves a connection that will never say
     * anything again. Refusing the new one would leave the device dead until
     * the bridge restarted.
     */
    const h = await harness();
    await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    const second = await fakeDriver(h.path);
    await vi.waitFor(() => expect(second.received).toHaveLength(1));
    second.send(FrameKind.MIDI, 0, [0x90, 61, 1]);
    await vi.waitFor(() => expect(h.midi).toEqual([{ port: 0, data: [0x90, 61, 1] }]));
  });

  it("drops a peer that is not speaking this protocol", async () => {
    // A length beyond the maximum has no resynchronisation point — the reader
    // would wait forever for bytes that are not coming, looking connected.
    const h = await harness();
    const driver = await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    driver.socket.write(Buffer.from([0xff, 0xff, 0x00, FrameKind.MIDI]));
    await vi.waitFor(() => expect(h.link.connected).toBe(false));
  });

  it("refuses to send more than one frame can carry", async () => {
    // Writing a header whose length does not match its body would desynchronise
    // the stream permanently. Dropping one message is the lesser failure.
    const h = await harness();
    await fakeDriver(h.path);
    await vi.waitFor(() => expect(h.link.connected).toBe(true));
    expect(h.link.sendMidi(0, new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toBe(false);
  });

  it("removes the socket file on stop, so the next run can bind", async () => {
    const h = await harness();
    await h.link.stop();
    const { existsSync } = await import("node:fs");
    expect(existsSync(h.path)).toBe(false);
  });
});
