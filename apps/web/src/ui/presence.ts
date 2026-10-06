/**
 * Exit presence (ui-requirements M-02/M-06/M-08): a surface stays mounted for
 * the length of its exit animation, then leaves the DOM. During the exit it is
 * click-through (pointer-events: none, in CSS). With prefers-reduced-motion
 * the exit is immediate (M-18). Purely view machinery — no state meaning.
 */
import { createRenderEffect, createSignal, onCleanup, untrack } from 'solid-js';

export type MotionPhase = 'enter' | 'exit';
export type PresenceState<T> = { held: T | null; phase: MotionPhase };

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The pure transition: a present value holds (a CHANGED value swaps content in
 * place — M-03, no re-entrance); a vanished value starts one exit; after the
 * exit the surface is gone; a value during the exit cancels it and re-enters.
 */
export function presenceStep<T>(prev: PresenceState<T>, value: T | null | undefined): { next: PresenceState<T>; startExit: boolean } {
  if (value !== null && value !== undefined) return { next: { held: value, phase: 'enter' }, startExit: false };
  if (prev.held !== null && prev.phase !== 'exit') return { next: { held: prev.held, phase: 'exit' }, startExit: true };
  return { next: prev, startExit: false };
}

/** Reactive shell over presenceStep; the timer ends the exit. */
export function createPresence<T>(value: () => T | null | undefined, exitMs: number) {
  const initial = value();
  const [state, setState] = createSignal<PresenceState<T>>({ held: initial ?? null, phase: 'enter' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  createRenderEffect(() => {
    const v = value();
    untrack(() => {
      const { next, startExit } = presenceStep(state(), v);
      if (next !== state()) setState(next);
      if (startExit) {
        const ms = prefersReducedMotion() ? 0 : exitMs;
        timer = setTimeout(() => setState((s) => (s.phase === 'exit' ? { held: null, phase: 'exit' } : s)), ms);
      } else if (v !== null && v !== undefined && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
  });
  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });
  return { held: () => state().held, phase: () => state().phase };
}

/** Boolean form: `true` to show. */
export function createBooleanPresence(open: () => boolean, exitMs: number) {
  const p = createPresence<true>(() => (open() ? true : null), exitMs);
  return { mounted: () => p.held() === true, phase: p.phase };
}
