/**
 * The engine's default wiring: only what holds for any backend. It names no
 * state, kind, relation, cause or action — those are the backend's words,
 * presented through its own wiring files (unwired words show a neutral glyph
 * and their raw text). Data only — it passes the contract's wiring validator.
 */
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';

export const DEFAULT_WIRING: WiringConfig = {
  version: WIRING_SCHEMA_VERSION,
  // Attention is the contract's own fact: a lens for it holds for every backend.
  lenses: [{ id: 'needs-you', label: 'Needs you', match: { attention: true } }],
  viewers: {
    'text/plain': 'text',
    'text/markdown': 'markdown-source',
    'text/html': 'html-isolated',
    'image/*': 'image',
    'application/pdf': 'pdf',
    'text/vnd.mermaid': 'mermaid',
    'text/x-mermaid': 'mermaid',
    'application/vnd.excalidraw+json': 'excalidraw',
  },
};
