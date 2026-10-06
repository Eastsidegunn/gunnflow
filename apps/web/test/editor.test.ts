// Editor part (push-stage §3.3): base pinning, display records, base-move
// detection, byte limit, body encoding, send-boundary recheck, attestation,
// digest reconcile, rejection → Restore keeps the buffer, gate reason drafts.
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import {
  FakeWorkspaceStream,
  NullIntentRelay,
  fakeBytesToBase64,
  fakeSha256Hex,
  gatesFixture,
  normalFixture,
  type FakeIntent,
  type FakeWorkspaceProjection,
} from '@gunnflow-testing/fake-contracts';
import { createProjectionStore } from '../src/state/projectionStore.js';
import { createPendingIntentState, type EditBuffer } from '../src/state/pendingIntents.js';
import { fakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { validateIntent } from '@gunnflow/contract';
import {
  displayRecord,
  editorSendState,
  fixBase,
  markRendered,
  type DisplayToken,
} from '../src/state/editorLogic.js';
import { decideGate, gateReason, gateReasonEntry, setGateReason } from '../src/state/gateLogic.js';
import { sha256Hex, utf8Bytes } from '../src/state/digest.js';
import { editCapability, taskArtifact } from '../src/model/selectors.js';
import type { ArtifactRef, Intent } from '../src/model/types.js';

const TASK = 't-draft';
const EDIT_DRAFT: Intent = { nodeId: TASK, action: 'artifact.edit' };

function fixtureBase() {
  const p = normalFixture();
  const cap = editCapability(p, TASK)!;
  const ref = taskArtifact(p, TASK, cap.edit!.artifactId!)!;
  return { p, cap, ref, b64: p.artifactSnapshots![ref.id]! };
}

function harness(opts: { reject?: string; initial?: FakeWorkspaceProjection; latencyMs?: number } = {}) {
  return createRoot((dispose) => {
    const stream = new FakeWorkspaceStream(opts.initial ?? normalFixture());
    const relay = new NullIntentRelay(stream, {
      latencyMs: opts.latencyMs ?? 2,
      rejectWith: opts.reject ? () => opts.reject : undefined,
    });
    const projectionStore = createProjectionStore();
    projectionStore.applyUpstream(stream.current());
    const state = createPendingIntentState(
      (intent) => relay.send(intent as never, 'fake-actor:test'),
      fakeIntentAdapter,
      projectionStore.projection,
    );
    stream.subscribe((p) => {
      projectionStore.applyUpstream(p);
      state.reconcile(p);
    });
    /** An upstream-side projection change (capability or artifact moves under the editor). */
    const upstreamChange = (edit: (p: FakeWorkspaceProjection) => FakeWorkspaceProjection) =>
      stream.replaceProjection(edit(stream.current()), { actor: 'system', type: 'test.change' });
    return { stream, relay, projectionStore, state, upstreamChange, dispose };
  });
}

/** Stand-in for the attached <pre> holding exactly the base text. */
const shown = (text: string) => ({ isConnected: true, textContent: text });

/** The base as the editor shows it: pinned by fixBase, then rendered (token minted). */
async function bufferFromFixture(body?: string): Promise<EditBuffer> {
  const { ref, b64, cap } = fixtureBase();
  const fixed = await fixBase(ref, b64, cap.edit!.mediaTypes);
  if (!fixed.ok) throw new Error(fixed.reason);
  return {
    baseArtifactId: ref.id,
    mediaType: ref.mediaType,
    body: body ?? fixed.text,
    display: markRendered(fixed.pinned, shown(fixed.text))!,
  };
}

/** A rendered token for an arbitrary text snapshot. */
async function renderedToken(text: string): Promise<{ token: DisplayToken; digest: string }> {
  const bytes = utf8Bytes(text);
  const ref: ArtifactRef = { id: 'a', mediaType: 'text/plain', digest: fakeSha256Hex(bytes), access: { kind: 'snapshot' } };
  const fixed = await fixBase(ref, fakeBytesToBase64(bytes), ['text/plain']);
  if (!fixed.ok) throw new Error(fixed.reason);
  return { token: markRendered(fixed.pinned, shown(fixed.text))!, digest: fixed.digest };
}

type Cap = NonNullable<FakeWorkspaceProjection['declaredCapabilities']>[string][number];

const withEditCap = (p: FakeWorkspaceProjection, patch: (cap: Cap) => Cap): FakeWorkspaceProjection => ({
  ...p,
  declaredCapabilities: {
    ...p.declaredCapabilities,
    [TASK]: p.declaredCapabilities![TASK]!.map((c) => (c.action === 'artifact.edit' ? patch(c) : c)),
  },
});

describe('digest rule', () => {
  it('the fake upstream and the cockpit hash the same UTF-8 bytes identically', async () => {
    const bytes = utf8Bytes('abc');
    expect(fakeSha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const multi = utf8Bytes('한글 ✓\r\n\u0000'.repeat(40));
    expect(await sha256Hex(multi)).toBe(fakeSha256Hex(multi));
  });
});

describe('base pinning', () => {
  const snapshot = (bytes: Uint8Array, over: Partial<ArtifactRef> = {}) => ({
    ref: {
      id: 'a',
      mediaType: 'text/plain',
      digest: fakeSha256Hex(bytes),
      access: { kind: 'snapshot' },
      ...over,
    } as ArtifactRef,
    b64: fakeBytesToBase64(bytes),
  });
  const TYPES = ['text/plain', 'text/markdown'];

  it('the fixture artifact is pinnable and shown as raw markdown text', async () => {
    const { ref, b64, cap } = fixtureBase();
    const fixed = await fixBase(ref, b64, cap.edit!.mediaTypes);
    expect(fixed).toMatchObject({ ok: true, digest: ref.digest });
    expect(fixed.ok && fixed.text.startsWith('# Ship faster')).toBe(true);
  });

  it('live, digest-less, undeclared media type and missing bytes cannot be a base', async () => {
    const s = snapshot(utf8Bytes('x'));
    expect((await fixBase({ ...s.ref, access: { kind: 'live', url: 'https://x' } }, s.b64, TYPES)).ok).toBe(false);
    expect((await fixBase({ ...s.ref, digest: undefined }, s.b64, TYPES)).ok).toBe(false);
    expect((await fixBase({ ...s.ref, mediaType: 'text/html' }, s.b64, TYPES)).ok).toBe(false);
    expect((await fixBase(s.ref, undefined, TYPES)).ok).toBe(false);
    expect((await fixBase(undefined, s.b64, TYPES)).ok).toBe(false);
  });

  it('bytes that do not round-trip through UTF-8 losslessly cannot be a base', async () => {
    const bom = snapshot(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    expect(await fixBase(bom.ref, bom.b64, TYPES)).toEqual({ ok: false, reason: 'byte order mark present' });
    const latin1 = snapshot(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    expect(await fixBase(latin1.ref, latin1.b64, TYPES)).toEqual({ ok: false, reason: 'bytes are not valid UTF-8' });
  });

  it('bytes that do not hash to the declared digest cannot be a base', async () => {
    const s = snapshot(utf8Bytes('x'), { digest: fakeSha256Hex(utf8Bytes('y')) });
    expect((await fixBase(s.ref, s.b64, TYPES)).ok).toBe(false);
  });
});

describe('display records', () => {
  it('only a pinned base can be marked rendered; the record carries the render time', async () => {
    const before = Date.now();
    const { token, digest } = await renderedToken('shown');
    const record = displayRecord(token)!;
    expect(record).toMatchObject({ artifactId: 'a', digest });
    expect(record.at).toBeGreaterThanOrEqual(before);
    expect(markRendered(Object.freeze({}) as never, shown('shown'))).toBeUndefined();
    expect(displayRecord(Object.freeze({}) as DisplayToken)).toBeUndefined();
  });

  it('a token is refused before the base is attached, or when the element holds other text', async () => {
    const bytes = utf8Bytes('the base');
    const ref: ArtifactRef = { id: 'a', mediaType: 'text/plain', digest: fakeSha256Hex(bytes), access: { kind: 'snapshot' } };
    const fixed = await fixBase(ref, fakeBytesToBase64(bytes), ['text/plain']);
    if (!fixed.ok) throw new Error(fixed.reason);
    expect(markRendered(fixed.pinned, { isConnected: false, textContent: 'the base' })).toBeUndefined();
    expect(markRendered(fixed.pinned, { isConnected: true, textContent: 'something else' })).toBeUndefined();
    expect(markRendered(fixed.pinned, shown('the base'))).toBeDefined();
  });
});

describe('send conditions', () => {
  const buffer = (body: string, display: DisplayToken | null): EditBuffer => ({
    baseArtifactId: 'a',
    mediaType: 'text/plain',
    body,
    display,
  });

  it('base moved: projection digest ≠ displayed base digest disables send; switching restores it', async () => {
    const v1 = await renderedToken('base v1');
    const v2 = await renderedToken('base v2');
    const s = editorSendState({ buffer: buffer('edited', v1.token), currentDigest: v2.digest, baseText: 'base v2', maxBytes: 100, writable: true });
    expect(s.baseMoved).toBe(true);
    expect(s.canSend).toBe(false);
    const switched = editorSendState({ buffer: buffer('edited', v2.token), currentDigest: v2.digest, baseText: 'base v2', maxBytes: 100, writable: true });
    expect(switched.canSend).toBe(true);
  });

  it('maxBytes compares UTF-8 byte length, boundary inclusive', async () => {
    const { token, digest } = await renderedToken('b');
    // '가' is 3 UTF-8 bytes.
    const at = editorSendState({ buffer: buffer('가가', token), currentDigest: digest, baseText: 'b', maxBytes: 6, writable: true });
    expect(at).toMatchObject({ bytes: 6, overLimit: false, canSend: true });
    const over = editorSendState({ buffer: buffer('가가a', token), currentDigest: digest, baseText: 'b', maxBytes: 6, writable: true });
    expect(over).toMatchObject({ bytes: 7, overLimit: true, canSend: false });
  });

  it('an unchanged body, a read-only mode, or an undisplayed base cannot send', async () => {
    const { token, digest } = await renderedToken('base');
    expect(editorSendState({ buffer: buffer('base', token), currentDigest: digest, baseText: 'base', maxBytes: 100, writable: true }).canSend).toBe(false);
    expect(editorSendState({ buffer: buffer('x', token), currentDigest: digest, baseText: 'base', maxBytes: 100, writable: false }).canSend).toBe(false);
    const none = editorSendState({ buffer: buffer('x', null), currentDigest: digest, baseText: 'base', maxBytes: 100, writable: true });
    expect(none).toMatchObject({ undisplayed: true, canSend: false });
  });

  it('body encoding: leading BOM and unpaired surrogates block send; CRLF → LF is shown, not blocked', async () => {
    const { token, digest } = await renderedToken('a\r\nb\r\n');
    const base = { currentDigest: digest, baseText: 'a\r\nb\r\n', maxBytes: 100, writable: true };
    expect(editorSendState({ ...base, buffer: buffer('﻿x', token) }).encodingProblem).toContain('byte order mark');
    expect(editorSendState({ ...base, buffer: buffer('x\uD800y', token) }).encodingProblem).toContain('surrogate');
    expect(editorSendState({ ...base, buffer: buffer('x😀', token) }).encodingProblem).toBeNull();
    const lf = editorSendState({ ...base, buffer: buffer('a\nb\nc\n', token) });
    expect(lf).toMatchObject({ lineEndingsConverted: true, canSend: true });
  });
});

describe('edit send and reconcile', () => {
  it('materializes Intent.edit and attaches the attestation from the internal display record', async () => {
    const h = harness();
    const buf = await bufferFromFixture('# Ship faster\n\nEdited by a human.\n');
    const id = h.state.compose(EDIT_DRAFT, buf);
    expect(h.relay.sent).toHaveLength(0);
    await h.state.send(id);
    const sent = h.relay.sent[0]!.intent;
    const record = displayRecord(buf.display)!;
    expect(record).toMatchObject({ artifactId: fixtureBase().ref.id, digest: fixtureBase().ref.digest });
    expect(sent).toEqual({
      nodeId: TASK,
      action: 'artifact.edit',
      edit: { baseDigest: record.digest, mediaType: 'text/markdown', body: buf.body },
      attestation: {
        displayed: [{ artifactId: record.artifactId, digest: record.digest, at: new Date(record.at).toISOString() }],
      },
      idempotencyKey: expect.any(String),
    });
    h.dispose();
  });

  it('a based edit without a valid display record is refused at send — nothing is posted', async () => {
    const h = harness();
    const undisplayed = { ...(await bufferFromFixture('changed')), display: null };
    const a = await h.state.send(h.state.compose(EDIT_DRAFT, undisplayed));
    expect(a).toMatchObject({ accepted: false, invalid: true, reason: 'base was never displayed' });
    const forged = { ...(await bufferFromFixture('changed')), display: Object.freeze({}) as DisplayToken };
    const b = await h.state.send(h.state.compose(EDIT_DRAFT, forged));
    expect(b).toMatchObject({ accepted: false, invalid: true });
    expect(h.relay.sent).toHaveLength(0);
    expect(h.state.composing().every((e) => e.invalid !== undefined)).toBe(true);
    h.dispose();
  });

  it('the entry clears only when a projection carries sha256(sent bytes)', async () => {
    const h = harness({ latencyMs: 300 });
    const body = '# Ship faster\n\nSaved via digest.\n';
    const buf = await bufferFromFixture(body);
    const id = h.state.compose(EDIT_DRAFT, buf);
    const sending = h.state.send(id);
    // The digest is computed before the transition; once in flight, an unrelated projection does not clear it.
    await vi.waitFor(() => expect(h.state.inFlight()).toHaveLength(1));
    h.state.reconcile(normalFixture());
    expect(h.state.inFlight()).toHaveLength(1);
    await sending;
    const expected = fakeSha256Hex(utf8Bytes(body));
    const art = taskArtifact(h.projectionStore.projection(), TASK, buf.baseArtifactId!)!;
    expect(art.digest).toBe(expected);
    expect(h.state.entries()).toHaveLength(0);
    h.dispose();
  });

  it('rejection → Restore keeps the long body and base; resend re-materializes', async () => {
    const h = harness({ reject: 'upstream rejected: policy hold' });
    const body = 'A long human-written body.\n'.repeat(50);
    const buf = await bufferFromFixture(body);
    const id = h.state.compose(EDIT_DRAFT, buf);
    await h.state.send(id);
    expect(h.state.rejected()[0]).toMatchObject({ reason: 'upstream rejected: policy hold' });
    h.state.reopen(id);
    const back = h.state.composing()[0]!;
    expect(back.editBuffer).toEqual(buf);
    expect(back.draft).toEqual(EDIT_DRAFT);
    h.state.updateEditBuffer(id, { body: body + 'more\n' });
    await h.state.send(id);
    expect(h.relay.sent[1]!.intent.edit?.body).toBe(body + 'more\n');
    expect(h.relay.sent[1]!.intent.attestation?.displayed).toHaveLength(1);
    h.dispose();
  });

  it('the fixture pairs edit with its declared capability; other nodes refuse edit', async () => {
    const h = harness();
    const buf = await bufferFromFixture('changed');
    const elsewhere = h.state.compose({ nodeId: 't-build', action: 'artifact.edit' }, buf);
    const outcome = await h.state.send(elsewhere);
    expect(outcome).toMatchObject({ accepted: false, invalid: true });
    expect(h.relay.sent).toHaveLength(0);
    h.dispose();
  });
});

describe('send-boundary recheck (current projection)', () => {
  it('a swapped edit target is refused even when the digest is identical', async () => {
    const h = harness();
    const buf = await bufferFromFixture('changed');
    const { ref } = fixtureBase();
    // Same bytes, same digest, different artifact id behind the capability.
    h.upstreamChange((p) => ({
      ...withEditCap(p, (c) => ({ ...c, edit: { ...c.edit!, artifactId: 'art-other' } })),
      tasks: p.tasks.map((t) =>
        t.id === TASK ? { ...t, artifacts: [...(t.artifacts ?? []), { ...ref, id: 'art-other' }] } : t,
      ),
    }));
    const outcome = await h.state.send(h.state.compose(EDIT_DRAFT, buf));
    expect(outcome).toMatchObject({ accepted: false, invalid: true, reason: 'edit target changed' });
    expect(h.relay.sent).toHaveLength(0);
    h.dispose();
  });

  it('capability disabled, media type undeclared, over maxBytes, or null target at send time → composing + invalid', async () => {
    const cases: Array<[(p: FakeWorkspaceProjection) => FakeWorkspaceProjection, string]> = [
      [(p) => withEditCap(p, (c) => ({ ...c, level: 'disabled' })), 'edit capability is disabled'],
      [(p) => withEditCap(p, (c) => ({ ...c, edit: { ...c.edit!, mediaTypes: ['text/plain'] } })), 'media type text/markdown'],
      [(p) => withEditCap(p, (c) => ({ ...c, edit: { ...c.edit!, maxBytes: 4 } })), 'limit 4'],
      [(p) => withEditCap(p, (c) => ({ ...c, edit: { ...c.edit!, artifactId: null } })), 'not supported'],
    ];
    for (const [change, reason] of cases) {
      const h = harness();
      const buf = await bufferFromFixture('changed');
      h.upstreamChange(change);
      const id = h.state.compose(EDIT_DRAFT, buf);
      const outcome = await h.state.send(id);
      expect(outcome).toMatchObject({ accepted: false, invalid: true });
      expect(h.state.composing()[0]!.invalid).toContain(reason);
      expect(h.relay.sent).toHaveLength(0);
      h.dispose();
    }
  });

  it('the displayed base must match the current artifact in id, media type, digest and snapshot access', async () => {
    const other = await renderedToken('unrelated');
    const h1 = harness();
    const wrongRecord = { ...(await bufferFromFixture('changed')), display: other.token };
    expect(await h1.state.send(h1.state.compose(EDIT_DRAFT, wrongRecord))).toMatchObject({
      invalid: true,
      reason: 'display record is for another artifact',
    });
    h1.dispose();

    const setArtifact = (patch: Partial<ArtifactRef>) => (p: FakeWorkspaceProjection) => ({
      ...p,
      tasks: p.tasks.map((t) => (t.id === TASK ? { ...t, artifacts: t.artifacts!.map((a) => ({ ...a, ...patch }) as ArtifactRef) } : t)),
    });
    const cases: Array<[Partial<ArtifactRef>, string]> = [
      [{ mediaType: 'text/plain' }, 'media type differs'],
      [{ access: { kind: 'live', url: 'https://x' } }, 'no longer a snapshot'],
    ];
    for (const [patch, reason] of cases) {
      const h = harness();
      const buf = await bufferFromFixture('changed');
      h.upstreamChange(setArtifact(patch));
      const outcome = await h.state.send(h.state.compose(EDIT_DRAFT, buf));
      expect(outcome).toMatchObject({ invalid: true });
      expect(h.state.composing()[0]!.invalid).toContain(reason);
      expect(h.relay.sent).toHaveLength(0);
      h.dispose();
    }
  });

  it('a change between the last check and the post is caught: the recheck runs after the digest await', async () => {
    const h = harness();
    const buf = await bufferFromFixture('changed');
    const id = h.state.compose(EDIT_DRAFT, buf);
    const sending = h.state.send(id);
    // While the digest is being computed, upstream disables the capability.
    h.upstreamChange((p) => withEditCap(p, (c) => ({ ...c, level: 'disabled' })));
    expect(await sending).toMatchObject({ invalid: true, reason: 'edit capability is disabled' });
    expect(h.relay.sent).toHaveLength(0);

    // Editing the buffer mid-send also refuses rather than posting stale bytes.
    const h2 = harness();
    const id2 = h2.state.compose(EDIT_DRAFT, await bufferFromFixture('first'));
    const sending2 = h2.state.send(id2);
    h2.state.updateEditBuffer(id2, { body: 'second' });
    expect(await sending2).toMatchObject({ invalid: true });
    expect(h2.relay.sent).toHaveLength(0);
    h.dispose();
    h2.dispose();
  });

  it('the fake upstream re-verifies capability, media type and size at apply time', () => {
    const digest = fixtureBase().ref.digest!;
    const disabled = new FakeWorkspaceStream(withEditCap(normalFixture(), (c) => ({ ...c, level: 'disabled' })));
    const edit = (body: string, mediaType = 'text/markdown'): FakeIntent => ({
      intent: 'artifact.edit',
      taskId: TASK,
      edit: { baseDigest: digest, mediaType, body },
    });
    expect(disabled.acceptIntent(edit('x'), 'a').accepted).toBe(false);
    const s = new FakeWorkspaceStream(normalFixture());
    expect(s.acceptIntent(edit('x', 'text/html'), 'a').accepted).toBe(false);
    expect(s.acceptIntent(edit('x'.repeat(4096)), 'a').accepted).toBe(false);
    expect(s.auditChain()).toHaveLength(0);
  });

  it('body encoding problems are refused at send too', async () => {
    const h = harness();
    const bom = await h.state.send(h.state.compose(EDIT_DRAFT, await bufferFromFixture('﻿# x')));
    const lone = await h.state.send(h.state.compose(EDIT_DRAFT, await bufferFromFixture('# x\uDC00')));
    expect(bom).toMatchObject({ invalid: true });
    expect(lone).toMatchObject({ invalid: true });
    expect(h.relay.sent).toHaveLength(0);
    h.dispose();
  });

  it('capability loss keeps existing entries readable and restorable; only send is blocked', async () => {
    const h = harness({ reject: 'upstream rejected: policy hold' });
    const buf = await bufferFromFixture('long human text\n');
    const id = h.state.compose(EDIT_DRAFT, buf);
    await h.state.send(id);
    h.upstreamChange((p) => withEditCap(p, (c) => ({ ...c, level: 'hidden' })));
    h.state.reopen(id);
    expect(h.state.composing()[0]!.editBuffer!.body).toBe('long human text\n');
    const outcome = await h.state.send(id);
    expect(outcome).toMatchObject({ invalid: true, reason: 'edit capability is hidden' });
    expect(h.state.composing()[0]!.editBuffer!.body).toBe('long human text\n');
    h.dispose();
  });
});

describe('fake upstream conflict check (check and apply in one step)', () => {
  const editIntent = (baseDigest: string | null): FakeIntent => ({
    intent: 'artifact.edit',
    taskId: TASK,
    edit: { baseDigest, mediaType: 'text/markdown', body: 'x' },
  });

  it('stale base, missing target, and digest-less target are all refused, appending nothing', () => {
    const stale = new FakeWorkspaceStream(normalFixture());
    expect(stale.acceptIntent(editIntent('0'.repeat(64)), 'a')).toMatchObject({ accepted: false });

    const missing = new FakeWorkspaceStream({
      ...normalFixture(),
      tasks: normalFixture().tasks.map((t) => (t.id === TASK ? { ...t, artifacts: [] } : t)),
    });
    expect(missing.acceptIntent(editIntent(null), 'a').reason).toContain('missing');

    const noDigest = new FakeWorkspaceStream({
      ...normalFixture(),
      tasks: normalFixture().tasks.map((t) =>
        t.id === TASK ? { ...t, artifacts: t.artifacts!.map((a) => ({ ...a, digest: undefined })) } : t,
      ),
    });
    expect(noDigest.acceptIntent(editIntent(null), 'a').accepted).toBe(false);
    for (const s of [stale, missing, noDigest]) expect(s.auditChain()).toHaveLength(0);

    const ok = new FakeWorkspaceStream(normalFixture());
    expect(ok.acceptIntent(editIntent(fixtureBase().ref.digest!), 'a')).toEqual({ accepted: true });
    expect(ok.auditChain()).toHaveLength(1);
  });
});

describe('gate reason drafts', () => {
  const gateHarness = (reject?: string) => harness({ initial: gatesFixture(), reject });

  it('typing a reason leaves the kind undecided; it cannot be sent until a kind is chosen', async () => {
    const h = gateHarness();
    setGateReason(h.state, 'g-review', 'Looks right');
    const entry = gateReasonEntry(h.state, 'g-review')!;
    expect(entry.draft).toEqual({ action: null, nodeId: 'g-review', text: 'Looks right' });
    const refused = await h.state.send(entry.localId);
    expect(refused).toMatchObject({ invalid: true, reason: 'choose an action before sending' });
    expect(h.relay.sent).toHaveLength(0);
    await decideGate(h.state, 'g-review', 'gate.reject');
    expect(h.relay.sent[0]!.intent).toEqual({ nodeId: 'g-review', action: 'gate.reject', decision: { text: 'Looks right' }, idempotencyKey: expect.any(String) });
    h.dispose();
  });

  it('Restore of a refused decision brings its reason back to the field', async () => {
    const h = gateHarness('upstream rejected: approver not on rota');
    setGateReason(h.state, 'g-review', 'Ship it');
    await decideGate(h.state, 'g-review', 'gate.approve');
    const [rejected] = h.state.rejected();
    expect(gateReason(h.state, 'g-review')).toBe('');
    h.state.reopen(rejected!.localId);
    expect(gateReason(h.state, 'g-review')).toBe('Ship it');
    // Restore returns it undecided: the generic send path cannot re-send the old kind.
    expect(gateReasonEntry(h.state, 'g-review')!.draft).toMatchObject({ action: null, nodeId: 'g-review', text: 'Ship it' });
    expect(await h.state.send(rejected!.localId)).toMatchObject({ invalid: true, reason: 'choose an action before sending' });
    expect(h.relay.sent).toHaveLength(1);
    h.dispose();
  });
});

describe('attestation structure', () => {
  const lookup = { declared: false } as const;
  const base = { nodeId: 't', action: 'task.pause', idempotencyKey: 'k' } as const;

  it('accepts displayed[] of {artifactId, digest, at}', () => {
    const intent = { ...base, attestation: { displayed: [{ artifactId: 'a', digest: 'd', at: '2026-09-29T00:00:00.000Z' }] } };
    expect(validateIntent(intent, lookup)).toEqual({ ok: true });
  });

  it('refuses extra keys at every level and non-string fields', () => {
    const extraTop = { ...base, attestation: { displayed: [], by: 'copilot' } } as unknown as Intent;
    expect(validateIntent(extraTop, lookup)).toMatchObject({ ok: false, reason: "unknown key 'attestation.by'" });
    const extraItem = {
      ...base,
      attestation: { displayed: [{ artifactId: 'a', digest: 'd', at: 't', origin: 'x' }] },
    } as unknown as Intent;
    expect(validateIntent(extraItem, lookup)).toMatchObject({
      ok: false,
      reason: "unknown key 'attestation.displayed[0].origin'",
    });
    const badType = { ...base, attestation: { displayed: [{ artifactId: 'a', digest: 'd', at: 1 }] } } as unknown as Intent;
    expect(validateIntent(badType, lookup).ok).toBe(false);
    const notArray = { ...base, attestation: { displayed: {} } } as unknown as Intent;
    expect(validateIntent(notArray, lookup).ok).toBe(false);
  });
});
