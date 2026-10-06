/**
 * Default wiring config for the simulator's vocabulary. Data only — it passes
 * the contract's wiring validator. Kind assemblies are drafts: the canvas does
 * not render from them yet.
 */
import { WIRING_SCHEMA_VERSION, type WiringConfig } from '@gunnflow/contract/wiring';

export const DEFAULT_WIRING: WiringConfig = {
  version: WIRING_SCHEMA_VERSION,
  render: {
    queued: { glyph: '◌', tone: '#5b6672' },
    running: { glyph: '▶', tone: '#4da3ff' },
    waiting: { glyph: '◷', tone: '#ffb02e' },
    paused: { glyph: '❙❙', tone: '#e8a33d' },
    blocked: { glyph: '■', tone: '#ff5d5d' },
    completed: { glyph: '✓', tone: '#6ee7a8' },
    failed: { glyph: '✕', tone: '#ff5d5d' },
    approved: { glyph: '✓', tone: '#6ee7a8' },
    rejected: { glyph: '✕', tone: '#5b6672' },
    expired: { glyph: '◷', tone: '#5b6672' },
    superseded: { glyph: '○', tone: '#5b6672' },
    canceled: { glyph: '✕', tone: '#5b6672' },
    draft: { glyph: '▤', tone: '#dde3ea' },
  },
  relations: {
    dependency: { style: 'solid', arrange: 'flow' },
    spawn: { style: 'muted', arrange: 'flow' },
    produces: { style: 'bold', arrange: 'flow' },
    gate: { style: 'double', arrange: 'flow' },
    'member-of': { style: 'muted', arrange: 'contain' },
    evidence: { style: 'solid' },
    'superseded-by': { style: 'muted' },
  },
  attention: [
    { match: { cause: 'waiting_for_human' }, mechanism: 'interrupt' },
    { match: { cause: 'flagged' }, mechanism: 'ambient' },
  ],
  // Sidebar lenses for the simulator's vocabulary — pure match tables, no meaning in the engine.
  lenses: [
    { id: 'needs-you', label: 'Needs you', match: { attention: true } },
    { id: 'running', label: 'Running', match: { states: ['running'] } },
    { id: 'deliverables', label: 'Deliverables', match: { kinds: ['deliverable'] } },
    { id: 'blocked', label: 'Blocked', match: { states: ['blocked'] } },
  ],
  // The simulator's recommendation label, emphasized in detail views (label match only).
  detail: { emphasis: ['recommendation'] },
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
  kinds: {
    task: {
      parts: [
        { id: 'status', part: 'glyph' },
        { id: 'state', part: 'label', source: 'state' },
        { id: 'artifact', part: 'viewer', source: { artifact: 0 } },
        { id: 'artifact-2', part: 'viewer', source: { artifact: 1 } },
        { id: 'instruction', part: 'text', action: 'task.instruct' },
        { id: 'send-instruction', part: 'send', action: 'task.instruct', requires: ['instruction'] },
        { id: 'pause', part: 'send', action: 'task.pause', requires: [] },
        { id: 'resume', part: 'send', action: 'task.resume', requires: [] },
        { id: 'body', part: 'editor', action: 'artifact.edit', rows: 12, wrap: 'soft' },
        { id: 'save', part: 'send', action: 'artifact.edit', requires: ['body'] },
      ],
    },
    gate: {
      parts: [
        { id: 'status', part: 'glyph' },
        { id: 'state', part: 'label', source: 'state' },
        { id: 'evidence', part: 'viewer', source: { artifact: 0 } },
        { id: 'reason', part: 'text', action: 'gate.approve' },
        // The reason is optional unless upstream requires it; the send carries it either way.
        { id: 'approve', part: 'send', action: 'gate.approve', requires: [] },
        { id: 'reject-reason', part: 'text', action: 'gate.reject' },
        { id: 'reject', part: 'send', action: 'gate.reject', requires: [] },
        { id: 'changes', part: 'text', action: 'gate.requestChanges' },
        { id: 'request-changes', part: 'send', action: 'gate.requestChanges', requires: ['changes'] },
      ],
    },
    workspace: {
      parts: [
        { id: 'mission-name', part: 'text', action: 'mission.create' },
        { id: 'create-mission', part: 'send', action: 'mission.create', requires: ['mission-name'] },
      ],
    },
    mission: {
      parts: [
        { id: 'status', part: 'glyph' },
        { id: 'kind', part: 'label', source: 'kind' },
      ],
    },
    deliverable: {
      parts: [
        { id: 'status', part: 'glyph' },
        { id: 'kind', part: 'label', source: 'kind' },
      ],
    },
  },
};
