// Stream part (stream review §3.2–§3.5): contiguous gap arithmetic, resync
// boundary, local buffer drop, duplicate seqs, retention clamp — three losses
// kept apart — plus the fake upstream feed's resume/resync behaviour.
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { FakeStreamFeed, fakePtyStreamRef } from '@gunnflow-testing/fake-contracts';
import type { StreamEvent } from '@gunnflow/contract';
import {
  STREAM_RETAIN_LIMITS,
  bindStream,
  chunkText,
  clampStreamParams,
  createStreamStore,
  visibleControls,
  type StreamPartParams,
} from '../src/state/streamStore.js';
import type { StreamChunk, StreamRef } from '../src/model/streamTypes.js';

const REF = fakePtyStreamRef('s-1');
const PARAMS: StreamPartParams = { source: { role: 'pty' }, retainItems: 5000, retainBytes: 8 * 1024 * 1024 };

const chunk = (seq: number, data = `line ${seq}`): StreamChunk => ({ seq, at: `t${seq}`, data });
const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => chunk(from + i));
const append = (chunks: StreamChunk[]): StreamEvent => ({ type: 'append', streamId: REF.id, chunks });
const resync = (chunks: StreamChunk[]): StreamEvent => ({ type: 'resync', streamId: REF.id, chunks });

function store(params: StreamPartParams = PARAMS, ref: Omit<StreamRef, 'sequence'> & { sequence: string } = REF) {
  return createRoot((dispose) => ({ s: createStreamStore(ref, params), dispose }));
}

const chunkSeqs = (s: ReturnType<typeof createStreamStore>) =>
  s.rows().flatMap((r) => (r.kind === 'chunk' ? [r.chunk.seq] : []));

describe('gap arithmetic', () => {
  it('a contiguous seq break is computed as a gap, never filled', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(1, 2)));
    s.apply(append([chunk(5)]));
    expect(chunkSeqs(s)).toEqual([1, 2, 5]);
    expect(s.rows()[2]).toEqual({ kind: 'gap', origin: 'computed', fromSeq: 3, toSeq: 4 });
    expect(s.computedGaps()).toEqual({ events: 1, seqs: 2 });
    expect(s.upstreamGaps()).toEqual({ events: 0, seqs: 0 });
    dispose();
  });

  it('no gap arithmetic when the stream does not declare contiguous seqs', () => {
    const { s, dispose } = store(PARAMS, { ...REF, sequence: 'monotonic' });
    s.apply(append([chunk(1), chunk(5), chunk(9)]));
    expect(s.rows().every((r) => r.kind === 'chunk')).toBe(true);
    expect(s.computedGaps().events).toBe(0);
    dispose();
  });

  it('an upstream gap is shown with its reason and advances the baseline', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(1, 2)));
    s.apply({ type: 'gap', streamId: REF.id, fromSeq: 3, toSeq: 10, reason: 'overflow', origin: 'upstream' });
    s.apply(append([chunk(11)]));
    expect(s.upstreamGaps()).toEqual({ events: 1, seqs: 8 });
    expect(s.computedGaps().events).toBe(0);
    expect(s.rows().find((r) => r.kind === 'gap')).toMatchObject({ origin: 'upstream', reason: 'overflow' });
    dispose();
  });

  it('the first data seen is the start of view, not a gap', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(500, 501)));
    expect(s.computedGaps().events).toBe(0);
    dispose();
  });
});

describe('resync boundary', () => {
  it('marks the boundary without inventing a gap count', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(1, 3)));
    s.apply(resync(seqs(40, 42)));
    expect(s.resyncs()).toBe(1);
    expect(s.computedGaps().events).toBe(0);
    expect(s.rows().map((r) => r.kind)).toEqual(['chunk', 'chunk', 'chunk', 'resync', 'chunk', 'chunk', 'chunk']);
    dispose();
  });

  it('the first resync on an empty view is not a boundary; a later one starts a new segment', () => {
    const { s, dispose } = store();
    s.apply(resync(seqs(1, 3)));
    expect(s.resyncs()).toBe(0);
    // Overlapping seqs after a boundary belong to the new segment: shown, not deduped across it.
    s.apply(resync(seqs(2, 4)));
    expect(chunkSeqs(s)).toEqual([1, 2, 3, 2, 3, 4]);
    expect(s.resyncs()).toBe(1);
    dispose();
  });

  it('after a resync to LOWER seqs, the following appends are accepted, not dropped as duplicates', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(100, 102)));
    s.apply(resync(seqs(1, 2)));
    s.apply(append([chunk(3), chunk(4)]));
    expect(chunkSeqs(s)).toEqual([100, 101, 102, 1, 2, 3, 4]);
    expect(s.duplicates()).toBe(0);
    expect(s.computedGaps().events).toBe(0);
    dispose();
  });

  it('after a resync to HIGHER seqs, no gap is computed across the boundary', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(1, 2)));
    s.apply(resync(seqs(50, 51)));
    s.apply(append([chunk(52)]));
    expect(s.computedGaps().events).toBe(0);
    dispose();
  });

  it('an empty resync resets the baseline; the next append starts the segment without a gap', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(1, 5)));
    s.apply(resync([]));
    s.apply(append([chunk(900)]));
    expect(s.computedGaps().events).toBe(0);
    expect(s.duplicates()).toBe(0);
    expect(s.rows().map((r) => r.kind)).toEqual(['chunk', 'chunk', 'chunk', 'chunk', 'chunk', 'resync', 'chunk']);
    // Within the new segment, arithmetic resumes.
    s.apply(append([chunk(903)]));
    expect(s.computedGaps()).toEqual({ events: 1, seqs: 2 });
    dispose();
  });
});

describe('upstream gap declarations', () => {
  const gap = (fromSeq: number, toSeq: number): StreamEvent => ({
    type: 'gap',
    streamId: REF.id,
    fromSeq,
    toSeq,
    reason: 'overflow',
    origin: 'upstream',
  });

  it('a repeated or overlapping range is counted once', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(1, 2)));
    s.apply(gap(3, 10));
    s.apply(gap(3, 10));
    s.apply(gap(8, 12));
    expect(s.upstreamGaps()).toEqual({ events: 2, seqs: 10 });
    expect(s.rows().filter((r) => r.kind === 'gap')).toHaveLength(2);
    dispose();
  });

  it('a reversed range is rejected, not counted', () => {
    const { s, dispose } = store();
    s.apply(gap(10, 3));
    expect(s.upstreamGaps()).toEqual({ events: 0, seqs: 0 });
    expect(s.malformedGaps()).toBe(1);
    expect(s.rows()).toHaveLength(0);
    dispose();
  });
});

describe('duplicates', () => {
  it('re-sent seqs are ignored and counted', () => {
    const { s, dispose } = store();
    s.apply(append(seqs(1, 2)));
    s.apply(append(seqs(2, 3)));
    expect(chunkSeqs(s)).toEqual([1, 2, 3]);
    expect(s.duplicates()).toBe(1);
    expect(s.computedGaps().events).toBe(0);
    dispose();
  });
});

describe('local buffer drop', () => {
  const range = (fromSeq: number, toSeq: number, segment = 0) => ({ segment, fromSeq, toSeq });

  it('oldest-first by item count, with accumulated count and seq range', () => {
    const { s, dispose } = store({ ...PARAMS, retainItems: 100 });
    s.apply(append(seqs(1, 150)));
    expect(chunkSeqs(s)).toHaveLength(100);
    expect(chunkSeqs(s)[0]).toBe(51);
    expect(s.localDrop()).toEqual({ chunks: 50, ranges: [range(1, 50)] });
    s.apply(append(seqs(151, 160)));
    expect(s.localDrop()).toEqual({ chunks: 60, ranges: [range(1, 60)] });
    dispose();
  });

  it('oldest-first by UTF-8 bytes', () => {
    const { s, dispose } = store({ ...PARAMS, retainBytes: STREAM_RETAIN_LIMITS.bytes.min });
    const kib = 'x'.repeat(1024);
    s.apply(append(Array.from({ length: 100 }, (_, i) => chunk(i + 1, kib))));
    expect(chunkSeqs(s)).toHaveLength(64);
    expect(s.localDrop()).toEqual({ chunks: 36, ranges: [range(1, 36)] });
    dispose();
  });

  it('non-contiguous drops are recorded as separate ranges, never merged over the hole', () => {
    const { s, dispose } = store({ ...PARAMS, retainItems: 100 });
    s.apply(append(seqs(1, 10)));
    s.apply(append(seqs(21, 120)));
    // 10 + gap marker + 100 = 111 rows → 11 oldest rows go: seqs 1–10 and the marker.
    expect(s.localDrop().ranges).toEqual([range(1, 10)]);
    s.apply(append(seqs(121, 125)));
    expect(s.localDrop().ranges).toEqual([range(1, 10), range(21, 25)]);
    expect(s.localDrop().chunks).toBe(15);
    dispose();
  });

  it('marker rows count toward the retention limit', () => {
    const { s, dispose } = store({ ...PARAMS, retainItems: 100 });
    s.apply(append(seqs(1, 50)));
    s.apply(append(seqs(60, 109)));
    // 50 + 1 marker + 50 = 101 rows → one row over.
    expect(s.rows()).toHaveLength(100);
    expect(s.localDrop().chunks).toBe(1);
    dispose();
  });

  it('gap, resync and local drop stay three separate tallies', () => {
    const { s, dispose } = store({ ...PARAMS, retainItems: 100 });
    s.apply(append(seqs(1, 120)));
    s.apply(append([chunk(125)]));
    s.apply(resync(seqs(300, 301)));
    // 120 + gap + 125 + resync + 2 = 125 rows → 25 oldest rows (all chunks) dropped.
    expect(s.localDrop().chunks).toBe(25);
    expect(s.computedGaps()).toEqual({ events: 1, seqs: 4 });
    expect(s.resyncs()).toBe(1);
    expect(s.upstreamGaps().events).toBe(0);
    dispose();
  });
});

describe('params', () => {
  it('retain limits are clamped by the engine', () => {
    expect(clampStreamParams({ ...PARAMS, retainItems: 5, retainBytes: 1 })).toMatchObject({
      retainItems: STREAM_RETAIN_LIMITS.items.min,
      retainBytes: STREAM_RETAIN_LIMITS.bytes.min,
    });
    expect(clampStreamParams({ ...PARAMS, retainItems: 1e9, retainBytes: 1e12 })).toMatchObject({
      retainItems: STREAM_RETAIN_LIMITS.items.max,
      retainBytes: STREAM_RETAIN_LIMITS.bytes.max,
    });
    expect(clampStreamParams({ ...PARAMS, retainItems: Number.NaN }).retainItems).toBe(STREAM_RETAIN_LIMITS.items.min);
  });

  it('binds by role among declared streams only', () => {
    expect(bindStream([REF], { role: 'pty' })).toBe(REF);
    expect(bindStream([REF], { role: 'log' })).toBeUndefined();
    expect(bindStream(undefined, { role: 'pty' })).toBeUndefined();
  });
});

describe('display', () => {
  it('escape sequences are shown, not interpreted', () => {
    expect(visibleControls('\u001b[31mred\u001b[0m\ttab')).toBe('␛[31mred␛[0m\ttab');
  });

  it('base64 chunks decode only when they are UTF-8 text', () => {
    expect(chunkText('base64', btoa('hello'))).toBe('hello');
    expect(chunkText('base64', btoa(String.fromCharCode(0xff, 0xfe)))).toBe('[not decodable as UTF-8 text]');
    expect(chunkText('utf-8', 'raw')).toBe('raw');
  });
});

describe('fake upstream feed', () => {
  const events = (feed: FakeStreamFeed, last: number | null) => {
    const got: StreamEvent[] = [];
    const off = feed.subscribe(last, (e) => got.push(e));
    return { got, off };
  };

  it('resumes after a retained seq, resyncs otherwise', () => {
    const feed = new FakeStreamFeed(REF, 5);
    feed.append(Array.from({ length: 8 }, (_, i) => ({ data: `l${i + 1}` })));
    const resumed = events(feed, 6);
    expect(resumed.got).toEqual([{ type: 'append', streamId: REF.id, chunks: [expect.objectContaining({ seq: 7 }), expect.objectContaining({ seq: 8 })] }]);
    const tooOld = events(feed, 1);
    expect(tooOld.got[0]!.type).toBe('resync');
    const fresh = events(feed, null);
    expect(fresh.got[0]!.type).toBe('resync');
  });

  it('a declared gap after the last seen seq forces a resync', () => {
    const feed = new FakeStreamFeed(REF);
    feed.append([{ data: 'a' }, { data: 'b' }]);
    feed.declareGap(3, 'overflow');
    expect(events(feed, 2).got[0]!.type).toBe('resync');
    expect(events(feed, 5).got).toEqual([]);
  });
});
