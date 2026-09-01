# Architecture

## Why WebXR

The brief allowed either Unity with the Meta XR SDK or WebXR. This is WebXR,
and for this application it is the stronger choice:

- **Quest 3 passthrough works.** An `immersive-ar` session reports an
  `alpha-blend` environment blend mode, and the compositor shows the full-colour
  passthrough cameras behind anything the page does not paint.
- **Hand tracking is complete enough.** WebXR Hand Input exposes all 25 joints
  per hand with per-joint radii, at the display's frame rate. Everything the
  poke detector needs is a fingertip position and a timestamp.
- **Distribution is a URL.** No store review, no sideloading, no APK. It can
  live on an existing website, and an update is a deploy.
- **The code is shared.** The client, the bridge and the geometry are one
  TypeScript codebase with one wire format and one set of tests.

What WebXR gives up: no raw UDP from the browser (see below), no access to the
Meta Interaction SDK's prebuilt poke/grab affordances — which is why this
repository implements them — and slightly less headroom than a native build,
though the frame budget here is dominated by hand tracking and compositing
rather than by anything the app does.

## The pieces

```
packages/protocol    Wire format. Zero-allocation writer/reader.
packages/layout      Geometry: pad grids, piano keyboards, placement maths.
packages/interaction Poke detection and pinch-grab. No dependencies at all.
packages/devices     Launchpad emulation: identity, LED SysEx, colour palette.
apps/xr-client       WebXR + R3F. Reads hands, draws instruments, sends packets.
apps/desktop-bridge  Receives packets, manages virtual devices, emits MIDI.
```

The split is not organisational tidiness. The hard parts of this system are the
fingertip-to-note state machine, the geometry, and the packet format — and all
three are pure functions of numbers. Keeping them out of the app layers means
they can be tested exhaustively at a terminal, which is the only practical way
to iterate on behaviour that otherwise requires a headset on your face.

## Emulating a Launchpad

A Launchpad is not a pad grid with a different label on it. Three things make it
a different kind of problem:

**It is a display.** Most of what a Launchpad does is show you the state of your
session — which clips are playing, which are queued, which track is armed. All
of that is decided by the DAW and pushed to the device. A virtual Launchpad that
could only send would appear in Ableton and then sit dark, which is not a
Launchpad. This is why protocol v2 exists.

**It has to be recognised.** A DAW does not ask "are you a Launchpad?" It matches
the MIDI port name, then confirms with a Universal Device Inquiry and reads a
two-byte family code out of the reply — `03 01` for the X, `23 01` for the Pro
MK3. Get either wrong and the control-surface script never binds, silently. So
the emulation opens ports named as the hardware names them and answers the
inquiry on both of them, because a host that probes the wrong port and hears
nothing will give up.

**Its LED protocol has more than one path.** The RGB SysEx is the one people
document, but Ableton lights most of the grid with plain Note On messages whose
*velocity* selects one of 128 predefined colours. An emulator that implemented
only the SysEx would look correct in a protocol test and blank in real use. The
palette is a table, ported from CoreFW, and the channel number carries the
animation: channel 1 steady, 2 flashing, 3 pulsing — which is how a queued clip
looks different from a recording one.

Devices are created and destroyed at runtime. Spawning one in the headset opens
real ports, which a DAW sees as hardware being plugged in; removing it closes
them, which reads as an unplug. Notes are released *before* the ports close: a
port that is already gone cannot carry the Note Offs it owes.

The emulator itself holds no timers. Flashing and pulsing are animated by the
renderer at frame rate, where frames are. Keeping the emulator clock-free means
the copy on the desktop and the copy in the headset cannot drift apart.

## Why the transport is a WebRTC data channel

UDP is the right transport for this traffic and the browser will not hand us a
socket. For a long time that meant a WebSocket, and it cost twice over: TCP's
delivery guarantees are actively wrong for MIDI, and a WebSocket from an HTTPS
page needs a certificate a public authority signed for whatever host it dials —
which a computer on someone's home network cannot have without its owner running
a DNS zone and installing a wildcard key.

A WebRTC data channel answers both.

**It is unordered and unreliable, on purpose.** `ordered: false` and
`maxRetransmits: 0` give datagram semantics over SCTP. A MIDI control message
has a useful life of a few milliseconds; if one is lost, the correct response is
to carry on, because by the time TCP would notice and retransmit, the moment the
note belonged to has passed. Worse, TCP delivers in order, so one lost packet
stalls every packet behind it — a single drop becomes an audible gap followed by
a burst of late notes, far more damaging than the missing note would have been.
That was the compromise the WebSocket forced. It is gone.

**It authenticates by DTLS fingerprint.** The peers exchange fingerprints in the
handshake and verify each other directly, with no certificate authority in the
picture. No DNS, no certificate, no shipped private key, nothing for the user to
accept. [PAIRING.md](PAIRING.md) covers how the two are introduced.

**No ICE servers.** Both peers are on the same network, so host candidates are
enough, and nothing outside the LAN is contacted while connecting — not even to
discover an address. There is no TURN relay that could quietly become the audio
path, which would trade a two-millisecond local hop for tens.

The things that actually protect the experience are unchanged and live above the
transport:

- **Backpressure sheds load rather than queueing.** When `bufferedAmount`
  exceeds 8 KB the client starts dropping aftertouch — never notes. Queueing
  instead would make the instrument feel like it lags further behind the longer
  you play.
- **The one failure that does real damage is handled.** A lost Note Off would
  strand a voice, so the bridge tracks every sounding note and releases them on
  disconnect. That is `NoteTracker`, and it is why the transport can afford to
  be lossy.
- **Events are batched per frame, not per event.** Every event carries its own
  sub-frame offset, so batching costs no timing accuracy.

The WebSocket is still there for a client on the same machine as the bridge —
the dashboard, and development — where `ws://` is already a secure context.
`BridgeLink` drives either through one `Transport` interface, so the batching,
backpressure and reconnect logic is the same code on both. On that path Nagle is
off (`setNoDelay(true)`) and compression is off (`perMessageDeflate: false`):
our packets are 16–784 bytes of already-dense binary, and batching or
compressing them costs latency to save nothing.

The bridge also listens on UDP with the identical wire format, so a native
client — Unity, a hardware sender, anything that can open a socket — gets the
better transport without changing anything downstream.

## Latency budget

This is an analysis of where time goes, not a set of measurements. See
[what is not yet verified](#what-is-not-yet-verified).

| Stage | Expected | Notes |
|---|---|---|
| Hand tracking capture → pose available to the page | ~10–20 ms | The runtime's own pipeline. Not ours to influence. |
| Frame quantisation in the detector | 0–11 ms | One 90 Hz frame. Mitigated: each event carries a sub-frame offset (`tOffsetMs`) so a fast roll is not smeared to frame boundaries. |
| Packet encode + `send` | <0.1 ms | Fixed-width write into a preallocated buffer. |
| Wi-Fi hop, 5/6 GHz, same room | ~2–6 ms | The dominant variable. 2.4 GHz is materially worse. |
| Bridge decode → MIDI port | <0.1 ms | Synchronous in the socket callback. No queue, no allocation. |
| DAW input → audio out | 5–20 ms | Whatever your buffer size is. Not ours. |

The number that matters is not the total, it is the **variance**. A steady 25 ms
of delay is inaudible — players adapt within seconds. The same 25 ms wandering
between 10 and 50 is what makes an instrument unplayable. That is why the
bridge reports RTP-style inter-arrival jitter rather than a latency figure it
cannot honestly compute, and why the client shows both current and best round
trip: the gap between them is the number to worry about.

Two design consequences follow from prioritising variance:

**Nothing allocates in the hot path.** Not the packet writer, not the decoder,
not the hand tracker, not the detector. A minor GC is only a millisecond or two,
but it lands unpredictably — including in the middle of a fill. The techniques
are ordinary once the goal is clear: preallocated `ArrayBuffer`s, cached
`subarray` views, flat `Float32Array`s instead of vector objects, visitor
callbacks taking primitives instead of returning event objects, and
`XRFrame.fillPoses` instead of `getJointPose`.

**React is kept off the frame path entirely.** Real-time state lives in a plain
`Engine` class. Pad highlights are written directly into instance colours; knob
rotations are mutated on the mesh. React renders connection status and settings,
which change at human speed.

## Playability details that are not obvious

These are the decisions that separate a demo from something you can play, and
each one is a specific failure they prevent:

- **Hysteresis on release (4 mm).** Hand tracking jitters about a millimetre
  even when the hand is still. Without a release margin, a fingertip resting on
  the strike plane retriggers on that noise — a machine-gun stutter that is the
  most common way a hand-tracked instrument fails.
- **Velocity from peak approach speed, not the crossing frame.** The
  instantaneous finite difference at the moment of contact systematically
  under-reads a hard strike, because the finger is already decelerating against
  a surface that is not there. Taking the peak over the last few frames recovers
  the speed the player meant.
- **A contact offset of one finger radius.** The tracked joint is the bone
  centre; contact happens a radius earlier. Without it, the player has to push
  visibly through the key before it sounds.
- **Glissando.** A pressed finger sliding onto a new key retriggers, because on
  a real keyboard it does. Scaled down in velocity, because a gliss is quieter
  than a deliberate strike.
- **Release on tracking loss.** A finger that vanishes mid-press releases its
  note. Otherwise a hand leaving the tracking volume strands a voice.
- **Local audio confirmation.** A virtual pad has no edge to feel. Without some
  immediate response the player cannot distinguish a hit from a near miss, and
  waiting for the DAW to answer puts 30–60 ms between touch and sound, which
  reads as broken rather than as latency.

## What is not yet verified

Stated plainly, because the rest of this document sounds more confident than the
evidence supports:

- **No latency figure here is a measurement.** The table above is an analysis of
  where time is spent. Nothing has been timed on a Quest.
- **The CoreMIDI backend has not been exercised on macOS**, and the
  teVirtualMIDI backend has not been exercised on Windows. Both are written
  against their documented APIs; neither has run against them. The Linux/ALSA
  path could not run here either — this build environment has no
  `/dev/snd/seq`, which is why backend construction is guarded and a missing
  MIDI system is non-fatal rather than a crash on startup.
- **No DAW has ever seen an emulated Launchpad.** The identity constants and
  the LED protocol are cross-checked against CoreFW and covered by tests, but
  whether Ableton actually binds its Launchpad script to a virtual port named
  this way is exactly the thing that cannot be tested without Ableton. Port
  naming is the most likely thing to need adjustment, which is why
  `--port-template` exists.
- **The macOS and Windows binaries have never been run.** See
  [Packaging](PACKAGING.md).
- **The client has not run in a headset.** The 3D scene itself *is* verified —
  see below — but nothing inside an XR session is: `immersive-ar` availability,
  the passthrough blend mode, `fillPoses` support and hand joint ordering have
  all been written against the specification and never against a real runtime.

The tests cover what can be covered without hardware, which is most of the
difficult logic and none of the platform integration.

### What the headless render test does cover

`apps/xr-client/test/render-smoke.mjs` loads the built app in Chromium with
software WebGL and checks 21 properties of the running scene: that the React
tree mounts with no uncaught exceptions, a WebGL 2 context is created, both
instrument surfaces build as instanced meshes with all 41 zones, the frame loop
advances, geometry rasterises, and both surfaces fall inside the preview
camera's frustum.

It then drives the *real* `PokeDetector` and `NoteRouter` with synthetic
fingertip positions and asserts a strike on pad 1 produces MIDI note 36 with a
velocity derived from approach speed, lights that pad in the instance colour
buffer, and keeps it lit while held. It also spawns an emulated Launchpad,
injects LED colours the way the bridge would, and checks they reach the GPU. That is the only test covering detection,
routing, feedback and the GPU together — the pieces are unit-tested in
`packages/interaction`, but the wiring between them exists only in the client.

Five real bugs came out of writing it, none of which any amount of type checking
would have caught: the preview camera framed the instruments out of shot
entirely; the label plane was occluded by the raised zone boxes; labels drew
dark ink on the dark pad theme; `SurfaceHighlighter` faded held zones despite
documenting that it did not; and every Launchpad pad rendered washed white,
because `emissive` is a single uniform shared by all instances while only the
diffuse is multiplied by `instanceColor`.

Run it alone with `pnpm --filter @vrmc/xr-client test`. It skips cleanly when no
Chromium is available; set `CHROMIUM_PATH` to point at one.
