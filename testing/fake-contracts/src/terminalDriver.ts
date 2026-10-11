/**
 * TEST-ONLY: the conformance suite's terminal driver over an upstream-port
 * terminal surface — the in-process simulator, or the BFF's direct upstream
 * talking to a backend over the wire. Absent methods or UpstreamUnsupported
 * mean no driver at all (the suite then checks nothing).
 */
import type { ConformanceTerminalAck, ConformanceTerminalEvent, ConformanceTerminals } from '@gunnflow/contract/conformance';
import type { UpstreamTerminalAck, UpstreamUnsupported, WorkspaceUpstream } from '@gunnflow/upstream-port';

const isUnsupported = (v: unknown): v is UpstreamUnsupported =>
  !!v && typeof v === 'object' && 'unsupported' in v;

function ackOf(a: UpstreamTerminalAck | UpstreamUnsupported): ConformanceTerminalAck {
  if (isUnsupported(a)) throw new Error(`terminal surface answered unsupported: ${a.unsupported}`);
  return a.ok ? 'ok' : a.reason;
}

export async function upstreamTerminalDriver(
  upstream: WorkspaceUpstream,
  options: { shellCwd?: string } = {},
): Promise<ConformanceTerminals | undefined> {
  const u = upstream;
  if (!u.listTerminals || !u.openTerminal || !u.subscribeTerminalOutput || !u.terminalInput || !u.terminalResize || !u.closeTerminal) {
    return undefined;
  }
  if (isUnsupported(await u.listTerminals())) return undefined;
  return {
    ...(options.shellCwd !== undefined ? { shellCwd: options.shellCwd } : {}),
    async list() {
      const l = await u.listTerminals!();
      if (isUnsupported(l)) throw new Error(l.unsupported);
      return l;
    },
    async open(request) {
      const o = await u.openTerminal!(request);
      if (isUnsupported(o)) throw new Error(o.unsupported);
      return o.ok ? { terminalId: o.terminalId } : { refused: o.reason };
    },
    async output(terminalId) {
      const events: ConformanceTerminalEvent[] = [];
      const off = await u.subscribeTerminalOutput!(terminalId, (e) => {
        if (e.type !== 'end') events.push(e);
      });
      if (isUnsupported(off)) throw new Error(off.unsupported);
      return off ? { events, close: off } : undefined;
    },
    input: async (terminalId, bytesBase64) => ackOf(await u.terminalInput!(terminalId, bytesBase64)),
    resize: async (terminalId, cols, rows) => ackOf(await u.terminalResize!(terminalId, cols, rows)),
    close: async (terminalId) => ackOf(await u.closeTerminal!(terminalId)),
  };
}
