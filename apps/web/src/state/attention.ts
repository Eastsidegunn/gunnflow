/**
 * Interrupt view-status: which received nodes currently carry an attention
 * cause the config maps to `interrupt`. Pure lookup — causes are received,
 * the mapping is config data, nothing is inferred.
 */
import { attentionMechanism, type WiringConfig } from '@gunnflow/contract/wiring';
import type { NodeProjection } from '@gunnflow/contract';

export function interruptNodes(nodes: readonly NodeProjection[], config: WiringConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes) {
    if (n.attention.some((a) => attentionMechanism(config, a.cause) === 'interrupt')) out.set(n.id, n.label ?? n.id);
  }
  return out;
}
