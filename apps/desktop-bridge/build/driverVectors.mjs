// SPDX-License-Identifier: GPL-3.0-only

/**
 * Generate the frame vectors both implementations are tested against.
 *
 * The wire format has two implementations — TypeScript in the bridge, C++ in
 * the driver — written separately from one description, which is how wire
 * formats drift apart. This produces the bytes the TypeScript actually emits;
 * `native/coremidi-driver/test/framing_test.cpp` reads them and requires the
 * C++ to produce and parse the same. A disagreement is then a failed build
 * rather than a stuck note on somebody's machine.
 *
 * Emitted as a C++ header rather than as JSON on purpose. Reading JSON would
 * mean a parser in the test, and a bug in *that* is a test that passes when the
 * format has drifted — the one failure a cross-language check must not have. A
 * generated array has nothing to parse.
 *
 * Committed rather than generated during the build, so that a change to the
 * format shows up as a diff in review. `pnpm --filter @vrmc/desktop-bridge run
 * driver-vectors` regenerates it; CI checks the committed copy is current.
 */
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FrameKind,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  encodeAddress,
  encodeFrame,
} from '../dist/midi/driverFraming.js';
import { DEVICE_SPECS } from '@vrmc/devices';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../native/coremidi-driver/test/vectors.h');
const devicesOut = join(here, '../../../native/coremidi-driver/src/Devices.h');

/** A run of bytes that is distinctive rather than all one value. */
function pattern(length) {
  return Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
}

const cases = [
  { name: 'hello', kind: FrameKind.HELLO, port: 0, payload: [PROTOCOL_VERSION] },
  { name: 'note on', kind: FrameKind.MIDI, port: encodeAddress(1, 2), payload: [0x90, 0x3c, 0x5a] },
  { name: 'note off', kind: FrameKind.MIDI, port: encodeAddress(1, 2), payload: [0x80, 0x3c, 0x00] },
  { name: 'cc on the midi port', kind: FrameKind.MIDI, port: encodeAddress(0, 0), payload: [0xb0, 0x07, 0x64] },
  // Every corner of the packed address byte, since a device index that bled
  // into the port half would route silently to the wrong instrument.
  { name: 'device 0 port 0', kind: FrameKind.MIDI, port: encodeAddress(0, 0), payload: [0x90, 1, 1] },
  { name: 'device 0 port 15', kind: FrameKind.MIDI, port: encodeAddress(0, 15), payload: [0x90, 2, 2] },
  { name: 'device 15 port 0', kind: FrameKind.MIDI, port: encodeAddress(15, 0), payload: [0x90, 3, 3] },
  { name: 'device 15 port 15', kind: FrameKind.MIDI, port: encodeAddress(15, 15), payload: [0x90, 4, 4] },
  { name: 'device present', kind: FrameKind.DEVICE_STATE, port: encodeAddress(1, 0), payload: [1] },
  { name: 'device absent', kind: FrameKind.DEVICE_STATE, port: encodeAddress(0, 0), payload: [0] },
  // An LED SysEx: the long message that actually flows, and the one whose
  // length crosses into the header's second byte.
  { name: 'led sysex', kind: FrameKind.MIDI, port: 2, payload: [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x03, ...pattern(300), 0xf7] },
  { name: 'empty payload', kind: FrameKind.PING, port: 0, payload: [] },
  { name: 'pong', kind: FrameKind.PONG, port: 0, payload: [] },
  // The port byte is a whole byte and the kind is too: prove nothing truncates.
  { name: 'the whole address byte', kind: FrameKind.MIDI, port: 255, payload: [0x90, 0x7f, 0x7f] },
  // Exactly the maximum, which is where an off-by-one in either direction shows.
  { name: 'largest legal payload', kind: FrameKind.MIDI, port: 1, payload: pattern(MAX_PAYLOAD_BYTES) },
  { name: 'one under the maximum', kind: FrameKind.MIDI, port: 1, payload: pattern(MAX_PAYLOAD_BYTES - 1) },
  // 255/256 is where a byte boundary in the length would show up.
  { name: 'payload of 255', kind: FrameKind.MIDI, port: 1, payload: pattern(255) },
  { name: 'payload of 256', kind: FrameKind.MIDI, port: 1, payload: pattern(256) },
];

const buffer = new Uint8Array(64 * 1024);
const vectors = cases.map((c) => {
  const payload = Uint8Array.from(c.payload);
  const written = encodeFrame(buffer, 0, c.kind, c.port, payload);
  if (written < 0) throw new Error(`${c.name} did not encode`);
  return {
    name: c.name,
    kind: c.kind,
    port: c.port,
    payload: [...payload],
    encoded: [...buffer.subarray(0, written)],
  };
});

const bytes = (list) => list.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ');

const body = vectors
  .map(
    (v, i) => `// ${v.name}
static const uint8_t kPayload${i}[] = {${bytes(v.payload)}};
static const uint8_t kEncoded${i}[] = {${bytes(v.encoded)}};`,
  )
  .join('\n\n');

const table = vectors
  .map(
    (v, i) =>
      `    {"${v.name}", ${v.kind}, ${v.port}, kPayload${i}, ${v.payload.length}, kEncoded${i}, ${v.encoded.length}},`,
  )
  .join('\n');

await writeFile(
  out,
  `// SPDX-License-Identifier: GPL-3.0-only
//
// GENERATED by apps/desktop-bridge/build/driverVectors.mjs. Do not edit.
//
// These are the bytes the TypeScript encoder actually produces. The C++ in
// src/Framing.h is required to produce and to parse exactly the same, so that
// the two implementations of this wire format cannot drift apart unnoticed.
#pragma once

#include <cstddef>
#include <cstdint>

namespace vrmc_vectors {

inline constexpr size_t kHeaderBytes = ${4};
inline constexpr size_t kMaxPayloadBytes = ${MAX_PAYLOAD_BYTES};
inline constexpr uint8_t kProtocolVersion = ${PROTOCOL_VERSION};

${body}

struct Vector {
  const char *name;
  uint8_t kind;
  uint8_t port;
  const uint8_t *payload;
  size_t payloadLength;
  const uint8_t *encoded;
  size_t encodedLength;
};

inline constexpr Vector kVectors[] = {
${table}
};

inline constexpr size_t kVectorCount = sizeof(kVectors) / sizeof(kVectors[0]);

}  // namespace vrmc_vectors
`,
  'utf8',
);
console.log(`wrote ${vectors.length} vectors to ${out}`);

/*
 * The devices the driver publishes, taken from the specs rather than retyped.
 *
 * The driver has to know each model's name, manufacturer and port names, and
 * the bridge addresses its entities by the *spec's* port index — so the two
 * are only correct while they agree. Generating the C++ from `DEVICE_SPECS`
 * makes them the same list by construction, and the order here is the device
 * index on the wire.
 */
const models = Object.entries(DEVICE_SPECS);
const cString = (value) => JSON.stringify(value);

const deviceBody = models
  .map(([slug, spec], i) => {
    const ports = spec.portNames.map((n) => `    CFSTR(${cString(n)}),`).join('\n');
    return `// ${slug}
static const CFStringRef kPorts${i}[] = {
${ports}
};`;
  })
  .join('\n\n');

const deviceTable = models
  .map(
    ([slug, spec], i) =>
      `    {${cString(slug)}, CFSTR(${cString(spec.displayName)}), CFSTR(${cString(
        spec.manufacturer,
      )}), kPorts${i}, ${spec.portNames.length}},`,
  )
  .join('\n');

await writeFile(
  devicesOut,
  `// SPDX-License-Identifier: GPL-3.0-only
//
// GENERATED by apps/desktop-bridge/build/driverVectors.mjs. Do not edit.
//
// The devices this driver publishes, generated from the bridge's own device
// specs. The driver needs each model's name, manufacturer and port names, and
// the bridge addresses the driver's entities by the spec's port index — so the
// two halves are only correct while they agree, and generating one from the
// other makes them the same list rather than two lists that must be kept in
// step by hand.
//
// The order is the device index carried on the wire.
#pragma once

#include <CoreFoundation/CoreFoundation.h>
#include <cstddef>

namespace vrmc_devices {

${deviceBody}

struct DeviceSpec {
  const char *model;
  CFStringRef name;
  CFStringRef manufacturer;
  const CFStringRef *portNames;
  size_t portCount;
};

inline const DeviceSpec kDevices[] = {
${deviceTable}
};

inline constexpr size_t kDeviceCount = sizeof(kDevices) / sizeof(kDevices[0]);

/// Ports on the widest device, for fixed-size per-port arrays.
inline constexpr size_t kMaxPortsPerDevice = ${Math.max(
  ...models.map(([, spec]) => spec.portNames.length),
)};

}  // namespace vrmc_devices
`,
  'utf8',
);
console.log(`wrote ${models.length} devices to ${devicesOut}`);
