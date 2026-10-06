import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file runs with GUNNFLOW_HOME in a fresh temp dir: no test reads
    // or writes a developer's real ~/.gunnflow (their config, wiring, notes).
    setupFiles: ['test/setup-home.ts'],
  },
});
