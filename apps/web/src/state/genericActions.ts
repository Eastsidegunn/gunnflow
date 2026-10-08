/**
 * Whether a resolved action can run now. Composition of two facts only:
 * the capability level, and what the capability's decision requires (a
 * fallback cannot collect it; an assembled send must have its preconditions
 * met). No risk tiers, no action lists, no cockpit mode.
 */
import type { ResolvedAction } from '../canvas/parts.js';

export type ActionGate = { runnable: true } | { runnable: false; reason: string };

export function actionGate(action: ResolvedAction, preconditionsMet = true): ActionGate {
  if (action.level !== 'enabled') return { runnable: false, reason: 'disabled by upstream' };
  if (action.kind === 'fallback' && !action.usable) return { runnable: false, reason: action.reason ?? 'needs more than a click' };
  if (action.kind === 'assembled' && action.blocked) return { runnable: false, reason: action.blocked };
  if (!preconditionsMet) return { runnable: false, reason: 'fill in what this action requires' };
  return { runnable: true };
}

/** Opening the panel for an action: the level gates it; what it requires is collected there. */
export function openGate(action: ResolvedAction): ActionGate {
  if (action.level !== 'enabled') return { runnable: false, reason: 'disabled by upstream' };
  return { runnable: true };
}

/**
 * Where an action's text input lives. Stacked surfaces: one field per action
 * ('field'). The decision inbox's bar: the primary action's OPTIONAL text sits
 * inline; every other text slot (required or optional) is an expand-in-place
 * form whose button opens it rather than sending. 'none': no text slot.
 */
export type TextMode = 'field' | 'expand' | 'inline' | 'none';
export function textModeFor(o: { hasText: boolean; bar: boolean; required: boolean; primary: boolean }): TextMode {
  if (!o.hasText) return 'none';
  if (!o.bar) return 'field';
  if (o.primary && !o.required) return 'inline';
  return 'expand';
}

/**
 * What a send may relay: never a text the control is not showing. A text the
 * person typed elsewhere stays in its composing entry, but leaves this control
 * only while its field is on screen.
 */
export function shownDecision<D extends { text?: string }>(decision: D, mode: TextMode, expanded: boolean): D {
  const shown = mode === 'field' || mode === 'inline' || (mode === 'expand' && expanded);
  if (shown || decision.text === undefined) return decision;
  const { text: _hidden, ...rest } = decision;
  return rest as D;
}

/** Actions that open a panel (they need input, evidence or an editor) rather than relaying on click. */
export function opensPanel(action: ResolvedAction): boolean {
  if (action.kind === 'fallback') return !action.usable;
  return action.inputs.length > 0 || action.evidence.length > 0;
}
