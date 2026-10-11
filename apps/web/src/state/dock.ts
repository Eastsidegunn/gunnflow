/**
 * The dock rule (GF-T3): the panels that share the screen's edges never cover one another.
 *
 * - The toolbar holds every top-level toggle in its own row (Terminals, Decisions, ⚠); none floats over another.
 * - The bottom dock holds the terminals: full width, between the work area and the status line,
 *   its height set by the person (handle drag or arrow keys) and kept on this device.
 * - The right dock holds one panel at a time: the node stage or the decision inbox (the stage
 *   stands down while the inbox is open). It reaches from under the toolbar to the bottom dock.
 * - What floats — toasts and the notifications list — stands clear of both docks: it reads the
 *   insets below (CSS `--dock-right`, `--dock-bottom`) instead of guessing.
 * - Stacking order lives in styles.css `:root` (`--z-*`), nowhere else.
 *
 * Measurements are local (no request); the bottom height is stored in localStorage only.
 */
import { createRoot, createSignal } from 'solid-js';

/** The smallest useful terminal and the least room the work area keeps above it. */
export const DOCK_MIN_HEIGHT = 160;
export const WORK_MIN_HEIGHT = 160;
/** The toolbar and status line the bottom dock never eats into (styles.css --top-bar-height, --status-strip-height). */
export const CHROME_HEIGHT = 48 + 36;
/** One arrow-key step on the handle. */
export const DOCK_KEY_STEP = 24;

/** A dock height that leaves the terminal usable and the work area above it. */
export function clampDockHeight(height: number, viewportHeight: number): number {
  const max = Math.max(DOCK_MIN_HEIGHT, viewportHeight - CHROME_HEIGHT - WORK_MIN_HEIGHT);
  return Math.round(Math.min(max, Math.max(DOCK_MIN_HEIGHT, height)));
}

/** The first height: two fifths of the window. */
export const defaultDockHeight = (viewportHeight: number) => clampDockHeight(viewportHeight * 0.4, viewportHeight);

const STORAGE_KEY = 'gunnflow.dock.bottomHeight';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const viewportHeight = () => (typeof window === 'undefined' ? 900 : window.innerHeight);

export const dock = createRoot(() => {
  const stored = Number(storage()?.getItem(STORAGE_KEY));
  const [height, setHeightRaw] = createSignal(
    Number.isFinite(stored) && stored > 0 ? clampDockHeight(stored, viewportHeight()) : defaultDockHeight(viewportHeight()),
  );
  const [rightWidth, setRightWidth] = createSignal(0);
  const right = new Set<HTMLElement>();
  const measureRight = () => setRightWidth(Math.max(0, ...[...right].map((el) => el.offsetWidth)));
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureRight);
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      setHeightRaw((h) => clampDockHeight(h, viewportHeight()));
      measureRight();
    });
  }
  return {
    /** The bottom dock's height in px (whether or not it is open). */
    height,
    setHeight(h: number) {
      const next = clampDockHeight(h, viewportHeight());
      setHeightRaw(next);
      storage()?.setItem(STORAGE_KEY, String(next));
    },
    /** The open right-dock panel's width in px; 0 when none is open. */
    rightWidth,
    /**
     * A right-dock panel declares itself while mounted (it is anchored to the window's right edge).
     * Its layout width is read, not its on-screen box, so an entrance slide does not move what avoids it.
     */
    registerRight(el: HTMLElement): () => void {
      right.add(el);
      observer?.observe(el);
      measureRight();
      return () => {
        right.delete(el);
        observer?.unobserve(el);
        measureRight();
      };
    },
  };
});
