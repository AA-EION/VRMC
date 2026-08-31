/**
 * Type declarations for the WebXR bulk pose API.
 *
 * `XRFrame.fillPoses` and `fillJointRadii` are part of the WebXR Hand Input
 * specification and are implemented in Meta Quest Browser, but TypeScript's DOM
 * library does not declare them yet. They are the allocation-free way to read
 * joint poses — see `handTracking.ts` for why that matters here — so rather
 * than casting at each call site, the interface is augmented once.
 *
 * Both are declared optional: the code probes for them at runtime and falls
 * back to `getJointPose` where they are missing, and the types should say so.
 */
declare global {
  interface XRFrame {
    /**
     * Write the transforms of `spaces`, relative to `baseSpace`, into
     * `transforms` as consecutive column-major 4x4 matrices.
     *
     * Returns false if any pose was unavailable, in which case the buffer's
     * contents are unspecified and must not be read.
     */
    fillPoses?(
      spaces: Iterable<XRSpace>,
      baseSpace: XRSpace,
      transforms: Float32Array,
    ): boolean;

    /** Write the radius of each joint space into `radii`. */
    fillJointRadii?(jointSpaces: Iterable<XRJointSpace>, radii: Float32Array): boolean;
  }
}

export {};
