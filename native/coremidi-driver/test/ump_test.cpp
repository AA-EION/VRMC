// SPDX-License-Identifier: GPL-3.0-only
//
// Universal MIDI Packets back into the bytes a Launchpad speaks.
//
// This is the piece most able to be wrong without saying so. A DAW's LED
// updates reach the driver as SysEx7 — six bytes per packet, F0 and F7
// stripped, in a start/continue/end sequence — and an implementation that
// mishandles any of that produces a device whose lights simply never come on,
// with nothing in any log. So the SysEx cases here are the point, and the
// channel-voice ones are the easy half.
//
// Pure logic, no CoreMIDI, so this runs on a Linux runner in a second.

#include "../src/Ump.h"

#include <cstdio>
#include <cstring>
#include <vector>

namespace {

int failures = 0;

void Check(bool condition, const char *what) {
  if (condition) return;
  std::printf("  FAIL  %s\n", what);
  failures++;
}

using Message = std::vector<uint8_t>;

void Collect(void *context, const uint8_t *data, size_t length) {
  static_cast<std::vector<Message> *>(context)->push_back(
      Message(data, data + length));
}

std::vector<Message> Decode(vrmc::UmpDecoder &decoder,
                            const std::vector<uint32_t> &words) {
  std::vector<Message> out;
  decoder.Decode(words.data(), words.size(), Collect, &out);
  return out;
}

bool Equals(const Message &got, const Message &want) {
  return got.size() == want.size() &&
         std::memcmp(got.data(), want.data(), want.size()) == 0;
}

/// One 32-bit UMP for a MIDI 1.0 channel voice message.
uint32_t Cv(uint8_t group, uint8_t status, uint8_t d1, uint8_t d2) {
  return (static_cast<uint32_t>(0x2) << 28) |
         (static_cast<uint32_t>(group & 0x0f) << 24) |
         (static_cast<uint32_t>(status) << 16) |
         (static_cast<uint32_t>(d1) << 8) | d2;
}

/// The two words of one SysEx7 packet.
void SysEx7(std::vector<uint32_t> &out, uint8_t status, const uint8_t *data,
            size_t count) {
  uint8_t b[6] = {0, 0, 0, 0, 0, 0};
  for (size_t i = 0; i < count && i < 6; i++) b[i] = data[i];
  out.push_back((static_cast<uint32_t>(0x3) << 28) |
                (static_cast<uint32_t>(status & 0x0f) << 20) |
                (static_cast<uint32_t>(count & 0x0f) << 16) |
                (static_cast<uint32_t>(b[0]) << 8) | b[1]);
  out.push_back((static_cast<uint32_t>(b[2]) << 24) |
                (static_cast<uint32_t>(b[3]) << 16) |
                (static_cast<uint32_t>(b[4]) << 8) | b[5]);
}

void ChannelVoice() {
  std::printf("channel voice\n");
  vrmc::UmpDecoder d;

  auto got = Decode(d, {Cv(0, 0x90, 60, 100)});
  Check(got.size() == 1 && Equals(got[0], {0x90, 60, 100}), "note on");

  got = Decode(d, {Cv(0, 0x80, 60, 0)});
  Check(got.size() == 1 && Equals(got[0], {0x80, 60, 0}), "note off");

  got = Decode(d, {Cv(0, 0xb0, 7, 100)});
  Check(got.size() == 1 && Equals(got[0], {0xb0, 7, 100}), "control change");

  // Two bytes, not three. A decoder that always emitted three would append a
  // stray zero, and a DAW reading the next message would be one byte out.
  got = Decode(d, {Cv(0, 0xc0, 5, 0)});
  Check(got.size() == 1 && Equals(got[0], {0xc0, 5}), "program change is two bytes");

  got = Decode(d, {Cv(0, 0xd0, 64, 0)});
  Check(got.size() == 1 && Equals(got[0], {0xd0, 64}), "channel pressure is two bytes");

  // Polyphonic aftertouch: the Launchpad Pro MK3 sends it and Live reads it.
  got = Decode(d, {Cv(0, 0xa0, 60, 90)});
  Check(got.size() == 1 && Equals(got[0], {0xa0, 60, 90}), "poly pressure");

  got = Decode(d, {Cv(0, 0xe0, 0, 64)});
  Check(got.size() == 1 && Equals(got[0], {0xe0, 0, 64}), "pitch bend");

  // Several in one packet list, which is how a chord arrives.
  got = Decode(d, {Cv(0, 0x90, 60, 100), Cv(0, 0x90, 64, 100), Cv(0, 0x90, 67, 100)});
  Check(got.size() == 3, "a chord arrives as three messages");
}

void SystemMessages() {
  std::printf("system messages\n");
  vrmc::UmpDecoder d;
  const uint32_t clock = (static_cast<uint32_t>(0x1) << 28) | (0xf8u << 16);
  auto got = Decode(d, {clock});
  Check(got.size() == 1 && Equals(got[0], {0xf8}), "clock is one byte");

  const uint32_t spp = (static_cast<uint32_t>(0x1) << 28) | (0xf2u << 16) | (10u << 8) | 20u;
  got = Decode(d, {spp});
  Check(got.size() == 1 && Equals(got[0], {0xf2, 10, 20}), "song position is three");
}

void SysExInOnePacket() {
  std::printf("sysex, one packet\n");
  vrmc::UmpDecoder d;
  // A short Novation message: F0 00 20 29 02 0E F7 without the wrapper bytes.
  const uint8_t body[] = {0x00, 0x20, 0x29, 0x02, 0x0e, 0x03};
  std::vector<uint32_t> words;
  SysEx7(words, 0, body, 6);  // status 0: complete in one packet
  auto got = Decode(d, words);
  Check(got.size() == 1, "one message out");
  if (got.empty()) return;
  // The F0 and F7 are not on the wire and must be put back.
  Check(got[0].front() == 0xf0, "F0 restored at the front");
  Check(got[0].back() == 0xf7, "F7 restored at the end");
  Check(Equals(got[0], {0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x03, 0xf7}),
        "body preserved between them");
}

void SysExAcrossPackets() {
  std::printf("sysex, many packets\n");
  vrmc::UmpDecoder d;
  // A realistic grid update: 60 bytes, which is ten packets.
  std::vector<uint8_t> body;
  for (size_t i = 0; i < 60; i++) body.push_back(static_cast<uint8_t>(i & 0x7f));

  std::vector<uint32_t> words;
  for (size_t at = 0; at < body.size(); at += 6) {
    const size_t count = (body.size() - at) < 6 ? (body.size() - at) : 6;
    const uint8_t status = at == 0 ? 1 : (at + count >= body.size() ? 3 : 2);
    SysEx7(words, status, body.data() + at, count);
  }

  auto got = Decode(d, words);
  Check(got.size() == 1, "reassembled into exactly one message");
  if (got.empty()) return;
  Check(got[0].size() == body.size() + 2, "length is the body plus F0 and F7");
  Message want;
  want.push_back(0xf0);
  want.insert(want.end(), body.begin(), body.end());
  want.push_back(0xf7);
  Check(Equals(got[0], want), "every byte in order");
}

void SysExPacketsArrivingSeparately() {
  std::printf("sysex, one call per packet\n");
  // The real shape: MIDIServer hands over one packet at a time, so the decoder
  // has to hold state *between calls*, not merely within one.
  vrmc::UmpDecoder d;
  std::vector<uint8_t> body;
  for (size_t i = 0; i < 20; i++) body.push_back(static_cast<uint8_t>(0x40 + i));

  std::vector<Message> got;
  for (size_t at = 0; at < body.size(); at += 6) {
    const size_t count = (body.size() - at) < 6 ? (body.size() - at) : 6;
    const uint8_t status = at == 0 ? 1 : (at + count >= body.size() ? 3 : 2);
    std::vector<uint32_t> words;
    SysEx7(words, status, body.data() + at, count);
    d.Decode(words.data(), words.size(), Collect, &got);
  }
  Check(got.size() == 1, "one message from many calls");
  if (got.empty()) return;
  Check(got[0].size() == body.size() + 2, "nothing lost between calls");
}

void SysExEdges() {
  std::printf("sysex, the awkward cases\n");
  {
    // A continue with no start: the beginning was lost. Emitting the fragment
    // would be a malformed SysEx that a device might act on.
    vrmc::UmpDecoder d;
    const uint8_t body[] = {1, 2, 3};
    std::vector<uint32_t> words;
    SysEx7(words, 2, body, 3);
    Check(Decode(d, words).empty(), "an orphan continue emits nothing");
  }
  {
    // An end with no start, likewise.
    vrmc::UmpDecoder d;
    const uint8_t body[] = {1, 2, 3};
    std::vector<uint32_t> words;
    SysEx7(words, 3, body, 3);
    Check(Decode(d, words).empty(), "an orphan end emits nothing");
  }
  {
    // A second start while one is in flight: the first was abandoned. Splicing
    // them would produce one message containing two.
    vrmc::UmpDecoder d;
    const uint8_t first[] = {0x11, 0x22};
    const uint8_t second[] = {0x33, 0x44};
    std::vector<uint32_t> words;
    SysEx7(words, 1, first, 2);
    SysEx7(words, 0, second, 2);  // complete-in-one restarts
    auto got = Decode(d, words);
    Check(got.size() == 1, "the abandoned one is not emitted");
    if (!got.empty()) {
      Check(Equals(got[0], {0xf0, 0x33, 0x44, 0xf7}), "and does not contaminate the new one");
    }
  }
  {
    // Zero data bytes in a packet is legal — an end that carries none.
    vrmc::UmpDecoder d;
    const uint8_t body[] = {0x7f};
    std::vector<uint32_t> words;
    SysEx7(words, 1, body, 1);
    SysEx7(words, 3, nullptr, 0);
    auto got = Decode(d, words);
    Check(got.size() == 1 && Equals(got[0], {0xf0, 0x7f, 0xf7}), "an empty end still terminates");
  }
  {
    // Over the cap. Truncating would hand a device half a palette upload,
    // which it may act on; abandoning is the safer failure.
    vrmc::UmpDecoder d;
    std::vector<uint32_t> words;
    uint8_t six[6] = {1, 2, 3, 4, 5, 6};
    SysEx7(words, 1, six, 6);
    for (size_t i = 0; i < vrmc::kMaxSysExBytes; i += 6) SysEx7(words, 2, six, 6);
    SysEx7(words, 3, six, 6);
    auto got = Decode(d, words);
    for (const auto &m : got) {
      Check(m.size() <= vrmc::kMaxSysExBytes + 1, "nothing longer than the cap escapes");
    }
  }
}

void TruncatedAndUnknown() {
  std::printf("truncated and unknown packets\n");
  vrmc::UmpDecoder d;
  // A SysEx7 header with its second word missing: two words are needed and one
  // is present. Reading past it would be reading somebody else's memory.
  std::vector<uint32_t> words;
  const uint8_t body[] = {1, 2};
  SysEx7(words, 0, body, 2);
  words.pop_back();
  Check(Decode(d, words).empty(), "a truncated packet is dropped, not read past");

  /*
   * A MIDI 2.0 channel voice message (type 4), which a MIDI 2.0 host may send
   * and which this device does not speak. It is *two* words, and skipping the
   * right number is what keeps the rest of the stream readable.
   *
   * Its second word is deliberately shaped like a channel-voice UMP. A first
   * version of this test padded with zeroes, which decode as a harmless
   * utility packet — so a decoder that treated type 4 as one word skipped the
   * zero word too and the test passed anyway. The padding has to be something
   * that *would* be emitted if the size were wrong.
   */
  vrmc::UmpDecoder d2;
  const std::vector<uint32_t> mixed = {(static_cast<uint32_t>(0x4) << 28),
                                       Cv(0, 0x90, 7, 7),
                                       Cv(0, 0x90, 61, 99)};
  auto got = Decode(d2, mixed);
  Check(got.size() == 1, "the MIDI 2.0 message's second word is not decoded as MIDI 1.0");
  Check(got.size() == 1 && Equals(got[0], {0x90, 61, 99}),
        "and the message after it is still read");
}

}  // namespace

int main() {
  std::printf("UMP to MIDI 1.0\n\n");
  ChannelVoice();
  SystemMessages();
  SysExInOnePacket();
  SysExAcrossPackets();
  SysExPacketsArrivingSeparately();
  SysExEdges();
  TruncatedAndUnknown();
  std::printf("\n%s\n", failures == 0 ? "ok" : "FAILED");
  return failures == 0 ? 0 : 1;
}
