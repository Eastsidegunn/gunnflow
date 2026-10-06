/**
 * Pure display model for canvas nodes. This is where "the UI shows only what
 * upstream provided" is enforced and tested (acceptance B2–B4): no field here
 * is ever computed from other fields — only passed through or omitted.
 */
export function elapsedLabel(
  startedAt: number | undefined,
  updatedAt: number | undefined,
  now: number,
): string | null {
  const base = startedAt ?? updatedAt;
  if (!base) return null;
  const mins = Math.max(0, Math.round((now - base) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
}
