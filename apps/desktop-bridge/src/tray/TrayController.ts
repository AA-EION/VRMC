// SPDX-License-Identifier: GPL-3.0-only

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { findHelper } from './helperPath.js';
import { parseTrayEvent, type TrayCommand, type TrayItem } from './protocol.js';

export interface TrayOptions {
  onClick: (id: string) => void;
  /** The user chose Quit from the menu. */
  onQuit: () => void;
  onLog: (message: string) => void;
}

/**
 * The menu bar icon, and the only user interface the bridge has.
 *
 * The bridge is a background process: it has no window, and on both platforms
 * the honest place for something that runs all day and mostly does nothing is
 * the menu bar or the notification area. This owns that icon by driving a
 * native helper, and it is deliberately optional — if the helper is missing or
 * refuses to start, the bridge logs it once and carries on headless. A tray
 * icon failing to appear must never stop MIDI from working.
 */
export class TrayController {
  private readonly options: TrayOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stopping = false;
  /** Last menu sent, so a helper that restarts can be brought back in step. */
  private lastCommand: TrayCommand | null = null;

  constructor(options: TrayOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  /** Launch the helper. Returns false when this platform has none installed. */
  start(): boolean {
    const path = findHelper();
    if (path === null) return false;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.options.onLog(
        `tray helper would not start: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    this.child = child;
    // The helper is a convenience. Holding the event loop open for it would
    // mean a bridge that cannot exit because its icon is still drawn.
    child.unref();
    child.stdin.on('error', () => {
      // The helper died mid-write; `exit` below handles the consequences.
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.options.onLog(`tray: ${text}`);
    });

    child.on('exit', (code) => {
      this.child = null;
      if (this.stopping) return;
      this.options.onLog(`tray helper exited (${code ?? 'signal'}); continuing without an icon`);
    });

    if (this.lastCommand !== null) this.send(this.lastCommand);
    return true;
  }

  /** Replace the whole menu. Cheap enough to call on every state change. */
  setMenu(tooltip: string, items: readonly TrayItem[]): void {
    this.send({ type: 'menu', tooltip, items: [...items] });
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    if (child === null) return;
    this.send({ type: 'quit' });
    // Give it a moment to take its icon down cleanly. A helper that ignores
    // the request leaves a dead icon in the menu bar until the user clicks it.
    const kill = setTimeout(() => child.kill(), 500);
    kill.unref();
    child.once('exit', () => clearTimeout(kill));
  }

  private send(command: TrayCommand): void {
    if (command.type === 'menu') this.lastCommand = command;
    const child = this.child;
    if (child === null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Split stdout into lines; a write may deliver part of one or several. */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const event = parseTrayEvent(line);
      if (event !== null) {
        if (event.type === 'click') this.options.onClick(event.id);
        else if (event.type === 'quit') this.options.onQuit();
      }
      index = this.buffer.indexOf('\n');
    }
    // A helper that never sends a newline must not grow this without bound.
    if (this.buffer.length > 64 * 1024) this.buffer = '';
  }
}
