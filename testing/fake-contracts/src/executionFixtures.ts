/** TEST-ONLY execution fixtures (Execution Surface brief §32, §34). */
import type {
  FakeExecutionEvent,
  FakeExecutionProjection,
  FakeSessionProjection,
} from './execution.js';

const NOW = 1_757_400_000_000;

function evt(
  seq: number,
  minsAgo: number,
  sessionId: string,
  partial: Omit<FakeExecutionEvent, 'seq' | 'at' | 'sessionId'>,
): FakeExecutionEvent {
  return { seq, at: NOW - minsAgo * 60_000, sessionId, ...partial };
}

/** t-build: running session with tool failure, egress pending, plus a paused sibling. */
export function buildExecutionFixture(): FakeExecutionProjection {
  const s184: FakeSessionProjection = {
    id: 's-184',
    taskId: 't-build',
    label: 'Session 184',
    agentLabel: 'Builder Agent',
    model: 'fake-model-large',
    state: 'running',
    startedAt: NOW - 18 * 60_000,
    policy: {
      ceiling: 'Org ceiling: no external egress without approval',
      missionNarrowing: 'Mission: writes limited to /workspace/app',
      sessionNarrowing: 'Session: shell allowed, network read-only',
      activePolicies: ['egress-approval-required', 'workspace-write-scope'],
      decisions: [
        { at: NOW - 16 * 60_000, label: 'read_file package.json', outcome: 'allow' },
        { at: NOW - 9 * 60_000, label: 'fetch external analytics API', outcome: 'deny' },
        { at: NOW - 3 * 60_000, label: 'publish landing page', outcome: 'pending' },
      ],
      remainingBudget: '$4.20 of $10.00',
    },
    runtime: {
      cwd: '/workspace/app',
      currentCommand: 'pnpm test',
      maskedEnv: { API_KEY: '••••••', NODE_ENV: 'test' },
    },
    capabilities: { stdin: 'enabled', pause: 'enabled', resume: 'enabled', fork: 'enabled', kill: 'enabled', restart: 'disabled' },
  };
  const s185: FakeSessionProjection = {
    id: 's-185',
    taskId: 't-build',
    label: 'Session 185',
    agentLabel: 'Test Agent',
    state: 'paused',
    startedAt: NOW - 40 * 60_000,
    capabilities: { stdin: 'disabled', pause: 'enabled', resume: 'enabled', fork: 'hidden', kill: 'enabled' },
  };
  const events: FakeExecutionEvent[] = [
    evt(1, 18, 's-184', { kind: 'session', label: 'session started', status: 'ok' }),
    evt(2, 17, 's-184', { kind: 'tool.call', label: 'read_file package.json', status: 'ok', durationMs: 42, tool: { name: 'read_file', args: '{"path":"package.json"}', result: '68 lines', durationMs: 42 } }),
    evt(3, 16, 's-184', { kind: 'tool.call', label: 'read_file src/App.tsx', status: 'ok', durationMs: 51, tool: { name: 'read_file', args: '{"path":"src/App.tsx"}', result: '214 lines', durationMs: 51 } }),
    evt(4, 15, 's-184', { kind: 'tool.call', label: 'web_search agent runtime', status: 'ok', durationMs: 814, tool: { name: 'web_search', args: '{"q":"agent runtime"}', result: '10 results', durationMs: 814, costLabel: '$0.002' } }),
    evt(5, 14, 's-184', { kind: 'file.change', label: 'create src/components/Hero.tsx', status: 'ok', file: { path: 'src/components/Hero.tsx', change: 'create', diff: '+export function Hero() {\n+  return <section>…</section>;\n+}' } }),
    evt(6, 12, 's-184', { kind: 'file.change', label: 'edit src/App.tsx', status: 'ok', file: { path: 'src/App.tsx', change: 'modify', diff: '-  <main />\n+  <Hero />\n+  <main />' } }),
    evt(7, 11, 's-184', { kind: 'file.change', label: 'delete src/old.ts', status: 'ok', file: { path: 'src/old.ts', change: 'delete' } }),
    evt(8, 10, 's-184', { kind: 'message', label: 'agent: starting test run', message: { role: 'agent', content: 'Hero section added. Running the test suite before wiring auth.' } }),
    evt(9, 9, 's-184', { kind: 'policy.decision', label: 'fetch external analytics API', status: 'denied', egress: { destination: 'analytics.example', outcome: 'deny' } }),
    evt(10, 8, 's-184', { kind: 'shell', label: 'pnpm test', status: 'ok', tool: { name: 'shell.exec', args: 'pnpm test', durationMs: 2100 } }),
    evt(11, 7, 's-184', { kind: 'shell', label: '12 passed, 1 failed', status: 'failed', tool: { name: 'shell.result', args: 'pnpm test', result: '12 passed, 1 failed — auth.spec.ts' } }),
    evt(12, 6, 's-184', { kind: 'message', label: 'agent: continuing to fix failing test', message: { role: 'agent', content: 'auth.spec.ts fails on token refresh; patching the mock clock.' } }),
    evt(13, 5, 's-184', { kind: 'message', label: 'human: instruction', message: { role: 'human', content: 'Prefer fixing the implementation over the test.' } }),
    evt(14, 3, 's-184', { kind: 'egress', label: 'publish landing page', status: 'pending', egress: { destination: 'myblog.example', outcome: 'pending', gateId: 'g-publish' } }),
    evt(15, 3, 's-184', { kind: 'policy.decision', label: 'human approval required', status: 'pending', egress: { destination: 'myblog.example', outcome: 'pending', gateId: 'g-publish' } }),
    evt(16, 1, 's-184', { kind: 'tool.call', label: 'read_file src/auth.ts', status: 'ok', durationMs: 39, tool: { name: 'read_file', args: '{"path":"src/auth.ts"}', result: '120 lines', durationMs: 39 } }),
  ];
  return { taskId: 't-build', sessions: [s184, s185], events };
}

/** t-draft: fork lineage (parent + child fork, both listed). */
export function draftExecutionFixture(): FakeExecutionProjection {
  const s201: FakeSessionProjection = {
    id: 's-201',
    taskId: 't-draft',
    label: 'Session 201',
    agentLabel: 'Copy Agent',
    state: 'running',
    startedAt: NOW - 20 * 60_000,
    capabilities: { stdin: 'enabled', pause: 'enabled', resume: 'enabled', fork: 'enabled', kill: 'enabled' },
  };
  const s201a: FakeSessionProjection = {
    id: 's-201a',
    taskId: 't-draft',
    label: 'Session 201 fork',
    agentLabel: 'Copy Agent',
    state: 'running',
    startedAt: NOW - 8 * 60_000,
    parentSessionId: 's-201',
    capabilities: { pause: 'enabled', resume: 'enabled', fork: 'hidden', kill: 'enabled' },
  };
  return {
    taskId: 't-draft',
    sessions: [s201, s201a],
    events: [
      evt(1, 20, 's-201', { kind: 'session', label: 'session started', status: 'ok' }),
      evt(2, 15, 's-201', { kind: 'file.change', label: 'edit copy/landing.md', status: 'ok', file: { path: 'copy/landing.md', change: 'modify', diff: '-Old headline\n+Ship faster with agents' } }),
      evt(3, 8, 's-201', { kind: 'human', label: 'Forked to s-201a by fake-actor:test-user', status: 'ok' }),
      evt(4, 7, 's-201a', { kind: 'session', label: 'session started (fork of s-201)', status: 'ok' }),
      evt(5, 2, 's-201a', { kind: 'message', label: 'agent: drafting alt headline', message: { role: 'agent', content: 'Trying a variant focused on technical users.' } }),
    ],
  };
}

/** Performance fixture (§34): thousands of events, hundreds of tools/files. */
export function largeExecutionFixture(taskId: string, eventCount = 5000): FakeExecutionProjection {
  const sessionId = `sL-${taskId}`;
  const session: FakeSessionProjection = {
    id: sessionId,
    taskId,
    label: `Session L/${taskId}`,
    agentLabel: 'Bulk Agent',
    state: 'running',
    startedAt: NOW - 60 * 60_000,
    capabilities: { stdin: 'enabled', pause: 'enabled', resume: 'enabled', fork: 'enabled', kill: 'enabled' },
  };
  const events: FakeExecutionEvent[] = [];
  for (let i = 1; i <= eventCount; i++) {
    const mod = i % 10;
    events.push(
      evt(i, 60 - (i * 60) / eventCount, sessionId, mod === 3
        ? { kind: 'tool.call', label: `read_file file-${i}.ts`, status: 'ok', durationMs: 40, tool: { name: 'read_file', args: `{"path":"file-${i}.ts"}`, result: 'ok', durationMs: 40 } }
        : mod === 5
          ? { kind: 'file.change', label: `edit file-${i}.ts`, status: 'ok', file: { path: `file-${i}.ts`, change: 'modify', diff: `-a\n+b${i}` } }
          : mod === 7
            ? { kind: 'shell', label: `step ${i} failed`, status: 'failed', tool: { name: 'shell.exec', args: `step-${i}` } }
            : { kind: 'message', label: `agent: step ${i}`, message: { role: 'agent', content: `step ${i}` } }),
    );
  }
  return { taskId, sessions: [session], events };
}

export const FAKE_EXECUTIONS: Record<string, () => FakeExecutionProjection> = {
  't-build': buildExecutionFixture,
  't-draft': draftExecutionFixture,
};

export function emptyExecutionFixture(taskId: string): FakeExecutionProjection {
  return { taskId, sessions: [], events: [] };
}
