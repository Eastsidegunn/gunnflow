// scripts/peer-range.mjs (used by pack-check): caret ranges, optionally joined by `||`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
type Mod = { rangeAdmits: (range: string, v: string) => boolean; caretAdmits: (range: string, v: string) => boolean };
const load = async () => (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'peer-range.mjs')).href)) as Mod;

describe('peer ranges for pack-check', () => {
  it('0.x caret: same minor, patch at least', async () => {
    const { caretAdmits } = await load();
    expect(caretAdmits('^0.3.1', '0.3.1')).toBe(true);
    expect(caretAdmits('^0.3.1', '0.3.9')).toBe(true);
    expect(caretAdmits('^0.3.1', '0.3.0')).toBe(false);
    expect(caretAdmits('^0.3.1', '0.4.0')).toBe(false);
    expect(caretAdmits('^1.2.0', '1.9.0')).toBe(true);
    expect(caretAdmits('^1.2.0', '2.0.0')).toBe(false);
  });

  it('|| joins caret parts; any other form admits nothing', async () => {
    const { rangeAdmits } = await load();
    const range = '^0.3.1 || ^0.4.0';
    expect(rangeAdmits(range, '0.3.1')).toBe(true);
    expect(rangeAdmits(range, '0.4.0')).toBe(true);
    expect(rangeAdmits(range, '0.4.7')).toBe(true);
    expect(rangeAdmits(range, '0.5.0')).toBe(false);
    expect(rangeAdmits(range, '0.3.0')).toBe(false);
    expect(rangeAdmits('^0.3.1||^0.4.0', '0.4.0')).toBe(true);
    expect(rangeAdmits('^0.3.1', '0.4.0')).toBe(false);
    for (const bad of ['>=0.3.1', '^0.3.1 || *', '0.3.1', '^0.3.1 || ', '^0.3 || ^0.4.0', '']) {
      expect(rangeAdmits(bad, '0.3.1'), bad).toBe(false);
    }
  });

  it("the tree's upstream-port peer admits both 0.3.1 and the tree's contract version", async () => {
    const { rangeAdmits } = await load();
    const read = (p: string) => JSON.parse(readFileSync(join(REPO_ROOT, p), 'utf8')) as { version: string; peerDependencies?: Record<string, string> };
    const peer = read('packages/upstream-port/package.json').peerDependencies!['@gunnflow/contract']!;
    expect(rangeAdmits(peer, '0.3.1')).toBe(true);
    expect(rangeAdmits(peer, read('packages/contract/package.json').version)).toBe(true);
  });
});
