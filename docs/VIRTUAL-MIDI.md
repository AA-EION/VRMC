# Virtual MIDI setup

The bridge's job is to make your DAW believe a MIDI device is plugged in. How
that is achieved differs sharply by platform, and the difference is not
incidental — it is why the Windows path has a setup step and the macOS one does
not.

## macOS — nothing to install

CoreMIDI lets any application publish a virtual source, and the OS advertises it
system-wide the moment it opens. Run:

```bash
pnpm bridge
```

**No ports appear yet, and that is deliberate.** They open when a headset
connects and close when it leaves, because a virtual MIDI port is published
system-wide the moment it exists — so a port opened at startup is an instrument
in every DAW on the machine that nobody is playing and nothing is attached to.
Connect the headset and **VRMC** appears: a plain instrument port carrying the
keys, pads and knobs. Because CoreMIDI publishes system-wide, DAWs that rescan
while running see it without a restart.

A plain port is all it can be — no control-surface script matches the name
"VRMC", so Ableton lists it as a nameless keyboard and nothing lights up. For
hardware a DAW can identify, spawn a Launchpad from the wrist menu in the
headset, or start the bridge with `--device launchpad-x` to have one opened for
every session. Either way its two ports are named as the hardware names them:

| Model | Ports, in the order the host enumerates them |
|---|---|
| Launchpad X | `LPX (DAW)`, `LPX (MIDI)` |
| Launchpad Pro MK3 | `PRO MK3 (DAW)`, `PRO MK3 (MIDI)` |

DAW first: on a real Launchpad the two ports are cables on one USB endpoint
pair, and the DAW jack is cable 0. The names and the order are both taken from
[CoreFW](https://github.com/anthonyhfm/launchpad-core-firmware)'s USB
descriptor, because a DAW decides what a port is by its name — these are
functional strings, not cosmetic ones.

**One difference from real hardware that cannot be closed here.** A Launchpad
is one USB device, so macOS shows one CoreMIDI *device* with two *entities*
inside it. These are two standalone virtual endpoints: RtMidi's virtual-port
API is `MIDISourceCreate`/`MIDIDestinationCreate`, and it has no call for
creating a device with entities under it. So Audio MIDI Setup lists them as two
separate entries rather than one expandable device, and the endpoint names
carry a `{device} {port}` prefix to compensate for having no owning device.
Closing that gap means talking to CoreMIDI directly rather than through RtMidi.

### When the headset drops

Ports survive a disconnection for ten seconds before closing. Headset Wi-Fi
drops for a second at a time, and a DAW that sees a control surface vanish does
not wait politely — Ableton unbinds the script, and rebinding is a manual trip
through Preferences. A headset back inside that window finds its ports still
open and the DAW none the wiser. Tune it with `--port-grace <seconds>`; `0`
closes immediately.

Where to enable the plain port:

| DAW | Where to enable it |
|---|---|
| Ableton Live | Preferences → Link/Tempo/MIDI → enable **Track** and **Remote** on VRMC |
| Logic Pro | Appears automatically; no configuration needed |
| REAPER | Preferences → Audio → MIDI Devices → right-click VRMC → **Enable input** |
| Pro Tools | Setup → MIDI → MIDI Input Devices → tick VRMC |

Rename the port with `--name "My Controller"` if you would rather it showed as
something else.

> These steps are from each DAW's documented MIDI setup; the backend has not
> been run against them. See
> [Architecture](ARCHITECTURE.md#what-is-not-yet-verified).

## Linux — nothing to install (given ALSA)

Same code path, via the ALSA sequencer. The port appears in `aconnect -o`. It
requires `/dev/snd/seq`, which means a real audio stack — a headless container
generally will not have one, and the bridge will say so and carry on without
MIDI rather than refusing to start.

## Windows — one of two setup paths

Windows has no equivalent of CoreMIDI's virtual source. WinMM, the classic MIDI
API, can only *open* ports that a kernel driver has already published;
an application cannot create one. So a Windows virtual MIDI port always means a
third-party kernel driver. The bridge supports both realistic routes and picks
whichever it finds.

### Path 1 — loopMIDI (recommended)

Free, five minutes, no licensing question.

1. Install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html).
2. Open it and create a port named **VRMC**.
3. Run `pnpm bridge`. It finds the port by name and attaches to it.
4. Select **VRMC** as a MIDI input in your DAW.

The bridge matches `loopMIDI`, `rtpMIDI` or `VRMC` in a port name by default.
Override with `--loopback "<regex>"`.

### Path 2 — teVirtualMIDI (no manual port creation)

If the teVirtualMIDI driver is present — it ships with loopMIDI and rtpMIDI —
the bridge creates its port itself through the driver's DLL, with no GUI step.
It tries this first and falls back to path 1.

**Licensing:** teVirtualMIDI is free for personal use, but redistributing it in
a commercial product requires a licence from its author. If you are shipping
this commercially, either use path 1 (where the user installs loopMIDI
themselves) or obtain a licence. This is a real constraint, not a formality.

### Looking ahead

[Windows MIDI Services](https://github.com/microsoft/MIDI), Microsoft's new
MIDI 2.0 stack, adds app-created virtual endpoints natively. Once it is broadly
available, the Windows path collapses to the same shape as macOS and
`windowsBackend.ts` can go away.

## Checking it works

```bash
pnpm bridge -- --list-ports    # what this machine can see
pnpm bridge -- --no-midi       # accept packets, send nothing (isolates the network)
```

The bridge prints a stats line every 10 seconds while traffic is flowing:

```
17:42:10.881  1284 pkt / 3102 ev · jitter 0.84 ms (peak 3.10) · loss 0.00%
```

`jitter` is the number to watch. Under a millisecond is good; a peak in the tens
of milliseconds means the Wi-Fi link is contended — move to 5 GHz or 6 GHz, or
get closer to the access point.

## If the DAW does not see the port

- **Start the bridge before the DAW.** Ableton and Pro Tools scan MIDI devices
  at launch and do not always notice one appearing later. Logic and REAPER do.
- **Check nothing else holds the name.** A second bridge instance, or a
  leftover loopMIDI port, will collide. `--list-ports` shows what exists.
- **On Windows, confirm which path was taken.** The startup banner says whether
  it created a port via teVirtualMIDI or attached to an existing one.

## If notes hang

They should not — the bridge tracks every sounding note and releases them when a
client disconnects, when a session ends, and on shutdown. If one does hang, the
**Panic** button in the client sends an explicit Note Off for everything the
bridge believes is sounding, followed by All Notes Off and All Sound Off on all
16 channels. `Ctrl-C` on the bridge does the same before exiting.
