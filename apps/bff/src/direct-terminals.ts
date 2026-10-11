/**
 * The direct wire's terminal surface (WIRE.md §terminals) as upstream-port
 * terminal methods. Bytes are carried as the wire's base64, never decoded.
 * 404/501 on the collection (and 501 anywhere) = the backend serves no
 * terminals → UpstreamUnsupported, asked again on every call so a backend that
 * gains terminals after a restart is seen. Transport and wire failures reject.
 */
import { DIRECT_WIRE, directTerminalProblem, isWireBase64, type DirectTerminal } from '@gunnflow/contract';
import type {
  UpstreamTerminalAck,
  UpstreamTerminalEvent,
  UpstreamTerminalOpen,
  UpstreamTerminalOpened,
  UpstreamUnsupported,
  WorkspaceUpstream,
} from '@gunnflow/upstream-port';
import { SseDecoder } from './sse.js';

type TerminalMethods = Required<
  Pick<
    WorkspaceUpstream,
    'listTerminals' | 'openTerminal' | 'subscribeTerminalOutput' | 'terminalInput' | 'terminalResize' | 'closeTerminal'
  >
>;

const unsupported = (method: string, path: string, status: number): UpstreamUnsupported => ({
  unsupported: `the direct wire's ${method} ${path} answered ${status}`,
});

/** The upstream's own text from an error response, verbatim when present. */
async function responseReason(res: Response): Promise<string | undefined> {
  const text = (await res.text().catch(() => '')).trim();
  if (!text) return undefined;
  try {
    const reason = (JSON.parse(text) as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason) return reason;
  } catch {
    // not JSON: the text itself is the upstream's message
  }
  return text;
}

/** A frame of GET /terminals/:id/stream as an upstream-port event, or null when it breaks the wire. */
function eventOf(frame: { event: string; data: string }): UpstreamTerminalEvent | null | 'ignore' {
  const E = DIRECT_WIRE.terminalEvents;
  if (frame.event === E.snapshot || frame.event === E.data) {
    if (!isWireBase64(frame.data)) return null;
    return { type: frame.event, bytesBase64: frame.data };
  }
  if (frame.event === E.exit) {
    try {
      const code = (JSON.parse(frame.data) as { code?: unknown }).code;
      if (code === null || Number.isInteger(code)) return { type: 'exit', code: code as number | null };
    } catch {
      // broken JSON breaks the wire
    }
    return null;
  }
  return 'ignore'; // other event names are ignored, as on /stream
}

export function directTerminals(base: string, options: { reconnectMs: number }): TerminalMethods & { close(): void } {
  const path = DIRECT_WIRE.terminals;
  /** Live output connections, aborted when the upstream itself closes. */
  const tails = new Set<{ stop(reason: 'closed'): void }>();

  const ack = async (method: string, sub: string, init: RequestInit): Promise<UpstreamTerminalAck | UpstreamUnsupported> => {
    const r = await fetch(`${base}${sub}`, init);
    if (r.ok) return { ok: true };
    if (r.status === 404) return { ok: false, reason: 'unknown' };
    if (r.status === 409) return { ok: false, reason: 'exited' };
    if (r.status === 501) return unsupported(method, sub, 501);
    const reason = await responseReason(r);
    throw new Error(`${method} ${sub} answered ${r.status}${reason ? `: ${reason}` : ''}`);
  };
  const postJson = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    async listTerminals() {
      const r = await fetch(`${base}${path}`);
      if (r.status === 404 || r.status === 501) return unsupported('GET', path, r.status);
      if (!r.ok) throw new Error(`GET ${path} answered ${r.status}`);
      const body = (await r.json()) as unknown;
      if (!Array.isArray(body)) throw new Error(`GET ${path} must answer an array`);
      for (const [i, t] of body.entries()) {
        const problem = directTerminalProblem(t);
        if (problem) throw new Error(`GET ${path} element ${i} breaks the wire: ${problem}`);
      }
      return body as DirectTerminal[];
    },

    async openTerminal(request: UpstreamTerminalOpen): Promise<UpstreamTerminalOpened | UpstreamUnsupported> {
      const r = await fetch(`${base}${path}`, postJson(request));
      if (r.status === 404 || r.status === 501) return unsupported('POST', path, r.status);
      if (r.status >= 400 && r.status < 500) {
        return { ok: false, reason: (await responseReason(r)) ?? `the backend refused (${r.status})` };
      }
      if (!r.ok) throw new Error(`POST ${path} answered ${r.status}`);
      const terminalId = ((await r.json()) as { terminalId?: unknown }).terminalId;
      if (typeof terminalId !== 'string' || !terminalId) throw new Error(`POST ${path} answered no terminalId`);
      return { ok: true, terminalId };
    },

    // One wire connection per viewer. A stream that ends without `exit` is
    // re-opened after reconnectMs; its first frame is a fresh `snapshot`, which
    // restarts the viewer's screen. 404 on a re-open = the terminal is gone.
    async subscribeTerminalOutput(terminalId, listener) {
      const sub = `${DIRECT_WIRE.terminal(terminalId)}/stream`;
      const ac = new AbortController();
      const connect = () => fetch(`${base}${sub}`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
      const first = await connect();
      if (first.status === 404) return undefined;
      if (first.status === 501) return unsupported('GET', sub, 501);
      if (!first.ok || !first.body) throw new Error(`GET ${sub} answered ${first.status}`);

      let stopped = false;
      const tail = {
        stop(reason: 'closed') {
          if (stopped) return;
          stopped = true;
          ac.abort();
          listener({ type: 'end', reason });
        },
      };
      tails.add(tail);
      /** 'exit' = the terminal ended (last event sent); 'again' = the stream dropped. */
      const pump = async (res: Response): Promise<'exit' | 'again'> => {
        const reader = res.body!.getReader();
        const text = new TextDecoder();
        const sse = new SseDecoder();
        try {
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) return 'again';
            for (const frame of sse.push(text.decode(value, { stream: true }))) {
              const event = eventOf(frame);
              if (event === 'ignore') continue;
              // A frame that breaks the wire drops this connection; the re-open resyncs from its snapshot.
              if (event === null) return 'again';
              if (stopped) return 'again';
              listener(event);
              if (event.type === 'exit') return 'exit';
            }
          }
          return 'again';
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      };
      void (async () => {
        let res: Response | null = first;
        let end: 'gone' | 'unsupported' | null = null;
        while (!stopped && end === null) {
          if (res) {
            try {
              if ((await pump(res)) === 'exit') break;
            } catch {
              // transport loss mid-stream: re-open below
            }
            res = null;
          }
          if (stopped) break;
          await new Promise((resolve) => setTimeout(resolve, options.reconnectMs));
          if (stopped) break;
          try {
            const r = await connect();
            if (r.status === 404) end = 'gone';
            else if (r.status === 501) end = 'unsupported';
            else if (r.ok && r.body) res = r;
            else await r.body?.cancel().catch(() => undefined);
          } catch {
            // backend unreachable: keep trying until it answers or the viewer leaves
          }
        }
        tails.delete(tail);
        if (!stopped && end) {
          stopped = true;
          listener({ type: 'end', reason: end });
        }
        stopped = true;
        ac.abort();
      })();
      return () => {
        stopped = true;
        tails.delete(tail);
        ac.abort();
      };
    },

    terminalInput: (terminalId, bytesBase64) =>
      ack('POST', `${DIRECT_WIRE.terminal(terminalId)}/input`, postJson({ data: bytesBase64 })),
    terminalResize: (terminalId, cols, rows) =>
      ack('POST', `${DIRECT_WIRE.terminal(terminalId)}/resize`, postJson({ cols, rows })),
    closeTerminal: (terminalId) => ack('DELETE', DIRECT_WIRE.terminal(terminalId), { method: 'DELETE' }),

    close() {
      for (const t of [...tails]) t.stop('closed');
      tails.clear();
    },
  };
}
