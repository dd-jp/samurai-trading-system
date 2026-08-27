import type { Bar } from '../../providers/market-data-service/index.js';
import {
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { AnalystOrchestrator } from './orchestrator.js';
import type { Analyst, AnalystInput, AssetClass, Signal } from './types.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }
}

const INSTRUMENT = 'BTC-USD';
/** #742: the technical analyst's indicators read '5m' bars now, '1h' having moved to context-only. */
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;
const BAR_COUNT = 30;
const START = new Date('2026-07-14T00:00:00Z').getTime();

function buildBars(): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const closeTime = new Date(START + i * BAR_INTERVAL_MS);
    const close = 100 + i;
    bars.push({
      instrument: INSTRUMENT,
      timeframe: TIMEFRAME,
      open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
      close_time: closeTime,
      open: close - 1,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10 + i,
      source: 'fixture',
    });
  }
  return bars;
}

const BARS = buildBars();
const ASOF = BARS[BARS.length - 1].close_time;

function buildDeps(assetClass: AssetClass, bars: Bar[] = BARS) {
  const clock = new ManualClock(ASOF);
  const dataSource = new FixtureDataSource(
    bars,
    { price: 999, observed_at: ASOF, source: 'fixture-live' },
    assetClass,
  );
  const marketData = new MarketDataServiceImpl(
    dataSource,
    clock,
    'backtest',
    new SqliteMarketDataStore(openSharedStore(':memory:')),
  );

  const marketIntelligence = new MarketIntelligenceStore(clock);
  marketIntelligence.ingest({
    agent_id: 'deepresearch',
    timestamp: ASOF,
    asset_class: assetClass,
    items: [
      {
        id: 'item-news',
        source: 'bloomberg',
        type: 'news',
        timestamp: ASOF,
        entity: INSTRUMENT,
        headline: 'Steady uptrend continues',
        sentiment: 1,
        confidence: 0.6,
      },
      {
        id: 'item-social',
        source: 'twitter',
        type: 'sentiment',
        timestamp: ASOF,
        entity: INSTRUMENT,
        headline: 'Crowd is bullish',
        sentiment: 1,
        confidence: 0.5,
      },
    ],
  });

  return { clock, marketData, marketIntelligence };
}

function stubAnalyst(
  analyst_type: string,
  role: 'mandatory' | 'optional',
  behavior: 'succeed' | 'fail',
): Analyst {
  return {
    analyst_type,
    role,
    applies_to: () => true,
    async run(input: AnalystInput): Promise<AnalystView> {
      if (behavior === 'fail') {
        throw new Error(`${analyst_type} unavailable`);
      }
      return {
        trace_id: input.trace_id,
        analyst_id: analyst_type,
        analyst_type,
        direction: 'bullish',
        confidence: 0.5,
        key_points: [],
        timestamp: input.clock.now(),
      };
    },
  };
}

describe('AnalystOrchestrator', () => {
  it('runs Technical + Sentiment for crypto (Fundamental excluded)', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('crypto');
    const orchestrator = new AnalystOrchestrator({
      market_data: marketData,
      market_intelligence: marketIntelligence,
    });
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

    expect(result.analyst_count).toBe(2);
    expect(result.skipped).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.views.map((v) => v.analyst_type).sort()).toEqual(['sentiment', 'technical']);
  });

  it('runs Technical + Fundamental + Sentiment for stocks', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('stocks');
    const orchestrator = new AnalystOrchestrator({
      market_data: marketData,
      market_intelligence: marketIntelligence,
    });
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

    expect(result.analyst_count).toBe(3);
    expect(result.skipped).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.views.map((v) => v.analyst_type).sort()).toEqual([
      'fundamental',
      'sentiment',
      'technical',
    ]);
  });

  it('contains a short-window indicator throw as a recorded quorum skip, not a rejected tick (#319)', async () => {
    // The containment `computeIndicator`'s docstring relies on, pinned with
    // the REAL technical analyst rather than a stub. #319 made a short window
    // throw instead of answering a fabricated RSI, and that path fires far
    // more often than the misordered-feed throw it joined — a cold
    // instrument, a fresh DB after restart, a venue gap. `runTickPlan` has no
    // per-instrument catch, so if this escaped here it would abort every
    // OTHER instrument in the tick too.
    //
    // Instead it lands in the per-persona catch: technical is `mandatory`, so
    // the pass is a quorum skip with the reason recorded, and `runAnalysts`
    // itself resolves. Degraded and visible, not silent and not fatal.
    const coldStart = BARS.slice(0, 5);
    const { clock, marketData, marketIntelligence } = buildDeps('crypto', coldStart);
    const orchestrator = new AnalystOrchestrator({
      market_data: marketData,
      market_intelligence: marketIntelligence,
    });
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

    expect(result.skipped).toBe(true);
    expect(result.views).toEqual([]);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        analyst_type: 'technical',
        role: 'mandatory',
        // Whichever of the analyst's two indicator reads rejects first —
        // `Promise.all` gives no ordering guarantee, and both are short.
        reason: expect.stringMatching(/needs \d+ bars but received 5/),
      }),
    );
  });

  it('blocks the handoff (quorum-miss) when a mandatory persona fails', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('stocks');
    const personas = [
      stubAnalyst('technical', 'mandatory', 'fail'),
      stubAnalyst('fundamental', 'mandatory', 'succeed'),
      stubAnalyst('sentiment', 'optional', 'succeed'),
    ];
    const orchestrator = new AnalystOrchestrator(
      { market_data: marketData, market_intelligence: marketIntelligence },
      personas,
    );
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

    expect(result.skipped).toBe(true);
    expect(result.views).toEqual([]);
    expect(result.failures).toContainEqual({
      analyst_type: 'technical',
      role: 'mandatory',
      // #431: the reason now records that the retry was spent, so a log line
      // cannot be read as "failed once" when it failed twice.
      reason: 'technical unavailable (after 2 attempts)',
    });

    // The exact TickSteps.analysts shape must also report the skip as an empty array.
    const stepResult = await orchestrator.analysts({
      trace_id: 'trace-1',
      signal,
      clock,
      bar: ASOF,
    });
    expect(stepResult).toEqual([]);
  });

  it('proceeds with the reduced set when only the optional persona fails', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('stocks');
    const personas = [
      stubAnalyst('technical', 'mandatory', 'succeed'),
      stubAnalyst('fundamental', 'mandatory', 'succeed'),
      stubAnalyst('sentiment', 'optional', 'fail'),
    ];
    const orchestrator = new AnalystOrchestrator(
      { market_data: marketData, market_intelligence: marketIntelligence },
      personas,
    );
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

    expect(result.skipped).toBe(false);
    expect(result.views.map((v) => v.analyst_type).sort()).toEqual(['fundamental', 'technical']);
    expect(result.failures).toEqual([
      {
        analyst_type: 'sentiment',
        role: 'optional',
        reason: 'sentiment unavailable (after 2 attempts)',
      },
    ]);
  });

  /**
   * #371 — what the composition root seeds `analyst_weights` from.
   */
  describe('analystIds', () => {
    it('names every persona the default orchestrator builds', () => {
      const { marketData, marketIntelligence } = buildDeps('stocks');
      const orchestrator = new AnalystOrchestrator({
        market_data: marketData,
        market_intelligence: marketIntelligence,
      });

      expect(orchestrator.analystIds().sort()).toEqual(['fundamental', 'sentiment', 'technical']);
    });

    /**
     * The load-bearing assumption, pinned against the REAL personas: the id
     * `analystIds()` reports is the `analyst_id` the persona actually emits,
     * which is the key the debate log records and `accumulateCredit`
     * accumulates under. If a persona ever emitted a different `analyst_id`
     * than its `analyst_type`, the seeder would write a row under a key the
     * daily cycle never looks up — and `runDailyCycle` would silently go back
     * to skipping that analyst forever, which is the whole bug #371 closes.
     */
    it('reports the id each real persona emits its view under', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('stocks');
      const orchestrator = new AnalystOrchestrator({
        market_data: marketData,
        market_intelligence: marketIntelligence,
      });
      const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

      const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

      expect(result.failures).toEqual([]);
      expect(result.views.map((view) => view.analyst_id).sort()).toEqual(
        orchestrator.analystIds().sort(),
      );
    });
  });

  /**
   * #431, analysts-spec.md story 19: "retry a failing analyst exactly once with
   * a short timeout ... so that transient blips are absorbed without retry
   * storms." Before this the orchestrator gave each persona a single attempt
   * and no deadline at all, so one market-data hiccup forfeited the whole tick
   * and one hung request hung the stage forever.
   */
  describe('retry and timeout (#431)', () => {
    /** Fails its first `failures` attempts, then succeeds. Records the attempt count. */
    function flakyAnalyst(
      analyst_type: string,
      role: 'mandatory' | 'optional',
      failures: number,
    ): Analyst & { attempts: () => number } {
      let attempts = 0;
      return {
        analyst_type,
        role,
        applies_to: () => true,
        attempts: () => attempts,
        async run(input: AnalystInput): Promise<AnalystView> {
          attempts++;
          if (attempts <= failures) throw new Error(`${analyst_type} blip ${attempts}`);
          return {
            trace_id: input.trace_id,
            analyst_id: analyst_type,
            analyst_type,
            direction: 'bullish',
            confidence: 0.5,
            key_points: [],
            timestamp: input.clock.now(),
          };
        },
      };
    }

    /** Never settles — the failure mode a deadline exists for. */
    function hangingAnalyst(analyst_type: string, role: 'mandatory' | 'optional'): Analyst {
      return {
        analyst_type,
        role,
        applies_to: () => true,
        run: () => new Promise<AnalystView>(() => {}),
      };
    }

    it('absorbs a transient blip on the retry instead of forfeiting the tick', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const flaky = flakyAnalyst('technical', 'mandatory', 1);
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        [flaky],
      );

      const result = await orchestrator.runAnalysts(
        'trace-1',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(flaky.attempts()).toBe(2);
      expect(result.skipped).toBe(false);
      expect(result.failures).toEqual([]);
      expect(result.views).toHaveLength(1);
    });

    it('gives up after exactly one retry — no retry storm', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const flaky = flakyAnalyst('technical', 'mandatory', 99);
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        [flaky],
      );

      const result = await orchestrator.runAnalysts(
        'trace-1',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(flaky.attempts()).toBe(2);
      expect(result.skipped).toBe(true);
      expect(result.failures[0]?.reason).toContain('after 2 attempts');
    });

    it('bounds a persona that never answers, rather than hanging the stage', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        [hangingAnalyst('technical', 'mandatory')],
        { timeout_ms: 5 },
      );

      const result = await orchestrator.runAnalysts(
        'trace-1',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(result.skipped).toBe(true);
      // Story 20: one failure path, differing only in the logged reason.
      expect(result.failures[0]?.reason).toContain('did not answer within 5ms');
    });

    it('lets a healthy persona through unretried', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const healthy = flakyAnalyst('technical', 'mandatory', 0);
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        [healthy],
      );

      await orchestrator.runAnalysts(
        'trace-1',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(healthy.attempts()).toBe(1);
    });

    it('retries an optional persona too — the policy is uniform across roles', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const flaky = flakyAnalyst('sentiment', 'optional', 1);
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        [flaky],
      );

      const result = await orchestrator.runAnalysts(
        'trace-1',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(flaky.attempts()).toBe(2);
      expect(result.failures).toEqual([]);
    });
  });

  /**
   * #899 — analysts-spec.md ":202"/":319" claimed a SECOND, independent
   * ≥50%-of-3 quorum enforcer lives downstream in the Debate Engine
   * (`collectAnalystViews`, debate-engine/analyst-response-collector.ts).
   * That function has no production caller (a non-test grep of `server/` and
   * `client/` returns only its own definition and a re-export), so the role
   * gate exercised above is the ONLY production quorum enforcement. This
   * block pins exactly what that gate does and does not guarantee.
   */
  describe('quorum guarantee (#899): the role gate is the only production enforcement', () => {
    it('rejects a desk narrowed to a single live analyst before it can reach the debate', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('stocks');
      const personas = [
        stubAnalyst('technical', 'mandatory', 'fail'),
        stubAnalyst('fundamental', 'mandatory', 'succeed'),
        stubAnalyst('sentiment', 'optional', 'fail'),
      ];
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        personas,
      );
      const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

      const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

      // Only `fundamental` produced a view here — a single live analyst out
      // of 3 (33%), which analysts-spec.md says "is below quorum and must
      // not trade." Nothing computes 1/3 >= 0.5 to reach that conclusion:
      // `technical` is `mandatory` and failed, so the role gate wipes
      // `views` to `[]` regardless of what else succeeded
      // (orchestrator.ts:257-263). This is the whole guarantee — pinned
      // here because the count-based check in `collectAnalystViews` never
      // runs in production.
      expect(result.skipped).toBe(true);
      expect(result.views).toEqual([]);
      expect(result.analyst_count).toBe(3);
    });

    it('the only reachable partial desk is the optional dropout (2-of-3 = 67%), never a genuine <50% state', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('stocks');
      const personas = [
        stubAnalyst('technical', 'mandatory', 'succeed'),
        stubAnalyst('fundamental', 'mandatory', 'succeed'),
        stubAnalyst('sentiment', 'optional', 'fail'),
      ];
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        personas,
      );
      const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

      const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

      // With Technical + Fundamental mandatory and Sentiment the lone
      // optional slot, a mandatory failure always zeroes `views` entirely,
      // and the one persona allowed to fail alone without zeroing the desk
      // is the sole optional slot. So the only nonzero partial state the
      // role gate ever lets through is 2-of-3 — comfortably above 50%.
      expect(result.skipped).toBe(false);
      expect(result.views).toHaveLength(2);
      expect(result.views.length / result.analyst_count).toBeGreaterThanOrEqual(0.5);
    });

    it('FRAGILITY: a hypothetical demotion of Fundamental to optional would let a genuine 1-of-3 (33%) desk survive undetected', async () => {
      // NOT production config — Fundamental is `mandatory` today
      // (fundamental-analyst.ts:47). This documents the scope of the
      // guarantee above: it holds only because there is exactly ONE
      // optional slot out of three. If a second slot ever went optional
      // (Fundamental demoted, as simulated here, or a new persona added as
      // optional), two optional personas could fail together while the sole
      // remaining mandatory persona succeeds — and nothing would notice the
      // desk fell to 33%, because `collectAnalystViews`'s count check has no
      // production caller either.
      const { clock, marketData, marketIntelligence } = buildDeps('stocks');
      const personas = [
        stubAnalyst('technical', 'mandatory', 'succeed'),
        stubAnalyst('fundamental', 'optional', 'fail'), // hypothetical demotion, see comment above
        stubAnalyst('sentiment', 'optional', 'fail'),
      ];
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        personas,
      );
      const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

      const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

      // The role gate lets this through: no `mandatory` persona failed.
      expect(result.skipped).toBe(false);
      expect(result.views).toHaveLength(1);
      expect(result.analyst_count).toBe(3);
      // Genuine quorum miss (33% < 50%) that nothing in production catches.
      expect(result.views.length / result.analyst_count).toBeLessThan(0.5);
    });

    it('a hypothetical promotion of Sentiment to mandatory stays safe — it only makes the role gate stricter, never leakier', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('stocks');
      const personas = [
        stubAnalyst('technical', 'mandatory', 'succeed'),
        stubAnalyst('fundamental', 'mandatory', 'succeed'),
        stubAnalyst('sentiment', 'mandatory', 'fail'), // hypothetical promotion
      ];
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        personas,
      );
      const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

      const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

      // With every persona mandatory, any single failure zeroes the desk,
      // so the only reachable nonzero state is 3-of-3. Promoting a persona
      // to `mandatory` can only tighten the gate, never loosen it.
      expect(result.skipped).toBe(true);
      expect(result.views).toEqual([]);
    });
  });
});
