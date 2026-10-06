/**
 * Pure authority/guard logic for the terminal (brief §6, §21–§23, §34).
 * Gunnflow never classifies command content — risk lives upstream. These
 * guards only combine upstream capability × transport × lifecycle.
 */
import type { SessionProjection } from '../model/executionTypes.js';
import type { TerminalConnection } from './terminalStore.js';
import { writeAffordance } from './capabilities.js';

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

export const GUARD_LABEL: Record<NonNullable<StdinGuard['reason']>, string> = {
  'no-authority': 'No stdin authority for this session.',
  'authority-disabled': 'Stdin authority is disabled by upstream policy.',
  'not-live': 'Not live — input cannot be confirmed. Reconnect first.',
  'session-not-running': 'Session is not running — stdin is not accepted.',
};
