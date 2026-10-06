/**
 * `gunnflow.config.json` (repo root, optional): everything needed to connect
 * in one file. Environment variables, when set, win over the file.
 *
 *   { "upstream": "direct" | "fake",
 *     "url": "http://…", "webOrigin": "http://…", "previewOrigin": "http://…",
 *     "wiringDir": "wiring", "personalDir": "…" }
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_CHOICES, isUpstreamChoice } from './composition.js';

export interface GunnflowConfig {
  upstream?: string;
  url?: string;
  webOrigin?: string;
  previewOrigin?: string;
  /** Wiring config directory; relative paths resolve against the repo root. */
  wiringDir?: string;
  /** Personal-layer directory (local notes, never sent upstream); default ~/.gunnflow/personal. */
  personalDir?: string;
}

/** Config key → the environment variable that overrides it. */
export const CONFIG_ENV = {
  upstream: 'GUNNFLOW_UPSTREAM',
  url: 'GUNNFLOW_UPSTREAM_URL',
  webOrigin: 'GUNNFLOW_WEB_ORIGIN',
  previewOrigin: 'GUNNFLOW_PREVIEW_ORIGIN',
  wiringDir: 'GUNNFLOW_WIRING_DIR',
  personalDir: 'GUNNFLOW_PERSONAL_DIR',
} as const satisfies Record<keyof GunnflowConfig, string>;

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'gunnflow.config.json');
export const DEFAULT_WIRING_DIR = 'wiring';

/** The wiring directory for the effective settings, absolute. */
export function wiringDirOf(settings: Readonly<Record<string, string | undefined>>): string {
  return resolve(REPO_ROOT, settings[CONFIG_ENV.wiringDir] ?? DEFAULT_WIRING_DIR);
}

function httpUrl(v: string, originOnly: boolean): string | undefined {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must be http(s)';
  if (u.username || u.password) return 'must not carry credentials';
  if (originOnly && v.replace(/\/$/, '') !== u.origin) return 'must be an origin (scheme://host[:port]) only';
  return undefined;
}

/** Validates a parsed config; keys outside the schema are refused. */
export function parseConfig(raw: unknown): GunnflowConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('gunnflow config must be a JSON object');
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(CONFIG_ENV, key)) {
      problems.push(`unknown key '${key}'`);
      continue;
    }
    if (typeof value !== 'string' || value === '') {
      problems.push(`'${key}' must be a non-empty string`);
      continue;
    }
    if (key === 'wiringDir' || key === 'personalDir') {
      // A path or command, not a URL.
    } else if (key === 'upstream') {
      if (!isUpstreamChoice(value)) problems.push(`'upstream' must be ${UPSTREAM_CHOICES.map((c) => `'${c}'`).join(' or ')}`);
    } else {
      const p = httpUrl(value, key !== 'url');
      if (p) problems.push(`'${key}' ${p}`);
    }
  }
  if (problems.length > 0) throw new Error(`gunnflow config refused: ${problems.join('; ')}`);
  return raw as GunnflowConfig;
}

export function loadConfigFile(path: string): GunnflowConfig {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`gunnflow config ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(raw);
}

/** The effective settings as environment-shaped keys: env values win over the file. */
export function resolveSettings(
  env: Readonly<Record<string, string | undefined>>,
  config: GunnflowConfig,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, name] of Object.entries(CONFIG_ENV) as Array<[keyof GunnflowConfig, string]>) {
    out[name] = env[name] ?? config[key];
  }
  return out;
}
