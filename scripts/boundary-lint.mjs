#!/usr/bin/env node
// Acceptance A1–A3: Gunnflow may not import/call any non-shared cross-repo
// package. The only allowed workspace scope is @gunnflow/*. Backends connect
// over the contract's direct wire only; the core (apps/, packages/) and the
// simulator name no backend.
//
// The backend names and cross-repo packages are DATA, not code:
// scripts/boundary-names.json (override with BOUNDARY_NAMES_FILE). A
// $GUNNFLOW_HOME/boundary-names.local.json (default ~/.gunnflow/), when present,
// adds names a person wants checked without publishing them; it lives outside
// the repository, so it can never be committed. This file spells no backend name.
// (Self-contained on purpose: tests copy this file alone into sandboxes.)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['apps', 'packages', 'testing'];
// Directories whose source must not spell a backend name.
const NAME_SCAN_DIRS = ['apps/', 'packages/', 'testing/'];
// Rule: simulator-isolation — product packages know no simulator.
const SIMULATOR_BLIND_DIRS = ['packages/'];

const NAMES_FILE = process.env.BOUNDARY_NAMES_FILE ?? new URL('./boundary-names.json', import.meta.url).pathname;
// An explicit BOUNDARY_NAMES_FILE is exact (tests rely on that); only the default file merges the local one.
// Same home resolution as scripts/gunnflow-settings.mjs (inlined: tests copy this file alone).
const GUNNFLOW_HOME = (() => {
  const set = process.env.GUNNFLOW_HOME;
  if (!set) return join(homedir(), '.gunnflow');
  if (set === '~') return homedir();
  if (set.startsWith('~/')) return join(homedir(), set.slice(2));
  return resolve(set);
})();
const LOCAL_NAMES_FILE = process.env.BOUNDARY_NAMES_FILE ? null : join(GUNNFLOW_HOME, 'boundary-names.local.json');
const readNames = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // Never print a raw absolute path with a username.
    const shown = file.startsWith(GUNNFLOW_HOME) ? `$GUNNFLOW_HOME${file.slice(GUNNFLOW_HOME.length)}`
      : file.startsWith(homedir()) ? `~${file.slice(homedir().length)}` : file;
    console.error(`boundary-lint: cannot read the names data file ${shown} (${err instanceof Error ? err.message : String(err)})`);
    process.exit(2);
  }
};
const names = (() => {
  const base = readNames(NAMES_FILE);
  if (!LOCAL_NAMES_FILE || !existsSync(LOCAL_NAMES_FILE)) return base;
  const local = readNames(LOCAL_NAMES_FILE);
  const merged = { ...base };
  for (const key of ['backendNames', 'forbiddenPackages', 'siblingRepos']) {
    merged[key] = [...(base[key] ?? []), ...(local[key] ?? [])];
  }
  return merged;
})();
const toRegExp = ({ pattern, flags }) => new RegExp(pattern, flags ?? '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Backend proper names the core must not contain, in code or comments.
const BACKEND_NAMES = (names.backendNames ?? []).map(toRegExp);
// Cross-repo packages (by npm name) and sibling repositories (by relative path) the core must not import.
const FORBIDDEN_PACKAGES = (names.forbiddenPackages ?? []).map(toRegExp);
const siblings = (names.siblingRepos ?? []).map(escapeRe).join('|');
const FORBIDDEN = [
  ...FORBIDDEN_PACKAGES,
  ...(siblings
    ? [new RegExp(`from\\s+['"](\\.\\.\\/)+(\\.\\.\\/)*(${siblings})`, 'i'), new RegExp(`['"]\\.\\.\\/\\.\\.\\/\\.\\.\\/(${siblings})`, 'i')]
    : []),
];
const SRC_EXT = /\.(ts|tsx|mts|mjs|js|jsx)$/;

// Layering: the contract is pure (depends on nothing but relative files and
// vitest for its conformance suite); the simulator may depend on the contract,
// never the reverse; packages never reach into apps.
const CONTRACT_DIR = join('packages', 'contract') + '/';
const CONTRACT_ALLOWED_BARE = new Set(['vitest']);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g;

const violations = [];

const isSimulatorBlind = (rel) => SIMULATOR_BLIND_DIRS.some((d) => rel.startsWith(d));

/** Relative specifier climbs out of the package rooted `pkgDepth` levels above the file's dir. */
function escapesPackage(relPath, specifier, pkgRootSegments) {
  const depth = relPath.split('/').length - 1 - pkgRootSegments;
  const ups = specifier.split('/').filter((p) => p === '..').length;
  return ups > depth;
}

function layeringViolation(relPath, specifier) {
  if (isSimulatorBlind(relPath)) {
    if (/^@gunnflow-testing\//.test(specifier)) return '[simulator-isolation] may not import the simulator';
    if (specifier.startsWith('.') && /(^|\/)testing\//.test(specifier)) return '[simulator-isolation] may not reach into testing/';
  }
  if (relPath.startsWith('testing/')) {
    if (/^@gunnflow\/(web|bff)\b/.test(specifier)) return '[simulator-layering] testing may not import apps';
    if (specifier.startsWith('.') && escapesPackage(relPath, specifier, 2)) {
      return '[simulator-layering] testing imports other workspace code by package name only';
    }
    return null;
  }
  const inContract = relPath.startsWith(CONTRACT_DIR);
  if (inContract) {
    if (specifier.startsWith('.')) {
      // Relative imports must stay inside the contract package.
      const depth = relPath.slice(CONTRACT_DIR.length).split('/').length - 1;
      const ups = specifier.split('/').filter((p) => p === '..').length;
      return ups > depth ? 'contract may not import outside its package' : null;
    }
    return CONTRACT_ALLOWED_BARE.has(specifier) ? null : `contract may not depend on '${specifier}'`;
  }
  if (relPath.startsWith('packages/')) {
    if (/^@gunnflow\/(web|bff)\b/.test(specifier) || /(^|\/)apps\//.test(specifier)) {
      return 'packages may not import from apps';
    }
  }
  return null;
}

function scanBackendNames(rel, lines) {
  if (!NAME_SCAN_DIRS.some((d) => rel.startsWith(d))) return;
  lines.forEach((line, i) => {
    if (BACKEND_NAMES.some((p) => p.test(line))) {
      violations.push(`${rel}:${i + 1}  backend proper name in the core: ${line.trim()}`);
    }
  });
}

function scanFile(path) {
  const text = readFileSync(path, 'utf8');
  const rel = relative(ROOT, path);
  const lines = text.split('\n');
  scanBackendNames(rel, lines);
  lines.forEach((line, i) => {
    const isImport = /\b(import|require|from)\b/.test(line);
    if (!isImport) return;
    if (FORBIDDEN.some((pattern) => pattern.test(line))) {
      violations.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
    for (const m of line.matchAll(SPECIFIER)) {
      const why = layeringViolation(rel, m[1]);
      if (why) violations.push(`${rel}:${i + 1}  ${why}: ${line.trim()}`);
    }
  });
}

function scanPackageJson(path) {
  const raw = readFileSync(path, 'utf8');
  const pkg = JSON.parse(raw);
  const rel = relative(ROOT, path);
  scanBackendNames(rel, raw.split('\n'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (isSimulatorBlind(rel) && dep.startsWith('@gunnflow-testing/')) {
        violations.push(`${rel}  ${field}: ${dep} — [simulator-isolation] may not depend on the simulator`);
      }
      if (rel.startsWith('testing/') && /^@gunnflow\/(web|bff)$/.test(dep)) {
        violations.push(`${rel}  ${field}: ${dep} — [simulator-layering] testing may not depend on apps`);
      }
    }
  }
  if (rel === join('packages', 'contract', 'package.json')) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        violations.push(`${rel}  ${field}: ${dep} — the contract has no runtime dependencies`);
      }
    }
  }
  if (rel.startsWith('packages/') && rel !== join('packages', 'contract', 'package.json')) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (/^@gunnflow\/(web|bff)$/.test(dep)) violations.push(`${rel}  ${field}: ${dep} — packages may not depend on apps`);
      }
    }
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      const external = !/^@gunnflow(-testing)?\//.test(dep);
      for (const pattern of FORBIDDEN_PACKAGES) {
        if (external && pattern.test(dep)) {
          violations.push(`${relative(ROOT, path)}  ${field}: ${dep}`);
        }
      }
    }
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (SRC_EXT.test(entry)) scanFile(path);
    else if (entry === 'package.json') scanPackageJson(path);
  }
}

for (const dir of SCAN_DIRS) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));

if (violations.length > 0) {
  console.error('boundary-lint FAILED:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('boundary-lint OK — no cross-repo imports; contract and simulator layering hold; the core names no backend.');
