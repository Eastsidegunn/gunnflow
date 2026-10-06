// The cockpit's relay guard refuses the same shared refused-shape fixture the
// backends use, through the same contract validator (validateIntent).
import { describe, expect, it, vi } from 'vitest';
import { refusedIntentShapes } from '@gunnflow/contract/conformance';
import { projectNodes, normalFixture } from '@gunnflow-testing/fake-contracts';
import { createFakeIntentAdapter } from '../src/state/fakeIntentAdapter.js';
import { guardPost } from '../src/state/intentValidator.js';
import type { WireIntent } from '../src/model/types.js';

describe('relay guard: shared refused intent shapes', () => {
  it('refuses old wire shapes and extra fields before anything is posted; the valid shape passes', async () => {
    const p = normalFixture();
    const adapter = createFakeIntentAdapter(() => projectNodes(p));
    const post = vi.fn(async () => ({ accepted: true }));
    const guarded = guardPost(post, adapter, () => p);
    const task = projectNodes(p).find((n) => n.kind === 'task' && n.capabilities.some((c) => c.action === 'task.pause' && c.level === 'enabled'))!;
    for (const [label, intent] of refusedIntentShapes(task.id, 'task.pause')) {
      const r = await guarded(intent as WireIntent);
      expect(r.accepted, label).toBe(false);
    }
    expect(post).not.toHaveBeenCalled();
    await guarded({ nodeId: task.id, action: 'task.pause', idempotencyKey: 'k-ok' });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
