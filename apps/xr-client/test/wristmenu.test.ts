import { describe, it, expect } from 'vitest';
import { Finger, FingerFrame } from '@vrmc/interaction';
import { HAND_JOINTS, HandSkeleton, JOINTS_PER_HAND } from '../src/xr/HandSkeleton.js';
import { WristMenu, type WristItem } from '../src/ui/WristMenu.js';
import { WRIST_LIFT } from '../src/xr/wrist.js';

/**
 * The console, and the one thing it must never do.
 *
 * A hand playing a pad grid is a hand making rapid deliberate stabs at a
 * surface — and the console lives on that same hand. Everything here is about
 * the gate that keeps the two apart.
 */

const jointIndex = (name: (typeof HAND_JOINTS)[number]): number => HAND_JOINTS.indexOf(name);

/**
 * A skeleton with one left hand, palm down, fingers along +X.
 *
 * Fingers along +X and up along +Y makes +Z the third right-handed axis, so a
 * left hand held palm-down with fingers along +X has its index metacarpal on
 * the +Z side and its pinky on -Z, and the back of the hand points at +Y.
 */
function palmDownLeft(wristAt: readonly [number, number, number] = [0, 1, 0]): HandSkeleton {
  const skeleton = new HandSkeleton();
  const session = {
    inputSources: [
      {
        handedness: 'left',
        hand: new Map(HAND_JOINTS.map((name) => [name, { name }])),
      },
    ],
  } as unknown as XRSession;
  skeleton.syncInputSources(session);

  const points: Record<string, readonly [number, number, number]> = {
    wrist: wristAt,
    'middle-finger-metacarpal': [wristAt[0] + 0.08, wristAt[1], wristAt[2]],
    'index-finger-metacarpal': [wristAt[0] + 0.07, wristAt[1], wristAt[2] + 0.02],
    'pinky-finger-metacarpal': [wristAt[0] + 0.07, wristAt[1], wristAt[2] - 0.02],
  };

  const frame = {
    fillPoses(spaces: Iterable<{ name: string }>, _base: unknown, out: Float32Array): boolean {
      let j = 0;
      for (const space of spaces) {
        const m = j * 16;
        out[m] = 1;
        out[m + 5] = 1;
        out[m + 10] = 1;
        out[m + 15] = 1;
        const at = points[space.name] ?? [0, 0, 0];
        out[m + 12] = at[0];
        out[m + 13] = at[1];
        out[m + 14] = at[2];
        j++;
      }
      return true;
    },
  } as unknown as XRFrame;

  skeleton.update(frame, {} as XRReferenceSpace);
  return skeleton;
}

function menuWith(pressed: string[]): WristMenu {
  const items: WristItem[] = ['ONE', 'TWO', 'THREE'].map((id) => ({
    id,
    label: () => id,
    run: () => pressed.push(id),
  }));
  return new WristMenu(items);
}

/** The eye, directly above a panel that faces up. */
const LOOKING: [number, number, number] = [0, 2, 0];
/** The eye, well off to the side and below — an arm hanging at a side. */
const AWAY: [number, number, number] = [3, 0.2, 0];

describe('the facing gate', () => {
  it('opens when the wrist is turned toward the eye', () => {
    const menu = menuWith([]);
    const skeleton = palmDownLeft();
    const open = menu.update(skeleton, new FingerFrame(), ...LOOKING, 1 / 90);
    expect(open).toBe(true);
    expect(menu.facing).toBeGreaterThan(0);
  });

  it('is shut with the arm at a side', () => {
    const menu = menuWith([]);
    const skeleton = palmDownLeft();
    expect(menu.update(skeleton, new FingerFrame(), ...AWAY, 1 / 90)).toBe(false);
    expect(menu.facing).toBe(0);
  });

  it('is shut when no hand is being tracked', () => {
    const menu = menuWith([]);
    const skeleton = new HandSkeleton();
    expect(menu.update(skeleton, new FingerFrame(), ...LOOKING, 1 / 90)).toBe(false);
    expect(menu.worn).toBe(false);
  });

  it('ignores a hand that is not the one it is worn on', () => {
    const menu = menuWith([]);
    menu.handedness = 'right';
    expect(menu.update(palmDownLeft(), new FingerFrame(), ...LOOKING, 1 / 90)).toBe(false);
  });
});

describe('not stealing a poke', () => {
  /**
   * Drive a fingertip straight through the console's second row.
   *
   * Positions are taken from the panel's own pose so the test cannot drift from
   * the layout: the row is found in surface-local space and rotated out.
   */
  function pokeRow(menu: WristMenu, skeleton: HandSkeleton, eye: [number, number, number]): void {
    const fingers = new FingerFrame();
    // One frame to establish the pose, whether or not the gate is open.
    menu.update(skeleton, fingers, ...eye, 1 / 90);

    const zone = menu.layout.zones[1]!;
    // Surface-local, against the panel's own origin — its bottom-left corner,
    // which is the frame both the renderer and the detector use.
    const lx = zone.rect.x + zone.rect.width / 2;
    const ly = zone.rect.y + zone.rect.height / 2;

    const pose = menu.surface;
    const rotate = (x: number, y: number, z: number): [number, number, number] => {
      const [qx, qy, qz, qw] = [pose[3]!, pose[4]!, pose[5]!, pose[6]!];
      const tx = qy * z - qz * y + qw * x;
      const ty = qz * x - qx * z + qw * y;
      const tz = qx * y - qy * x + qw * z;
      return [
        pose[0]! + x + 2 * (qy * tz - qz * ty),
        pose[1]! + y + 2 * (qz * tx - qx * tz),
        pose[2]! + z + 2 * (qx * ty - qy * tx),
      ];
    };

    let clock = 1000;
    for (let i = 0; i <= 8; i++) {
      const depth = 0.03 - (0.045 * i) / 8;
      const [x, y, z] = rotate(lx, ly, zone.raise + 0.008 + depth);
      clock += 1000 / 90;
      fingers.beginFrame(clock, 1 / 90);
      fingers.setFinger(Finger.RIGHT_INDEX, x, y, z, 0.008);
      menu.update(skeleton, fingers, ...eye, 1 / 90);
    }
  }

  it('answers a poke while it is open', () => {
    const pressed: string[] = [];
    const menu = menuWith(pressed);
    pokeRow(menu, palmDownLeft(), LOOKING);
    expect(pressed).toEqual(['TWO']);
  });

  it('answers nothing at all while it is shut', () => {
    /*
     * The property the whole design answers to. Below the facing threshold the
     * detector is not merely hidden — it is not fed, so there is nothing
     * running that could fire. A hand flat over an instrument is exactly this
     * case, and a console that answered there would send a device spawning
     * mid-phrase.
     */
    const pressed: string[] = [];
    const menu = menuWith(pressed);
    pokeRow(menu, palmDownLeft(), AWAY);
    expect(pressed).toEqual([]);
  });

  it('leaves the finger frame for the instruments to read', () => {
    /*
     * The console reads the shared frame rather than claiming from it, so a
     * fingertip that crosses its plane is still there for every other surface.
     * Instruments and the console resolve the same frame independently.
     */
    const menu = menuWith([]);
    const skeleton = palmDownLeft();
    const fingers = new FingerFrame();
    fingers.beginFrame(1000, 1 / 90);
    fingers.setFinger(Finger.RIGHT_INDEX, 0.5, 1.2, -0.4, 0.008);
    menu.update(skeleton, fingers, ...LOOKING, 1 / 90);
    expect(fingers.tracked[Finger.RIGHT_INDEX]).toBe(1);
    expect(fingers.position[Finger.RIGHT_INDEX * 3]).toBeCloseTo(0.5, 6);
  });

  it('releases a held row when the wrist turns away mid-press', () => {
    // Rather than latching it. A row stuck down is a row that fires the moment
    // the console next opens.
    const pressed: string[] = [];
    const menu = menuWith(pressed);
    const skeleton = palmDownLeft();
    pokeRow(menu, skeleton, LOOKING);
    expect(pressed).toEqual(['TWO']);

    menu.update(skeleton, new FingerFrame(), ...AWAY, 1 / 90);
    expect(menu.facing).toBe(0);
    // Opening again with no finger present must not re-fire anything.
    menu.update(skeleton, new FingerFrame(), ...LOOKING, 1 / 90);
    expect(pressed).toEqual(['TWO']);
  });
});

describe('the console itself', () => {
  it('sits off the back of the wrist', () => {
    const menu = menuWith([]);
    menu.update(palmDownLeft([0, 1, 0]), new FingerFrame(), ...LOOKING, 1 / 90);
    expect(menu.pose[1]).toBeCloseTo(1 + WRIST_LIFT, 5);
  });

  it('has one row per item, and no more', () => {
    const menu = menuWith([]);
    expect(menu.layout.zones).toHaveLength(3);
    expect(menu.layout.zones.map((z) => z.label)).toEqual(['ONE', 'TWO', 'THREE']);
  });

  it('is shorter than a forearm', () => {
    // Six rows plus the readout is what it carries in practice; any taller and
    // the console runs off the end of the arm it is worn on.
    const six = new WristMenu(
      ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ id, label: () => id, run: () => {} })),
    );
    expect(six.layout.height).toBeLessThan(0.25);
  });

  it('leads its readout with a word rather than a dashboard', () => {
    /*
     * Six figures on a wrist is a dashboard, and a dashboard is not what
     * somebody mid-phrase needs: they need to know whether to trust their own
     * timing.
     */
    const menu = menuWith([]);
    menu.setLink(8, {
      jitterMs: 2,
      peakJitterMs: 5,
      lossRatio: 0,
      packets: 100,
      dropped: 0,
      reordered: 0,
      malformed: 0,
      activeNotes: 0,
    });
    expect(menu.state.readout.startsWith('Solid')).toBe(true);

    menu.setLink(8, {
      jitterMs: 40,
      peakJitterMs: 90,
      lossRatio: 0.08,
      packets: 100,
      dropped: 8,
      reordered: 0,
      malformed: 0,
      activeNotes: 0,
    });
    expect(menu.state.readout.startsWith('Struggling')).toBe(true);
  });

  it('says what is urgent instead of the link, and gives the link back after', () => {
    const menu = menuWith([]);
    menu.setLink(8, null);
    menu.setNotice('Play five pads gently.');
    expect(menu.state.readout).toBe('Play five pads gently.');
    menu.setNotice('');
    expect(menu.state.readout).toContain('ms');
  });
});
