// Acceptance A1–A3: the boundary lint must pass, and must actually catch violations.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const LINT = join(REPO_ROOT, 'scripts', 'boundary-lint.mjs');

// Sandboxes carry a synthetic names file: the test spells no real backend name. The simulator doors
// and the domain vocabulary are the repository's own data.
const REAL_NAMES = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'boundary-names.json'), 'utf8'));
const SYNTHETIC_NAMES = {
  backendNames: [{ name: 'SomeBackend', pattern: 'somebackend', flags: 'i' }],
  forbiddenPackages: [{ name: 'SomeBackend (npm scope)', pattern: '@somebackend/', flags: 'i' }],
  siblingRepos: ['SomeBackend'],
  simulatorDoors: REAL_NAMES.simulatorDoors,
  domainVocabulary: REAL_NAMES.domainVocabulary,
};
function installLint(sandbox: string): string {
  mkdirSync(join(sandbox, 'scripts'), { recursive: true });
  const lint = join(sandbox, 'scripts', 'boundary-lint.mjs');
  cpSync(LINT, lint);
  writeFileSync(join(sandbox, 'scripts', 'boundary-names.json'), JSON.stringify(SYNTHETIC_NAMES));
  return lint;
}
function inSandbox(files: Record<string, string>, body: (lint: string, sandbox: string) => void) {
  const sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-lint-'));
  try {
    const lint = installLint(sandbox);
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(join(sandbox, file, '..'), { recursive: true });
      writeFileSync(join(sandbox, file), source);
    }
    body(lint, sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
const run = (lint: string, args: string[] = []) => execFileSync('node', [lint, ...args], { encoding: 'utf8', stdio: 'pipe' });

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

  it('merges $GUNNFLOW_HOME/boundary-names.local.json, unless BOUNDARY_NAMES_FILE is set', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-lint-'));
    try {
      const lint = installLint(sandbox);
      mkdirSync(join(sandbox, 'apps', 'web', 'src'), { recursive: true });
      writeFileSync(join(sandbox, 'apps', 'web', 'src', 'ok.ts'), '// talks to PrivateBackend directly\n');
      const home = join(sandbox, 'home');
      mkdirSync(home);
      const env = { ...process.env, GUNNFLOW_HOME: home };
      const run = (extra: Record<string, string> = {}) => execFileSync('node', [lint], { encoding: 'utf8', stdio: 'pipe', env: { ...env, ...extra } });
      expect(run()).toContain('boundary-lint OK');
      writeFileSync(join(home, 'boundary-names.local.json'), JSON.stringify({ backendNames: [{ name: 'Private', pattern: 'privatebackend', flags: 'i' }] }));
      expect(() => run()).toThrow();
      expect(run({ BOUNDARY_NAMES_FILE: join(sandbox, 'scripts', 'boundary-names.json') })).toContain('boundary-lint OK');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('allows apps using packages, app tests and the composition door using the simulator, and the simulator using packages', () => {
    inSandbox(
      {
        'apps/bff/src/main.ts': "import type { WorkspaceUpstream } from '@gunnflow/upstream-port';\n",
        // Fake mode is the demo and e2e runtime: the composition loads the simulator by name, dynamically.
        'apps/bff/src/composition.ts': "export const SIMULATOR_MODULE = '@gunnflow-testing/fake-contracts';\n",
        'apps/web/test/fixtures.ts': "import { normalFixture } from '@gunnflow-testing/fake-contracts';\n",
        'apps/web/src/thing.test.ts': "import { normalFixture } from '@gunnflow-testing/fake-contracts';\n",
        'testing/fake-contracts/src/index.ts': "import type { Intent } from '@gunnflow/contract';\n",
        // Domain words in tests, the catalog and the default wiring are fine; a catalog key is not an action.
        'apps/web/test/x.test.ts': "if (kind === 'task') submit({ action: 'task.pause' });\n",
        'apps/web/src/i18n/en.ts': "export const en = { 'gate.send': 'Send' };\n",
        'apps/web/src/wiring/defaultWiring.ts': "export const w = { actions: { 'task.pause': {} } };\n",
        'apps/web/src/Label.tsx': "export const L = () => t('session.pause') + t('inspector.gates');\n",
      },
      (lint) => expect(run(lint)).toContain('boundary-lint OK'),
    );
  });

  it('keeps app runtime source simulator-blind: any other simulator reference fails', () => {
    for (const [file, source] of <Array<[string, string]>>[
      ['apps/web/src/fixtures.ts', "import { normalFixture } from '@gunnflow-testing/fake-contracts';\n"],
      ['apps/web/src/types.ts', "export type P = import('@gunnflow-testing/fake-contracts').FakeWorkspaceProjection;\n"],
      ['apps/bff/src/other.ts', "const m = '@gunnflow-testing/fake-contracts';\n"],
      ['apps/bff/src/composition.ts', "export const SIMULATOR_MODULE = '@gunnflow-testing/fake-contracts/direct-server';\n"],
      ['apps/web/src/rel.ts', "import { x } from '../../../testing/fake-contracts/src/index.js';\n"],
    ]) {
      inSandbox({ [file]: source }, (lint) => expect(() => run(lint), `${file}: ${source.trim()}`).toThrow(/simulator-blind-apps/));
    }
  });

  it('flags domain vocabulary in the core', () => {
    for (const [file, source] of <Array<[string, string]>>[
      ['apps/web/src/a.ts', "submit({ nodeId, action: 'gate.approve' });\n"],
      ['apps/web/src/b.ts', "if (node.kind === 'mission') open();\n"],
      ['apps/web/src/c.ts', "if ('deliverable' !== n.kind) return;\n"],
      ['apps/web/src/d.ts', 'const all = projection.tasks.length;\n'],
      ['packages/engine/src/e.ts', "const k = kind == 'session';\n"],
    ]) {
      inSandbox({ [file]: source }, (lint) => expect(() => run(lint), `${file}: ${source.trim()}`).toThrow(/domain-vocabulary/));
    }
  });

  it('ratchets against the baseline: growth fails, shrinkage asks for a smaller baseline, --shrink-baseline only lowers', () => {
    const two = "submit({ action: 'task.pause' });\nsubmit({ action: 'task.resume' });\n";
    inSandbox({ 'apps/web/src/a.ts': two }, (lint, sandbox) => {
      const baselineFile = join(sandbox, 'scripts', 'boundary-baseline.json');
      const write = (b: unknown) => writeFileSync(baselineFile, JSON.stringify(b));
      const read = () => JSON.parse(readFileSync(baselineFile, 'utf8'));
      write({ 'domain-vocabulary': { 'apps/web/src/a.ts': 2 } });
      expect(run(lint)).toContain('boundary-lint OK');
      // A third occurrence — or the same words in a file the baseline does not list — fails.
      writeFileSync(join(sandbox, 'apps/web/src/a.ts'), two + "submit({ action: 'task.instruct' });\n");
      expect(() => run(lint)).toThrow(/3 found, the baseline allows 2/);
      writeFileSync(join(sandbox, 'apps/web/src/a.ts'), two);
      writeFileSync(join(sandbox, 'apps/web/src/b.ts'), "if (kind === 'gate') x();\n");
      expect(() => run(lint)).toThrow(/b\.ts: 1 found, the baseline allows 0/);
      // --shrink-baseline does not absorb growth.
      expect(() => run(lint, ['--shrink-baseline'])).toThrow();
      expect(read()).toEqual({ 'domain-vocabulary': { 'apps/web/src/a.ts': 2 } });
      rmSync(join(sandbox, 'apps/web/src/b.ts'));
      // One fixed: the stale baseline fails until shrunk; shrinking lowers, then drops the entry.
      writeFileSync(join(sandbox, 'apps/web/src/a.ts'), "submit({ action: 'task.pause' });\n");
      expect(() => run(lint)).toThrow(/shrink it/);
      expect(run(lint, ['--shrink-baseline'])).toContain('boundary-lint OK');
      expect(read()).toEqual({ 'domain-vocabulary': { 'apps/web/src/a.ts': 1 } });
      writeFileSync(join(sandbox, 'apps/web/src/a.ts'), '');
      run(lint, ['--shrink-baseline']);
      expect(read()).toEqual({ 'domain-vocabulary': {} });
    });
  });
});
