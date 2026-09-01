#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import { DeviceId, DeviceStatus, isPrivateAddress } from '@vrmc/protocol';
import { ArgError, parseArgs, USAGE, type BridgeConfig } from './config.js';
import { Router } from './core/Router.js';
import { BRIDGE_VERSION, runSelfTest } from './core/selfTest.js';
import { autostartState, toggleAutostart } from './setup/autostart.js';
import { runFirstLaunch } from './setup/firstRun.js';
import { ensureCertificate } from './setup/certificate.js';
import { PairingPublisher } from './setup/pairing.js';
import { copyToClipboard, openUrl } from './tray/desktop.js';
import { buildMenu, buildTooltip, TrayAction, type TrayState } from './tray/menu.js';
import { TrayController } from './tray/TrayController.js';
import { DEFAULT_PORT_NAME_TEMPLATE, DeviceManager } from './devices/DeviceManager.js';
import { listPorts } from './midi/openPort.js';
import { Broadcaster } from './net/Broadcaster.js';
import { RtcTransport } from './net/RtcTransport.js';
import { SignalClient } from './net/SignalClient.js';
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

  // Declared before the manager so its callbacks can reach it, and before the
  // router because it is built from the router's stats.
  let broadcast: Broadcaster | null = null;

  const devices = new DeviceManager(
    {
      onLed: (deviceId, ledIndex, r, g, b, blink) => {
        broadcast?.queueLed(deviceId, ledIndex, r, g, b, blink);
      },
      onRosterChange: () => broadcast?.sendRoster(devices.roster()),
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
    onRosterChange: () => broadcast?.sendRoster(devices.roster()),
    onPong: () => broadcast?.notePong(),
    // Rate-limited by the caller below; a flood of malformed packets should not
    // itself become the thing that stalls the process.
    onMalformed: throttle((reason) => log(`dropped malformed packet: ${reason}`), 1000),
  });

  // TLS on the WebSocket is opt-in, and almost nobody needs it. The headset
  // reaches this bridge over a WebRTC data channel — authenticated by DTLS
  // fingerprint, so there is no certificate to obtain, install or trust — and
  // what is left on the WebSocket is a client running on this same machine,
  // where plain ws:// is already a secure context.
  let tlsCert = config.tlsCert;
  let tlsKey = config.tlsKey;
  if (config.selfSignedTls && (tlsCert === undefined || tlsKey === undefined)) {
    try {
      const generated = await ensureCertificate(reachableAddresses(config.host));
      tlsCert = generated.certPath;
      tlsKey = generated.keyPath;
      if (generated.created) {
        log(`generated a TLS certificate for ${generated.names.join(', ')}`);
      }
    } catch (err) {
      log(`could not prepare TLS: ${err instanceof Error ? err.message : String(err)}`);
      log('continuing on plain ws://');
    }
  }

  const ws = config.enableWs
    ? new WsServer(router, {
        port: config.wsPort,
        host: config.host,
        tlsCert,
        tlsKey,
        onLog: log,
      })
    : null;
  // Every headset-bound packet fans out through here, so a client on the
  // WebSocket and one on a data channel see exactly the same stream.
  const bus = new Broadcaster(router.stats);
  broadcast = bus;
  if (ws !== null) bus.add(ws);

  const rtc = config.enableRtc
    ? new RtcTransport(router, {
        onLog: log,
        // A headset that has just arrived has no idea what devices exist, and
        // it is the roster that tells it what to draw.
        onPeerChange: () => bus.sendRoster(devices.roster()),
      })
    : null;
  if (rtc !== null) bus.add(rtc);

  if (ws !== null) {
    ws.deviceCount = () => devices.count;

    ws.statusProvider = () => ({
      version: BRIDGE_VERSION,
      addresses: reachableAddresses(config.host),
      wsPort: config.wsPort,
      udpPort: config.udpPort,
      secure: ws?.secure ?? false,
      clients: bus.clientCount,
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
      pairingCode: pairing?.displayCode ?? '',
      pairingRegistered: pairing?.isRegistered ?? false,
      pairingError: pairing?.error ?? '',
      siteUrl: config.pairingService,
      rtcPeers: rtc?.peerCount ?? 0,
      rtcError: signalling?.error ?? '',
    });

    // Audits the whole outbound path, so it covers whichever transport the
    // headset actually arrived on.
    ws.selfTest = (what) => runSelfTest(what, bus, devices);
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

  /** Addresses a headset could plausibly reach this machine on. */
  const lanAddresses = (): string[] =>
    reachableAddresses(config.host).filter(isPrivateAddress);

  // Publishing the pairing code is what lets a headset on the hosted client
  // find this machine without anyone typing an address. The code is also what
  // the WebRTC handshake is keyed on, so the two go up together.
  const pairing =
    config.pairingService === ''
      ? null
      : new PairingPublisher({
          serviceUrl: config.pairingService,
          port: config.wsPort,
          version: BRIDGE_VERSION,
          addresses: lanAddresses,
          onLog: log,
        });
  pairing?.start();

  /*
   * Wait at the pairing service for a headset that wants in.
   *
   * This is the whole connection story for someone using the hosted client:
   * they read six characters off the dashboard and type them in the headset.
   * No certificate to install, no hostname to configure, no port to forward —
   * the offer arrives here, the answer goes back, and the data channel that
   * forms carries MIDI directly between the two machines.
   */
  let signalling: SignalClient | null = null;
  if (rtc !== null && pairing !== null) {
    if (await rtc.load()) {
      signalling = new SignalClient({
        serviceUrl: config.pairingService,
        code: pairing.code,
        answer: (sessionId, offer) => rtc.answer(sessionId, offer),
        onLog: log,
      });
      signalling.start();
      log('waiting for a headset to pair');
    } else {
      log('WebRTC is unavailable, so the hosted client cannot reach this bridge');
    }
  }

  if (pairing !== null) {
    log(`pairing code: ${pairing.displayCode}`);
    log(`open ${config.pairingService} in the headset and enter it`);
  }

  /*
   * The menu bar icon.
   *
   * This is the bridge's only user interface. It runs all day doing nothing
   * visible, so a window would be wrong — but so is no presence at all: a
   * musician whose headset will not connect needs somewhere to look, and
   * "check whether a background process is running" is not an answer.
   *
   * Everything here degrades quietly. No helper binary, no toolchain that
   * built one, a helper that crashes — the bridge logs it once and carries on
   * serving MIDI, because an icon is worth nothing next to that.
   */
  const dashboardUrl = `${ws?.secure === true ? 'https' : 'http'}://127.0.0.1:${config.wsPort}/`;

  // Dragging the app to Applications and opening it is the whole installation,
  // so the first launch registers the login item itself. See setup/firstRun.ts
  // for why that is a defensible thing to decide on someone's behalf.
  const firstRun = await runFirstLaunch();
  if (firstRun.first) {
    log(firstRun.registered ? 'set up to start at login' : `first run: ${firstRun.reason}`);
  }

  let autostart = await autostartState();

  const trayState = (): TrayState => ({
    pairingCode: pairing?.displayCode ?? '',
    pairingRegistered: pairing?.isRegistered ?? false,
    clients: bus.clientCount,
    devices: devices.count,
    midiReady: devices.roster().some((d) => d.status === DeviceStatus.READY),
    dashboardUrl,
    autostart,
  });

  let tray: TrayController | null = null;
  const refreshTray = (): void => {
    if (tray === null) return;
    const state = trayState();
    tray.setMenu(buildTooltip(state), buildMenu(state));
  };

  const handleTrayClick = async (id: string): Promise<void> => {
    switch (id) {
      case TrayAction.COPY_CODE: {
        const code = pairing?.displayCode ?? '';
        if (code === '') return;
        // Logged either way: a machine with no clipboard utility should still
        // put the code somewhere the user can reach it.
        log((await copyToClipboard(code)) ? `copied ${code}` : `pairing code: ${code}`);
        return;
      }
      case TrayAction.DASHBOARD:
        openUrl(dashboardUrl);
        return;
      case TrayAction.AUTOSTART:
        autostart = await toggleAutostart();
        log(autostart === 'on' ? 'will start at login' : 'will not start at login');
        refreshTray();
        return;
      case TrayAction.QUIT:
        await shutdown('menu');
        return;
      default:
        return;
    }
  };

  if (config.enableTray) {
    const controller = new TrayController({
      onLog: log,
      onQuit: () => void shutdown('menu'),
      onClick: (id) => void handleTrayClick(id),
    });
    if (controller.start()) {
      tray = controller;
      refreshTray();
      // Rebuilt whole on a timer, which is cheap and means the rows can never
      // be a mix of old and new state. Two seconds is well below the point
      // where a glance at the menu would show something stale.
      const trayTimer = setInterval(refreshTray, 2000);
      trayTimer.unref();
    } else {
      log('no tray helper found; running without a menu bar icon');
    }
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
    tray?.stop();
    signalling?.stop();
    rtc?.close();
    bus.close();
    await Promise.all([ws?.close(), udp?.close(), pairing?.stop()]);
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
