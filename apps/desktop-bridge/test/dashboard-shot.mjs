// SPDX-License-Identifier: GPL-3.0-only
/**
 * Render the dashboard in a real browser and capture it.
 *
 * The unit tests prove the endpoints answer; this proves the page actually
 * draws, which is the whole point of it existing.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { WebSocket } from 'ws';
import { DeviceModel } from '@vrmc/devices';
import { PacketKind, PacketReader, PacketWriter, EventType, DeviceId } from '@vrmc/protocol';
import { Router } from '../dist/core/Router.js';
import { runSelfTest, BRIDGE_VERSION } from '../dist/core/selfTest.js';
import { DeviceManager } from '../dist/devices/DeviceManager.js';
import { NullSink, NullSource, SimpleVirtualPort } from '../dist/midi/MidiSink.js';
import { WsServer } from '../dist/net/WsServer.js';

const PORT = 28999;

const devices = new DeviceManager(
  { onLed: (...a) => ws.queueLed(...a), onRosterChange: () => {}, onLog: () => {} },
  {
    noMidi: false,
    loopbackPattern: /never/,
    portNameTemplate: '{device} {port}',
    openPort: async ({ name }) => ({
      port: new SimpleVirtualPort(name, new NullSink(name, true), new NullSource(name)),
      ok: true,
      notes: [],
    }),
  },
);
const router = new Router(devices, { onPong: () => ws.notePong() });
const ws = new WsServer(router, { port: PORT, host: '127.0.0.1', onLog: () => {} });
ws.deviceCount = () => devices.count;
ws.selfTest = (what) => runSelfTest(what, ws, devices);
ws.statusProvider = () => ({
  version: BRIDGE_VERSION,
  addresses: ['192.168.1.42'],
  wsPort: PORT,
  udpPort: PORT + 1,
  secure: false,
  clients: ws.clientCount,
  devices: devices.roster(),
  lastPacketAgoMs: router.stats.lastPacketAt === 0 ? null : Date.now() - router.stats.lastPacketAt,
  packetsIn: router.stats.packets,
  packetsOut: router.stats.packetsOut,
  eventsIn: router.stats.events,
  ledsOut: router.stats.ledsOut,
  jitterMs: router.stats.jitterMs,
  peakJitterMs: router.stats.peakJitterMs,
  lossRatio: router.stats.lossRatio,
  malformed: router.stats.malformed,
  midiAvailable: true,
  pairingCode: 'K7M-2QX',
  pairingRegistered: true,
  pairingError: '',
  siteUrl: 'https://vrmc.eionstudios.com',
  lanUrls: ['wss://192-168-1-42.lan.vrmc.eionstudios.com:7401'],
});
await ws.listen();

await devices.add(DeviceId.PADS, 'VRMC');
await devices.add(16, DeviceModel.LAUNCHPAD_X);
await devices.add(17, DeviceModel.LAUNCHPAD_PRO_MK3);

// A stand-in headset: answers pings and sends a little traffic, so the page
// shows a live link rather than an empty one.
const client = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => client.once('open', r));
const reader = new PacketReader();
client.on('message', (data) => {
  if (reader.read(data, null) !== 0) return;
  if (reader.header.kind !== PacketKind.PING) return;
  const w = new PacketWriter();
  w.begin(PacketKind.PONG);
  client.send(w.finish(reader.header.tClient).slice());
});

const w = new PacketWriter();
for (let i = 0; i < 40; i++) {
  w.begin(PacketKind.EVENTS);
  w.pushEvent(EventType.NOTE_ON, 0, 11 + (i % 8), 100, 0, 16, 0, 0);
  client.send(w.finish(performance.now()).slice());
  await new Promise((r) => setTimeout(r, 6));
}

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROMIUM_PATH]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!exe) {
  console.log('no Chromium; skipping screenshot');
  process.exit(0);
}

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 820, height: 1000 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(600);

// Run each audit leg so the results panel has real output in the shot.
for (const id of ['#btn-headset', '#btn-midi', '#btn-leds']) {
  await page.click(id);
  await page.waitForTimeout(400);
}
await page.waitForTimeout(400);

await page.screenshot({ path: process.env.SHOT ?? 'dashboard.png', fullPage: true });
console.log('captured');
await browser.close();
client.close();
await ws.close();
process.exit(0);
