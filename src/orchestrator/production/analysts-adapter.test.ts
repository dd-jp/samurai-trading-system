import { describe, expect, it, vi } from 'vitest';
import type { AnalystOrchestrator } from '../../analysts/index.js';
import type { AnalystView } from '../../debate-engine/types.js';
import type { Clock } from '../../shared/clock.js';
import { buildAnalystsStep } from './analysts-adapter.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['price above the 50d'],
    timestamp: NOW,
    ...overrides,
  };
}

describe('buildAnalystsStep', () => {
  it('narrows AnalystRunResult to bare AnalystView[] and passes the 3-arg call through unmodified', async () => {
    const views = [makeView()];
    const runAnalysts = vi.fn(async () => ({
      views,
      analyst_count: 1,
      skipped: false,
      failures: [],
    }));
    const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

    const step = buildAnalystsStep(orchestrator);
    const result = await step({
      trace_id: 'trace-1',
      signal: { asset: 'AAPL', asset_class: 'stocks' },
      clock: CLOCK,
    });

    expect(result).toBe(views);
    expect(runAnalysts).toHaveBeenCalledWith(
      'trace-1',
      { asset: 'AAPL', asset_class: 'stocks' },
      CLOCK,
    );
  });

  it('preserves the empty-array quorum-skip contract', async () => {
    const runAnalysts = vi.fn(async () => ({
      views: [],
      analyst_count: 2,
      skipped: true,
      failures: [{ analyst_type: 'technical', role: 'mandatory', reason: 'timeout' }],
    }));
    const orchestrator = { runAnalysts } as unknown as AnalystOrchestrator;

    const step = buildAnalystsStep(orchestrator);
    const result = await step({
      trace_id: 'trace-1',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock: CLOCK,
    });

    expect(result).toEqual([]);
  });
});
