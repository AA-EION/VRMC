# VRMC

A mixed-reality MIDI controller for Meta Quest 3, and the desktop bridge that
makes it look like a normal MIDI device to your DAW.

Virtual pads and keys sit on your real desk in full-colour passthrough. You play
them with your hands — no controllers — and the notes arrive in Ableton, Logic,
REAPER or Pro Tools as if they came from hardware plugged into USB.

```
  Quest 3                          Wi-Fi                    Desktop
┌──────────────────────┐                          ┌──────────────────────────┐
│  WebXR client        │                          │  Bridge (Node)           │
│  ├ hand tracking     │   binary packets over    │  ├ WebSocket + UDP       │
│  ├ poke detection    │ ───  ws / wss / udp  ──▶ │  ├ note bookkeeping      │
│  └ velocity + notes  │                          │  └ virtual MIDI port     │
└──────────────────────┘                          └───────────┬──────────────┘
                                                              │ CoreMIDI / ALSA
                                                              │ teVirtualMIDI
                                                              ▼
                                                        Your DAW
```

## Quick start

Requires Node 20.11+ and pnpm 10.

```bash
git clone https://github.com/AA-EION/VRMC.git
cd VRMC
pnpm install
pnpm build
```

**On the computer running your DAW:**

```bash
pnpm bridge
```

It prints the addresses it is listening on. On macOS and Linux a virtual MIDI
port named `VRMC` appears immediately — open your DAW's MIDI preferences and
enable it as an input. On Windows there is a setup step first; see
[docs/VIRTUAL-MIDI.md](docs/VIRTUAL-MIDI.md).

**On the headset:**

```bash
pnpm xr
```

Open the printed `https://` address in Meta Quest Browser, accept the
self-signed certificate warning, enter the bridge address, and tap **Enter mixed
reality**.

## What you get

| | |
|---|---|
| **Pad grid** | 4x4 MPC-style, notes from C1 on channel 10 (the drum channel). Velocity comes from how fast your finger is moving when it crosses the pad. |
| **Keyboard** | 25-key Launchkey-style layout on channel 1, with correctly proportioned black keys. Slide a pressed finger sideways for a glissando. |
| **Knobs** | Four pinch-and-drag controls sending 14-bit CC 21–24. |

Layouts are data, not hard-coded — `MPC_4X4`, `LAUNCHPAD_8X8`, `LAUNCHKEY_25`
and `LAUNCHKEY_49` are all in `@vrmc/layout`, and new ones are a few numbers.

## Repository layout

```
packages/
  protocol/      Wire format. Allocation-free encoder and decoder.
  layout/        Pad and keyboard geometry, O(1) point-to-zone lookup, placement.
  interaction/   Poke detection, velocity, pinch-grab controls. No dependencies.
apps/
  xr-client/     WebXR + React Three Fiber client for the headset.
  desktop-bridge/ Node receiver and virtual MIDI port.
```

The three packages are shared and framework-free; both apps are thin by
comparison. The parts that are hard to get right — the state machine that turns
a moving fingertip into a note, the geometry, the wire format — are separated
out precisely so they can be tested without a headset. They are, extensively.

## Commands

```bash
pnpm build              # build everything
pnpm test               # run all tests
pnpm typecheck          # typecheck all workspaces
pnpm bridge             # run the desktop bridge
pnpm xr                 # run the XR client dev server (HTTPS)

pnpm bridge -- --help          # bridge options
pnpm bridge -- --list-ports    # show MIDI outputs this machine can see
pnpm bridge -- --no-midi       # accept packets, send no MIDI (network testing)
```

Turborepo handles the dependency order and caches results, so a second
`pnpm build` with nothing changed finishes immediately.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit, and the latency
  budget they were designed against.
- [Virtual MIDI setup](docs/VIRTUAL-MIDI.md) — per-platform, including why
  Windows needs a driver and macOS does not.
- [Web deployment](docs/WEB-DEPLOYMENT.md) — hosting the client on a public
  site, and the HTTPS/`wss` constraint that catches every first attempt.
- [Wire protocol](docs/PROTOCOL.md) — the packet format, for writing another
  client.

## Status

Everything here is built and tested: 90 tests cover the codec, both layouts,
the poke and knob state machines, the placement maths, the MIDI translation,
and the two transports over real sockets.

What has **not** been verified is the parts that need hardware this was not
built on: the CoreMIDI and teVirtualMIDI backends have no test coverage on
their respective platforms, and no latency figure in these docs is a
measurement. See [Architecture](docs/ARCHITECTURE.md#what-is-not-yet-verified).
