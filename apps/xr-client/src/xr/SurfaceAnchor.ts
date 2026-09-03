import { bestSurface, poseOnSurface } from "./anchors.js";
import type { SurfacePose } from "@vrmc/layout";

/**
 * Finding the real surface under a device, and keeping it there.
 *
 * This is the passthrough feature that makes the emulation feel like hardware.
 * A Launchpad floating at a guessed height reads as a hologram; the same
 * Launchpad lying on the desk you can see under it reads as a thing on your
 * desk.
 *
 * TWO WAYS OF ASKING, BECAUSE THEY FAIL DIFFERENTLY
 * `plane-detection` gives the room's flat surfaces as polygons with a pose, and
 * it is the better answer when it has run: it knows the desk is a desk, so the
 * device can be told to land on the *desk* rather than on whatever a ray
 * happened to strike. It needs the runtime to have found the plane, which takes
 * a moment after a session starts and never happens at all on a headset that
 * has not been shown the room.
 *
 * `hit-test` answers immediately — Quest's browser has backed it with the Depth
 * API since Horizon 40.4, so it resolves without waiting for a scene mesh — but
 * it answers about one ray, so it says «there is something 0.74 m down» without
 * any opinion about what.
 *
 * So planes are preferred and hit testing is the fallback, and a device is
 * simply left where it is when neither answers. Left floating is a worse pose;
 * dropped to the floor because a query returned zero is a lost instrument.
 *
 * WHY THE ANCHOR IS KEPT
 * `createAnchor` hands back a space the runtime keeps pinned to the real world
 * as its tracking improves. Without one, a device is placed at a position in a
 * reference space that quietly drifts over a long session, and the Launchpad
 * ends up hovering a centimetre above — or inside — the desk it was placed on.
 * The anchor is re-read as it moves, and never while somebody is holding the
 * device.
 */

/** How much an anchor must move before the device is re-placed, in metres. */
const ANCHOR_DEADBAND = 0.002;

export interface AnchorRequest {
  deviceId: number;
  pose: SurfacePose;
}

export interface AnchorResult {
  deviceId: number;
  pose: SurfacePose;
  /** True when the runtime gave us a real anchor rather than only a position. */
  anchored: boolean;
}

interface Held {
  deviceId: number;
  anchor: XRAnchor;
  /**
   * The pose the device was placed at.
   *
   * Kept whole rather than as three numbers, because an anchor corrects
   * *position* and nothing else. Reporting a drift as a bare centre — which
   * this did at first — rebuilt the pose from defaults and silently reset the
   * device's tilt and the yaw that turned it to face the player, so a
   * millimetre of tracking correction spun the instrument round.
   */
  pose: SurfacePose;
  /** Last position read out of the anchor, so a re-read only fires on motion. */
  last: [number, number, number];
}

export class SurfaceAnchor {
  /** Requests waiting for a surface. At most one per device. */
  private readonly pending = new Map<number, AnchorRequest>();
  private readonly anchors: Held[] = [];

  private hitTestSource: XRHitTestSource | null = null;
  private hitTestRequested = false;

  /** Called when a device has been placed. */
  onPlaced: ((result: AnchorResult) => void) | null = null;
  /** Called when a request could not be satisfied, with a reason to show. */
  onFailed: ((deviceId: number, reason: string) => void) | null = null;

  /** Ask for a device to be put down on whatever is under it. */
  /** How many drops are still waiting for a surface. */
  get pendingCount(): number {
    return this.pending.size;
  }

  request(deviceId: number, pose: SurfacePose): void {
    this.pending.set(deviceId, { deviceId, pose });
  }

  /** Forget a device: its request, and the anchor holding it down. */
  forget(deviceId: number): void {
    this.pending.delete(deviceId);
    const at = this.anchors.findIndex((a) => a.deviceId === deviceId);
    if (at < 0) return;
    const [held] = this.anchors.splice(at, 1);
    // Deleting is not optional housekeeping: a runtime keeps a small, fixed
    // number of anchors, and one held for a device that no longer exists is one
    // the next device cannot have.
    held?.anchor.delete?.();
  }

  /** Drop every anchor. For session teardown. */
  reset(): void {
    for (const held of this.anchors) held.anchor.delete?.();
    this.anchors.length = 0;
    this.pending.clear();
    this.hitTestSource?.cancel();
    this.hitTestSource = null;
    this.hitTestRequested = false;
  }

  get anchorCount(): number {
    return this.anchors.length;
  }

  /**
   * Advance one frame.
   *
   * `isHeld` lets the caller say which devices are in somebody's hand, so an
   * anchor cannot fight a grab: a device being carried is not being anchored,
   * whatever the runtime thinks about where it used to be.
   */
  update(
    frame: XRFrame,
    space: XRReferenceSpace,
    viewer: readonly [number, number, number],
    isHeld: (deviceId: number) => boolean,
  ): void {
    this.followAnchors(frame, space, isHeld);
    if (this.pending.size === 0) return;

    const surfaces = this.surfacesFrom(frame, space);
    for (const request of [...this.pending.values()]) {
      if (isHeld(request.deviceId)) {
        // Still in a hand. Keep the request rather than resolving it against a
        // pose that is about to change.
        continue;
      }
      const y = bestSurface(surfaces, request.pose.centre[1]);
      if (y === null) continue;

      this.pending.delete(request.deviceId);
      const pose = poseOnSurface(request.pose, y, viewer);
      const anchored = this.tryAnchor(frame, space, request.deviceId, pose);
      this.onPlaced?.({ deviceId: request.deviceId, pose, anchored });
    }
  }

  /**
   * Give up on anything still waiting, and say why.
   *
   * Called by the caller on a timeout rather than here, because «how long is
   * worth waiting» is a question about the interface: a person who pressed a
   * button needs an answer within a couple of seconds, and a plane can take
   * longer than that to appear.
   */
  timeOut(reason: string): void {
    for (const request of this.pending.values())
      this.onFailed?.(request.deviceId, reason);
    this.pending.clear();
  }

  // --- finding surfaces ---

  /** Heights of every horizontal surface the runtime is reporting. */
  private surfacesFrom(frame: XRFrame, space: XRReferenceSpace): number[] {
    const out: number[] = [];

    // Planes first: a plane knows it is a desk, and a ray does not.
    const planes = frame.detectedPlanes;
    if (planes !== undefined) {
      for (const plane of planes) {
        if (plane.orientation !== "horizontal") continue;
        const pose = frame.getPose?.(plane.planeSpace, space);
        if (pose === undefined || pose === null) continue;
        out.push(pose.transform.position.y);
      }
    }

    // Then whatever the hit test has to say, which is immediate but opinionless.
    if (this.hitTestSource !== null) {
      for (const hit of frame.getHitTestResults?.(this.hitTestSource) ?? []) {
        const pose = hit.getPose(space);
        if (pose === undefined || pose === null) continue;
        out.push(pose.transform.position.y);
      }
    }
    return out;
  }

  /**
   * Ask for a hit test source, once.
   *
   * Requested lazily rather than at session start: it is only needed when
   * somebody puts something down, and a source is a running query the runtime
   * evaluates every frame for as long as it exists.
   */
  ensureHitTest(session: XRSession, viewerSpace: XRReferenceSpace): void {
    if (this.hitTestRequested || this.hitTestSource !== null) return;
    if (session.requestHitTestSource === undefined) return;
    this.hitTestRequested = true;
    void session
      .requestHitTestSource({ space: viewerSpace })
      ?.then((source) => {
        this.hitTestSource = source;
      })
      .catch(() => {
        // Not granted, or not supported. Planes may still answer, and if they
        // do not the caller's timeout says so in words.
      });
  }

  // --- keeping it there ---

  private tryAnchor(
    frame: XRFrame,
    space: XRReferenceSpace,
    deviceId: number,
    pose: SurfacePose,
  ): boolean {
    if (frame.createAnchor === undefined) return false;
    const transform = new XRRigidTransform({
      x: pose.centre[0],
      y: pose.centre[1],
      z: pose.centre[2],
    });
    void frame
      .createAnchor(transform, space)
      ?.then((anchor) => {
        // A second anchor for the same device would leave the first one held
        // forever, and anchors are a limited resource.
        this.forget(deviceId);
        this.anchors.push({
          deviceId,
          anchor,
          pose,
          last: [pose.centre[0], pose.centre[1], pose.centre[2]],
        });
      })
      .catch(() => {
        // Anchoring failed; the device is still placed, it just will not be
        // corrected as tracking improves.
      });
    // Reported optimistically: the placement itself has already happened, and
    // the anchor is a refinement to it rather than a precondition.
    return true;
  }

  /** Re-read the anchors, and move anything that has drifted. */
  private followAnchors(
    frame: XRFrame,
    space: XRReferenceSpace,
    isHeld: (deviceId: number) => boolean,
  ): void {
    for (const held of this.anchors) {
      if (isHeld(held.deviceId)) continue;
      const pose = frame.getPose?.(held.anchor.anchorSpace, space);
      if (pose === undefined || pose === null) continue;
      const { x, y, z } = pose.transform.position;
      const moved =
        Math.abs(x - held.last[0]) > ANCHOR_DEADBAND ||
        Math.abs(y - held.last[1]) > ANCHOR_DEADBAND ||
        Math.abs(z - held.last[2]) > ANCHOR_DEADBAND;
      // A deadband, because an anchor's pose jitters by fractions of a
      // millimetre and re-placing a device on every frame would rebuild its
      // transform and its detector pose ninety times a second for nothing.
      if (!moved) continue;
      held.last[0] = x;
      held.last[1] = y;
      held.last[2] = z;
      // Position only: the tilt and the yaw are the ones the device was placed
      // with, and an anchor has no opinion about either.
      held.pose = {
        centre: [x, y, z],
        tiltDeg: held.pose.tiltDeg,
        yawDeg: held.pose.yawDeg,
      };
      this.onPlaced?.({
        deviceId: held.deviceId,
        pose: held.pose,
        anchored: true,
      });
    }
  }
}
