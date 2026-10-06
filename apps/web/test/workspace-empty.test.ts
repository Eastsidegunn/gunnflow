import { describe, expect, it } from 'vitest';
import { WORKSPACE_ROOT_KIND, type NodeProjection } from '@gunnflow/contract';
import { workspaceEmpty } from '../src/model/selectors.js';
import type { WorkspaceProjection } from '../src/model/types.js';

const bareDomain = {
  missions: [],
  tasks: [],
  gates: [],
  deliverables: [],
} as unknown as WorkspaceProjection;

const node = (id: string, kind: string): NodeProjection => ({
  id,
  kind,
  state: { value: 'unstated' },
  relations: [],
  capabilities: [],
  attention: [],
  artifacts: [],
});

describe('workspaceEmpty', () => {
  it('empty domain with no generic nodes is empty', () => {
    expect(workspaceEmpty(bareDomain, null)).toBe(true);
  });

  it('a workspace root alone does not make the workspace non-empty', () => {
    expect(workspaceEmpty(bareDomain, [node('~workspace', WORKSPACE_ROOT_KIND)])).toBe(true);
  });

  it('generic nodes beyond the root mean the workspace is not empty (wire-only upstream)', () => {
    expect(
      workspaceEmpty(bareDomain, [node('~workspace', WORKSPACE_ROOT_KIND), node('m1', 'mission')]),
    ).toBe(false);
  });

  it('a non-empty domain projection is never empty', () => {
    const withTask = { ...bareDomain, tasks: [{ id: 't1' }] } as unknown as WorkspaceProjection;
    expect(workspaceEmpty(withTask, null)).toBe(false);
  });
});
