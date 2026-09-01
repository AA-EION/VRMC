// SPDX-License-Identifier: GPL-3.0-only

/**
 * The conversation between the bridge and its tray helper.
 *
 * A menu bar item on macOS and a notification-area icon on Windows can only be
 * owned by a native process with a real event loop, and neither is reachable
 * from Node. So each platform gets a small native executable whose entire job
 * is to own that icon, and the two talk over stdin and stdout in
 * newline-delimited JSON.
 *
 * The helper holds no state and makes no decisions. It draws what it is told
 * and reports what was clicked; every judgement about what the menu should say
 * lives here, in one place, in TypeScript. That is what keeps the two native
 * implementations small enough to be obviously correct — the Swift and the C
 * are a few hundred lines each and contain no product logic at all.
 */

/** One row in the menu. */
export interface TrayItem {
  /** Reported back on click. Ignored for separators and disabled rows. */
  id: string;
  label: string;
  /** A greyed-out row, for status the user reads rather than presses. */
  enabled?: boolean;
  /** Draw a divider instead of a row; `id` and `label` are ignored. */
  separator?: boolean;
  /** Show a tick beside the label. */
  checked?: boolean;
}

/** Bridge to helper. */
export type TrayCommand =
  | { type: 'menu'; tooltip: string; items: TrayItem[] }
  | { type: 'quit' };

/** Helper to bridge. */
export type TrayEvent =
  | { type: 'ready' }
  | { type: 'click'; id: string }
  /** The user chose Quit, or the helper is going away. */
  | { type: 'quit' };

/**
 * Parse one line from a helper.
 *
 * Returns null rather than throwing. The helper's stdout is the only thing that
 * could put malformed input here, and a tray icon misbehaving must never take
 * down a bridge that is in the middle of a performance.
 */
export function parseTrayEvent(line: string): TrayEvent | null {
  const text = line.trim();
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = parsed as { type?: unknown; id?: unknown };
  if (event.type === 'ready' || event.type === 'quit') return { type: event.type };
  if (event.type === 'click' && typeof event.id === 'string') {
    return { type: 'click', id: event.id };
  }
  return null;
}
