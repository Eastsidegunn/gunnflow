/**
 * 결정함 F2: the inbox-aside frame is computed from the layout's FINAL
 * geometry — the transition's target rects — never from the animated
 * on-screen rects. A relayout (e.g. the first layered pass replacing the
 * interim layout) starts a 400 ms transition; framing what is on screen one
 * frame in would aim at where the nodes were, not where they land.
 * View status only: the camera moves, nothing else.
 */
import type { NodeProjection } from '@gunnflow/contract';
import { relationArrangeFor, type WiringConfig } from '@gunnflow/contract/wiring';
import { buildScene, endpointBox } from './genericScene.js';
import type { Rect } from './personalDraw.js';
import { frameIds, unionRect, type FrameRect } from '../state/inboxCamera.js';

export function finalFrameBounds(
  nodes: readonly NodeProjection[],
  config: WiringConfig,
  id: string,
  /** The person's pinned positions (view state). */
  pins: ReadonlyMap<string, { x: number; y: number }>,
  /** The layout result (base positions). */
  base: ReadonlyMap<string, { x: number; y: number }>,
  /** The transition's targets: where every node lands (size and push-aside included). */
  targets: ReadonlyMap<string, Rect>,
  /** The layout graph's container map (nearest container per node). */
  parentOf: ReadonlyMap<string, string> | undefined,
  layoutOptions: { packContainers?: boolean } = {},
): FrameRect | null {
  const scene = buildScene(nodes, config, pins, base, targets, layoutOptions);
  if (!endpointBox(scene, id)) return null;
  const ids = frameIds(nodes, id, parentOf, (type) => relationArrangeFor(config, type) === 'contain');
  return unionRect(
    ids.flatMap((x) => {
      const r = endpointBox(scene, x);
      return r ? [{ x: r.x, y: r.y, w: r.w, h: r.h }] : [];
    }),
  );
}
