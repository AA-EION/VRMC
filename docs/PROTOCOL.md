# VRMC wire protocol v1

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
     2     1  version     1. Receivers reject anything else.
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

Unknown kinds are ignored rather than treated as errors, so a newer client can
add one without breaking an older bridge.

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
