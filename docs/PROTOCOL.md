# VRMC wire protocol v3

A fixed-width little-endian binary format, carried over WebSocket binary frames
or UDP datagrams. Both transports are message-oriented and carry their own
length, which the format relies on.

The reference implementation is `packages/protocol`, and this document
describes what it does. Anything writing a client against this — a Unity build,
a hardware sender — only needs what is below.

## Packet

```
offset  size  field       notes
     0     2  magic       0x4D56 ("VM" little-endian)
     2     1  version     3. Receivers reject anything else.
     3     1  kind        see below
     4     4  seq         u32, monotonic per sender, wraps
     8     8  tClient     f64, sender's clock in ms at packet close
    16    ..  body        kind-specific
```

Header is 16 bytes. `tClient` is an `f64` so it can carry fractional
milliseconds directly from `performance.now()` without a separate epoch or a
wrap window to reason about.

**There is no event-count field.** The count is derived as
`(length - 16) / 12`. A count byte would be a second source of truth that can
disagree with the actual length, and that particular disagreement turns a
corrupt packet into a half-parsed one — which in a MIDI stream means a stuck
note rather than a clean reject.

### Kinds

| Value | Name | Body |
|---|---|---|
| 1 | `EVENTS` | A whole number of 12-byte event records |
| 2 | `PING` | Empty. `tClient` is the probe's send time. |
| 3 | `PONG` | `f64` server timestamp. The header echoes the ping's `tClient`. |
| 4 | `HELLO` | UTF-8 client name |
| 5 | `PANIC` | Empty. Silence everything. |
| 6 | `BYE` | Empty. Graceful disconnect; the bridge releases held notes. |
| 7 | `DEVICE_ADD` | Headset to bridge: `deviceId`, name length, model name. |
| 8 | `DEVICE_REMOVE` | Headset to bridge: `deviceId`. |
| 9 | `DEVICE_STATE` | Bridge to headset: the device roster and each one's status. |
| 10 | `LED_UPDATE` | Bridge to headset: `deviceId`, u16 count, then 5 bytes per LED. |
| 11 | `SYSEX` | Either direction: `deviceId`, u16 length, raw bytes. |
| 12 | `DEVICE_POSE` | Either direction: one device's placement and pin state. |
| 13 | `LAYOUT_SAVE` | Headset to bridge: store the current arrangement under a name. |
| 14 | `LAYOUT_DELETE` | Headset to bridge: forget a stored arrangement. |
| 15 | `LAYOUT_APPLY` | Headset to bridge: which arrangement is now in use. |
| 16 | `LAYOUT_STATE` | Bridge to headset: every stored arrangement, and which is current. |
| 17 | `LINK_STATS` | Bridge to headset: receive-side jitter, loss and counters. |

Unknown kinds are ignored rather than treated as errors, so a newer client can
add one without breaking an older bridge.

### Why v3 exists

Once an instrument can be picked up and put down, its pose is state — and state
that only lives in the headset is state that ends when the session does, so
every sitting would start with everything back at its default pose. The bridge
already outlives the headset and already pushes the roster on connection, so
the roster is where the pose belongs. A side channel for it would be a second
source of truth about the same device.

`LINK_STATS` exists for a narrower reason. The headset can time its own round
trip, and that is all it can measure: jitter is the variation in transit time
and loss is the gaps in the sequence number, and both are only visible where
the packets land. The bridge has computed them since v1 and showed them on the
desktop dashboard, which is exactly the screen nobody can look at while wearing
the headset.

### Placement — 22 bytes

Shared by `DEVICE_POSE`, by each entry of `DEVICE_STATE`, and by each entry of a
layout, because all three answer the same question.

```
offset  size  field
     0     1  deviceId
     1     1  flags       bit 0 PINNED, bit 1 ANCHORED
     2     4  centreX     f32, metres
     6     4  centreY     f32
    10     4  centreZ     f32
    14     4  yawDeg      f32, rotation about world Y
    18     4  tiltDeg     f32, 0 vertical, 90 flat and face-up
```

**Orientation is two numbers, not four.** What a quaternion would add over yaw
and tilt is roll, and a rolled Launchpad is one you cannot play — the grid stops
being a grid the moment its rows stop being level. Hand tracking will happily
report thirty degrees of wrist roll nobody intended, so a format that cannot
carry roll cannot save it by accident either.

**f32 and not f64.** Single precision carries about seven significant digits,
which over a ten-metre room resolves to under a micrometre — several orders
below what hand tracking can measure. The other half of an f64 would be
describing noise.

`PINNED` means grabs pass straight through. The point is not to protect a
setting: a hand playing a pad grid is constantly inside the volume a grab test
looks at, and without it a fast roll eventually reads as somebody taking hold of
the instrument and dragging it off the desk mid-phrase.

`ANCHORED` records that the pose was resolved against a real surface rather than
guessed. The anchor itself never crosses the wire — an `XRAnchor` means nothing
outside the session that created it — so this is the fact, not the handle.

### `DEVICE_STATE` body (v3)

```
offset  size  field
     0     1  count
     1    ..  count entries of:
                 1  deviceId
                 1  status
                 1  model length
                ..  model
                 1  detail length
                ..  detail
                 1  hasPlacement (0 or 1)
                22  placement, when hasPlacement is 1
```

The presence byte keeps *never placed* distinct from *placed at the origin*. A
device the bridge opened for a session has never been anywhere and belongs at its
default pose; one somebody deliberately put at the origin belongs at the origin.
Collapsing the two would move every fresh device to the player's feet.

A truncated entry ends the walk rather than being skipped — the entries after it
are no longer aligned to anything, and reading them anyway would report devices
that are not there.

### Layouts

`LAYOUT_SAVE` body:

```
offset  size  field
     0     1  name length          max 48 bytes of UTF-8
     1    ..  name
    ..     1  entry count
    ..    ..  entries of [22-byte placement, 1-byte model length, model]
```

`LAYOUT_STATE` is a current-name, then a count, then that many `LAYOUT_SAVE`
bodies. `LAYOUT_DELETE` and `LAYOUT_APPLY` carry a name and nothing else.

Each entry stores the **model** beside the placement. Device ids are handed out
per session and are not stable across a bridge restart, so matching a saved
entry by id alone would put a Launchpad Pro where a Launchpad X had been.

At most 16 arrangements are stored. `LAYOUT_STATE` pushes all of them in one
control packet and the cap is 4 kB; the limit exists so the failure is "you have
enough layouts" rather than a truncated packet that silently drops the one you
wanted.

`LAYOUT_APPLY` does not ask the bridge to do anything to the devices. The headset
has already applied the arrangement locally; this records which one is current so
the next connection hands back the same one, which is the whole reason layouts
are stored on the bridge rather than in the headset.

### `LINK_STATS` body — 32 bytes

```
offset  size  field
     0     4  jitterMs      f32, smoothed inter-arrival jitter (RFC 3550 6.4.1)
     4     4  peakJitterMs  f32, largest single deviation this window
     8     4  lossRatio     f32, 0..1
    12     4  packets       u32
    16     4  dropped       u32
    20     4  reordered     u32
    24     4  malformed     u32
    28     4  activeNotes   u32
```

Pushed once a second regardless of traffic — a link that has gone quiet because
packets stopped arriving is exactly the case somebody needs to be told about,
and a push conditioned on activity would go silent at that moment.

### Why v2 exists

v1 only ever sent headset to bridge, which is all a pad controller needs. A
Launchpad is a display as much as an input — its LEDs are driven by the DAW — so
the link had to become bidirectional. The fixed 12-byte event stayed exactly as
it was, because it is the latency-critical path and had no reason to change;
the new kinds carry variable-length bodies alongside it.

### LED_UPDATE body

```
offset  size  field
     0     1  deviceId
     1     2  count (u16 little-endian)
     3    ..  count entries of [ledIndex, r, g, b, blink]
```

Colour channels are 6-bit (0..63), as the hardware holds them; widening to 8-bit
is the renderer's job. `blink` is 0 steady, 1 flashing, 2 pulsing — the receiver
animates those itself.

Writes are coalesced before sending. A DAW lighting a row emits its writes one
LED at a time, so one scene change can be sixty-odd separate messages within a
millisecond; sending a packet each would put sixty frames on the wire for a
single visual change.

### Device instance ids

`deviceId` in the event record is a runtime instance id, not a fixed enum. Ids
1, 2 and 3 stay reserved; dynamically created devices start at 16. This is what
lets two Launchpads be live at once without a note started on one being
released on the other.

Id 1 is the VRMC surface — the keys, pads and knobs the app starts with. It was
three ids, aliased on the bridge onto one MIDI port, back when it was three
panels wired into the headset's engine rather than a device. It is one device
on one id now, spawned and removed like any other, and 2 and 3 are reserved
only so an older client's events do not land on something else.

## Event record — 12 bytes

```
offset  size  field       notes
     0     1  type        EventType
     1     1  channel     0..15
     2     1  data1       note number / CC number
     3     1  data2       velocity / CC value, 0..127
     4     2  value14     u16, 0..16383 for pitch bend and 14-bit CC
     6     1  deviceId    which surface produced it
     7     1  flags       bitfield
     8     4  tOffsetMs   f32, ms *before* tClient that this event fired
```

Events are appended in the order they occurred and must be emitted in that
order.

### `tOffsetMs`

This is the field that makes sub-frame timing work, and it exists for a specific
reason. A frame at 90 Hz is 11 ms. Two pads struck at opposite ends of the same
frame leave in the same packet; without an offset the bridge would place them at
the same instant, quantising a fast roll into a flam. The sender records how
long before the packet closed each event actually happened, recovered by
interpolating where between two frames the fingertip crossed the surface.

The bridge does not delay output to reorder by it — delaying would add latency
to fix a sub-millisecond ordering issue. Events already arrive in order; the
offset is there so a consumer that wants true timing has it.

### `EventType`

| Value | Name | Expands to |
|---|---|---|
| 0 | `NOTE_OFF` | `0x8n data1 data2` |
| 1 | `NOTE_ON` | `0x9n data1 data2` |
| 2 | `AFTERTOUCH_POLY` | `0xAn data1 data2` |
| 3 | `CONTROL_CHANGE` | `0xBn data1 data2` |
| 4 | `PROGRAM_CHANGE` | `0xCn data1` |
| 5 | `AFTERTOUCH_CHANNEL` | `0xDn data1` |
| 6 | `PITCH_BEND` | `0xEn lsb msb`, from `value14` |
| 7 | `CONTROL_CHANGE_14` | Two CCs: MSB on `data1`, LSB on `data1 + 32` |

`CONTROL_CHANGE_14` sends the MSB first — receivers latch on it, so the order
is not optional.

### `flags`

| Bit | Name | Meaning |
|---|---|---|
| 0 | `ESTIMATED_VELOCITY` | Velocity could not be measured (tracking dropped, or the frame hitched) and a default was substituted. A run of these means the tracking volume or the lighting needs attention. |
| 1 | `FROM_CONTROLLER` | Produced by a controller rather than a hand. |

### `deviceId`

`1` pads, `2` keys, `3` knobs. Lets a bridge fan out to separate MIDI ports.

## Limits

- Max 64 events per packet: `64 * 12 + 16 = 784` bytes, comfortably inside the
  1280-byte payload that survives every path without IP fragmentation. A
  fragmented datagram is an all-or-nothing loss, so the format never approaches
  it.
- Channel is masked to 4 bits, `data1`/`data2` to 7. Out-of-range values are
  masked at encode rather than rejected, so a caller bug cannot produce a packet
  that the receiver mis-parses.

## Latency probing

The client sends `PING` with its own clock in `tClient`. The bridge replies
`PONG`, echoing that same `tClient` in the header and putting its own timestamp
in the body. The client computes `rtt = now - header.tClient`.

Echoing the client's timestamp rather than a sequence number means the client
needs no table of outstanding pings — nothing to look up, nothing to leak, and
a stale reply is simply an old number rather than a mismatch.

The two clocks are never synchronised, so neither end computes an absolute
one-way latency. The bridge instead reports inter-arrival jitter, which is
independent of clock offset (RFC 3550 §6.4.1) and is the figure that actually
predicts how the instrument feels.

## Reserved

- `seq` gaps mean loss on UDP. Over WebSocket they should not occur; if they do,
  something is wrong upstream.
- Version 1 has no SysEx and no MIDI 2.0 / UMP support. Both would need a
  variable-length body and therefore a version bump.
