import type { TuningStore } from '../../shared/index.js';
import { bandMidpoint } from './attribution.js';
import type { TunableDial } from './types.js';

export interface SeedAnalystWeightsInput {
  tuning: TuningStore;
  analyst_ids: readonly string[];
  dial: TunableDial;
}

export interface SeedAnalystWeightsResult {
  seeded: string[];
  existing: string[];
}

export function seedAnalystWeights(input: SeedAnalystWeightsInput): SeedAnalystWeightsResult {
  const neutral = bandMidpoint(input.dial);

  const seeded: string[] = [];
  const existing: string[] = [];
  const seen = new Set<string>();

  for (const analyst_id of input.analyst_ids) {
    if (seen.has(analyst_id)) {
      continue;
    }
    seen.add(analyst_id);

    if (input.tuning.seedAnalystWeight(analyst_id, neutral)) {
      seeded.push(analyst_id);
    } else {
      existing.push(analyst_id);
    }
  }

  return { seeded, existing };
}
