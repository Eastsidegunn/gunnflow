// Isolates the suite from the developer's real Gunnflow home (see the `test` block of vite.config.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'gunnflow-test-home-'));
process.env.GUNNFLOW_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
