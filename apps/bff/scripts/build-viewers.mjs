// Builds the isolated Excalidraw viewer's static bundle into viewers/dist
// (vendored library: no CDN). Skips when current; `--force` rebuilds.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'viewers', 'dist', 'excalidraw');
const entry = join(root, 'viewers', 'excalidraw-viewer.ts');
// The package's own directory (its exports map hides package.json from resolution).
const pkgJson = join(root, 'node_modules', '@excalidraw', 'excalidraw', 'package.json');
const stamp = join(out, '.stamp');
const key = `${statSync(entry).mtimeMs}:${JSON.parse(readFileSync(pkgJson, 'utf8')).version}`;

if (existsSync(stamp) && readFileSync(stamp, 'utf8') === key && !process.argv.includes('--force')) {
  console.log('viewers: up to date');
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    splitting: true,
    minify: true,
    target: 'es2022',
    outdir: out,
    external: ['/viewer-assets/*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty', '.woff2': 'empty' },
    metafile: true,
    logLevel: 'warning',
  });
  // Excalidraw's font-subsetting worker chunks are referenced relative to the bundle.
  const prod = join(dirname(pkgJson), 'dist', 'prod');
  for (const f of ['subset-worker.chunk.js', 'subset-shared.chunk.js']) {
    if (existsSync(join(prod, f))) cpSync(join(prod, f), join(out, f));
  }
  const outputs = result.metafile.outputs;
  const total = Object.values(outputs).reduce((s, o) => s + o.bytes, 0);
  // Bytes the viewer loads up front (its static import closure).
  const entryKey = Object.keys(outputs).find((k) => k.endsWith('excalidraw-viewer.js'));
  const seen = new Set();
  const stack = [entryKey];
  let initial = 0;
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k) || !outputs[k]) continue;
    seen.add(k);
    initial += outputs[k].bytes;
    // The entry's own dynamic import (the library) loads on every render; deeper dynamic imports are optional.
    for (const i of outputs[k].imports) if (i.kind === 'import-statement' || (k === entryKey && i.kind === 'dynamic-import')) stack.push(i.path);
  }
  writeFileSync(stamp, key);
  console.log(`viewers: excalidraw bundle ${Object.keys(outputs).length} files, ${total} bytes total, ${initial} bytes loaded per render`);
}
