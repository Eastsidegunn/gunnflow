import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

/**
 * Typing through an input method into a terminal (e2e/terminal-ime.spec.ts): the simulator's
 * echo shell behind a BFF (:38787, preview :38788) and a web instance proxying to it (:35173).
 * Own home, wiring and personal directories, and ports clear of a running dev or live cockpit.
 */
export const IME_HOME = join(tmpdir(), 'gunnflow-e2e-ime-home');
const IME_WIRING_DIR = join(tmpdir(), 'gunnflow-e2e-ime-wiring');
const IME_PERSONAL_DIR = join(tmpdir(), 'gunnflow-e2e-ime-personal');
mkdirSync(IME_HOME, { recursive: true });
writeFileSync(join(IME_HOME, 'prefs.json'), JSON.stringify({ landingView: 'all' }, null, 2));

type WebServers = Extract<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>;

export const IME_SERVERS: WebServers = [
  {
    command: 'pnpm --filter @gunnflow/bff dev',
    url: 'http://127.0.0.1:38787/api/health',
    reuseExistingServer: false,
    cwd: '../..',
    env: {
      GUNNFLOW_HOME: IME_HOME,
      GUNNFLOW_UPSTREAM: 'fake',
      GUNNFLOW_BFF_PORT: '38787',
      GUNNFLOW_PREVIEW_PORT: '38788',
      GUNNFLOW_WEB_ORIGIN: 'http://127.0.0.1:35173',
      GUNNFLOW_WIRING_DIR: IME_WIRING_DIR,
      GUNNFLOW_PERSONAL_DIR: IME_PERSONAL_DIR,
    },
  },
  {
    command: 'pnpm --filter @gunnflow/web dev',
    url: 'http://127.0.0.1:35173',
    reuseExistingServer: false,
    cwd: '../..',
    env: {
      GUNNFLOW_HOME: IME_HOME,
      GUNNFLOW_WEB_PORT: '35173',
      GUNNFLOW_BFF_PORT: '38787',
      VITE_PREVIEW_ORIGIN: 'http://127.0.0.1:38788',
    },
  },
];

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'terminal-ime.spec.ts',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:35173', locale: 'en-US' },
  webServer: IME_SERVERS,
});
