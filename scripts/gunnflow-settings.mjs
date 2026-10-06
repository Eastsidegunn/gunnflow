// Gunnflow's user settings, one source for every reader: the BFF
// (apps/bff/src/home.ts and config.ts re-export this), the web build
// (apps/web/vite.config.ts) and the scripts (render-sweep). Plain JS so the
// scripts can run it without a build; types in gunnflow-settings.d.mts.
//
//   $GUNNFLOW_HOME (default ~/.gunnflow)
//     config.json                 connection config (same schema as gunnflow.config.json)
//     wiring/                     your wiring files
//     personal/                   personal layer (local notes, never sent upstream)
//     prefs.json                  display preferences
//     boundary-names.local.json   extra names for pnpm boundary-lint
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The upstream choices the BFF can compose. */
export const UPSTREAM_CHOICES = Object.freeze(['fake', 'direct']);

/** Config key → the environment variable that overrides it. */
export const CONFIG_ENV = Object.freeze({
  upstream: 'GUNNFLOW_UPSTREAM',
  url: 'GUNNFLOW_UPSTREAM_URL',
  webOrigin: 'GUNNFLOW_WEB_ORIGIN',
  previewOrigin: 'GUNNFLOW_PREVIEW_ORIGIN',
  wiringDir: 'GUNNFLOW_WIRING_DIR',
  personalDir: 'GUNNFLOW_PERSONAL_DIR',
});

/** The Gunnflow home directory, absolute: GUNNFLOW_HOME (leading `~` expanded) or `~/.gunnflow`. */
export function gunnflowHome(env = process.env, userHome = homedir()) {
  const set = env.GUNNFLOW_HOME;
  if (!set) return join(userHome, '.gunnflow');
  if (set === '~') return userHome;
  if (set.startsWith('~/')) return join(userHome, set.slice(2));
  return resolve(set);
}

/**
 * Which config file applies: GUNNFLOW_CONFIG (explicit, used even if it does not
 * exist — loading then refuses) > <repo>/gunnflow.config.json >
 * <home>/config.json > undefined (an empty config: the simulator).
 */
export function resolveConfigFile({ env, repoRoot, home, exists = existsSync }) {
  if (env.GUNNFLOW_CONFIG) return { path: resolve(env.GUNNFLOW_CONFIG), source: 'env' };
  const repo = join(repoRoot, 'gunnflow.config.json');
  if (exists(repo)) return { path: repo, source: 'repo' };
  const inHome = join(home, 'config.json');
  if (exists(inHome)) return { path: inHome, source: 'home' };
  return undefined;
}

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** explicit (relative to the repo root) > <home>/wiring when it exists > <repo>/wiring. */
export function resolveWiringDir({ explicit, repoRoot, home, isDirectory = isDir }) {
  if (explicit) return resolve(repoRoot, explicit);
  const inHome = join(home, 'wiring');
  if (isDirectory(inHome)) return inHome;
  return join(repoRoot, 'wiring');
}

function httpUrl(v, originOnly) {
  let u;
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
export function parseConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('gunnflow config must be a JSON object');
  const problems = [];
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
      // A path, not a URL.
    } else if (key === 'upstream') {
      if (!UPSTREAM_CHOICES.includes(value)) problems.push(`'upstream' must be ${UPSTREAM_CHOICES.map((c) => `'${c}'`).join(' or ')}`);
    } else {
      const p = httpUrl(value, key !== 'url');
      if (p) problems.push(`'${key}' ${p}`);
    }
  }
  if (problems.length > 0) throw new Error(`gunnflow config refused: ${problems.join('; ')}`);
  return raw;
}

/**
 * Reads and validates a config file. A missing file is an empty config, unless
 * it was named explicitly (`required`). `shown` is how errors name the file.
 */
export function loadConfigFile(path, { required = false, shown = path } = {}) {
  if (!existsSync(path)) {
    if (required) throw new Error(`gunnflow config ${shown} (named by GUNNFLOW_CONFIG) does not exist`);
    return {};
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`gunnflow config ${shown} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseConfig(raw);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)} (in ${shown})`);
  }
}

/**
 * A path for logs and errors, never a raw absolute path with a username: under
 * a custom GUNNFLOW_HOME as `$GUNNFLOW_HOME/…`, under the repo as `./…`, under
 * the OS home as `~/…` (the most specific base wins); any other absolute path
 * as `…/<file name>`.
 */
export function displayPath(path, { repoRoot, env = process.env, userHome = homedir() }) {
  const bases = [
    ...(env.GUNNFLOW_HOME ? [[gunnflowHome(env, userHome), '$GUNNFLOW_HOME']] : []),
    [resolve(repoRoot), '.'],
    [userHome, '~'],
  ].sort((a, b) => b[0].length - a[0].length);
  for (const [base, label] of bases) {
    const rel = relative(base, path);
    if (rel === '') return label;
    if (!rel.startsWith('..') && !isAbsolute(rel)) return `${label}${sep}${rel}`;
  }
  // Outside every known base: the file name only, so no username can leak.
  return isAbsolute(path) ? `…${sep}${basename(path)}` : path;
}

/**
 * The resolved config file, loaded and validated — the one call every reader
 * makes. Throws (loudly) on an invalid file or a missing explicit one.
 */
export function loadUserConfig({ env = process.env, repoRoot, userHome = homedir() }) {
  const home = gunnflowHome(env, userHome);
  const location = resolveConfigFile({ env, repoRoot, home });
  if (!location) return { home, location: undefined, config: {} };
  const shown = displayPath(location.path, { repoRoot, env, userHome });
  const config = loadConfigFile(location.path, { required: location.source === 'env', shown });
  return { home, location: { ...location, shown }, config };
}
