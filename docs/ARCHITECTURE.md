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
apps/xr-client       WebXR + R3F. Reads hands, draws instruments, sends packets.
apps/desktop-bridge  Receives packets, emits MIDI into a virtual port.
```

The split is not organisational tidiness. The hard parts of this system are the
fingertip-to-note state machine, the geometry, and the packet format — and all
three are pure functions of numbers. Keeping them out of the app layers means
they can be tested exhaustively at a terminal, which is the only practical way
to iterate on behaviour that otherwise requires a headset on your face.

## Why the transport is a WebSocket

UDP is the right transport for this traffic and the browser will not give it to
us. That is the whole story, and it is worth being precise about the trade.

A MIDI control message has a useful life of a few milliseconds. If one is lost,
the correct response is to carry on: by the time TCP notices and retransmits,
the moment the note belonged to has passed. Worse, TCP delivers in order, so one
lost packet stalls every packet behind it — a single drop becomes an audible gap
followed by a burst of late notes, which is far more damaging than the missing
note would have been.

In practice this matters less than it sounds. On a quiet 5 GHz or 6 GHz link
carrying a few kB/s, there is very little loss to retransmit. What actually
protects the experience is elsewhere:

- **Nagle is off.** `setNoDelay(true)` on every accepted socket. Otherwise the
  kernel batches small writes and adds tens of milliseconds.
- **Compression is off.** `perMessageDeflate: false`. Our packets are 16–784
  bytes of already-dense binary; compressing them costs CPU and latency to save
  nothing.
- **Backpressure sheds load rather than queueing.** When `bufferedAmount`
  exceeds 8 KB the client starts dropping aftertouch — never notes. Queueing
  instead would make the instrument feel like it lags further behind the longer
  you play.
- **The one failure that does real damage is handled.** A lost Note Off would
  strand a voice, so the bridge tracks every sounding note and releases them on
  disconnect. That is `NoteTracker`, and it is why the transport can afford to
  be lossy.

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
- **The client has not run in a headset.** It builds, typechecks, and its logic
  is covered by tests, but no part of the WebXR session path — passthrough blend
  mode, `fillPoses` availability, hand joint ordering — has been confirmed
  against a real runtime.

The tests cover what can be covered without hardware, which is most of the
difficult logic and none of the platform integration.
