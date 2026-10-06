/**
 * Editor part rules (push-stage §3.3 invariants 1, 3, 4, 5). Structure only:
 * digest string equality, byte counts, UTF-8 round-trip — never content.
 */
import type { ArtifactRef, Capability } from '../model/types.js';
import type { EditBuffer } from './pendingIntents.js';
import { sha256Hex, utf8Bytes } from './digest.js';

/** A base that passed fixBase; only this module mints one. */
export interface PinnedBase {
  readonly __pinned: unique symbol;
}
/** Proof that a pinned base was rendered; only markRendered mints one. */
export interface DisplayToken {
  readonly __displayed: unique symbol;
}
export interface DisplayRecord {
  artifactId: string;
  mediaType: string;
  digest: string;
  /** When the base bytes were rendered. */
  at: number;
}

/** A pinned base: rendered as exact text (plain path), or embedded from exact src (isolated path). */
const pinned = new WeakMap<
  object,
  { artifactId: string; mediaType: string; digest: string; text?: string; src?: string }
>();
const displayed = new WeakMap<object, DisplayRecord>();

/** The element the base was rendered into; only its live, exact content (or embed source) counts. */
export interface RenderedBaseElement {
  readonly isConnected: boolean;
  readonly textContent: string | null;
  getAttribute?(name: string): string | null;
}

/**
 * Mint a display record once the pinned base text is in the document. It is
 * refused unless the element is attached and holds exactly the pinned text,
 * so a token cannot be issued ahead of (or apart from) the rendering.
 */
export function markRendered(base: PinnedBase, shownIn: RenderedBaseElement): DisplayToken | undefined {
  const p = pinned.get(base);
  // Served pins mint only through markServedAfterLoad.
  if (!p || p.text === undefined || !shownIn.isConnected || shownIn.textContent !== p.text) return undefined;
  const token = Object.freeze({}) as DisplayToken;
  displayed.set(token, { artifactId: p.artifactId, mediaType: p.mediaType, digest: p.digest, at: Date.now() });
  return token;
}

/** The internal display record behind a token; forged tokens resolve to nothing. */
export function displayRecord(token: DisplayToken | null | undefined): DisplayRecord | undefined {
  return token ? displayed.get(token) : undefined;
}

export type BaseFix =
  | { ok: true; text: string; digest: string; pinned: PinnedBase }
  | { ok: false; reason: string };

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Can this artifact be an edit base? Only a snapshot with a digest whose bytes
 * round-trip through UTF-8 unchanged and hash to that digest — otherwise the
 * displayed text and the digest would not be the same thing.
 */
export async function fixBase(
  ref: ArtifactRef | undefined,
  snapshotBase64: string | undefined,
  mediaTypes: readonly string[],
): Promise<BaseFix> {
  if (!ref) return { ok: false, reason: 'base artifact is not in the projection' };
  if (ref.access.kind !== 'snapshot') return { ok: false, reason: 'only snapshot artifacts have fixed content' };
  if (!ref.digest) return { ok: false, reason: 'artifact has no digest' };
  if (!mediaTypes.includes(ref.mediaType)) {
    return { ok: false, reason: `media type ${ref.mediaType} is not declared editable` };
  }
  if (snapshotBase64 === undefined) return { ok: false, reason: 'snapshot bytes unavailable' };
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(snapshotBase64);
  } catch {
    return { ok: false, reason: 'snapshot bytes unreadable' };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, reason: 'byte order mark present' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'bytes are not valid UTF-8' };
  }
  if (!sameBytes(utf8Bytes(text), bytes)) {
    return { ok: false, reason: 'UTF-8 round trip changes the bytes' };
  }
  if ((await sha256Hex(bytes)) !== ref.digest) {
    return { ok: false, reason: 'bytes do not match the declared digest' };
  }
  const handle = Object.freeze({}) as PinnedBase;
  pinned.set(handle, { artifactId: ref.id, mediaType: ref.mediaType, digest: ref.digest, text });
  return { ok: true, text, digest: ref.digest, pinned: handle };
}

/**
 * Pin a snapshot for the isolated viewer at its digest address `src`. Only a
 * snapshot with a declared digest can be pinned; a live portal never can.
 */
export function pinServed(ref: ArtifactRef | undefined, src: string): PinnedBase | undefined {
  if (!ref || ref.access.kind !== 'snapshot' || !ref.digest) return undefined;
  const handle = Object.freeze({}) as PinnedBase;
  pinned.set(handle, { artifactId: ref.id, mediaType: ref.mediaType, digest: ref.digest, src });
  return handle;
}

/**
 * After the embed with exactly the pinned src has loaded, re-ask the isolated
 * origin about that same address; only a confirmation naming the pinned digest
 * mints a token ("these bytes were shown in the isolated viewer"). A load of an
 * error document is not confirmed and mints nothing.
 */
export async function markServedAfterLoad(
  base: PinnedBase,
  shownIn: RenderedBaseElement,
  confirm: (src: string) => Promise<string | null>,
): Promise<DisplayToken | undefined> {
  const p = pinned.get(base);
  if (!p || p.src === undefined) return undefined;
  const served = await confirm(p.src).catch(() => null);
  if (served !== p.digest || !shownIn.isConnected || shownIn.getAttribute?.('src') !== p.src) return undefined;
  const token = Object.freeze({}) as DisplayToken;
  displayed.set(token, { artifactId: p.artifactId, mediaType: p.mediaType, digest: p.digest, at: Date.now() });
  return token;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Body must encode to UTF-8 losslessly and without a BOM. Structure, not content. */
export function bodyEncodingProblem(body: string): string | null {
  if (body.startsWith('\uFEFF')) return 'body starts with a byte order mark (U+FEFF)';
  if (LONE_SURROGATE.test(body)) return 'body contains an unpaired surrogate (not encodable as UTF-8)';
  return null;
}

export interface EditContext {
  capability: Capability | undefined;
  artifact: ArtifactRef | undefined;
}

/**
 * Send-boundary recheck against the current projection. UI disabling is not
 * the boundary; this runs at send and a failure keeps the entry composing.
 */
export function checkEditSend(buffer: EditBuffer, ctx: EditContext): string | null {
  const cap = ctx.capability;
  if (!cap) return 'edit capability is no longer declared';
  if (cap.level !== 'enabled') return `edit capability is ${cap.level}`;
  if (!cap.edit) return 'capability declares no edit slot';
  if (cap.edit.artifactId === null) return 'new-body editing is not supported';
  if (buffer.baseArtifactId !== cap.edit.artifactId) return 'edit target changed';
  if (!cap.edit.mediaTypes.includes(buffer.mediaType)) {
    return `media type ${buffer.mediaType} is not declared editable`;
  }
  const record = displayRecord(buffer.display);
  if (!record) return 'base was never displayed';
  if (record.artifactId !== buffer.baseArtifactId) return 'display record is for another artifact';
  if (record.mediaType !== buffer.mediaType) return 'buffer media type differs from the displayed base';
  const current = ctx.artifact;
  if (!current) return 'base artifact is no longer in the projection';
  if (current.access.kind !== 'snapshot') return 'base artifact is no longer a snapshot';
  if (current.id !== record.artifactId) return 'base artifact id differs from the displayed base';
  if (current.mediaType !== record.mediaType) return 'base media type differs from the displayed base';
  if (current.digest !== record.digest) return 'base changed since it was displayed';
  const bytes = utf8Bytes(buffer.body).length;
  if (bytes > cap.edit.maxBytes) return `body is ${bytes} bytes, limit ${cap.edit.maxBytes}`;
  return bodyEncodingProblem(buffer.body);
}

export interface EditorSendState {
  bytes: number;
  maxBytes: number;
  overLimit: boolean;
  /** A based edit without a display record cannot be sent. */
  undisplayed: boolean;
  encodingProblem: string | null;
  /** Base had CRLF line endings the buffer no longer has (textarea normalization). Shown, not blocked. */
  lineEndingsConverted: boolean;
  /** Projection digest of the base artifact ≠ the buffer's base digest. */
  baseMoved: boolean;
  /** Body equals the displayed base text; sending would not change the bytes. */
  unchanged: boolean;
  canSend: boolean;
}

export function editorSendState(input: {
  buffer: EditBuffer;
  /** Current digest of the base artifact in the projection; null when there is no base. */
  currentDigest: string | null;
  /** Text of the current base when it is fixed; null when unknown. */
  baseText: string | null;
  maxBytes: number;
  writable: boolean;
}): EditorSendState {
  const { buffer } = input;
  const record = displayRecord(buffer.display);
  const bytes = utf8Bytes(buffer.body).length;
  const overLimit = bytes > input.maxBytes;
  const undisplayed = buffer.baseArtifactId !== null && !record;
  const baseMoved = (record?.digest ?? null) !== input.currentDigest;
  const unchanged = !baseMoved && input.baseText !== null && buffer.body === input.baseText;
  const encodingProblem = bodyEncodingProblem(buffer.body);
  const lineEndingsConverted =
    input.baseText !== null &&
    input.baseText.includes('\r\n') &&
    buffer.body.includes('\n') &&
    !buffer.body.includes('\r\n');
  return {
    bytes,
    maxBytes: input.maxBytes,
    overLimit,
    undisplayed,
    encodingProblem,
    lineEndingsConverted,
    baseMoved,
    unchanged,
    canSend:
      input.writable && !overLimit && !undisplayed && !baseMoved && !unchanged && encodingProblem === null,
  };
}
