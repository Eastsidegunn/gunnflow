/**
 * When the full view's layout engine preloads: once, at idle time after the
 * first snapshot (the caller decides when to schedule). Cancelled with the
 * cockpit: a pending idle callback never fires, and a preload that resolves
 * after disposal reports nothing.
 */
export type PreloadState = 'pending' | 'ready' | 'failed';

export interface IdleScheduler {
  request(cb: () => void): unknown;
  cancel(handle: unknown): void;
}

type IdleWindow = {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  cancelIdleCallback?: (h: number) => void;
};

/** The browser's idle callback (2 s at most), or a zero timer where there is none. */
export function browserIdle(w: IdleWindow = globalThis as IdleWindow): IdleScheduler {
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    return { request: (cb) => w.requestIdleCallback!(cb, { timeout: 2000 }), cancel: (h) => w.cancelIdleCallback!(h as number) };
  }
  return { request: (cb) => setTimeout(cb, 0), cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
}

/** Schedules one preload; the returned function cancels it (and silences a late result). */
export function scheduleLayoutPreload(preload: () => Promise<void>, onState: (s: PreloadState) => void, idle: IdleScheduler): () => void {
  let disposed = false;
  const handle = idle.request(() => {
    if (disposed) return;
    preload().then(
      () => !disposed && onState('ready'),
      () => !disposed && onState('failed'),
    );
  });
  return () => {
    disposed = true;
    idle.cancel(handle);
  };
}
