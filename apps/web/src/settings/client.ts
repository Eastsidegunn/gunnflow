/** The settings screen's transport: /api/wiring/user (only 90-user.json, server-side). */
import type { WiringConfig } from '@gunnflow/contract/wiring';

async function reasonOf(res: Response) {
  const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
  return typeof body?.reason === 'string' ? body.reason : `settings store answered ${res.status}`;
}

export async function loadUserWiring(): Promise<unknown | null> {
  const res = await fetch('/api/wiring/user', { cache: 'no-store' });
  if (!res.ok) throw new Error(await reasonOf(res));
  return ((await res.json()) as { config: unknown | null }).config;
}

export async function saveUserWiring(config: WiringConfig): Promise<void> {
  const res = await fetch('/api/wiring/user', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
  if (!res.ok) throw new Error(await reasonOf(res));
}

export async function removeUserWiringFile(): Promise<void> {
  const res = await fetch('/api/wiring/user', { method: 'DELETE' });
  if (!res.ok) throw new Error(await reasonOf(res));
}
