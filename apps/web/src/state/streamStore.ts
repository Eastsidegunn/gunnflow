/**
 * Stream part state (stream review §3.3–§3.5) over the contract's stream
 * channel. Receive-and-display only; built-in invariants that
 * no param can change: tail retention, oldest-first drop, no input, no
 * attestation. Three losses stay distinct and are never summed:
 *   STREAM GAP        — upstream-declared, or computed from a contiguous seq break
 *   resync boundary   — continuity with what was shown before is unknown
 *   LOCAL BUFFER DROP — received, then discarded by local retention
 */
import { createSignal } from 'solid-js';
import type { StreamChunk, StreamEvent, StreamRef } from '../model/streamTypes.js';
import { utf8Bytes } from './digest.js';

export interface StreamPartParams {
  source: { role: string };
  retainItems: number;
  retainBytes: number;
}

export const STREAM_RETAIN_LIMITS = {
  items: { min: 100, max: 20_000 },
  bytes: { min: 64 * 1024, max: 32 * 1024 * 1024 },
} as const;

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo;

export function clampStreamParams(p: StreamPartParams): StreamPartParams {
  return {
    source: { role: p.source.role },
    retainItems: clamp(p.retainItems, STREAM_RETAIN_LIMITS.items.min, STREAM_RETAIN_LIMITS.items.max),
    retainBytes: clamp(p.retainBytes, STREAM_RETAIN_LIMITS.bytes.min, STREAM_RETAIN_LIMITS.bytes.max),
  };
}

/** Bind by role among the node's declared streams; no role match → no stream. */
export function bindStream(
  streams: readonly StreamRef[] | undefined,
  source: StreamPartParams['source'],
): StreamRef | undefined {
  return streams?.find((s) => s.role === source.role);
}

export type StreamRow =
  | { kind: 'chunk'; chunk: StreamChunk }
  | { kind: 'gap'; fromSeq: number; toSeq: number; origin: 'upstream'; reason: string }
  | { kind: 'gap'; fromSeq: number; toSeq: number; origin: 'computed' }
  | { kind: 'resync' };

/** 'limited' = the engine's concurrent-stream cap refused a connection. */
export type StreamConnection = 'idle' | 'limited' | 'connecting' | 'live' | 'disconnected' | 'unsupported';

export interface LossTally {
  events: number;
  seqs: number;
}

/** A contiguous run of locally discarded seqs, within one resync segment. */
export interface DropRange {
  segment: number;
  fromSeq: number;
  toSeq: number;
}

export interface LocalDropTally {
  chunks: number;
  /** Disjoint ranges, never merged across holes or segments. */
  ranges: readonly DropRange[];
}

/** Only the stream-declared sequence kind licenses gap arithmetic. */
type SequenceDecl = Omit<StreamRef, 'sequence'> & { sequence: string };

function chunkBytes(c: StreamChunk): number {
  return utf8Bytes(c.data).length;
}

/** Seqs in [from, to] not yet covered by `counted`; `counted` is updated. */
function uncovered(counted: Array<[number, number]>, from: number, to: number): number {
  let fresh = 0;
  for (let seq = from; seq <= to; ) {
    const hit = counted.find(([a, b]) => seq >= a && seq <= b);
    if (hit) {
      seq = hit[1] + 1;
      continue;
    }
    const next = counted.filter(([a]) => a > seq).reduce((m, [a]) => Math.min(m, a), to + 1);
    fresh += Math.min(next, to + 1) - seq;
    seq = next;
  }
  counted.push([from, to]);
  return fresh;
}

export function createStreamStore(ref: SequenceDecl, params: StreamPartParams) {
  const limits = clampStreamParams(params);
  const contiguous = ref.sequence === 'contiguous';
  const [rows, setRows] = createSignal<readonly StreamRow[]>([]);
  const [connection, setConnection] = createSignal<StreamConnection>('idle');
  const [lastSeq, setLastSeq] = createSignal<number | null>(null);
  const [lastAt, setLastAt] = createSignal<string | null>(null);
  const [upstreamGaps, setUpstreamGaps] = createSignal<LossTally>({ events: 0, seqs: 0 });
  const [malformedGaps, setMalformedGaps] = createSignal(0);
  const [computedGaps, setComputedGaps] = createSignal<LossTally>({ events: 0, seqs: 0 });
  const [resyncs, setResyncs] = createSignal(0);
  const [localDrop, setLocalDrop] = createSignal<LocalDropTally>({ chunks: 0, ranges: [] });
  const [duplicates, setDuplicates] = createSignal(0);
  /** Chunks applied since creation (drives the paused-view "held" count). */
  const [received, setReceived] = createSignal(0);
  /**
   * Resync segment: seq arithmetic (dedup, gaps, ranges) never crosses a
   * segment boundary, because continuity across it is unknown.
   */
  let segment = 0;
  let upstreamCounted: Array<[number, number]> = [];
  let retainedBytes = 0;
  const rowSegment = new WeakMap<StreamRow, number>();

  function push(list: StreamRow[], row: StreamRow) {
    rowSegment.set(row, segment);
    list.push(row);
  }

  function retain(list: StreamRow[]): StreamRow[] {
    const dropped: DropRange[] = [];
    let chunks = 0;
    let i = 0;
    // Oldest first over every row, markers included; the newest row is always kept.
    while (list.length - i > 1 && (list.length - i > limits.retainItems || retainedBytes > limits.retainBytes)) {
      const row = list[i++]!;
      if (row.kind !== 'chunk') continue;
      retainedBytes -= chunkBytes(row.chunk);
      chunks++;
      const seg = rowSegment.get(row) ?? 0;
      const last = dropped.at(-1);
      if (last && last.segment === seg && row.chunk.seq === last.toSeq + 1) last.toSeq = row.chunk.seq;
      else dropped.push({ segment: seg, fromSeq: row.chunk.seq, toSeq: row.chunk.seq });
    }
    if (chunks > 0) {
      setLocalDrop((d) => {
        const ranges = [...d.ranges];
        for (const r of dropped) {
          const prev = ranges.at(-1);
          if (prev && prev.segment === r.segment && r.fromSeq === prev.toSeq + 1) {
            ranges[ranges.length - 1] = { ...prev, toSeq: r.toSeq };
          } else {
            ranges.push(r);
          }
        }
        return { chunks: d.chunks + chunks, ranges };
      });
    }
    return list.slice(i);
  }

  function applyChunks(list: StreamRow[], chunks: readonly StreamChunk[]) {
    let last = lastSeq();
    let dupes = 0;
    for (const chunk of chunks) {
      if (last !== null && chunk.seq <= last) {
        dupes++;
        continue;
      }
      if (contiguous && last !== null && chunk.seq > last + 1) {
        const from = last + 1;
        push(list, { kind: 'gap', origin: 'computed', fromSeq: from, toSeq: chunk.seq - 1 });
        setComputedGaps((g) => ({ events: g.events + 1, seqs: g.seqs + (chunk.seq - from) }));
      }
      push(list, { kind: 'chunk', chunk });
      retainedBytes += chunkBytes(chunk);
      last = chunk.seq;
      setLastAt(chunk.at);
    }
    if (dupes > 0) setDuplicates((d) => d + dupes);
    if (chunks.length - dupes > 0) setReceived((n) => n + chunks.length - dupes);
    setLastSeq(last);
  }

  return {
    params: limits,
    rows,
    connection,
    lastSeq,
    lastAt,
    upstreamGaps,
    malformedGaps,
    computedGaps,
    resyncs,
    localDrop,
    duplicates,
    received,
    encoding: ref.encoding,
    unit: ref.framing === 'line' ? 'lines' : 'chunks',

    setConnection,

    apply(event: StreamEvent) {
      const list = [...rows()];
      if (event.type === 'append') {
        applyChunks(list, event.chunks);
      } else if (event.type === 'resync') {
        if (lastSeq() !== null || list.length > 0) {
          push(list, { kind: 'resync' });
          setResyncs((n) => n + 1);
        }
        // New segment: the seq baseline and counted ranges restart from the bundle.
        segment++;
        upstreamCounted = [];
        setLastSeq(null);
        applyChunks(list, event.chunks);
      } else if (!(Number.isInteger(event.fromSeq) && Number.isInteger(event.toSeq) && event.fromSeq <= event.toSeq)) {
        setMalformedGaps((n) => n + 1);
      } else {
        const fresh = uncovered(upstreamCounted, event.fromSeq, event.toSeq);
        if (fresh > 0) {
          push(list, { kind: 'gap', origin: 'upstream', fromSeq: event.fromSeq, toSeq: event.toSeq, reason: event.reason });
          setUpstreamGaps((g) => ({ events: g.events + 1, seqs: g.seqs + fresh }));
        }
        const last = lastSeq();
        setLastSeq(last === null ? event.toSeq : Math.max(last, event.toSeq));
      }
      setRows(retain(list));
      if (event.type !== 'gap') setConnection('live');
    },
  };
}

export type StreamStore = ReturnType<typeof createStreamStore>;

/** Chunks carried by an event, for callers that confirm pending intents from them. */
export function chunksOf(event: StreamEvent): readonly StreamChunk[] {
  return event.type === 'gap' ? [] : event.chunks;
}

/** Display text for a chunk per the declared encoding; undecodable bytes are not guessed at. */
export function chunkText(encoding: StreamRef['encoding'], data: string): string {
  if (encoding === 'utf-8') return data;
  try {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '[not decodable as UTF-8 text]';
  }
}

/** Control characters shown as visible pictures; escape sequences are never interpreted. */
export function visibleControls(data: string): string {
  return data.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) =>
    c === '\u007f' ? '␡' : String.fromCharCode(0x2400 + c.charCodeAt(0)),
  );
}

const MAX_STREAM_CONNECTIONS = 4;
let openStreams = 0;

/** Engine cap on concurrent stream connections, so the workspace SSE keeps its slot. */
export function acquireStreamSlot(): (() => void) | null {
  if (openStreams >= MAX_STREAM_CONNECTIONS) return null;
  openStreams++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      openStreams--;
    }
  };
}
