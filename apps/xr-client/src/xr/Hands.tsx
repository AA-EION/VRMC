import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  Group,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { HAND_JOINTS, JOINTS_PER_HAND, type HandSkeleton } from './HandSkeleton.js';

/**
 * The hands, drawn.
 *
 * The mesh is `generic-hand` from the WebXR Input Profiles assets — the
 * reference hand every runtime is measured against, whose skeleton is the one
 * the standard names. It is the same file three's own `XRHandMeshModel` fetches
 * from jsdelivr; it is served from this origin instead, because nothing here
 * should be downloaded from a third party mid-session over the same Wi-Fi link
 * that is carrying the MIDI, and because the packaged path draws a hand at the
 * origin until the file lands. See public/xr/CREDITS.txt.
 *
 * The pose comes from `HandSkeleton`, not from three's hand controllers: see
 * the note there for why the official factory's fifty `getJointPose` calls a
 * frame are not affordable next to a poke detector.
 *
 * WHY THIS IS THE FULL-VR ROOM'S FEATURE
 * In passthrough the hands are already there — they are your own, seen through
 * the cameras, at zero cost and with perfect tracking. Drawing a model over
 * them would be drawing a worse copy of something already correct. In the
 * galaxy there is nothing to see, and a pad struck by an invisible finger is a
 * pad you have to aim at from memory.
 */

const FILE: Record<XRHandedness, string> = {
  left: '/xr/hand-left.glb',
  right: '/xr/hand-right.glb',
  none: '/xr/hand-left.glb',
};

/** One promise per file, so two mounts of the same hand share one fetch. */
const cache = new Map<string, Promise<Object3D>>();

function loadHand(url: string): Promise<Object3D> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  const job = new Promise<Object3D>((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => {
        const root = gltf.scene.children[0];
        if (root === undefined) reject(new Error(`${url} has no armature`));
        else resolve(root);
      },
      undefined,
      reject,
    );
  });
  cache.set(url, job);
  return job;
}

/**
 * Fetch both hands before anybody asks for them.
 *
 * Called when the session starts rather than when the room is entered: a hand
 * that arrives three frames after you first look for it is a hand you noticed
 * arriving, and the two files are 92 kB each.
 */
export function preloadHands(): void {
  void loadHand(FILE.left).catch(() => {});
  void loadHand(FILE.right).catch(() => {});
}

export interface HandsProps {
  skeleton: HandSkeleton;
  /** Whether to draw them at all. */
  visible: boolean;
  /** Surface colour, so the hands sit in the room's own palette. */
  colour: string;
  /**
   * Draw depth only, writing no colour.
   *
   * This is what makes a hand read correctly against passthrough — see
   * `Occlusion.tsx`. The same rig serves both, because a silhouette that is not
   * exactly the shape of the drawn hand is a silhouette that shows a seam.
   */
  depthOnly?: boolean;
  renderOrder?: number;
}

export function Hands({
  skeleton,
  visible,
  colour,
  depthOnly = false,
  renderOrder = 0,
}: HandsProps): React.ReactElement {
  return (
    <group>
      <HandModel
        skeleton={skeleton}
        slot={0}
        visible={visible}
        colour={colour}
        depthOnly={depthOnly}
        renderOrder={renderOrder}
      />
      <HandModel
        skeleton={skeleton}
        slot={1}
        visible={visible}
        colour={colour}
        depthOnly={depthOnly}
        renderOrder={renderOrder}
      />
    </group>
  );
}

/**
 * One hand.
 *
 * Mounted by *slot* rather than by handedness, and reloaded when the hand in
 * that slot changes sides. Slots are how `HandSkeleton` lays its buffer out,
 * and a component keyed on handedness would unmount and rebuild the whole rig
 * whenever a runtime reordered its input sources — which they do, on every
 * `inputsourceschange`.
 */
function HandModel({
  skeleton,
  slot,
  visible,
  colour,
  depthOnly,
  renderOrder,
}: {
  skeleton: HandSkeleton;
  slot: number;
  visible: boolean;
  colour: string;
  depthOnly: boolean;
  renderOrder: number;
}): React.ReactElement {
  const group = useRef<Group>(null);
  const [handedness, setHandedness] = useState<XRHandedness | null>(null);
  const [bones, setBones] = useState<Array<Object3D | undefined> | null>(null);
  const rig = useRef<Object3D | null>(null);

  const material = useMemo(() => {
    const m = new MeshStandardMaterial({
      color: new Color(colour),
      roughness: 0.85,
      metalness: 0,
      // A hand at arm's length wants a silhouette more than it wants shading;
      // the little that is left separates a finger from the palm behind it.
      flatShading: false,
    });
    if (depthOnly) {
      // Writes depth and no colour. Passthrough shows through the hole this
      // punches, so what you see there is your own hand rather than a model of
      // it, correctly hiding whatever is behind it.
      m.colorWrite = false;
    }
    return m;
  }, [colour, depthOnly]);

  useEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    material.color.set(colour);
  }, [material, colour]);

  /* Which hand is in this slot. Read from the binding rather than assumed:
     nothing guarantees the left hand is the first input source, and a left mesh
     bound to right-hand joints is a hand turned inside out. */
  useFrame(() => {
    const binding = skeleton.hands[slot];
    const next = binding?.handedness ?? null;
    if (next !== handedness) setHandedness(next);
  });

  useEffect(() => {
    if (handedness === null) {
      setBones(null);
      rig.current = null;
      return;
    }
    let live = true;
    void loadHand(FILE[handedness])
      .then((template) => {
        if (!live) return;
        /*
         * SkeletonUtils.clone, not Object3D.clone. A plain clone copies the
         * bones and then leaves the skeleton pointing at the originals, so both
         * hands would share one pose — which looks like the left hand mirroring
         * the right and is maddening to diagnose.
         */
        const root = cloneSkinned(template);
        root.traverse((o) => {
          const mesh = o as SkinnedMesh;
          if (mesh.isSkinnedMesh !== true) return;
          mesh.material = material as Material;
          // Bound to a skeleton the CPU never re-measures, and always within
          // arm's reach: culling it can only ever be wrong.
          mesh.frustumCulled = false;
          mesh.renderOrder = renderOrder;
        });
        rig.current = root;
        const group3 = group.current;
        if (group3 !== null) group3.add(root);
        setBones(HAND_JOINTS.map((name) => root.getObjectByName(name)));
      })
      .catch(() => {
        // A hand that will not load is a hand that is not drawn. The
        // instrument is unaffected — the fingertip path never touches this.
        if (live) setBones(null);
      });
    return () => {
      live = false;
      const root = rig.current;
      if (root !== null) root.removeFromParent();
      rig.current = null;
    };
  }, [handedness, material, renderOrder]);

  useFrame(() => {
    const root = rig.current;
    const binding = skeleton.hands[slot];
    if (root === null || bones === null) return;

    if (!visible || binding === undefined || !binding.tracked) {
      // Nothing is drawn until the runtime has actually reported a pose. Without
      // this the hand is a knot at the origin for its first frames, which is the
      // exact failure the packaged model has.
      root.visible = false;
      return;
    }
    root.visible = true;

    for (let j = 0; j < JOINTS_PER_HAND; j++) {
      const bone = bones[j];
      if (bone === undefined) continue;
      /*
       * The file's bones are flat siblings under the armature and the runtime's
       * joints are flat siblings under the reference space — the same frame —
       * so a joint's matrix is the bone's local matrix with no conversion at
       * all. `fromArray` copies into the bone's own elements, so this is 16
       * float writes and no allocation.
       */
      bone.matrix.fromArray(skeleton.matrices, binding.offset + j * 16);
      bone.matrixAutoUpdate = false;
      bone.matrixWorldNeedsUpdate = true;
    }
    // Composed once for the whole rig rather than left to the renderer's own
    // pass, so the skinning sees this frame's pose and not the last one's.
    root.updateMatrixWorld(true);
  });

  return <group ref={group} />;
}
