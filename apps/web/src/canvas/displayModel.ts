/**
 * Pure display model for canvas nodes. This is where "the UI shows only what
 * upstream provided" is enforced and tested (acceptance B2–B4): no field here
 * is ever computed from other fields — only passed through or omitted.
 */
import { t } from '../i18n/index.js';

export function elapsedLabel(
  startedAt: number | undefined,
  updatedAt: number | undefined,
  now: number,
): string | null {
  const base = startedAt ?? updatedAt;
  if (!base) return null;
  const mins = Math.max(0, Math.round((now - base) / 60_000));
  if (mins < 60) return t('elapsed.minutes', { m: mins });
  const h = Math.floor(mins / 60);
  return mins % 60 ? t('elapsed.hoursMinutes', { h, m: mins % 60 }) : t('elapsed.hours', { h });
}
