/**
 * TEST-ONLY fixtures for the required screen states (charter §19) and the
 * large-topology performance fixture (acceptance H).
 */
import type {
  FakeWorkspaceProjection,
  FakeTaskProjection,
  FakeEdgeProjection,
  FakeDeliverableProjection,
} from './projection.js';
import { fakeTextSnapshot } from './artifacts.js';

const NOW = 1_757_400_000_000; // fixed clock for deterministic tests

const RESEARCH_REPORT = fakeTextSnapshot(
  'art-research-report',
  'text/markdown',
  '# Research Report\n\nThree competitor sites reviewed; findings summarized below.\n',
);

const BUILD_REPORT = fakeTextSnapshot(
  'art-build-report',
  'text/html',
  '<!doctype html><html><body><h1>Build report</h1><p>41 of 42 tests passed.</p></body></html>',
);

/** Diagram samples: a mermaid flowchart, a mermaid ERD and an Excalidraw scene. */
const PIPELINE_FLOW = fakeTextSnapshot(
  'art-pipeline-flow',
  'text/vnd.mermaid',
  [
    'flowchart LR',
    '  research[Research] --> draft[Draft]',
    '  draft --> build[Web Build]',
    '  build --> test{Tests pass?}',
    '  test -->|yes| publish([Publish])',
    '  test -->|no| build',
    '',
  ].join('\n'),
);

const DATA_MODEL_ERD = fakeTextSnapshot(
  'art-data-model',
  'text/vnd.mermaid',
  [
    'erDiagram',
    '  MISSION ||--o{ TASK : contains',
    '  TASK ||--o{ ARTIFACT : produces',
    '  TASK }o--o{ GATE : "waits on"',
    '  MISSION {',
    '    string id PK',
    '    string name',
    '  }',
    '  TASK {',
    '    string id PK',
    '    string mission_id FK',
    '    string state',
    '  }',
    '  ARTIFACT {',
    '    string id PK',
    '    string media_type',
    '    string digest',
    '  }',
    '  GATE {',
    '    string id PK',
    '    string state',
    '  }',
    '',
  ].join('\n'),
);

const el = (id: string, type: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, type, x, y, width: 160, height: 70, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, seed: id.length * 7919,
  version: 1, versionNonce: 1, isDeleted: false, groupIds: [], boundElements: null, updated: 1, link: null, locked: false,
  ...extra,
});
const RELEASE_SKETCH = fakeTextSnapshot(
  'art-release-sketch',
  'application/vnd.excalidraw+json',
  JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'gunnflow-simulator',
    elements: [
      el('box-build', 'rectangle', 0, 0, { backgroundColor: '#a5d8ff' }),
      el('box-review', 'diamond', 260, -10, { width: 150, height: 90, backgroundColor: '#ffec99' }),
      el('box-ship', 'ellipse', 500, 0, { backgroundColor: '#b2f2bb' }),
      el('arrow-1', 'arrow', 165, 35, { width: 90, height: 0, points: [[0, 0], [90, 0]] }),
      el('arrow-2', 'arrow', 415, 35, { width: 80, height: 0, points: [[0, 0], [80, 0]] }),
      el('label-build', 'text', 45, 22, { width: 70, height: 25, text: 'Build', originalText: 'Build', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top' }),
      el('label-review', 'text', 300, 22, { width: 70, height: 25, text: 'Review', originalText: 'Review', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top' }),
      el('label-ship', 'text', 555, 22, { width: 50, height: 25, text: 'Ship', originalText: 'Ship', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top' }),
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }),
);

/** Workspace-level capabilities: creating a mission is the root node's action. */
const WORKSPACE_CAPABILITIES = [
  { action: 'mission.create', level: 'enabled' as const, decision: { input: { required: true } } },
];

const LANDING_COPY = fakeTextSnapshot(
  'art-landing-copy',
  'text/markdown',
  '# Ship faster\n\nGunnflow keeps a human in the loop.\n\n- Live canvas\n- Relayed intents\n',
);

export function emptyFixture(): FakeWorkspaceProjection {
  return {
    revision: 1,
    missions: [],
    tasks: [],
    gates: [],
    deliverables: [],
    edges: [],
    counts: { running: 0, needsYou: 0, blocked: 0 },
    activities: [],
    sessions: [],
    capabilities: {},
    gateCapabilities: {},
    effects: [],
    workspaceCapabilities: WORKSPACE_CAPABILITIES,
  };
}

/** §19.1 Normal — active + completed + deliverable + at least one branch. */
export function normalFixture(): FakeWorkspaceProjection {
  return {
    revision: 10,
    missions: [
      { kind: 'mission', id: 'm1', name: 'Ship Website', attention: false },
    ],
    tasks: [
      { kind: 'task', id: 't-research', missionId: 'm1', name: 'Research', state: 'completed', attention: false, startedAt: NOW - 3_600_000, updatedAt: NOW - 2_400_000, artifacts: [DATA_MODEL_ERD.ref] },
      { kind: 'task', id: 't-draft', missionId: 'm1', name: 'Draft', state: 'running', currentAction: 'Writing landing page copy', attention: false, startedAt: NOW - 1_200_000, updatedAt: NOW - 30_000, artifacts: [LANDING_COPY.ref] },
      { kind: 'task', id: 't-build', missionId: 'm1', name: 'Web Build', state: 'running', currentAction: 'Testing authentication', attention: false, startedAt: NOW - 1_080_000, updatedAt: NOW - 5_000, artifacts: [BUILD_REPORT.ref, RELEASE_SKETCH.ref] },
      { kind: 'task', id: 't-test', missionId: 'm1', name: 'Test', state: 'queued', attention: false, artifacts: [PIPELINE_FLOW.ref] },
    ],
    gates: [],
    deliverables: [
      { kind: 'deliverable', id: 'd-report', missionId: 'm1', title: 'Research Report', deliverableType: 'document', state: 'completed', previewHint: '▤', artifacts: [RESEARCH_REPORT.ref] },
    ],
    edges: [
      { id: 'e1', from: 't-research', to: 't-draft', edgeKind: 'dependency' },
      { id: 'e2', from: 't-research', to: 't-build', edgeKind: 'dependency' },
      { id: 'e3', from: 't-build', to: 't-test', edgeKind: 'dependency' },
      { id: 'e4', from: 't-research', to: 'd-report', edgeKind: 'produces' },
    ],
    counts: { running: 2, needsYou: 0, blocked: 0 },
    activities: [
      { id: 'a1', taskId: 't-research', at: NOW - 2_460_000, label: 'Collected 14 competitor pages', eventType: 'task.step', actor: 'agent' },
      { id: 'a2', taskId: 't-research', at: NOW - 2_400_000, label: 'Research report finalized', eventType: 'task.completed', actor: 'agent' },
      { id: 'a3', taskId: 't-draft', at: NOW - 900_000, label: 'Outlined landing page sections', eventType: 'task.step', actor: 'agent' },
      { id: 'a4', taskId: 't-draft', at: NOW - 30_000, label: 'Writing landing page copy', eventType: 'task.step', actor: 'agent' },
      { id: 'a5', taskId: 't-build', at: NOW - 700_000, label: 'Scaffolded project with Vite', eventType: 'task.step', actor: 'agent' },
      { id: 'a6', taskId: 't-build', at: NOW - 300_000, eventType: 'tool.batch', actor: 'agent' },
      { id: 'a7', taskId: 't-build', at: NOW - 5_000, label: 'Testing authentication', eventType: 'task.step', actor: 'agent' },
    ],
    sessions: [
      { taskId: 't-build', label: 'Builder Session', state: 'running', startedAt: NOW - 1_080_000 },
      { taskId: 't-draft', label: 'Copy Session', state: 'running', startedAt: NOW - 1_200_000, forkCount: 2 },
    ],
    capabilities: {
      't-research': { instruct: 'hidden', pause: 'hidden', cancel: 'hidden', delete: 'enabled' },
      't-draft': { pause: 'enabled', resume: 'enabled', instruct: 'enabled', cancel: 'enabled', forceReplan: 'enabled' },
      't-build': { pause: 'enabled', resume: 'enabled', instruct: 'enabled', cancel: 'enabled', forceReplan: 'disabled' },
      't-test': { pause: 'disabled', resume: 'enabled', instruct: 'enabled', cancel: 'enabled' },
    },
    gateCapabilities: {},
    effects: [],
    declaredCapabilities: {
      't-draft': [
        { action: 'task.pause', level: 'enabled' },
        { action: 'task.resume', level: 'enabled' },
        { action: 'task.instruct', level: 'enabled', decision: { input: { required: true } } },
        {
          action: 'artifact.edit',
          level: 'enabled',
          edit: { artifactId: LANDING_COPY.ref.id, mediaTypes: ['text/plain', 'text/markdown'], maxBytes: 2048 },
        },
      ],
    },
    artifactSnapshots: {
      ...LANDING_COPY.store,
      ...RESEARCH_REPORT.store,
      ...BUILD_REPORT.store,
      ...PIPELINE_FLOW.store,
      ...DATA_MODEL_ERD.store,
      ...RELEASE_SKETCH.store,
    },
    workspaceCapabilities: WORKSPACE_CAPABILITIES,
  };
}

/** §19.2 Attention — at least one waiting Human Gate; Needs-you lens must work. */
export function attentionFixture(): FakeWorkspaceProjection {
  const base = normalFixture();
  return {
    ...base,
    revision: 20,
    tasks: base.tasks.map((t) =>
      t.id === 't-draft' ? { ...t, state: 'completed' as const, currentAction: undefined } : t,
    ),
    gates: [
      {
        kind: 'gate',
        id: 'g-publish',
        missionId: 'm1',
        name: 'Publish?',
        gateType: 'publish approval',
        requestedAction: 'Publish the landing page externally',
        state: 'waiting',
        urgency: 'high',
        riskTier: 'logged',
        deliverableId: 'd-report',
        request: {
          target: 'Landing page copy',
          destination: 'myblog.example',
          requestedBy: 'Copy Session (agent)',
          requestedAt: NOW - 600_000,
          reason: 'Final draft is ready for release.',
          impact: 'The page becomes publicly visible.',
          externalEffect: true,
        },
        policy: {
          policyLabel: 'Egress: publishing requires operator approval',
          requiredAuthority: 'operator',
        },
      },
    ],
    edges: [
      ...base.edges,
      { id: 'e5', from: 't-draft', to: 'g-publish', edgeKind: 'gate' },
    ],
    counts: { running: 1, needsYou: 1, blocked: 0 },
    gateCapabilities: {
      'g-publish': { approve: 'enabled', reject: 'enabled', requestChanges: 'enabled' },
    },
  };
}

/** §19.3 Blocked — upstream provides the reason; the UI never invents one. */
export function blockedFixture(): FakeWorkspaceProjection {
  const base = attentionFixture();
  return {
    ...base,
    revision: 30,
    tasks: base.tasks.map((t) =>
      t.id === 't-test'
        ? { ...t, state: 'blocked' as const, blockedReason: 'Staging environment credentials expired (upstream policy hold)', attention: true }
        : t,
    ),
    counts: { running: 1, needsYou: 1, blocked: 1 },
    activities: [
      ...base.activities,
      { id: 'a8', taskId: 't-test', at: NOW - 120_000, label: 'Deploy to staging failed: credentials expired', eventType: 'task.blocked', actor: 'system' },
    ],
  };
}

/** Acceptance H — large topology for pan/zoom and update-throughput testing. */
export function largeFixture(missionCount = 12, tasksPerMission = 40): FakeWorkspaceProjection {
  const missions = [];
  const tasks: FakeTaskProjection[] = [];
  const deliverables: FakeDeliverableProjection[] = [];
  const edges: FakeEdgeProjection[] = [];
  let running = 0;
  let blocked = 0;

  for (let m = 0; m < missionCount; m++) {
    const mid = `Lm${m}`;
    missions.push({ kind: 'mission' as const, id: mid, name: `Mission ${m}`, attention: false });
    for (let t = 0; t < tasksPerMission; t++) {
      const id = `Lm${m}t${t}`;
      const state =
        t % 11 === 10 ? ('blocked' as const) : t % 3 === 0 ? ('running' as const) : t % 3 === 1 ? ('completed' as const) : ('queued' as const);
      if (state === 'running') running++;
      if (state === 'blocked') blocked++;
      tasks.push({
        kind: 'task',
        id,
        missionId: mid,
        name: `Task ${m}.${t}`,
        state,
        currentAction: state === 'running' ? 'Working' : undefined,
        blockedReason: state === 'blocked' ? 'Upstream-provided reason' : undefined,
        attention: state === 'blocked',
        startedAt: NOW - t * 60_000,
        updatedAt: NOW - t * 1_000,
      });
      if (t > 0) {
        // Fake data may declare explicit relations; production edges are upstream-only.
        edges.push({ id: `Le${m}-${t}`, from: `Lm${m}t${t - 1}`, to: id, edgeKind: 'dependency' });
      }
      if (t % 8 === 7) {
        const did = `Lm${m}d${t}`;
        deliverables.push({ kind: 'deliverable', id: did, missionId: mid, title: `Artifact ${m}.${t}`, deliverableType: 'document', state: 'completed' });
        edges.push({ id: `Lep${m}-${t}`, from: id, to: did, edgeKind: 'produces' });
      }
    }
  }
  return {
    revision: 100,
    missions,
    tasks,
    gates: [],
    deliverables,
    edges,
    counts: { running, needsYou: 0, blocked },
    activities: [],
    sessions: [],
    capabilities: {},
    gateCapabilities: {},
    effects: [],
    workspaceCapabilities: WORKSPACE_CAPABILITIES,
  };
}

/**
 * Human Gate brief §33 — required gate UI states in one mission:
 * A simple approval, B publish w/ evidence, C privileged deploy, E read-only
 * (upstream-disabled), G approved+effect pending, H approved+effect failed,
 * I superseded. (D/F/J are dynamic: request-changes, pending, stale.)
 */
export function gatesFixture(): FakeWorkspaceProjection {
  const base = attentionFixture();
  const gates: FakeWorkspaceProjection['gates'] = [
    ...base.gates,
    {
      kind: 'gate', id: 'g-review', missionId: 'm1', name: 'Review draft?',
      gateType: 'review', requestedAction: 'Accept the draft as ready',
      state: 'waiting', riskTier: 'logged',
      request: { requestedBy: 'Copy Session (agent)', requestedAt: NOW - 300_000, reason: 'Draft finished; internal acceptance needed before publish.' },
    },
    {
      kind: 'gate', id: 'g-deploy', missionId: 'm1', name: 'Deploy to production?',
      gateType: 'deploy approval', requestedAction: 'Deploy the web app to production',
      state: 'waiting', urgency: 'high', riskTier: 'privileged', reasonRequired: true,
      request: {
        target: 'web app build #42', destination: 'production.example.com',
        requestedBy: 'Builder Session (agent)', requestedAt: NOW - 120_000,
        reason: 'All tests green; production release requires operator approval.',
        impact: 'This action causes an external effect: the app goes live.',
        externalEffect: true,
      },
      policy: {
        policyLabel: 'Egress: production deploy is privileged',
        requiredAuthority: 'privileged operator',
        credentialLabel: 'GitHub Deploy Credential', credentialScope: 'repo:deploy', credentialExpiresIn: '18m',
      },
    },
    {
      kind: 'gate', id: 'g-scope', missionId: 'm1', name: 'Widen crawl scope?',
      gateType: 'scope expansion', requestedAction: 'Allow crawling additional domains',
      state: 'waiting', riskTier: 'privileged',
      request: { requestedBy: 'Research Session (agent)', requestedAt: NOW - 900_000, reason: 'Requested sources are outside the approved scope.', externalEffect: true },
      policy: { policyLabel: 'Scope ceiling: fixed domain list', requiredAuthority: 'privileged operator' },
    },
    {
      kind: 'gate', id: 'g-upload', missionId: 'm1', name: 'Upload assets?',
      gateType: 'upload approval', requestedAction: 'Upload image assets to CDN',
      state: 'approved', riskTier: 'logged',
      request: { destination: 'cdn.example', requestedAt: NOW - 1_500_000, externalEffect: true },
      decision: { by: 'fake-actor:test-user', at: NOW - 1_400_000, choice: 'approved' },
    },
    {
      kind: 'gate', id: 'g-migrate', missionId: 'm1', name: 'Run data migration?',
      gateType: 'action approval', requestedAction: 'Run the schema migration',
      state: 'approved', riskTier: 'privileged',
      request: { target: 'staging database', requestedAt: NOW - 2_000_000, externalEffect: true },
      decision: { by: 'fake-actor:test-user', at: NOW - 1_900_000, choice: 'approved', reason: 'Window confirmed with the team.' },
    },
    {
      kind: 'gate', id: 'g-old-publish', missionId: 'm1', name: 'Publish? (v1)',
      gateType: 'publish approval', requestedAction: 'Publish landing page v1',
      state: 'superseded', supersededBy: 'g-publish',
      request: { destination: 'myblog.example', requestedAt: NOW - 3_000_000 },
    },
  ];
  return {
    ...base,
    revision: 40,
    gates,
    edges: [
      ...base.edges,
      { id: 'ge1', from: 't-draft', to: 'g-review', edgeKind: 'gate' },
      { id: 'ge2', from: 't-build', to: 'g-deploy', edgeKind: 'gate' },
    ],
    counts: { ...base.counts, needsYou: gates.filter((g) => g.state === 'waiting').length },
    gateCapabilities: {
      ...base.gateCapabilities,
      'g-review': { approve: 'enabled', reject: 'enabled', requestChanges: 'enabled' },
      'g-deploy': { approve: 'enabled', reject: 'enabled' },
      'g-scope': { approve: 'disabled', reject: 'enabled', disabledReason: 'Requires privileged operator.' },
      'g-upload': {},
      'g-migrate': {},
      'g-old-publish': {},
    },
    effects: [
      { gateId: 'g-upload', label: 'Upload image assets to CDN', state: 'running' },
      { gateId: 'g-migrate', label: 'Run the schema migration', state: 'failed', detail: 'Migration step 3 failed: constraint violation (upstream detail)' },
    ],
  };
}

/** The exact command text of the hands-on request in the inbox fixture (two lines). */
export const FAKE_CHORE_COMMAND = 'fake-cli login\nfake-cli publish ./dist/fake-pkg.tgz --access public';

/**
 * Decision inbox v2 — the blocked state plus hands-on requests: one a person
 * can report on (done with an optional note, cannot with a required reason)
 * and one that declares no action at all.
 */
export function inboxFixture(): FakeWorkspaceProjection {
  const base = blockedFixture();
  return {
    ...base,
    revision: 35,
    chores: [
      {
        kind: 'chore',
        id: 'c-publish',
        missionId: 'm1',
        name: 'Publish the package by hand',
        state: 'waiting',
        requestedAt: NOW - 1_200_000,
        why: 'The agent cannot log in to the registry.',
        where: 'Your own terminal, in the project folder.',
        command: FAKE_CHORE_COMMAND,
        afterwards: 'Report done (a short note is optional).',
        reportable: true,
      },
      {
        kind: 'chore',
        id: 'c-silent',
        missionId: 'm1',
        name: 'Look at the shared drive',
        state: 'waiting',
        requestedAt: NOW - 3_600_000,
        why: 'Nothing to report back here yet.',
        reportable: false,
      },
    ],
  };
}

export const FIXTURES = {
  empty: emptyFixture,
  normal: normalFixture,
  attention: attentionFixture,
  blocked: blockedFixture,
  inbox: inboxFixture,
  gates: gatesFixture,
  large: () => largeFixture(),
} as const;

export type FixtureName = keyof typeof FIXTURES;
