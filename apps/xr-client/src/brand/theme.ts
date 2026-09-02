/**
 * The theme, in one place.
 *
 * Three states, and they are not the same kind of thing: `light` and `dark` are
 * choices, `system` is a *deferral* — it keeps following the OS for as long as
 * it is selected, which is why it stays a stored value in its own right rather
 * than collapsing into whichever of the two it happens to resolve to today.
 *
 *   pref      what the person chose      system · light · dark
 *   resolved  what is actually shown     light · dark
 *
 * `resolved` is written to `<html data-theme>` and nowhere else, so the
 * stylesheet has one selector to reason about and no specificity race between a
 * media query and an explicit choice.
 *
 * The matching pre-paint boot script is inlined in index.html — it has to run
 * before the first paint and a module cannot. Keep the two in step: the storage
 * key and the attribute names are the contract between them.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { INK } from './tokens.js';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

/** Shared with the boot script in index.html. */
const KEY = 'vrmc.theme';
const DARK = '(prefers-color-scheme: dark)';

/** The surface each theme paints, for the browser chrome's own colour. */
const CHROME: Record<Theme, string> = { light: INK.bone, dark: INK.sumi };

const isPref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark';

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return isPref(v) ? v : 'system';
  } catch {
    // Private browsing, or storage disabled outright. Following the OS is the
    // right default when nothing can be remembered.
    return 'system';
  }
}

const systemTheme = (): Theme => (window.matchMedia?.(DARK).matches ? 'dark' : 'light');

export const resolve = (pref: ThemePref): Theme => (pref === 'system' ? systemTheme() : pref);

/* ---- the store ----------------------------------------------------------- */

let pref: ThemePref = 'system';
let theme: Theme = 'light';
const listeners = new Set<() => void>();
/**
 * The WebGL layer subscribes here rather than re-rendering: the galaxy's ink
 * crosses a theme change on its own curve inside the frame loop, and a React
 * render on that path is exactly what the rest of this app avoids.
 */
const watchers = new Set<(t: Theme) => void>();

/** Snapshot object, rebuilt only when something actually changed. */
let snapshot: { pref: ThemePref; theme: Theme } = { pref, theme };

function apply(next: ThemePref): void {
  pref = next;
  const nextTheme = resolve(next);
  const changed = nextTheme !== theme;
  theme = nextTheme;

  const root = document.documentElement;
  root.dataset.theme = theme;
  // The preference is published too, so a toggle can read its own state from
  // the DOM on a cold start rather than racing this module's first run.
  root.dataset.themePref = pref;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute('content', CHROME[theme]);

  snapshot = { pref, theme };
  listeners.forEach((l) => l());
  if (changed) watchers.forEach((w) => w(theme));
}

export function setThemePref(next: ThemePref): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not fatal; the choice just will not survive the visit.
  }
  apply(next);
}

/**
 * Start following the OS, and adopt whatever the boot script already decided.
 *
 * Called once from `main.tsx`. The listener stays for the life of the page: a
 * `system` preference means the theme can change while the app is open, and an
 * app that only reads the OS at start-up is one that goes light at dusk and
 * stays there.
 */
export function startTheme(): void {
  apply(read());
  window.matchMedia?.(DARK).addEventListener('change', () => {
    if (pref === 'system') apply('system');
  });
}

/** For the frame loop: the value, not a re-render. Returns an unsubscribe. */
export function watchTheme(fn: (t: Theme) => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

/** The theme right now, for code that runs before its first frame. */
export const currentTheme = (): Theme => theme;

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function useTheme(): { pref: ThemePref; theme: Theme; cycle: () => void } {
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
  const cycle = useCallback(() => {
    setThemePref(THEME_PREFS[(THEME_PREFS.indexOf(state.pref) + 1) % THEME_PREFS.length]!);
  }, [state.pref]);
  return { ...state, cycle };
}
