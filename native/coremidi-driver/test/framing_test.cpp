// SPDX-License-Identifier: GPL-3.0-only
//
// Does the C++ half of the wire format agree with the TypeScript half?
//
// The bridge and the driver each implement this format, separately, from one
// description — which is how wire formats drift apart. `vectors.h` is generated
// from the TypeScript encoder and holds the bytes it actually produces; every
// case below requires this C++ to produce and to parse exactly those bytes.
//
// Deliberately no test framework. This has to compile and run anywhere the
// driver might be built, including a Linux CI runner that has no CoreMIDI at
// all — the format is platform-independent, so testing it needs no Mac, and a
// check that can only run on the expensive runner is a check that runs less.

#include "../src/Framing.h"
#include "vectors.h"

#include <cstdio>
#include <cstring>
#include <vector>

namespace {

int failures = 0;

void Check(bool condition, const char *what, const char *detail = "") {
  if (condition) return;
  std::printf("  FAIL  %s %s\n", what, detail);
  failures++;
}

/// Collects whole frames out of a FrameReader.
struct Collected {
  uint8_t kind;
  uint8_t port;
  std::vector<uint8_t> payload;
};

void Collect(void *context, uint8_t kind, uint8_t port, const uint8_t *payload,
             size_t length) {
  auto *out = static_cast<std::vector<Collected> *>(context);
  out->push_back({kind, port, std::vector<uint8_t>(payload, payload + length)});
}

/// Every vector encodes to exactly the bytes the TypeScript produced.
void EncodeMatchesTypeScript() {
  std::printf("encoding\n");
  uint8_t out[vrmc::kMaxFrameBytes];
  for (size_t i = 0; i < vrmc_vectors::kVectorCount; i++) {
    const auto &v = vrmc_vectors::kVectors[i];
    const size_t written = vrmc::EncodeFrame(out, sizeof(out), v.kind, v.port,
                                             v.payload, v.payloadLength);
    Check(written == v.encodedLength, "encoded length", v.name);
    if (written != v.encodedLength) continue;
    Check(std::memcmp(out, v.encoded, written) == 0, "encoded bytes", v.name);
  }
}

/// And every one of them parses back to what went in.
void DecodeMatchesTypeScript() {
  std::printf("decoding\n");
  for (size_t i = 0; i < vrmc_vectors::kVectorCount; i++) {
    const auto &v = vrmc_vectors::kVectors[i];
    vrmc::FrameReader reader;
    std::vector<Collected> got;
    Check(reader.Push(v.encoded, v.encodedLength, Collect, &got), "accepted",
          v.name);
    Check(got.size() == 1, "one frame out", v.name);
    if (got.size() != 1) continue;
    Check(got[0].kind == v.kind, "kind", v.name);
    Check(got[0].port == v.port, "port", v.name);
    Check(got[0].payload.size() == v.payloadLength, "payload length", v.name);
    if (got[0].payload.size() != v.payloadLength) continue;
    Check(std::memcmp(got[0].payload.data(), v.payload, v.payloadLength) == 0,
          "payload bytes", v.name);
  }
}

/// A stream socket splits and joins writes freely; the reader must not care.
///
/// This is the property the whole length-prefix exists for. A Note On arriving
/// in two reads and re-emitted as two fragments is a stuck note.
void SurvivesArbitrarySplitting() {
  std::printf("splitting\n");
  // Every vector, back to back, as one stream.
  std::vector<uint8_t> stream;
  for (size_t i = 0; i < vrmc_vectors::kVectorCount; i++) {
    const auto &v = vrmc_vectors::kVectors[i];
    stream.insert(stream.end(), v.encoded, v.encoded + v.encodedLength);
  }

  // Sizes chosen to land inside headers, inside payloads, and on boundaries.
  const size_t chunkSizes[] = {1, 2, 3, 4, 5, 7, 13, 64, 1000, 8191, 8192, 65536};
  for (size_t s = 0; s < sizeof(chunkSizes) / sizeof(chunkSizes[0]); s++) {
    const size_t chunk = chunkSizes[s];
    vrmc::FrameReader reader;
    std::vector<Collected> got;
    bool ok = true;
    for (size_t offset = 0; offset < stream.size(); offset += chunk) {
      const size_t take =
          (stream.size() - offset) < chunk ? (stream.size() - offset) : chunk;
      if (!reader.Push(stream.data() + offset, take, Collect, &got)) {
        ok = false;
        break;
      }
    }
    char detail[64];
    std::snprintf(detail, sizeof(detail), "in chunks of %zu", chunk);
    Check(ok, "stream accepted", detail);
    Check(got.size() == vrmc_vectors::kVectorCount, "every frame recovered",
          detail);
    if (got.size() != vrmc_vectors::kVectorCount) continue;
    for (size_t i = 0; i < got.size(); i++) {
      const auto &v = vrmc_vectors::kVectors[i];
      Check(got[i].kind == v.kind && got[i].port == v.port &&
                got[i].payload.size() == v.payloadLength &&
                std::memcmp(got[i].payload.data(), v.payload, v.payloadLength) ==
                    0,
            "frame survived splitting", detail);
    }
  }
}

/// A partial frame yields nothing, rather than a truncated one.
void HoldsBackPartialFrames() {
  std::printf("partial frames\n");
  const auto &v = vrmc_vectors::kVectors[4];  // the long SysEx
  for (size_t prefix = 0; prefix < v.encodedLength; prefix++) {
    vrmc::FrameReader reader;
    std::vector<Collected> got;
    Check(reader.Push(v.encoded, prefix, Collect, &got), "prefix accepted",
          v.name);
    Check(got.empty(), "no frame from a partial one", v.name);
  }
}

/// A length beyond the maximum is refused rather than trusted.
void RefusesAnOversizedLength() {
  std::printf("refusing nonsense\n");
  // 0xffff, well past kMaxPayloadBytes. A reader that believed this would try
  // to wait for 65535 bytes that are never coming, and block the link forever.
  const uint8_t bad[] = {0xff, 0xff, 0x00, vrmc::kFrameMidi};
  vrmc::FrameReader reader;
  std::vector<Collected> got;
  Check(!reader.Push(bad, sizeof(bad), Collect, &got), "oversized refused");
  Check(got.empty(), "nothing emitted from it");
}

/// Encoding refuses what it cannot describe, rather than truncating it.
void RefusesToEncodeTooMuch() {
  std::printf("encode limits\n");
  std::vector<uint8_t> big(vrmc::kMaxPayloadBytes + 1, 0x7f);
  uint8_t out[vrmc::kMaxFrameBytes * 2];
  Check(vrmc::EncodeFrame(out, sizeof(out), vrmc::kFrameMidi, 0, big.data(),
                          big.size()) == 0,
        "payload over the maximum refused");
  // And a destination too small is refused rather than overrun.
  uint8_t tiny[4];
  const uint8_t payload[] = {0x90, 0x3c, 0x40};
  Check(vrmc::EncodeFrame(tiny, sizeof(tiny), vrmc::kFrameMidi, 0, payload,
                          sizeof(payload)) == 0,
        "short destination refused");
}

/// The constants themselves have to match, not just the bytes.
void ConstantsAgree() {
  std::printf("constants\n");
  Check(vrmc::kHeaderBytes == vrmc_vectors::kHeaderBytes, "header size");
  Check(vrmc::kMaxPayloadBytes == vrmc_vectors::kMaxPayloadBytes,
        "maximum payload");
  Check(vrmc::kProtocolVersion == vrmc_vectors::kProtocolVersion, "version");
}

}  // namespace

int main() {
  std::printf("framing, against the TypeScript's own bytes (%zu vectors)\n\n",
              vrmc_vectors::kVectorCount);
  ConstantsAgree();
  EncodeMatchesTypeScript();
  DecodeMatchesTypeScript();
  SurvivesArbitrarySplitting();
  HoldsBackPartialFrames();
  RefusesAnOversizedLength();
  RefusesToEncodeTooMuch();

  std::printf("\n%s\n", failures == 0 ? "ok" : "FAILED");
  return failures == 0 ? 0 : 1;
}
