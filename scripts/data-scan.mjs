#!/usr/bin/env node
// Data scan: keeps personal data and environment details out of the tracked
// tree. Secrets are gitleaks' job (CI); this catches what gitleaks does not
// look for — absolute home paths with a username, private/CGNAT IPv4
// addresses, tailnet host names, and data files (journals, databases, logs,
// .env) that should never be committed.
//
// Scans `git ls-files` of the repository this script lives in. A line that
// must keep a match (a test fixture, documentation of a pattern) carries the
// marker `data-scan:allow` on the same line; a whole tracked file can be
// listed in scripts/data-scan.allow.json ({ "paths": [...] }), kept minimal.
//
// Extra patterns from $GUNNFLOW_HOME/data-scan.local.json (default
// ~/.gunnflow/), an array of { name, pattern, flags }, are merged when present:
// an owner can scan for their own identifiers without publishing them. CI has
// no such file and runs the generic set only.
//
// Findings are reported as path:line and rule, never with the matched text.
// Exit codes: 0 clean, 1 findings, 2 setup error.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOW_MARKER = 'data-scan:allow';
const ALLOW_FILE = join(ROOT, 'scripts', 'data-scan.allow.json');

// Same home resolution as the BFF: GUNNFLOW_HOME (leading ~ expanded) or ~/.gunnflow.
const GUNNFLOW_HOME = (() => {
  const set = process.env.GUNNFLOW_HOME;
  if (!set) return join(homedir(), '.gunnflow');
  if (set === '~') return homedir();
  if (set.startsWith('~/')) return join(homedir(), set.slice(2));
  return resolve(set);
})();
const LOCAL_FILE = join(GUNNFLOW_HOME, 'data-scan.local.json');

// A username path segment: not a placeholder like <name>, $USER or ${HOME}, not a glob.
// It ends at a boundary — a separator, quote, whitespace or end of line all count —
// and the path must not continue a word or host name (so `example.com/home/x` is no home).
const USER = String.raw`[A-Za-z0-9._-]+(?![A-Za-z0-9._-])`;
const PATH_START = String.raw`(?<![\w.-])`;
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IP_END = String.raw`(?![\d]|\.\d)`;
const IP_START = String.raw`(?<![\d.])`;

/** Content rules: generic, safe to publish. */
const GENERIC_RULES = [
  { name: 'macOS home path', re: new RegExp(String.raw`${PATH_START}/Users/(?!Shared(?![A-Za-z0-9._-]))${USER}`) },
  { name: 'Linux home path', re: new RegExp(String.raw`${PATH_START}/home/${USER}`) },
  { name: 'Windows home path', re: new RegExp(String.raw`\b[A-Za-z]:(?:\\{1,2}|/)Users(?:\\{1,2}|/)${USER}`, 'i') },
  { name: 'private IPv4 (10/8)', re: new RegExp(`${IP_START}10(?:\\.${OCTET}){3}${IP_END}`) },
  { name: 'private IPv4 (172.16/12)', re: new RegExp(`${IP_START}172\\.(?:1[6-9]|2\\d|3[01])(?:\\.${OCTET}){2}${IP_END}`) },
  { name: 'private IPv4 (192.168/16)', re: new RegExp(`${IP_START}192\\.168(?:\\.${OCTET}){2}${IP_END}`) },
  { name: 'CGNAT IPv4 (100.64/10)', re: new RegExp(`${IP_START}100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(?:\\.${OCTET}){2}${IP_END}`) },
  { name: 'tailnet host (.ts.net)', re: /\b[a-z0-9-]+\.ts\.net\b/i },
];

/** Path rules: data files that should never be tracked. */
const PATH_RULES = [
  { name: 'data file (*.ndjson)', re: /\.ndjson$/i },
  { name: 'database file (*.sqlite, *.db)', re: /\.(?:sqlite3?|db)$/i },
  { name: 'database journal (*-journal, *-wal, *-shm)', re: /-(?:journal|wal|shm)$/i },
  { name: 'journal file (*.journal)', re: /\.journal$/i },
  { name: 'log file (*.log)', re: /\.log$/i },
  { name: 'environment file (.env*)', re: /(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$/ }, // .env.example is a template
];

function fail(message) {
  console.error(`data-scan: ${message}`);
  process.exit(2);
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read ${what} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function localRules() {
  if (!existsSync(LOCAL_FILE)) return [];
  const raw = readJson(LOCAL_FILE, 'the local patterns file in $GUNNFLOW_HOME');
  if (!Array.isArray(raw)) fail('the local patterns file must be an array of { name, pattern, flags }');
  return raw.map((entry, i) => {
    if (!entry || typeof entry.pattern !== 'string') fail(`local pattern #${i} has no string 'pattern'`);
    try {
      // Each RegExp is reused for every line with .test(): a global or sticky flag would carry
      // lastIndex from one line to the next and miss matches, so those flags are dropped.
      const flags = String(entry.flags ?? '').replace(/[gy]/g, '');
      return { name: `local: ${entry.name ?? `#${i}`}`, re: new RegExp(entry.pattern, flags) };
    } catch (err) {
      return fail(`local pattern #${i} is not a valid RegExp (${err instanceof Error ? err.message : String(err)})`);
    }
  });
}

const allowedPaths = new Set(existsSync(ALLOW_FILE) ? (readJson(ALLOW_FILE, 'scripts/data-scan.allow.json').paths ?? []) : []);
const local = localRules();
const contentRules = [...GENERIC_RULES, ...local];

let files;
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
} catch (err) {
  fail(`git ls-files failed (${err instanceof Error ? err.message : String(err)})`);
}

const findings = [];
for (const file of files) {
  if (allowedPaths.has(file)) continue;
  for (const rule of PATH_RULES) if (rule.re.test(file)) findings.push(`${file}  [${rule.name}]`);
  let buf;
  try {
    buf = readFileSync(join(ROOT, file));
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of contentRules) {
      if (rule.re.test(line)) findings.push(`${file}:${i + 1}  [${rule.name}]`);
    }
  });
}

const scope = `${files.length} tracked files, ${GENERIC_RULES.length + PATH_RULES.length} generic rules${local.length ? ` + ${local.length} local` : ''}`;
if (findings.length > 0) {
  console.error(`data-scan FAILED (${scope}):`);
  for (const f of findings) console.error(`  ${f}`);
  console.error(`Remove the data, or mark a deliberate fixture line with '${ALLOW_MARKER}'.`);
  process.exit(1);
}
console.log(`data-scan OK — ${scope}; no personal data or environment details found.`);
