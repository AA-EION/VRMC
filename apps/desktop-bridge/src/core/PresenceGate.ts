// SPDX-License-Identifier: GPL-3.0-only

/**
 * Ports exist while a headset is connected, and not otherwise.
 *
 * WHY THIS EXISTS
 * A virtual MIDI port is not a private thing. The moment one opens, CoreMIDI
 * publishes it system-wide and every DAW on the machine lists it — so a port
 * for a device nobody is playing is a device in somebody's Ableton dropdown
 * that does not exist. The bridge used to open three of them before anything
 * connected (the VRMC surface, plus a Launchpad X from `startupDevice`)
 * and close them only on SIGINT, which is why a Mac with the bridge merely
 * running showed a Launchpad that was not there.
 *
 * WHY IT IS NOT JUST "CLOSE ON DISCONNECT"
 * Because a disconnect is usually not one. Wi-Fi on a headset drops for a
 * second at a time, and a DAW that sees a control surface vanish does not
 * politely wait — Ableton unbinds the script, and rebinding is a manual trip
 * through Preferences. Tearing ports down the instant a peer goes would make a
 * network blip cost the performer their session.
 *
 * So departure is delayed and arrival is immediate: a headset that comes back
 * inside the grace window finds its ports still open and the DAW none the
 * wiser, and one that does not come back leaves nothing behind.
 *
 * The timer functions are injected so the whole of this is testable without
 * waiting real seconds for anything.
 */

export interface PresenceGateOptions {
  /**
   * How long to keep ports open after the last client leaves.
   *
   * Long enough to cover a reconnect, short enough that somebody who takes the
   * headset off and walks away does not leave a phantom Launchpad in the DAW.
   */
  graceMs: number;
  /** Open the session's devices. Awaited, so the roster is ready before use. */
  onOpen: () => Promise<void>;
  /** Close everything. */
  onClose: () => void;
  /** For reporting; the bridge logs both transitions. */
  onLog?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class PresenceGate {
  private readonly options: PresenceGateOptions;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /** True once `onOpen` has been asked for and not yet undone. */
  private opened = false;
  private pendingClose: unknown = null;
  /**
   * The in-flight open, if one is still running.
   *
   * Opening ports is asynchronous — each one is a call into CoreMIDI — and a
   * headset can arrive, drop and return inside that window. Without this, two
   * arrivals in quick succession would both see `opened === false` and open
   * every port twice, which on macOS produces a second set of endpoints with
   * the same names rather than an error.
   */
  private opening: Promise<void> | null = null;

  constructor(options: PresenceGateOptions) {
    this.options = options;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /** Whether the session's ports are currently open. */
  get isOpen(): boolean {
    return this.opened;
  }

  /** Whether a close is scheduled but has not run. */
  get isClosing(): boolean {
    return this.pendingClose !== null;
  }

  /**
   * Tell the gate how many clients are connected right now.
   *
   * Called from every transport on both connect and disconnect. Takes a count
   * rather than an event because there are two transports and only their sum
   * means anything: a headset on WebRTC and the dashboard on WebSocket are two
   * clients, and the last one leaving is what matters.
   */
  update(clients: number): Promise<void> {
    if (clients > 0) return this.arrive();
    this.depart();
    return Promise.resolve();
  }

  private arrive(): Promise<void> {
    // A returning client cancels its own teardown. This is the case that makes
    // a blip free rather than expensive.
    if (this.pendingClose !== null) {
      this.clearTimer(this.pendingClose);
      this.pendingClose = null;
      this.options.onLog?.(
        "client returned within the grace period; ports kept open",
      );
    }
    if (this.opening !== null) return this.opening;
    if (this.opened) return Promise.resolve();

    this.opened = true;
    const open = this.options
      .onOpen()
      .catch((err: unknown) => {
        // A failed open must not leave the gate believing it succeeded, or
        // nothing will ever try again for the rest of the session.
        this.opened = false;
        this.options.onLog?.(
          `could not open the session's MIDI ports: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.opening = null;
      });
    this.opening = open;
    return open;
  }

  private depart(): void {
    /*
     * Never while an open is still running.
     *
     * `opened` goes true before `onOpen` is awaited, so with a short grace the
     * timer could fire mid-open: `removeAll()` would drop a half-built device
     * whose ports had not been recorded yet, the rest of the open would then
     * create ports nothing was tracking, and the next arrival — seeing
     * `opened` back to false — would open a second set under the same names.
     * With `--port-grace 0` that is not a race so much as the normal order.
     *
     * Waiting for the open to finish and then departing is correct rather than
     * merely safe: the client really has gone, and the close that follows
     * tears down everything the open just built.
     */
    if (this.opening !== null) {
      void this.opening.then(() => this.depart());
      return;
    }
    if (!this.opened || this.pendingClose !== null) return;
    this.pendingClose = this.setTimer(() => {
      this.pendingClose = null;
      if (!this.opened) return;
      this.opened = false;
      this.options.onLog?.(
        "no client for the grace period; closing the MIDI ports",
      );
      this.options.onClose();
    }, this.options.graceMs);
  }

  /**
   * Shut down: cancel any pending close and release the ports now.
   *
   * Deliberately not a `depart()` with a zero grace — the process is going
   * away, and waiting even a tick risks exiting with the ports still open.
   */
  dispose(): void {
    if (this.pendingClose !== null) {
      this.clearTimer(this.pendingClose);
      this.pendingClose = null;
    }
    if (!this.opened) return;
    this.opened = false;
    this.options.onClose();
  }
}
