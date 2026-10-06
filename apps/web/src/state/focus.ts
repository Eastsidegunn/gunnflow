/**
 * Selection focus dimming (Task Inspector brief §16): with the inspector open,
 * the canvas keeps its context — the selected task stays full strength, direct
 * neighbors readable, everything else recedes without disappearing.
 */
import type { WorkspaceProjection } from '../model/types.js';

export const FOCUS_ALPHA = {
  selected: 1,
  neighbor: 0.6,
  missionSibling: 0.4,
  other: 0.25,
} as const;

export function computeFocusAlpha(
  projection: WorkspaceProjection,
  focusTaskId: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const task = projection.tasks.find((t) => t.id === focusTaskId);
  const neighbors = new Set<string>();
  for (const e of projection.edges) {
    if (e.from === focusTaskId) neighbors.add(e.to);
    if (e.to === focusTaskId) neighbors.add(e.from);
  }
  const all = [
    ...projection.tasks.map((t) => ({ id: t.id, missionId: t.missionId })),
    ...projection.gates.map((g) => ({ id: g.id, missionId: g.missionId })),
    ...projection.deliverables.map((d) => ({ id: d.id, missionId: d.missionId })),
  ];
  for (const n of all) {
    const alpha =
      n.id === focusTaskId
        ? FOCUS_ALPHA.selected
        : neighbors.has(n.id)
          ? FOCUS_ALPHA.neighbor
          : task && n.missionId === task.missionId
            ? FOCUS_ALPHA.missionSibling
            : FOCUS_ALPHA.other;
    out.set(n.id, alpha);
  }
  return out;
}
