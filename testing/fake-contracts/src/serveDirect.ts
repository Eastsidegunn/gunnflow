/** Runs the simulator's direct-wire reference server (dev/e2e). */
import { startFakeDirectServer } from './directServer.js';

const server = await startFakeDirectServer({ port: Number(process.env.FAKE_DIRECT_PORT ?? 8791) });
console.log(`fake direct-wire server  ${server.url}`);
