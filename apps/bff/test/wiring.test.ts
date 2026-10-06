// WP-K: the BFF carries the wiring directory's *.json files in file-name order,
// marking only transport failures (oversize, not JSON); no content validation.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIRING_LIMITS } from '@gunnflow/contract/wiring';
import { createFakeUpstream } from '@gunnflow-testing/fake-contracts';
import { readWiringDir } from '../src/wiringFiles.js';
import { buildServer } from '../src/server.js';
import { DEFAULT_WIRING_DIR, REPO_ROOT, parseConfig, wiringDirOf } from '../src/config.js';

describe('wiring directory', () => {
  it('an absent directory is an empty list', () => {
    expect(readWiringDir(join(tmpdir(), 'gunnflow-no-such-dir'))).toEqual([]);
    expect(readWiringDir(undefined)).toEqual([]);
  });

  it('reads *.json in file-name order; oversize and unparsable files carry an error; content is not judged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gunnflow-wiring-'));
    try {
      writeFileSync(join(dir, '20-b.json'), JSON.stringify({ version: '0.1.0', render: {} }));
      writeFileSync(join(dir, '10-a.json'), JSON.stringify({ anything: 'goes' }));
      writeFileSync(join(dir, '30-bad.json'), '{ not json');
      writeFileSync(join(dir, '40-big.json'), JSON.stringify({ pad: 'x'.repeat(WIRING_LIMITS.fileBytes) }));
      writeFileSync(join(dir, 'notes.txt'), 'ignored');
      mkdirSync(join(dir, '05-dir.json'));
      const entries = readWiringDir(dir);
      expect(entries.map((e) => e.file)).toEqual(['10-a.json', '20-b.json', '30-bad.json', '40-big.json']);
      expect(entries[0]).toEqual({ file: '10-a.json', config: { anything: 'goes' } });
      expect(entries[2]).toMatchObject({ file: '30-bad.json', error: expect.stringMatching(/^invalid JSON/) });
      expect(entries[3]).toMatchObject({ file: '40-big.json', error: expect.stringMatching(/larger than/) });

      const app = buildServer({ upstream: createFakeUpstream('normal'), wiringDir: dir });
      const res = await app.inject({ method: 'GET', url: '/api/wiring' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(entries);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the directory comes from settings (config wiringDir / GUNNFLOW_WIRING_DIR), default repo-root wiring/', () => {
    expect(wiringDirOf({})).toBe(join(REPO_ROOT, DEFAULT_WIRING_DIR));
    expect(wiringDirOf({ GUNNFLOW_WIRING_DIR: 'custom/wiring' })).toBe(join(REPO_ROOT, 'custom/wiring'));
    expect(wiringDirOf({ GUNNFLOW_WIRING_DIR: '/abs/wiring' })).toBe('/abs/wiring');
    expect(parseConfig({ wiringDir: 'wiring' })).toEqual({ wiringDir: 'wiring' });
    expect(() => parseConfig({ wiringDir: '' })).toThrow(/non-empty/);
  });
});
