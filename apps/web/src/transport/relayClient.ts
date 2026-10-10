/** Transport only: posts a human intent to the BFF relay. No local judgment. */
import type { Intent } from '../model/types.js';
import { relayResult, type RelayResult } from '../state/intentValidator.js';

/** The answer is normalized here: only `accepted` and the upstream's `reason` leave the transport. */
export async function postIntent(intent: Intent): Promise<RelayResult> {
  const res = await fetch('/api/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(intent),
  });
  return relayResult(await res.json());
}
