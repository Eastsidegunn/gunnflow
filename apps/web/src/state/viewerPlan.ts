/**
 * How an artifact is shown, from its access and the wiring's viewer mapping
 * (engine rule; config only picks among engine viewers):
 *   plain     — text rendered by the cockpit as glyphs (claim grade)
 *   frame     — isolated origin, sandboxed iframe (claim grade)
 *   image     — isolated origin, <img> (claim grade)
 *   mermaid   — rendered to SVG on the isolated origin, shown as <img> (claim grade)
 *   scene     — Excalidraw scene in the isolated read-only viewer page (claim grade)
 *   portal    — live remote content, opened only on request (portal grade, never attested)
 *   fallback  — no viewer registered; raw on the isolated origin only
 */
import type { ArtifactRef } from '@gunnflow/contract';
import { viewerFor, type WiringConfig } from '@gunnflow/contract/wiring';

export type ViewerPlan = 'plain' | 'frame' | 'image' | 'mermaid' | 'scene' | 'portal' | 'fallback';

export function viewerPlan(ref: ArtifactRef, config: WiringConfig): ViewerPlan {
  if (ref.access.kind === 'live') return 'portal';
  const viewer = viewerFor(config, ref.mediaType);
  if (viewer === 'text' || viewer === 'markdown-source') return 'plain';
  if (viewer === 'html-isolated' || viewer === 'pdf') return 'frame';
  if (viewer === 'image') return 'image';
  if (viewer === 'mermaid') return 'mermaid';
  if (viewer === 'excalidraw') return 'scene';
  return 'fallback';
}
