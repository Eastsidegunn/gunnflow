// The unfamiliar backend speaks the contract: its snapshot validates, and its own
// action changes its own state (no simulator vocabulary anywhere).
import { DIRECT_WIRE, snapshotProblem } from '@gunnflow/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STRANGE_OPEN, startStrangeServer, type StrangeServer } from '../src/strangeServer.js';

let server: StrangeServer;
beforeAll(async () => {
  server = await startStrangeServer();
});
afterAll(() => server.close());

const nodes = async () => (await (await fetch(`${server.url}${DIRECT_WIRE.nodes}`)).json()) as {
  revision: number;
  nodes: { id: string; kind: string; state: { value: string }; attention: unknown[] }[];
};

describe('strange server', () => {
  it('serves a snapshot that passes the contract, in its own words', async () => {
    await server.reset();
    const snap = await nodes();
    expect(snapshotProblem(snap)).toBeNull();
    expect(new Set(snap.nodes.map((n) => n.kind))).toEqual(new Set(['board', 'ticket']));
  });

  it('ticket.close flips the ticket to done and clears its ping', async () => {
    await server.reset();
    const before = await nodes();
    const res = await fetch(`${server.url}${DIRECT_WIRE.intent}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DIRECT_WIRE.actorHeader]: 'tester' },
      body: JSON.stringify({ nodeId: STRANGE_OPEN, action: 'ticket.close', idempotencyKey: 'k-close-1' }),
    });
    expect(await res.json()).toEqual({ accepted: true });
    const after = await nodes();
    const t = after.nodes.find((n) => n.id === STRANGE_OPEN)!;
    expect(t.state.value).toBe('done');
    expect(t.attention).toEqual([]);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('reset { empty } serves zero nodes', async () => {
    await server.reset({ empty: true });
    const snap = await nodes();
    expect(snapshotProblem(snap)).toBeNull();
    expect(snap.nodes).toEqual([]);
  });
});
