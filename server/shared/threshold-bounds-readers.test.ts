import { readFileSync } from 'node:fs';
import { SqliteTuningStore } from '../pipeline/feedback-loop/sqlite-tuning-store.js';
import { resolveRiskConfig } from '../pipeline/risk-manager/risk-thresholds.js';
import type { RiskConfig } from '../pipeline/risk-manager/types.js';
import { openSharedStore } from './store/index.js';
import { GUARDED_THRESHOLD_BOUNDS, ThresholdBoundViolationError } from './threshold-bounds.js';

const G9_MAX_PBO = 0.1;
const SOFTENED_PBO = 0.11;

const baseRisk: RiskConfig = {
  max_position_size_fraction_of_equity: 0.35,
  per_asset_cap_fraction_of_equity: 0.35,
  per_asset_class_cap_fraction_of_equity: { crypto: 0.5, stocks: 0.5 },
  portfolio_gross_cap_fraction_of_equity: 1,
  concentration: { cap_fraction_of_equity: 0.35, threshold: 0.7 },
  min_viable_size: 100,
  whole_share_sizing: false,
  cii_threshold: 70,
  max_mark_age: { crypto: 120_000, stocks: 900_000 },
};

describe('G9 PBO bound reaches every threshold reader', () => {
  it('threshold-bounds carries the G9 line', () => {
    expect(GUARDED_THRESHOLD_BOUNDS.max_pbo.max).toBe(G9_MAX_PBO);
  });

  it('risk-thresholds refuses a softened PBO line and accepts the G9 line', () => {
    expect(() => resolveRiskConfig(baseRisk, { max_pbo: SOFTENED_PBO })).toThrow(
      ThresholdBoundViolationError,
    );
    expect(() => resolveRiskConfig(baseRisk, { max_pbo: G9_MAX_PBO })).not.toThrow();
  });

  it('sqlite-tuning-store refuses to persist a softened PBO line and accepts the G9 line', () => {
    const store = new SqliteTuningStore(openSharedStore(':memory:'), {
      now: () => new Date('2026-09-24T00:00:00Z'),
    });
    expect(() => store.setRiskThreshold('max_pbo', SOFTENED_PBO)).toThrow(
      ThresholdBoundViolationError,
    );
    store.setRiskThreshold('max_pbo', G9_MAX_PBO);
    expect(store.getRiskThresholds()).toEqual({ max_pbo: G9_MAX_PBO });
  });

  it('production.ts routes bound violations through the shared threshold-bounds export', () => {
    const production = readFileSync(
      new URL('../apps/orchestrator/production.ts', import.meta.url),
      'utf8',
    );
    const shared = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(production).toContain('isThresholdBoundViolation');
    expect(production).toMatch(/from '\.\.\/\.\.\/shared\/index\.js'/);
    expect(shared).toMatch(/isThresholdBoundViolation[\s\S]*from '\.\/threshold-bounds\.js'/);
  });
});
