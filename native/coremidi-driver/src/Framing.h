// SPDX-License-Identifier: GPL-3.0-only
#pragma once

// The frames the driver and the bridge exchange.
//
// The other half of this is apps/desktop-bridge/src/midi/driverFraming.ts, and
// the two are written separately from one description — which is exactly how
// wire formats drift apart. They are held together by a shared set of vectors:
// the TypeScript generates test/vectors.json, and test/framing_test.cpp reads
// it and requires this code to agree byte for byte. A disagreement fails the
// build rather than becoming a stuck note on somebody's machine.
//
// Header, four bytes:
//
//     0..1  payload length, little-endian uint16
//     2     port: which of the device's entities this is for
//     3     kind
//     4..   payload
//
// Written byte by byte rather than as a struct memcpy. A struct would be
// subject to padding and alignment, and the whole point of this file is that
// there is exactly one description of the bytes.
//
// No allocation and no exceptions anywhere here. Half of this runs on
// MIDIServer's I/O thread, where a malloc under a lock is a way to make every
// application on the machine stutter.

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace vrmc {

inline constexpr size_t kHeaderBytes = 4;
inline constexpr size_t kMaxPayloadBytes = 8192;
inline constexpr size_t kMaxFrameBytes = kHeaderBytes + kMaxPayloadBytes;

enum FrameKind : uint8_t {
  kFrameHello = 0,
  kFrameMidi = 1,
  kFramePing = 2,
  kFramePong = 3,
  /// One byte: non-zero if the device should appear present to a DAW.
  kFrameDeviceState = 4,
};

/// 2 packs a device index into the address byte; 1 carried a bare port index
/// and could describe only one device.
inline constexpr uint8_t kProtocolVersion = 2;

/*
 * The address byte names one port of one device: `(device << 4) | port`.
 *
 * Packed rather than given a byte each so the header stays four bytes, which
 * is a cost paid per message on the per-note path. Both halves fit: the device
 * table is short and the widest Launchpad has three ports.
 */
inline constexpr uint8_t EncodeAddress(uint8_t device, uint8_t port) {
  return static_cast<uint8_t>(((device & 0x0f) << 4) | (port & 0x0f));
}

inline constexpr uint8_t DeviceOf(uint8_t address) {
  return static_cast<uint8_t>((address >> 4) & 0x0f);
}

inline constexpr uint8_t PortOf(uint8_t address) {
  return static_cast<uint8_t>(address & 0x0f);
}

/// Write one frame into `out`. Returns bytes written, or 0 if it does not fit.
inline size_t EncodeFrame(uint8_t *out, size_t capacity, uint8_t kind,
                          uint8_t port, const uint8_t *payload,
                          size_t payloadLength) {
  if (payloadLength > kMaxPayloadBytes) return 0;
  const size_t total = kHeaderBytes + payloadLength;
  if (total > capacity) return 0;
  out[0] = static_cast<uint8_t>(payloadLength & 0xff);
  out[1] = static_cast<uint8_t>((payloadLength >> 8) & 0xff);
  out[2] = port;
  out[3] = kind;
  if (payloadLength > 0) std::memcpy(out + kHeaderBytes, payload, payloadLength);
  return total;
}

/// Reassembles frames from a byte stream.
///
/// A fixed buffer, not a growing one: the largest legal frame is known, and a
/// reader that cannot be made to allocate cannot be made to allocate *by a
/// peer*. Four frames' worth absorbs a burst without the copying that a
/// single-frame buffer would do on every read.
class FrameReader {
 public:
  /// Called for each whole frame. The payload pointer is valid for the call
  /// only.
  using Visitor = void (*)(void *context, uint8_t kind, uint8_t port,
                           const uint8_t *payload, size_t length);

  /// Feed received bytes.
  ///
  /// Returns false when the stream is unusable and the connection should be
  /// dropped — a length beyond the maximum means the peer is not speaking this
  /// protocol, and a byte stream offers no resynchronisation point to look for.
  bool Push(const uint8_t *chunk, size_t length, Visitor visit, void *context) {
    size_t consumed = 0;
    while (consumed < length) {
      // Compact first: `used_` only ever shrinks by whole frames, so the space
      // freed at the front is reclaimed here rather than by growing.
      if (start_ > 0 && used_ > start_) {
        std::memmove(buffer_, buffer_ + start_, used_ - start_);
      }
      used_ -= start_;
      start_ = 0;

      const size_t room = sizeof(buffer_) - used_;
      if (room == 0) return false;  // a frame larger than the buffer can hold
      const size_t take = (length - consumed) < room ? (length - consumed) : room;
      std::memcpy(buffer_ + used_, chunk + consumed, take);
      used_ += take;
      consumed += take;

      for (;;) {
        const size_t available = used_ - start_;
        if (available < kHeaderBytes) break;
        const size_t payloadLength = static_cast<size_t>(buffer_[start_]) |
                                     (static_cast<size_t>(buffer_[start_ + 1])
                                      << 8);
        if (payloadLength > kMaxPayloadBytes) return false;
        if (available < kHeaderBytes + payloadLength) break;
        visit(context, buffer_[start_ + 3], buffer_[start_ + 2],
              buffer_ + start_ + kHeaderBytes, payloadLength);
        start_ += kHeaderBytes + payloadLength;
      }

      if (start_ == used_) {
        start_ = 0;
        used_ = 0;
      }
    }
    return true;
  }

  void Reset() {
    start_ = 0;
    used_ = 0;
  }

 private:
  uint8_t buffer_[kMaxFrameBytes * 4] = {};
  size_t start_ = 0;
  size_t used_ = 0;
};

}  // namespace vrmc
