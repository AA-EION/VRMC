/**
 * Fingertip input buffer.
 *
 * The XR client fills this once per frame from `XRFrame.getJointPose()` and
 * hands the same instance to every surface. Positions live in one flat
 * Float32Array rather than an array of vector objects: it is written once per
 * frame by the hand-tracking code and read ten times per surface, and keeping
 * it as raw floats means no property lookups and no garbage.
 */

/** Both hands, five fingertips each. */
export const MAX_FINGERS = 10;

/** Index of a fingertip within the buffer. Left hand first, thumb to pinky. */
export const Finger = {
  LEFT_THUMB: 0,
  LEFT_INDEX: 1,
  LEFT_MIDDLE: 2,
  LEFT_RING: 3,
  LEFT_PINKY: 4,
  RIGHT_THUMB: 5,
  RIGHT_INDEX: 6,
  RIGHT_MIDDLE: 7,
  RIGHT_RING: 8,
  RIGHT_PINKY: 9,
} as const;

export class FingerFrame {
  /** World-space xyz per fingertip, packed as [x0,y0,z0, x1,y1,z1, ...]. */
  readonly position = new Float32Array(MAX_FINGERS * 3);
  /** 1 when the runtime reported a pose for this fingertip this frame. */
  readonly tracked = new Uint8Array(MAX_FINGERS);
  /** Joint radius in metres, used to offset the contact point to the skin. */
  readonly radius = new Float32Array(MAX_FINGERS);
  /** Seconds since the previous frame. */
  dt = 0;
  /** Frame timestamp in ms, on the same clock the packet writer stamps with. */
  timestamp = 0;

  constructor() {
    this.radius.fill(0.008);
  }

  /** Clear tracking flags. Call at the top of each frame before filling. */
  beginFrame(timestamp: number, dt: number): void {
    this.timestamp = timestamp;
    this.dt = dt;
    this.tracked.fill(0);
  }

  setFinger(i: number, x: number, y: number, z: number, radius: number): void {
    const o = i * 3;
    this.position[o] = x;
    this.position[o + 1] = y;
    this.position[o + 2] = z;
    this.radius[i] = radius;
    this.tracked[i] = 1;
  }
}
