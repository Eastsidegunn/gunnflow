/**
 * Gunnflow BFF. Allowed: subscription fan-out, snapshot + tail, coalescing,
 * transport normalization, auth/session handling. Forbidden: any new judgment
 * (priority, risk, blocked/progress inference, approval, policy).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { validateNodeDetail, type NodeDetail } from '@gunnflow/contract';
import { UnsupportedDetail, type UpstreamUnsupported, type WorkspaceUpstream } from '@gunnflow/upstream-port';
import { readUserWiring, readWiringDir, removeUserWiring, userWiringProblem, writeUserWiring } from './wiringFiles.js';
import { personalStructureProblem, readPersonal, writePersonal } from './personalStore.js';
import { prefsStructureProblem, readPrefs, writePrefs } from './prefsStore.js';
import { PERSONAL_SOURCE_MAX_CHARS, type PersonalRenders } from './personalRender.js';

function isUnsupported(v: unknown): v is UpstreamUnsupported {
  return typeof v === 'object' && v !== null && typeof (v as UpstreamUnsupported).unsupported === 'string';
}

/** G2: no API shape may carry raw credentials. Reject payloads that try. */
const CREDENTIAL_KEYS = /^(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)$/i;

export function findCredentialShapedKey(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredentialShapedKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (CREDENTIAL_KEYS.test(k)) return p;
      const hit = findCredentialShapedKey(v, p);
      if (hit) return hit;
    }
  }
  return null;
}

export interface BuildServerOptions {
  upstream: WorkspaceUpstream;
  /** Test-only fixture switching; only wired when the fake upstream is in use. */
  loadFixture?: (name: string) => void;
  /** Test-only execution burst generator (perf/live-tail scenarios). */
  burstExecution?: (taskId: string, count: number) => void;
  /** Test-only PTY burst generator. */
  burstPty?: (sessionId: string, count: number) => void;
  /** Test-only upstream-declared stream gap. */
  gapStream?: (sessionId: string, count: number) => void;
  /** SSE coalescing window in ms — bursts collapse to the latest projection. */
  coalesceMs?: number;
  /** Directory of wiring config files; absent directory = no files. */
  wiringDir?: string;
  /** The composition root's label for the upstream (`fake`, `direct → <url>`). */
  upstreamLabel?: string;
  /** The personal layer's local file for this workspace (never sent upstream). */
  personalFile?: string;
  /** Machine-local preferences file (ergonomics; never sent upstream). */
  prefsFile?: string;
  /** Renders personal mermaid sources (shared with the isolated origin, which serves the SVGs). */
  personalRenders?: PersonalRenders;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const { upstream, coalesceMs = 50 } = opts;
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ ok: true }));

  // The personal layer: a local file, read and written as-is. It has no route to the upstream.
  app.get('/api/personal', async (_req, reply) => {
    if (!opts.personalFile) return reply.code(501).send({ reason: 'no personal store configured' });
    const r = readPersonal(opts.personalFile);
    return r.ok ? { doc: r.doc } : reply.code(409).send({ reason: r.reason });
  });
  app.put('/api/personal', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    if (!opts.personalFile) return reply.code(501).send({ reason: 'no personal store configured' });
    const doc = req.body;
    const problem = personalStructureProblem(doc, Buffer.byteLength(JSON.stringify(doc ?? null)));
    if (problem) return reply.code(400).send({ reason: problem });
    // Never overwrite a file that cannot be read: it may hold the person's notes.
    const current = readPersonal(opts.personalFile);
    if (!current.ok) return reply.code(409).send({ reason: current.reason });
    writePersonal(opts.personalFile, doc);
    return { saved: true };
  });

  // Machine-local preferences: carried as-is; meaning is the web's business. Never upstream.
  app.get('/api/prefs', async (_req, reply) => {
    if (!opts.prefsFile) return reply.code(501).send({ reason: 'no prefs store configured' });
    const r = readPrefs(opts.prefsFile);
    return r.ok ? { prefs: r.prefs } : reply.code(409).send({ reason: r.reason });
  });
  app.put('/api/prefs', { bodyLimit: 128 * 1024 }, async (req, reply) => {
    if (!opts.prefsFile) return reply.code(501).send({ reason: 'no prefs store configured' });
    const doc = req.body;
    const problem = prefsStructureProblem(doc, Buffer.byteLength(JSON.stringify(doc ?? null)));
    if (problem) return reply.code(400).send({ reason: problem });
    const current = readPrefs(opts.prefsFile);
    if (!current.ok) return reply.code(409).send({ reason: current.reason });
    writePrefs(opts.prefsFile, doc);
    return { saved: true };
  });

  // A personal mermaid source → SVG on the isolated origin (by source hash). Bound to no artifact, nothing upstream.
  app.post('/api/personal/render-mermaid', async (req, reply) => {
    const source = (req.body as { source?: unknown } | null)?.source;
    if (typeof source !== 'string' || source.length === 0 || source.length > PERSONAL_SOURCE_MAX_CHARS) {
      return reply.code(400).send({ reason: `source must be a non-empty string up to ${PERSONAL_SOURCE_MAX_CHARS} characters` });
    }
    if (!opts.personalRenders) return reply.code(503).send({ reason: 'no mermaid renderer configured' });
    const { hash, result } = await opts.personalRenders.render(source);
    if (!result.ok) return reply.code(422).send({ hash, reason: result.reason });
    return { hash, svgPath: `/personal-render/${hash}` };
  });

  // Wiring config files, carried as-is in file-name order; the web validates and merges them.
  app.get('/api/wiring', async () => readWiringDir(opts.wiringDir));

  // The settings screen's wiring file: only <wiringDir>/90-user.json is ever read or written here.
  app.get('/api/wiring/user', async (_req, reply) => {
    if (!opts.wiringDir) return reply.code(501).send({ reason: 'no wiring directory configured' });
    const r = readUserWiring(opts.wiringDir);
    return r.ok ? { config: r.config } : reply.code(409).send({ reason: r.reason });
  });
  app.put('/api/wiring/user', async (req, reply) => {
    if (!opts.wiringDir) return reply.code(501).send({ reason: 'no wiring directory configured' });
    const problem = userWiringProblem(req.body);
    if (problem) return reply.code(400).send({ reason: problem });
    writeUserWiring(opts.wiringDir, req.body);
    return { saved: true };
  });
  app.delete('/api/wiring/user', async (_req, reply) => {
    if (!opts.wiringDir) return reply.code(501).send({ reason: 'no wiring directory configured' });
    removeUserWiring(opts.wiringDir);
    return { removed: true };
  });

  // Which upstream this BFF is wired to (its composition label), for the settings screen.
  app.get('/api/upstream', async () => ({ label: opts.upstreamLabel ?? null }));

  // Snapshot + tail over SSE. The BFF forwards projections verbatim.
  app.get('/api/workspace/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const write = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    write('snapshot', upstream.snapshot());
    // The upstream connection's state, now and on every change — carried as a fact.
    if (upstream.status) write('upstream-status', upstream.status());
    const unsubscribeStatus = upstream.subscribeStatus?.((s) => write('upstream-status', s));

    // Coalescing/backpressure path (acceptance H): keep only the latest
    // projection during a burst and flush at most once per window.
    let pending: unknown = null;
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (pending !== null) {
        const p = pending;
        pending = null;
        write('projection', p);
      }
    };
    const unsubscribe = upstream.subscribe((p) => {
      pending = p;
      if (!timer) timer = setTimeout(flush, coalesceMs);
    });
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);

    req.raw.on('close', () => {
      unsubscribe();
      unsubscribeStatus?.();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      reply.raw.end();
    });
  });

  // Manual refresh: the upstream re-opens its connection and re-broadcasts its snapshot. A pull, not a write.
  app.post('/api/workspace/refresh', async () => {
    if (!upstream.refresh) return { refreshed: false, reason: 'this upstream has no manual refresh', status: upstream.status?.() ?? null };
    const result = await upstream.refresh();
    return result.ok
      ? { refreshed: true, status: upstream.status?.() ?? null }
      : { refreshed: false, reason: result.reason, status: upstream.status?.() ?? null };
  });

  // One node's on-demand detail: fetched when a person opens it, carried
  // verbatim after the contract's shape check. An upstream without the surface
  // answers 501, stated — never an empty normal answer (invariant 2).
  app.get('/api/node/:nodeId/detail', async (req, reply) => {
    if (!upstream.nodeDetail) return reply.code(501).send({ reason: 'detail is not served by this upstream' });
    const { nodeId } = req.params as { nodeId: string };
    let detail: NodeDetail | undefined;
    try {
      detail = await upstream.nodeDetail(nodeId);
    } catch (err) {
      // Support discovered missing at call time (the direct wire answering 501).
      if (err instanceof UnsupportedDetail) return reply.code(501).send({ reason: 'detail is not served by this upstream' });
      // Transport-level failure: a carried reason, not an anonymous 500.
      return reply.code(502).send({ reason: `detail unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (detail === undefined) return reply.code(404).send({ reason: 'no detail for this node' });
    const checked = validateNodeDetail(detail);
    if (!checked.ok) return reply.code(502).send({ reason: `upstream detail fails the contract: ${checked.problems.join('; ')}` });
    return checked.detail;
  });

  // Execution telemetry: snapshot + tail per task, coalesced. The BFF forwards
  // upstream deltas verbatim — no interpretation, no health scores. An upstream
  // without the surface answers 501, stated; a task without execution 404; a
  // transport or contract failure a reasoned 502 — never an anonymous 500.
  app.get('/api/execution/:taskId/stream', (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    // Registered BEFORE any await: a client that disconnects during the
    // upstream round-trip must not leak the subscription or the heartbeat.
    let clientGone = false;
    let shutdown: () => void = () => undefined;
    req.raw.on('close', () => {
      clientGone = true;
      shutdown();
    });
    void (async () => {
      let snapshot: unknown;
      try {
        snapshot = await upstream.executionSnapshot(taskId);
      } catch (err) {
        if (clientGone) return;
        return reply.code(502).send({ reason: `execution unavailable: ${err instanceof Error ? err.message : String(err)}` });
      }
      if (clientGone) return;
      const sseHead = () =>
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
      const write = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // Unsupported/absent is a stated condition, not a transport loss: an
      // EventSource cannot read a non-200, so it is said as one terminal
      // `end` frame and the stream closes (invariant 2 — never a silent open
      // connection that looks like "nothing yet", never a fake outage).
      if (isUnsupported(snapshot) || snapshot === undefined) {
        sseHead();
        write('end', { reason: isUnsupported(snapshot) ? 'unsupported' : 'none' });
        reply.raw.end();
        return;
      }
      sseHead();
      write('snapshot', snapshot);

      // Coalesce bursts: batch event deltas per window, keep the latest session
      // update and the latest full-snapshot republish (a snapshot is a full
      // replace downstream, so only the newest matters).
      let pendingEvents: unknown[] = [];
      const pendingSessions = new Map<string, unknown>();
      let pendingSnapshot: unknown = null;
      let timer: NodeJS.Timeout | null = null;
      const flush = () => {
        timer = null;
        if (pendingSnapshot !== null) {
          write('snapshot', pendingSnapshot);
          pendingSnapshot = null;
        }
        if (pendingEvents.length > 0) {
          write('events', pendingEvents);
          pendingEvents = [];
        }
        for (const s of pendingSessions.values()) write('session', s);
        pendingSessions.clear();
      };
      let endSeen = false;
      const unsubscribe = upstream.subscribeExecution(taskId, (delta) => {
        const d = delta as { type: string; events?: unknown[]; session?: { id: string }; snapshot?: unknown };
        if (d.type === 'end') {
          // The upstream tail ended for good: close the downstream SSE so the
          // browser sees the loss instead of a frozen LIVE.
          endSeen = true;
          shutdown();
          return;
        }
        if (d.type === 'events' && d.events) pendingEvents.push(...d.events);
        else if (d.type === 'session' && d.session) pendingSessions.set(d.session.id, d.session);
        else if (d.type === 'snapshot' && d.snapshot !== undefined) pendingSnapshot = d.snapshot;
        if (!timer) timer = setTimeout(flush, coalesceMs);
      });
      const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
      let ended = false;
      shutdown = () => {
        if (ended) return;
        ended = true;
        unsubscribe();
        clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        reply.raw.end();
      };
      // The client may have vanished — or the tail ended — while wiring up.
      if (clientGone || endSeen) shutdown();
    })();
  });

  // PTY relay: snapshot + tail per session. The BFF is a wire, never a shell —
  // it executes nothing and synthesizes no terminal output.
  // A surface the upstream does not provide answers 501 with its reason — never
  // an open, silent connection that looks like "nothing yet".
  app.get('/api/terminal/:sessionId/stream', (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const snapshot = upstream.terminalSnapshot(sessionId);
    if (isUnsupported(snapshot)) return reply.code(501).send(snapshot);
    let pendingLines: unknown[] = [];
    let pendingSession: unknown = null;
    let timer: NodeJS.Timeout | null = null;
    const subscribed = upstream.subscribeTerminal(sessionId, (delta) => {
      const d = delta as { type: string; events?: unknown[]; session?: unknown };
      if (d.type === 'pty' && d.events) pendingLines.push(...d.events);
      else if (d.type === 'session') pendingSession = d.session;
      if (!timer) timer = setTimeout(() => flush(), coalesceMs);
    });
    if (isUnsupported(subscribed)) return reply.code(501).send(subscribed);
    const unsubscribe = subscribed;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const write = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    write('snapshot', snapshot);
    const flush = () => {
      timer = null;
      if (pendingLines.length > 0) {
        write('pty', pendingLines);
        pendingLines = [];
      }
      if (pendingSession) {
        write('session', pendingSession);
        pendingSession = null;
      }
    };
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
    req.raw.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      reply.raw.end();
    });
  });

  // Human intent relay. The BFF stamps the actor (auth/session handling is its
  // job) and forwards; acceptance and reasons come from upstream only.
  app.post('/api/intent', async (req, reply) => {
    // Carried, not validated: the schema belongs to the contract (checked by the cockpit and the backend).
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ accepted: false, reason: 'malformed intent' });
    }
    const credentialKey = findCredentialShapedKey(body);
    if (credentialKey) {
      return reply.code(400).send({
        accepted: false,
        reason: `credential-shaped field '${credentialKey}' — Gunnflow never accepts raw credentials`,
      });
    }
    // BLOCKED.md #4 (OIDC): fake actor until a real IdP is attached.
    const actor = 'fake-actor:local-dev';
    const result = await upstream.relayIntent(body, actor);
    return reply.code(result.accepted ? 202 : 409).send(result);
  });

  // Stream channel: carries upstream stream events one-for-one. The BFF never
  // drops, merges, or declares gaps. Buffering is bounded to the one event
  // whose write() returned false: another event before 'drain', or a socket
  // error, closes the connection and the browser takes the reconnect/resync path.
  app.get('/api/stream/:nodeId/:streamId', (req, reply) => {
    const { nodeId, streamId } = req.params as { nodeId: string; streamId: string };
    const query = req.query as { lastEventId?: string };
    const rawLast = req.headers['last-event-id'] ?? query.lastEventId;
    const parsed = typeof rawLast === 'string' && /^\d+$/.test(rawLast) ? Number(rawLast) : null;
    let closed = false;
    // Events arriving during subscribe (the resync) wait until headers are decided.
    let early: string[] | null = [];
    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      reply.raw.destroy();
    };
    let congested = false;
    const send = (text: string) => {
      if (closed) return;
      if (early) {
        early.push(text);
        return;
      }
      if (congested) return close();
      try {
        if (!reply.raw.write(text)) {
          congested = true;
          reply.raw.once('drain', () => {
            congested = false;
          });
        }
      } catch {
        close();
      }
    };
    const subscribed = upstream.subscribeStream(nodeId, streamId, parsed, (event) => {
      const e = event as { type?: string; chunks?: { seq: number }[]; toSeq?: number };
      const last = e.type === 'gap' ? e.toSeq : e.chunks?.at(-1)?.seq;
      const id = typeof last === 'number' ? `id: ${last}\n` : '';
      send(`${id}event: stream\ndata: ${JSON.stringify(event)}\n\n`);
    });
    if (isUnsupported(subscribed)) return reply.code(501).send(subscribed);
    unsubscribe = subscribed;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.on('error', close);
    const buffered = early;
    early = null;
    for (const text of buffered) send(text);
    heartbeat = setInterval(() => send(': keepalive\n\n'), 15_000);
    req.raw.on('close', close);
  });

  if (opts.loadFixture) {
    // Test-only escape hatch for e2e scenario switching. Never a production route.
    app.post('/api/_fake/fixture', async (req, reply) => {
      const { name } = (req.body ?? {}) as { name?: string };
      if (!name) return reply.code(400).send({ ok: false });
      opts.loadFixture!(name);
      return { ok: true, name };
    });
  }
  if (opts.burstExecution) {
    app.post('/api/_fake/execution-burst', async (req, reply) => {
      const { taskId, count } = (req.body ?? {}) as { taskId?: string; count?: number };
      if (!taskId || !count) return reply.code(400).send({ ok: false });
      opts.burstExecution!(taskId, Math.min(count, 20_000));
      return { ok: true };
    });
  }
  if (opts.burstPty) {
    app.post('/api/_fake/pty-burst', async (req, reply) => {
      const { sessionId, count } = (req.body ?? {}) as { sessionId?: string; count?: number };
      if (!sessionId || !count) return reply.code(400).send({ ok: false });
      opts.burstPty!(sessionId, Math.min(count, 50_000));
      return { ok: true };
    });
  }

  if (opts.gapStream) {
    app.post('/api/_fake/stream-gap', async (req, reply) => {
      const { sessionId, count } = (req.body ?? {}) as { sessionId?: string; count?: number };
      if (!sessionId || !count) return reply.code(400).send({ ok: false });
      opts.gapStream!(sessionId, Math.min(count, 50_000));
      return { ok: true };
    });
  }

  return app;
}
