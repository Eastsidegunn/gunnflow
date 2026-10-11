/**
 * Conformance suite. A backend author calls `defineConformanceSuite` from a
 * vitest file with a factory for their target; the suite checks the contract
 * properties the cockpit relies on. It inspects only canonical shapes: the
 * backend speaks them, exactly as it does on the wire.
 */
import { describe, expect, it } from 'vitest';
import type { Capability, ExecutionSnapshot, Intent, IntentResult, NodeDetail, NodeProjection, StreamEvent } from '../types.js';
import { CONTRACT_VERSION } from '../version.js';
import {
  DETAIL_MAX_ITEMS,
  isCompatibleContractVersion,
  nodeProblem,
  snapshotProblem,
  streamEventProblem,
  validateExecutionSnapshot,
  validateNodeDetail,
} from '../validate.js';
import { digestOfBody, utf8Bytes } from '../digest.js';
import { directTerminalProblem, isWireBase64, type DirectSnapshot, type DirectTerminalOpen } from '../wire.js';

/** A node exactly as the backend projects it. */
export type ConformanceNode = NodeProjection;

export interface ConformanceStream {
  /** Events received so far, in arrival order. */
  readonly events: readonly StreamEvent[];
  close(): void;
}

/** One frame of GET /terminals/:id/stream, bytes still base64. */
export type ConformanceTerminalEvent =
  | { type: 'snapshot' | 'data'; bytesBase64: string }
  | { type: 'exit'; code: number | null };

export interface ConformanceTerminalOutput {
  /** Frames received so far, in arrival order. */
  readonly events: readonly ConformanceTerminalEvent[];
  close(): void;
}

/** 204 → 'ok', 404 → 'unknown', 409 → 'exited'. */
export type ConformanceTerminalAck = 'ok' | 'unknown' | 'exited';

export interface ConformanceTerminals {
  list(): Promise<readonly unknown[]> | readonly unknown[];
  /** POST /terminals: the opened id, or the backend's refusal reason (422). */
  open(request: DirectTerminalOpen): Promise<{ terminalId: string } | { refused: string }>;
  /** GET /terminals/:id/stream; undefined = 404. */
  output(terminalId: string): Promise<ConformanceTerminalOutput | undefined>;
  input(terminalId: string, bytesBase64: string): Promise<ConformanceTerminalAck>;
  resize(terminalId: string, cols: number, rows: number): Promise<ConformanceTerminalAck>;
  close(terminalId: string): Promise<ConformanceTerminalAck>;
  /**
   * A folder in which the backend opens a shell, for the shell checks. Without
   * it the suite joins the first running attachable terminal and sends no input.
   */
  shellCwd?: string;
}

export interface ConformanceTarget {
  /** Contract version the backend claims to implement. */
  contractVersion: string;
  /**
   * Features the backend claims. A claimed feature with nothing to test
   * against fails instead of being skipped.
   */
  features?: { edit?: boolean; streams?: boolean; terminals?: boolean };
  /** Nodes as the backend projects them. */
  nodes(): Promise<readonly ConformanceNode[]> | readonly ConformanceNode[];
  /**
   * The whole snapshot as the backend serves it (its GET /nodes body),
   * checked with `snapshotProblem` — including changedAtRevision ≤ revision.
   * Required as of 0.6.0.
   */
  snapshot(): Promise<DirectSnapshot> | DirectSnapshot;
  /** Relay a canonical intent to the backend. */
  relay(intent: Intent): Promise<IntentResult>;
  /** Resolves once effects of relayed intents or produced output are observable. */
  settle?(): Promise<void>;
  /** Optional detail surface: the backend's GET /detail body for a node, undefined = no detail (404). */
  detail?(nodeId: string): Promise<NodeDetail | undefined> | NodeDetail | undefined;
  /** Optional execution surface: the backend's GET /execution body for a task, undefined = no execution (404). */
  execution?(taskId: string): Promise<ExecutionSnapshot | undefined> | ExecutionSnapshot | undefined;
  /**
   * Optional interactive terminals (WIRE.md §terminals), driven the way the
   * wire is: list, open, output, input, resize, close. Absent = the backend
   * serves no terminals (404/501) and nothing is checked.
   */
  terminals?: ConformanceTerminals;
  streams?: {
    open(nodeId: string, streamId: string, lastSeenSeq: number | null): ConformanceStream;
    /** Test driver: have the backend emit `count` chunks. */
    produce(nodeId: string, streamId: string, count: number): void | Promise<void>;
    /** Test driver: have the backend declare a loss of `count` seqs, if it can. */
    declareLoss?(nodeId: string, streamId: string, count: number): void | Promise<void>;
  };
}

/**
 * Seqs must be non-negative integers, contiguous across resync/append events,
 * except where an upstream gap declares exactly the skipped range. A resync
 * starts a new baseline; a fresh connection must start with one.
 */
export function streamSequenceProblem(
  events: readonly StreamEvent[],
  options: { freshConnection?: boolean } = {},
): string | null {
  if (options.freshConnection && events.length > 0 && events[0]!.type !== 'resync') {
    return `a fresh connection must start with resync, got ${events[0]!.type}`;
  }
  let last: number | null = null;
  for (const [i, e] of events.entries()) {
    const shape = streamEventProblem(e);
    if (shape) return `event ${i}: ${shape}`;
    if (e.type === 'gap') {
      if (e.fromSeq < 0) return `event ${i}: negative gap seq ${e.fromSeq}`;
      if (last !== null && e.fromSeq !== last + 1) return `event ${i}: gap starts at ${e.fromSeq}, expected ${last + 1}`;
      last = e.toSeq;
      continue;
    }
    if (e.type === 'resync') last = null;
    for (const c of e.chunks) {
      if (c.seq < 0) return `event ${i}: negative seq ${c.seq}`;
      if (last !== null && c.seq !== last + 1) return `event ${i}: seq ${c.seq} follows ${last}`;
      last = c.seq;
    }
  }
  return null;
}

/**
 * Intent shapes every relay boundary must refuse for an otherwise valid
 * (nodeId, action): pre-contract wire addressing, and extra top-level fields
 * (provenance, backend fields, overrides). Shared by the cockpit's guard and
 * backends' own checks.
 */
export function refusedIntentShapes(nodeId: string, action: string): Array<[string, unknown]> {
  const k = 'shape-check-key';
  return [
    ['old wire: kind + typed id', { intent: action, taskId: nodeId, idempotencyKey: k }],
    ['old wire: kind beside the canonical address', { intent: action, nodeId, action, idempotencyKey: k }],
    ['extra field: provenance', { nodeId, action, idempotencyKey: k, origin: 'copilot' }],
    ['extra field: actor override', { nodeId, action, idempotencyKey: k, actor: 'mallory' }],
    ['extra field: backend kind override', { nodeId, action, idempotencyKey: k, kind: 'mission.delete' }],
    ['extra field: backend-only field', { nodeId, action, idempotencyKey: k, prompt: 'x' }],
    ['missing idempotency key', { nodeId, action }],
    ['not an object', [nodeId, action]],
  ];
}

/**
 * The snapshot check the suite runs: the target's served snapshot must pass
 * `snapshotProblem`. Exported so the check itself can be tested against a
 * failing target.
 */
export async function snapshotConformanceProblem(t: Pick<ConformanceTarget, 'snapshot'>): Promise<string | null> {
  return snapshotProblem(await t.snapshot());
}

let keyCounter = 0;
const key = () => `conformance-${Date.now()}-${++keyCounter}`;

export function defineConformanceSuite(
  name: string,
  makeTarget: () => ConformanceTarget | Promise<ConformanceTarget>,
): void {
  const settled = async (t: ConformanceTarget) => {
    await t.settle?.();
    return t.nodes();
  };
  const intentFor = (nodeId: string, action: string, extra: Partial<Intent> = {}): Intent => ({
    nodeId,
    action,
    idempotencyKey: key(),
    ...extra,
  });
  const expectRefused = (r: IntentResult, label: string) => {
    expect(r.accepted, label).toBe(false);
    if (r.reason !== undefined) expect(typeof r.reason, label).toBe('string');
  };

  describe(`Gunnflow contract ${CONTRACT_VERSION} conformance: ${name}`, () => {
    it('claims a compatible contract version (strict semver)', async () => {
      const t = await makeTarget();
      expect(isCompatibleContractVersion(t.contractVersion, CONTRACT_VERSION), t.contractVersion).toBe(true);
    });

    it('detail surface: every detail the backend serves holds the contract shape', async () => {
      const t = await makeTarget();
      if (!t.detail) return; // optional surface — absent means the wire answers 501
      const nodes = await t.nodes();
      for (const n of nodes.slice(0, 32)) {
        const d = await t.detail(n.id);
        if (d === undefined) continue;
        const r = validateNodeDetail(d);
        if (!r.ok) throw new Error(`detail(${n.id}) fails the contract: ${r.problems.join('; ')}`);
      }
    });

    it('validateNodeDetail: one body per item, non-empty labels, bounded lists (the shape every /detail answer must hold)', () => {
      const artifact = { id: 'a', mediaType: 'text/plain', access: { kind: 'snapshot' as const } };
      expect(validateNodeDetail({ revision: 1, items: [{ label: 'progress', text: '41/42 tests' }] }).ok).toBe(true);
      expect(validateNodeDetail({ revision: 2, items: [{ label: 'report', artifact }] }).ok).toBe(true);
      expect(validateNodeDetail({ revision: 1, items: [{ label: 'both', text: 'x', artifact }] }).ok).toBe(false);
      expect(validateNodeDetail({ revision: 1, items: [{ text: 'no label' }] }).ok).toBe(false);
      expect(
        validateNodeDetail({
          revision: 1,
          items: Array.from({ length: DETAIL_MAX_ITEMS + 1 }, (_, i) => ({ label: `l${i}`, text: 't' })),
        }).ok,
      ).toBe(false);
    });

    it('execution surface: every snapshot the backend serves holds the contract shape', async () => {
      const t = await makeTarget();
      if (!t.execution) return; // optional surface — absent means the wire answers 501
      const nodes = await t.nodes();
      let served = 0;
      for (const n of nodes.slice(0, 32)) {
        const s = await t.execution(n.id);
        if (s === undefined) continue;
        const r = validateExecutionSnapshot(s);
        if (!r.ok) throw new Error(`execution(${n.id}) fails the contract: ${r.problems.join('; ')}`);
        served += 1;
      }
      // A target that claims the surface but 404s every projected node proves nothing.
      expect(served, 'target claims execution but served no snapshot for any projected node').toBeGreaterThan(0);
    });

    it('validateExecutionSnapshot: session state enum, open non-empty kinds, strictly increasing seqs, real session refs, honest window cuts (the shape every /execution answer must hold)', () => {
      const session = { id: 's', taskId: 't', state: 'running' as const };
      const evt = (seq: number) => ({ seq, at: 1, sessionId: 's', kind: 'subagent/spawn', label: 'spawned' });
      expect(validateExecutionSnapshot({ sessions: [session], events: [evt(1), evt(2)] }).ok).toBe(true);
      expect(validateExecutionSnapshot({ sessions: [{ ...session, state: 'rogue' }], events: [] }).ok).toBe(false);
      expect(validateExecutionSnapshot({ sessions: [session], events: [evt(2), evt(2)] }).ok).toBe(false);
      expect(validateExecutionSnapshot({ sessions: [session], events: [{ ...evt(1), kind: '' }] }).ok).toBe(false);
      expect(validateExecutionSnapshot({ sessions: [session], events: [{ ...evt(1), sessionId: 'ghost' }] }).ok).toBe(false);
      expect(validateExecutionSnapshot({ sessions: [session], events: [evt(4)], truncatedBefore: 4 }).ok).toBe(true);
      expect(validateExecutionSnapshot({ sessions: [session], events: [evt(4)], truncatedBefore: 5 }).ok).toBe(false);
    });

    it('projects well-formed nodes: kind/state/relations/attention, capabilities, artifacts, streams, unique ids, real references', async () => {
      const t = await makeTarget();
      const nodes = await t.nodes();
      expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
      for (const n of nodes) expect(nodeProblem(n), n.id).toBeNull();
    });

    it('snapshot: the served GET /nodes body holds the contract shape, no node changed after its revision', async () => {
      const t = await makeTarget();
      expect(await snapshotConformanceProblem(t)).toBeNull();
    });

    it('nodeProblem / snapshotProblem: optional decorations are bounded one-line texts, positive integers, closed steps (the shape every node must hold)', () => {
      const base = { id: 'n', kind: 'k', state: { value: 's' }, relations: [], capabilities: [], attention: [], artifacts: [] };
      const ok = (extra: Record<string, unknown>) => nodeProblem({ ...base, ...extra }) === null;
      expect(ok({ shortName: 'x'.repeat(32), summary: 'one line', active: false, lastActivityTs: 1, changedAtRevision: 1 })).toBe(true);
      expect(ok({ originNodeId: 'elsewhere', steps: { done: 0, total: 1 } })).toBe(true);
      expect(ok({ shortName: 'x'.repeat(33) })).toBe(false);
      expect(ok({ summary: 'two\nlines' })).toBe(false);
      expect(ok({ active: 'yes' })).toBe(false);
      expect(ok({ lastActivityTs: 0 })).toBe(false);
      expect(ok({ changedAtRevision: 0 })).toBe(false);
      expect(ok({ originNodeId: 'n' })).toBe(false);
      expect(ok({ steps: { done: 2, total: 1 } })).toBe(false);
      expect(ok({ steps: { done: 0, total: 1, pct: 0 } })).toBe(false);
      expect(snapshotProblem({ revision: 3, nodes: [{ ...base, changedAtRevision: 3 }] })).toBeNull();
      expect(snapshotProblem({ revision: 3, nodes: [{ ...base, changedAtRevision: 4 }] })).not.toBeNull();
    });

    it('refuses intents for unknown nodes, undeclared actions and unknown keys', async () => {
      const t = await makeTarget();
      const nodes = await t.nodes();
      expectRefused(await t.relay(intentFor(`conformance-missing-${key()}`, 'any')), 'node not in the projection');
      for (const n of nodes.slice(0, 3)) {
        expectRefused(await t.relay(intentFor(n.id, `conformance.undeclared.${key()}`)), `${n.id}: undeclared action`);
        const action = n.capabilities[0]?.action ?? 'any';
        expectRefused(
          await t.relay({ ...intentFor(n.id, action), origin: 'copilot' } as Intent),
          `${n.id}: unknown top-level key`,
        );
      }
    });

    it('refuses disabled/hidden actions, unpaired slots and missing required input', async (ctx) => {
      const t = await makeTarget();
      const nodes = await t.nodes();
      const pairs = nodes.flatMap((n) => n.capabilities.map((c) => ({ n, c })));
      const find = (pred: (c: Capability) => boolean) => pairs.find(({ c }) => pred(c));
      const cases: Array<[string, Intent]> = [];
      const inactive = find((c) => c.level !== 'enabled');
      if (inactive) cases.push([`${inactive.c.level} action ${inactive.c.action}`, intentFor(inactive.n.id, inactive.c.action)]);
      const noEdit = find((c) => c.level === 'enabled' && !c.edit);
      if (noEdit) {
        cases.push([
          `edit on ${noEdit.c.action} (no edit slot)`,
          intentFor(noEdit.n.id, noEdit.c.action, { edit: { baseDigest: null, mediaType: 'text/plain', body: 'x' } }),
        ]);
      }
      const noOptions = find((c) => c.level === 'enabled' && !c.decision?.options);
      if (noOptions) {
        cases.push([`decision.option on ${noOptions.c.action}`, intentFor(noOptions.n.id, noOptions.c.action, { decision: { option: 'x' } })]);
      }
      const noInput = find((c) => c.level === 'enabled' && !c.decision?.input);
      if (noInput) {
        cases.push([`decision.text on ${noInput.c.action}`, intentFor(noInput.n.id, noInput.c.action, { decision: { text: 'x' } })]);
      }
      const required = find((c) => c.level === 'enabled' && c.decision?.input?.required === true);
      if (required) cases.push([`missing required input on ${required.c.action}`, intentFor(required.n.id, required.c.action)]);
      if (cases.length === 0) return ctx.skip();
      for (const [label, intent] of cases) expectRefused(await t.relay(intent), label);
    });

    it('stores an accepted edit under sha256 of the sent UTF-8 bytes, and refuses stale bases and oversize bodies', async (ctx) => {
      const t = await makeTarget();
      const nodes = await t.nodes();
      const found = nodes
        .flatMap((n) => n.capabilities.map((c) => ({ n, c })))
        .map(({ n, c }) => ({ n, c, a: n.artifacts.find((x) => x.id === c.edit?.artifactId) }))
        .find(
          ({ c, a }) =>
            c.level === 'enabled' && c.edit && a?.digest && a.access.kind === 'snapshot' && c.edit.mediaTypes.includes(a.mediaType),
        );
      if (!found) {
        expect(t.features?.edit, 'backend claims edit but projects no editable snapshot artifact').not.toBe(true);
        return ctx.skip();
      }
      const { n, c, a } = found;
      const edit = (baseDigest: string | null, body: string) =>
        intentFor(n.id, c.action, { edit: { baseDigest, mediaType: a!.mediaType, body } });

      expectRefused(await t.relay(edit('0'.repeat(64), 'stale base')), 'stale base digest');
      expectRefused(await t.relay(edit(a!.digest!, 'x'.repeat(c.edit!.maxBytes + 1))), 'body over maxBytes');

      const body = `conformance edit ✓ ${key()}\r\nline two\n`;
      expect(utf8Bytes(body).length).toBeLessThanOrEqual(c.edit!.maxBytes);
      const ok = await t.relay(edit(a!.digest!, body));
      expect(ok.accepted, ok.reason).toBe(true);
      const after = (await settled(t)).find((x) => x.id === n.id)!;
      const stored = after.artifacts.find((x) => x.id === a!.id);
      expect(stored?.digest).toBe(await digestOfBody(body));
    });

    it('streams: resync first, contiguous non-negative seqs, upstream-only gaps, resume after a seen seq', async (ctx) => {
      const t = await makeTarget();
      const nodes = await t.nodes();
      const pair = nodes.flatMap((n) => (n.streams ?? []).map((s) => ({ n, s })))[0];
      if (!t.streams || !pair) {
        expect(t.features?.streams, 'backend claims streams but provides no stream driver or declared stream').not.toBe(true);
        return ctx.skip();
      }
      const { n, s } = pair;

      const first = t.streams.open(n.id, s.id, null);
      await t.settle?.();
      expect(first.events[0]?.type, 'first event of a fresh connection').toBe('resync');
      await t.streams.produce(n.id, s.id, 3);
      if (t.streams.declareLoss) await t.streams.declareLoss(n.id, s.id, 2);
      await t.streams.produce(n.id, s.id, 2);
      await t.settle?.();
      expect(streamSequenceProblem(first.events, { freshConnection: true })).toBeNull();
      for (const e of first.events) {
        if (e.type === 'gap') expect(e.origin).toBe('upstream');
        expect(e.streamId).toBe(s.id);
      }
      const seqs = first.events.flatMap((e) => (e.type === 'gap' ? [] : e.chunks.map((c) => c.seq)));
      const lastSeen = seqs.at(-1)!;
      first.close();

      const resumed = t.streams.open(n.id, s.id, lastSeen);
      await t.streams.produce(n.id, s.id, 2);
      await t.settle?.();
      const head = resumed.events[0];
      expect(head, 'resumed connection receives output').toBeDefined();
      if (head!.type === 'append') expect(head!.chunks[0]!.seq).toBe(lastSeen + 1);
      expect(streamSequenceProblem(resumed.events)).toBeNull();
      resumed.close();
    });

    it('terminals: well-formed list, snapshot first on every connection, base64 bytes, honest acks for unknown and closed terminals', async (ctx) => {
      const t = await makeTarget();
      const term = t.terminals;
      if (!term) {
        expect(t.features?.terminals, 'backend claims terminals but provides no terminal driver').not.toBe(true);
        return ctx.skip();
      }
      const listed = await term.list();
      for (const [i, entry] of listed.entries()) expect(directTerminalProblem(entry), `list element ${i}`).toBeNull();
      const ids = listed.map((e) => (e as { terminalId: string }).terminalId);
      expect(new Set(ids).size, 'terminal ids are unique').toBe(ids.length);

      const attachable = listed.find(
        (e) => (e as { kind: string }).kind === 'attachable' && (e as { state: string }).state === 'running',
      ) as { terminalId: string } | undefined;
      const target: DirectTerminalOpen['target'] | null =
        term.shellCwd !== undefined ? { shell: { cwd: term.shellCwd } } : attachable ? { attach: attachable.terminalId } : null;
      if (!target) {
        expect(t.features?.terminals, 'backend claims terminals but offers none to join and no shell folder').not.toBe(true);
        return ctx.skip();
      }
      const opened = await term.open({ target, cols: 80, rows: 24 });
      if ('refused' in opened) throw new Error(`open refused: ${opened.refused}`);
      const id = opened.terminalId;
      expect(typeof id === 'string' && id.length > 0, 'open answers a terminalId').toBe(true);
      if ('shell' in target) {
        const after = (await term.list()).map((e) => (e as { terminalId: string }).terminalId);
        expect(after, 'an opened shell is listed').toContain(id);
      }

      const waitFor = async (cond: () => boolean, label: string) => {
        const end = Date.now() + 3000;
        while (!cond()) {
          if (Date.now() > end) throw new Error(`timed out: ${label}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      const checkBytes = (events: readonly ConformanceTerminalEvent[]) => {
        for (const e of events) if (e.type !== 'exit') expect(isWireBase64(e.bytesBase64), 'chunk is base64').toBe(true);
      };

      const first = await term.output(id);
      expect(first, 'the opened terminal has an output stream').toBeDefined();
      await waitFor(() => first!.events.length > 0, 'first output frame');
      expect(first!.events[0]!.type, 'first frame of a connection').toBe('snapshot');
      expect(await term.resize(id, 100, 30)).toBe('ok');
      if ('shell' in target) {
        expect(await term.input(id, 'IA==')).toBe('ok'); // one space
      }
      // A second connection (a reconnect) starts from the retained output again.
      const second = await term.output(id);
      await waitFor(() => (second?.events.length ?? 0) > 0, 'reconnect snapshot');
      expect(second!.events[0]!.type, 'first frame of a reconnect').toBe('snapshot');
      checkBytes(first!.events);
      checkBytes(second!.events);
      second!.close();

      const ghost = `conformance-no-such-terminal-${key()}`;
      expect(await term.input(ghost, 'IA=='), 'input to an unknown terminal').toBe('unknown');
      expect(await term.resize(ghost, 80, 24), 'resize of an unknown terminal').toBe('unknown');
      expect(await term.output(ghost), 'output of an unknown terminal').toBeUndefined();

      if ('shell' in target) {
        expect(await term.close(id)).toBe('ok');
        await waitFor(() => first!.events.some((e) => e.type === 'exit'), 'exit after close');
        const exitAt = first!.events.findIndex((e) => e.type === 'exit');
        expect(exitAt, 'exit is the last frame').toBe(first!.events.length - 1);
        expect(['unknown', 'exited'], 'input after close').toContain(await term.input(id, 'IA=='));
      }
      first!.close();
    });
  });
}
