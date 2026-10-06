/** The personal layer's own transport: /api/personal and its mermaid rendering. It knows no other route. */
import type { PersonalDoc } from './schema.js';

export interface PersonalStore {
  load(): Promise<{ doc: unknown | null }>;
  save(doc: PersonalDoc): Promise<void>;
}

/** A personal mermaid source rendered on the isolated origin: the SVG's path there, or why not. */
export type PersonalRender = { ok: true; hash: string; svgPath: string } | { ok: false; reason: string };

export async function renderPersonalMermaid(source: string): Promise<PersonalRender> {
  try {
    const res = await fetch('/api/personal/render-mermaid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const body = (await res.json().catch(() => null)) as { hash?: unknown; svgPath?: unknown; reason?: unknown } | null;
    if (res.ok && typeof body?.hash === 'string' && typeof body.svgPath === 'string') return { ok: true, hash: body.hash, svgPath: body.svgPath };
    return { ok: false, reason: typeof body?.reason === 'string' ? body.reason : `renderer answered ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `renderer unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function reasonOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
  return typeof body?.reason === 'string' ? body.reason : `personal store answered ${res.status}`;
}

export const httpPersonalStore: PersonalStore = {
  async load() {
    const res = await fetch('/api/personal', { cache: 'no-store' });
    if (!res.ok) throw new Error(await reasonOf(res));
    return (await res.json()) as { doc: unknown | null };
  },
  async save(doc) {
    const res = await fetch('/api/personal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error(await reasonOf(res));
  },
};
