#!/usr/bin/env node
// Packs one publishable workspace package exactly as it would be published and checks the
// tarball: the manifest must point at built JavaScript (pnpm applies publishConfig when packing;
// a plain `npm publish` from the package directory would not) and the files a consumer needs
// must be inside. Per package:
//   packages/contract       CONTRACT_VERSION equals the package version; WIRE.md and the
//                           conformance / wiring entry points are inside.
//   packages/upstream-port  the packed peer range for @gunnflow/contract is a caret range that
//                           still admits the oldest contract consumers use (0.3.1).
// Every main/types/exports target must exist in the tarball, and each package's required
// export entries must be present.
//
//   node scripts/pack-check.mjs packages/contract           # check only (tarball removed)
//   node scripts/pack-check.mjs packages/upstream-port --keep   # keep the tarball, print its path
//
// Requires a prior build (`pnpm build`).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGES = {
  'packages/contract': {
    tarball: /^gunnflow-contract-.*\.tgz$/,
    files: ['dist/conformance/index.js', 'dist/wiring/index.js', 'WIRE.md'],
    exports: ['.', './conformance', './wiring'],
    check(read, manifest, problems) {
      const m = read('package/dist/version.js').match(/CONTRACT_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (!m) problems.push('dist/version.js has no CONTRACT_VERSION');
      else if (m[1] !== manifest.version) problems.push(`CONTRACT_VERSION ${m[1]} != package version ${manifest.version}`);
      return `version ${manifest.version}`;
    },
  },
  'packages/upstream-port': {
    tarball: /^gunnflow-upstream-port-.*\.tgz$/,
    files: [],
    exports: ['.'],
    check(_read, manifest, problems) {
      const range = manifest.peerDependencies?.['@gunnflow/contract'];
      if (typeof range !== 'string' || !range) problems.push('no peer range for @gunnflow/contract');
      else if (!caretAdmits(range, OLDEST_CONTRACT)) problems.push(`peer range ${range} for @gunnflow/contract must be a caret range admitting ${OLDEST_CONTRACT}`);
      return `version ${manifest.version}, peer @gunnflow/contract ${range}`;
    },
  },
};

/** The oldest contract version a published upstream-port must still install next to. */
const OLDEST_CONTRACT = '0.3.1';
/** `^M.m.p` admits `v` (0.x caret: same major and minor, patch >= p; 1+: same major, >=). */
function caretAdmits(range, v) {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const x = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!r || !x) return false;
  const [rM, rm, rp] = r.slice(1).map(Number);
  const [xM, xm, xp] = x.slice(1).map(Number);
  if (rM !== xM) return false;
  if (rM === 0) return rm === xm && xp >= rp;
  return xm > rm || (xm === rm && xp >= rp);
}

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const positional = args.filter((a) => a !== '--keep');
const target = positional[0]?.replace(/\/+$/, '');
const spec = positional.length === 1 && !target.startsWith('-') && PACKAGES[target];
if (!spec) {
  console.error(`usage: node scripts/pack-check.mjs <${Object.keys(PACKAGES).join('|')}> [--keep]`);
  process.exit(2);
}
const name = `pack-check ${target}`;
const pkgDir = new URL(`../${target}/`, import.meta.url).pathname;
const outDir = keep ? pkgDir : mkdtempSync(join(tmpdir(), 'pack-check-'));

// The exact file this pack produces — never another tarball left in the directory by an
// earlier version (--keep packs into the package directory).
const source = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const tarball = `${source.name.replace(/^@/, '').replace('/', '-')}-${source.version}.tgz`;
rmSync(join(outDir, tarball), { force: true });
execFileSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: pkgDir, stdio: ['ignore', 'ignore', 'inherit'] });
if (!spec.tarball.test(tarball) || !existsSync(join(outDir, tarball))) {
  console.error(`${name}: expected tarball ${tarball} was not produced`);
  process.exit(1);
}
const path = join(outDir, tarball);
const list = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).split('\n').filter(Boolean);
const read = (file) => (list.includes(file) ? execFileSync('tar', ['-xOzf', path, file], { encoding: 'utf8' }) : '');
const manifest = JSON.parse(read('package/package.json'));

const problems = [];
const pointsAtDist = (v) => typeof v === 'string' && (v.startsWith('./dist/') || v.startsWith('dist/'));
if (manifest.private) problems.push('manifest is private');
if (!pointsAtDist(manifest.main)) problems.push(`main points at ${manifest.main}, not dist/`);
if (!pointsAtDist(manifest.types)) problems.push(`types points at ${manifest.types}, not dist/`);
const inTarball = (rel) => list.includes(`package/${rel.replace(/^\.\//, '')}`);
const targetExists = (label, rel) => {
  if (typeof rel === 'string' && pointsAtDist(rel) && !inTarball(rel)) problems.push(`${label} target ${rel} is not in the tarball`);
};
targetExists('main', manifest.main);
targetExists('types', manifest.types);
for (const [entry, t] of Object.entries(manifest.exports ?? {})) {
  const imp = typeof t === 'string' ? t : t?.import;
  const types = typeof t === 'string' ? null : t?.types;
  if (!pointsAtDist(imp)) problems.push(`exports["${entry}"] import points at ${imp}`);
  if (types !== null && !pointsAtDist(types)) problems.push(`exports["${entry}"] types points at ${types}`);
  targetExists(`exports["${entry}"] import`, imp);
  if (types !== null) targetExists(`exports["${entry}"] types`, types);
}
for (const entry of spec.exports) {
  if (!manifest.exports || !(entry in manifest.exports)) problems.push(`missing export entry "${entry}"`);
}
for (const need of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE', ...spec.files]) {
  if (!list.includes(`package/${need}`)) problems.push(`missing ${need}`);
}
if (list.some((f) => f.startsWith('package/test/') || f.includes('node_modules'))) problems.push('tests or node_modules leaked into the tarball');
const summary = spec.check(read, manifest, problems);

if (!keep) rmSync(outDir, { recursive: true, force: true });
if (problems.length) {
  console.error(`${name}: ${tarball} is not publishable:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${name} OK — ${tarball}: ${list.length} files, main ${manifest.main}, ${summary}${keep ? `\n${path}` : ''}`);
