// Machine-local prefs route: carried as-is, structure checked, never interpreted.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeUpstream } from '@gunnflow-testing/fake-contracts';
import { buildServer } from '../src/server.js';
import { PREFS_MAX_BYTES } from '../src/prefsStore.js';

describe('prefs route', () => {
  it('GET/PUT one JSON object at the configured file; broken files are reported, never replaced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gunnflow-prefs-'));
    const file = join(root, 'prefs.json');
    try {
      const app = buildServer({ upstream: createFakeUpstream('normal'), prefsFile: file });
      expect((await app.inject({ method: 'GET', url: '/api/prefs' })).json()).toEqual({ prefs: null });
      const prefs = { zoomSensitivity: 1.2, detailZoom: 0.6, defaultLens: 'needs-you' };
      expect((await app.inject({ method: 'PUT', url: '/api/prefs', payload: prefs })).json()).toEqual({ saved: true });
      expect((await app.inject({ method: 'GET', url: '/api/prefs' })).json()).toEqual({ prefs });
      // Structure only: non-objects and oversize refused; field meaning is the web's business.
      for (const bad of [[1], 'x', 3]) {
        expect((await app.inject({ method: 'PUT', url: '/api/prefs', payload: JSON.stringify(bad), headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'PUT', url: '/api/prefs', payload: { pad: 'x'.repeat(PREFS_MAX_BYTES) } })).statusCode).toBe(400);
      // An unreadable file is reported on read and protects against overwrite.
      writeFileSync(file, '{ broken');
      expect((await app.inject({ method: 'GET', url: '/api/prefs' })).statusCode).toBe(409);
      expect((await app.inject({ method: 'PUT', url: '/api/prefs', payload: prefs })).statusCode).toBe(409);
      await app.close();
      const none = buildServer({ upstream: createFakeUpstream('normal') });
      expect((await none.inject({ method: 'GET', url: '/api/prefs' })).statusCode).toBe(501);
      await none.close();
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
