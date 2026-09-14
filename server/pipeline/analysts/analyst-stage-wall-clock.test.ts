/**
 * #1104 — `ANALYST_STAGE_WALL_CLOCK_MS` still describes the stage it names.
 *
 * The constant exists because `paper-profile.ts`'s pass-duration arithmetic and
 * `paper-profile.test.ts` each used to restate the same product by hand. A
 * constant restating an arithmetic identity would be untestable; what is
 * testable, and what those consumers actually depend on, is that the stage's
 * OBSERVED worst case equals it — which holds only while the personas fan out
 * concurrently and each takes at most `ATTEMPTS_PER_PERSONA` deadlines. Make the
 * fan-out sequential, add an attempt, or add a backoff between attempts, and the
 * consumers' arithmetic goes wrong silently; these tests go red instead.
 *
 * Every assertion is on a settlement FLAG rather than on an awaited result, so a
 * regression that makes the stage slower fails on the expectation that names it
 * instead of hanging until vitest's own timeout.
 */

import type { MarketDataService } from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import {
  ANALYST_STAGE_WALL_CLOCK_MS,
  AnalystOrchestrator,
  DEFAULT_ANALYST_TIMEOUT_MS,
} from './orchestrator.js';
import type { Analyst, AnalystRunResult } from './types.js';

const ASOF = new Date('2026-09-14T14:00:00Z');
const CLOCK: Clock = { now: () => ASOF };
const SIGNAL = { asset: 'QQQ', asset_class: 'stocks' } as const;

/** Never settles, so every attempt can only end at the deadline. */
function stallingAnalyst(analyst_type: string): Analyst {
  return {
    analyst_type,
    role: 'mandatory',
    applies_to: () => true,
    run: () => new Promise<AnalystView>(() => {}),
  };
}

function startStarvedStage(personaCount: number): { settled: () => AnalystRunResult | undefined } {
  const personas = Array.from({ length: personaCount }, (_unused, index) =>
    stallingAnalyst(`persona-${index}`),
  );
  const orchestrator = new AnalystOrchestrator(
    {
      market_data: {} as MarketDataService,
      market_intelligence: new MarketIntelligenceStore(CLOCK),
    },
    personas,
  );

  let result: AnalystRunResult | undefined;
  void orchestrator
    .runAnalysts(`trace-${personaCount}`, SIGNAL, CLOCK, ASOF)
    .then((settledResult) => {
      result = settledResult;
    });
  return { settled: () => result };
}

describe('the analyst stage wall clock (#1104)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles a fully starved stage at exactly ANALYST_STAGE_WALL_CLOCK_MS', async () => {
    const stage = startStarvedStage(3);

    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYST_TIMEOUT_MS);
    expect(stage.settled(), 'the first deadline is retried, not returned').toBeUndefined();

    await vi.advanceTimersByTimeAsync(ANALYST_STAGE_WALL_CLOCK_MS - DEFAULT_ANALYST_TIMEOUT_MS - 1);
    expect(stage.settled()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const result = stage.settled();

    expect(result).toBeDefined();
    expect(result?.skipped).toBe(true);
    expect(result?.failures.map((failure) => failure.kind)).toEqual([
      'timeout',
      'timeout',
      'timeout',
    ]);
  });

  it('holds that wall clock however many personas the stage fans out to', async () => {
    const one = startStarvedStage(1);
    const many = startStarvedStage(3);

    await vi.advanceTimersByTimeAsync(ANALYST_STAGE_WALL_CLOCK_MS);

    expect(one.settled()?.failures).toHaveLength(1);
    expect(many.settled()?.failures).toHaveLength(3);
  });
});
