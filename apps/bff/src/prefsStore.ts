/**
 * Machine-local person preferences (`~/.gunnflow/prefs.json`): ergonomics of
 * THIS person on THIS machine (zoom feel, default lens, density). Not wiring
 * config (no workspace vocabulary), not personal notes (no content) — and,
 * like both, never sent upstream. The BFF carries the JSON as-is; what the
 * fields mean is the web's business.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PREFS_MAX_BYTES = 64 * 1024;
export const DEFAULT_PREFS_FILE = join(homedir(), '.gunnflow', 'prefs.json');

export type PrefsRead = { ok: true; prefs: unknown | null } | { ok: false; reason: string };

/** The stored prefs, `null` when none yet; an unreadable file is reported, never replaced. */
export function readPrefs(file: string): PrefsRead {
  if (!existsSync(file)) return { ok: true, prefs: null };
  try {
    return { ok: true, prefs: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: `prefs file unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Structural check only: a JSON object within the size cap. */
export function prefsStructureProblem(doc: unknown, bytes: number): string | null {
  if (bytes > PREFS_MAX_BYTES) return `larger than ${PREFS_MAX_BYTES} bytes`;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'must be a JSON object';
  return null;
}

/** Atomic replace: write a sibling temp file, then rename over the old one. */
export function writePrefs(file: string, doc: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, file);
}
