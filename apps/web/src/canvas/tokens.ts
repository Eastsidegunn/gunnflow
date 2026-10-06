/**
 * Engine render constants. Glyph and tone come from config as validated
 * literals (any short unicode / a hex colour) printed verbatim — the config
 * stores what the screen shows. Everything else stays a closed token id,
 * looked up here as own properties (never the prototype chain). Nothing from
 * config is ever evaluated or composed into a style; an invalid value falls
 * back to neutral.
 */
import { isGlyphValue, TONE_HEX, type EdgeStyleId } from '@gunnflow/contract/wiring';
import { DEFAULT_THEME } from '../theme/defaultTheme.js';

/** Engine fallbacks for an unmapped or invalid state. */
export const NEUTRAL_GLYPH = DEFAULT_THEME.neutral.glyph;
export const NEUTRAL_TONE = DEFAULT_THEME.neutral.tone;
/** The engine's own attention colour (interrupt borders and badges — not configurable). */
export const ATTENTION_COLOR = DEFAULT_THEME.attention;

export interface EdgeStroke {
  width: number;
  color: string;
  double: boolean;
}

/** Config-selectable edge strokes: all solid. */
export const EDGE_STROKE: Readonly<Record<EdgeStyleId, EdgeStroke>> = DEFAULT_THEME.edges;
export const DEFAULT_EDGE_STROKE = EDGE_STROKE.solid;

/**
 * The personal grade: the person's own local items. A hue no other grade uses,
 * solid (dashes belong to pending and draft), with a folded corner.
 */
export const PERSONAL_STYLE = DEFAULT_THEME.personal;

/** Engine container style for `contain` groups (not configurable). */
export const GROUP_STYLE = DEFAULT_THEME.group;

/** Engine-only dash patterns (pending, draft grades); config edges never use them. */
export const PENDING_DASH: readonly number[] = DEFAULT_THEME.dashes.pending;
export const DRAFT_DASH: readonly number[] = DEFAULT_THEME.dashes.draft;
export const CONFIG_EDGE_DASH: readonly number[] = DEFAULT_THEME.dashes.configEdge;

const own = <T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

/** A validated literal (emoji etc.) prints verbatim; anything else → ○. */
export const glyphChar = (v: string | undefined) => (v !== undefined && isGlyphValue(v) ? v : NEUTRAL_GLYPH);
/** A '#rrggbb' literal passes through; anything else → the neutral tone. */
export const toneColor = (v: string | undefined) => (v !== undefined && TONE_HEX.test(v) ? v : NEUTRAL_TONE);
export const edgeStroke = (id: string | undefined) => own(EDGE_STROKE, id) ?? DEFAULT_EDGE_STROKE;
