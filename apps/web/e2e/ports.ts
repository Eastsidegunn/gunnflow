/**
 * The suite's server ports, shifted by GUNNFLOW_E2E_PORT_OFFSET. The isolated config sets it (+40000,
 * clear of a live cockpit on 5173·8787·8788) before the base config or any spec loads; the default
 * config leaves it unset. Specs reach the main BFF through the web origin's /api proxy, and every
 * other origin through these — never a literal port.
 */
export const E2E_PORT_OFFSET_ENV = 'GUNNFLOW_E2E_PORT_OFFSET';
export const E2E_PORT_OFFSET = Number(process.env[E2E_PORT_OFFSET_ENV] ?? 0);

export const port = (base: number): number => base + E2E_PORT_OFFSET;
const origin = (base: number): string => `http://127.0.0.1:${port(base)}`;

/** The simulator in fake mode: web, BFF and its isolated preview origin. */
export const WEB = origin(5173);
export const BFF = origin(8787);
export const PREVIEW = origin(8788);
/** The direct path: the simulator's direct-wire reference server, a BFF on `direct`, its preview origin and web. */
export const DIRECT_UPSTREAM = origin(8791);
export const DIRECT_BFF = origin(8797);
export const DIRECT_PREVIEW = origin(8798);
export const DIRECT_WEB = origin(5174);
