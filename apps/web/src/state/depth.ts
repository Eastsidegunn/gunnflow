/**
 * Depth model (조망 ① → 선택 ② → 작업 ③): pure resolution for the work
 * surface. `surfaceForKind` is the engine's kind→surface table (config-like
 * plumbing: it maps the two kinds that have deep surfaces today, everything
 * else to the full-width assembly). ③ has no context strip (design
 * review ②) — the only remaining helper beyond resolution is the carried
 * decision-queue position.
 */

/** The deep surface a node's kind resolves to; 'assembly' = no deep surface (② content at full width). */
export type WorkSurfaceKind = 'approval' | 'inspector' | 'assembly';

export function surfaceForKind(kind: string | undefined): WorkSurfaceKind {
  if (kind === 'gate') return 'approval';
  if (kind === 'task') return 'inspector';
  return 'assembly';
}

/**
 * A deep surface renders DOMAIN facts the projection may not carry (a live
 * upstream serves generic nodes only). When the kind's deep surface has no
 * domain record to show, depth 3 falls back to the assembly — the generic ②
 * content at full width — instead of an empty body. The fallback is honest:
 * it shows exactly the received facts, never an invented deep view.
 */
export function resolveWorkSurface(kind: string | undefined, hasDomainRecord: boolean): WorkSurfaceKind {
  const surface = surfaceForKind(kind);
  if (surface === 'assembly') return surface;
  return hasDomainRecord ? surface : 'assembly';
}

/** Position of `id` in a carried queue; -1 when the queue does not carry it. */
export function queueIndexOf(queue: readonly string[] | undefined, id: string): number {
  return queue ? queue.indexOf(id) : -1;
}
