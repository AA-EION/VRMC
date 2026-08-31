/**
 * VRMC wire protocol — shared constants.
 *
 * The wire format is deliberately fixed-width and little-endian so that both
 * ends can encode/decode straight out of a preallocated ArrayBuffer with no
 * per-message allocation. Nothing in the hot path may allocate: on the Quest a
 * single minor GC during a drum roll is audible as a dropped or late note.
 */

/** ASCII "VM", little-endian. Cheap sanity check against stray UDP traffic. */
export const MAGIC = 0x4d56;

/**
 * Bump on any incompatible layout change. Receivers reject mismatches.
 *
 * v2 added the return path. v1 only ever sent headset -> bridge, which is all a
 * pad controller needs; a Launchpad is a display as much as an input, and its
 * LEDs are driven by the DAW, so the link had to become bidirectional.
 */
export const PROTOCOL_VERSION = 2;

/** Packet header size in bytes. Events begin at this offset. */
export const HEADER_BYTES = 16;

/** Size of a single encoded event. */
export const EVENT_BYTES = 12;

/**
 * Max events per packet. 64 * 12 + 16 = 784 bytes, comfortably inside the
 * 1280-byte payload that survives every Wi-Fi/IPv6 path without fragmentation.
 * A fragmented UDP datagram is an all-or-nothing loss, so we never approach it.
 */
export const MAX_EVENTS_PER_PACKET = 64;

/** Largest EVENTS packet. */
export const MAX_EVENT_PACKET_BYTES = HEADER_BYTES + MAX_EVENTS_PER_PACKET * EVENT_BYTES;

/**
 * Largest control packet.
 *
 * Control traffic is variable length and can be much bigger than an events
 * packet — a full Launchpad redraw is 64 LEDs, and a SysEx dump is bigger
 * still. These travel over WebSocket, which frames and reassembles for us, so
 * the UDP fragmentation limit that caps events does not apply.
 */
export const MAX_CONTROL_BYTES = 4096;

/** Largest packet of any kind. Sized for receive buffers. */
export const MAX_PACKET_BYTES = MAX_CONTROL_BYTES;

/** Bytes per LED in an LED_UPDATE body: index, r, g, b, blink. */
export const LED_ENTRY_BYTES = 5;

/** Most LEDs one update packet can carry. */
export const MAX_LEDS_PER_PACKET = 200;

/** Default transport ports. */
export const DEFAULT_WS_PORT = 7401;
export const DEFAULT_UDP_PORT = 7402;

/** Packet kinds (header byte 3). */
export const PacketKind = {
  /** Body is `count` MIDI events. */
  EVENTS: 1,
  /** Latency probe, client -> server. Header only. */
  PING: 2,
  /** Probe reply, server -> client. Header + f64 server timestamp. */
  PONG: 3,
  /** Session announce, client -> server. Header + UTF-8 client name. */
  HELLO: 4,
  /** Emergency stop: kill every sounding note on every channel. */
  PANIC: 5,
  /** Graceful disconnect. Server releases held notes immediately. */
  BYE: 6,

  // --- v2: device lifecycle and the return path ---

  /**
   * Headset -> bridge: create a virtual device.
   *
   * The bridge answers by creating real MIDI ports named after the emulated
   * hardware, which is what makes the device appear in the DAW.
   */
  DEVICE_ADD: 7,
  /** Headset -> bridge: destroy a device and close its ports. */
  DEVICE_REMOVE: 8,
  /** Bridge -> headset: the current device roster and each one's port status. */
  DEVICE_STATE: 9,
  /**
   * Bridge -> headset: LEDs changed.
   *
   * The DAW drives these. Without them a virtual Launchpad is an input device
   * with a dark grid, which is not what a Launchpad is for.
   */
  LED_UPDATE: 10,
  /** Either direction: a raw SysEx message for one device. */
  SYSEX: 11,
} as const;
export type PacketKind = (typeof PacketKind)[keyof typeof PacketKind];

/** Event types (event byte 0). */
export const EventType = {
  NOTE_OFF: 0,
  NOTE_ON: 1,
  /** Polyphonic key pressure — driven by sustained fingertip depth. */
  AFTERTOUCH_POLY: 2,
  CONTROL_CHANGE: 3,
  PROGRAM_CHANGE: 4,
  /** Channel pressure. */
  AFTERTOUCH_CHANNEL: 5,
  PITCH_BEND: 6,
  /** 14-bit CC: sends the MSB on `data1` and the LSB on `data1 + 32`. */
  CONTROL_CHANGE_14: 7,
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** Per-event flag bits (event byte 7). */
export const EventFlags = {
  NONE: 0,
  /**
   * The sender could not measure a real velocity (hand tracking lost the joint
   * mid-strike) and substituted a default. The bridge may log these; a run of
   * them means the tracking volume or lighting needs attention.
   */
  ESTIMATED_VELOCITY: 1 << 0,
  /** Event was produced by a controller (not hand) input path. */
  FROM_CONTROLLER: 1 << 1,
} as const;

/**
 * Device instance id, carried in every event so the bridge knows which port to
 * emit on.
 *
 * v1 treated this as a fixed enum of the three built-in surfaces. v2 makes it a
 * runtime instance id, because there can now be several devices at once and a
 * user may hold two Launchpads. The three values below stay reserved so the
 * original surfaces keep their identity.
 */
export const DeviceId = {
  PADS: 1,
  KEYS: 2,
  KNOBS: 3,
} as const;
export type DeviceId = (typeof DeviceId)[keyof typeof DeviceId];

/** First id handed out to a dynamically created device. */
export const FIRST_DYNAMIC_DEVICE_ID = 16;

/** Highest device instance id. The field is one byte. */
export const MAX_DEVICE_ID = 255;

/** MIDI status nibbles, for the bridge's encoder. */
export const MidiStatus = {
  NOTE_OFF: 0x80,
  NOTE_ON: 0x90,
  AFTERTOUCH_POLY: 0xa0,
  CONTROL_CHANGE: 0xb0,
  PROGRAM_CHANGE: 0xc0,
  AFTERTOUCH_CHANNEL: 0xd0,
  PITCH_BEND: 0xe0,
} as const;

/** CC 123. Silences sounding notes without clearing sustain state. */
export const CC_ALL_NOTES_OFF = 123;
/** CC 120. Harder stop: cuts the voice, used on disconnect. */
export const CC_ALL_SOUND_OFF = 120;
