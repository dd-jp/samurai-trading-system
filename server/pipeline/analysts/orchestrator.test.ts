import type { Bar } from '../../providers/market-data-service/index.js';
import {
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import { type Clock, MAX_ERROR_BODY_CHARS } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { fundamentalAnalyst } from './fundamental-analyst.js';
import { AnalystOrchestrator } from './orchestrator.js';
import { sentimentAnalyst } from './sentiment-analyst.js';
import { technicalAnalyst } from './technical-analyst.js';
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
      // #1080: a thrown persona is a fault, not a deadline — the two are acted
      // on differently downstream, and the reason string is the only other
      // place the difference exists.
      kind: 'error',
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
        kind: 'error',
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
      // #1080: and in the kind, which is the discriminator a reader downstream
      // gets instead of having to match on the reason's wording. This is the
      // failure mode that starved the analyst stage in the 2026-09-03 session.
      expect(result.failures[0]?.kind).toBe('timeout');
    });

    it('reports a deadline as a timeout even when an earlier attempt threw', async () => {
      // The kind describes the attempt the stage GAVE UP on. A persona that
      // threw once and then hung is a stage waiting on a deadline it cannot
      // meet, which is acted on differently from a data gap.
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      let attempts = 0;
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        [
          {
            analyst_type: 'technical',
            role: 'mandatory',
            applies_to: () => true,
            run: async (): Promise<AnalystView> => {
              attempts += 1;
              if (attempts === 1) throw new Error('technical unavailable');
              return await new Promise<AnalystView>(() => {});
            },
          },
        ],
        { timeout_ms: 5 },
      );

      const result = await orchestrator.runAnalysts(
        'trace-1',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(attempts).toBe(2);
      expect(result.failures[0]?.kind).toBe('timeout');
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

    it('pins the real persona role assignment the guarantee above depends on — a silent demotion must fail this test, not just the doc', () => {
      // The FRAGILITY case above is only hypothetical because Fundamental is
      // `mandatory` today. This is the tripwire: if someone actually demotes
      // Fundamental (or promotes a second persona to optional), this
      // assertion fails immediately instead of the regression surviving
      // undetected — which is exactly the gap analysts-spec.md now warns
      // about (#899).
      expect(technicalAnalyst.role).toBe('mandatory');
      expect(fundamentalAnalyst.role).toBe('mandatory');
      expect(sentimentAnalyst.role).toBe('optional');
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

  /**
   * #1114: a soak's `stage=analysts level=error` line named a verdict
   * ("quorum NOT met... did not answer within 10000ms") but never the cause
   * — 40+ occurrences, 100% timeouts by tally, zero non-timeout rejections.
   * `withTimeout`'s `Promise.race` means the timeout branch fires while
   * `work` is still pending, so the cause literally does not exist at the
   * failure branch on that path — hence the late-settlement handler these
   * tests pin, plus the cheap non-timeout half the ticket also asks for.
   */
  describe('failure cause logging (#1114)', () => {
    /** Never settles on its own — the caller controls exactly when (and how) it finally does. */
    function controlledAnalyst(analyst_type: string): {
      analyst: Analyst;
      settlers: Array<(error: Error) => void>;
    } {
      const settlers: Array<(error: Error) => void> = [];
      const analyst: Analyst = {
        analyst_type,
        role: 'mandatory',
        applies_to: () => true,
        run: () =>
          new Promise<AnalystView>((_resolve, reject) => {
            settlers.push(reject);
          }),
      };
      return { analyst, settlers };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('logs a late rejection at debug, tagged with the attempt, without letting it reach quorum or views', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const { analyst, settlers } = controlledAnalyst('technical');
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      try {
        const orchestrator = new AnalystOrchestrator(
          { market_data: marketData, market_intelligence: marketIntelligence, logger },
          [analyst],
          { timeout_ms: 5 },
        );

        const resultPromise = orchestrator.runAnalysts(
          'trace-late',
          { asset: INSTRUMENT, asset_class: 'crypto' },
          clock,
          ASOF,
        );

        // Both attempts (ATTEMPTS_PER_PERSONA = 2) time out at 5ms each —
        // `controlledAnalyst` never resolves or rejects on its own.
        await vi.advanceTimersByTimeAsync(20);
        const result = await resultPromise;

        // Captured BEFORE the late rejection below fires — proves what
        // `runAnalysts` already decided, so a later mutation of that decision
        // by the late arrival would show up as a diff against these values.
        expect(result.skipped).toBe(true);
        expect(result.views).toEqual([]);
        expect(result.failures[0]?.kind).toBe('timeout');
        expect(settlers).toHaveLength(2);

        // The SECOND (last, abandoned) attempt's work finally rejects, long
        // after runAnalysts already returned.
        settlers[1]?.(new Error('late boom: connection reset'));
        await vi.advanceTimersByTimeAsync(0);

        // Invariant: logged, never applied. Same object, unchanged.
        expect(result.skipped).toBe(true);
        expect(result.views).toEqual([]);

        const late = logger.entries.find(
          (entry) =>
            entry.level === 'debug' &&
            (entry.payload as { attempt?: number } | undefined)?.attempt === 2,
        );
        expect(late).toBeDefined();
        expect(late?.trace_id).toBe('trace-late');
        expect(late?.stage).toBe('analysts');
        expect(late?.payload).toMatchObject({
          analyst_type: 'technical',
          attempt: 2,
          outcome: 'rejected',
          message: expect.stringContaining('late boom: connection reset'),
        });

        // No unhandled rejection escaped — `Promise.race` already handles
        // the losing side; the late-settlement observer above must not
        // change that.
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('does not log anything when the abandoned attempt never settles at all', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const { analyst } = controlledAnalyst('technical');
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [analyst],
        { timeout_ms: 5 },
      );

      const resultPromise = orchestrator.runAnalysts(
        'trace-hang',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );
      await vi.advanceTimersByTimeAsync(20);
      const result = await resultPromise;

      expect(result.skipped).toBe(true);
      expect(logger.entries.filter((entry) => entry.level === 'debug')).toEqual([]);
    });

    it('logs the underlying cause of a non-timeout rejection at debug, without changing the existing failure reason', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const cause = new Error('root cause: malformed payload');
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          throw new Error('technical unavailable', { cause });
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      const result = await orchestrator.runAnalysts(
        'trace-cause',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      // Unchanged existing behaviour: the reason/kind the adapter's
      // error/warn line reads are exactly what they were before #1114.
      expect(result.failures[0]?.kind).toBe('error');
      expect(result.failures[0]?.reason).toContain('technical unavailable (after 2 attempts)');

      const debugEntries = logger.entries.filter((entry) => entry.level === 'debug');
      expect(debugEntries).toHaveLength(2); // one per attempt — both attempts reject the same way
      for (const [index, entry] of debugEntries.entries()) {
        expect(entry.trace_id).toBe('trace-cause');
        expect(entry.stage).toBe('analysts');
        expect(entry.payload).toMatchObject({
          analyst_type: 'technical',
          attempt: index + 1,
          name: 'Error',
          message: expect.stringContaining('technical unavailable'),
          cause: expect.stringContaining('root cause: malformed payload'),
        });
      }
    });

    it('masks credentials and caps the stack — the widest text surface #1114 adds', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const cause = new Error('POST /v1/chat failed: Bearer sk-live-abcdef0123456789');
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          const error = new Error('technical unavailable', { cause });
          error.stack = `Error: technical unavailable\n${'    at frame (/app/x.js:1:1)\n'.repeat(60)}`;
          throw error;
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      await orchestrator.runAnalysts(
        'trace-secret',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      const payload = logger.entries.find((entry) => entry.level === 'debug')?.payload as
        | { cause?: string; stack?: string }
        | undefined;
      expect(payload?.cause).toContain('[REDACTED]');
      expect(payload?.cause).not.toContain('sk-live-abcdef0123456789');
      // A stack is thousands of chars of upstream-controlled text and is the
      // one field here never logged before #1114; the cap is what keeps a
      // debug line from carrying the whole frame list into the soak log.
      // `truncateForError` appends its own "chars total" note past the bound,
      // so the kept prefix is what MAX_ERROR_BODY_CHARS limits, not the whole
      // string.
      expect(payload?.stack).toContain('(truncated,');
      expect(payload?.stack?.split('… (truncated,')[0]?.length).toBeLessThanOrEqual(
        MAX_ERROR_BODY_CHARS,
      );
    });

    it('degrades only the field that cannot be rendered, keeping the rest of the cause', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          const error = new Error('technical unavailable');
          // A lazily-computed `stack` is real: several runtimes and error
          // wrappers define it as a getter. #1114 is what first put this
          // field in a log payload, so its throw is this diff's to contain.
          Object.defineProperty(error, 'stack', {
            get(): string {
              throw new Error('render boom');
            },
          });
          throw error;
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      const result = await orchestrator.runAnalysts(
        'trace-hostile',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(result.skipped).toBe(true);
      // The render happens while the payload is still being built, so a throw
      // here escapes `safeLog` entirely — and losing the whole payload would
      // cost the diagnostic the ticket exists to provide.
      expect(logger.entries.find((entry) => entry.level === 'debug')?.payload).toMatchObject({
        analyst_type: 'technical',
        message: 'technical unavailable',
        stack: '[unrenderable]',
      });
    });

    it('masks a credential-carrying error name', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          const error = new Error('technical unavailable');
          // `name` is upstream-settable like every other field here, and was
          // the one rendered raw.
          error.name = 'HttpError(auth=sk-live-abcdef0123456789)';
          throw error;
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      await orchestrator.runAnalysts(
        'trace-name',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      const name = (
        logger.entries.find((entry) => entry.level === 'debug')?.payload as
          | { name?: string }
          | undefined
      )?.name;
      expect(name).toContain('[REDACTED]');
      expect(name).not.toContain('sk-live-abcdef0123456789');
    });

    it('contains an unrenderable late settlement instead of rejecting a promise nobody holds', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const { analyst, settlers } = controlledAnalyst('technical');
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      try {
        const orchestrator = new AnalystOrchestrator(
          { market_data: marketData, market_intelligence: marketIntelligence, logger },
          [analyst],
          { timeout_ms: 5 },
        );

        const resultPromise = orchestrator.runAnalysts(
          'trace-late-hostile',
          { asset: INSTRUMENT, asset_class: 'crypto' },
          clock,
          ASOF,
        );
        await vi.advanceTimersByTimeAsync(20);
        await resultPromise;

        // The late path is the one where an escaping render is worst: it
        // rejects the derived `work.then(...)` promise, which nobody holds,
        // and Node 22 exits the process on an unhandled rejection.
        // Not an `Error`, and defeats both of `describeThrown`'s steps: the
        // self-reference makes `JSON.stringify` throw, and the throwing
        // `Symbol.toPrimitive` makes its `String(value)` fallback throw too.
        // That is the one render failure no per-field guard sits under.
        const hostile: Record<string, unknown> = {
          [Symbol.toPrimitive]() {
            throw new Error('render boom');
          },
        };
        hostile.self = hostile;
        settlers[1]?.(hostile as unknown as Error);
        await vi.advanceTimersByTimeAsync(0);

        expect(unhandled).not.toHaveBeenCalled();
        expect(
          logger.entries.find(
            (entry) =>
              entry.level === 'debug' &&
              (entry.payload as { attempt?: number } | undefined)?.attempt === 2,
          )?.payload,
        ).toMatchObject({ outcome: 'rejected', message: '[unrenderable error]' });
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('keeps the rest of a late cause when only its message cannot be rendered', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const { analyst, settlers } = controlledAnalyst('technical');
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [analyst],
        { timeout_ms: 5 },
      );

      const resultPromise = orchestrator.runAnalysts(
        'trace-late-message',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );
      await vi.advanceTimersByTimeAsync(20);
      await resultPromise;

      // The late path is the one where an escaping render is worst: it
      // rejects the derived `work.then(...)` promise that nobody holds
      // (see the hostile-`toString` test above) — the direct path below is
      // now guarded the same way `lastReason` is (#1199), so both reach this
      // render rather than one of them throwing first.
      const hostile = new Error('unused');
      hostile.name = 'LateBoomError';
      Object.defineProperty(hostile, 'message', {
        get(): string {
          throw new Error('render boom');
        },
      });
      settlers[1]?.(hostile);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        logger.entries.find(
          (entry) =>
            entry.level === 'debug' &&
            (entry.payload as { attempt?: number } | undefined)?.attempt === 2,
        )?.payload,
      ).toMatchObject({ name: 'LateBoomError', message: '[unrenderable]' });
    });

    it('never logs above debug — the existing error/warn posture is unchanged', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          throw new Error('technical unavailable');
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      await orchestrator.runAnalysts(
        'trace-level',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(logger.entries.every((entry) => entry.level === 'debug')).toBe(true);
    });

    it('a throwing logger does not turn an analyst failure into a crash', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const throwingLogger = {
        log(): void {
          throw new Error('logger transport is down');
        },
      };
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          throw new Error('technical unavailable');
        },
      };
      const orchestrator = new AnalystOrchestrator(
        {
          market_data: marketData,
          market_intelligence: marketIntelligence,
          logger: throwingLogger,
        },
        [failing],
      );

      await expect(
        orchestrator.runAnalysts(
          'trace-throwing-logger',
          { asset: INSTRUMENT, asset_class: 'crypto' },
          clock,
          ASOF,
        ),
      ).resolves.toMatchObject({ skipped: true });
    });

    it('a throwing message getter on a direct rejection does not turn the tick itself into a failure (#1199)', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          const error = new Error('unused');
          // Same construction as the late-settlement `message`-getter test
          // above, but thrown on the DIRECT (non-timeout) path: the catch
          // site this closes reads `error.message` for `lastReason` before
          // any of `renderErrorDetail`'s guards are reached.
          Object.defineProperty(error, 'message', {
            get(): string {
              throw new Error('render boom');
            },
          });
          throw error;
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      // Before the fix, `error.message` throws inside the catch handling
      // the analyst failure, which escapes the `Promise.all` in `runAnalysts`
      // and rejects this promise instead of resolving with a recorded
      // failure.
      const result = await orchestrator.runAnalysts(
        'trace-hostile-message-direct',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(result.skipped).toBe(true);
      expect(result.failures[0]?.reason).toContain('[unrenderable error]');
      // The direct path now reaches `renderErrorDetail`'s own per-field guard
      // too (renderField, line ~160) — same hostile `message` getter, guarded
      // independently for the debug payload it builds. Qualified by
      // `attempt === 1`, matching the late-settlement tests' `attempt === 2`
      // qualifier above, rather than taking whichever debug line comes first.
      expect(
        logger.entries.find(
          (entry) =>
            entry.level === 'debug' &&
            (entry.payload as { attempt?: number } | undefined)?.attempt === 1,
        )?.payload,
      ).toMatchObject({ name: 'Error', message: '[unrenderable]' });
    });

    it('a hostile thrown value with no usable String() form does not turn the tick itself into a failure (#1199)', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      // Not an `Error`, so the catch site's other branch — `String(error)` —
      // is the one under test. Circular (defeats `JSON.stringify`) AND a
      // throwing `Symbol.toPrimitive` (defeats the `String()` fallback too):
      // the same combination the late-settlement test above uses to defeat
      // `describeThrown` itself, applied here to the direct-rejection catch.
      const hostile: Record<string, unknown> = {
        [Symbol.toPrimitive]() {
          throw new Error('render boom');
        },
      };
      hostile.self = hostile;
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          throw hostile;
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      const result = await orchestrator.runAnalysts(
        'trace-hostile-tostring-direct',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(result.skipped).toBe(true);
      expect(result.failures[0]?.reason).toContain('[unrenderable error]');
    });

    it('an Error whose message getter returns a value describeThrown cannot render either still resolves with the placeholder', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      // `describeThrown` (safe-log.ts) now runs a non-string `message`
      // through its own JSON.stringify/String ladder rather than returning
      // it verbatim, but that ladder is not total: this value is circular
      // (defeats `JSON.stringify`) AND has a throwing `Symbol.toPrimitive`
      // (defeats the `String()` fallback too) — the same double-failure
      // shape as the hostile-thrown-value test above, here as the VALUE of
      // `message` on a genuine `Error` rather than as the thrown value
      // itself. Before `describeThrown` was hardened to coerce a non-string
      // `message`, this escaped even further downstream — building
      // `AnalystFailure.reason`'s template literal outside any guard.
      const hostileMessage: Record<string, unknown> = {
        [Symbol.toPrimitive]() {
          throw new Error('render boom');
        },
      };
      hostileMessage.self = hostileMessage;
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          const error = new Error('unused');
          Object.defineProperty(error, 'message', { get: () => hostileMessage });
          throw error;
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      const result = await orchestrator.runAnalysts(
        'trace-hostile-message-value',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(result.skipped).toBe(true);
      expect(result.failures[0]?.reason).toContain('[unrenderable error]');
    });

    // Pins a real, deliberate behavior change from routing `lastReason`
    // through `describeThrown` (#1199 review): a non-`Error` throw used to
    // record `String(error)` (`"[object Object]"` for a plain object) and
    // now records `describeThrown`'s `JSON.stringify` result instead — an
    // improvement (the actual fields survive), not a guard side effect.
    // Nothing parses `AnalystFailure.reason` programmatically downstream
    // (`analysts-adapter.ts` only logs/masks it), so this is safe to pin as
    // the new, intended text rather than an incidental one.
    it('records JSON.stringify of a plain non-Error throw, not "[object Object]"', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const logger = recordingLogger();
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          throw { code: 'ECONNRESET' };
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence, logger },
        [failing],
      );

      const result = await orchestrator.runAnalysts(
        'trace-plain-object-reason',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(result.failures[0]?.reason).toContain('{"code":"ECONNRESET"}');
      expect(result.failures[0]?.reason).not.toContain('[object Object]');
    });

    it('omitting the logger dependency entirely does not crash — the safe default is silence', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('crypto');
      const failing: Analyst = {
        analyst_type: 'technical',
        role: 'mandatory',
        applies_to: () => true,
        run: async () => {
          throw new Error('technical unavailable');
        },
      };
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        [failing],
      );

      await expect(
        orchestrator.runAnalysts(
          'trace-no-logger',
          { asset: INSTRUMENT, asset_class: 'crypto' },
          clock,
          ASOF,
        ),
      ).resolves.toMatchObject({ skipped: true });
    });
  });
});
