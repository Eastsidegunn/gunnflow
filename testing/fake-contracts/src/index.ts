export * from './projection.js';
export * from './artifacts.js';
export * from './fixtures.js';
export * from './stream.js';
export * from './relay.js';
export * from './execution.js';
export * from './terminal.js';
export * from './streams.js';
export * from './upstreamAdapter.js';
export * from './details.js';
export * from './projectNodes.js';
export * from './canonical.js';
export * from './executionFixtures.js';
/** Execution Surface brief §31 naming: controls ride the same TEST-ONLY relay. */
export { NullIntentRelay as NullExecutionIntentRelay } from './relay.js';
/** Human Gate brief §32 naming: gate decisions ride the same TEST-ONLY relay. */
export { NullIntentRelay as NullHumanDecisionRelay } from './relay.js';
