// The direct wire's optional detail surface, served by the reference server:
// 200 NodeDetail for nodes with a detail source, 404 for every other node.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateNodeDetail } from '@gunnflow/contract';
import { startFakeDirectServer, type FakeDirectServer } from '../src/directServer.js';

let ref: FakeDirectServer;
beforeAll(async () => {
  ref = await startFakeDirectServer({ fixture: 'attention' });
});
afterAll(async () => {
  await ref.close();
});

describe('GET /detail/:nodeId (reference server)', () => {
  it('serves the fixture detail sources as valid NodeDetail (200)', async () => {
    const gate = await fetch(`${ref.url}/detail/g-publish`);
    expect(gate.status).toBe(200);
    const gateDetail = (await gate.json()) as { revision: number; items: unknown[] };
    expect(validateNodeDetail(gateDetail).ok).toBe(true);
    expect(gateDetail.items).toEqual([
      { label: 'requested', text: 'Publish the landing page externally' },
      { label: 'impact', text: 'The page becomes publicly visible.' },
      { label: 'recommendation', text: 'Approve after reviewing the evidence.' },
    ]);

    const root = await fetch(`${ref.url}/detail/workspace`);
    expect(root.status).toBe(200);
    const rootDetail = (await root.json()) as { items: unknown[] };
    expect(validateNodeDetail(rootDetail).ok).toBe(true);
    // The attention fixture's counts, verbatim.
    expect(rootDetail.items).toEqual([
      { label: 'running', text: '1' },
      { label: 'needsYou', text: '1' },
      { label: 'blocked', text: '0' },
    ]);

    const task = await fetch(`${ref.url}/detail/t-build`);
    expect(task.status).toBe(200);
    expect(((await task.json()) as { items: unknown[] }).items).toEqual([{ label: 'progress', text: '41/42 tests' }]);
  });

  it('a node without a detail source (or no such node) answers 404 with a reason', async () => {
    for (const nodeId of ['t-draft', 'no-such-node']) {
      const res = await fetch(`${ref.url}/detail/${nodeId}`);
      expect(res.status, nodeId).toBe(404);
      expect(((await res.json()) as { reason: string }).reason).toBe('no detail for this node');
    }
  });
});
