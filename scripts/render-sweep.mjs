#!/usr/bin/env node
/**
 * Render sweep: the unregistered-vocabulary fallback (neutral glyph, default
 * edge, ambient, fallback viewer) keeps the screen honest, but for a directly
 * wired backend an emitted-yet-unmapped term is a Gunnflow bug. This script
 * fetches the live projection, unions the vocabulary mapped by the valid
 * wiring configs, and reports every emitted term the union does not cover.
 *
 * Usage: node scripts/render-sweep.mjs [--url <backend base URL>] [--wiring <dir>]
 * The wire URL has no built-in default. Resolution order: `--url` >
 * env GUNNFLOW_SWEEP_URL > the `url` of gunnflow.config.json (or the file named
 * by GUNNFLOW_CONFIG) when its `upstream` is "direct" > otherwise exit 3.
 * Exit codes: 0 = clean, 1 = gaps found, 2 = wire unreachable, 3 = setup error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_WIRING = './wiring';
const CONFIG_PATH = process.env.GUNNFLOW_CONFIG ?? new URL('../gunnflow.config.json', import.meta.url).pathname;

/** The wire URL from the config file, only when that file selects the direct upstream. */
function configuredDirectUrl() {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return config?.upstream === 'direct' && typeof config.url === 'string' && config.url !== '' ? config.url : undefined;
  } catch (error) {
    console.error(`render sweep: cannot read ${CONFIG_PATH} (${error.message})`);
    process.exit(3);
  }
}

function parseArgs(argv) {
  const opts = { url: undefined, wiring: DEFAULT_WIRING };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (name !== '--url' && name !== '--wiring') {
      console.error(`render sweep: unknown argument '${arg}' (expected --url, --wiring)`);
      process.exit(3);
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[(i += 1)];
    if (value === undefined) {
      console.error(`render sweep: ${name} needs a value`);
      process.exit(3);
    }
    opts[name.slice(2)] = value;
  }
  opts.url ??= process.env.GUNNFLOW_SWEEP_URL || configuredDirectUrl();
  if (!opts.url) {
    console.error(
      'render sweep: no wire URL — pass --url <backend base URL> (or set GUNNFLOW_SWEEP_URL, ' +
        'or a gunnflow.config.json with "upstream": "direct" and "url").',
    );
    process.exit(3);
  }
  return opts;
}

async function loadValidator() {
  const distUrl = new URL('../packages/contract/dist/wiring/index.js', import.meta.url);
  try {
    const mod = await import(distUrl.href);
    if (typeof mod.validateWiringConfig !== 'function') throw new Error('validateWiringConfig not exported');
    return mod.validateWiringConfig;
  } catch (error) {
    console.error('render sweep: cannot load @gunnflow/contract/wiring validator from the contract build.');
    console.error(`  (${error.message})`);
    console.error('  Build it first: pnpm --filter @gunnflow/contract build');
    process.exit(3);
  }
}

async function fetchNodes(baseUrl) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/nodes`;
  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    console.error(`render sweep: wire is not up — could not reach ${endpoint}`);
    console.error(`  (${error.cause?.message ?? error.message})`);
    process.exit(2);
  }
  if (!response.ok) {
    console.error(`render sweep: wire at ${endpoint} answered ${response.status} ${response.statusText}`);
    process.exit(2);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    console.error(`render sweep: wire at ${endpoint} did not return JSON (${error.message})`);
    process.exit(2);
  }
  const nodes = Array.isArray(body) ? body : body?.nodes;
  if (!Array.isArray(nodes)) {
    console.error(`render sweep: response from ${endpoint} has no NodeProjection[] (expected an array or { nodes })`);
    process.exit(2);
  }
  return nodes;
}

/** Read wiring/*.json in filename order, validate each, union the vocabulary tables of the valid ones. */
async function loadWiringUnion(wiringDir, validateWiringConfig) {
  let entries;
  try {
    entries = (await readdir(wiringDir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    console.error(`render sweep: cannot read wiring directory ${wiringDir} (${error.message})`);
    process.exit(3);
  }
  const union = {
    render: new Set(),
    relations: new Set(),
    causes: new Set(),
    viewers: new Set(),
    kinds: new Set(),
  };
  const validFiles = [];
  let merged;
  for (const name of entries) {
    const filePath = path.join(wiringDir, name);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      console.error(`render sweep: skipping ${name} — not valid JSON (${error.message})`);
      continue;
    }
    const result = validateWiringConfig(parsed);
    if (!result.ok) {
      console.error(`render sweep: skipping ${name} — wiring validation failed:`);
      for (const problem of result.problems) console.error(`  - ${problem}`);
      continue;
    }
    validFiles.push(name);
    const { config } = result;
    merged = merged === undefined ? config : mergeWiring(merged, config);
    for (const key of Object.keys(config.render ?? {})) union.render.add(key);
    for (const key of Object.keys(config.relations ?? {})) union.relations.add(key);
    for (const rule of config.attention ?? []) union.causes.add(rule.match.cause);
    for (const key of Object.keys(config.viewers ?? {})) union.viewers.add(key);
    for (const key of Object.keys(config.kinds ?? {})) union.kinds.add(key);
  }
  // The engine layers the files in name order and validates the MERGE as a whole
  // (apps/web loadWiringFiles); a rejected merge falls back wholesale, so a
  // union-only check could report a false clean. Mirror the merge here.
  // (Known limit: the engine's built-in DEFAULT_WIRING floor is not included,
  // so vocabulary mapped only by the default may be over-reported as a gap.)
  if (merged !== undefined) {
    const whole = validateWiringConfig(merged);
    if (!whole.ok) {
      console.error('render sweep: the merged wiring config is rejected — the engine would fall back to its default:');
      for (const problem of whole.problems) console.error(`  - ${problem}`);
      process.exit(3);
    }
  }
  return { union, validFiles };
}

/** The engine's merge: tables override per key; attention/lenses replace per cause/id, else append. */
function mergeWiring(base, over) {
  const table = (a, b) => (a || b ? { ...(a ?? {}), ...(b ?? {}) } : undefined);
  const byKey = (as, bs, keyOf) => {
    const out = [...(as ?? [])];
    for (const item of bs ?? []) {
      const at = out.findIndex((x) => keyOf(x) === keyOf(item));
      if (at >= 0) out[at] = item;
      else out.push(item);
    }
    return out.length > 0 ? out : undefined;
  };
  const merged = { version: base.version };
  for (const k of ['render', 'relations', 'viewers', 'kinds']) {
    const t = table(base[k], over[k]);
    if (t) merged[k] = t;
  }
  const attention = byKey(base.attention, over.attention, (r) => r.match.cause);
  if (attention) merged.attention = attention;
  const lenses = byKey(base.lenses, over.lenses, (l) => l.id);
  if (lenses) merged.lenses = lenses;
  return merged;
}

/** Mirrors the engine's viewer lookup: exact media type, else type/* — never a wildcard for SVG. */
function viewerMapped(viewers, mediaType) {
  if (viewers.has(mediaType)) return true;
  if (mediaType === 'image/svg+xml') return false;
  const slash = mediaType.indexOf('/');
  return slash > 0 && viewers.has(`${mediaType.slice(0, slash)}/*`);
}

/** gaps: Map<term, Map<kind, Set<nodeId>>> so each gap reports which kinds use it and in how many nodes. */
function recordGap(gaps, term, node) {
  let byKind = gaps.get(term);
  if (!byKind) gaps.set(term, (byKind = new Map()));
  let ids = byKind.get(node.kind);
  if (!ids) byKind.set(node.kind, (ids = new Set()));
  ids.add(node.id);
}

function reportGaps(label, gaps) {
  for (const [term, byKind] of [...gaps.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const usage = [...byKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, ids]) => `${kind} (${ids.size} node${ids.size === 1 ? '' : 's'})`)
      .join(', ');
    console.log(`  unmapped ${label} '${term}' — used by ${usage}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const wiringDir = path.resolve(process.cwd(), opts.wiring);
const validateWiringConfig = await loadValidator();
const [nodes, { union, validFiles }] = await Promise.all([
  fetchNodes(opts.url),
  loadWiringUnion(wiringDir, validateWiringConfig),
]);

const gaps = { kind: new Map(), state: new Map(), relation: new Map(), cause: new Map(), mediaType: new Map() };
for (const node of nodes) {
  if (!node || typeof node !== 'object') continue;
  // An unmapped kind renders as the default assembly — honest, but for a
  // directly wired backend it means no kind-specific parts were designed.
  if (typeof node.kind === 'string' && !union.kinds.has(node.kind)) recordGap(gaps.kind, node.kind, node);
  const stateValue = node.state?.value;
  if (typeof stateValue === 'string' && !union.render.has(stateValue)) recordGap(gaps.state, stateValue, node);
  for (const relation of node.relations ?? []) {
    if (typeof relation?.type === 'string' && !union.relations.has(relation.type)) {
      recordGap(gaps.relation, relation.type, node);
    }
  }
  for (const attention of node.attention ?? []) {
    if (typeof attention?.cause === 'string' && !union.causes.has(attention.cause)) {
      recordGap(gaps.cause, attention.cause, node);
    }
  }
  for (const artifact of node.artifacts ?? []) {
    // A live artifact is a portal whatever its media type — never a viewer gap.
    if (artifact?.access && artifact.access.kind !== 'snapshot') continue;
    if (typeof artifact?.mediaType === 'string' && !viewerMapped(union.viewers, artifact.mediaType)) {
      recordGap(gaps.mediaType, artifact.mediaType, node);
    }
  }
}

const gapCount =
  gaps.kind.size + gaps.state.size + gaps.relation.size + gaps.cause.size + gaps.mediaType.size;
console.log(
  `render sweep: ${nodes.length} nodes from ${opts.url}, wiring union from ${validFiles.length} valid config file${validFiles.length === 1 ? '' : 's'} (${validFiles.join(', ') || 'none'})`,
);
if (gapCount === 0) {
  console.log('render sweep clean');
  process.exit(0);
}
console.log(`render sweep: ${gapCount} unmapped vocabulary term${gapCount === 1 ? '' : 's'} emitted by the wire:`);
reportGaps('kind', gaps.kind);
reportGaps('state', gaps.state);
reportGaps('relation type', gaps.relation);
reportGaps('attention cause', gaps.cause);
reportGaps('artifact mediaType', gaps.mediaType);
process.exit(1);
