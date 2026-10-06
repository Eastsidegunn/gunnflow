// WP-Q2: the settings file route writes only <wiringDir>/90-user.json; the upstream label is readable.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIRING_LIMITS } from '@gunnflow/contract/wiring';
import { createFakeUpstream } from '@gunnflow-testing/fake-contracts';
import { buildServer } from '../src/server.js';

describe('user wiring route', () => {
  it('GET/PUT/DELETE touch exactly 90-user.json; structure is checked; an unreadable file is reported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gunnflow-user-wiring-'));
    const dir = join(root, 'wiring');
    try {
      const app = buildServer({ upstream: createFakeUpstream('normal'), wiringDir: dir, upstreamLabel: 'fake' });
      expect((await app.inject({ method: 'GET', url: '/api/upstream' })).json()).toEqual({ label: 'fake' });
      expect((await app.inject({ method: 'GET', url: '/api/wiring/user' })).json()).toEqual({ config: null });
      const config = { version: '0.1.0', render: { running: { glyph: '●', tone: '#ff5d5d' } } };
      expect((await app.inject({ method: 'PUT', url: '/api/wiring/user', payload: config })).json()).toEqual({ saved: true });
      expect(readdirSync(dir)).toEqual(['90-user.json']);
      expect(JSON.parse(readFileSync(join(dir, '90-user.json'), 'utf8'))).toEqual(config);
      expect((await app.inject({ method: 'GET', url: '/api/wiring/user' })).json()).toEqual({ config });
      // It is one of the merged files, last in name order.
      writeFileSync(join(dir, '10-a.json'), '{"version":"0.1.0"}');
      expect(((await app.inject({ method: 'GET', url: '/api/wiring' })).json() as { file: string }[]).map((e) => e.file)).toEqual(['10-a.json', '90-user.json']);
      for (const bad of [[1], 'x']) {
        expect((await app.inject({ method: 'PUT', url: '/api/wiring/user', payload: JSON.stringify(bad), headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'PUT', url: '/api/wiring/user', payload: { pad: 'x'.repeat(WIRING_LIMITS.fileBytes) } })).statusCode).toBe(400);
      writeFileSync(join(dir, '90-user.json'), '{ broken');
      expect((await app.inject({ method: 'GET', url: '/api/wiring/user' })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: '/api/wiring/user' })).json()).toEqual({ removed: true });
      expect(existsSync(join(dir, '90-user.json'))).toBe(false);
      expect(existsSync(join(dir, '10-a.json'))).toBe(true);
      await app.close();
      const none = buildServer({ upstream: createFakeUpstream('normal') });
      expect((await none.inject({ method: 'PUT', url: '/api/wiring/user', payload: config })).statusCode).toBe(501);
      await none.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
