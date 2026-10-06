/**
 * Wiring config files for `GET /api/wiring`: every `*.json` in the directory,
 * in file-name order (code-unit sort), carried as parsed JSON. No content
 * validation here — the web validates each file and the merge. Only transport
 * failures are marked per file: oversize, unreadable, not JSON.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIRING_LIMITS } from '@gunnflow/contract/wiring';

export type WiringFileEntry = { file: string; config: unknown } | { file: string; error: string };

export function readWiringDir(dir: string | undefined): WiringFileEntry[] {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const out: WiringFileEntry[] = [];
  for (const file of names) {
    const path = join(dir, file);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.size > WIRING_LIMITS.fileBytes) {
        out.push({ file, error: `larger than ${WIRING_LIMITS.fileBytes} bytes` });
        continue;
      }
      out.push({ file, config: JSON.parse(readFileSync(path, 'utf8')) });
    } catch (err) {
      out.push({ file, error: err instanceof SyntaxError ? `invalid JSON: ${err.message}` : `unreadable: ${String(err)}` });
    }
  }
  return out;
}

/** The settings screen's file: last in file-name order, so the person's choices always win. */
export const USER_WIRING_FILE = '90-user.json';

export type UserWiringRead = { ok: true; config: unknown | null } | { ok: false; reason: string };

export function readUserWiring(dir: string): UserWiringRead {
  const path = join(dir, USER_WIRING_FILE);
  if (!existsSync(path)) return { ok: true, config: null };
  try {
    return { ok: true, config: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: `${USER_WIRING_FILE} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Structure only (the web validates the wiring schema): a JSON object within the file size limit. */
export function userWiringProblem(config: unknown): string | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'must be a JSON object';
  if (Buffer.byteLength(JSON.stringify(config)) > WIRING_LIMITS.fileBytes) return `larger than ${WIRING_LIMITS.fileBytes} bytes`;
  return null;
}

/** Atomic write of exactly `<dir>/90-user.json` — no other path is ever written. */
export function writeUserWiring(dir: string, config: unknown): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, USER_WIRING_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, path);
}

export function removeUserWiring(dir: string): void {
  rmSync(join(dir, USER_WIRING_FILE), { force: true });
}
