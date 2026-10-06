/**
 * Part resolution: a node's assembly (config) meets its capabilities
 * (upstream). Capabilities are the source of what a node can do; the assembly
 * only gives some actions a presentation and can never widen authority:
 * an assembled send or input whose action is absent or hidden does not appear.
 * Enabled/disabled actions the assembly does not cover get a raw-label
 * fallback control, unusable (with the reason) when their decision needs UI
 * the default control cannot collect.
 */
import type { Capability, NodeProjection } from '@gunnflow/contract';
import { kindParts, type PartDecl, type WiringConfig } from '@gunnflow/contract/wiring';

export type ResolvedDisplay =
  | { partId: string; part: 'glyph' }
  | { partId: string; part: 'label'; text: string }
  | { partId: string; part: 'viewer'; artifactId: string | null }
  | { partId: string; part: 'stream'; streamId: string | null };

export interface ResolvedInput {
  partId: string;
  part: 'selector' | 'text' | 'editor';
}

export type ResolvedAction =
  | {
      kind: 'assembled';
      partId: string;
      action: string;
      level: 'enabled' | 'disabled';
      inputs: ResolvedInput[];
      /** Evidence artifact ids from the capability (the viewing condition and attestation basis). */
      evidence: string[];
      /** Why the send cannot run even when enabled (an unbindable precondition). */
      blocked?: string;
    }
  | {
      kind: 'fallback';
      action: string;
      level: 'enabled' | 'disabled';
      usable: boolean;
      reason?: string;
      evidence: string[];
    };

export interface ResolvedParts {
  display: ResolvedDisplay[];
  actions: ResolvedAction[];
}

/** Can this input part bind to the capability's declared slot? */
function binds(part: PartDecl, cap: Capability): boolean {
  if (part.part === 'selector') return Boolean(cap.decision?.options?.length);
  if (part.part === 'text') return Boolean(cap.decision?.input);
  if (part.part === 'editor') return Boolean(cap.edit);
  return false;
}

/** A decision the default (label-only) control cannot collect. */
function needsUi(cap: Capability): string | undefined {
  if (cap.decision?.options?.length) return 'needs a choice among options';
  if (cap.decision?.input?.required) return 'needs text input';
  if (cap.decision?.evidence?.length) return 'needs evidence to be viewed first';
  if (cap.edit) return 'needs an editor';
  return undefined;
}

export function resolveParts(node: NodeProjection, config: WiringConfig): ResolvedParts {
  const caps = new Map(node.capabilities.map((c) => [c.action, c]));
  const visible = (action: string) => {
    const cap = caps.get(action);
    return cap && cap.level !== 'hidden' ? cap : undefined;
  };
  const parts = kindParts(config, node.kind) ?? [];
  const display: ResolvedDisplay[] = [];
  const actions: ResolvedAction[] = [];

  for (const part of parts) {
    if (part.part === 'glyph') display.push({ partId: part.id, part: 'glyph' });
    else if (part.part === 'label') {
      const text = part.source === 'state' ? node.state.value : part.source === 'kind' ? node.kind : (node.label ?? node.id);
      display.push({ partId: part.id, part: 'label', text });
    } else if (part.part === 'viewer') {
      display.push({ partId: part.id, part: 'viewer', artifactId: node.artifacts[part.source.artifact]?.id ?? null });
    } else if (part.part === 'stream') {
      const s = node.streams?.find((x) => x.role === part.source.role);
      display.push({ partId: part.id, part: 'stream', streamId: s?.id ?? null });
    }
  }

  const covered = new Set<string>();
  for (const send of parts) {
    if (send.part !== 'send') continue;
    const cap = visible(send.action);
    if (!cap) continue;
    covered.add(send.action);
    const inputs: ResolvedInput[] = parts
      .filter((p): p is Extract<PartDecl, { part: 'selector' | 'text' | 'editor' }> =>
        (p.part === 'selector' || p.part === 'text' || p.part === 'editor') && p.action === send.action && binds(p, cap),
      )
      .map((p) => ({ partId: p.id, part: p.part }));
    const bound = new Set(inputs.map((i) => i.partId));
    const unbindable = send.requires.find((r) => {
      const target = parts.find((p) => p.id === r);
      return target && (target.part === 'selector' || target.part === 'text' || target.part === 'editor') && !bound.has(r);
    });
    actions.push({
      kind: 'assembled',
      partId: send.id,
      action: send.action,
      level: cap.level as 'enabled' | 'disabled',
      inputs,
      evidence: cap.decision?.evidence ?? [],
      ...(unbindable ? { blocked: `requires '${unbindable}', which this node's capability does not declare a slot for` } : {}),
    });
  }

  for (const cap of node.capabilities) {
    if (cap.level === 'hidden' || covered.has(cap.action)) continue;
    const reason = needsUi(cap);
    actions.push({
      kind: 'fallback',
      action: cap.action,
      level: cap.level,
      usable: !reason,
      ...(reason ? { reason } : {}),
      evidence: cap.decision?.evidence ?? [],
    });
  }
  return { display, actions };
}
