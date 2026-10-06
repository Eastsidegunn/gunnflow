/**
 * The personal layer's local file: plain read and write of one JSON document
 * per workspace (`<dir>/<workspace>.json`). Structure only — the document's
 * schema is the web's to check. Nothing here ever reaches the upstream: this
 * module has no path to the upstream port, and the upstream has none to it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PERSONAL_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PERSONAL_DIR = join(homedir(), '.gunnflow', 'personal');

/** A file-name-safe workspace key from the upstream label (`fake`, `direct → http://host:port`). */
export function workspaceKey(label: string): string {
  const key = label
    .replace(/https?:\/\//g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return key || 'workspace';
}

export type PersonalRead = { ok: true; doc: unknown | null } | { ok: false; reason: string };

/** The stored document, `null` when there is none yet; an unreadable file is reported, never replaced. */
export function readPersonal(file: string): PersonalRead {
  if (!existsSync(file)) return { ok: true, doc: null };
  try {
    return { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: `personal file unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Structural check only: a JSON object with a numeric version, within the size cap. */
export function personalStructureProblem(doc: unknown, bytes: number): string | null {
  if (bytes > PERSONAL_MAX_BYTES) return `larger than ${PERSONAL_MAX_BYTES} bytes`;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'must be a JSON object';
  if (typeof (doc as { version?: unknown }).version !== 'number') return 'must carry a numeric version';
  return null;
}

/** Atomic replace: write a sibling temp file, then rename over the old one. */
export function writePersonal(file: string, doc: unknown): void {
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, file);
}
