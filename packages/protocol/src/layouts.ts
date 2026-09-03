// SPDX-License-Identifier: GPL-3.0-only

import { MAX_LAYOUT_BODY_BYTES, MAX_LAYOUT_NAME_BYTES } from "./constants.js";
import type { PacketWriter } from "./codec.js";
import {
  PLACEMENT_BYTES,
  readPlacement,
  writePlacement,
  type DevicePlacement,
} from "./pose.js";

/**
 * Named arrangements of the room — "Studio", "Couch".
 *
 * Movable devices are worth much less without these. A pose that only lives in
 * the headset dies with the session, so every sitting would start with
 * everything back where the default placement put it, and the work of arranging
 * a room would be work you do again tomorrow.
 *
 * They are stored on the bridge rather than in the headset's local storage for
 * one reason: the bridge is the thing that persists. It is already running
 * before the headset connects, already outlives it, and already pushes the
 * roster on every connection — so a layout arriving in that same push is
 * restored before the player has finished putting the headset on. Local storage
 * would be per-browser, per-origin and gone the moment somebody clears site
 * data or uses the headset's other browser.
 *
 * A layout stores the *model* alongside each device id. Ids are handed out per
 * session and are not stable across restarts, so matching a saved entry to a
 * live device by id alone would put a Launchpad Pro where a Launchpad X had
 * been. The model is what makes a saved arrangement mean something a week
 * later.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface LayoutEntry {
  placement: DevicePlacement;
  /** The emulated model this placement was saved for. */
  model: string;
}

export interface Layout {
  name: string;
  entries: LayoutEntry[];
}

/** Trim a name to something that fits and is worth storing. */
export function normaliseLayoutName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  let bytes = encoder.encode(trimmed);
  if (bytes.length <= MAX_LAYOUT_NAME_BYTES) return trimmed;
  // Cut by characters, not bytes: slicing a UTF-8 buffer mid-sequence produces
  // a replacement character, and a layout called "Studi�" is a layout
  // somebody has to look at and wonder about.
  let cut = trimmed;
  while (bytes.length > MAX_LAYOUT_NAME_BYTES && cut.length > 0) {
    cut = cut.slice(0, -1);
    bytes = encoder.encode(cut);
  }
  return cut;
}

function writeName(w: PacketWriter, name: string): boolean {
  const bytes = encoder.encode(name);
  if (bytes.length > MAX_LAYOUT_NAME_BYTES) return false;
  return w.pushU8(bytes.length) && w.pushRaw(bytes);
}

/** Read a length-prefixed name. Returns the text and the next offset. */
function readName(
  body: Uint8Array,
  offset: number,
): { name: string; next: number } | null {
  if (offset >= body.length) return null;
  const len = body[offset]!;
  const from = offset + 1;
  if (from + len > body.length) return null;
  return {
    name: decoder.decode(body.subarray(from, from + len)),
    next: from + len,
  };
}

// --- LAYOUT_SAVE ---

/** Body: name, u8 count, then per entry a placement and a model name. */
export function writeLayoutSave(w: PacketWriter, layout: Layout): boolean {
  if (!writeName(w, layout.name)) return false;
  if (layout.entries.length > 255) return false;
  if (!w.pushU8(layout.entries.length)) return false;
  for (const entry of layout.entries) {
    if (!writePlacement(w, entry.placement)) return false;
    if (!writeName(w, entry.model)) return false;
  }
  return true;
}

export function readLayoutSave(body: Uint8Array): Layout | null {
  const head = readName(body, 0);
  if (head === null) return null;
  let o = head.next;
  if (o >= body.length) return null;
  const count = body[o]!;
  o += 1;

  const entries: LayoutEntry[] = [];
  for (let i = 0; i < count; i++) {
    const placement = readPlacement(body, o);
    if (placement === null) return null;
    o += PLACEMENT_BYTES;
    const model = readName(body, o);
    if (model === null) return null;
    o = model.next;
    entries.push({ placement, model: model.name });
  }
  return { name: head.name, entries };
}

// --- LAYOUT_DELETE and LAYOUT_APPLY ---

/** Both carry a name and nothing else. */
export function writeLayoutName(w: PacketWriter, name: string): boolean {
  return writeName(w, name);
}

export function readLayoutName(body: Uint8Array): string | null {
  return readName(body, 0)?.name ?? null;
}

// --- LAYOUT_STATE ---

export interface LayoutState {
  layouts: Layout[];
  /** The arrangement in use, or '' when none has been chosen. */
  current: string;
}

/** Bytes one layout occupies on the wire. */
export function layoutBytes(layout: Layout): number {
  let total = 1 + encoder.encode(layout.name).length + 1;
  for (const entry of layout.entries) {
    total += PLACEMENT_BYTES + 1 + encoder.encode(entry.model).length;
  }
  return total;
}

/**
 * As many layouts as fit in `budget` bytes, longest-standing first.
 *
 * Separate from the writing so the arithmetic can be tested without a packet,
 * and so the caller can see it dropped some.
 */
export function fitLayouts(state: LayoutState, budget: number): Layout[] {
  let left = budget - (1 + encoder.encode(state.current).length + 1);
  const fitted: Layout[] = [];
  for (const layout of state.layouts) {
    const size = layoutBytes(layout);
    if (size > left) break;
    left -= size;
    fitted.push(layout);
  }
  return fitted;
}

/**
 * Write the layout list, dropping the tail if it will not fit.
 *
 * Returns how many were written, which may be fewer than were offered — and
 * that is the point. This used to return false the moment the body overflowed,
 * and `Broadcaster.sendLayouts` returned without sending anything at all: a
 * headset with sixteen saved arrangements of eight devices got *no* layout
 * state, including `current`, which is the one field it needs to restore the
 * arrangement somebody is standing in. Sixteen by eight overflows a 4080-byte
 * body by several hundred bytes, so this was reachable rather than theoretical.
 *
 * Losing the oldest few layouts is a real loss and it is still the better one:
 * the alternative was losing all of them silently.
 */
export function writeLayoutState(w: PacketWriter, state: LayoutState): number {
  const fitted = fitLayouts(state, MAX_LAYOUT_BODY_BYTES);
  if (!writeName(w, state.current)) return -1;
  if (!w.pushU8(fitted.length)) return -1;
  for (const layout of fitted) {
    if (!writeLayoutSave(w, layout)) return -1;
  }
  return fitted.length;
}

/**
 * Read the whole set.
 *
 * A layout that does not decode cleanly ends the walk rather than being
 * skipped: entries are variable length, so a malformed one leaves the cursor
 * somewhere arbitrary and everything after it would be read out of a body it is
 * no longer aligned to. Returning what was understood so far is honest;
 * carrying on would be invention.
 */
export function readLayoutState(body: Uint8Array): LayoutState {
  const head = readName(body, 0);
  if (head === null) return { layouts: [], current: "" };
  let o = head.next;
  const layouts: Layout[] = [];
  if (o >= body.length) return { layouts, current: head.name };
  const count = body[o]!;
  o += 1;

  for (let i = 0; i < count; i++) {
    const name = readName(body, o);
    if (name === null) break;
    o = name.next;
    if (o >= body.length) break;
    const entryCount = body[o]!;
    o += 1;

    const entries: LayoutEntry[] = [];
    let ok = true;
    for (let e = 0; e < entryCount; e++) {
      const placement = readPlacement(body, o);
      if (placement === null) {
        ok = false;
        break;
      }
      o += PLACEMENT_BYTES;
      const model = readName(body, o);
      if (model === null) {
        ok = false;
        break;
      }
      o = model.next;
      entries.push({ placement, model: model.name });
    }
    if (!ok) break;
    layouts.push({ name: name.name, entries });
  }
  return { layouts, current: head.name };
}
