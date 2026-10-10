// The full view's layout engine preloads at idle time after the first snapshot
// (gf-p2-views: switching views makes no request). The warm-up takes the same
// path as a layout pass — serialized, time-limited, the worker dropped on
// failure — and goes away with the cockpit.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { normalFixture, projectNodes } from '@gunnflow-testing/fake-contracts';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { layoutGraphOf } from '../src/canvas/layoutGraph.js';
import { createElkWorkerProvider, type ElkEngine } from '../src/canvas/elkLayout.js';
import { createLayoutState } from '../src/state/layoutState.js';
import { scheduleLayoutPreload, type IdleScheduler, type PreloadState } from '../src/state/layoutPreload.js';

const real = new ELK();
const graph = () => layoutGraphOf(projectNodes(normalFixture()), DEFAULT_WIRING);
const smallerGraph = () => layoutGraphOf(projectNodes(normalFixture()).filter((n) => n.id !== 't-test'), DEFAULT_WIRING);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

type Mode = 'ok' | 'hang' | 'reject';

/**
 * A stand-in engine: the real in-thread ELK, with a scripted behaviour for the
 * first engine's warm-up and for every normal pass; overlap and termination counted.
 */
function engines(warm: Mode = 'ok', passMode: Mode = 'ok') {
  const stats = { made: 0, terminated: 0, active: 0, maxActive: 0, warms: 0, passes: 0 };
  const make = (): ElkEngine => {
    stats.made++;
    const first = stats.made === 1;
    return {
      async layout(g: ElkNode) {
        stats.active++;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        try {
          if (g.id === 'warm') {
            stats.warms++;
            await tick(5);
            if (first && warm === 'hang') await new Promise(() => undefined);
            if (first && warm === 'reject') throw new Error('worker failed');
          } else {
            stats.passes++;
            if (passMode === 'hang') await new Promise(() => undefined);
            if (passMode === 'reject') throw new Error('pass crashed');
          }
          return await real.layout(g);
        } finally {
          stats.active--;
        }
      },
      terminateWorker: () => void stats.terminated++,
    };
  };
  return { stats, make };
}

/** The default limit is far away so a slow in-thread pass on a loaded machine never trips it; timeout tests pass 50 under fake timers. */
function harness(warm: Mode = 'ok', passMode: Mode = 'ok', timeoutMs = 10_000) {
  const e = engines(warm, passMode);
  let loads = 0;
  const layout = createRoot(() =>
    createLayoutState({ loadProvider: async () => (loads++, createElkWorkerProvider(timeoutMs, e.make)) }),
  );
  return { ...e, layout, loads: () => loads };
}

const syncIdle = (): IdleScheduler & { fire(): void; cancelled: boolean } => {
  let cb: (() => void) | null = null;
  return {
    cancelled: false,
    request: (f) => ((cb = f), 1),
    cancel() {
      this.cancelled = true;
      cb = null;
    },
    fire: () => cb?.(),
  };
};

describe('layout preload: one path with the passes', () => {
  it('a warm-up that hangs times out, the marker says failed, and the next real pass retries on a fresh worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness('hang', 'ok', 50);
      const states: PreloadState[] = [];
      const idle = syncIdle();
      scheduleLayoutPreload(() => h.layout.preload(), (s) => states.push(s), idle);
      idle.fire();
      await vi.advanceTimersByTimeAsync(40);
      expect(states).toEqual([]);
      await vi.advanceTimersByTimeAsync(20); // past the 50 ms limit
      expect(states).toEqual(['failed']);
      expect(h.stats.terminated).toBe(1);
      h.layout.update(graph());
      await vi.advanceTimersByTimeAsync(20);
      expect(h.layout.source()).toBe('layered');
      expect(h.stats.made).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a warm-up that rejects fails the preload; the next pass retries', async () => {
    const h = harness('reject');
    await expect(h.layout.preload()).rejects.toThrow('worker failed');
    h.layout.update(graph());
    await h.layout.settled();
    expect(h.layout.source()).toBe('layered');
    // A later preload is a new attempt (the failed one does not stick).
    await h.layout.preload();
  });

  it('two preloads at once share one load and one warm-up', async () => {
    const h = harness();
    const a = h.layout.preload();
    const b = h.layout.preload();
    await Promise.all([a, b]);
    await h.layout.preload();
    expect(h.loads()).toBe(1);
    expect(h.stats.warms).toBe(1);
  });

  it('a preload and a pass at the same time never overlap at the engine; both resolve', async () => {
    const h = harness();
    const pre = h.layout.preload();
    h.layout.update(graph());
    await pre;
    await h.layout.settled();
    expect(h.layout.source()).toBe('layered');
    expect(h.stats.maxActive).toBe(1);
    expect(h.loads()).toBe(1);
  });
});

describe('layout preload goes away with the cockpit', () => {
  it('cancelled before the idle callback fires: no load, no worker, no report', async () => {
    const h = harness();
    const states: PreloadState[] = [];
    const idle = syncIdle();
    const cancel = scheduleLayoutPreload(() => h.layout.preload(), (s) => states.push(s), idle);
    cancel();
    h.layout.dispose();
    idle.fire();
    await tick(20);
    expect(idle.cancelled).toBe(true);
    expect(h.loads()).toBe(0);
    expect(h.stats.made).toBe(0);
    expect(states).toEqual([]);
  });

  it('a preload that resolves after cancellation reports nothing', async () => {
    const states: PreloadState[] = [];
    const idle = syncIdle();
    let resolve!: () => void;
    const cancel = scheduleLayoutPreload(() => new Promise<void>((r) => (resolve = r)), (s) => states.push(s), idle);
    idle.fire();
    cancel();
    resolve();
    await tick();
    expect(states).toEqual([]);
  });

  it('disposed after the warm-up: the worker is terminated and later loads refuse', async () => {
    const h = harness();
    await h.layout.preload();
    expect(h.stats.made).toBe(1);
    h.layout.dispose();
    await tick();
    expect(h.stats.terminated).toBe(1);
    // Later topology changes do nothing: no engine, nothing shown.
    h.layout.update(graph());
    await h.layout.settled();
    expect(h.layout.positions().size).toBe(0);
    expect(h.stats.made).toBe(1);
  });

  it('disposed during an active pass: the pass settles at once, nothing is applied, queued work never starts', async () => {
    const h = harness('ok', 'hang'); // the limit is far away: only the dispose can end the pass
    h.layout.update(graph());
    await tick(20);
    expect(h.stats.passes).toBe(1);
    expect(h.layout.source()).toBe('interim');
    // A newer topology waits behind the running pass.
    h.layout.update(smallerGraph());
    h.layout.dispose();
    const t0 = Date.now();
    await h.layout.settled();
    expect(Date.now() - t0).toBeLessThan(1000); // rejected at once, not at the 10 s limit
    await tick(50);
    expect(h.layout.source()).toBe('interim');
    expect(h.stats.passes).toBe(1);
    expect(h.stats.terminated).toBe(1);
    expect(h.stats.made).toBe(1);
  });
});

describe('layout passes on the worker path', () => {
  afterEach(() => vi.useRealTimers());

  it('a pass queued behind a hanging warm-up is released at the time limit and runs on a fresh worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness('hang', 'ok', 50);
    const pre = h.layout.preload().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(10); // the warm-up is now hanging on the first worker
    h.layout.update(graph()); // submitted before the warm-up times out
    await vi.advanceTimersByTimeAsync(30);
    expect(h.layout.source()).toBe('interim');
    expect(h.stats.passes).toBe(0);
    expect(h.stats.made).toBe(1);
    await vi.advanceTimersByTimeAsync(20); // past the 50 ms limit
    expect(await pre).toMatch(/timed out/);
    expect(h.stats.terminated).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.stats.made).toBe(2);
    expect(h.stats.passes).toBe(1);
    expect(h.layout.source()).toBe('layered');
  });

  it('a normal pass that rejects: the fallback layout stands and the worker is terminated', async () => {
    const h = harness('ok', 'reject');
    h.layout.update(graph());
    await h.layout.settled();
    expect(h.layout.source()).toBe('fallback');
    expect(h.layout.reason()).toMatch(/layered pass failed: pass crashed/);
    expect(h.stats.terminated).toBe(1);
  });
});
