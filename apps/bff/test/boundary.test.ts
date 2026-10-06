// Acceptance A1–A3: the boundary lint must pass, and must actually catch violations.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const LINT = join(REPO_ROOT, 'scripts', 'boundary-lint.mjs');

// Sandboxes carry a synthetic names file: the test spells no real backend name.
const SYNTHETIC_NAMES = {
  backendNames: [{ name: 'SomeBackend', pattern: 'somebackend', flags: 'i' }],
  forbiddenPackages: [{ name: 'SomeBackend (npm scope)', pattern: '@somebackend/', flags: 'i' }],
  siblingRepos: ['SomeBackend'],
};
function installLint(sandbox: string): string {
  mkdirSync(join(sandbox, 'scripts'), { recursive: true });
  const lint = join(sandbox, 'scripts', 'boundary-lint.mjs');
  cpSync(LINT, lint);
  writeFileSync(join(sandbox, 'scripts', 'boundary-names.json'), JSON.stringify(SYNTHETIC_NAMES));
  return lint;
}

describe('boundary lint (A1–A3)', () => {
  it('passes on the real repo — no cross-repo imports, layering holds', () => {
    const out = execFileSync('node', [LINT], { encoding: 'utf8' });
    expect(out).toContain('boundary-lint OK');
  });

  it('fails when a forbidden import is introduced', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-lint-'));
    try {
      const lint = installLint(sandbox);
      mkdirSync(join(sandbox, 'apps', 'bad'), { recursive: true });
      mkdirSync(join(sandbox, 'packages'), { recursive: true });
      writeFileSync(join(sandbox, 'apps', 'bad', 'evil.ts'), "import { runtime } from '@somebackend/runtime';\n");
      expect(() => execFileSync('node', [lint], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
  it('enforces contract layering: the contract is pure, the simulator never flows back into it', () => {
    const cases: Array<[string, string]> = [
      ['packages/contract/src/bad.ts', "import { FakeWorkspaceStream } from '@gunnflow-testing/fake-contracts';\n"],
      ['packages/contract/src/bad.ts', "import { createSignal } from 'solid-js';\n"],
      ['packages/contract/src/bad.ts', "import { x } from '../../fake-contracts/src/index.js';\n"],
      ['testing/fake-contracts/src/bad.ts', "import { App } from '@gunnflow/web';\n"],
      ['packages/upstream-port/src/bad.ts', "import { createFakeUpstream } from '@gunnflow-testing/fake-contracts';\n"],
      ['packages/upstream-port/src/bad.ts', "import { x } from '../../../testing/fake-contracts/src/index.js';\n"],
      [
        'packages/upstream-port/package.json',
        JSON.stringify({ name: 'x', devDependencies: { '@gunnflow-testing/fake-contracts': 'workspace:*' } }),
      ],
      ['testing/fake-contracts/src/bad.ts', "import { x } from '../../../apps/bff/src/server.js';\n"],
      ['packages/upstream-port/src/bad.ts', "import { buildServer } from '@gunnflow/bff';\n"],
      ['apps/web/src/note.ts', '// talks to SomeBackend directly\n'],
      ['apps/web/src/sibling.ts', "import { x } from '../../../SomeBackend/src/index.js';\n"],
    ];
    for (const [file, source] of cases) {
      const sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-lint-'));
      try {
        const lint = installLint(sandbox);
        mkdirSync(join(sandbox, 'apps'), { recursive: true });
        mkdirSync(join(sandbox, file, '..'), { recursive: true });
        writeFileSync(join(sandbox, file), source);
        expect(
          () => execFileSync('node', [lint], { encoding: 'utf8', stdio: 'pipe' }),
          `${file}: ${source.trim()}`,
        ).toThrow();
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it('reads the names from data: the lint code spells no name of its own', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-lint-'));
    try {
      const lint = installLint(sandbox);
      mkdirSync(join(sandbox, 'apps', 'web', 'src'), { recursive: true });
      writeFileSync(join(sandbox, 'apps', 'web', 'src', 'ok.ts'), '// talks to OtherBackend directly\n');
      expect(execFileSync('node', [lint], { encoding: 'utf8' })).toContain('boundary-lint OK');
      rmSync(join(sandbox, 'scripts', 'boundary-names.json'));
      expect(() => execFileSync('node', [lint], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('allows apps using packages and the simulator, and the simulator using packages', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-lint-'));
    try {
      const lint = installLint(sandbox);
      mkdirSync(join(sandbox, 'apps', 'bff', 'src'), { recursive: true });
      mkdirSync(join(sandbox, 'packages'), { recursive: true });
      writeFileSync(join(sandbox, 'apps', 'bff', 'src', 'main.ts'), "import type { WorkspaceUpstream } from '@gunnflow/upstream-port';\n");
      // Apps may use the simulator (fake mode is the demo and e2e runtime); testing may use packages.
      mkdirSync(join(sandbox, 'apps', 'web', 'src'), { recursive: true });
      writeFileSync(join(sandbox, 'apps', 'web', 'src', 'fixtures.ts'), "import { normalFixture } from '@gunnflow-testing/fake-contracts';\n");
      mkdirSync(join(sandbox, 'testing', 'fake-contracts', 'src'), { recursive: true });
      writeFileSync(join(sandbox, 'testing', 'fake-contracts', 'src', 'index.ts'), "import type { Intent } from '@gunnflow/contract';\n");
      const out = execFileSync('node', [lint], { encoding: 'utf8' });
      expect(out).toContain('boundary-lint OK');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
