// WP-P: the upstream link's state travels to the browser — the direct
// upstream records loss and reconnection, the BFF carries it as
// `upstream-status` events (no judgment), and a reconnect brings a new snapshot.
import { describe, expect, it } from 'vitest';
import type { UpstreamStatus, WorkspaceUpstream } from '@gunnflow/upstream-port';
import { createFakeUpstream } from '@gunnflow-testing/fake-contracts';
import { startFakeDirectServer } from '@gunnflow-testing/fake-contracts/direct-server';
import { createDirectUpstream } from '../src/direct-upstream.js';
import { buildServer } from '../src/server.js';

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('direct upstream link state', () => {
  it('goes unreachable when the backend drops, and back to connected — with a fresh snapshot — when it returns', async () => {
    const ref = await startFakeDirectServer();
    const u = await createDirectUpstream(ref.url, { reconnectMs: 30 });
    try {
      expect(u.status!()).toMatchObject({ connected: true });
      const seen: UpstreamStatus[] = [];
      u.subscribeStatus!((s) => seen.push(s));
      const nodes = () => ((u.snapshot().body as { nodes: { id: string }[] }).nodes ?? []).map((n) => n.id);
      expect(nodes()).not.toContain('g-publish');
      await ref.restart(150, 'gates');
      await until(() => seen.some((s) => s.connected) && nodes().includes('g-publish'));
      expect(seen.map((s) => s.connected)).toEqual([false, true]);
      expect(Date.parse(seen[0]!.since)).toBeLessThanOrEqual(Date.parse(seen[1]!.since));
      expect(u.status!().connected).toBe(true);
    } finally {
      u.close();
      await ref.close();
    }
  });
});

describe('BFF carries the upstream link state', () => {
  it('sends the current state right after the snapshot, then every change, as upstream-status events', async () => {
    let status: UpstreamStatus = { connected: true, since: '2026-01-01T00:00:00.000Z' };
    const listeners = new Set<(s: UpstreamStatus) => void>();
    const fake = createFakeUpstream('normal');
    const upstream: WorkspaceUpstream = {
      ...fake,
      status: () => status,
      subscribeStatus: (l) => (listeners.add(l), () => listeners.delete(l)),
    };
    const app = buildServer({ upstream });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const ctrl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace/stream`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      let text = '';
      const read = async (needle: string) => {
        while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
      };
      await read('event: upstream-status');
      expect(text.indexOf('event: snapshot')).toBeLessThan(text.indexOf('event: upstream-status'));
      expect(text).toContain('"connected":true');
      status = { connected: false, since: '2026-01-01T00:05:00.000Z' };
      for (const l of listeners) l(status);
      await read('"connected":false');
      expect(text).toContain('"since":"2026-01-01T00:05:00.000Z"');
    } finally {
      ctrl.abort();
      await app.close();
    }
  });
});

describe('manual refresh', () => {
  it('direct: drops even a live stream and re-opens it without an unreachable blip; re-fetches and broadcasts the snapshot', async () => {
    const ref = await startFakeDirectServer();
    const u = await createDirectUpstream(ref.url, { reconnectMs: 5_000 });
    try {
      const statuses: boolean[] = [];
      u.subscribeStatus!((s) => statuses.push(s.connected));
      let broadcasts = 0;
      u.subscribe(() => broadcasts++);
      ref.loadFixture('gates');
      await until(() => broadcasts > 0);
      const before = broadcasts;
      expect(await u.refresh!()).toEqual({ ok: true });
      expect(broadcasts).toBeGreaterThan(before);
      await new Promise((r) => setTimeout(r, 100));
      expect(statuses).toEqual([]);
      expect(u.status!().connected).toBe(true);
    } finally {
      u.close();
      await ref.close();
    }
  });

  it('direct: pressed while unreachable, it retries at once (not after the reconnect delay) and reports why if still down', async () => {
    const ref = await startFakeDirectServer();
    const u = await createDirectUpstream(ref.url, { reconnectMs: 60_000 });
    try {
      const outage = ref.restart(300);
      await until(() => !u.status!().connected);
      const down = await u.refresh!();
      expect(down.ok).toBe(false);
      await outage;
      // Back up: the next refresh reconnects immediately despite the 60 s reconnect delay.
      expect(await u.refresh!()).toEqual({ ok: true });
      await until(() => u.status!().connected, 2000);
    } finally {
      u.close();
      await ref.close();
    }
  });

  it('BFF route: pulls the upstream refresh and answers with the resulting status (fake: a re-broadcast)', async () => {
    const fake = createFakeUpstream('normal');
    let pushed = 0;
    fake.subscribe(() => pushed++);
    const app = buildServer({ upstream: fake });
    const res = await app.inject({ method: 'POST', url: '/api/workspace/refresh' });
    expect(res.json()).toMatchObject({ refreshed: true, status: { connected: true } });
    expect(pushed).toBe(1);
    await app.close();
  });
});
