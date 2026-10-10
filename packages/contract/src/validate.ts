/**
 * Runtime structure checks for the contract. Used on both sides of the relay:
 * the cockpit before sending, backends on receipt. Structure only —
 * unknown keys, types, slot pairing, declared/enabled — never content.
 */
import type { Capability, ExecutionSnapshot, NodeDetail, NodeProjection } from './types.js';

export type IntentValidation = { ok: true } | { ok: false; reason: string };

/**
 * `missing` — the addressed node is not in the projection: always refused.
 * `declared: false` — the node exists but carries no capability declarations
 * (legacy), so only slot pairing applies. `declared: true` — the node declares
 * its capabilities and the action must be among them, enabled.
 */
export type CapabilityLookup =
  | { missing: 'node' }
  | { declared: false }
  | { declared: true; capability: Capability | undefined };

/** Top-level keys of the canonical Intent. */
export const INTENT_KEYS = ['nodeId', 'action', 'decision', 'edit', 'attestation', 'idempotencyKey'] as const;
/** Value slots every intent shape may carry. */
export const INTENT_SLOT_KEYS = ['decision', 'edit', 'attestation'] as const;
const DECISION_KEYS = ['option', 'text'] as const;
const EDIT_KEYS = ['baseDigest', 'mediaType', 'body'] as const;
const DISPLAYED_KEYS = ['artifactId', 'digest', 'at'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys with an `undefined` value never reach the wire (JSON drops them). */
function presentKeys(v: Record<string, unknown>): string[] {
  return Object.keys(v).filter((k) => v[k] !== undefined);
}

function unknownKey(v: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return presentKeys(v).find((k) => !allowed.includes(k));
}

const fail = (reason: string): IntentValidation => ({ ok: false, reason });

/**
 * Slot checks shared by every intent shape: declared/enabled, nested keys and
 * types, pairing with the capability's declared slots, required input.
 */
export function validateIntentSlots(
  intent: Record<string, unknown>,
  action: string,
  lookup: CapabilityLookup,
): IntentValidation {
  if ('missing' in lookup) return fail('addressed node is not in the projection');
  const capability = lookup.declared ? lookup.capability : undefined;
  if (lookup.declared && capability?.level !== 'enabled') {
    return fail(`action '${action}' is ${capability ? capability.level : 'not declared'} on this node`);
  }
  const { decision, edit, attestation } = intent;
  if (decision !== undefined) {
    if (!isRecord(decision)) return fail('decision must be an object');
    const bad = unknownKey(decision, DECISION_KEYS);
    if (bad) return fail(`unknown key 'decision.${bad}'`);
    for (const k of DECISION_KEYS) {
      if (decision[k] !== undefined && typeof decision[k] !== 'string') return fail(`decision.${k} must be a string`);
    }
    if (decision.option !== undefined && !capability?.decision?.options) {
      return fail('decision.option without declared decision.options');
    }
    if (decision.text !== undefined && !capability?.decision?.input) {
      return fail('decision.text without declared decision.input');
    }
  }
  if (capability?.decision?.input?.required && (!isRecord(decision) || decision.text === undefined)) {
    return fail('decision.text required by declared decision.input');
  }
  if (edit !== undefined) {
    if (!isRecord(edit)) return fail('edit must be an object');
    const bad = unknownKey(edit, EDIT_KEYS);
    if (bad) return fail(`unknown key 'edit.${bad}'`);
    if (edit.baseDigest !== null && typeof edit.baseDigest !== 'string') {
      return fail('edit.baseDigest must be a string or null');
    }
    if (typeof edit.mediaType !== 'string' || typeof edit.body !== 'string') {
      return fail('edit.mediaType and edit.body must be strings');
    }
    if (!capability?.edit) return fail('edit without declared capability.edit');
  }
  if (attestation !== undefined) {
    if (!isRecord(attestation)) return fail('attestation must be an object');
    const bad = unknownKey(attestation, ['displayed']);
    if (bad) return fail(`unknown key 'attestation.${bad}'`);
    if (!Array.isArray(attestation.displayed)) return fail('attestation.displayed must be an array');
    for (const [i, item] of attestation.displayed.entries()) {
      if (!isRecord(item)) return fail(`attestation.displayed[${i}] must be an object`);
      const extraKey = unknownKey(item, DISPLAYED_KEYS);
      if (extraKey) return fail(`unknown key 'attestation.displayed[${i}].${extraKey}'`);
      for (const k of DISPLAYED_KEYS) {
        if (typeof item[k] !== 'string') return fail(`attestation.displayed[${i}].${k} must be a string`);
      }
    }
  }
  return { ok: true };
}

/** Validate a canonical Intent against the capability it addresses. */
export function validateIntent(intent: unknown, lookup: CapabilityLookup): IntentValidation {
  if (!isRecord(intent)) return fail('malformed intent');
  const extra = unknownKey(intent, INTENT_KEYS);
  if (extra) return fail(`unknown key '${extra}'`);
  for (const k of ['nodeId', 'action', 'idempotencyKey'] as const) {
    if (typeof intent[k] !== 'string' || intent[k] === '') return fail(`${k} must be a non-empty string`);
  }
  return validateIntentSlots(intent, intent.action as string, lookup);
}

/**
 * Validate an intent shape that differs from the canonical one only in its
 * addressing keys (for example a stand-in upstream's). `ownKeys` lists every
 * allowed key besides the shared value slots.
 */
export function validateIntentWithKeys(
  intent: unknown,
  ownKeys: readonly string[],
  action: string,
  lookup: CapabilityLookup,
): IntentValidation {
  if (!isRecord(intent)) return fail('malformed intent');
  const extra = unknownKey(intent, [...INTENT_SLOT_KEYS, ...ownKeys]);
  if (extra) return fail(`unknown key '${extra}'`);
  return validateIntentSlots(intent, action, lookup);
}

/**
 * Lookup helper. `node` undefined = not in the projection (refused);
 * `capabilities` undefined = present but undeclared (legacy).
 */
export function lookupCapability(
  node: { capabilities?: readonly Capability[] } | undefined,
  action: string,
): CapabilityLookup {
  if (!node) return { missing: 'node' };
  if (!node.capabilities) return { declared: false };
  return { declared: true, capability: node.capabilities.find((c) => c.action === action) };
}

/* ---- structural guards (conformance and backends) ---- */

const LEVELS = ['enabled', 'disabled', 'hidden'];
const HEX64 = /^[0-9a-f]{64}$/;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Returns a reason when `v` is not a well-formed Capability. */
export function capabilityProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'capability must be an object';
  const extra = unknownKey(v, ['action', 'level', 'decision', 'edit']);
  if (extra) return `unknown capability key '${extra}'`;
  if (typeof v.action !== 'string' || !v.action) return 'capability.action must be a non-empty string';
  if (!LEVELS.includes(v.level as string)) return `capability.level must be one of ${LEVELS.join('/')}`;
  if (v.decision !== undefined) {
    const d = v.decision;
    if (!isRecord(d)) return 'capability.decision must be an object';
    const bad = unknownKey(d, ['options', 'input', 'evidence']);
    if (bad) return `unknown capability.decision key '${bad}'`;
    if (d.options !== undefined && !isStringArray(d.options)) return 'decision.options must be string[]';
    if (d.evidence !== undefined && !isStringArray(d.evidence)) return 'decision.evidence must be string[]';
    if (d.input !== undefined) {
      if (!(isRecord(d.input) && typeof d.input.required === 'boolean')) return 'decision.input must be { required: boolean }';
      const extraInput = unknownKey(d.input, ['required']);
      if (extraInput) return `unknown capability.decision.input key '${extraInput}'`;
    }
  }
  if (v.edit !== undefined) {
    const e = v.edit;
    if (!isRecord(e)) return 'capability.edit must be an object';
    const bad = unknownKey(e, ['artifactId', 'mediaTypes', 'maxBytes']);
    if (bad) return `unknown capability.edit key '${bad}'`;
    if (e.artifactId !== null && typeof e.artifactId !== 'string') return 'edit.artifactId must be string or null';
    if (!isStringArray(e.mediaTypes) || e.mediaTypes.length === 0) return 'edit.mediaTypes must be a non-empty string[]';
    if (!Number.isInteger(e.maxBytes) || (e.maxBytes as number) <= 0) return 'edit.maxBytes must be a positive integer';
  }
  return null;
}

export function artifactRefProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'artifact must be an object';
  const extra = unknownKey(v, ['id', 'mediaType', 'digest', 'access']);
  if (extra) return `unknown artifact key '${extra}'`;
  if (typeof v.id !== 'string' || !v.id) return 'artifact.id must be a non-empty string';
  if (typeof v.mediaType !== 'string' || !v.mediaType) return 'artifact.mediaType must be a non-empty string';
  if (v.digest !== undefined && !(typeof v.digest === 'string' && HEX64.test(v.digest))) {
    return 'artifact.digest must be lowercase sha256 hex';
  }
  const a = v.access;
  if (!isRecord(a)) return 'artifact.access must be an object';
  if (a.kind === 'snapshot') return unknownKey(a, ['kind']) ? 'snapshot access carries no other keys' : null;
  if (a.kind === 'live') {
    const extraLive = unknownKey(a, ['kind', 'url']);
    if (extraLive) return `unknown live access key '${extraLive}'`;
    if (typeof a.url !== 'string') return 'live access needs a url';
    let url: URL;
    try {
      url = new URL(a.url);
    } catch {
      return 'live access url is not a URL';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `live access url scheme ${url.protocol} is not http(s)`;
    // Never echo the URL or its userinfo: the problem text reaches logs and the screen.
    if (url.username || url.password) return 'live access url must not carry credentials';
    return null;
  }
  return "artifact.access.kind must be 'snapshot' or 'live'";
}

export function streamRefProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'stream must be an object';
  const extra = unknownKey(v, ['id', 'role', 'mediaType', 'sequence', 'encoding', 'framing']);
  if (extra) return `unknown stream key '${extra}'`;
  if (typeof v.id !== 'string' || !v.id) return 'stream.id must be a non-empty string';
  if (v.role !== undefined && typeof v.role !== 'string') return 'stream.role must be a string';
  if (typeof v.mediaType !== 'string') return 'stream.mediaType must be a string';
  if (v.sequence !== 'contiguous') return "stream.sequence must be 'contiguous'";
  if (v.encoding !== 'utf-8' && v.encoding !== 'base64') return "stream.encoding must be 'utf-8' or 'base64'";
  if (v.framing !== 'line' && v.framing !== 'chunk') return "stream.framing must be 'line' or 'chunk'";
  return null;
}

export function streamChunkProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'chunk must be an object';
  const extra = unknownKey(v, ['seq', 'at', 'channel', 'data']);
  if (extra) return `unknown chunk key '${extra}'`;
  if (!Number.isInteger(v.seq)) return 'chunk.seq must be an integer';
  if (typeof v.at !== 'string') return 'chunk.at must be a string';
  if (v.channel !== undefined && typeof v.channel !== 'string') return 'chunk.channel must be a string';
  if (typeof v.data !== 'string') return 'chunk.data must be a string';
  return null;
}

export function streamEventProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'stream event must be an object';
  if (typeof v.streamId !== 'string') return 'event.streamId must be a string';
  if (v.type === 'resync' || v.type === 'append') {
    const extra = unknownKey(v, ['type', 'streamId', 'chunks']);
    if (extra) return `unknown ${v.type} key '${extra}'`;
    if (!Array.isArray(v.chunks)) return `${v.type}.chunks must be an array`;
    for (const c of v.chunks) {
      const p = streamChunkProblem(c);
      if (p) return p;
    }
    return null;
  }
  if (v.type === 'gap') {
    const extra = unknownKey(v, ['type', 'streamId', 'fromSeq', 'toSeq', 'reason', 'origin']);
    if (extra) return `unknown gap key '${extra}'`;
    if (v.origin !== 'upstream') return "gap.origin must be 'upstream'";
    if (!Number.isInteger(v.fromSeq) || !Number.isInteger(v.toSeq) || (v.fromSeq as number) > (v.toSeq as number)) {
      return 'gap needs integer fromSeq ≤ toSeq';
    }
    if (typeof v.reason !== 'string') return 'gap.reason must be a string';
    return null;
  }
  return "event.type must be 'resync', 'append' or 'gap'";
}

/** Bounds of the optional node decorations (0.6.0), in code points. */
export const NODE_SHORT_NAME_MAX_CHARS = 32;
export const NODE_SUMMARY_MAX_CHARS = 200;
const NODE_KEYS = [
  'id', 'kind', 'label', 'state', 'relations', 'capabilities', 'attention', 'artifacts', 'streams',
  'shortName', 'summary', 'active', 'lastActivityTs', 'changedAtRevision', 'originNodeId', 'steps',
] as const;
/** LF, VT, FF, CR, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

/** A one-line text of 1..max code points (surrogate pairs count once). */
const oneLine = (v: unknown, max: number): boolean => {
  if (typeof v !== 'string' || LINE_BREAK.test(v)) return false;
  const n = [...v].length;
  return n >= 1 && n <= max;
};

/** The optional decorations of a node; `id` is already known to be a non-empty string. */
function nodeDecorationProblem(v: Record<string, unknown>, id: string): string | null {
  if (v.shortName !== undefined && !oneLine(v.shortName, NODE_SHORT_NAME_MAX_CHARS)) {
    return `${id}: shortName must be 1..${NODE_SHORT_NAME_MAX_CHARS} characters with no line breaks`;
  }
  if (v.summary !== undefined && !oneLine(v.summary, NODE_SUMMARY_MAX_CHARS)) {
    return `${id}: summary must be 1..${NODE_SUMMARY_MAX_CHARS} characters with no line breaks`;
  }
  if (v.active !== undefined && typeof v.active !== 'boolean') return `${id}: active must be a boolean`;
  if (v.lastActivityTs !== undefined && !(Number.isInteger(v.lastActivityTs) && (v.lastActivityTs as number) > 0)) {
    return `${id}: lastActivityTs must be a positive integer (ms epoch)`;
  }
  if (v.changedAtRevision !== undefined && !(Number.isInteger(v.changedAtRevision) && (v.changedAtRevision as number) >= 1)) {
    return `${id}: changedAtRevision must be an integer ≥ 1`;
  }
  if (v.originNodeId !== undefined) {
    if (typeof v.originNodeId !== 'string' || !v.originNodeId) return `${id}: originNodeId must be a non-empty string`;
    if (v.originNodeId === id) return `${id}: originNodeId must not be the node's own id`;
  }
  if (v.steps !== undefined) {
    const st = v.steps;
    if (
      !isRecord(st) ||
      unknownKey(st, ['done', 'total']) ||
      !Number.isInteger(st.done) ||
      !Number.isInteger(st.total) ||
      (st.total as number) < 1 ||
      (st.done as number) < 0 ||
      (st.done as number) > (st.total as number)
    ) {
      return `${id}: steps must be { done; total } integers with 0 ≤ done ≤ total and total ≥ 1`;
    }
  }
  return null;
}

/**
 * Whole-node structure: closed shapes for state/relations/attention, every
 * capability/artifact/stream well-formed, ids unique within the node, and
 * references (edit target, decision evidence) pointing at the node's artifacts.
 */
export function nodeProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'node must be an object';
  const extra = unknownKey(v, NODE_KEYS);
  if (extra) return `unknown node key '${extra}'`;
  if (typeof v.id !== 'string' || !v.id) return 'node.id must be a non-empty string';
  if (typeof v.kind !== 'string' || !v.kind) return `${v.id}: kind must be a non-empty string`;
  if (v.label !== undefined && typeof v.label !== 'string') return `${v.id}: label must be a string`;
  const decoration = nodeDecorationProblem(v, v.id);
  if (decoration) return decoration;
  if (!isRecord(v.state) || typeof v.state.value !== 'string' || unknownKey(v.state, ['value'])) {
    return `${v.id}: state must be { value: string }`;
  }
  if (!Array.isArray(v.relations)) return `${v.id}: relations must be an array`;
  for (const r of v.relations) {
    if (!isRecord(r) || typeof r.type !== 'string' || typeof r.target !== 'string' || unknownKey(r, ['type', 'target'])) {
      return `${v.id}: each relation must be { type: string; target: string }`;
    }
  }
  if (!Array.isArray(v.attention)) return `${v.id}: attention must be an array`;
  for (const a of v.attention) {
    if (
      !isRecord(a) ||
      typeof a.cause !== 'string' ||
      (a.since !== undefined && typeof a.since !== 'string') ||
      (a.refs !== undefined && !isStringArray(a.refs)) ||
      unknownKey(a, ['cause', 'since', 'refs'])
    ) {
      return `${v.id}: each attention entry must be { cause: string; since?: string; refs?: string[] }`;
    }
  }
  if (!Array.isArray(v.capabilities) || !Array.isArray(v.artifacts)) {
    return `${v.id}: capabilities and artifacts must be arrays`;
  }
  if (v.streams !== undefined && !Array.isArray(v.streams)) return `${v.id}: streams must be an array`;
  const streams = (v.streams as unknown[] | undefined) ?? [];
  for (const c of v.capabilities) {
    const p = capabilityProblem(c);
    if (p) return `${v.id}: ${p}`;
  }
  for (const a of v.artifacts) {
    const p = artifactRefProblem(a);
    if (p) return `${v.id}: ${p}`;
  }
  for (const s of streams) {
    const p = streamRefProblem(s);
    if (p) return `${v.id}: ${p}`;
  }
  const dup = (ids: string[]) => ids.find((x, i) => ids.indexOf(x) !== i);
  const caps = v.capabilities as Capability[];
  const artifactIds = (v.artifacts as { id: string }[]).map((a) => a.id);
  const d1 = dup(caps.map((c) => c.action));
  if (d1) return `${v.id}: duplicate capability action '${d1}'`;
  const d2 = dup(artifactIds);
  if (d2) return `${v.id}: duplicate artifact id '${d2}'`;
  const d3 = dup((streams as { id: string }[]).map((s) => s.id));
  if (d3) return `${v.id}: duplicate stream id '${d3}'`;
  for (const c of caps) {
    if (c.edit?.artifactId && !artifactIds.includes(c.edit.artifactId)) {
      return `${v.id}/${c.action}: edit target '${c.edit.artifactId}' is not an artifact of the node`;
    }
    for (const e of c.decision?.evidence ?? []) {
      if (!artifactIds.includes(e)) return `${v.id}/${c.action}: evidence '${e}' is not an artifact of the node`;
    }
  }
  return null;
}

/* ---- snapshot (GET /nodes and every /stream frame on the direct wire) ---- */

/**
 * A node as carried by a snapshot of the given revision: `nodeProblem`, plus
 * the snapshot-level rule that its `changedAtRevision` does not exceed the
 * revision. A failure is per node — the node is not shown, the rest stand.
 */
export function snapshotNodeProblem(v: unknown, revision: number): string | null {
  const problem = nodeProblem(v);
  if (problem) return problem;
  const n = v as NodeProjection;
  if (n.changedAtRevision !== undefined && n.changedAtRevision > revision) {
    return `${n.id}: changedAtRevision ${n.changedAtRevision} is after the snapshot revision ${revision}`;
  }
  return null;
}

/**
 * Whole `DirectSnapshot` structure: closed { revision, nodes }, revision a
 * non-negative integer, unique node ids, every node passing
 * `snapshotNodeProblem`. Reports the first problem.
 */
export function snapshotProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'snapshot must be an object';
  const extra = unknownKey(v, ['revision', 'nodes']);
  if (extra) return `unknown snapshot key '${extra}'`;
  if (!(Number.isInteger(v.revision) && (v.revision as number) >= 0)) return 'snapshot.revision must be a non-negative integer';
  if (!Array.isArray(v.nodes)) return 'snapshot.nodes must be an array';
  const seen = new Set<string>();
  for (const [i, n] of v.nodes.entries()) {
    const problem = snapshotNodeProblem(n, v.revision as number);
    if (problem) return `nodes[${i}]: ${problem}`;
    const id = (n as NodeProjection).id;
    if (seen.has(id)) return `nodes[${i}]: duplicate node id '${id}'`;
    seen.add(id);
  }
  return null;
}

/* ---- node detail (GET /detail on the direct wire) ---- */

/** Bounds of a detail response: a thin on-demand surface, never a bulk feed. */
export const DETAIL_MAX_ITEMS = 64;
export const DETAIL_MAX_LABEL_CHARS = 256;
export const DETAIL_MAX_TEXT_CHARS = 65_536;

const DETAIL_KEYS = ['revision', 'items'] as const;
const DETAIL_ITEM_KEYS = ['label', 'text', 'artifact'] as const;

export type NodeDetailValidation = { ok: true; detail: NodeDetail } | { ok: false; problems: string[] };

/**
 * Structure of a GET /detail response. Collects every problem so the carrier
 * can report them all at once. Structure only — labels and texts are upstream
 * vocabulary and stay uninterpreted; each item carries exactly one body
 * (text or artifact), and artifacts obey the projection's ArtifactRef rules.
 */
export function validateNodeDetail(value: unknown): NodeDetailValidation {
  if (!isRecord(value)) return { ok: false, problems: ['detail must be an object'] };
  const problems: string[] = [];
  const extra = unknownKey(value, DETAIL_KEYS);
  if (extra) problems.push(`unknown detail key '${extra}'`);
  if (!Number.isInteger(value.revision)) problems.push('detail.revision must be a finite integer');
  if (!Array.isArray(value.items)) {
    problems.push('detail.items must be an array');
  } else {
    if (value.items.length > DETAIL_MAX_ITEMS) {
      problems.push(`detail.items must hold at most ${DETAIL_MAX_ITEMS} items, got ${value.items.length}`);
    }
    for (const [i, item] of value.items.entries()) {
      const at = `items[${i}]`;
      if (!isRecord(item)) {
        problems.push(`${at} must be an object`);
        continue;
      }
      const bad = unknownKey(item, DETAIL_ITEM_KEYS);
      if (bad) problems.push(`unknown ${at} key '${bad}'`);
      if (typeof item.label !== 'string' || !item.label || item.label.length > DETAIL_MAX_LABEL_CHARS) {
        problems.push(`${at}.label must be a non-empty string of at most ${DETAIL_MAX_LABEL_CHARS} characters`);
      }
      const hasText = item.text !== undefined;
      const hasArtifact = item.artifact !== undefined;
      if (hasText === hasArtifact) problems.push(`${at} must carry exactly one body: text or artifact`);
      if (hasText && !(typeof item.text === 'string' && item.text.length <= DETAIL_MAX_TEXT_CHARS)) {
        problems.push(`${at}.text must be a string of at most ${DETAIL_MAX_TEXT_CHARS} characters`);
      }
      if (hasArtifact) {
        const p = artifactRefProblem(item.artifact);
        if (p) problems.push(`${at}.artifact: ${p}`);
      }
    }
  }
  return problems.length === 0 ? { ok: true, detail: value as unknown as NodeDetail } : { ok: false, problems };
}

/* ---- execution snapshot (GET /execution on the direct wire) ---- */

/** Bounds of an execution snapshot: a bounded live window, never a bulk history feed. */
export const EXECUTION_MAX_SESSIONS = 256;
export const EXECUTION_MAX_EVENTS = 10_000;
export const EXECUTION_MAX_LABEL_CHARS = 512;
export const EXECUTION_MAX_KIND_CHARS = 128;
export const EXECUTION_MAX_STATUS_CHARS = 64;

const EXECUTION_KEYS = ['sessions', 'events', 'truncatedBefore'] as const;
const EXECUTION_SESSION_KEYS = [
  'id',
  'taskId',
  'state',
  'label',
  'upstreamSessionState',
  'usageInTotal',
  'usageOutTotal',
  'lastActivityTs',
] as const;
const EXECUTION_EVENT_KEYS = ['seq', 'at', 'sessionId', 'kind', 'label', 'status'] as const;
const EXECUTION_SESSION_STATES = ['running', 'paused', 'ended', 'killed'];

export type ExecutionSnapshotValidation =
  | { ok: true; snapshot: ExecutionSnapshot }
  | { ok: false; problems: string[] };

/**
 * Structure of a GET /execution response (and of every execution `snapshot`
 * stream frame). Collects every problem so the carrier can report them all at
 * once. Structure only — `kind`, `label`, `status` and `upstreamSessionState`
 * are upstream vocabulary and stay uninterpreted; seqs must strictly increase,
 * every event must reference a listed session, and a declared window cut
 * (`truncatedBefore`) must lie at or before the first carried seq.
 */
export function validateExecutionSnapshot(value: unknown): ExecutionSnapshotValidation {
  if (!isRecord(value)) return { ok: false, problems: ['execution snapshot must be an object'] };
  const problems: string[] = [];
  const extra = unknownKey(value, EXECUTION_KEYS);
  if (extra) problems.push(`unknown snapshot key '${extra}'`);
  let sessionIds: Set<string> | null = null;
  if (!Array.isArray(value.sessions)) {
    problems.push('snapshot.sessions must be an array');
  } else {
    if (value.sessions.length > EXECUTION_MAX_SESSIONS) {
      problems.push(`snapshot.sessions must hold at most ${EXECUTION_MAX_SESSIONS} sessions, got ${value.sessions.length}`);
    }
    const ids = new Set<string>();
    sessionIds = ids;
    for (const [i, s] of value.sessions.entries()) {
      const at = `sessions[${i}]`;
      if (!isRecord(s)) {
        problems.push(`${at} must be an object`);
        continue;
      }
      const bad = unknownKey(s, EXECUTION_SESSION_KEYS);
      if (bad) problems.push(`unknown ${at} key '${bad}'`);
      if (typeof s.id !== 'string' || !s.id) problems.push(`${at}.id must be a non-empty string`);
      else if (ids.has(s.id)) problems.push(`duplicate session id '${s.id}'`);
      else ids.add(s.id);
      if (typeof s.taskId !== 'string' || !s.taskId) problems.push(`${at}.taskId must be a non-empty string`);
      if (!EXECUTION_SESSION_STATES.includes(s.state as string)) {
        problems.push(`${at}.state must be one of ${EXECUTION_SESSION_STATES.join('/')}`);
      }
      if (s.label !== undefined && !(typeof s.label === 'string' && s.label.length <= EXECUTION_MAX_LABEL_CHARS)) {
        problems.push(`${at}.label must be a string of at most ${EXECUTION_MAX_LABEL_CHARS} characters`);
      }
      if (
        s.upstreamSessionState !== undefined &&
        !(
          typeof s.upstreamSessionState === 'string' &&
          s.upstreamSessionState.length > 0 &&
          s.upstreamSessionState.length <= EXECUTION_MAX_STATUS_CHARS
        )
      ) {
        problems.push(`${at}.upstreamSessionState must be a non-empty string of at most ${EXECUTION_MAX_STATUS_CHARS} characters`);
      }
      for (const k of ['usageInTotal', 'usageOutTotal'] as const) {
        if (s[k] !== undefined && !(Number.isInteger(s[k]) && (s[k] as number) >= 0)) {
          problems.push(`${at}.${k} must be a non-negative integer`);
        }
      }
      if (s.lastActivityTs !== undefined && !Number.isInteger(s.lastActivityTs)) {
        problems.push(`${at}.lastActivityTs must be a finite integer (ms epoch)`);
      }
    }
  }
  if (!Array.isArray(value.events)) {
    problems.push('snapshot.events must be an array');
  } else {
    if (value.events.length > EXECUTION_MAX_EVENTS) {
      problems.push(`snapshot.events must hold at most ${EXECUTION_MAX_EVENTS} events, got ${value.events.length}`);
    }
    let lastSeq: number | null = null;
    let firstSeq: number | null = null;
    for (const [i, e] of value.events.entries()) {
      const at = `events[${i}]`;
      if (!isRecord(e)) {
        problems.push(`${at} must be an object`);
        continue;
      }
      const bad = unknownKey(e, EXECUTION_EVENT_KEYS);
      if (bad) problems.push(`unknown ${at} key '${bad}'`);
      if (!Number.isInteger(e.seq)) {
        problems.push(`${at}.seq must be a finite integer`);
      } else {
        if (lastSeq !== null && (e.seq as number) <= lastSeq) {
          problems.push(`${at}.seq ${e.seq} does not increase past ${lastSeq}`);
        }
        lastSeq = e.seq as number;
        if (firstSeq === null) firstSeq = e.seq as number;
      }
      if (!Number.isInteger(e.at)) problems.push(`${at}.at must be a finite integer (ms epoch)`);
      if (typeof e.sessionId !== 'string' || !e.sessionId) {
        problems.push(`${at}.sessionId must be a non-empty string`);
      } else if (sessionIds !== null && !sessionIds.has(e.sessionId)) {
        problems.push(`${at}.sessionId '${e.sessionId}' references no session in the snapshot`);
      }
      if (!(typeof e.kind === 'string' && e.kind.length > 0 && e.kind.length <= EXECUTION_MAX_KIND_CHARS)) {
        problems.push(`${at}.kind must be a non-empty string of at most ${EXECUTION_MAX_KIND_CHARS} characters`);
      }
      if (!(typeof e.label === 'string' && e.label.length <= EXECUTION_MAX_LABEL_CHARS)) {
        problems.push(`${at}.label must be a string of at most ${EXECUTION_MAX_LABEL_CHARS} characters`);
      }
      if (e.status !== undefined && !(typeof e.status === 'string' && e.status.length <= EXECUTION_MAX_STATUS_CHARS)) {
        problems.push(`${at}.status must be a string of at most ${EXECUTION_MAX_STATUS_CHARS} characters`);
      }
    }
    // A declared window cut must not overlap the carried events.
    if (value.truncatedBefore !== undefined) {
      if (!(Number.isInteger(value.truncatedBefore) && (value.truncatedBefore as number) > 0)) {
        problems.push('snapshot.truncatedBefore must be a positive integer (a seq)');
      } else if (firstSeq !== null && (value.truncatedBefore as number) > firstSeq) {
        problems.push(`snapshot.truncatedBefore ${value.truncatedBefore} exceeds the first carried seq ${firstSeq}`);
      }
    }
  }
  return problems.length === 0
    ? { ok: true, snapshot: value as unknown as ExecutionSnapshot }
    : { ok: false, problems };
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/** Strict semver 2.0.0 parse; undefined when `v` is not a version. */
export function parseSemver(v: string): SemVer | undefined {
  const m = SEMVER.exec(v);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(m[4] ? { prerelease: m[4] } : {}) };
}

/**
 * Contract compatibility: same major; while major is 0, the same minor too.
 * Patch and build metadata never break compatibility.
 */
export function isCompatibleContractVersion(claimed: string, supported: string): boolean {
  const a = parseSemver(claimed);
  const b = parseSemver(supported);
  if (!a || !b || a.major !== b.major) return false;
  return a.major !== 0 || a.minor === b.minor;
}
