# VRMC CoreMIDI driver (spike)

One device with three ports, the way a real Launchpad appears — and a test of
whether that can be shipped for free.

## What this answers

Everything else in VRMC opens **virtual endpoints**, which is all an
application may do. A virtual endpoint has no device behind it, so the
Launchpad Pro MK3's three ports are three separate devices in every DAW's list,
where the hardware is one device with three ports. CoreMIDI's header is
explicit that the grouping API belongs to drivers: `MIDIDeviceCreate` takes a
`MIDIDriverRef owner`, and `MIDISetupAddDevice` is documented for drivers.

There are two kinds of driver on macOS 26:

| | Entitlement | Cost | Signing |
|---|---|---|---|
| **MIDIDriverKit** (`.dext`) | `com.apple.developer.driverkit.family.midi`, granted by Apple per team | Developer Program membership | Developer ID + notarisation. Restricted entitlements **cannot** be ad-hoc signed |
| **CoreMIDI plugin** (this) | none | none | unknown — that is the question |

`MIDIDriverInterface` is not marked deprecated in Apple's current
documentation, and third parties still ship plugins for macOS 26. But theirs
are Developer ID signed and notarised. Whether MIDIServer will load an
**ad-hoc** signed one decides whether VRMC can present as hardware without an
Apple Developer account.

If it loads, the full driver is worth building. If it does not, no free path
exists and we have spent days rather than weeks establishing that.

## Build

```sh
native/coremidi-driver/build.sh
```

It builds as a **version 3** driver (`kMIDIDriverInterface3ID`, macOS 12 and
later), which is the interface MIDIServer asks for first on 26, while still
answering for version 2 if the server falls back.

Produces `native/coremidi-driver/build/VRMC.plugin`, universal, ad-hoc signed.
CI builds it on every push, so a compile error shows up without a Mac.

## Install

From CI, download `vrmc-coremidi-driver` and unpack the tarball inside it —
`tar`, not the Finder, because the bundle has to keep its name, its layout and
the executable bit on `Contents/MacOS/VRMC`:

```sh
tar -xzf vrmc-coremidi-driver.tar.gz
```

**Check the signature survived the trip before installing.** If this fails, the
transfer broke the bundle and anything MIDIServer then does tells you nothing:

```sh
codesign --verify --strict --verbose=2 VRMC.plugin
```

It should say `valid on disk` and `satisfies its Designated Requirement`, and
`codesign --display` should show `Signature=adhoc` with `TeamIdentifier=not
set`. That is the state being tested. Then:

```sh
sudo mkdir -p "/Library/Audio/MIDI Drivers"
sudo cp -R VRMC.plugin "/Library/Audio/MIDI Drivers/"
sudo killall MIDIServer 2>/dev/null || true
```

`MIDIServer` is launched on demand, so killing it is how you make it reload;
it comes back the moment anything asks for MIDI. Open **Audio MIDI Setup** →
*Window* → *Show MIDI Studio* to make something ask.

## What to look for

**It worked** if MIDI Studio shows a *single* icon named `Launchpad Pro MK3`,
and double-clicking it lists three ports — `LPProMK3 MIDI`, `LPProMK3 DIN`,
`LPProMK3 DAW`. One device, three ports, with no bridge running: that is the
thing an application cannot do, and every DAW reads the same setup, so it is
not an Ableton-specific result.

**It was rejected** if nothing appears. Check whether MIDIServer refused it:

```sh
log show --last 10m --predicate 'process == "MIDIServer"' --info | grep -i -E "vrmc|plugin|sign|reject|denied"
```

A code-signing or library-validation complaint is the answer we are looking
for — it means ad-hoc is not enough and a Developer ID is required either way.
Silence with no device is a different failure (a malformed plist, or the wrong
architecture) and is worth reporting with the log.

Also worth capturing either way:

```sh
codesign --display --verbose=4 "/Library/Audio/MIDI Drivers/VRMC.plugin"
spctl --assess --type install --verbose "/Library/Audio/MIDI Drivers/VRMC.plugin" || true
```

## Uninstall

```sh
"/Applications/VRMC Bridge.app/Contents/MacOS/vrmc-bridge" --uninstall-driver
```

This is the one to use, because **deleting the plugin is not enough**.
`MIDISetupAddDevice` writes into the *persisted* MIDI setup, so the device
survives its driver: it stays listed in Audio MIDI Setup and in every DAW's
port menu, offline and unowned. Nothing collects it, because from CoreMIDI's
side that is exactly what an unplugged interface looks like.

`--uninstall-driver` deletes the plugin from **both** locations — a copy left
in the other one is loaded just the same and puts the device straight back —
restarts MIDIServer so the driver is no longer resident, and only then calls
`MIDISetupRemoveDevice`. That order matters: remove the device while the driver
is still loaded and the next `Start()` recreates it.

The device is matched by `kMIDIPropertyDriverOwner` against this driver's
bundle identifier, never by name. "Launchpad Pro MK3" would also match a *real*
Launchpad Pro MK3, and removing that from the setup — where its configuration
and port naming live — would be a worse bug than the leftover.

By hand, if you have no app to hand:

```sh
rm -rf ~/"Library/Audio/MIDI Drivers/VRMC.plugin"
sudo rm -rf "/Library/Audio/MIDI Drivers/VRMC.plugin"
sudo killall MIDIServer 2>/dev/null || true
```

then remove the leftover device in *Audio MIDI Setup* → *MIDI Studio* → select
it → **Remove**. That button makes the same `MIDISetupRemoveDevice` call.

## What it carries, and how

Every model the bridge can emulate — a Launchpad X and a Launchpad Pro MK3 —
each as its own device with its own ports. The device table in `src/Devices.h`
is **generated** from the bridge's own device specs, so the driver's devices and
the bridge's are the same list rather than two that must be kept in step.

MIDI crosses a Unix socket in the user's Application Support directory. Each
frame carries a one-byte address, `(device << 4) | port`, so a note can name
which port of which instrument it belongs to.

Every device is created at load and marked **absent**. The bridge says which are
present as the headset spawns instruments and puts them away. That is CoreMIDI's
own prescription rather than a convenience — the header says a driver "should
set the device's kMIDIPropertyOffline to 1 so that if the device reappears
later, none of its properties are lost", instead of adding and removing devices
— and it means a DAW's binding survives an instrument being put away and
fetched back. It is also what stops a Mac with the driver installed from listing
every Launchpad VRMC can emulate, all the time, whether or not anybody is
holding one.

Marking a device present is a CoreMIDI call, and CoreMIDI permits only
`MIDISend` and `MIDIReceived` off the server's main thread. The request arrives
on the link's own thread, so it is handed back to the run loop captured in
`Start()` — which runs on the main thread by definition — through a run loop
*source*. A source rather than a queued block because it coalesces: a headset
spawning and removing an instrument repeatedly signals the same source, and the
main thread applies the final state once.

This runs **inside MIDIServer**, so a crash here takes MIDI down for every
application on the machine. That is why `Send()` does one non-blocking write and
nothing else, and why nothing on that path allocates.

## One thing a driver will not fix

Ableton's automatic control-surface detection keys on USB vendor and product
IDs — `Launchpad_Pro_MK3/__init__.py` declares
`controller_id(vendor_id=4661, product_ids=[291], ...)`. A driver-created
device is still not a USB device, so whether Live sources those IDs somewhere a
driver can populate is unknown and untested.

What the driver *does* fix is the presentation: one device with three
correctly-named ports, in every DAW rather than one. Manual assignment works
today in any host, because the SysEx identity reply already matches what Live's
`IdentifiableControlSurface` compares — and Logic identifies control surfaces
by that same inquiry rather than by USB id.
