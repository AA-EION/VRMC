# Which devices are worth emulating next

Emulating a Launchpad was worth doing because a DAW does not have to be taught
what it is: Ableton ships a control-surface script, matches the device, and the
session grid, the mixer and the transport all work with nothing configured. Any
device with a script Live already ships gets the same deal.

So the question "what else can we emulate" has a precise answer, and it is not a
matter of taste. It is: **which controllers does Live ship a script for, and
what shape is the device behind it.**

## How this was established

Not from memory. Live's MIDI Remote Scripts are Python and each one declares
what it expects in `get_capabilities()` — the USB vendor and product ids it
matches on, and the number and roles of its MIDI ports. Everything in the table
below is read out of those declarations, and the control complements are from
Novation's and Akai's own specification pages.

The same source settled two things about the Launchpads that were wrong here for
a while: that the Pro MK3 has three ports rather than two, and that its DAW port
is the last rather than the first.

## The wall, restated

Live's auto-detection keys on **USB vendor and product ids**. A virtual endpoint
has none, and a CoreMIDI driver-created device has none either — a driver device
is not a USB device. So on Ableton specifically, a script binds by *manual*
assignment however good the emulation is. See docs/VIRTUAL-MIDI.md.

That is not true of every host. Logic identifies control surfaces by the SysEx
Device Inquiry, which this project already answers with the exact seven bytes
Live's own `IdentifiableControlSurface` compares — so a correct family code is
worth having regardless.

## Candidates, best first

| Device | Live script | USB | Ports (in/out) | Surface |
|---|---|---|---|---|
| **Launchkey MK3 49 / 61** | `Launchkey_MK3` | `0x1235` / `0x134`–`0x137` | 2 / 2, DAW **second** | 49 or 61 keys, 16 RGB pads, 8 knobs, **9 faders**, transport, 16×2 display |
| **Launch Control XL** | `Launch_Control_XL` | `0x1235` / `0x61` | 1 / 1 | 24 knobs, 8 faders, 24 buttons |
| **Launchpad Mini MK3** | `Launchpad_Mini_MK3` | `0x1235` / `0x113` | 2 / 2, DAW **first** | 8×8 grid, two edge strips |
| **APC mini mk2** | `APC_mini_mk2` | `0x09e8` / `0x4f` | 2 / 2, DAW first, `HIDDEN` | 8×8 RGB grid, 9 faders |
| **APC Key 25 mk2** | `APC_Key_25_mk2` | `0x09e8` / `0x4e` | 2 / 2, DAW **second**, `HIDDEN` | 25 keys, 5×8 grid, 8 knobs |

### Launchkey MK3 49 — the one to do next

It is the device this project is missing. A big keyboard with faders and knobs
is what a lot of people actually want in front of them, and unlike a generic
one it arrives with a script that maps the faders to the mixer and the knobs to
the selected device without anybody assigning anything.

Two things to know before starting. Its **DAW port is second**, not first —
`inport(props=[NOTES_CC, REMOTE])` then `inport(props=[NOTES_CC, SCRIPT])` —
which is a third distinct ordering across three Novation families, so
`dawPortIndex` must keep being read from the script rather than assumed. And it
has a **16×2 character display**, which is a real protocol surface: the script
writes track and parameter names to it, and a Launchkey that does not answer
those messages is one whose display stays blank while everything else works.

### Launch Control XL — the cheapest to add

One port in, one out, no keys, no grid: twenty-four knobs, eight faders and
twenty-four buttons. It is the smallest device here by protocol surface, and
the continuous-control machinery it needs — pinch, drag, 14-bit CC — already
exists in `packages/interaction/src/KnobControl.ts`.

### Launchpad Mini MK3 — nearly free

The same family, the same SysEx dialect and the same LED protocol as the two
Launchpads already emulated. It is an 8×8 grid with two edge strips instead of
four, so it is close to the Launchpad X with a different family code, product
id and port names.

### The Akai pair — worth noting for one detail

`APC_mini_mk2` and `APC_Key_25_mk2` both mark their script port `HIDDEN`, which
Live's capabilities use to keep a port out of the user-facing lists. Nothing
here models that yet, and a device that exposes a port Live expects to hide
would appear with one more port than the real thing.

## What is deliberately not on this list

**Mackie Control (MCU).** Tempting, because every DAW supports it and it would
work everywhere at once rather than in Ableton alone. It is left off because it
is a *protocol*, not a device: it assumes motorised faders that move under the
host's control, a scribble strip per channel, and a jog wheel — none of which a
poke-and-pinch surface reproduces honestly. Emulating it would produce a control
surface that lies about what it can do, and the failure would be silent: the
host would send fader positions nothing moves.

**Push 1/2/3.** Ableton's own, and its script assumes hardware this cannot
present — a touch strip, an encoder ring per knob, and a display protocol far
larger than the Launchkey's.
