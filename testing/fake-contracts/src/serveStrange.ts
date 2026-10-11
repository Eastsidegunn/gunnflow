/** Runs the unfamiliar ticket-board backend on the direct wire (e2e only). */
import { startStrangeServer } from './strangeServer.js';

const server = await startStrangeServer({ port: Number(process.env.STRANGE_PORT ?? 28791) });
console.log(`strange direct-wire server  ${server.url}`);
