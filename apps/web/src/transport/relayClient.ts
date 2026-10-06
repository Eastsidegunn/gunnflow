/** Transport only: posts a human intent to the BFF relay. No local judgment. */
import type { Intent, IntentResult } from '../model/types.js';

export async function postIntent(intent: Intent): Promise<IntentResult> {
  const res = await fetch('/api/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const body = (await res.json()) as IntentResult;
  return body;
}
