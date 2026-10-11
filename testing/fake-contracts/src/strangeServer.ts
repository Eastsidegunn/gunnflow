/**
 * An unfamiliar backend on the direct wire (packages/contract/WIRE.md): a tiny
 * ticket board that shares NO vocabulary with the simulator — kinds `board` /
 * `ticket`, states `open` / `done`, relation `on`, attention cause `ping`,
 * actions `ticket.close` / `ticket.note` / `ticket.rewrite`. It exists so e2e
 * can tell a backend-agnostic cockpit from one that only knows the simulator.
 * It imports nothing from the simulator's fixtures. `POST /_strange/reset` is a
 * test control, not wire.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  DIRECT_WIRE,
  TERMINAL_SIZE_MAX,
  digestOfBody,
  isWireBase64,
  lookupCapability,
  validateExecutionSnapshot,
  validateIntent,
  type DirectSnapshot,
  type DirectTerminal,
  type ExecutionSnapshot,
  type Intent,
  type NodeDetail,
  type NodeProjection,
} from '@gunnflow/contract';

export const STRANGE_BOARD = 'b-1';
export const STRANGE_OPEN = 'k-1';
export const STRANGE_DONE = 'k-2';
export const STRANGE_NOTES = 'n-k1';
export const STRANGE_TERMINAL = 'tty-k1';
export const STRANGE_NOTES_BODY = '# Wobbly hinge\n\nThe left hinge squeaks.\n';
export const STRANGE_NOTES_MAX_BYTES = 4096;

export interface StrangeServer {
  url: string;
  close(): Promise<void>;
  /** Test control: the initial board, or a board with zero nodes. */
  reset(options?: { empty?: boolean }): Promise<void>;
  snapshot(): DirectSnapshot;
}

interface Ticket {
  id: string;
  label: string;
  summary: string;
  state: 'open' | 'done';
  pinged: boolean;
  notes: string[];
}

interface State {
  revision: number;
  empty: boolean;
  tickets: Ticket[];
  /** The open ticket's editable body: digest → bytes, every version kept (the address is the version). */
  bodies: Map<string, string>;
  bodyDigest: string;
  seenKeys: Set<string>;
}

async function initialState(empty: boolean): Promise<State> {
  const digest = await digestOfBody(STRANGE_NOTES_BODY);
  return {
    revision: 1,
    empty,
    tickets: [
      { id: STRANGE_OPEN, label: 'Wobbly hinge', summary: 'The left hinge squeaks', state: 'open', pinged: true, notes: [] },
      { id: STRANGE_DONE, label: 'Paint the fence', summary: 'Two coats, white', state: 'done', pinged: false, notes: [] },
    ],
    bodies: new Map([[digest, STRANGE_NOTES_BODY]]),
    bodyDigest: digest,
    seenKeys: new Set(),
  };
}

function project(s: State): DirectSnapshot {
  if (s.empty) return { revision: s.revision, nodes: [] };
  const board: NodeProjection = {
    id: STRANGE_BOARD,
    kind: 'board',
    label: 'Workshop board',
    state: { value: 'open' },
    relations: [],
    capabilities: [],
    attention: [],
    artifacts: [],
  };
  const tickets = s.tickets.map((t): NodeProjection => {
    const open = t.state === 'open';
    const editable = t.id === STRANGE_OPEN;
    return {
      id: t.id,
      kind: 'ticket',
      label: t.label,
      summary: t.summary,
      state: { value: t.state },
      relations: [{ type: 'on', target: STRANGE_BOARD }],
      capabilities: [
        { action: 'ticket.close', level: open ? 'enabled' : 'disabled' },
        { action: 'ticket.note', level: 'enabled', decision: { input: { required: true } } },
        ...(editable
          ? [{
              action: 'ticket.rewrite',
              level: 'enabled' as const,
              edit: { artifactId: STRANGE_NOTES, mediaTypes: ['text/markdown'], maxBytes: STRANGE_NOTES_MAX_BYTES },
            }]
          : []),
      ],
      attention: t.pinged ? [{ cause: 'ping' }] : [],
      artifacts: editable
        ? [{ id: STRANGE_NOTES, mediaType: 'text/markdown', digest: s.bodyDigest, access: { kind: 'snapshot' } }]
        : [],
    };
  });
  return { revision: s.revision, nodes: [board, ...tickets] };
}

function detailOf(s: State, nodeId: string): NodeDetail | undefined {
  const t = s.empty ? undefined : s.tickets.find((x) => x.id === nodeId);
  if (!t) return undefined;
  return {
    revision: s.revision,
    items: [
      { label: 'reporter', text: 'the caretaker' },
      ...t.notes.map((n, i) => ({ label: `note ${i + 1}`, text: n })),
    ],
  };
}

/** One recorded session for the open ticket — the only execution this backend holds. */
function executionOf(s: State, nodeId: string): ExecutionSnapshot | undefined {
  if (s.empty || nodeId !== STRANGE_OPEN) return undefined;
  const snap: ExecutionSnapshot = {
    sessions: [{ id: 'run-1', taskId: STRANGE_OPEN, state: 'running', label: 'hinge inspection', upstreamSessionState: 'looking' }],
    events: [
      { seq: 1, at: 1_760_000_000_000, sessionId: 'run-1', kind: 'look/start', label: 'opened the cupboard' },
      { seq: 2, at: 1_760_000_001_000, sessionId: 'run-1', kind: 'look/find', label: 'found the squeak', status: 'noted' },
    ],
  };
  const checked = validateExecutionSnapshot(snap);
  if (!checked.ok) throw new Error(`strange execution snapshot fails the contract: ${checked.problems.join('; ')}`);
  return checked.snapshot;
}

/** Applies an already-validated intent; a refusal is a reason. */
async function apply(s: State, intent: Intent): Promise<string | undefined> {
  const t = s.tickets.find((x) => x.id === intent.nodeId);
  if (!t) return 'no such ticket';
  if (intent.action === 'ticket.close') {
    if (t.state !== 'open') return 'the ticket is already done';
    t.state = 'done';
    t.pinged = false;
  } else if (intent.action === 'ticket.note') {
    const text = intent.decision?.text?.trim();
    if (!text) return 'a note needs text';
    t.notes.push(text);
  } else if (intent.action === 'ticket.rewrite') {
    const edit = intent.edit!;
    if (edit.baseDigest !== s.bodyDigest) return 'the notes changed since you opened them';
    if (new TextEncoder().encode(edit.body).length > STRANGE_NOTES_MAX_BYTES) return 'the notes are too long';
    const digest = await digestOfBody(edit.body);
    s.bodies.set(digest, edit.body);
    s.bodyDigest = digest;
  } else {
    return `unknown action '${intent.action}'`;
  }
  s.revision++;
  return undefined;
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

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** One opened (joined) terminal: an echo of what it is sent, its output retained. */
interface Joined {
  output: string;
  exited: boolean;
  listeners: Set<(frame: string) => void>;
}

export async function startStrangeServer(options: { port?: number; host?: string } = {}): Promise<StrangeServer> {
  let state = await initialState(false);
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((l) => l());
  const joined = new Map<string, Joined>();
  let nextJoin = 1;
  const E = DIRECT_WIRE.terminalEvents;
  const sizeOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= TERMINAL_SIZE_MAX;

  const terminalList = (): DirectTerminal[] =>
    state.empty
      ? []
      : [{ terminalId: STRANGE_TERMINAL, label: 'hinge console', kind: 'attachable', state: 'running', nodeId: STRANGE_OPEN }];

  const sse = (req: IncomingMessage, res: ServerResponse, first: () => string, subscribe: (send: () => void) => () => void) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = () => res.write(first());
    send();
    const unsubscribe = subscribe(send);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
    });
  };

  // WIRE.md §terminals: one attachable terminal; joining opens a new echo terminal.
  const serveTerminals = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (path === DIRECT_WIRE.terminals) {
      if (req.method === 'GET') return json(res, 200, terminalList());
      if (req.method === 'POST') {
        const body = (await readJson(req)) as { target?: { attach?: unknown; shell?: unknown }; cols?: unknown; rows?: unknown } | undefined;
        if (!body || !sizeOk(body.cols) || !sizeOk(body.rows) || !body.target) return json(res, 400, { reason: 'malformed terminal request' });
        if (body.target.shell !== undefined) return json(res, 422, { reason: 'this board opens no new shells' });
        if (!terminalList().some((t) => t.terminalId === body.target!.attach)) return json(res, 422, { reason: 'no such console' });
        const id = `${STRANGE_TERMINAL}~${nextJoin++}`;
        joined.set(id, { output: 'hinge console ready\r\n', exited: false, listeners: new Set() });
        return json(res, 200, { terminalId: id });
      }
      return json(res, 405, { reason: 'method not allowed' });
    }
    const m = /^\/terminals\/([^/]+)(\/stream|\/input|\/resize)?$/.exec(path);
    if (!m) return json(res, 404, { reason: 'not on the direct wire' });
    const t = joined.get(decodeURIComponent(m[1]!));
    if (!t) return json(res, 404, { reason: 'no such terminal' });
    const op = m[2];
    if (op === '/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`event: ${E.snapshot}\ndata: ${b64(t.output)}\n\n`);
      if (t.exited) {
        res.write(`event: ${E.exit}\ndata: ${JSON.stringify({ code: 0 })}\n\n`);
        return void res.end();
      }
      const l = (frame: string) => {
        res.write(frame);
        if (frame.startsWith(`event: ${E.exit}`)) res.end();
      };
      t.listeners.add(l);
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      req.on('close', () => {
        t.listeners.delete(l);
        clearInterval(keepalive);
      });
      return;
    }
    if (op === '/input' && req.method === 'POST') {
      const data = ((await readJson(req)) as { data?: unknown } | undefined)?.data;
      if (!isWireBase64(data)) return json(res, 400, { reason: 'malformed terminal input' });
      if (t.exited) return json(res, 409, { reason: 'the terminal has exited' });
      // Echo verbatim (CR → CRLF so a typed line ends a line).
      const text = Buffer.from(data, 'base64').toString('utf8').replace(/\r/g, '\r\n');
      t.output += text;
      t.listeners.forEach((l) => l(`event: ${E.data}\ndata: ${b64(text)}\n\n`));
      return void res.writeHead(204).end();
    }
    if (op === '/resize' && req.method === 'POST') {
      const body = (await readJson(req)) as { cols?: unknown; rows?: unknown } | undefined;
      if (!sizeOk(body?.cols) || !sizeOk(body?.rows)) return json(res, 400, { reason: 'malformed terminal size' });
      if (t.exited) return json(res, 409, { reason: 'the terminal has exited' });
      return void res.writeHead(204).end();
    }
    if (op === undefined && req.method === 'DELETE') {
      if (t.exited) return json(res, 409, { reason: 'the terminal has exited' });
      t.exited = true;
      t.listeners.forEach((l) => l(`event: ${E.exit}\ndata: ${JSON.stringify({ code: 0 })}\n\n`));
      return void res.writeHead(204).end();
    }
    return json(res, 405, { reason: 'method not allowed' });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'GET' && path === DIRECT_WIRE.nodes) return json(res, 200, project(state));
      if (req.method === 'GET' && path === DIRECT_WIRE.stream) {
        return sse(req, res, () => `event: ${DIRECT_WIRE.snapshotEvent}\ndata: ${JSON.stringify(project(state))}\n\n`, (send) => {
          listeners.add(send);
          return () => listeners.delete(send);
        });
      }
      if (req.method === 'POST' && path === DIRECT_WIRE.intent) {
        const intent = await readJson(req);
        const i = intent as { nodeId?: unknown; action?: unknown; idempotencyKey?: unknown } | undefined;
        const node = project(state).nodes.find((n) => n.id === i?.nodeId);
        const check = validateIntent(intent, lookupCapability(node, typeof i?.action === 'string' ? i.action : ''));
        if (!check.ok) return json(res, 200, { accepted: false, reason: check.reason });
        const key = String(i!.idempotencyKey);
        if (state.seenKeys.has(key)) return json(res, 200, { accepted: true });
        const refused = await apply(state, intent as Intent);
        if (refused) return json(res, 200, { accepted: false, reason: refused });
        state.seenKeys.add(key);
        json(res, 200, { accepted: true });
        // The effect arrives as the next snapshot, never in the response (WIRE.md §intent).
        return void setTimeout(publish, 50);
      }
      const detail = req.method === 'GET' ? /^\/detail\/([^/]+)$/.exec(path) : null;
      if (detail) {
        const d = detailOf(state, decodeURIComponent(detail[1]!));
        return d ? json(res, 200, d) : json(res, 404, { reason: 'no detail for this node' });
      }
      const execution = req.method === 'GET' ? /^\/execution\/([^/]+)(\/stream)?$/.exec(path) : null;
      if (execution) {
        const id = decodeURIComponent(execution[1]!);
        const snap = executionOf(state, id);
        if (!snap) return json(res, 404, { reason: 'no execution for this node' });
        if (!execution[2]) return json(res, 200, snap);
        return sse(req, res, () => `event: ${DIRECT_WIRE.snapshotEvent}\ndata: ${JSON.stringify(executionOf(state, id) ?? snap)}\n\n`, () => () => {});
      }
      if (path === DIRECT_WIRE.terminals || path.startsWith(`${DIRECT_WIRE.terminals}/`)) {
        return await serveTerminals(req, res, path);
      }
      const artifact = req.method === 'GET' ? /^\/artifact\/([^/]+)\/([^/]+)$/.exec(path) : null;
      if (artifact) {
        const bytes = decodeURIComponent(artifact[1]!) === STRANGE_NOTES ? state.bodies.get(decodeURIComponent(artifact[2]!)) : undefined;
        if (bytes === undefined) return json(res, 404, { reason: 'no bytes for this artifact version' });
        res.writeHead(200, { 'content-type': 'text/markdown' });
        return res.end(Buffer.from(bytes, 'utf8'));
      }
      if (req.method === 'POST' && path === '/_strange/reset') {
        const { empty = false } = ((await readJson(req)) ?? {}) as { empty?: boolean };
        await reset({ empty });
        return json(res, 200, { ok: true });
      }
      json(res, 404, { reason: 'not on the direct wire' });
    })().catch((err: unknown) => json(res, 500, { reason: String(err) }));
  });

  const reset = async ({ empty = false }: { empty?: boolean } = {}) => {
    // Revision stays non-decreasing across resets (WIRE.md §nodes).
    const revision = state.revision + 1;
    state = await initialState(empty);
    state.revision = revision;
    for (const t of joined.values()) t.listeners.forEach((l) => l(`event: ${E.exit}\ndata: ${JSON.stringify({ code: 0 })}\n\n`));
    joined.clear();
    publish();
  };

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://${host}:${port}`,
    reset,
    snapshot: () => project(state),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
  };
}
