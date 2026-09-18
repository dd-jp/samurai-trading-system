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
      reason: 'technical unavailable (after 2 attempts)',
      kind: 'other',
    });

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
        kind: 'other',
      },
    ]);
  });

  describe('analystIds', () => {
    it('names every persona the default orchestrator builds', () => {
      const { marketData, marketIntelligence } = buildDeps('stocks');
      const orchestrator = new AnalystOrchestrator({
        market_data: marketData,
        market_intelligence: marketIntelligence,
      });

      expect(orchestrator.analystIds().sort()).toEqual(['fundamental', 'sentiment', 'technical']);
    });

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

  describe('retry and timeout (#431)', () => {
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
      expect(result.failures[0]?.reason).toContain('did not answer within 5ms');
      expect(result.failures[0]?.kind).toBe('timeout');
    });

    it('reports a deadline as a timeout even when an earlier attempt threw', async () => {
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

      expect(result.skipped).toBe(false);
      expect(result.views).toHaveLength(2);
      expect(result.views.length / result.analyst_count).toBeGreaterThanOrEqual(0.5);
    });

    it('FRAGILITY: a hypothetical demotion of Fundamental to optional would let a genuine 1-of-3 (33%) desk survive undetected', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('stocks');
      const personas = [
        stubAnalyst('technical', 'mandatory', 'succeed'),
        stubAnalyst('fundamental', 'optional', 'fail'),
        stubAnalyst('sentiment', 'optional', 'fail'),
      ];
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        personas,
      );
      const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

      const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

      expect(result.skipped).toBe(false);
      expect(result.views).toHaveLength(1);
      expect(result.analyst_count).toBe(3);
      expect(result.views.length / result.analyst_count).toBeLessThan(0.5);
    });

    it('pins the real persona role assignment the guarantee above depends on — a silent demotion must fail this test, not just the doc', () => {
      expect(technicalAnalyst.role).toBe('mandatory');
      expect(fundamentalAnalyst.role).toBe('mandatory');
      expect(sentimentAnalyst.role).toBe('optional');
    });

    it('a hypothetical promotion of Sentiment to mandatory stays safe — it only makes the role gate stricter, never leakier', async () => {
      const { clock, marketData, marketIntelligence } = buildDeps('stocks');
      const personas = [
        stubAnalyst('technical', 'mandatory', 'succeed'),
        stubAnalyst('fundamental', 'mandatory', 'succeed'),
        stubAnalyst('sentiment', 'mandatory', 'fail'),
      ];
      const orchestrator = new AnalystOrchestrator(
        { market_data: marketData, market_intelligence: marketIntelligence },
        personas,
      );
      const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

      const result = await orchestrator.runAnalysts('trace-1', signal, clock, ASOF);

      expect(result.skipped).toBe(true);
      expect(result.views).toEqual([]);
    });
  });

  describe('failure cause logging (#1114)', () => {
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

        await vi.advanceTimersByTimeAsync(20);
        const result = await resultPromise;

        expect(result.skipped).toBe(true);
        expect(result.views).toEqual([]);
        expect(result.failures[0]?.kind).toBe('timeout');
        expect(settlers).toHaveLength(2);

        settlers[1]?.(new Error('late boom: connection reset'));
        await vi.advanceTimersByTimeAsync(0);

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

      expect(result.failures[0]?.kind).toBe('other');
      expect(result.failures[0]?.reason).toContain('technical unavailable (after 2 attempts)');

      const debugEntries = logger.entries.filter((entry) => entry.level === 'debug');
      expect(debugEntries).toHaveLength(2);
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

      const result = await orchestrator.runAnalysts(
        'trace-hostile-message-direct',
        { asset: INSTRUMENT, asset_class: 'crypto' },
        clock,
        ASOF,
      );

      expect(result.skipped).toBe(true);
      expect(result.failures[0]?.reason).toContain('[unrenderable error]');
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
