import type { Sleeve } from '../../../../contracts/index.js';
import { SIGNALS_SLEEVE_ID, SIGNALS_SLEEVE_SPEC } from './parameters.js';

// Entries arrive from the signals processor between cycles; the daily cycle only sweeps, exits
// and marks the two signals books, so the sleeve itself never decides
export function createSignalsSleeve(): Sleeve {
  return {
    id: SIGNALS_SLEEVE_ID,
    spec: SIGNALS_SLEEVE_SPEC,
    universe: () => ({ instruments: [], refusals: [] }),
    decide: () => Promise.resolve({ decisions: [], refusals: [] }),
  };
}
