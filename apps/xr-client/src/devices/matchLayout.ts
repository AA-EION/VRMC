import type { DevicePlacement, Layout } from '@vrmc/protocol';

/** Anything a saved entry can be matched against. */
export interface MatchableDevice {
  deviceId: number;
  model: string;
}

export interface LayoutMatch<T extends MatchableDevice> {
  device: T;
  placement: DevicePlacement;
}

/**
 * Work out which live device each saved entry refers to.
 *
 * A saved entry carries a device id *and* a model, and the second one is what
 * makes an arrangement mean anything a week later. Ids are handed out per
 * session and are not stable across a restart of the bridge, so matching on id
 * alone would put a Launchpad Pro where a Launchpad X had been the first time
 * anybody restarted anything.
 *
 * So it is two passes:
 *
 *   1. Exact id *and* model. Unambiguous, and the common case — nothing has
 *      restarted, so the roster is the one the layout was saved from.
 *   2. Whatever is left, by model, in order. This is what survives a restart,
 *      and taking them in order means two Launchpad X's keep their left-right
 *      relationship rather than swapping arbitrarily.
 *
 * An entry with no match is dropped: the device it named is not here, and
 * there is nothing sensible to do with a pose for it. A device with no entry
 * is left exactly where it is, rather than being moved somewhere neutral — the
 * arrangement said nothing about it, which is not the same as saying it should
 * move.
 */
export function matchLayout<T extends MatchableDevice>(
  entries: readonly Layout['entries'][number][],
  devices: readonly T[],
): Array<LayoutMatch<T>> {
  const out: Array<LayoutMatch<T>> = [];
  const taken = new Set<number>();

  const pending: Array<Layout['entries'][number]> = [];
  for (const entry of entries) {
    const exact = devices.find(
      (d) =>
        !taken.has(d.deviceId) &&
        d.deviceId === entry.placement.deviceId &&
        d.model === entry.model,
    );
    if (exact === undefined) {
      pending.push(entry);
      continue;
    }
    taken.add(exact.deviceId);
    out.push({ device: exact, placement: entry.placement });
  }

  for (const entry of pending) {
    const byModel = devices.find((d) => !taken.has(d.deviceId) && d.model === entry.model);
    if (byModel === undefined) continue;
    taken.add(byModel.deviceId);
    out.push({ device: byModel, placement: entry.placement });
  }

  return out;
}
