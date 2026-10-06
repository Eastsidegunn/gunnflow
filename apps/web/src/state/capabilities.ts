/**
 * Action affordance = the upstream capability, verbatim (Task Inspector brief
 * §10, §19). Authority always comes from upstream; absence of a capability
 * never widens it (missing → hidden). There is no cockpit mode: whether a
 * write is possible is capability × preconditions alone.
 */
import type { CapabilityLevel } from '@gunnflow/contract';

export type Affordance = 'enabled' | 'disabled' | 'hidden';

export function writeAffordance(capability: CapabilityLevel | undefined): Affordance {
  if (capability === undefined || capability === 'hidden') return 'hidden';
  if (capability === 'disabled') return 'disabled';
  return 'enabled';
}
