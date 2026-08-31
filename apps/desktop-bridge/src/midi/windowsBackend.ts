import { dataByteCount } from '@vrmc/protocol';
import { SimpleVirtualPort, type MidiSink, type MidiSource, type VirtualPort } from './MidiSink.js';

/**
 * Virtual MIDI on Windows.
 *
 * Windows has no equivalent of CoreMIDI's virtual sources. WinMM, the classic
 * MIDI API, can only *open* ports that a kernel driver already published — an
 * application cannot create one. So a Windows virtual port always means a
 * third-party kernel driver, and there are two realistic routes:
 *
 *  1. teVirtualMIDI (Tobias Erichsen). A user-mode DLL over a signed kernel
 *     driver, installed by loopMIDI, rtpMIDI or the virtualMIDI SDK. It lets us
 *     create a port at runtime with the name we choose. This file drives it
 *     through FFI. Note its licence: free for personal use, but shipping it in
 *     a commercial product needs a licence from the author.
 *
 *  2. loopMIDI. The user creates a named port once in its GUI and we simply
 *     open it, through the same RtMidi path every other platform uses. No FFI,
 *     no licensing question for us, but it needs that one-time manual step.
 *
 * The bridge tries (1) and falls back to (2). Longer term, Windows MIDI
 * Services — Microsoft's new MIDI 2.0 stack — adds app-created virtual
 * endpoints natively, which will make this whole file unnecessary on Windows
 * versions that ship it.
 */

/** Flags from teVirtualMIDI.h. */
const TE_VM_FLAGS_PARSE_RX = 1;
const TE_VM_FLAGS_INSTANTIATE_BOTH = 12;

/** Maximum SysEx the driver will buffer. We send none, so keep it small. */
const MAX_SYSEX_LENGTH = 65536;

/**
 * Where the virtualMIDI installers put the DLL, tried in order.
 *
 * The bare names resolve through the standard Windows search path, which is
 * where a normal install lands; the absolute paths cover a machine whose
 * System32 is not on the loader path for this process.
 */
const DLL_CANDIDATES: readonly string[] = [
  'teVirtualMIDI64.dll',
  'C:\\Windows\\System32\\teVirtualMIDI64.dll',
  'teVirtualMIDI.dll',
  'teVirtualMIDI32.dll',
  'C:\\Windows\\SysWOW64\\teVirtualMIDI32.dll',
];

/**
 * The slice of koffi we use. Declared structurally rather than as
 * `typeof import('koffi')` so a machine without the optional dependency
 * installed still typechecks.
 */
interface KoffiLike {
  load(path: string): {
    func(name: string, result: unknown, args: unknown[]): unknown;
  };
  pointer(name: string, type: unknown): unknown;
  opaque(): unknown;
  proto(signature: string): unknown;
  register(fn: unknown, type: unknown): unknown;
  decode(pointer: unknown, type: string, length: number): Uint8Array;
}

interface TeVirtualMidiApi {
  createPort: (
    name: string,
    callback: unknown,
    instance: number,
    maxSysex: number,
    flags: number,
  ) => unknown;
  sendData: (port: unknown, data: Buffer, length: number) => boolean;
  closePort: (port: unknown) => void;
  /** Wrap a JS function as a native callback the driver can invoke. */
  registerCallback: (fn: (data: Uint8Array) => void) => unknown;
  dllPath: string;
}

/**
 * Bind the teVirtualMIDI entry points through koffi.
 *
 * Returns null when the driver is not installed, which is the normal case on a
 * machine that has never had loopMIDI or rtpMIDI on it.
 */
async function bindTeVirtualMidi(): Promise<TeVirtualMidiApi | null> {
  let koffi: KoffiLike;
  try {
    const mod = (await import('koffi')) as unknown as KoffiLike & { default?: KoffiLike };
    koffi = mod.default ?? mod;
  } catch {
    return null;
  }

  for (const candidate of DLL_CANDIDATES) {
    try {
      const lib = koffi.load(candidate);
      // LPVM_MIDI_PORT is an opaque handle; we only ever pass it back in.
      const PortHandle = koffi.pointer('LPVM_MIDI_PORT', koffi.opaque());

      // On x64 Windows there is a single calling convention, so the __stdcall
      // in the SDK header is a no-op there; koffi's default binding is correct.
      const createPort = lib.func('virtualMIDICreatePortEx2', PortHandle, [
        'str16', // LPCWSTR portName — Windows wide string
        'void *', // LPVM_MIDI_DATA_CB callback; null = we never receive
        'uintptr_t', // DWORD_PTR dwCallbackInstance
        'uint32', // DWORD maxSysexLength
        'uint32', // DWORD flags
      ]);
      const sendData = lib.func('virtualMIDISendData', 'bool', [
        PortHandle,
        'uint8_t *',
        'uint32',
      ]);
      const closePort = lib.func('virtualMIDIClosePort', 'void', [PortHandle]);

      // The driver's data callback:
      //   void CALLBACK cb(LPVM_MIDI_PORT, LPBYTE data, DWORD length, DWORD_PTR)
      const CallbackProto = koffi.proto(
        'void TeVmCallback(void *port, uint8_t *data, uint32_t length, uintptr_t instance)',
      );

      const registerCallback = (fn: (data: Uint8Array) => void): unknown =>
        koffi.register(
          (_port: unknown, data: unknown, length: number) => {
            if (length <= 0) return;
            fn(koffi.decode(data, 'uint8_t', length));
          },
          koffi.pointer('TeVmCallbackPtr', CallbackProto),
        );

      return {
        createPort: createPort as TeVirtualMidiApi['createPort'],
        sendData: sendData as TeVirtualMidiApi['sendData'],
        closePort: closePort as TeVirtualMidiApi['closePort'],
        registerCallback,
        dllPath: candidate,
      };
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

/**
 * Input side of a teVirtualMIDI port.
 *
 * Unlike CoreMIDI, where the input and output halves are separate endpoints
 * that happen to share a name, one teVirtualMIDI port is inherently
 * bidirectional: the driver delivers host traffic through the callback passed
 * at creation. So the source here is a view onto the same port as the sink.
 */
class TeVirtualMidiSource implements MidiSource {
  readonly name: string;
  onMessage: ((bytes: Uint8Array) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /** Called by the port's driver callback. */
  deliver(bytes: Uint8Array): void {
    this.onMessage?.(bytes);
  }

  close(): void {
    this.onMessage = null;
  }
}

class TeVirtualMidiSink implements MidiSink {
  readonly name: string;
  readonly backend = 'tevirtualmidi';
  readonly virtual = true;
  private readonly api: TeVirtualMidiApi;
  private port: unknown;
  private closed = false;

  /**
   * One reusable 3-byte buffer. The driver copies synchronously inside
   * `virtualMIDISendData`, so reusing it is safe and keeps the send path free
   * of per-message allocation.
   */
  private readonly buf = Buffer.allocUnsafe(3);

  constructor(api: TeVirtualMidiApi, port: unknown, name: string) {
    this.api = api;
    this.port = port;
    this.name = name;
  }

  send(status: number, d1: number, d2: number): void {
    if (this.closed) return;
    const len = dataByteCount(status) === 1 ? 2 : 3;
    this.buf[0] = status;
    this.buf[1] = d1;
    if (len === 3) this.buf[2] = d2;
    this.api.sendData(this.port, this.buf, len);
  }

  sendRaw(bytes: Uint8Array): void {
    if (this.closed) return;
    // The driver takes a length, so any message size works without the
    // three-byte assumption the channel-voice path makes.
    this.api.sendData(this.port, Buffer.from(bytes), bytes.length);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.api.closePort(this.port);
    } catch {
      /* driver already unloaded */
    }
    this.port = null;
  }
}

/**
 * Create a bidirectional Windows virtual MIDI port via teVirtualMIDI.
 *
 * Returns null when the driver is absent or the port cannot be created (most
 * often because a port of the same name is already open).
 *
 * The driver calls back on its own thread whenever the host sends us something.
 * koffi marshals that into a JS callback, which is how LED writes and the
 * identity handshake reach the emulator on Windows.
 */
export async function openTeVirtualMidiPort(name: string): Promise<VirtualPort | null> {
  const api = await bindTeVirtualMidi();
  if (api === null) return null;

  const source = new TeVirtualMidiSource(name);
  try {
    const callback = api.registerCallback((data: Uint8Array) => source.deliver(data));
    const port = api.createPort(
      name,
      callback,
      0,
      MAX_SYSEX_LENGTH,
      TE_VM_FLAGS_INSTANTIATE_BOTH | TE_VM_FLAGS_PARSE_RX,
    );
    if (port === null || port === undefined) return null;
    return new SimpleVirtualPort(name, new TeVirtualMidiSink(api, port, name), source);
  } catch {
    return null;
  }
}

/** Default pattern for finding a usable loopback port on Windows. */
export const WINDOWS_LOOPBACK_PATTERN = /loopMIDI|rtpMIDI|VRMC/i;
