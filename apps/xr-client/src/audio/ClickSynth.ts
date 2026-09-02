/**
 * Local audio confirmation for a strike.
 *
 * Not an instrument — the DAW is the instrument. This exists because a virtual
 * pad has no edge to feel, and without *some* immediate response the player
 * cannot tell a hit from a near miss. A short percussive blip through the
 * headset's speakers, a couple of milliseconds after the finger crosses, gives
 * back the sense of contact that the missing physical surface took away.
 *
 * Deliberately cheap: two oscillators and a gain ramp per hit, all torn down by
 * the audio thread. No buffers to keep, nothing to leak if the player rolls.
 *
 * AND IT IS PLACED WHERE THE PAD IS
 * A click that arrives in the middle of your head tells you that *something*
 * was struck. A click that arrives from the left tells you *which*. On a wide
 * surface — a 64-pad grid is nearly half a metre across — that is the
 * difference between a controller you have to look at and one you can play by
 * ear, which is how anybody plays a real one.
 *
 * The panner is HRTF rather than the cheaper equal-power pan. Equal power gives
 * left and right and nothing else, and a pad grid is as tall as it is wide; the
 * whole point is knowing which pad, not which side. Each hit builds one panner
 * that lives for the hundred and thirty milliseconds the blip does, so even a
 * ten-finger chord is ten short-lived nodes.
 */
export class ClickSynth {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;

  enabled = true;
  /** Output level, 0..1. */
  volume = 0.25;

  /**
   * Create the AudioContext.
   *
   * Must be called from a user gesture — browsers start a context suspended
   * otherwise, and it stays silent until one arrives.
   */
  start(): void {
    if (this.ctx !== null) return;
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    // 'interactive' asks for the smallest buffer the device will give us, which
    // is the whole point of playing this locally rather than over the network.
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const bus = ctx.createGain();
    bus.gain.value = this.volume;
    bus.connect(ctx.destination);
    this.ctx = ctx;
    this.bus = bus;
  }

  /** Resume after the browser has suspended the context (headset sleep). */
  resume(): void {
    void this.ctx?.resume();
  }

  /**
   * Where the listener is, and which way they are facing.
   *
   * Written from the camera each frame. Without it every click arrives from
   * wherever the listener was left, which is the origin — so a pad to your left
   * sounds to your left only while you are standing exactly where the session
   * started.
   *
   * Both APIs are handled: the AudioParam form is current, and `setPosition` is
   * what older implementations expose. Neither is universal, so both are
   * probed rather than assumed.
   */
  setListener(
    x: number,
    y: number,
    z: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const listener = ctx.listener;
    const now = ctx.currentTime;

    if (listener.positionX !== undefined) {
      listener.positionX.setValueAtTime(x, now);
      listener.positionY.setValueAtTime(y, now);
      listener.positionZ.setValueAtTime(z, now);
      listener.forwardX.setValueAtTime(fx, now);
      listener.forwardY.setValueAtTime(fy, now);
      listener.forwardZ.setValueAtTime(fz, now);
      listener.upX.setValueAtTime(ux, now);
      listener.upY.setValueAtTime(uy, now);
      listener.upZ.setValueAtTime(uz, now);
      return;
    }
    listener.setPosition?.(x, y, z);
    listener.setOrientation?.(fx, fy, fz, ux, uy, uz);
  }

  /**
   * Play one blip.
   *
   * @param note     MIDI note, used to pitch the blip so runs are legible
   * @param velocity 1..127, mapped to level and brightness
   * @param at       world position of the pad that was struck, if it is known
   */
  strike(note: number, velocity: number, at?: readonly [number, number, number]): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const bus = this.bus;
    if (ctx === null || bus === null || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const level = (velocity / 127) ** 1.5 * 0.9;
    const freq = 440 * Math.pow(2, (note - 69) / 12);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    // A touch of noise-free "click" from a detuned partial, so a soft hit still
    // has an attack transient to locate in time.
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.value = freq * 4;

    const env = ctx.createGain();
    const clickEnv = ctx.createGain();

    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(level, now + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    clickEnv.gain.setValueAtTime(level * 0.25, now);
    clickEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);

    const destination = at === undefined ? bus : this.panner(ctx, at, bus);
    osc.connect(env).connect(destination);
    click.connect(clickEnv).connect(destination);

    osc.start(now);
    click.start(now);
    osc.stop(now + 0.13);
    click.stop(now + 0.03);
  }

  /**
   * A panner for one hit, placed at the pad.
   *
   * `inverse` with a reference distance of half a metre, because everything
   * here is within arm's reach and the default rolloff would make a pad at the
   * far end of a Launchpad noticeably quieter than one at the near end — which
   * is a real acoustic effect and the wrong one to reproduce, since what the
   * player needs is *direction*, not distance. The cone is left open: a pad
   * radiates in every direction.
   */
  private panner(
    ctx: AudioContext,
    at: readonly [number, number, number],
    bus: GainNode,
  ): AudioNode {
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 0.5;
    panner.maxDistance = 4;
    panner.rolloffFactor = 0.6;
    const now = ctx.currentTime;
    if (panner.positionX !== undefined) {
      panner.positionX.setValueAtTime(at[0], now);
      panner.positionY.setValueAtTime(at[1], now);
      panner.positionZ.setValueAtTime(at[2], now);
    } else {
      panner.setPosition?.(at[0], at[1], at[2]);
    }
    panner.connect(bus);
    return panner;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.bus !== null) this.bus.gain.value = v;
  }

  close(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.bus = null;
  }
}
