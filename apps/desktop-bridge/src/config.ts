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
  /** Seconds between stats lines. 0 disables them. */
  statsInterval: number;
  tlsCert?: string;
  tlsKey?: string;
  loopbackPattern: RegExp;
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
  statsInterval: 10,
  loopbackPattern: WINDOWS_LOOPBACK_PATTERN,
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
  --tls-cert <path>    TLS certificate; enables wss://
  --tls-key <path>     TLS private key
  --loopback <regex>   Windows: pattern for the fallback port
  --stats <seconds>    Stats interval, 0 to disable (default: 10)
  --list-ports         List MIDI outputs and exit
  --help               Show this message

A page served over HTTPS cannot open a plain ws:// socket, so a hosted XR
client needs --tls-cert/--tls-key. See docs/WEB-DEPLOYMENT.md.
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
      case '--tls-cert':
        config.tlsCert = requireValue(arg, argv[++i]);
        break;
      case '--tls-key':
        config.tlsKey = requireValue(arg, argv[++i]);
        break;
      case '--loopback':
        config.loopbackPattern = new RegExp(requireValue(arg, argv[++i]), 'i');
        break;
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

  if (!config.enableWs && !config.enableUdp) {
    throw new ArgError('--no-ws and --no-udp together leave no way in');
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
