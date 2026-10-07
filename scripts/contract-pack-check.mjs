#!/usr/bin/env node
// Packs @gunnflow/contract exactly as it would be published and checks the tarball:
// the manifest must point at built JavaScript (pnpm applies publishConfig when packing;
// a plain `npm publish` from the package directory would not), the version must match
// CONTRACT_VERSION, and the files a consumer needs must be inside.
//
//   node scripts/contract-pack-check.mjs            # check only (tarball removed)
//   node scripts/contract-pack-check.mjs --keep     # keep the tarball, print its path
//
// Requires a prior build (`pnpm --filter @gunnflow/contract build`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkgDir = new URL('../packages/contract/', import.meta.url).pathname;
const keep = process.argv.includes('--keep');
const outDir = keep ? pkgDir : mkdtempSync(join(tmpdir(), 'contract-pack-'));

execFileSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: pkgDir, stdio: ['ignore', 'ignore', 'inherit'] });
const tarball = readdirSync(outDir).find((f) => /^gunnflow-contract-.*\.tgz$/.test(f));
if (!tarball) {
  console.error('contract-pack-check: no tarball produced');
  process.exit(1);
}
const path = join(outDir, tarball);
const list = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).split('\n').filter(Boolean);
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }));
const versionJs = execFileSync('tar', ['-xOzf', path, 'package/dist/version.js'], { encoding: 'utf8' });

const problems = [];
const pointsAtDist = (v) => typeof v === 'string' && v.startsWith('./dist/') || typeof v === 'string' && v.startsWith('dist/');
if (manifest.private) problems.push('manifest is private');
if (!pointsAtDist(manifest.main)) problems.push(`main points at ${manifest.main}, not dist/`);
if (!pointsAtDist(manifest.types)) problems.push(`types points at ${manifest.types}, not dist/`);
for (const [entry, target] of Object.entries(manifest.exports ?? {})) {
  const t = typeof target === 'string' ? target : target?.import;
  const d = typeof target === 'string' ? null : target?.types;
  if (!pointsAtDist(t)) problems.push(`exports["${entry}"] import points at ${t}`);
  if (d !== null && !pointsAtDist(d)) problems.push(`exports["${entry}"] types points at ${d}`);
}
const m = versionJs.match(/CONTRACT_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!m) problems.push('dist/version.js has no CONTRACT_VERSION');
else if (m[1] !== manifest.version) problems.push(`CONTRACT_VERSION ${m[1]} != package version ${manifest.version}`);
for (const need of ['package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/conformance/index.js', 'package/dist/wiring/index.js', 'package/WIRE.md', 'package/README.md', 'package/LICENSE']) {
  if (!list.includes(need)) problems.push(`missing ${need.slice('package/'.length)}`);
}
if (list.some((f) => f.startsWith('package/test/') || f.includes('node_modules'))) problems.push('tests or node_modules leaked into the tarball');

if (!keep) rmSync(outDir, { recursive: true, force: true });
if (problems.length) {
  console.error(`contract-pack-check: ${tarball} is not publishable:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`contract-pack-check OK — ${tarball}: ${list.length} files, main ${manifest.main}, version ${manifest.version}${keep ? `\n${path}` : ''}`);
