// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LAYOUTS, PlacementFlags, type DevicePlacement } from '@vrmc/protocol';
import { Workspace } from '../src/core/Workspace.js';
import { loadWorkspace, saveWorkspace } from '../src/core/workspaceFile.js';

function placement(deviceId: number, x = 0.4): DevicePlacement {
  return {
    deviceId,
    flags: PlacementFlags.NONE,
    centre: [x, 0.95, -0.52],
    yawDeg: 0,
    tiltDeg: 48,
  };
}

describe('Workspace placements', () => {
  it('remembers where a device was put', () => {
    const w = new Workspace();
    expect(w.place(placement(16))).toBe(true);
    expect(w.placementOf(16)?.centre[0]).toBeCloseTo(0.4);
  });

  it('answers null for a device nobody has placed', () => {
    /*
     * A real answer rather than a missing one. The headset puts a never-placed
     * device at its default pose; if this returned a zeroed placement instead,
     * every fresh device would land at the player's feet.
     */
    expect(new Workspace().placementOf(16)).toBeNull();
  });

  it('refuses numbers no room can contain', () => {
    /*
     * Not a guard against a hostile sender — the bridge is on the same desk.
     * It is a guard against a NaN persisting to disk, restoring on the next
     * connection, and putting a Launchpad somewhere it can never be reached
     * from, which needs the file deleted by hand to undo.
     */
    const w = new Workspace();
    expect(w.place({ ...placement(16), centre: [NaN, 0, 0] })).toBe(false);
    expect(w.place({ ...placement(16), centre: [0, 4000, 0] })).toBe(false);
    expect(w.placementOf(16)).toBeNull();
  });

  it('tells its owner when anything changed', () => {
    const w = new Workspace();
    let changes = 0;
    w.onChange = () => changes++;
    w.place(placement(16));
    w.place({ ...placement(16), centre: [NaN, 0, 0] });
    expect(changes).toBe(1);
  });
});

describe('Workspace layouts', () => {
  const studio = {
    name: 'Studio',
    entries: [
      { placement: placement(16), model: 'launchpad-x' },
      { placement: placement(17, -0.4), model: 'launchpad-pro-mk3' },
    ],
  };

  it('stores and hands back an arrangement', () => {
    const w = new Workspace();
    expect(w.save(studio).ok).toBe(true);
    expect(w.state().layouts).toHaveLength(1);
    expect(w.state().current).toBe('Studio');
  });

  it('replaces a layout of the same name rather than refusing', () => {
    // «Save» on an existing name is somebody updating their studio, not a
    // mistake — and a save that quietly does nothing is the worst answer.
    const w = new Workspace();
    w.save(studio);
    w.save({ name: 'Studio', entries: [{ placement: placement(16, 1.2), model: 'launchpad-x' }] });
    expect(w.state().layouts).toHaveLength(1);
    expect(w.state().layouts[0]!.entries).toHaveLength(1);
  });

  it('refuses a nameless layout', () => {
    expect(new Workspace().save({ name: '   ', entries: [] }).ok).toBe(false);
  });

  it('stops at the ceiling with a reason rather than truncating a packet', () => {
    const w = new Workspace();
    for (let i = 0; i < MAX_LAYOUTS; i++) {
      expect(w.save({ name: `L${i}`, entries: [] }).ok).toBe(true);
    }
    const over = w.save({ name: 'one too many', entries: [] });
    expect(over.ok).toBe(false);
    expect(over.reason).toContain(String(MAX_LAYOUTS));
    // …and an existing name still saves, because that replaces rather than adds.
    expect(w.save({ name: 'L0', entries: [] }).ok).toBe(true);
  });

  it('drops entries whose placement is nonsense, keeping the rest', () => {
    const w = new Workspace();
    w.save({
      name: 'Mixed',
      entries: [
        { placement: placement(16), model: 'launchpad-x' },
        { placement: { ...placement(17), yawDeg: NaN }, model: 'launchpad-x' },
      ],
    });
    expect(w.state().layouts[0]!.entries).toHaveLength(1);
  });

  it('moves the devices when an arrangement is applied', () => {
    /*
     * Applying is a statement about where everything now is. Without this the
     * next reconnect would restore the layout's devices and hand back a roster
     * still describing wherever they were before it was applied.
     */
    const w = new Workspace();
    w.place(placement(16, 0));
    w.save(studio);
    w.place(placement(16, 9));
    expect(w.apply('Studio')).not.toBeNull();
    expect(w.placementOf(16)?.centre[0]).toBeCloseTo(0.4);
  });

  it('returns null for an arrangement that is not there', () => {
    expect(new Workspace().apply('Couch')).toBeNull();
  });

  it('clears «current» when the current layout is deleted', () => {
    const w = new Workspace();
    w.save(studio);
    expect(w.delete('Studio')).toBe(true);
    expect(w.state().current).toBe('');
    expect(w.delete('Studio')).toBe(false);
  });

  it('matches a stored name however it was typed', () => {
    const w = new Workspace();
    w.save({ name: '  Studio   B ', entries: [] });
    expect(w.apply('Studio B')).not.toBeNull();
  });
});

describe('the workspace file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vrmc-workspace-'));
    path = join(dir, 'workspace.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('survives a round trip to disk', () => {
    const w = new Workspace();
    w.place(placement(16));
    w.save({ name: 'Studio', entries: [{ placement: placement(17), model: 'launchpad-x' }] });
    expect(saveWorkspace(w, path)).toBe(true);

    const back = loadWorkspace(path);
    expect(back.placementOf(16)?.centre[0]).toBeCloseTo(0.4);
    expect(back.state().layouts).toHaveLength(1);
    expect(back.state().current).toBe('Studio');
  });

  it('starts empty rather than refusing to run on a corrupt file', () => {
    // The alternative is a bridge that will not start because of a file whose
    // only job is to remember where somebody likes their Launchpad.
    writeFileSync(path, '{ this is not json', 'utf8');
    expect(loadWorkspace(path).layoutCount).toBe(0);
  });

  it('starts empty when there is no file at all', () => {
    expect(loadWorkspace(join(dir, 'absent.json')).layoutCount).toBe(0);
  });

  it('revalidates everything on the way back in', () => {
    /*
     * A file can be hand-edited, or truncated by a power cut mid-write. Numbers
     * coming off disk have to earn their way back in exactly as if they had
     * arrived over the wire.
     */
    writeFileSync(
      path,
      JSON.stringify({
        placements: [
          { deviceId: 16, flags: 0, centre: [0.4, 0.9, -0.5], yawDeg: 0, tiltDeg: 48 },
          { deviceId: 17, flags: 0, centre: [0, 99999, 0], yawDeg: 0, tiltDeg: 48 },
          { deviceId: 18, nonsense: true },
        ],
        layouts: [{ name: 'Studio', entries: [{ model: 'launchpad-x', placement: null }] }],
        current: 'Nowhere',
      }),
      'utf8',
    );
    const w = loadWorkspace(path);
    expect(w.placementOf(16)).not.toBeNull();
    expect(w.placementOf(17)).toBeNull();
    expect(w.placementOf(18)).toBeNull();
    expect(w.state().layouts[0]!.entries).toHaveLength(0);
    // «current» named a layout that does exist, but the entry was dropped; a
    // current that named nothing at all must not be restored.
    expect(w.state().current).toBe('');
  });

  it('never leaves half a file behind', () => {
    // Written to a sibling and renamed. Rename is atomic within a filesystem;
    // a plain write is not, and the truncation would land in the middle of the
    // one thing a user would most notice losing.
    const w = new Workspace();
    w.save({ name: 'Studio', entries: [] });
    saveWorkspace(w, path);
    saveWorkspace(w, path);
    expect(loadWorkspace(path).layoutCount).toBe(1);
  });
});
