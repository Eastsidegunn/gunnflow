/**
 * The simulator speaking the contract's direct wire (packages/contract/WIRE.md):
 * the reference server for the BFF's `direct` upstream. It validates intents
 * with the contract's own validator before the simulator sees them, as a
 * native backend must. `POST /_fake/fixture` and `POST /_fake/restart` are
 * test controls, not wire.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  DIRECT_WIRE,
  lookupCapability,
  validateExecutionSnapshot,
  validateIntent,
  type DirectSnapshot,
  type ExecutionSnapshot,
  type NodeProjection,
} from '@gunnflow/contract';
import { toExecutionSnapshot, type FakeExecutionProjection } from './execution.js';
import { FAKE_EXECUTIONS } from './executionFixtures.js';
import type { FixtureName } from './fixtures.js';
import { createFakeUpstream } from './upstreamAdapter.js';

export interface FakeDirectServer {
  url: string;
  close(): Promise<void>;
  loadFixture(name: FixtureName): void;
  restart(downMs: number, fixture?: FixtureName): Promise<void>;
  /** Test control: append N synthetic events to a task's execution stream (in-process, not wire). */
  burstExecution(taskId: string, count: number): void;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeDirectServer(
  options: { port?: number; host?: string; fixture?: FixtureName } = {},
): Promise<FakeDirectServer> {
  const upstream = createFakeUpstream(options.fixture ?? 'normal');
  const snapshot = (): DirectSnapshot => {
    const e = upstream.snapshot();
    return { revision: e.revision, nodes: (e.body as { nodes: NodeProjection[] }).nodes };
  };
  // WIRE.md §execution: a validated contract snapshot, as a native backend must serve it.
  // Unknown tasks are 404 (undefined) — the reference wire holds executions for the fixture tasks only.
  const executionWire = (taskId: string): ExecutionSnapshot | undefined => {
    if (!(taskId in FAKE_EXECUTIONS)) return undefined;
    const rich = upstream.executionSnapshot(taskId) as FakeExecutionProjection;
    const checked = validateExecutionSnapshot(toExecutionSnapshot(rich));
    if (!checked.ok) throw new Error(`fake execution snapshot fails the contract: ${checked.problems.join('; ')}`);
    return checked.snapshot;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'GET' && path === DIRECT_WIRE.nodes) return json(res, 200, snapshot());
      if (req.method === 'GET' && path === DIRECT_WIRE.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = () => res.write(`event: ${DIRECT_WIRE.snapshotEvent}\ndata: ${JSON.stringify(snapshot())}\n\n`);
        send();
        const unsubscribe = upstream.subscribe(send);
        const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
        req.on('close', () => {
          unsubscribe();
          clearInterval(keepalive);
        });
        return;
      }
      if (req.method === 'POST' && path === DIRECT_WIRE.intent) {
        const intent = await readJson(req);
        const actor = String(req.headers[DIRECT_WIRE.actorHeader] ?? '');
        const i = intent as { nodeId?: unknown; action?: unknown } | undefined;
        const node = snapshot().nodes.find((n) => n.id === i?.nodeId);
        const check = validateIntent(intent, lookupCapability(node, typeof i?.action === 'string' ? i.action : ''));
        if (!check.ok) return json(res, 200, { accepted: false, reason: check.reason });
        const result = await upstream.relayIntent(intent, actor);
        return json(res, 200, result.reason === undefined ? { accepted: result.accepted } : result);
      }
      const detail = req.method === 'GET' ? /^\/detail\/([^/]+)$/.exec(path) : null;
      if (detail) {
        // WIRE.md: 501 = this wire does not serve detail at all; 404 = no detail for this node.
        if (!upstream.nodeDetail) return json(res, 501, { reason: 'detail is not served on this wire' });
        const d = await upstream.nodeDetail(decodeURIComponent(detail[1]!));
        if (!d) return json(res, 404, { reason: 'no detail for this node' });
        return json(res, 200, d);
      }
      const executionStream = req.method === 'GET' ? /^\/execution\/([^/]+)\/stream$/.exec(path) : null;
      if (executionStream) {
        // WIRE.md: SSE of `snapshot` events, each a FULL ExecutionSnapshot — the /stream republish grammar.
        // NOTE: this 501 guard is unreachable today (the port requires executionSnapshot); kept to mirror the detail guard.
        if (!upstream.executionSnapshot) return json(res, 501, { reason: 'execution is not served on this wire' });
        const taskId = decodeURIComponent(executionStream[1]!);
        if (executionWire(taskId) === undefined) return json(res, 404, { reason: 'no execution for this task' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = () => res.write(`event: ${DIRECT_WIRE.snapshotEvent}\ndata: ${JSON.stringify(executionWire(taskId))}\n\n`);
        send();
        const unsubscribe = upstream.subscribeExecution(taskId, send);
        const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
        req.on('close', () => {
          unsubscribe();
          clearInterval(keepalive);
        });
        return;
      }
      const execution = req.method === 'GET' ? /^\/execution\/([^/]+)$/.exec(path) : null;
      if (execution) {
        // WIRE.md: 501 = this wire does not serve execution at all; 404 = no execution for this task.
        // NOTE: this 501 guard is unreachable today (the port requires executionSnapshot); kept to mirror the detail guard.
        if (!upstream.executionSnapshot) return json(res, 501, { reason: 'execution is not served on this wire' });
        const snap = executionWire(decodeURIComponent(execution[1]!));
        if (!snap) return json(res, 404, { reason: 'no execution for this task' });
        return json(res, 200, snap);
      }
      const artifact = req.method === 'GET' ? /^\/artifact\/([^/]+)\/([^/]+)$/.exec(path) : null;
      if (artifact) {
        const snap = upstream.artifactSnapshot?.(decodeURIComponent(artifact[1]!), decodeURIComponent(artifact[2]!));
        if (!snap || snap instanceof Promise) return json(res, 404, { reason: 'no bytes for this artifact version' });
        res.writeHead(200, { 'content-type': snap.mediaType });
        return res.end(Buffer.from(snap.bytesBase64, 'base64'));
      }
      if (req.method === 'POST' && path === '/_fake/restart') {
        // An outage: stop listening and drop every connection, then come back after `downMs`
        // (optionally on another fixture, so the first snapshot after the outage is new).
        const { downMs = 1000, fixture } = ((await readJson(req)) ?? {}) as { downMs?: number; fixture?: FixtureName };
        json(res, 200, { restarting: true, downMs });
        setTimeout(() => {
          server.closeAllConnections();
          server.close(() => {
            if (fixture) upstream.loadFixture(fixture);
            setTimeout(() => server.listen(port, host), Math.max(0, Math.min(60_000, downMs)));
          });
        }, 20);
        return;
      }
      if (req.method === 'POST' && path === '/_fake/fixture') {
        const { name } = ((await readJson(req)) ?? {}) as { name?: FixtureName };
        if (!name) return json(res, 400, { reason: 'fixture name required' });
        upstream.loadFixture(name);
        return json(res, 200, { ok: true });
      }
      json(res, 404, { reason: 'not on the direct wire' });
    })().catch((err: unknown) => json(res, 500, { reason: String(err) }));
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://${host}:${port}`,
    loadFixture: (name) => upstream.loadFixture(name),
    burstExecution: (taskId, count) => upstream.burstExecution(taskId, count),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
    /** Test control: an outage of `downMs`, as POST /_fake/restart does. */
    async restart(downMs: number, fixture?: FixtureName) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      if (fixture) upstream.loadFixture(fixture);
      await new Promise((r) => setTimeout(r, downMs));
      await new Promise<void>((r) => server.listen(port, host, r));
    },
  };
}
