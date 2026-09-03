import { DeviceModel, HARDWARE_MODELS } from '@vrmc/devices';
import { DEFAULT_UDP_PORT, DEFAULT_WS_PORT } from '@vrmc/protocol';
import { WINDOWS_LOOPBACK_PATTERN } from './midi/openPort.js';

export interface BridgeConfig {
  portName: string;
  wsPort: number;
  udpPort: number;
  host: string;
  enableUdp: boolean;
  enableWs: boolean;
  noMidi: boolean;
  listPorts: boolean;
  /** Verify the native addons load, print the result, and exit. */
  check: boolean;
  /**
   * Install or remove the CoreMIDI driver, then exit.
   *
   * `user` installs into ~/Library/Audio/MIDI Drivers and asks for nothing;
   * `system` installs into /Library and costs one administrator password. See
   * src/midi/driverInstall.ts for why that cannot be Touch ID.
   */
  driverAction: 'none' | 'install-user' | 'install-system' | 'uninstall';
  /** Seconds between stats lines. 0 disables them. */
  statsInterval: number;
  tlsCert?: string;
  tlsKey?: string;
  /**
   * Generate a self-signed certificate so the WebSocket speaks wss://.
   *
   * Off by default, and rarely worth turning on. A headset on the hosted client
   * connects over a WebRTC data channel, which authenticates by DTLS
   * fingerprint and needs no certificate at all; the WebSocket is left for a
   * client running on this same machine, where plain ws:// is a secure context
   * already. A self-signed certificate here would only produce a warning
   * nobody should be taught to click through.
   */
  selfSignedTls: boolean;
  /** Base URL of the pairing service, or empty to publish nothing. */
  pairingService: string;
  /** Accept headset connections brokered over WebRTC by the pairing service. */
  enableRtc: boolean;
  /**
   * Show a menu bar / notification-area icon.
   *
   * On by default because it is the bridge's only user interface. Turn it off
   * for a headless machine, or when running under a supervisor that would
   * rather the process had no desktop presence at all.
   */
  enableTray: boolean;
  loopbackPattern: RegExp;
  /**
   * How emulated devices name their MIDI ports. `{device}` is the model's
   * display name, `{port}` the endpoint name, `{model}` the slug.
   *
   * A DAW decides what a port is by its name, so this is the knob to reach for
   * when a host expects a different spelling than the default.
   */
  portNameTemplate: string;
  /**
   * Emulated hardware to open at startup, or `none` for just the plain port.
   *
   * The plain port is honest but anonymous: a DAW sees "VRMC", has no script
   * that matches it, and treats it as a nameless keyboard. Nothing lights up,
   * no session grid appears, and the answer — "spawn a Launchpad from inside
   * the headset" — is not something a user finds by looking at Ableton.
   *
   * So a Launchpad X is open before anyone puts the headset on. It is emulated
   * completely enough for Ableton to bind its own control-surface script:
   * matching port names, a Device Inquiry reply carrying the family code, and
   * the LED SysEx the script drives. The headset adopts it from the roster and
   * draws it, so the lights the DAW sends have somewhere to land.
   */
  startupDevice: string;
  /**
   * How long the MIDI ports survive the last client leaving, in milliseconds.
   *
   * Not zero: a headset's Wi-Fi drops for a second at a time, and a DAW that
   * sees a control surface vanish unbinds its script rather than waiting.
   */
  portGraceMs: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  portName: 'VRMC',
  wsPort: DEFAULT_WS_PORT,
  udpPort: DEFAULT_UDP_PORT,
  // Bind on all interfaces: the Quest reaches us over the LAN, not loopback.
  host: '0.0.0.0',
  enableUdp: true,
  enableWs: true,
  noMidi: false,
  listPorts: false,
  check: false,
  driverAction: 'none',
  statsInterval: 10,
  loopbackPattern: WINDOWS_LOOPBACK_PATTERN,
  portNameTemplate: '{device} {port}',
  selfSignedTls: false,
  pairingService: 'https://vrmc.eionstudios.com',
  enableRtc: true,
  enableTray: true,
  /*
   * Nothing, until a headset asks.
   *
   * This was LAUNCHPAD_X, opened at startup — which meant a Mac with the
   * bridge merely running listed a Launchpad in every DAW on it, with nothing
   * on the other end. Set it to a model to get that behaviour back; the device
   * then appears when a headset connects rather than when the bridge starts.
   */
  startupDevice: 'none',
  portGraceMs: 10_000,
};

export const USAGE = `
vrmc-bridge — virtual MIDI bridge for the VRMC mixed-reality controller

Usage: vrmc-bridge [options]

  --name <text>        Name of the virtual MIDI port (default: VRMC)
  --ws-port <n>        WebSocket port (default: ${DEFAULT_WS_PORT})
  --udp-port <n>       UDP port (default: ${DEFAULT_UDP_PORT})
  --host <addr>        Bind address (default: 0.0.0.0)
  --no-udp             Disable the UDP transport
  --no-ws              Disable the WebSocket transport
  --no-midi            Accept packets but send no MIDI (network testing)
  --tls-cert <path>    TLS certificate for the WebSocket
  --tls-key <path>     TLS private key
  --self-signed-tls    Generate a certificate and serve wss:// (rarely needed)
  --pair-service <url> Pairing service base URL ("" to disable)
  --no-rtc             Refuse WebRTC connections from the hosted client
  --no-tray            Run without a menu bar / notification-area icon
  --loopback <regex>   Windows: pattern for the fallback port
  --port-template <s>  Naming for emulated device ports
                       (default: "{device} {port}", e.g. "Launchpad X LPX DAW")
  --device <model>     Emulated hardware to open for a session: ${HARDWARE_MODELS.join(
    ', ',
  )},
                       or "none" (default: ${DEFAULT_CONFIG.startupDevice}).
                       Ports open when a headset connects, not at startup.
  --port-grace <secs>  Keep the ports open this long after the last client
                       leaves, so a brief drop does not make the DAW unbind
                       (default: ${DEFAULT_CONFIG.portGraceMs / 1000})
  --stats <seconds>    Stats interval, 0 to disable (default: 10)
  --list-ports         List MIDI outputs and exit
  --check              Verify the native libraries load, then exit
  --install-driver     Install the CoreMIDI driver for this user and exit, so
                       an emulated Launchpad appears as one device with its
                       ports rather than as separate devices. No password.
  --install-driver-system
                       The same, for every user on this Mac. Asks once for an
                       administrator password (macOS gives third-party apps no
                       way to offer Touch ID here).
  --uninstall-driver   Remove the driver installed for this user and exit
  --help               Show this message

A headset running the hosted client connects over a WebRTC data channel: read
the pairing code off the dashboard, type it in the headset, and the two
negotiate a direct connection. No certificate, no DNS, no port forwarding —
see docs/PAIRING.md.
`.trimStart();

class ArgError extends Error {}

/** Parse argv. Throws `ArgError` with a readable message on bad input. */
export function parseArgs(argv: readonly string[]): BridgeConfig | 'help' {
  const config: BridgeConfig = { ...DEFAULT_CONFIG };

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) {
      throw new ArgError(`${flag} needs a value`);
    }
    return value;
  };

  const requirePort = (flag: string, value: string | undefined): number => {
    const n = Number(requireValue(flag, value));
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new ArgError(`${flag} must be a port number between 1 and 65535`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--name':
        config.portName = requireValue(arg, argv[++i]);
        break;
      case '--ws-port':
        config.wsPort = requirePort(arg, argv[++i]);
        break;
      case '--udp-port':
        config.udpPort = requirePort(arg, argv[++i]);
        break;
      case '--host':
        config.host = requireValue(arg, argv[++i]);
        break;
      case '--port-grace': {
        const seconds = Number(requireValue(arg, argv[++i]));
        // Zero is allowed and means "close as soon as the last client goes" —
        // a legitimate choice for a fixed installation where nothing ever
        // reconnects, and the one case where a DAW unbinding does not matter.
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`${arg} needs a number of seconds, not "${argv[i]}"`);
        }
        config.portGraceMs = Math.round(seconds * 1000);
        break;
      }
      case '--no-udp':
        config.enableUdp = false;
        break;
      case '--no-ws':
        config.enableWs = false;
        break;
      case '--no-midi':
        config.noMidi = true;
        break;
      case '--list-ports':
        config.listPorts = true;
        break;
      case '--check':
        config.check = true;
        break;
      case '--install-driver':
        config.driverAction = 'install-user';
        break;
      case '--install-driver-system':
        config.driverAction = 'install-system';
        break;
      case '--uninstall-driver':
        config.driverAction = 'uninstall';
        break;
      case '--tls-cert':
        config.tlsCert = requireValue(arg, argv[++i]);
        break;
      case '--tls-key':
        config.tlsKey = requireValue(arg, argv[++i]);
        break;
      case '--self-signed-tls':
        config.selfSignedTls = true;
        break;
      case '--pair-service':
        config.pairingService = argv[++i] ?? '';
        break;
      case '--no-rtc':
        config.enableRtc = false;
        break;
      case '--no-tray':
        config.enableTray = false;
        break;
      case '--loopback':
        config.loopbackPattern = new RegExp(requireValue(arg, argv[++i]), 'i');
        break;
      case '--port-template': {
        const template = requireValue(arg, argv[++i]);
        if (!template.includes('{port}')) {
          throw new ArgError('--port-template must contain {port}, or both ports collide');
        }
        config.portNameTemplate = template;
        break;
      }
      case '--device': {
        const model = requireValue(arg, argv[++i]);
        if (model !== 'none' && !HARDWARE_MODELS.includes(model as DeviceModel)) {
          throw new ArgError(
            `--device must be one of ${HARDWARE_MODELS.join(', ')}, or "none"`,
          );
        }
        config.startupDevice = model;
        break;
      }
      case '--stats': {
        const n = Number(requireValue(arg, argv[++i]));
        if (!Number.isFinite(n) || n < 0) throw new ArgError('--stats must be 0 or more');
        config.statsInterval = n;
        break;
      }
      default:
        throw new ArgError(`unknown option: ${arg}`);
    }
  }

  if (!config.enableWs && !config.enableUdp && !config.enableRtc) {
    throw new ArgError('--no-ws, --no-udp and --no-rtc together leave no way in');
  }
  if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) {
    throw new ArgError('--tls-cert and --tls-key must be given together');
  }
  if (config.wsPort === config.udpPort && config.enableWs && config.enableUdp) {
    // They are different protocols and would not actually collide, but equal
    // ports here is nearly always a typo, and a silent one.
    throw new ArgError('--ws-port and --udp-port are the same; did you mean different ports?');
  }

  return config;
}

export { ArgError };
