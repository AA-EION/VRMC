// SPDX-License-Identifier: GPL-3.0-only
#pragma once

// Universal MIDI Packets back into the MIDI 1.0 bytes a Launchpad speaks.
//
// WHY THIS IS NEEDED AT ALL
// The version 3 driver interface — the one MIDIServer asks for first on macOS
// 12 and later — delivers MIDIEventList rather than MIDIPacketList. That is
// 32-bit Universal MIDI Packets, not bytes, and MIDI 1.0 messages arrive
// wrapped inside them. CoreMIDI exposes no public converter in the other
// direction, so this is it.
//
// SYSEX IS THE HALF THAT MATTERS
// A Launchpad's whole LED protocol is SysEx, and SysEx crosses UMP as *SysEx7*:
// six data bytes per 64-bit packet, in a start/continue/end sequence, with the
// F0 and F7 removed. So a single grid update arrives as a dozen packets none of
// which is a valid MIDI message on its own, and the F0/F7 have to be put back.
// Getting this wrong does not fail loudly — it produces a device whose lights
// never come on.
//
// THREADING
// One decoder per port, used only from MIDIServer's I/O thread. There is no
// locking here and there must not be: this runs on the thread every other MIDI
// device on the machine shares.

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace vrmc {

/// Longest SysEx this will reassemble.
///
/// Novation's largest documented message is a palette upload well under this.
/// A cap is required rather than optional: without one, a peer that sends
/// "continue" forever is an unbounded write inside MIDIServer.
inline constexpr size_t kMaxSysExBytes = 4096;

/// Bytes a single non-SysEx message can produce.
inline constexpr size_t kUmpScratchBytes = 8;

/// How many bytes a MIDI 1.0 status byte introduces, including itself.
inline size_t Midi1MessageLength(uint8_t status) {
  if (status < 0x80) return 0;
  if (status < 0xc0) return 3;  // note off/on, poly pressure, control change
  if (status < 0xe0) return 2;  // program change, channel pressure
  if (status < 0xf0) return 3;  // pitch bend
  switch (status) {
    case 0xf1:  // MIDI time code quarter frame
    case 0xf3:  // song select
      return 2;
    case 0xf2:  // song position pointer
      return 3;
    case 0xf6:  // tune request
    case 0xf8:  // clock
    case 0xfa:  // start
    case 0xfb:  // continue
    case 0xfc:  // stop
    case 0xfe:  // active sensing
    case 0xff:  // reset
      return 1;
    default:
      return 0;  // F0/F7 never appear here: SysEx arrives as type 3
  }
}

/// Receives each complete MIDI 1.0 message.
using UmpEmit = void (*)(void *context, const uint8_t *data, size_t length);

/// Decodes one port's stream of Universal MIDI Packets.
class UmpDecoder {
 public:
  /// Walk `words`, emitting every complete MIDI 1.0 message it completes.
  void Decode(const uint32_t *words, size_t wordCount, UmpEmit emit,
              void *context) {
    size_t i = 0;
    while (i < wordCount) {
      const uint32_t word = words[i];
      const uint8_t type = static_cast<uint8_t>((word >> 28) & 0x0f);
      const size_t size = WordsForType(type);
      if (size == 0 || i + size > wordCount) return;  // unknown or truncated

      switch (type) {
        case 0x1:  // system real time and common
        case 0x2: {  // MIDI 1.0 channel voice
          uint8_t bytes[3];
          bytes[0] = static_cast<uint8_t>((word >> 16) & 0xff);
          bytes[1] = static_cast<uint8_t>((word >> 8) & 0x7f);
          bytes[2] = static_cast<uint8_t>(word & 0x7f);
          const size_t length = Midi1MessageLength(bytes[0]);
          if (length > 0) emit(context, bytes, length);
          break;
        }
        case 0x3:
          DecodeSysEx7(words + i, emit, context);
          break;
        default:
          // Utility (0x0), MIDI 2.0 channel voice (0x4), SysEx8 (0x5), and the
          // reserved types. Nothing a Launchpad speaks, and silently skipping
          // them is what keeps a MIDI 2.0 host from jamming the stream.
          break;
      }
      i += size;
    }
  }

  void Reset() {
    length_ = 0;
    active_ = false;
  }

 private:
  /// Words in a UMP of this message type, per the UMP specification.
  static size_t WordsForType(uint8_t type) {
    switch (type) {
      case 0x0:
      case 0x1:
      case 0x2:
      case 0x6:
      case 0x7:
        return 1;
      case 0x3:
      case 0x4:
      case 0x8:
      case 0x9:
      case 0xa:
        return 2;
      case 0xb:
      case 0xc:
        return 3;
      case 0x5:
      case 0xd:
      case 0xe:
      case 0xf:
        return 4;
      default:
        return 0;
    }
  }

  /*
   * SysEx7: two words, up to six data bytes, in a start/continue/end sequence.
   *
   *   word 0:  [0x3 | group] [status | count] [b0] [b1]
   *   word 1:  [b2] [b3] [b4] [b5]
   *
   * status 0 = the whole message in one packet, 1 = start, 2 = continue,
   * 3 = end. The F0 and F7 are *not* carried, which is the detail that makes a
   * naive implementation produce SysEx no device will accept.
   */
  void DecodeSysEx7(const uint32_t *words, UmpEmit emit, void *context) {
    const uint8_t header = static_cast<uint8_t>((words[0] >> 16) & 0xff);
    const uint8_t status = static_cast<uint8_t>((header >> 4) & 0x0f);
    const size_t count = header & 0x0f;
    if (count > 6) return;

    uint8_t data[6];
    data[0] = static_cast<uint8_t>((words[0] >> 8) & 0x7f);
    data[1] = static_cast<uint8_t>(words[0] & 0x7f);
    data[2] = static_cast<uint8_t>((words[1] >> 24) & 0x7f);
    data[3] = static_cast<uint8_t>((words[1] >> 16) & 0x7f);
    data[4] = static_cast<uint8_t>((words[1] >> 8) & 0x7f);
    data[5] = static_cast<uint8_t>(words[1] & 0x7f);

    if (status == 0 || status == 1) {
      // A start that arrives while another is in flight means the previous one
      // was abandoned — a DAW that was interrupted, or a dropped packet.
      // Beginning again is better than splicing two messages into one.
      length_ = 0;
      active_ = true;
      buffer_[length_++] = 0xf0;
    } else if (!active_) {
      // A continue or end with no start: the beginning was lost, and what is
      // here is a fragment. Emitting it would be a malformed SysEx.
      return;
    }

    for (size_t i = 0; i < count; i++) {
      if (length_ >= kMaxSysExBytes - 1) {
        // Over the cap. Abandon rather than truncate: a truncated SysEx is a
        // message a device may act on, and acting on half a palette upload is
        // worse than ignoring it.
        Reset();
        return;
      }
      buffer_[length_++] = data[i];
    }

    if (status == 0 || status == 3) {
      buffer_[length_++] = 0xf7;
      emit(context, buffer_, length_);
      Reset();
    }
  }

  uint8_t buffer_[kMaxSysExBytes] = {};
  size_t length_ = 0;
  bool active_ = false;
};

}  // namespace vrmc
