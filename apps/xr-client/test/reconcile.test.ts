// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { devicesMissingFromRoster } from "../src/devices/reconcile.js";

/**
 * Noticing that the bridge has forgotten a device.
 *
 * This decides whether a headset coming back from a long disconnect keeps
 * working. The bridge drops its devices when it closes its ports, and the
 * roster it then sends mentions none of them; a device the headset keeps
 * drawing but the bridge does not know about is one that plays nothing and
 * says nothing about why.
 */
const lpx = { deviceId: 21, model: "launchpad-x" };
const pro = { deviceId: 22, model: "launchpad-pro-mk3" };

describe("devices the bridge no longer knows about", () => {
  it("finds nothing when the roster still has them all", () => {
    expect(
      devicesMissingFromRoster(
        [lpx, pro],
        [{ deviceId: 21 }, { deviceId: 22 }],
      ),
    ).toEqual([]);
  });

  it("finds every device after the bridge closed its ports", () => {
    // The case that matters: grace period expired, bridge emptied, headset
    // reconnects to a roster with nothing in it.
    expect(devicesMissingFromRoster([lpx, pro], [])).toEqual([lpx, pro]);
  });

  it("finds only the ones actually missing", () => {
    expect(devicesMissingFromRoster([lpx, pro], [{ deviceId: 21 }])).toEqual([
      pro,
    ]);
  });

  it("carries the model, because that is what the bridge needs to rebuild it", () => {
    // Re-asking with the wrong model would open a port for the wrong hardware:
    // a Pro MK3's control layout answering on a Launchpad X's ports.
    const [missing] = devicesMissingFromRoster([pro], []);
    expect(missing?.model).toBe("launchpad-pro-mk3");
  });

  it("keeps spawn order, so the bridge rebuilds them in the same order", () => {
    expect(
      devicesMissingFromRoster([pro, lpx], []).map((d) => d.deviceId),
    ).toEqual([22, 21]);
  });

  it("asks for nothing when the headset holds nothing", () => {
    // The ordinary first connection: the roster may carry a bridge-side device
    // this headset has never seen, and that is adoption's job, not this one's.
    expect(devicesMissingFromRoster([], [{ deviceId: 21 }])).toEqual([]);
  });
});
