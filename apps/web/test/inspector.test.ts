// Task Inspector acceptance: relations/activity/capability projection integrity,
// focus dimming (§16), capability × mode affordances (§10, §19).
import { describe, expect, it } from 'vitest';
import { attentionFixture, blockedFixture, normalFixture } from '@gunnflow-testing/fake-contracts';
import {
  activityLabel,
  taskActivities,
  taskCapabilities,
  taskRelations,
  taskSessions,
} from '../src/model/selectors.js';
import { writeAffordance } from '../src/state/capabilities.js';
import { computeFocusAlpha, FOCUS_ALPHA } from '../src/state/focus.js';

describe('task relations (upstream edges only, no inference)', () => {
  it('reads direct upstream/downstream/gate/deliverable from declared edges', () => {
    const p = attentionFixture();
    const rel = taskRelations(p, 't-draft');
    expect(rel.upstream.map((t) => t.id)).toEqual(['t-research']);
    expect(rel.gates.map((g) => g.id)).toEqual(['g-publish']);
    const research = taskRelations(p, 't-research');
    expect(research.downstream.map((t) => t.id).sort()).toEqual(['t-build', 't-draft']);
    expect(research.deliverables.map((d) => d.id)).toEqual(['d-report']);
  });

  it('a task with no declared relations gets empty lists — nothing invented', () => {
    const p = normalFixture();
    const rel = taskRelations({ ...p, edges: [] }, 't-draft');
    expect(rel.upstream).toEqual([]);
    expect(rel.downstream).toEqual([]);
    expect(rel.gates).toEqual([]);
    expect(rel.deliverables).toEqual([]);
  });
});

describe('activity (upstream summaries only)', () => {
  it('lists a task’s activities newest-first', () => {
    const items = taskActivities(normalFixture(), 't-build');
    expect(items.length).toBe(3);
    expect(items[0]!.at).toBeGreaterThan(items[1]!.at);
  });

  it('falls back to the bare event type when upstream provides no label — never summarizes', () => {
    const unlabeled = taskActivities(normalFixture(), 't-build').find((a) => !a.label)!;
    expect(activityLabel(unlabeled)).toBe('tool.batch');
  });

  it('sessions come from upstream links only', () => {
    expect(taskSessions(normalFixture(), 't-build').map((s) => s.label)).toEqual([
      'Builder Session',
    ]);
    expect(taskSessions(normalFixture(), 't-test')).toEqual([]);
  });
});

describe('capability affordances', () => {
  it('missing capability never widens authority (→ hidden)', () => {
    expect(writeAffordance(undefined)).toBe('hidden');
    expect(taskCapabilities(normalFixture(), 'no-such-task')).toEqual({});
  });

  it('the affordance is the upstream level, verbatim', () => {
    expect(writeAffordance('enabled')).toBe('enabled');
    expect(writeAffordance('disabled')).toBe('disabled');
    expect(writeAffordance('hidden')).toBe('hidden');
  });
});

describe('focus dimming (§16)', () => {
  it('selected 100%, neighbors 60%, mission siblings 40%, others readable', () => {
    const p = blockedFixture();
    const alpha = computeFocusAlpha(p, 't-build');
    expect(alpha.get('t-build')).toBe(FOCUS_ALPHA.selected);
    expect(alpha.get('t-research')).toBe(FOCUS_ALPHA.neighbor); // edge e2
    expect(alpha.get('t-test')).toBe(FOCUS_ALPHA.neighbor); // edge e3
    expect(alpha.get('t-draft')).toBe(FOCUS_ALPHA.missionSibling);
    expect(alpha.get('g-publish')).toBe(FOCUS_ALPHA.missionSibling);
    // No node is ever fully erased.
    for (const a of alpha.values()) expect(a).toBeGreaterThan(0.1);
  });
});
