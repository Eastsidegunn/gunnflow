/**
 * Pure execution-view helpers: filtering (view-only, §26), virtualization
 * (§17/§34), and row display (verbatim upstream facts, §6).
 */
import type { ExecutionEvent } from '../model/executionTypes.js';

export interface EventFilters {
  sessionId: string | null;
  failedOnly: boolean;
  kinds: ReadonlySet<string>; // empty = all kinds
}

export const NO_FILTERS: EventFilters = { sessionId: null, failedOnly: false, kinds: new Set() };

/** View-only filter — never touches source state (acceptance §26). */
export function filterEvents(
  events: readonly ExecutionEvent[],
  filters: EventFilters,
): ExecutionEvent[] {
  return events.filter((e) => {
    if (filters.sessionId && e.sessionId !== filters.sessionId) return false;
    if (filters.failedOnly && e.status !== 'failed' && e.status !== 'denied') return false;
    if (filters.kinds.size > 0 && !filters.kinds.has(e.kind)) return false;
    return true;
  });
}

/** Fixed-height virtualization window with overscan. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 10,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end };
}

export interface EventRow {
  time: string;
  kind: string;
  label: string;
  status: string | null;
  duration: string | null;
}

/** Row model: upstream fields verbatim — no re-summarization, no invention. */
export function eventRow(e: ExecutionEvent): EventRow {
  return {
    time: new Date(e.at).toLocaleTimeString(),
    kind: e.kind,
    label: e.label,
    status: e.status ?? null,
    duration:
      e.durationMs !== undefined
        ? e.durationMs >= 1000
          ? `${(e.durationMs / 1000).toFixed(1)} s`
          : `${e.durationMs} ms`
        : null,
  };
}

/** File-change rollup for the Files tab: last upstream-reported change per path. */
export function fileChanges(events: readonly ExecutionEvent[]): ExecutionEvent[] {
  const byPath = new Map<string, ExecutionEvent>();
  for (const e of events) if (e.file) byPath.set(e.file.path, e);
  return [...byPath.values()];
}
