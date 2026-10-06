/**
 * Upstream selection for the composition root. The upstream is one of two
 * built-ins: `fake` (the simulator, default) or `direct` (the client of the
 * contract's direct wire, for any backend that speaks it). Nothing else is
 * loaded: configuration never names code to run with the BFF's rights. The
 * factory receives only the url it needs, never the environment.
 */
import type { UpstreamFactory, WorkspaceUpstream } from '@gunnflow/upstream-port';

/** What each built-in upstream module exports. */
interface BuiltinUpstream {
  createUpstream: UpstreamFactory;
}

export const UPSTREAM_CHOICES = ['fake', 'direct'] as const;
export type UpstreamChoice = (typeof UPSTREAM_CHOICES)[number];
/** The simulator's package, reachable only through the `fake` choice. */
export const SIMULATOR_MODULE = '@gunnflow-testing/fake-contracts';
/** The built-in direct-wire client, reachable only through the `direct` choice. */
export const DIRECT_MODULE = './direct-upstream.js';

export const isUpstreamChoice = (v: string): v is UpstreamChoice => (UPSTREAM_CHOICES as readonly string[]).includes(v);

/** Test controls the simulator's upstream exposes (fixture switching, bursts, declared loss). */
export interface SimulatorControls {
  loadFixture(name: string): void;
  burstExecution(taskId: string, count: number): void;
  burstPty(sessionId: string, count: number): void;
  gapStream(sessionId: string, count: number): void;
}

export interface LoadedUpstream {
  upstream: WorkspaceUpstream;
  /** Simulator controls, present only in fake mode. */
  fake: SimulatorControls | null;
  label: string;
}

export interface LoadDeps {
  importModule(name: string): Promise<unknown>;
}

const defaultDeps: LoadDeps = {
  importModule: (name) => import(name),
};

function simulatorControls(u: unknown): SimulatorControls | null {
  const c = u as Partial<SimulatorControls>;
  return typeof c.loadFixture === 'function' &&
    typeof c.burstExecution === 'function' &&
    typeof c.burstPty === 'function' &&
    typeof c.gapStream === 'function'
    ? (c as SimulatorControls)
    : null;
}

export async function loadUpstream(
  env: Readonly<Record<string, string | undefined>>,
  deps: LoadDeps = defaultDeps,
): Promise<LoadedUpstream> {
  const choice = env.GUNNFLOW_UPSTREAM ?? 'fake';
  if (!isUpstreamChoice(choice)) {
    throw new Error(`GUNNFLOW_UPSTREAM must be ${UPSTREAM_CHOICES.map((c) => `'${c}'`).join(' or ')}; refusing '${choice}'`);
  }
  const moduleName = choice === 'fake' ? SIMULATOR_MODULE : DIRECT_MODULE;
  const mod = (await deps.importModule(moduleName)) as Partial<BuiltinUpstream>;
  if (typeof mod.createUpstream !== 'function') {
    throw new Error(`upstream module '${moduleName}' does not export createUpstream`);
  }
  if (choice === 'fake') {
    const upstream = await mod.createUpstream({});
    const controls = simulatorControls(upstream);
    if (!controls) throw new Error(`simulator module '${moduleName}' exposes no test controls`);
    return { upstream, fake: controls, label: 'fake' };
  }
  const url = env.GUNNFLOW_UPSTREAM_URL;
  const upstream = await mod.createUpstream(url ? { url } : {});
  return { upstream, fake: null, label: url ? `direct → ${url}` : 'direct' };
}
