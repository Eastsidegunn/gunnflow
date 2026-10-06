/**
 * On-demand node detail (M-17): fetched once per opened node, shown exactly
 * as received — labels are upstream vocabulary, texts are claim-grade plain
 * glyphs, nothing is interpolated or reworded. The response → display-state
 * mapping is pure so it can be tested without a DOM or a fetch.
 */
import { validateNodeDetail, type NodeDetail } from '@gunnflow/contract';

export type NodeDetailView =
  | { kind: 'items'; detail: NodeDetail }
  /** 404: the node has no detail — the section is omitted, silently. */
  | { kind: 'absent' }
  /** 501: said out loud as "not served" (invariant 2), never an empty section. */
  | { kind: 'unsupported' }
  /** Transport or structure fault: shown with its reason, never partially rendered. */
  | { kind: 'unavailable'; reason: string };

export function detailViewOf(status: number, body: unknown): NodeDetailView {
  if (status === 404) return { kind: 'absent' };
  if (status === 501) return { kind: 'unsupported' };
  if (status !== 200) {
    const reason = (body as { reason?: unknown } | null)?.reason;
    return { kind: 'unavailable', reason: typeof reason === 'string' ? reason : `detail route answered ${status}` };
  }
  const checked = validateNodeDetail(body);
  return checked.ok ? { kind: 'items', detail: checked.detail } : { kind: 'unavailable', reason: checked.problems.join('; ') };
}

export async function fetchNodeDetail(nodeId: string): Promise<NodeDetailView> {
  try {
    const res = await fetch(`/api/node/${encodeURIComponent(nodeId)}/detail`, { cache: 'no-store' });
    return detailViewOf(res.status, await res.json().catch(() => null));
  } catch (err) {
    return { kind: 'unavailable', reason: `detail route unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
