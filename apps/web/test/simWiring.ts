// What the cockpit runs with in fake mode: the engine default with the simulator's wiring layered on.
import { SIMULATOR_WIRING } from '@gunnflow-testing/fake-contracts';
import { DEFAULT_WIRING } from '../src/wiring/defaultWiring.js';
import { mergeWiring } from '../src/wiring/loadWiring.js';

export const SIM_WIRING = mergeWiring(DEFAULT_WIRING, SIMULATOR_WIRING);
