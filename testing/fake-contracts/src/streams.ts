/**
 * Simulated stream backend for the contract's stream channel (StreamRef,
 * resync/append/gap). The PTY feed adapts FakePtyStream output; its
 * stdin/policy simulation stays in terminal.ts and is not part of the contract.
 */
import type { StreamChunk, StreamEvent, StreamGap, StreamRef } from '@gunnflow/contract';
import type { FakePtyEvent, FakePtyStream } from './terminal.js';

export function fakePtyStreamRef(sessionId: string): StreamRef {
  return {
    id: `pty-${sessionId}`,
    role: 'pty',
    mediaType: 'text/plain',
    sequence: 'contiguous',
    encoding: 'utf-8',
    framing: 'line',
  };
}

type FeedListener = (event: StreamEvent) => void;

/**
 * TEST-ONLY upstream feed: contiguous seq, bounded upstream retention, resume
 * from a last seen seq when still retained, otherwise a resync bundle.
 */
export class FakeStreamFeed {
  private readonly chunks: StreamChunk[] = [];
  private readonly gaps: StreamGap[] = [];
  private readonly listeners = new Set<FeedListener>();
  private seq = 0;

  constructor(
    readonly ref: StreamRef,
    private readonly retain = 20_000,
  ) {}

  lastSeq(): number {
    return this.seq;
  }

  append(items: Array<{ channel?: string; data: string; at?: string }>): void {
    if (items.length === 0) return;
    const appended = items.map((i) =>
      Object.freeze({
        seq: ++this.seq,
        at: i.at ?? new Date().toISOString(),
        ...(i.channel !== undefined ? { channel: i.channel } : {}),
        data: i.data,
      }),
    );
    this.chunks.push(...appended);
    if (this.chunks.length > this.retain) this.chunks.splice(0, this.chunks.length - this.retain);
    this.emit({ type: 'append', streamId: this.ref.id, chunks: appended });
  }

  /** Upstream-declared loss: `count` seqs are skipped and announced. */
  declareGap(count: number, reason: string): void {
    const gap: StreamGap = {
      type: 'gap',
      streamId: this.ref.id,
      fromSeq: this.seq + 1,
      toSeq: this.seq + count,
      reason,
      origin: 'upstream',
    };
    this.seq += count;
    this.gaps.push(gap);
    this.emit(gap);
  }

  /**
   * Subscribe, resuming after `lastSeenSeq` when every later seq is still
   * retained and no declared gap lies after it; otherwise send a resync.
   */
  subscribe(lastSeenSeq: number | null, listener: FeedListener): () => void {
    const first = this.chunks[0]?.seq ?? this.seq + 1;
    const resumable =
      lastSeenSeq !== null &&
      lastSeenSeq <= this.seq &&
      lastSeenSeq >= first - 1 &&
      !this.gaps.some((g) => g.toSeq > lastSeenSeq);
    if (resumable) {
      const rest = this.chunks.filter((c) => c.seq > lastSeenSeq);
      if (rest.length > 0) listener({ type: 'append', streamId: this.ref.id, chunks: rest });
    } else {
      listener({ type: 'resync', streamId: this.ref.id, chunks: [...this.chunks] });
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StreamEvent): void {
    for (const l of this.listeners) l(event);
  }
}

/** Upstream-declared channel for a PTY line; operator-injected lines get their own. */
function ptyChannel(e: Pick<FakePtyEvent, 'channel' | 'attribution'>): string {
  return e.attribution === 'operator' && e.channel !== 'control' ? 'operator' : e.channel;
}

/** A feed carrying a FakePtyStream's output as contiguous line chunks. */
export function fakePtyFeed(pty: FakePtyStream, sessionId: string): FakeStreamFeed {
  const feed = new FakeStreamFeed(fakePtyStreamRef(sessionId));
  const toItem = (e: FakePtyEvent) => ({
    channel: ptyChannel(e),
    data: e.text,
    at: new Date(e.at).toISOString(),
  });
  feed.append(pty.snapshot().events.map(toItem));
  pty.subscribe((delta) => {
    if (delta.type === 'pty') feed.append(delta.events.map(toItem));
  });
  return feed;
}
