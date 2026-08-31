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
   * Play one blip.
   *
   * @param note     MIDI note, used to pitch the blip so runs are legible
   * @param velocity 1..127, mapped to level and brightness
   */
  strike(note: number, velocity: number): void {
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

    osc.connect(env).connect(bus);
    click.connect(clickEnv).connect(bus);

    osc.start(now);
    click.start(now);
    osc.stop(now + 0.13);
    click.stop(now + 0.03);
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
