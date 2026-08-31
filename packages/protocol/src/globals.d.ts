// SPDX-License-Identifier: GPL-3.0-only

/**
 * Minimal declarations for the two UTF-8 globals this package uses.
 *
 * `TextEncoder` and `TextDecoder` are standard in both Node and every browser,
 * but TypeScript only declares them in `lib.dom.d.ts` or `@types/node`. This
 * package runs in both environments and should depend on neither — pulling in
 * DOM would let browser-only APIs typecheck inside the bridge, and pulling in
 * Node would do the reverse. Declaring just what is used keeps both honest.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
