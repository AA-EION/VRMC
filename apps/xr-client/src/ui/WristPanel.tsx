import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group } from 'three';
import { InstrumentSurface } from '../devices/InstrumentSurface.js';
import { buildTextTexture } from '../devices/labels.js';
import { READOUT_HEIGHT } from './WristMenuLayout.js';
import { WRIST_THEME, type WristMenu } from './WristMenu.js';
import { INK } from '../brand/tokens.js';

/**
 * Drawing the wrist console.
 *
 * The panel is the same `InstrumentSurface` every playable surface uses, at
 * wrist scale — so its rows light on contact and fade on release exactly as a
 * pad does, with none of that written twice.
 *
 * Position and orientation are written straight onto the group in the frame
 * loop rather than through React. The console rides somebody's forearm, so its
 * pose changes every frame; routing that through component state would put a
 * render on the same frame as note dispatch.
 */

/**
 * The console's node name.
 *
 * Named so the scene can be surveyed by intent: the render test counts the
 * *instruments'* meshes, and a console mounted whether or not it is showing
 * would otherwise be counted among them.
 */
export const WRIST_CONSOLE_NAME = 'wrist-console';

export interface WristPanelProps {
  menu: WristMenu;
  /** Rebuilt when the labels change, which is at human speed. */
  labels: readonly string[];
  readout: string;
}

export function WristPanel({ menu, labels, readout }: WristPanelProps): React.ReactElement {
  const group = useRef<Group>(null);

  const readoutTexture = useMemo(
    () => buildTextTexture(readout, { ink: INK.bone, ground: 'rgba(11, 11, 12, 0.9)' }),
    [readout],
  );
  useEffect(() => () => readoutTexture?.dispose(), [readoutTexture]);

  useFrame(() => {
    const node = group.current;
    if (node === null) return;
    // Hidden below the facing threshold, and hidden means not drawn *and* not
    // raycast — though nothing here is raycast, the detector is gated in the
    // menu itself, which is the stronger guarantee. See WristMenu.
    node.visible = menu.facing > 0 && menu.worn;
    if (!node.visible) return;

    /*
     * The *surface* transform, not the wrist's own frame — its bottom-left
     * corner, which is where every surface in this app puts its local origin
     * and what the poke detector inverts. Drawing from the centre while the
     * detector inverts the corner is half a panel of disagreement, and it does
     * not look broken: the rows simply answer somewhere other than where they
     * are drawn.
     */
    const pose = menu.surface;
    node.position.set(pose[0]!, pose[1]!, pose[2]!);
    node.quaternion.set(pose[3]!, pose[4]!, pose[5]!, pose[6]!);
    // The console arrives as a fade rather than appearing: a control that pops
    // into being is one that was not there when you started reaching for it.
    node.scale.setScalar(0.92 + 0.08 * menu.facing);
  });

  const layout = menu.layout;

  return (
    <group ref={group} name={WRIST_CONSOLE_NAME} visible={false}>
      {/* The group is already at the surface's own origin — see the frame
          loop above — so the rows are drawn from it directly. */}
      <group>
        <InstrumentSurface
          locator={layout}
          theme={WRIST_THEME}
          highlighter={menu.highlighter}
          position={[0, 0, 0]}
          quaternion={[0, 0, 0, 1]}
          showLabels
        />

        {readoutTexture !== null && (
          <mesh
            position={[layout.width / 2, layout.height - READOUT_HEIGHT / 2, 0.006]}
            renderOrder={1}
          >
            <planeGeometry args={[layout.width, READOUT_HEIGHT * 0.8]} />
            <meshBasicMaterial map={readoutTexture} transparent depthWrite={false} />
          </mesh>
        )}
      </group>
      {/* Labels are drawn by InstrumentSurface from the layout's zone labels,
          which are the item labels — so a row that changes what it says changes
          what it draws with no second path. */}
      <group visible={labels.length > 0} />
    </group>
  );
}
