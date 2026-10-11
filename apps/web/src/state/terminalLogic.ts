/**
 * Pure authority/guard logic for the terminal (brief §6, §21–§23, §34).
 * Gunnflow never classifies command content — risk lives upstream. These
 * guards only combine upstream capability × transport × lifecycle.
 */
import type { SessionProjection } from '../model/executionTypes.js';
import type { TerminalConnection } from './terminalStore.js';
import { writeAffordance } from './capabilities.js';
import { t, type MessageKey } from '../i18n/index.js';

export interface StdinGuard {
  allowed: boolean;
  /** UI guard label; never an invented policy fact. */
  reason?: 'no-authority' | 'authority-disabled' | 'not-live' | 'session-not-running';
}

export function stdinGuard(
  session: SessionProjection | null,
  connection: TerminalConnection,
): StdinGuard {
  const capability = writeAffordance(session?.capabilities?.stdin);
  if (capability === 'hidden') return { allowed: false, reason: 'no-authority' };
  if (capability === 'disabled') return { allowed: false, reason: 'authority-disabled' };
  // Stale/disconnected/replay terminals take no input — outcomes could not be
  // confirmed, and replay is always read-only.
  if (connection !== 'live') return { allowed: false, reason: 'not-live' };
  if (session?.state !== 'running') return { allowed: false, reason: 'session-not-running' };
  return { allowed: true };
}

const GUARD_LABEL: Record<NonNullable<StdinGuard['reason']>, MessageKey> = {
  'no-authority': 'terminal.guard.noAuthority',
  'authority-disabled': 'terminal.guard.authorityDisabled',
  'not-live': 'terminal.guard.notLive',
  'session-not-running': 'terminal.guard.sessionNotRunning',
};

/** The guard's label in the current locale (resolved at render time). */
export function guardLabel(reason: NonNullable<StdinGuard['reason']>): string {
  return t(GUARD_LABEL[reason]);
}
