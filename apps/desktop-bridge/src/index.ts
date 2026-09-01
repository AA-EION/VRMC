#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import { DeviceId, DeviceStatus } from '@vrmc/protocol';
import { ArgError, parseArgs, USAGE, type BridgeConfig } from './config.js';
import { Router } from './core/Router.js';
import { BRIDGE_VERSION, runSelfTest } from './core/selfTest.js';
import { DEFAULT_PORT_NAME_TEMPLATE, DeviceManager } from './devices/DeviceManager.js';
import { listPorts } from './midi/openPort.js';
import { UdpServer } from './net/UdpServer.js';
import { WsServer } from './net/WsServer.js';

const log = (message: string): void => {
  process.stdout.write(`${new Date().toISOString().slice(11, 23)}  ${message}\n`);
};

/**
 * Addresses the bridge is actually reachable on, for the startup banner.
 *
 * When bound to a specific interface that address is the only truthful answer.
 * Only a wildcard bind means every local IPv4 address will work — and those are
 * what the user needs, since the Quest connects over the LAN, never loopback.
 */
function reachableAddresses(host: string): string[] {
  if (host !== '0.0.0.0' && host !== '::') return [host];
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) out.push(address.address);
    }
  }
  return out.length > 0 ? out : ['127.0.0.1'];
}

async function main(): Promise<void> {
  let config: BridgeConfig | 'help';
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`vrmc-bridge: ${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }

  if (config === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  if (config.listPorts) {
    const ports = await listPorts();
    process.stdout.write(
      ports.length > 0
        ? `MIDI outputs:\n${ports.map((p, i) => `  [${i}] ${p}`).join('\n')}\n`
        : 'No MIDI output ports found.\n',
    );
    return;
  }

  // Declared before the manager so its callbacks can reach the server, and
  // before the server so the server can read the device count.
  let ws: WsServer | null = null;

  const devices = new DeviceManager(
    {
      onLed: (deviceId, ledIndex, r, g, b, blink) => {
        ws?.queueLed(deviceId, ledIndex, r, g, b, blink);
      },
      onRosterChange: () => ws?.sendRoster(devices.roster()),
      onLog: log,
    },
    {
      noMidi: config.noMidi,
      loopbackPattern: config.loopbackPattern,
      portNameTemplate: config.portNameTemplate,
    },
  );

  // The original surfaces are one plain MIDI port with no hardware identity,
  // created up front so they behave exactly as they did before Launchpads
  // existed. Pads, keys and knobs share it and are told apart by their event
  // ids. Emulated hardware is spawned on demand from the headset instead.
  await devices.add(DeviceId.PADS, config.portName);
  devices.alias(DeviceId.KEYS, DeviceId.PADS);
  devices.alias(DeviceId.KNOBS, DeviceId.PADS);

  const router = new Router(devices, {
    onPanic: (released) => log(`panic: released ${released} note(s)`),
    onHello: (name) => log(`client identified as "${name}"`),
    onBye: () => log('client said goodbye'),
    onRosterChange: () => ws?.sendRoster(devices.roster()),
    onPong: () => ws?.notePong(),
    // Rate-limited by the caller below; a flood of malformed packets should not
    // itself become the thing that stalls the process.
    onMalformed: throttle((reason) => log(`dropped malformed packet: ${reason}`), 1000),
  });

  ws = config.enableWs
    ? new WsServer(router, {
        port: config.wsPort,
        host: config.host,
        tlsCert: config.tlsCert,
        tlsKey: config.tlsKey,
        onLog: log,
      })
    : null;
  if (ws !== null) {
    ws.deviceCount = () => devices.count;

    ws.statusProvider = () => ({
      version: BRIDGE_VERSION,
      addresses: reachableAddresses(config.host),
      wsPort: config.wsPort,
      udpPort: config.udpPort,
      secure: ws?.secure ?? false,
      clients: ws?.clientCount ?? 0,
      devices: devices.roster(),
      lastPacketAgoMs:
        router.stats.lastPacketAt === 0 ? null : Date.now() - router.stats.lastPacketAt,
      packetsIn: router.stats.packets,
      packetsOut: router.stats.packetsOut,
      eventsIn: router.stats.events,
      ledsOut: router.stats.ledsOut,
      jitterMs: router.stats.jitterMs,
      peakJitterMs: router.stats.peakJitterMs,
      lossRatio: router.stats.lossRatio,
      malformed: router.stats.malformed,
      midiAvailable: devices.roster().some((d) => d.status === DeviceStatus.READY),
    });

    ws.selfTest = (what) => runSelfTest(what, ws, devices);
  }

  const udp = config.enableUdp
    ? new UdpServer(router, { port: config.udpPort, host: config.host, onLog: log })
    : null;

  try {
    if (ws !== null) await ws.listen();
    if (udp !== null) await udp.listen();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`failed to start: ${message}`);
    if (message.includes('EADDRINUSE')) {
      log('Another copy of the bridge is probably already running.');
    }
    process.exit(1);
  }

  const scheme = ws?.secure === true ? 'wss' : 'ws';
  log(`${devices.count} device(s) open; emulated hardware is added from the headset`);
  if (ws !== null) {
    for (const address of reachableAddresses(config.host)) {
      log(`listening  ${scheme}://${address}:${config.wsPort}`);
    }
  }
  if (udp !== null) log(`listening  udp://${config.host}:${config.udpPort}`);
  if (ws !== null && !ws.secure) {
    log('note: plain ws:// — an HTTPS-hosted client will refuse this. See --tls-cert.');
  }

  let statsTimer: NodeJS.Timeout | null = null;
  if (config.statsInterval > 0) {
    statsTimer = setInterval(() => {
      if (router.stats.packets === 0) return;
      log(router.stats.summary());
      router.stats.resetWindow();
    }, config.statsInterval * 1000);
    // Do not hold the process open on the stats timer alone.
    statsTimer.unref();
  }

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`${signal} — shutting down`);
    if (statsTimer !== null) clearInterval(statsTimer);
    // Release before closing the ports: once they are gone there is nothing
    // left to send the Note Offs through, and whatever was sounding stays
    // sounding until the DAW is restarted.
    const released = router.releaseAll();
    if (released > 0) log(`released ${released} sounding note(s)`);
    await Promise.all([ws?.close(), udp?.close()]);
    devices.removeAll();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Call `fn` at most once per `intervalMs`, dropping the calls in between. */
function throttle<T extends unknown[]>(
  fn: (...args: T) => void,
  intervalMs: number,
): (...args: T) => void {
  let last = 0;
  return (...args: T): void => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    fn(...args);
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`vrmc-bridge: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
