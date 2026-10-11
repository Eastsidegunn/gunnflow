import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

/**
 * The unfamiliar-backend scenarios: a ticket board on the direct wire that shares no
 * vocabulary with the simulator (testing/fake-contracts/src/strangeServer.ts, :28791),
 * a BFF on `direct` (:28797, preview :28798) and a web instance proxying to it (:25174).
 * Own home, wiring and personal directories, so nothing leaks to or from the main suite.
 */
export const STRANGE_HOME = join(tmpdir(), 'gunnflow-e2e-strange-home');
export const STRANGE_WIRING_DIR = join(tmpdir(), 'gunnflow-e2e-strange-wiring');
export const STRANGE_PERSONAL_DIR = join(tmpdir(), 'gunnflow-e2e-strange-personal');
export const STRANGE_URL = 'http://127.0.0.1:28791';
mkdirSync(STRANGE_HOME, { recursive: true });
// The full view, as the main suite's canvas scenarios open on (rewritten at each config load).
writeFileSync(join(STRANGE_HOME, 'prefs.json'), JSON.stringify({ landingView: 'all' }, null, 2));

type WebServers = Extract<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>;

export const STRANGE_SERVERS: WebServers = [
  {
    command:
      'sh -c "pnpm --filter @gunnflow-testing/fake-contracts serve:strange & ' +
      'until curl -sf http://127.0.0.1:28791/nodes >/dev/null; do sleep 0.2; done; ' +
      'pnpm --filter @gunnflow/bff dev"',
    url: 'http://127.0.0.1:28797/api/health',
    reuseExistingServer: false,
    cwd: '../..',
    env: {
      GUNNFLOW_HOME: STRANGE_HOME,
      GUNNFLOW_UPSTREAM: 'direct',
      GUNNFLOW_UPSTREAM_URL: STRANGE_URL,
      GUNNFLOW_BFF_PORT: '28797',
      GUNNFLOW_PREVIEW_PORT: '28798',
      GUNNFLOW_WEB_ORIGIN: 'http://127.0.0.1:25174',
      GUNNFLOW_WIRING_DIR: STRANGE_WIRING_DIR,
      GUNNFLOW_PERSONAL_DIR: STRANGE_PERSONAL_DIR,
    },
  },
  {
    command: 'pnpm --filter @gunnflow/web dev',
    url: 'http://127.0.0.1:25174',
    reuseExistingServer: false,
    cwd: '../..',
    env: {
      GUNNFLOW_HOME: STRANGE_HOME,
      GUNNFLOW_WEB_PORT: '25174',
      GUNNFLOW_BFF_PORT: '28797',
      VITE_PREVIEW_ORIGIN: 'http://127.0.0.1:28798',
    },
  },
];

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'strange-backend.spec.ts',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:25174', locale: 'en-US' },
  webServer: STRANGE_SERVERS,
});
