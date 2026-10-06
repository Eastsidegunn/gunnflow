// Human Gate acceptance (B/C/E/F): projection integrity, decision affordances,
// double-submit guard, stale/inactive guards, approval ≠ effect.
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import {
  FakeWorkspaceStream,
  NullHumanDecisionRelay,
  gatesFixture,
  type FakeIntent,
} from '@gunnflow-testing/fake-contracts';
import { gateById, gateEffects, gateRelations } from '../src/model/selectors.js';
import {
  gateDecisionAffordances,
  gateSurfaceForm,
  hasPendingGateDecision,
} from '../src/state/gateLogic.js';
import { createPendingIntentState } from '../src/state/pendingIntents.js';
import { fakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { createProjectionStore } from '../src/state/projectionStore.js';
import type { Intent } from '../src/model/types.js';

const NO_PENDING: never[] = [];

describe('gate projection integrity (B)', () => {
  it('request/reason/impact/policy come from upstream fields verbatim', () => {
    const g = gateById(gatesFixture(), 'g-deploy')!;
    expect(g.request?.destination).toBe('production.example.com');
    expect(g.request?.reason).toContain('operator approval');
    expect(g.riskTier).toBe('privileged'); // upstream-declared, never computed
    expect(g.policy?.credentialLabel).toBe('GitHub Deploy Credential');
  });

  it('no risk tier provided → none shown/assumed (g-review has logged tier, g-old none matters)', () => {
    const p = gatesFixture();
    const old = gateById(p, 'g-old-publish')!;
    expect(old.riskTier).toBeUndefined();
    expect(old.request?.expiresAt).toBeUndefined(); // no expiration inference possible
  });

  it('gate relations come from declared edges + declared deliverable only', () => {
    const p = gatesFixture();
    const rel = gateRelations(p, 'g-publish');
    expect(rel.tasks.map((t) => t.id)).toEqual(['t-draft']);
    expect(rel.deliverable?.id).toBe('d-report');
    expect(gateRelations(p, 'g-old-publish').tasks).toEqual([]);
  });

  it('surface form (S-03): only external-effect gates take the overlay; evidence gates stay panels', () => {
    const p = gatesFixture();
    expect(gateSurfaceForm(gateById(p, 'g-publish')!)).toBe('overlay'); // external effect → privileged confirmation
    expect(gateSurfaceForm(gateById(p, 'g-deploy')!)).toBe('overlay');
    expect(gateSurfaceForm(gateById(p, 'g-review')!)).toBe('panel');
  });
});

describe('decision affordances (E)', () => {
  const p = gatesFixture();

  it('upstream capability decides, with upstream-provided disabled reason', () => {
    const scope = gateDecisionAffordances(p, gateById(p, 'g-scope')!, 'live', NO_PENDING);
    expect(scope.approve).toBe('disabled');
    expect(scope.reject).toBe('enabled');
    expect(scope.disabledReason).toBe('Requires privileged operator.');
    const noCaps = gateDecisionAffordances(p, gateById(p, 'g-upload')!, 'live', NO_PENDING);
    expect(noCaps.approve).toBe('hidden'); // decided gate has no capabilities
  });

  it('stale projection disables decisions — validity is never guessed (§22)', () => {
    const a = gateDecisionAffordances(p, gateById(p, 'g-review')!, 'lost', NO_PENDING);
    expect(a.approve).toBe('disabled');
    expect(a.guard).toBe('stale');
  });

  it('inactive (superseded) gates take no decisions (§23)', () => {
    const a = gateDecisionAffordances(p, gateById(p, 'g-old-publish')!, 'live', NO_PENDING);
    expect(a.guard).toBe('inactive');
  });
});

describe('decision path (C/F)', () => {
  function harness() {
    return createRoot((dispose) => {
      const stream = new FakeWorkspaceStream(gatesFixture());
      const relay = new NullHumanDecisionRelay(stream, { latencyMs: 5 });
      const projectionStore = createProjectionStore();
      projectionStore.applyUpstream(stream.current());
      const pendingIntents = createPendingIntentState(
        (intent) => relay.send(intent as never, 'fake-actor:test-user'),
        fakeIntentAdapter,
        projectionStore.projection,
      );
      stream.subscribe((next) => {
        projectionStore.applyUpstream(next);
        pendingIntents.reconcile(next);
      });
      return { stream, projectionStore, pendingIntents, dispose };
    });
  }

  it('approve: pending → relay → projection carries the attributed decision', async () => {
    const h = harness();
    const submit = h.pendingIntents.submit({ nodeId: 'g-review', action: 'gate.approve' });
    // Double-submit guard active while pending (F).
    expect(hasPendingGateDecision(h.pendingIntents.inFlight(), 'g-review')).toBe(true);
    const guarded = gateDecisionAffordances(
      h.projectionStore.projection(),
      gateById(h.projectionStore.projection(), 'g-review')!,
      'live',
      h.pendingIntents.inFlight(),
    );
    expect(guarded.approve).toBe('disabled');
    expect(guarded.guard).toBe('pending');
    // Local state untouched until the projection returns.
    expect(gateById(h.projectionStore.projection(), 'g-review')!.state).toBe('waiting');
    await submit;
    const decided = gateById(h.projectionStore.projection(), 'g-review')!;
    expect(decided.state).toBe('approved');
    expect(decided.decision?.by).toBe('fake-actor:test-user');
    expect(h.pendingIntents.inFlight()).toHaveLength(0);
    h.dispose();
  });

  it('approving an egress gate creates a SEPARATE pending effect (G) — approval ≠ effect', async () => {
    const h = harness();
    await h.pendingIntents.submit({
      nodeId: 'g-deploy',
      action: 'gate.approve',
      decision: { text: 'Release window confirmed' },
    });
    const p = h.projectionStore.projection();
    expect(gateById(p, 'g-deploy')!.state).toBe('approved');
    expect(gateById(p, 'g-deploy')!.decision?.reason).toBe('Release window confirmed');
    const effects = gateEffects(p, 'g-deploy');
    expect(effects).toHaveLength(1);
    expect(effects[0]!.state).toBe('pending'); // NOT succeeded — outcome is separate
    h.dispose();
  });

  it('request changes keeps resolution to upstream and lands as human activity on the linked task', async () => {
    const h = harness();
    await h.pendingIntents.submit({
      nodeId: 'g-review',
      action: 'gate.requestChanges',
      decision: { text: 'Shorten the introduction.' },
    });
    const p = h.projectionStore.projection();
    expect(gateById(p, 'g-review')!.state).toBe('waiting'); // fake upstream kept it open
    expect(
      p.activities.some(
        (a) => a.taskId === 't-draft' && a.actor === 'human' && a.label === 'Shorten the introduction.',
      ),
    ).toBe(true);
    h.dispose();
  });

  it('effect failure stays a distinct fact next to an approved gate (H)', () => {
    const p = gatesFixture();
    expect(gateById(p, 'g-migrate')!.state).toBe('approved');
    expect(gateEffects(p, 'g-migrate')[0]!.state).toBe('failed');
  });
});
