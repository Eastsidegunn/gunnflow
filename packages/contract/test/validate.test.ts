// Canonical Intent validation and structural guards.
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  DETAIL_MAX_ITEMS,
  DETAIL_MAX_LABEL_CHARS,
  DETAIL_MAX_TEXT_CHARS,
  EXECUTION_MAX_EVENTS,
  EXECUTION_MAX_KIND_CHARS,
  EXECUTION_MAX_LABEL_CHARS,
  EXECUTION_MAX_SESSIONS,
  EXECUTION_MAX_STATUS_CHARS,
  artifactRefProblem,
  capabilityProblem,
  digestOfBody,
  isCompatibleContractVersion,
  lookupCapability,
  nodeProblem,
  parseSemver,
  streamEventProblem,
  validateExecutionSnapshot,
  validateIntent,
  validateNodeDetail,
  type Capability,
} from '../src/index.js';
import { streamSequenceProblem } from '../src/conformance/index.js';

const node = {
  capabilities: [
    { action: 'approve', level: 'enabled', decision: { options: ['ship', 'hold'] } },
    { action: 'note', level: 'enabled', decision: { input: { required: true } } },
    { action: 'edit', level: 'enabled', edit: { artifactId: 'a', mediaTypes: ['text/plain'], maxBytes: 10 } },
    { action: 'off', level: 'disabled' },
  ] satisfies Capability[],
};
const intent = (action: string, extra: object = {}) => ({ nodeId: 'n', action, idempotencyKey: 'k', ...extra });

describe('contract', () => {
  it('exports a semver version — 0.3.x: execution surface (0.3.0), packaging-only peer widening (0.3.1), credential-free live urls (0.3.2)', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CONTRACT_VERSION).toBe('0.3.2');
    expect(isCompatibleContractVersion('0.3.1', CONTRACT_VERSION)).toBe(true);
    expect(isCompatibleContractVersion('0.2.0', CONTRACT_VERSION)).toBe(false);
  });

  it('validates canonical intents: required addressing, unknown keys, pairing, enabled', () => {
    const v = (action: string, extra: object = {}) => validateIntent(intent(action, extra), lookupCapability(node, action));
    expect(v('approve', { decision: { option: 'ship' } })).toEqual({ ok: true });
    expect(v('approve', { decision: { text: 'x' } }).ok).toBe(false);
    expect(v('note').ok).toBe(false);
    expect(v('note', { decision: { text: '' } })).toEqual({ ok: true });
    expect(v('edit', { edit: { baseDigest: null, mediaType: 'text/plain', body: '' } })).toEqual({ ok: true });
    expect(v('approve', { edit: { baseDigest: null, mediaType: 'text/plain', body: '' } }).ok).toBe(false);
    expect(v('off').ok).toBe(false);
    expect(v('missing').ok).toBe(false);
    expect(v('approve', { draftId: 'x' })).toMatchObject({ ok: false, reason: "unknown key 'draftId'" });
    expect(validateIntent({ nodeId: 'n', action: 'approve' }, lookupCapability(node, 'approve')).ok).toBe(false);
  });

  it('guards capability, artifact and stream event shapes', () => {
    expect(capabilityProblem({ action: 'a', level: 'maybe' })).not.toBeNull();
    expect(capabilityProblem({ action: 'a', level: 'enabled', edit: { artifactId: 'x', mediaTypes: [], maxBytes: 1 } })).not.toBeNull();
    expect(artifactRefProblem({ id: 'a', mediaType: 't', digest: 'ABC', access: { kind: 'snapshot' } })).not.toBeNull();
    expect(streamEventProblem({ type: 'gap', streamId: 's', fromSeq: 3, toSeq: 1, reason: 'r', origin: 'upstream' })).not.toBeNull();
    expect(streamEventProblem({ type: 'gap', streamId: 's', fromSeq: 1, toSeq: 3, reason: 'r', origin: 'relay' })).not.toBeNull();
  });

  it('checks stream sequence contiguity with declared gaps and resync baselines', () => {
    const chunk = (seq: number) => ({ seq, at: 't', data: 'd' });
    expect(
      streamSequenceProblem([
        { type: 'resync', streamId: 's', chunks: [chunk(1), chunk(2)] },
        { type: 'gap', streamId: 's', fromSeq: 3, toSeq: 4, reason: 'r', origin: 'upstream' },
        { type: 'append', streamId: 's', chunks: [chunk(5)] },
        { type: 'resync', streamId: 's', chunks: [chunk(100)] },
        { type: 'append', streamId: 's', chunks: [chunk(101)] },
      ]),
    ).toBeNull();
    expect(streamSequenceProblem([{ type: 'append', streamId: 's', chunks: [chunk(1), chunk(3)] }])).not.toBeNull();
  });

  it('digest rule: sha256 hex of the UTF-8 bytes', async () => {
    expect(await digestOfBody('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('node addressing (lookupCapability)', () => {
  it('a node missing from the projection is refused; a present node without declarations is legacy', () => {
    expect(lookupCapability(undefined, 'x')).toEqual({ missing: 'node' });
    expect(validateIntent(intent('x'), lookupCapability(undefined, 'x'))).toMatchObject({
      ok: false,
      reason: 'addressed node is not in the projection',
    });
    expect(lookupCapability({}, 'x')).toEqual({ declared: false });
    expect(validateIntent(intent('x'), lookupCapability({}, 'x'))).toEqual({ ok: true });
  });
});

describe('closed nested shapes and node structure', () => {
  const node = (over: object = {}) => ({
    id: 'n',
    kind: 'doc',
    state: { value: 'open' },
    relations: [{ type: 'rel', target: 'm' }],
    capabilities: [{ action: 'review', level: 'enabled', decision: { evidence: ['a'] } }],
    attention: [{ cause: 'c', since: '2026-09-29T00:00:00Z' }],
    artifacts: [{ id: 'a', mediaType: 'text/plain', access: { kind: 'snapshot' } }],
    ...over,
  });

  it('decision.input and live access refuse extra keys; live urls must be http(s)', () => {
    expect(capabilityProblem({ action: 'a', level: 'enabled', decision: { input: { required: true, hint: 'x' } } })).toContain('input');
    const live = (url: string, extra: object = {}) => ({ id: 'a', mediaType: 't', access: { kind: 'live', url, ...extra } });
    expect(artifactRefProblem(live('https://example.com/x'))).toBeNull();
    expect(artifactRefProblem(live('javascript:alert(1)'))).toContain('scheme');
    expect(artifactRefProblem(live('file:///etc/passwd'))).toContain('scheme');
    expect(artifactRefProblem(live('https://x', { token: 't' }))).toContain('unknown live access key');
  });

  it('a live access url never carries userinfo credentials, and the problem never echoes them', () => {
    const live = (url: string) => ({ id: 'a', mediaType: 't', access: { kind: 'live', url } });
    expect(artifactRefProblem(live('https://h.example/x'))).toBeNull();
    expect(artifactRefProblem(live('http://h.example:8080/x?q=1'))).toBeNull();
    expect(artifactRefProblem(live('http://alice:s3cret@h.example/x'))).toBe('live access url must not carry credentials');
    for (const url of ['https://alice:s3cret@h.example/x', 'https://alice@h.example/x', 'https://:s3cret@h.example/x']) {
      const p = artifactRefProblem(live(url));
      expect(p).toBe('live access url must not carry credentials');
      expect(p).not.toContain('alice');
      expect(p).not.toContain('s3cret');
      expect(p).not.toContain('h.example');
    }
    // nodeProblem refuses the whole node through the same rule.
    expect(nodeProblem(node({ artifacts: [{ id: 'a', mediaType: 'text/plain', access: { kind: 'live', url: 'https://alice:s3cret@h.example/x' } }] })))
      .toContain('must not carry credentials');
  });

  it('a well-formed node passes; structure, duplicates and dangling references fail', () => {
    expect(nodeProblem(node())).toBeNull();
    expect(nodeProblem(node({ label: 'Readable name' }))).toBeNull();
    expect(nodeProblem(node({ label: 42 }))).toContain('label');
    expect(nodeProblem(node({ state: 'open' }))).toContain('state');
    expect(nodeProblem(node({ relations: [{ type: 'r' }] }))).toContain('relation');
    expect(nodeProblem(node({ attention: [{ since: 'x' }] }))).toContain('attention');
    expect(nodeProblem(node({ attention: [{ cause: 'c', since: 1 }] }))).toContain('attention');
    // since is optional: an unknown start time stays absent.
    expect(nodeProblem(node({ attention: [{ cause: 'c' }] }))).toBeNull();
    expect(nodeProblem(node({ capabilities: [{ action: 'review', level: 'enabled', decision: { evidence: ['zzz'] } }] }))).toContain('evidence');
    expect(nodeProblem(node({ capabilities: [{ action: 'x', level: 'enabled' }, { action: 'x', level: 'hidden' }] }))).toContain('duplicate capability');
    const art = { id: 'a', mediaType: 't', access: { kind: 'snapshot' } };
    expect(nodeProblem(node({ artifacts: [art, art] }))).toContain('duplicate artifact');
  });
});

describe('stream sequence checks', () => {
  const chunk = (seq: number) => ({ seq, at: 't', data: 'd' });
  it('negative seqs and a fresh connection not starting with resync are problems', () => {
    expect(streamSequenceProblem([{ type: 'resync', streamId: 's', chunks: [chunk(-1)] }])).toContain('negative');
    expect(streamSequenceProblem([{ type: 'append', streamId: 's', chunks: [chunk(1)] }], { freshConnection: true })).toContain('resync');
    expect(streamSequenceProblem([{ type: 'resync', streamId: 's', chunks: [chunk(1)] }], { freshConnection: true })).toBeNull();
  });
});

describe('validateNodeDetail (GET /detail responses)', () => {
  const art = { id: 'a', mediaType: 'text/plain', access: { kind: 'snapshot' as const } };
  const detail = (over: object = {}) => ({ revision: 7, items: [{ label: 'progress', text: '41/42 tests' }], ...over });
  const problemsOf = (v: unknown) => {
    const r = validateNodeDetail(v);
    return r.ok ? [] : r.problems;
  };

  it('accepts a text item and an artifact item, carrying the detail through untouched', () => {
    const text = validateNodeDetail(detail());
    expect(text).toEqual({ ok: true, detail: detail() });
    const withArtifact = detail({ items: [{ label: 'report', artifact: art }] });
    expect(validateNodeDetail(withArtifact)).toEqual({ ok: true, detail: withArtifact });
    expect(validateNodeDetail(detail({ items: [] })).ok).toBe(true);
  });

  it('requires a finite integer revision, an items array and closed keys — collecting every problem', () => {
    expect(problemsOf('x')).toEqual(['detail must be an object']);
    expect(problemsOf({ revision: 1.5, items: 'nope', extra: true })).toEqual([
      "unknown detail key 'extra'",
      'detail.revision must be a finite integer',
      'detail.items must be an array',
    ]);
    expect(problemsOf(detail({ revision: Number.NaN }))[0]).toContain('revision');
  });

  it('each item carries exactly one body, a bounded non-empty label and a bounded text', () => {
    expect(problemsOf(detail({ items: [{ label: 'both', text: 'x', artifact: art }] }))[0]).toContain('exactly one body');
    expect(problemsOf(detail({ items: [{ label: 'neither' }] }))[0]).toContain('exactly one body');
    expect(problemsOf(detail({ items: [{ text: 'no label' }] }))[0]).toContain('label');
    expect(problemsOf(detail({ items: [{ label: '', text: 'x' }] }))[0]).toContain('label');
    expect(problemsOf(detail({ items: [{ label: 'l'.repeat(DETAIL_MAX_LABEL_CHARS + 1), text: 'x' }] }))[0]).toContain('label');
    expect(validateNodeDetail(detail({ items: [{ label: 'l', text: 't'.repeat(DETAIL_MAX_TEXT_CHARS) }] })).ok).toBe(true);
    expect(problemsOf(detail({ items: [{ label: 'l', text: 't'.repeat(DETAIL_MAX_TEXT_CHARS + 1) }] }))[0]).toContain('text');
    expect(problemsOf(detail({ items: [{ label: 'l', text: 'x', note: 'n' }] }))[0]).toContain("key 'note'");
  });

  it('bounds the list and holds artifacts to the projection ArtifactRef rules', () => {
    const many = Array.from({ length: DETAIL_MAX_ITEMS + 1 }, (_, i) => ({ label: `l${i}`, text: 't' }));
    expect(problemsOf(detail({ items: many }))[0]).toContain(`${DETAIL_MAX_ITEMS}`);
    expect(validateNodeDetail(detail({ items: many.slice(0, DETAIL_MAX_ITEMS) })).ok).toBe(true);
    expect(problemsOf(detail({ items: [{ label: 'a', artifact: { id: 'a' } }] }))[0]).toContain('artifact');
  });
});

describe('validateExecutionSnapshot (GET /execution responses)', () => {
  const session = (over: object = {}) => ({ id: 's-1', taskId: 't-1', state: 'running', ...over });
  const evt = (seq: number, over: object = {}) => ({ seq, at: 1_700_000_000_000, sessionId: 's-1', kind: 'subagent/spawn', label: 'spawned reviewer', ...over });
  const snap = (over: object = {}) => ({ sessions: [session()], events: [evt(1), evt(2)], ...over });
  const problemsOf = (v: unknown) => {
    const r = validateExecutionSnapshot(v);
    return r.ok ? [] : r.problems;
  };

  it('accepts the minimal shape and the additive optional fields, carrying the snapshot through untouched', () => {
    expect(validateExecutionSnapshot(snap())).toEqual({ ok: true, snapshot: snap() });
    const rich = snap({
      sessions: [session({ label: 'Session 1', upstreamSessionState: 'awaiting-review', usageInTotal: 1200, usageOutTotal: 340, lastActivityTs: 1_700_000_000_000 })],
      events: [evt(1, { status: 'ok' }), evt(5, { kind: 'session/end' })],
    });
    expect(validateExecutionSnapshot(rich)).toEqual({ ok: true, snapshot: rich });
    expect(validateExecutionSnapshot({ sessions: [], events: [] }).ok).toBe(true);
  });

  it('requires closed keys, arrays and well-formed sessions — collecting every problem', () => {
    expect(problemsOf('x')).toEqual(['execution snapshot must be an object']);
    expect(problemsOf({ sessions: 'nope', events: 'nope', taskId: 't' })).toEqual([
      "unknown snapshot key 'taskId'",
      'snapshot.sessions must be an array',
      'snapshot.events must be an array',
    ]);
    expect(problemsOf(snap({ sessions: [session({ id: '' })] }))[0]).toContain('id');
    expect(problemsOf(snap({ sessions: [session({ taskId: 7 })] }))[0]).toContain('taskId');
    expect(problemsOf(snap({ sessions: [session({ state: 'rogue' })] }))[0]).toContain('state');
    expect(problemsOf(snap({ sessions: [session(), session()] }))[0]).toContain('duplicate session id');
    expect(problemsOf(snap({ sessions: [session({ policy: {} })] }))[0]).toContain("key 'policy'");
    expect(problemsOf(snap({ sessions: [session({ label: 'l'.repeat(EXECUTION_MAX_LABEL_CHARS + 1) })] }))[0]).toContain('label');
    expect(problemsOf(snap({ sessions: [session({ upstreamSessionState: '' })] }))[0]).toContain('upstreamSessionState');
    expect(problemsOf(snap({ sessions: [session({ usageInTotal: -1 })] }))[0]).toContain('usageInTotal');
    expect(problemsOf(snap({ sessions: [session({ usageOutTotal: 1.5 })] }))[0]).toContain('usageOutTotal');
    expect(problemsOf(snap({ sessions: [session({ lastActivityTs: Number.NaN })] }))[0]).toContain('lastActivityTs');
  });

  it('events need finite ints, strictly increasing seqs, open non-empty bounded kinds and bounded labels/status', () => {
    expect(problemsOf(snap({ events: [evt(1), evt(1)] }))[0]).toContain('does not increase');
    expect(problemsOf(snap({ events: [evt(2), evt(1)] }))[0]).toContain('does not increase');
    expect(problemsOf(snap({ events: [evt(1.5)] }))[0]).toContain('seq');
    expect(problemsOf(snap({ events: [evt(1, { at: 'yesterday' })] }))[0]).toContain('at');
    expect(problemsOf(snap({ events: [evt(1, { sessionId: '' })] }))[0]).toContain('sessionId');
    expect(problemsOf(snap({ events: [evt(1, { kind: '' })] }))[0]).toContain('kind');
    expect(problemsOf(snap({ events: [evt(1, { kind: 'k'.repeat(EXECUTION_MAX_KIND_CHARS + 1) })] }))[0]).toContain('kind');
    expect(problemsOf(snap({ events: [evt(1, { label: 42 })] }))[0]).toContain('label');
    expect(problemsOf(snap({ events: [evt(1, { status: 's'.repeat(EXECUTION_MAX_STATUS_CHARS + 1) })] }))[0]).toContain('status');
    expect(problemsOf(snap({ events: [evt(1, { payload: {} })] }))[0]).toContain("key 'payload'");
  });

  it('referential integrity: every event must reference a listed session', () => {
    expect(problemsOf(snap({ events: [evt(1, { sessionId: 'ghost' })] }))[0]).toContain("references no session");
    expect(validateExecutionSnapshot(snap({ events: [evt(1), evt(2, { sessionId: 's-1' })] })).ok).toBe(true);
  });

  it('truncatedBefore declares a window cut: positive integer at or before the first carried seq', () => {
    const cut = (truncatedBefore: unknown, events?: unknown[]) =>
      validateExecutionSnapshot(snap({ truncatedBefore, ...(events ? { events } : {}) }));
    expect(cut(1).ok).toBe(true); // events start at seq 1
    expect(cut(3, [evt(3), evt(4)]).ok).toBe(true); // cut exactly at the first carried seq
    expect(cut(7, []).ok).toBe(true); // an empty window may still declare the cut
    expect(problemsOf(snap({ truncatedBefore: 0 }))[0]).toContain('positive integer');
    expect(problemsOf(snap({ truncatedBefore: -3 }))[0]).toContain('positive integer');
    expect(problemsOf(snap({ truncatedBefore: 1.5 }))[0]).toContain('positive integer');
    expect(problemsOf(snap({ truncatedBefore: '5' }))[0]).toContain('positive integer');
    expect(problemsOf(snap({ truncatedBefore: 2 }))[0]).toContain('exceeds the first carried seq');
  });

  it('bounds the lists: a live window, never a bulk feed', () => {
    const manySessions = Array.from({ length: EXECUTION_MAX_SESSIONS + 1 }, (_, i) => session({ id: `s-${i}` }));
    expect(problemsOf(snap({ sessions: manySessions }))[0]).toContain(`${EXECUTION_MAX_SESSIONS}`);
    const manyEvents = Array.from({ length: EXECUTION_MAX_EVENTS + 1 }, (_, i) => evt(i + 1));
    expect(problemsOf(snap({ events: manyEvents }))[0]).toContain(`${EXECUTION_MAX_EVENTS}`);
    expect(validateExecutionSnapshot(snap({ events: manyEvents.slice(0, EXECUTION_MAX_EVENTS) })).ok).toBe(true);
  });
});

describe('semver', () => {
  it('parses strictly and compares by major (and minor while 0.x)', () => {
    expect(parseSemver('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseSemver('1.2.3-rc.1+build.5')).toMatchObject({ major: 1, prerelease: 'rc.1' });
    for (const bad of ['0.1', '01.0.0', 'v0.1.0', '0.1.0.0', '']) expect(parseSemver(bad), bad).toBeUndefined();
    expect(isCompatibleContractVersion('0.1.7', '0.1.0')).toBe(true);
    expect(isCompatibleContractVersion('0.2.0', '0.1.0')).toBe(false);
    expect(isCompatibleContractVersion('1.4.0', '1.0.0')).toBe(true);
    expect(isCompatibleContractVersion('2.0.0', '1.0.0')).toBe(false);
    expect(isCompatibleContractVersion('0.1', '0.1.0')).toBe(false);
  });
});
