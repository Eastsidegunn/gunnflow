// scripts/data-scan.mjs: personal data and environment details stay out of the tracked tree.
// Every run gets a temp GUNNFLOW_HOME, so no test reads a developer's real ~/.gunnflow.
// Leak strings are assembled at runtime so this file itself scans clean.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SCAN = join(REPO_ROOT, 'scripts', 'data-scan.mjs');

type Run = { code: number; out: string };
function run(script: string, home: string): Run {
  try {
    const out = execFileSync('node', [script], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GUNNFLOW_HOME: home } });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: e.stdout + e.stderr };
  }
}

describe('data scan', () => {
  let sandbox: string;
  let home: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-data-scan-'));
    home = join(sandbox, 'home');
    mkdirSync(home);
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('passes on the real repo with the generic rules', () => {
    const r = run(SCAN, home);
    expect(r.out).toContain('data-scan OK');
    expect(r.code).toBe(0);
  });

  describe('in a fixture repository', () => {
    let repo: string;
    let script: string;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    const track = (path: string, content: string) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
      git('add', '-f', path);
    };
    beforeEach(() => {
      repo = join(sandbox, 'repo');
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      script = join(repo, 'scripts', 'data-scan.mjs');
      cpSync(SCAN, script);
      git('init', '-q');
      git('add', 'scripts/data-scan.mjs');
    });

    it('is clean with placeholders, shared or URL paths and public addresses', () => {
      track(
        'docs/a.md',
        'see /Users/<name>/ or $HOME/.gunnflow or /home/$USER; /Users/Shared/x and /Users/Shared; ' +
          'https://example.com/home/index; C:\\Users\\<name>; listen on 127.0.0.1, 8.8.8.8, version 10.34.5\n',
      );
      const r = run(script, home);
      expect(r.out).toContain('data-scan OK');
      expect(r.code).toBe(0);
    });

    // Each form alone on its own line: with and without a trailing separator, quoted, mid-line, end of line.
    const u = 'alice';
    const mac = `/Us${''}ers/${u}`;
    const lin = `/ho${''}me/${u}`;
    const win = `C:\\Us${''}ers\\${u}`;
    const winFwd = `C:/Us${''}ers/${u}`;
    const forms = (p: string) => [p, `${p}/x`, `'${p}'`, `"${p}" and more`, `path=${p} next`, `cd ${p}`, `(${p})`];
    for (const [rule, base] of [
      ['macOS home path', mac],
      ['Linux home path', lin],
      ['Windows home path', win],
      ['Windows home path', winFwd],
    ] as const) {
      it(`catches every ${rule} form of ${base.slice(0, 3)}…`, () => {
        const lines = forms(base);
        track('src/forms.txt', lines.join('\n') + '\n');
        const r = run(script, home);
        expect(r.code).toBe(1);
        lines.forEach((_, i) => expect(r.out, lines[i]).toMatch(new RegExp(`src/forms\\.txt:${i + 1}  \\[${rule}\\]`)));
      });
    }

    it('catches home paths, private and CGNAT addresses, tailnet hosts and tracked data files', () => {
      const user = 'alice';
      track('src/paths.ts', `const a = '/Us${''}ers/${user}/code';\nconst b = '/ho${''}me/${user}/x';\nconst c = 'C:\\\\Us${''}ers\\\\${user}\\\\x';\n`);
      track('src/net.ts', ['10', '1.2.3'].join('.') + '\n' + ['192', '168', '0', '7'].join('.') + '\n' + ['172', '20', '0', '1'].join('.') + '\n' + ['100', '100', '1', '2'].join('.') + '\n' + `box.tail${''}0.ts${''}.net\n`);
      track('data/events.ndjson', '{}\n');
      track('state.sqlite', 'x');
      track('.env.local', 'X=1\n');
      track('.env.example', 'X=\n');
      const r = run(script, home);
      expect(r.code).toBe(1);
      for (const rule of ['macOS home path', 'Linux home path', 'Windows home path', '10/8', '192.168/16', '172.16/12', '100.64/10', '.ts.net', '*.ndjson', '*.sqlite', '.env*']) {
        expect(r.out, rule).toContain(rule);
      }
      expect(r.out).toContain('src/paths.ts:1');
      expect(r.out).not.toContain('.env.example');
      // Findings never echo the matched text.
      expect(r.out).not.toContain(user);
    });

    it('lets a marked fixture line and an allowlisted file through', () => {
      track('test/fixture.ts', `const p = '/Us${''}ers/alice/x'; // data-scan${''}:allow\n`);
      track('fixtures/sample.ndjson', '{}\n');
      expect(run(script, home).code).toBe(1);
      track('scripts/data-scan.allow.json', JSON.stringify({ paths: ['fixtures/sample.ndjson'] }));
      const r = run(script, home);
      expect(r.out).toContain('data-scan OK');
      expect(r.code).toBe(0);
    });

    it('merges local patterns from $GUNNFLOW_HOME/data-scan.local.json', () => {
      track('notes.md', 'deployed by Codename Zebra\n');
      expect(run(script, home).code).toBe(0);
      writeFileSync(join(home, 'data-scan.local.json'), JSON.stringify([{ name: 'project codename', pattern: 'codename\\s+zebra', flags: 'i' }]));
      const r = run(script, home);
      expect(r.code).toBe(1);
      expect(r.out).toContain('notes.md:1  [local: project codename]');
      // A global/sticky flag must not make the reused RegExp skip later lines.
      track('more.md', 'codename zebra\ncodename zebra\ncodename zebra\n');
      for (const flags of ['gi', 'yi', 'giy']) {
        writeFileSync(join(home, 'data-scan.local.json'), JSON.stringify([{ name: 'codename', pattern: 'codename\\s+zebra', flags }]));
        const out = run(script, home).out;
        for (const line of ['notes.md:1', 'more.md:1', 'more.md:2', 'more.md:3']) expect(out, `${flags} ${line}`).toContain(`${line}  [local: codename]`);
      }
      writeFileSync(join(home, 'data-scan.local.json'), '{"not":"an array"}');
      expect(run(script, home).code).toBe(2);
    });
  });
});
