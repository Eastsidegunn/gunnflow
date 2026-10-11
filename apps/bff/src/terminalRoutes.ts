/**
 * Interactive terminal relay (upstream-port 0.2.0). The BFF is still a wire:
 * it runs no shell and reads no byte — it checks shapes, keeps the steering
 * routes to this machine, and carries base64 chunks both ways.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UpstreamTerminalAck, UpstreamTerminalOpen, WorkspaceUpstream } from '@gunnflow/upstream-port';

/** One input write; a paste larger than this is split by the cockpit. */
export const TERMINAL_INPUT_MAX_BASE64 = 64 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UNSUPPORTED = { reason: 'terminals are not served by this upstream' };

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

function sendAck(reply: FastifyReply, ack: UpstreamTerminalAck) {
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
    if (!upstream.listTerminals) return reply.code(501).send(UNSUPPORTED);
    return { terminals: await upstream.listTerminals() };
  });

  app.post('/api/terminals', async (req, reply) => {
    if (!upstream.openTerminal) return reply.code(501).send(UNSUPPORTED);
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
    const opened = await upstream.openTerminal(request);
    if (!opened.ok) return reply.code(422).send({ reason: opened.reason });
    return { terminalId: opened.terminalId };
  });

  // Output: `snapshot` first (also on every reconnect), then `data`, then `exit`.
  app.get('/api/terminals/:terminalId/output', (req, reply) => {
    if (!upstream.subscribeTerminalOutput) return reply.code(501).send(UNSUPPORTED);
    const { terminalId } = req.params as { terminalId: string };
    const write = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let opened = false;
    const early: Array<() => void> = [];
    const unsubscribe = upstream.subscribeTerminalOutput(terminalId, (event) => {
      const send = () => {
        write(event.type, event.type === 'exit' ? { code: event.code } : { bytesBase64: event.bytesBase64 });
      };
      if (opened) send();
      else early.push(send);
    });
    if (!unsubscribe) return reply.code(404).send({ reason: 'no such terminal' });
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    opened = true;
    for (const send of early) send();
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
    req.raw.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      reply.raw.end();
    });
  });

  app.post('/api/terminals/:terminalId/input', async (req, reply) => {
    if (!upstream.terminalInput) return reply.code(501).send(UNSUPPORTED);
    if (!steer(req, reply)) return reply;
    const data = objectBody(req)?.bytesBase64;
    if (typeof data !== 'string' || data.length > TERMINAL_INPUT_MAX_BASE64 || !BASE64.test(data)) {
      return reply.code(400).send({ reason: 'malformed terminal input' });
    }
    const { terminalId } = req.params as { terminalId: string };
    return sendAck(reply, await upstream.terminalInput(terminalId, data));
  });

  app.post('/api/terminals/:terminalId/resize', async (req, reply) => {
    if (!upstream.terminalResize) return reply.code(501).send(UNSUPPORTED);
    if (!steer(req, reply)) return reply;
    const body = objectBody(req);
    if (!body || !isSize(body.cols) || !isSize(body.rows)) return reply.code(400).send({ reason: 'malformed terminal size' });
    const { terminalId } = req.params as { terminalId: string };
    return sendAck(reply, await upstream.terminalResize(terminalId, body.cols, body.rows));
  });

  app.delete('/api/terminals/:terminalId', async (req, reply) => {
    if (!upstream.closeTerminal) return reply.code(501).send(UNSUPPORTED);
    if (!steer(req, reply)) return reply;
    const { terminalId } = req.params as { terminalId: string };
    return sendAck(reply, await upstream.closeTerminal(terminalId));
  });
}
