// SPDX-License-Identifier: GPL-3.0-only

import {
  MAX_LAYOUTS,
  isPlausiblePlacement,
  normaliseLayoutName,
  type DevicePlacement,
  type Layout,
  type LayoutState,
} from '@vrmc/protocol';

/**
 * Where every device is, and the named arrangements of them.
 *
 * This lives on the bridge and not in the headset for one reason: the bridge is
 * the thing that persists. It is running before the headset connects, it
 * outlives the session, and it already pushes the roster on every connection —
 * so a placement it holds is restored before the player has finished putting
 * the headset on. Keeping it in the browser's storage instead would tie a
 * studio's layout to one origin in one browser on one headset, and lose it the
 * first time anybody cleared site data.
 *
 * Placements are kept per device id *and* per model. Ids are handed out per
 * session and are not stable across a bridge restart, so a saved arrangement
 * matched by id alone would put a Launchpad Pro where a Launchpad X had been.
 */
export class Workspace {
  private readonly placements = new Map<number, DevicePlacement>();
  private readonly layouts = new Map<string, Layout>();
  private current = '';

  /** Called whenever anything here changes and the headset should be told. */
  onChange: (() => void) | null = null;

  /**
   * Record where a device is.
   *
   * Implausible numbers are dropped rather than stored. This is not a guard
   * against a hostile sender — the bridge is on the same desk as the headset —
   * but against a NaN or an uninitialised buffer putting a Launchpad ten
   * kilometres away, which persists, restores on the next connection, and needs
   * the file deleting by hand to undo.
   */
  place(placement: DevicePlacement): boolean {
    if (!isPlausiblePlacement(placement)) return false;
    this.placements.set(placement.deviceId, placement);
    this.onChange?.();
    return true;
  }

  placementOf(deviceId: number): DevicePlacement | null {
    return this.placements.get(deviceId) ?? null;
  }

  /** Forget a device's placement, when the device itself goes away. */
  forget(deviceId: number): void {
    if (this.placements.delete(deviceId)) this.onChange?.();
  }

  // --- named arrangements ---

  /**
   * Store an arrangement under a name, replacing one of the same name.
   *
   * Replacing rather than refusing: «save» on a name that already exists is
   * somebody updating their studio, not somebody making a mistake, and a save
   * that quietly does nothing is the worst of the three possible answers.
   */
  save(layout: Layout): { ok: boolean; reason?: string } {
    const name = normaliseLayoutName(layout.name);
    if (name === '') return { ok: false, reason: 'a layout needs a name' };
    if (!this.layouts.has(name) && this.layouts.size >= MAX_LAYOUTS) {
      return { ok: false, reason: `only ${MAX_LAYOUTS} layouts can be stored` };
    }
    const entries = layout.entries.filter((e) => isPlausiblePlacement(e.placement));
    this.layouts.set(name, { name, entries });
    this.current = name;
    this.onChange?.();
    return { ok: true };
  }

  delete(name: string): boolean {
    const key = normaliseLayoutName(name);
    if (!this.layouts.delete(key)) return false;
    if (this.current === key) this.current = '';
    this.onChange?.();
    return true;
  }

  /**
   * Mark an arrangement as the one in use.
   *
   * The headset applies it locally; this only remembers which, so the next
   * connection can hand back the same one. That is the whole reason layouts are
   * stored here rather than chosen fresh each time.
   */
  apply(name: string): Layout | null {
    const key = normaliseLayoutName(name);
    const layout = this.layouts.get(key);
    if (layout === undefined) return null;
    this.current = key;
    // Applying an arrangement is also a statement about where everything now
    // is, so the per-device placements follow it. Without this a reconnect
    // would restore the layout's devices and leave the roster still describing
    // wherever they were before it was applied.
    for (const entry of layout.entries) this.placements.set(entry.placement.deviceId, entry.placement);
    this.onChange?.();
    return layout;
  }

  /** Everything the headset needs, for a LAYOUT_STATE push. */
  state(): LayoutState {
    return { layouts: [...this.layouts.values()], current: this.current };
  }

  get layoutCount(): number {
    return this.layouts.size;
  }

  /** For persistence: the whole workspace as plain data. */
  toJSON(): { placements: DevicePlacement[]; layouts: Layout[]; current: string } {
    return {
      placements: [...this.placements.values()],
      layouts: [...this.layouts.values()],
      current: this.current,
    };
  }

  /**
   * Restore from disk.
   *
   * Everything is re-validated on the way in. A file that has been edited, or
   * truncated by a power cut mid-write, is a file whose numbers have to earn
   * their way back in exactly as if they had arrived over the wire.
   */
  static fromJSON(data: unknown): Workspace {
    const workspace = new Workspace();
    if (typeof data !== 'object' || data === null) return workspace;
    const record = data as { placements?: unknown; layouts?: unknown; current?: unknown };

    if (Array.isArray(record.placements)) {
      for (const p of record.placements) {
        if (isPlacement(p) && isPlausiblePlacement(p)) workspace.placements.set(p.deviceId, p);
      }
    }
    if (Array.isArray(record.layouts)) {
      for (const l of record.layouts) {
        if (typeof l !== 'object' || l === null) continue;
        const layout = l as { name?: unknown; entries?: unknown };
        if (typeof layout.name !== 'string') continue;
        const name = normaliseLayoutName(layout.name);
        if (name === '' || workspace.layouts.size >= MAX_LAYOUTS) continue;
        const entries = Array.isArray(layout.entries)
          ? layout.entries.filter(
              (e): e is { placement: DevicePlacement; model: string } =>
                typeof e === 'object' &&
                e !== null &&
                typeof (e as { model?: unknown }).model === 'string' &&
                isPlacement((e as { placement?: unknown }).placement) &&
                isPlausiblePlacement((e as { placement: DevicePlacement }).placement),
            )
          : [];
        workspace.layouts.set(name, { name, entries });
      }
    }
    if (typeof record.current === 'string' && workspace.layouts.has(record.current)) {
      workspace.current = record.current;
    }
    return workspace;
  }
}

function isPlacement(v: unknown): v is DevicePlacement {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.deviceId === 'number' &&
    typeof p.flags === 'number' &&
    Array.isArray(p.centre) &&
    p.centre.length === 3 &&
    p.centre.every((n) => typeof n === 'number') &&
    typeof p.yawDeg === 'number' &&
    typeof p.tiltDeg === 'number'
  );
}
