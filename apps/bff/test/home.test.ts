// The per-user Gunnflow home and the config file: one source
// (scripts/gunnflow-settings.mjs) read by the BFF, the web build and the
// scripts. The cases run through both entry points — the BFF's re-exports and
// the plain-JS module the scripts import — and through render-sweep itself.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as bffConfig from '../src/config.js';
import { REPO_ROOT, wiringDirOf } from '../src/config.js';
import * as bffHome from '../src/home.js';
import { defaultPersonalDir } from '../src/personalStore.js';
import { defaultPrefsFile } from '../src/prefsStore.js';

type Impl = Pick<typeof bffHome, 'gunnflowHome' | 'resolveConfigFile' | 'resolveWiringDir' | 'displayPath' | 'loadUserConfig'> &
  Pick<typeof bffConfig, 'parseConfig' | 'loadConfigFile'>;
const SETTINGS = join(REPO_ROOT, 'scripts', 'gunnflow-settings.mjs');
const scriptImpl = (await import(pathToFileURL(SETTINGS).href)) as Impl;
const bffImpl: Impl = { ...bffHome, parseConfig: bffConfig.parseConfig, loadConfigFile: bffConfig.loadConfigFile };

describe('the test suite is isolated from the real Gunnflow home', () => {
  it('GUNNFLOW_HOME points into a temp dir for every test file', () => {
    expect(process.env.GUNNFLOW_HOME?.startsWith(resolve(tmpdir()))).toBe(true);
    expect(bffHome.gunnflowHome()).toBe(process.env.GUNNFLOW_HOME);
  });
});

for (const [name, impl] of [
  ['bff (src/home.ts, src/config.ts)', bffImpl],
  ['scripts (scripts/gunnflow-settings.mjs)', scriptImpl],
] as Array<[string, Impl]>) {
  describe(`Gunnflow settings — ${name}`, () => {
    let sandbox: string;
    let repo: string;
    let userHome: string;
    let home: string;
    beforeEach(() => {
      sandbox = mkdtempSync(join(tmpdir(), 'gunnflow-home-'));
      repo = join(sandbox, 'repo');
      userHome = join(sandbox, 'user');
      home = join(userHome, '.gunnflow');
      mkdirSync(repo, { recursive: true });
      mkdirSync(home, { recursive: true });
    });
    afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

    it('GUNNFLOW_HOME, with ~ expanded against the injected user home; default ~/.gunnflow', () => {
      expect(impl.gunnflowHome({}, userHome)).toBe(join(userHome, '.gunnflow'));
      expect(impl.gunnflowHome({ GUNNFLOW_HOME: '' }, userHome)).toBe(join(userHome, '.gunnflow'));
      expect(impl.gunnflowHome({ GUNNFLOW_HOME: '/srv/gf' }, userHome)).toBe('/srv/gf');
      expect(impl.gunnflowHome({ GUNNFLOW_HOME: '~/gf' }, userHome)).toBe(join(userHome, 'gf'));
      expect(impl.gunnflowHome({ GUNNFLOW_HOME: '~' }, userHome)).toBe(userHome);
      expect(impl.gunnflowHome({ GUNNFLOW_HOME: 'rel/gf' }, userHome)).toBe(resolve('rel/gf'));
    });

    it('config file: GUNNFLOW_CONFIG > repo gunnflow.config.json > home config.json > none', () => {
      const r = (env: Record<string, string>) => impl.resolveConfigFile({ env, repoRoot: repo, home });
      expect(r({})).toBeUndefined();
      writeFileSync(join(home, 'config.json'), '{}');
      expect(r({})).toEqual({ path: join(home, 'config.json'), source: 'home' });
      writeFileSync(join(repo, 'gunnflow.config.json'), '{}');
      expect(r({})).toEqual({ path: join(repo, 'gunnflow.config.json'), source: 'repo' });
      const explicit = join(sandbox, 'elsewhere.json');
      // Explicit wins even when the file does not exist: loading refuses it then.
      expect(r({ GUNNFLOW_CONFIG: explicit })).toEqual({ path: explicit, source: 'env' });
    });

    it('wiring dir: explicit (relative to the repo root) > home wiring/ when it exists > repo wiring/', () => {
      const r = (explicit?: string) => impl.resolveWiringDir({ explicit, repoRoot: repo, home });
      expect(r()).toBe(join(repo, 'wiring'));
      writeFileSync(join(home, 'wiring'), 'a file, not a directory');
      expect(r()).toBe(join(repo, 'wiring'));
      rmSync(join(home, 'wiring'));
      mkdirSync(join(home, 'wiring'));
      expect(r()).toBe(join(home, 'wiring'));
      expect(r('custom/wiring')).toBe(join(repo, 'custom/wiring'));
      expect(r('/abs/wiring')).toBe('/abs/wiring');
    });

    it('validation: the schema is accepted; unknown keys, empty or non-string values, bad upstream and bad urls are refused', () => {
      const ok = { upstream: 'direct', url: 'http://127.0.0.1:9000/gf', webOrigin: 'http://127.0.0.1:5173', wiringDir: 'w', personalDir: 'p' };
      expect(impl.parseConfig(ok)).toEqual(ok);
      expect(() => impl.parseConfig({ token: 'x' })).toThrow(/unknown key 'token'/);
      expect(() => impl.parseConfig({ wiringDir: '' })).toThrow(/'wiringDir' must be a non-empty string/);
      expect(() => impl.parseConfig({ wiringDir: 3 })).toThrow(/'wiringDir' must be a non-empty string/);
      expect(() => impl.parseConfig({ upstream: 'other' })).toThrow(/'upstream' must be 'fake' or 'direct'/);
      expect(() => impl.parseConfig({ url: 'not a url' })).toThrow(/'url' is not a URL/);
      expect(() => impl.parseConfig({ url: 'file:///etc/passwd' })).toThrow(/http/);
      expect(() => impl.parseConfig({ url: 'http://u:p@host' })).toThrow(/credentials/);
      expect(() => impl.parseConfig({ previewOrigin: 'http://h:1/path' })).toThrow(/origin/);
      expect(() => impl.parseConfig([])).toThrow(/object/);
    });

    it('loading fails loudly on an invalid file and on a missing explicit one, naming the file as shown', () => {
      const file = join(home, 'config.json');
      expect(impl.loadUserConfig({ env: { GUNNFLOW_HOME: home }, repoRoot: repo, userHome })).toMatchObject({ location: undefined, config: {} });
      writeFileSync(file, JSON.stringify({ upstream: 'fake' }));
      expect(impl.loadUserConfig({ env: {}, repoRoot: repo, userHome })).toMatchObject({
        location: { path: file, source: 'home', shown: join('~', '.gunnflow', 'config.json') },
        config: { upstream: 'fake' },
      });
      writeFileSync(file, '{"upstream":');
      expect(() => impl.loadUserConfig({ env: {}, repoRoot: repo, userHome })).toThrow(/~\/\.gunnflow\/config\.json is not valid JSON/);
      writeFileSync(file, JSON.stringify({ token: 'x' }));
      expect(() => impl.loadUserConfig({ env: {}, repoRoot: repo, userHome })).toThrow(/unknown key 'token' \(in ~\/\.gunnflow\/config\.json\)/);
      expect(() => impl.loadUserConfig({ env: { GUNNFLOW_CONFIG: join(home, 'missing.json') }, repoRoot: repo, userHome })).toThrow(
        /~\/\.gunnflow\/missing\.json \(named by GUNNFLOW_CONFIG\) does not exist/,
      );
      expect(impl.loadConfigFile(join(home, 'missing.json'))).toEqual({});
    });

    it('display paths: $GUNNFLOW_HOME/… for a custom home, ./… in the repo, ~/… in the OS home, most specific first', () => {
      const custom = join(sandbox, 'custom-home');
      const shown = (p: string, env: Record<string, string> = {}) => impl.displayPath(p, { repoRoot: repo, env, userHome });
      expect(shown(join(custom, 'config.json'), { GUNNFLOW_HOME: custom })).toBe(`$GUNNFLOW_HOME${sep}config.json`);
      expect(shown(custom, { GUNNFLOW_HOME: custom })).toBe('$GUNNFLOW_HOME');
      expect(shown(join(userHome, 'gf', 'wiring'), { GUNNFLOW_HOME: '~/gf' })).toBe(`$GUNNFLOW_HOME${sep}wiring`);
      expect(shown(join(home, 'config.json'))).toBe(join('~', '.gunnflow', 'config.json'));
      expect(shown(join(repo, 'gunnflow.config.json'))).toBe(`.${sep}gunnflow.config.json`);
      expect(shown('/srv/gf/config.json')).toBe('/srv/gf/config.json');
    });
  });
}

describe('the BFF derives its local files from the Gunnflow home', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gunnflow-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('personal/, prefs.json and wiring/ sit under the home', () => {
    expect(defaultPersonalDir(home)).toBe(join(home, 'personal'));
    expect(defaultPrefsFile(home)).toBe(join(home, 'prefs.json'));
    expect(wiringDirOf({}, home)).toBe(join(REPO_ROOT, 'wiring'));
    mkdirSync(join(home, 'wiring'));
    expect(wiringDirOf({}, home)).toBe(join(home, 'wiring'));
    expect(wiringDirOf({ GUNNFLOW_WIRING_DIR: 'wiring' }, home)).toBe(join(REPO_ROOT, 'wiring'));
  });
});

describe('render-sweep validates the config exactly like the BFF', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gunnflow-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const sweep = (config: unknown): { code: number; out: string } => {
    const file = join(home, 'config.json');
    writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
    try {
      const out = execFileSync('node', [join(REPO_ROOT, 'scripts', 'render-sweep.mjs')], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, GUNNFLOW_HOME: home, GUNNFLOW_CONFIG: file, GUNNFLOW_SWEEP_URL: '' },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: e.stdout + e.stderr };
    }
  };

  it('refuses unknown keys, a bad wiringDir, a bad url and invalid JSON with exit 3', () => {
    for (const [config, why] of [
      [{ token: 'x' }, /unknown key 'token' \(in \$GUNNFLOW_HOME\/config\.json\)/],
      [{ wiringDir: '' }, /'wiringDir' must be a non-empty string/],
      [{ upstream: 'direct', url: 'ftp://x' }, /'url' must be http\(s\)/],
      ['{"upstream":', /not valid JSON/],
    ] as Array<[unknown, RegExp]>) {
      const r = sweep(config);
      expect(r.code, String(why)).toBe(3);
      expect(r.out).toMatch(why);
    }
    // A valid config without a wire URL still gets past validation to the URL check.
    expect(sweep({ upstream: 'fake' }).out).toMatch(/no wire URL/);
  });
});
