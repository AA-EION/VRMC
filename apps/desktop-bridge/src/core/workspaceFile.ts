// SPDX-License-Identifier: GPL-3.0-only

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDataDir } from '../setup/paths.js';
import { Workspace } from './Workspace.js';

/**
 * The workspace, on disk.
 *
 * Layouts are the one piece of state whose whole value is that it survives —
 * an arrangement you have to rebuild each morning is not an arrangement, it is
 * a chore — so it outlives the process as well as the session.
 */
const FILE = 'workspace.json';

export function workspacePath(): string {
  return join(ensureDataDir(), FILE);
}

/** Read the stored workspace, or an empty one. */
export function loadWorkspace(path = workspacePath()): Workspace {
  try {
    return Workspace.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Missing, unreadable, or not JSON. An empty workspace is the right answer
    // to all three: the alternative is refusing to start over a file whose only
    // job is to remember where somebody likes their Launchpad.
    return new Workspace();
  }
}

/**
 * Write it back, atomically.
 *
 * Written to a sibling and renamed, because rename is atomic within a
 * filesystem and a plain write is not. Without this a power cut during the
 * write leaves a truncated file — and the truncation lands in the middle of the
 * one thing the user would most notice losing. `Workspace.fromJSON` revalidates
 * everything on the way back in anyway, but a file that never becomes half a
 * file is better than one that is repaired.
 */
export function saveWorkspace(workspace: Workspace, path = workspacePath()): boolean {
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(workspace.toJSON()), 'utf8');
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}
