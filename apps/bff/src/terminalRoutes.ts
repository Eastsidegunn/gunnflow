/**
 * Interactive terminal relay (upstream-port 0.2.0). The BFF is still a wire:
 * it runs no shell and reads no byte — it checks shapes, keeps the steering
 * routes to this machine, and carries base64 chunks both ways.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  UpstreamTerminalAck,
  UpstreamTerminalOpen,
  UpstreamUnsupported,
  WorkspaceUpstream,
} from '@gunnflow/upstream-port';

/** One input write; a paste larger than this is split by the cockpit. */
export const TERMINAL_INPUT_MAX_BASE64 = 64 * 1024;
/**
 * Output a viewer has not taken yet, beyond which its stream is dropped: the
 * viewer reconnects and restarts from the retained snapshot, so a slow screen
 * costs a redraw, never unbounded memory here.
 */
export const TERMINAL_OUTPUT_HIGH_WATER = 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UNSUPPORTED = { reason: 'terminals are not served by this upstream' };

const isUnsupported = (v: unknown): v is UpstreamUnsupported =>
  !!v && typeof v === 'object' && typeof (v as { unsupported?: unknown }).unsupported === 'string';

/** An upstream call that rejected (transport or wire failure) is a reasoned 502, not a crash. */
async function upstreamCall<T>(reply: FastifyReply, call: () => T | Promise<T>): Promise<{ value: T } | null> {
  try {
    return { value: await call() };
  } catch (err) {
    reply.code(502).send({ reason: `upstream terminal failure: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }
}

/**
 * Steering a terminal is limited to this machine until remote auth exists: the
 * request must come from loopback, and a browser-sent Origin must be loopback
 * too (a page elsewhere cannot type into a shell through the user's browser).
 */
export function terminalSteeringRefusal(req: FastifyRequest): string | null {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) return 'terminal input is accepted from this machine only';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host = '';
    try {
      host = new URL(origin).hostname;
    } catch {
      /* unparsable origin: refused below */
    }
    if (!LOOPBACK_HOSTS.has(host)) return 'terminal input is accepted from a page on this machine only';
  }
  return null;
}

function isSize(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;
}

function objectBody(req: FastifyRequest): Record<string, unknown> | null {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

function sendAck(reply: FastifyReply, ack: UpstreamTerminalAck | UpstreamUnsupported) {
  if (isUnsupported(ack)) return reply.code(501).send({ reason: ack.unsupported });
  if (ack.ok) return reply.code(204).send();
  return ack.reason === 'unknown'
    ? reply.code(404).send({ reason: 'no such terminal' })
    : reply.code(409).send({ reason: 'the terminal has exited' });
}

export function registerTerminalRoutes(app: FastifyInstance, upstream: WorkspaceUpstream): void {
  const steer = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const refusal = terminalSteeringRefusal(req);
    if (refusal) reply.code(403).send({ reason: refusal });
    return refusal === null;
  };

  app.get('/api/terminals', async (_req, reply) => {
    const list = upstream.listTerminals?.bind(upstream);
    if (!list) return reply.code(501).send(UNSUPPORTED);
    const listed = await upstreamCall(reply, list);
    if (!listed) return reply;
    if (isUnsupported(listed.value)) return reply.code(501).send({ reason: listed.value.unsupported });
    return { terminals: listed.value };
  });

  app.post('/api/terminals', async (req, reply) => {
    const open = upstream.openTerminal?.bind(upstream);
    if (!open) return reply.code(501).send(UNSUPPORTED);
    if (!steer(req, reply)) return reply;
    const body = objectBody(req);
    const target = body?.target as Record<string, unknown> | undefined;
    let request: UpstreamTerminalOpen | null = null;
    if (body && isSize(body.cols) && isSize(body.rows) && target && typeof target === 'object') {
      const shell = target.shell as Record<string, unknown> | undefined;
      if (typeof target.attach === 'string' && target.attach) {
        request = { target: { attach: target.attach }, cols: body.cols, rows: body.rows };
      } else if (shell && typeof shell.cwd === 'string' && shell.cwd.length <= 4096) {
        request = { target: { shell: { cwd: shell.cwd } }, cols: body.cols, rows: body.rows };
      }
    }
    if (!request) return reply.code(400).send({ reason: 'malformed terminal request' });
    const valid = request;
    const call = await upstreamCall(reply, () => open(valid));
    if (!call) return reply;
    const opened = call.value;
    if (isUnsupported(opened)) return reply.code(501).send({ reason: opened.unsupported });
    if (!opened.ok) return reply.code(422).send({ reason: opened.reason });
    return { terminalId: opened.terminalId };
  });

  // Output: `snapshot` first (also on every reconnect), then `data`, then `exit`.
  // An upstream `end` drops the stream without a frame: the viewer re-asks.
  app.get('/api/terminals/:terminalId/output', async (req, reply) => {
    const subscribe = upstream.subscribeTerminalOutput?.bind(upstream);
    if (!subscribe) return reply.code(501).send(UNSUPPORTED);
    const { terminalId } = req.params as { terminalId: string };
    let opened = false;
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const early: Array<() => void> = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      clearInterval(heartbeat);
      if (opened) reply.raw.end();
    };
    const write = (event: string, data: unknown) => {
      if (finished) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Backpressure: a viewer this far behind restarts from the snapshot instead.
      if (reply.raw.writableLength > TERMINAL_OUTPUT_HIGH_WATER) finish();
    };
    const call = await upstreamCall(reply, () =>
      subscribe(terminalId, (event) => {
        const send = () => {
          if (event.type === 'end') return finish();
          write(event.type, event.type === 'exit' ? { code: event.code } : { bytesBase64: event.bytesBase64 });
        };
        if (opened) send();
        else early.push(send);
      }),
    );
    if (!call) return reply;
    if (isUnsupported(call.value)) return reply.code(501).send({ reason: call.value.unsupported });
    if (!call.value) return reply.code(404).send({ reason: 'no such terminal' });
    unsubscribe = call.value;
    if (req.raw.destroyed) {
      finished = true;
      unsubscribe();
      return reply;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    opened = true;
    for (const send of early) send();
    if (finished) {
      // An `end` arrived before the stream opened: release the upstream and close now.
      unsubscribe();
      reply.raw.end();
      return reply;
    }
    heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
    req.raw.on('close', finish);
    return reply;
  });

  app.post('/api/terminals/:terminalId/input', async (req, reply) => {
    const input = upstream.terminalInput?.bind(upstream);
    if (!input) return reply.code(501).send(UNSUPPORTED);
    if (!steer(req, reply)) return reply;
    const data = objectBody(req)?.bytesBase64;
    if (typeof data !== 'string' || data.length > TERMINAL_INPUT_MAX_BASE64 || !BASE64.test(data)) {
      return reply.code(400).send({ reason: 'malformed terminal input' });
    }
    const { terminalId } = req.params as { terminalId: string };
    const ack = await upstreamCall(reply, () => input(terminalId, data));
    return ack ? sendAck(reply, ack.value) : reply;
  });

  app.post('/api/terminals/:terminalId/resize', async (req, reply) => {
    const resize = upstream.terminalResize?.bind(upstream);
    if (!resize) return reply.code(501).send(UNSUPPORTED);
    if (!steer(req, reply)) return reply;
    const body = objectBody(req);
    if (!body || !isSize(body.cols) || !isSize(body.rows)) return reply.code(400).send({ reason: 'malformed terminal size' });
    const { terminalId } = req.params as { terminalId: string };
    const { cols, rows } = body;
    const ack = await upstreamCall(reply, () => resize(terminalId, cols, rows));
    return ack ? sendAck(reply, ack.value) : reply;
  });

  app.delete('/api/terminals/:terminalId', async (req, reply) => {
    const close = upstream.closeTerminal?.bind(upstream);
    if (!close) return reply.code(501).send(UNSUPPORTED);
    if (!steer(req, reply)) return reply;
    const { terminalId } = req.params as { terminalId: string };
    const ack = await upstreamCall(reply, () => close(terminalId));
    return ack ? sendAck(reply, ack.value) : reply;
  });
}
