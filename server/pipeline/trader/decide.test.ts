import {
  AlwaysOpenCalendar,
  type Bar,
  type BarWindow,
  collectMarks,
  type IndicatorKind,
  type IndicatorSpec,
  type IndicatorValue,
  InsufficientBarsError,
  LseRegularHoursCalendar,
  type Mark,
  type MarketDataService,
  type MarkRead,
  minimumBarsFor,
  recommendedWarmupFor,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock, OpenPosition } from '../../shared/index.js';
import { MACD_SPEC, RSI_SPEC } from '../analysts/technical-analyst.js';
import type { DebateResult } from '../debate-engine/index.js';
import { MarkReadError, StaleMarkError } from '../risk-manager/index.js';
import {
  atrIndicatorSpec,
  checkExitsWithReason,
  decide,
  decideWithReason,
  type ExitCheckInput,
} from './decide.js';
import { FixtureSetupStore } from './fixture-setup-store.js';
import { computeFlattenIdempotencyKey, computeIdempotencyKey } from './idempotency-key.js';
import type { AssetClass, TraderConfig, TraderInput } from './types.js';
import { DEFAULT_TRADER_CONFIG } from './types.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }

  set(time: Date): void {
    this.time = time;
  }
}

const INSTRUMENT = 'AAPL';
const DECISION_BAR = new Date('2026-07-15T10:00:00Z');
const NEXT_BAR = new Date('2026-07-15T11:00:00Z');
const ENTRY_PRICE = 100;
const EQUITY = 100_000;

function bars(count: number, trueRange: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const closeTime = new Date(DECISION_BAR.getTime() - (count - 1 - i) * 60 * 60 * 1000);
    return {
      instrument: INSTRUMENT,
      timeframe: '1h',
      open_time: new Date(closeTime.getTime() - 60 * 60 * 1000),
      close_time: closeTime,
      open: ENTRY_PRICE,
      high: ENTRY_PRICE + trueRange / 2,
      low: ENTRY_PRICE - trueRange / 2,
      close: ENTRY_PRICE,
      volume: 1,
      source: 'fixture',
    };
  });
}

class FixtureMarketData implements MarketDataService {
  requestedWindow: BarWindow | undefined;

  markObservedAt: Date = DECISION_BAR;

  constructor(
    private readonly fixtureBars: Bar[],
    private readonly assetClass: AssetClass = 'stocks',
    private readonly price: number = ENTRY_PRICE,
  ) {}

  async getBars(_instrument: string, window: BarWindow, _asOf: Date): Promise<Bar[]> {
    this.requestedWindow = window;
    return this.fixtureBars;
  }

  async getMark(_instrument: string, _asOf: Date): Promise<Mark> {
    return {
      price: this.price,
      observed_at: this.markObservedAt,
      source: 'fixture',
      asset_class: this.assetClass,
    };
  }

  async getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
  }

  indicatorReads = new Map<IndicatorKind, number | Error>();

  async getIndicator(
    _instrument: string,
    spec: IndicatorSpec,
    _asOf: Date,
  ): Promise<IndicatorValue> {
    if (spec.indicator === 'atr') {
      throw new Error('FixtureMarketData.getIndicator: decide must compute ATR from getBars');
    }
    const configured = this.indicatorReads.get(spec.indicator);
    if (configured === undefined) {
      throw new Error(
        `FixtureMarketData.getIndicator: no fixture value configured for '${spec.indicator}'`,
      );
    }
    if (configured instanceof Error) throw configured;
    return { indicator: spec.indicator, value: configured, as_of_bar_close: DECISION_BAR };
  }

  async getSpreadEstimate(): Promise<number | null> {
    throw new Error('FixtureMarketData.getSpreadEstimate: not part of the Trader path');
  }

  async getQuote(): Promise<null> {
    throw new Error('FixtureMarketData.getQuote: not part of the Trader path');
  }

  async getADV(): Promise<number> {
    throw new Error('FixtureMarketData.getADV: not part of the Trader path');
  }
}

function debateResult(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'Analysts converge on upside momentum.',
    position: 'Enter long.',
    confidence: 0.775,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 9_000,
    direction: 'bullish',
    debate_id: 'debate-abc123',
    bar_timestamp: DECISION_BAR,
    read: true,
    ...overrides,
  };
}

function traderInput(overrides: Partial<TraderInput> = {}): TraderInput {
  return {
    trace_id: 'trace-1',
    instrument: INSTRUMENT,
    debate: debateResult(),
    clock: new ManualClock(DECISION_BAR),
    marketData: new FixtureMarketData(bars(15, 2)),
    equity: async () => EQUITY,
    config: DEFAULT_TRADER_CONFIG,
    positionState: async () => [],
    exitFillSizes: async () => new Map<string, number>(),
    unresolvedFlattens: async () => [],
    setupStore: new FixtureSetupStore(),
    sessionCalendars: {
      crypto: new AlwaysOpenCalendar(),
      stocks: new UsEquityRegularHoursCalendar(),
    },
    ...overrides,
  };
}

function configWith(overrides: Partial<TraderConfig>): TraderConfig {
  return { ...DEFAULT_TRADER_CONFIG, ...overrides };
}

function openPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'existing-key',
    debate_id: 'debate-existing',
    instrument: INSTRUMENT,
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 50,
    filled_size: 50,
    avg_entry_price: ENTRY_PRICE,
    stop: 96,
    target: 108,
    order_state: 'filled',
    broker_order_ids: ['broker-1'],
    opened_at: new Date('2026-07-14T10:00:00Z'),
    decision_timestamp: new Date('2026-07-14T10:00:00Z'),
    conviction: 0.6,
    converged: true,
    ...overrides,
  };
}

const EXPECTED_STOP_DISTANCE = 4;
const EXPECTED_SIZE = 93.75;

describe('decide — entry bracket', () => {
  it('generates a full bracket with entry, stop, and target for a qualifying debate', async () => {
    const intent = await decide(traderInput());

    expect(intent).not.toBeNull();
    expect(intent?.instrument).toBe(INSTRUMENT);
    expect(intent?.asset_class).toBe('stocks');
    expect(intent?.side).toBe('buy');
    expect(intent?.intent_type).toBe('entry');
    expect(intent?.entry).toBe(ENTRY_PRICE);
    expect(intent?.stop).toBe(ENTRY_PRICE - EXPECTED_STOP_DISTANCE);
    expect(intent?.target).toBe(ENTRY_PRICE + 2 * EXPECTED_STOP_DISTANCE);
    expect(intent?.size).toBeCloseTo(EXPECTED_SIZE, 10);
    expect(intent?.time_in_force).toBe(DEFAULT_TRADER_CONFIG.time_in_force.stocks);
    expect(intent?.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mirrors the bracket for a bearish debate — stop above entry, target below', async () => {
    const input = traderInput({ debate: debateResult({ direction: 'bearish' }) });

    const intent = await decide(input);

    expect(intent?.side).toBe('sell');
    expect(intent?.stop).toBe(ENTRY_PRICE + EXPECTED_STOP_DISTANCE);
    expect(intent?.target).toBe(ENTRY_PRICE - 2 * EXPECTED_STOP_DISTANCE);
    expect(intent?.size).toBeCloseTo(EXPECTED_SIZE, 10);
  });

  it('carries debate_id, conviction, and converged through to the intent metadata', async () => {
    const debate = debateResult({ debate_id: 'debate-xyz789', confidence: 0.9 });

    const intent = await decide(traderInput({ debate }));

    expect(intent?.metadata.debate_id).toBe('debate-xyz789');
    expect(intent?.metadata.conviction).toBe(0.9);
    expect(intent?.metadata.converged).toBe(true);
  });

  it('flags no precedent and applies the 0.75 default until cosine retrieval lands (#75)', async () => {
    const intent = await decide(traderInput());

    expect(intent?.metadata.cosine_precedent).toEqual({
      neighbor_count: 0,
      weighted_mean_r: null,
      no_precedent: true,
    });
    expect(intent?.metadata.sizing.cosine_multiplier).toBe(0.75);
  });

  it('records a sizing decomposition that reproduces the emitted size', async () => {
    const intent = await decide(traderInput());
    const sizing = intent?.metadata.sizing;
    if (!intent || !sizing) throw new Error('expected an intent');

    const riskFraction =
      sizing.base_risk_fraction * sizing.non_converged_haircut * sizing.cosine_multiplier;
    const stopDistance = Math.abs(intent.entry - intent.stop);

    expect((EQUITY * riskFraction) / stopDistance).toBeCloseTo(intent.size, 10);
  });
});

describe('decide — conviction scaling', () => {
  it('scales size linearly with conviction above the floor', async () => {
    const sizeAt = async (confidence: number) =>
      (await decide(traderInput({ debate: debateResult({ confidence }) })))?.size;

    const low = await sizeAt(0.6625);
    const mid = await sizeAt(0.775);
    const high = await sizeAt(1.0);

    if (low === undefined || mid === undefined || high === undefined) {
      throw new Error('expected intents at every conviction above the floor');
    }
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(mid).toBeCloseTo(2 * low, 10);
    expect(high).toBeCloseTo(4 * low, 10);
  });

  it('never risks more than max_risk_per_trade, even at maximum conviction', async () => {
    const intent = await decide(traderInput({ debate: debateResult({ confidence: 1.0 }) }));
    if (!intent) throw new Error('expected an intent');

    const riskedFraction = (intent.size * Math.abs(intent.entry - intent.stop)) / EQUITY;

    expect(riskedFraction).toBeLessThanOrEqual(DEFAULT_TRADER_CONFIG.max_risk_per_trade);
  });
});

describe('decide — asset-class risk scaling', () => {
  it('sizes crypto more conservatively than stocks at equal conviction', async () => {
    const stocks = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(15, 2), 'stocks') }),
    );
    const crypto = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(15, 2), 'crypto') }),
    );
    if (!stocks || !crypto) throw new Error('expected an intent for both asset classes');

    expect(crypto.asset_class).toBe('crypto');
    expect(crypto.size).toBeLessThan(stocks.size);
    expect(Math.abs(crypto.entry - crypto.stop)).toBe(Math.abs(stocks.entry - stocks.stop));
  });
});

describe('decide — per-asset-class time in force', () => {
  it('stamps an equity intent with the equities value', async () => {
    const intent = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(15, 2), 'stocks') }),
    );

    expect(intent?.time_in_force).toBe('day');
  });

  it("stamps a crypto intent with a value Alpaca's crypto venue accepts", async () => {
    const intent = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(15, 2), 'crypto') }),
    );

    expect(intent?.time_in_force).toBe('gtc');
    expect(intent?.time_in_force).not.toBe('day');
  });

  it('reads the value off the intent asset class, not a fixed field', async () => {
    const config = configWith({ time_in_force: { crypto: 'day', stocks: 'gtc' } });
    const stocks = await decide(
      traderInput({ config, marketData: new FixtureMarketData(bars(15, 2), 'stocks') }),
    );
    const crypto = await decide(
      traderInput({ config, marketData: new FixtureMarketData(bars(15, 2), 'crypto') }),
    );

    expect(stocks?.time_in_force).toBe('gtc');
    expect(crypto?.time_in_force).toBe('day');
  });
});

describe('decide — volatility', () => {
  it('sizes smaller as volatility rises, for the same conviction', async () => {
    const calm = await decide(traderInput({ marketData: new FixtureMarketData(bars(15, 2)) }));
    const wild = await decide(traderInput({ marketData: new FixtureMarketData(bars(15, 8)) }));
    if (!calm || !wild) throw new Error('expected an intent in both regimes');

    expect(wild.size).toBeLessThan(calm.size);
    expect(Math.abs(wild.entry - wild.stop)).toBeGreaterThan(Math.abs(calm.entry - calm.stop));
  });

  it('bounds the stop by the volatility floor when ATR is ultra-low', async () => {
    const intent = await decide(traderInput({ marketData: new FixtureMarketData(bars(15, 0.02)) }));
    if (!intent) throw new Error('expected an intent');

    expect(Math.abs(intent.entry - intent.stop)).toBeCloseTo(0.4, 10);
    expect(intent.metadata.sizing.vol_floor_factor).toBeCloseTo(10, 10);
  });

  it('records a vol_floor_factor of 1 when ATR governs the stop', async () => {
    const intent = await decide(traderInput());

    expect(intent?.metadata.sizing.vol_floor_factor).toBe(1);
  });
});

describe('decide — ATR bar window (#304, #757)', () => {
  it('fetches the CONVERGED ATR width, not the atr_lookback + 1 arity floor (#757)', async () => {
    const marketData = new FixtureMarketData(bars(15, 2));

    await decide(traderInput({ marketData, config: configWith({ atr_lookback: 7 }) }));

    expect(marketData.requestedWindow?.lookback).toBe(
      recommendedWarmupFor(atrIndicatorSpec(7, DEFAULT_TRADER_CONFIG.atr_timeframe)),
    );
    expect(marketData.requestedWindow?.lookback).toBe(29);
  });

  it('fails loudly if getBars serves a descending window, rather than mispricing the stop', async () => {
    const descending = [...bars(15, 2)].reverse();

    await expect(
      decide(traderInput({ marketData: new FixtureMarketData(descending) })),
    ).rejects.toThrow(/ascending by close_time/);
  });

  it('fetches on config.atr_timeframe, not the indicator default', async () => {
    const marketData = new FixtureMarketData(bars(15, 2));

    await decide(traderInput({ marketData, config: configWith({ atr_timeframe: '15m' }) }));

    expect(marketData.requestedWindow?.timeframe).toBe('15m');
  });
});

describe('decide — non-convergence haircut', () => {
  it('halves size when the debate did not converge, and records the haircut', async () => {
    const converged = await decide(traderInput());
    const notConverged = await decide(
      traderInput({ debate: debateResult({ converged: false, open_items: ['unresolved'] }) }),
    );
    if (!converged || !notConverged) throw new Error('expected an intent in both cases');

    expect(notConverged.size).toBeCloseTo(converged.size * 0.5, 10);
    expect(notConverged.metadata.sizing.non_converged_haircut).toBe(0.5);
    expect(converged.metadata.sizing.non_converged_haircut).toBe(1);
  });
});

describe('decide — skip paths', () => {
  it('returns null when conviction is below the floor', async () => {
    const belowFloor = DEFAULT_TRADER_CONFIG.conviction_floor - 0.01;

    const intent = await decide(traderInput({ debate: debateResult({ confidence: belowFloor }) }));

    expect(intent).toBeNull();
  });

  it('returns null for a neutral debate — no directional edge to act on', async () => {
    const intent = await decide(traderInput({ debate: debateResult({ direction: 'neutral' }) }));

    expect(intent).toBeNull();
  });

  it('returns null rather than placing a dust order below the minimum viable notional', async () => {
    const intent = await decide(traderInput({ equity: async () => 100 }));

    expect(intent).toBeNull();
  });

  it('returns null when there is not enough history to compute ATR', async () => {
    const intent = await decide(traderInput({ marketData: new FixtureMarketData(bars(1, 2)) }));

    expect(intent).toBeNull();
  });

  it('returns null on an empty bar window rather than sizing off NaN', async () => {
    const intent = await decide(traderInput({ marketData: new FixtureMarketData(bars(0, 2)) }));

    expect(intent).toBeNull();
  });

  it('returns null when the computed ATR is not finite, rather than sizing off NaN', async () => {
    const corrupt = bars(15, 2);
    // biome-ignore lint/style/noNonNullAssertion: fixed-length fixture built two lines above.
    corrupt[7]!.high = Number.NaN;

    const intent = await decide(traderInput({ marketData: new FixtureMarketData(corrupt) }));

    expect(intent).toBeNull();
  });

  it('returns null when the mark price is not finite, rather than pricing off NaN', async () => {
    const intent = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(15, 2), 'stocks', Number.NaN) }),
    );

    expect(intent).toBeNull();
  });

  it('returns null when equity is not finite, rather than sizing off NaN', async () => {
    const intent = await decide(traderInput({ equity: async () => Number.NaN }));

    expect(intent).toBeNull();
  });

  it('skips one bar short of the ATR width and trades at exactly that width (#319)', async () => {
    const { atr_lookback } = DEFAULT_TRADER_CONFIG;

    const oneShort = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(atr_lookback, 2)) }),
    );
    const exact = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(atr_lookback + 1, 2)) }),
    );

    expect(oneShort).toBeNull();
    expect(exact).toEqual(await decide(traderInput()));
  });
});

describe('decide — determinism & idempotency', () => {
  it('produces an identical intent and key for identical input', async () => {
    const first = await decide(traderInput());
    const second = await decide(traderInput());

    expect(first).toEqual(second);
  });

  it('keys on the decision bar, not wall-clock, so a re-run of the same bar dedupes', async () => {
    const first = await decide(traderInput({ clock: new ManualClock(DECISION_BAR) }));
    const rerun = await decide(
      traderInput({ clock: new ManualClock(new Date('2026-07-15T10:42:31Z')) }),
    );

    expect(rerun?.idempotency_key).toBe(first?.idempotency_key);
    expect(rerun?.decision_timestamp).toEqual(DECISION_BAR);
  });

  it('gives different instruments different keys on the same bar', async () => {
    const aapl = await decide(traderInput({ instrument: 'AAPL' }));
    const tsla = await decide(traderInput({ instrument: 'TSLA' }));

    expect(aapl?.idempotency_key).not.toBe(tsla?.idempotency_key);
  });

  it('keys identically across two live ticks in one bar, despite moving quote timestamps', async () => {
    const tickOne = new FixtureMarketData(bars(15, 2));
    tickOne.markObservedAt = new Date('2026-07-15T10:00:03.187Z');

    const tickTwo = new FixtureMarketData(bars(15, 2));
    tickTwo.markObservedAt = new Date('2026-07-15T10:45:11.902Z');

    const first = await decide(
      traderInput({
        marketData: tickOne,
        clock: new ManualClock(new Date('2026-07-15T10:00:03.187Z')),
      }),
    );
    const sameBarLater = await decide(
      traderInput({
        marketData: tickTwo,
        clock: new ManualClock(new Date('2026-07-15T10:45:11.902Z')),
      }),
    );

    expect(first?.idempotency_key).toBeDefined();
    expect(sameBarLater?.idempotency_key).toBe(first?.idempotency_key);
    expect(sameBarLater?.decision_timestamp).toEqual(DECISION_BAR);

    expect(first?.decided_at).toEqual(new Date('2026-07-15T10:00:03.187Z'));
    expect(sameBarLater?.decided_at).toEqual(new Date('2026-07-15T10:45:11.902Z'));
    expect(sameBarLater?.decided_at).not.toEqual(first?.decided_at);
  });

  it('keys an exit identically across two live ticks in one bar', async () => {
    const position = openPosition({ side: 'buy', filled_size: 10 });
    const debate = debateResult({ direction: 'bearish', confidence: 0.9, converged: true });

    const tickOne = new FixtureMarketData(bars(15, 2));
    tickOne.markObservedAt = new Date('2026-07-15T10:00:03.187Z');
    const tickTwo = new FixtureMarketData(bars(15, 2));
    tickTwo.markObservedAt = new Date('2026-07-15T10:45:11.902Z');

    const first = await decide(
      traderInput({
        debate,
        positionState: async () => [position],
        marketData: tickOne,
        clock: new ManualClock(new Date('2026-07-15T10:00:03.187Z')),
      }),
    );
    const sameBarLater = await decide(
      traderInput({
        debate,
        positionState: async () => [position],
        marketData: tickTwo,
        clock: new ManualClock(new Date('2026-07-15T10:45:11.902Z')),
      }),
    );

    expect(first?.intent_type).toBe('exit');
    expect(sameBarLater?.intent_type).toBe('exit');
    expect(first?.idempotency_key).toBeDefined();
    expect(sameBarLater?.idempotency_key).toBe(first?.idempotency_key);
    expect(sameBarLater?.decision_timestamp).toEqual(DECISION_BAR);

    expect(first?.decided_at).toEqual(new Date('2026-07-15T10:00:03.187Z'));
    expect(sameBarLater?.decided_at).toEqual(new Date('2026-07-15T10:45:11.902Z'));
  });

  it('still separates two different bars', async () => {
    const nextBar = new FixtureMarketData(bars(15, 2));
    nextBar.markObservedAt = new Date('2026-07-15T11:03:00Z');

    const first = await decide(traderInput());
    const next = await decide(
      traderInput({
        debate: debateResult({
          debate_id: 'debate-next-bar',
          bar_timestamp: NEXT_BAR,
        }),
        marketData: nextBar,
        clock: new ManualClock(new Date('2026-07-15T11:03:00Z')),
      }),
    );

    expect(next?.idempotency_key).not.toBe(first?.idempotency_key);
    expect(next?.decision_timestamp).toEqual(NEXT_BAR);
  });

  it('#687: keys a straddling debate to the debate bar, not the bar the Trader ran in', async () => {
    const lateTick = new FixtureMarketData(bars(15, 2));
    lateTick.markObservedAt = new Date('2026-07-15T11:07:42.310Z');

    const straddled = await decide(
      traderInput({
        debate: debateResult({ bar_timestamp: DECISION_BAR }),
        marketData: lateTick,
        clock: new ManualClock(new Date('2026-07-15T11:07:42.310Z')),
      }),
    );

    expect(straddled?.idempotency_key).toBe(
      computeIdempotencyKey(INSTRUMENT, DECISION_BAR, 'open'),
    );
    expect(straddled?.decision_timestamp).toEqual(DECISION_BAR);
  });

  it('#687: keys a straddling exit to the debate bar too', async () => {
    const lateTick = new FixtureMarketData(bars(15, 2));
    lateTick.markObservedAt = new Date('2026-07-15T11:07:42.310Z');

    const straddled = await decide(
      traderInput({
        debate: debateResult({
          direction: 'bearish',
          confidence: 0.9,
          bar_timestamp: DECISION_BAR,
        }),
        positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
        marketData: lateTick,
        clock: new ManualClock(new Date('2026-07-15T11:07:42.310Z')),
      }),
    );

    expect(straddled?.intent_type).toBe('exit');
    expect(straddled?.idempotency_key).toBe(
      computeIdempotencyKey(INSTRUMENT, DECISION_BAR, 'close'),
    );
    expect(straddled?.decision_timestamp).toEqual(DECISION_BAR);
  });

  it('#687: bar N+1s own genuine decision is still admitted after a straddle', async () => {
    const straddled = await decide(
      traderInput({
        debate: debateResult({ bar_timestamp: DECISION_BAR }),
        clock: new ManualClock(new Date('2026-07-15T11:07:42.310Z')),
      }),
    );
    const genuineNextBar = await decide(
      traderInput({
        debate: debateResult({ debate_id: 'debate-next-bar', bar_timestamp: NEXT_BAR }),
        clock: new ManualClock(new Date('2026-07-15T11:12:00Z')),
      }),
    );

    expect(genuineNextBar?.idempotency_key).not.toBe(straddled?.idempotency_key);
    expect(genuineNextBar?.idempotency_key).toBe(
      computeIdempotencyKey(INSTRUMENT, NEXT_BAR, 'open'),
    );
  });

  it('#687: a true duplicate of the same bar still computes one key', async () => {
    const replayed = new FixtureMarketData(bars(15, 2));
    replayed.markObservedAt = new Date('2026-07-15T10:58:03.941Z');

    const first = await decide(traderInput());
    const replay = await decide(
      traderInput({
        debate: debateResult({ bar_timestamp: DECISION_BAR }),
        marketData: replayed,
        clock: new ManualClock(new Date('2026-07-15T10:58:03.941Z')),
      }),
    );

    expect(replay?.idempotency_key).toBe(first?.idempotency_key);
    expect(replay?.idempotency_key).toBe(computeIdempotencyKey(INSTRUMENT, DECISION_BAR, 'open'));
  });

  it('keys on the debate bar grid, not on atr_timeframe', async () => {
    const fine = await decide(traderInput({ config: configWith({ atr_timeframe: '15m' }) }));
    const coarse = await decide(traderInput());

    expect(fine?.decision_timestamp).toEqual(DECISION_BAR);
    expect(fine?.decision_timestamp).toEqual(coarse?.decision_timestamp);
  });
});

describe('decide — flat by close (#668)', () => {
  const CLOSE = new Date('2026-07-15T20:00:00Z');
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');
  const OUTSIDE_WINDOW = new Date('2026-07-15T19:50:00Z');

  function holding(overrides: Partial<OpenPosition> = {}): OpenPosition {
    return openPosition({ side: 'buy', filled_size: 10, ...overrides });
  }

  it('flattens a held position inside the window', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        positionState: async () => [holding()],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.side).toBe('sell');
  });

  it('produces no flatten while this arm holds an unresolved flatten for the instrument, on the decision path', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        positionState: async () => [holding()],
        unresolvedFlattens: async () => [{ instrument: INSTRUMENT }],
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('flatten_in_flight');
  });

  it('flattens even when the debate is neutral — the commonest branch must not suppress it', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
      }),
    );

    expect(outcome.skip_reason).not.toBe('holding_neutral_or_non_converged');
    expect(outcome.intent?.intent_type).toBe('exit');
  });

  it('flattens a non-converged debate too — ADR-0013 leaves no human to defer to', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        debate: debateResult({ converged: false }),
        positionState: async () => [holding()],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
  });

  it('flattens without reading equity, so a dark mark elsewhere cannot suppress it (#847)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
        equity: async () => {
          throw new Error('portfolio view refused: SPY mark is stale');
        },
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.side).toBe('sell');
  });

  it('still refuses to size an entry when the equity read refuses (#847)', async () => {
    await expect(
      decideWithReason(
        traderInput({
          clock: new ManualClock(OUTSIDE_WINDOW),
          positionState: async () => [],
          equity: async () => {
            throw new Error('portfolio view refused: SPY mark is stale');
          },
        }),
      ),
    ).rejects.toThrow(/portfolio view refused/);
  });

  it('the control arm skips instead of refusing, with a distinct named reason (#1089)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(OUTSIDE_WINDOW),
        positionState: async () => [],
        arm: 'control',
        equity: async () => {
          throw new StaleMarkError('SPY', new Date(0), OUTSIDE_WINDOW, OUTSIDE_WINDOW, {
            status: 'stale',
            age_ms: OUTSIDE_WINDOW.getTime(),
            bound_ms: 60_000,
          });
        },
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('control_arm_valuation_refused');
  });

  it('the control arm also skips on the multi-instrument AggregateError shape (#1089)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(OUTSIDE_WINDOW),
        positionState: async () => [],
        arm: 'control',
        equity: async () => {
          throw new AggregateError(
            [
              new StaleMarkError('QQQ', new Date(0), OUTSIDE_WINDOW, OUTSIDE_WINDOW, {
                status: 'stale',
                age_ms: OUTSIDE_WINDOW.getTime(),
                bound_ms: 60_000,
              }),
              new StaleMarkError('MSTR', new Date(0), OUTSIDE_WINDOW, OUTSIDE_WINDOW, {
                status: 'stale',
                age_ms: OUTSIDE_WINDOW.getTime(),
                bound_ms: 60_000,
              }),
            ],
            '2 held instrument(s) could not be valued',
          );
        },
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('control_arm_valuation_refused');
  });

  it('the control arm also skips on a single mark-READ failure, not only a stale mark (#1089)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(OUTSIDE_WINDOW),
        positionState: async () => [],
        arm: 'control',
        equity: async () => {
          throw new MarkReadError(
            'AMD',
            "computePortfolioView: the mark read for held instrument 'AMD' failed, so the book " +
              'cannot be valued: 429 rate limited',
          );
        },
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('control_arm_valuation_refused');
  });

  it('the control arm still rethrows a non-valuation equity rejection — a sizing fault is not a skip (#1089)', async () => {
    await expect(
      decideWithReason(
        traderInput({
          clock: new ManualClock(OUTSIDE_WINDOW),
          positionState: async () => [],
          arm: 'control',
          equity: async () => {
            throw new Error('sizingEquity: capitalCeilingUsd refused');
          },
        }),
      ),
    ).rejects.toThrow(/capitalCeilingUsd refused/);
  });

  it('the control arm rethrows an AggregateError whose members are not all BookValuationError (#1089)', async () => {
    await expect(
      decideWithReason(
        traderInput({
          clock: new ManualClock(OUTSIDE_WINDOW),
          positionState: async () => [],
          arm: 'control',
          equity: async () => {
            throw new AggregateError(
              [
                new StaleMarkError('QQQ', new Date(0), OUTSIDE_WINDOW, OUTSIDE_WINDOW, {
                  status: 'stale',
                  age_ms: OUTSIDE_WINDOW.getTime(),
                  bound_ms: 60_000,
                }),
                new Error('sizingEquity: some unrelated batched sub-read failed'),
              ],
              '2 errors occurred',
            );
          },
        }),
      ),
    ).rejects.toThrow(/2 errors occurred/);
  });

  it('holds normally just outside the window', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(OUTSIDE_WINDOW),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('holding_neutral_or_non_converged');
  });

  it('opens nothing new inside the window', async () => {
    const outcome = await decideWithReason(
      traderInput({ clock: new ManualClock(INSIDE_WINDOW), positionState: async () => [] }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('session_closing');
  });

  it('still opens just outside the window', async () => {
    const outcome = await decideWithReason(
      traderInput({ clock: new ManualClock(OUTSIDE_WINDOW), positionState: async () => [] }),
    );

    expect(outcome.intent?.intent_type).toBe('entry');
  });

  it('fires exactly at the window boundary, not a tick later', async () => {
    const atBoundary = new Date(CLOSE.getTime() - DEFAULT_TRADER_CONFIG.flatten_before_close_ms);

    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(atBoundary),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
  });

  it('does not flatten crypto — #667 has not decided what its close means', async () => {
    const marketData = new FixtureMarketData(bars(15, 2), 'crypto');

    const outcome = await decideWithReason(
      traderInput({
        marketData,
        clock: new ManualClock(INSIDE_WINDOW),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding({ asset_class: 'crypto' })],
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('holding_neutral_or_non_converged');
  });

  it('uses the venue calendar it is given, so the LSE leg does not flatten on the US close', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
        sessionCalendars: {
          crypto: new AlwaysOpenCalendar(),
          stocks: new LseRegularHoursCalendar(),
        },
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('holding_neutral_or_non_converged');
  });

  it('flattens the LSE leg at ITS 16:30 London close', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(new Date('2026-07-15T15:26:00Z')),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
        sessionCalendars: {
          crypto: new AlwaysOpenCalendar(),
          stocks: new LseRegularHoursCalendar(),
        },
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
  });

  it('flattens rather than holding when the calendar reports a close already past', async () => {
    const pastClose = new Date('2026-07-15T19:00:00Z');
    const stuckCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: () => pastClose,
      sessionEnd: () => pastClose,
    } as unknown as TradingCalendar;

    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(new Date('2026-07-15T19:56:00Z')),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
        sessionCalendars: { crypto: new AlwaysOpenCalendar(), stocks: stuckCalendar },
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
  });

  it('opens nothing new while the calendar reports a close already past', async () => {
    const pastClose = new Date('2026-07-15T19:00:00Z');
    const stuckCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: () => pastClose,
      sessionEnd: () => pastClose,
    } as unknown as TradingCalendar;

    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(new Date('2026-07-15T19:56:00Z')),
        positionState: async () => [],
        sessionCalendars: { crypto: new AlwaysOpenCalendar(), stocks: stuckCalendar },
      }),
    );

    expect(outcome.intent).toBeNull();
  });

  it('still flattens against a close already gone, and no longer calls it a diagnostic (#1389)', async () => {
    const pastClose = new Date('2026-07-15T19:00:00Z');
    const stuckCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: () => pastClose,
      sessionEnd: () => pastClose,
    } as unknown as TradingCalendar;

    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(new Date('2026-07-15T19:56:00Z')),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
        sessionCalendars: { crypto: new AlwaysOpenCalendar(), stocks: stuckCalendar },
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.diagnostics).toEqual([]);
  });

  it('reports a non-crypto calendar that cannot resolve a session end at all (#698)', async () => {
    const muteCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: () => null,
      sessionEnd: () => null,
    } as unknown as TradingCalendar;

    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
        sessionCalendars: { crypto: new AlwaysOpenCalendar(), stocks: muteCalendar },
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'session_end_absent_on_non_crypto',
    ]);
  });

  it('stays silent when CRYPTO has no session end, which is the intended answer (#698)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding({ asset_class: 'crypto' })],
      }),
    );

    expect(outcome.diagnostics).toEqual([]);
  });

  it('leaves diagnostics empty on an ordinary healthy decision (#698)', async () => {
    const outcome = await decideWithReason(traderInput());

    expect(outcome.intent).not.toBeNull();
    expect(outcome.diagnostics).toEqual([]);
  });

  it('reports corrupt bar data that yields a non-finite ATR (#698)', async () => {
    const corrupt = bars(15, 2).map((bar, index) =>
      index === 7 ? { ...bar, high: Number.NaN } : bar,
    );

    const outcome = await decideWithReason(
      traderInput({ marketData: new FixtureMarketData(corrupt) }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('atr_not_finite');
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(['atr_not_finite']);
  });

  it('does NOT see a broken calendar while the book is flat — the known limitation (#698)', async () => {
    const muteCalendar = {
      isOpen: () => true,
      isTradingDay: () => true,
      sessionStart: () => null,
      sessionEnd: () => null,
    } as unknown as TradingCalendar;

    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [],
        sessionCalendars: { crypto: new AlwaysOpenCalendar(), stocks: muteCalendar },
      }),
    );

    expect(outcome.skip_reason).toBe('neutral_direction_while_flat');
    expect(outcome.diagnostics).toEqual([]);
  });

  it('throws on a non-positive flatten window rather than silently disabling flat-by-close', async () => {
    await expect(
      decide(
        traderInput({
          clock: new ManualClock(INSIDE_WINDOW),
          debate: debateResult({ direction: 'neutral' }),
          positionState: async () => [holding()],
          config: { ...DEFAULT_TRADER_CONFIG, flatten_before_close_ms: 0 },
        }),
      ),
    ).rejects.toThrow(/flatten_before_close_ms must be > 0/);
  });

  it('keys a same-bar entry and the mandatory flatten separately (#686)', async () => {
    const entry = await decide(
      traderInput({
        clock: new ManualClock(OUTSIDE_WINDOW),
        positionState: async () => [],
      }),
    );
    const flatten = await decide(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding()],
      }),
    );

    expect(entry?.intent_type).toBe('entry');
    expect(flatten?.intent_type).toBe('exit');
    expect(flatten?.idempotency_key).not.toBe(entry?.idempotency_key);
  });
});

describe('decide — config injection', () => {
  it('honours an injected conviction floor', async () => {
    const debate = debateResult({ confidence: 0.7 });

    const permissive = await decide(
      traderInput({ debate, config: configWith({ conviction_floor: 0.5 }) }),
    );
    const strict = await decide(
      traderInput({ debate, config: configWith({ conviction_floor: 0.8 }) }),
    );

    expect(permissive).not.toBeNull();
    expect(strict).toBeNull();
  });

  it('honours an injected reward:risk multiple', async () => {
    const intent = await decide(traderInput({ config: configWith({ reward_risk_multiple: 3 }) }));

    expect(intent?.target).toBe(ENTRY_PRICE + 3 * EXPECTED_STOP_DISTANCE);
  });
});

describe('decide — position-aware branching (#74)', () => {
  it('holds (null) on a same-direction debate whose conviction has not risen materially', async () => {
    const position = openPosition({ conviction: 0.6 });
    const debate = debateResult({ direction: 'bullish', confidence: 0.65, converged: true });

    const intent = await decide(traderInput({ debate, positionState: async () => [position] }));

    expect(intent).toBeNull();
  });

  it('scale_ins on a same-direction debate whose conviction rose materially', async () => {
    const position = openPosition({ conviction: 0.6 });
    const debate = debateResult({ direction: 'bullish', confidence: 0.775, converged: true });

    const intent = await decide(traderInput({ debate, positionState: async () => [position] }));

    expect(intent).not.toBeNull();
    expect(intent?.intent_type).toBe('scale_in');
    expect(intent?.side).toBe('buy');
    expect(intent?.size).toBeCloseTo(EXPECTED_SIZE);
  });

  it('exits (flattens) on an opposite-direction debate', async () => {
    const position = openPosition({ side: 'buy', filled_size: 50 });
    const secondLot = openPosition({
      idempotency_key: 'existing-key-2',
      side: 'buy',
      filled_size: 25,
    });
    const debate = debateResult({ direction: 'bearish', confidence: 0.9, converged: true });

    const intent = await decide(
      traderInput({ debate, positionState: async () => [position, secondLot] }),
    );

    expect(intent).not.toBeNull();
    expect(intent?.intent_type).toBe('exit');
    expect(intent?.side).toBe('sell');
    expect(intent?.size).toBe(75);
  });

  it('sizes an exit to what the venue still holds after a partial flatten, not the original filled size', async () => {
    const partiallyFlattened = openPosition({ side: 'buy', filled_size: 10 });
    const debate = debateResult({ direction: 'bearish', confidence: 0.9, converged: true });

    const intent = await decide(
      traderInput({
        debate,
        positionState: async () => [partiallyFlattened],
        exitFillSizes: async () => new Map([[partiallyFlattened.idempotency_key, 4]]),
      }),
    );

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.size).toBe(6);
  });

  it('holds (null) rather than exiting a lot whose exit fills already cover it', async () => {
    const fullyExited = openPosition({ side: 'buy', filled_size: 10 });
    const debate = debateResult({ direction: 'bearish', confidence: 0.9, converged: true });

    const intent = await decide(
      traderInput({
        debate,
        positionState: async () => [fullyExited],
        exitFillSizes: async () => new Map([[fullyExited.idempotency_key, 10]]),
      }),
    );

    expect(intent).toBeNull();
  });

  it('holds (null) rather than emitting a zero-size exit when every lot is still unfilled', async () => {
    const pendingLot = openPosition({ order_state: 'pending', filled_size: 0 });
    const debate = debateResult({ direction: 'bearish', confidence: 0.9, converged: true });

    const intent = await decide(traderInput({ debate, positionState: async () => [pendingLot] }));

    expect(intent).toBeNull();
  });

  it('holds (null) on a neutral debate while holding a position', async () => {
    const position = openPosition();
    const debate = debateResult({ direction: 'neutral', confidence: 0.9 });

    const intent = await decide(traderInput({ debate, positionState: async () => [position] }));

    expect(intent).toBeNull();
  });

  it('holds (null) on a non-converged debate while holding, even same-direction with a material conviction rise', async () => {
    const position = openPosition({ conviction: 0.5 });
    const debate = debateResult({ direction: 'bullish', confidence: 0.9, converged: false });

    const intent = await decide(traderInput({ debate, positionState: async () => [position] }));

    expect(intent).toBeNull();
  });

  it('still enters when flat, even with an unrelated position open on another instrument', async () => {
    const otherInstrumentPosition = openPosition({ instrument: 'TSLA' });

    const intent = await decide(
      traderInput({ positionState: async () => [otherInstrumentPosition] }),
    );

    expect(intent).not.toBeNull();
    expect(intent?.intent_type).toBe('entry');
  });

  it('compares conviction against the most recently opened lot, not the oldest', async () => {
    const olderLot = openPosition({
      idempotency_key: 'older',
      conviction: 0.5,
      opened_at: new Date('2026-07-10T10:00:00Z'),
    });
    const newerLot = openPosition({
      idempotency_key: 'newer',
      conviction: 0.7,
      opened_at: new Date('2026-07-14T10:00:00Z'),
    });
    const debate = debateResult({ direction: 'bullish', confidence: 0.75, converged: true });

    const intent = await decide(
      traderInput({ debate, positionState: async () => [olderLot, newerLot] }),
    );

    expect(intent).toBeNull();
  });
});

describe('decide — cosine precedent wiring (#432)', () => {
  it('writes the setup vector for an emitted intent', async () => {
    const setupStore = new FixtureSetupStore();

    const intent = await decide(traderInput({ setupStore }));

    expect(intent).not.toBeNull();
    const written = setupStore.getWritten();
    expect(written).toHaveLength(1);
    expect(written[0]?.debateId).toBe('debate-abc123');
    expect(written[0]?.decidedAt).toEqual(DECISION_BAR);
    expect(written[0]?.vector.debate_features).toHaveLength(4);
    expect(written[0]?.vector.market_features).toHaveLength(3);
  });

  it('survives a re-decided bar — replay and crash-restart hit the same debate_id', async () => {
    const setupStore = new FixtureSetupStore();

    await decide(traderInput({ setupStore }));
    await expect(decide(traderInput({ setupStore }))).resolves.not.toBeNull();

    expect(setupStore.getWritten()).toHaveLength(1);
  });

  it('writes NO setup when the decision is a skip', async () => {
    const setupStore = new FixtureSetupStore();
    const debate = debateResult({ confidence: 0.1 });

    const intent = await decide(traderInput({ debate, setupStore }));

    expect(intent).toBeNull();
    expect(setupStore.getWritten()).toHaveLength(0);
  });

  it('writes NO setup for an exit — a flatten is not a new setup', async () => {
    const setupStore = new FixtureSetupStore();
    const position = openPosition({ side: 'buy' });
    const debate = debateResult({ direction: 'bearish', converged: true });

    const intent = await decide(
      traderInput({ debate, setupStore, positionState: async () => [position] }),
    );

    expect(intent?.intent_type).toBe('exit');
    expect(setupStore.getWritten()).toHaveLength(0);
  });

  it('falls back to the 0.75x no-precedent default against an empty store', async () => {
    const intent = await decide(traderInput({ setupStore: new FixtureSetupStore() }));

    expect(intent?.metadata.sizing.cosine_multiplier).toBe(0.75);
    expect(intent?.metadata.cosine_precedent).toEqual({
      neighbor_count: 0,
      weighted_mean_r: null,
      no_precedent: true,
    });
  });

  it('sizes UP off a profitable precedent instead of taking the 0.75x haircut', async () => {
    const probe = new FixtureSetupStore();
    const baseline = await decide(traderInput({ setupStore: probe }));
    const vector = probe.getWritten()[0]?.vector;
    if (vector === undefined) throw new Error('probe run wrote no setup');

    const withPrecedent = new FixtureSetupStore([
      { vector, r_multiple: 2, closed_at: new Date('2026-07-14T10:00:00Z') },
    ]);
    const intent = await decide(traderInput({ setupStore: withPrecedent }));

    expect(intent?.metadata.sizing.cosine_multiplier).toBe(1.5);
    expect(intent?.metadata.cosine_precedent).toEqual({
      neighbor_count: 1,
      weighted_mean_r: 2,
      no_precedent: false,
    });
    expect(intent?.size).toBeCloseTo((baseline?.size ?? 0) * (1.5 / 0.75), 10);
  });

  it('sizes DOWN off a losing precedent', async () => {
    const probe = new FixtureSetupStore();
    const baseline = await decide(traderInput({ setupStore: probe }));
    const vector = probe.getWritten()[0]?.vector;
    if (vector === undefined) throw new Error('probe run wrote no setup');

    const withPrecedent = new FixtureSetupStore([
      { vector, r_multiple: -2, closed_at: new Date('2026-07-14T10:00:00Z') },
    ]);
    const intent = await decide(traderInput({ setupStore: withPrecedent }));

    expect(intent?.metadata.sizing.cosine_multiplier).toBe(0.5);
    expect(intent?.size).toBeCloseTo((baseline?.size ?? 0) * (0.5 / 0.75), 10);
  });

  it('ignores a neighbor whose trade closed after the decision (point-in-time)', async () => {
    const probe = new FixtureSetupStore();
    await decide(traderInput({ setupStore: probe }));
    const vector = probe.getWritten()[0]?.vector;
    if (vector === undefined) throw new Error('probe run wrote no setup');

    const future = new FixtureSetupStore([
      { vector, r_multiple: 2, closed_at: new Date('2026-07-16T10:00:00Z') },
    ]);
    const intent = await decide(traderInput({ setupStore: future }));

    expect(intent?.metadata.cosine_precedent.no_precedent).toBe(true);
    expect(intent?.metadata.sizing.cosine_multiplier).toBe(0.75);
  });
});

describe('decideWithReason — named skip reasons (#475)', () => {
  it('flat and neutral', async () => {
    const outcome = await decideWithReason(
      traderInput({ debate: debateResult({ direction: 'neutral' }) }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('neutral_direction_while_flat');
  });

  it('below the conviction floor', async () => {
    const outcome = await decideWithReason(
      traderInput({ debate: debateResult({ confidence: 0.1 }) }),
    );

    expect(outcome.skip_reason).toBe('below_conviction_floor');
    expect(outcome.atr).toBeNull();
  });

  it('too few bars to compute an ATR', async () => {
    const outcome = await decideWithReason(
      traderInput({ marketData: new FixtureMarketData(bars(2, 2)) }),
    );

    expect(outcome.skip_reason).toBe('atr_insufficient_bars');
  });

  it('below the minimum viable notional', async () => {
    const outcome = await decideWithReason(
      traderInput({ config: configWith({ min_viable_notional: 1_000_000 }) }),
    );

    expect(outcome.skip_reason).toBe('below_min_notional');
  });

  it('holding, and the debate went neutral', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [openPosition()],
      }),
    );

    expect(outcome.skip_reason).toBe('holding_neutral_or_non_converged');
  });

  it('holding, and conviction has not risen enough to scale in', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ confidence: 0.6 }),
        positionState: async () => [openPosition({ conviction: 0.6 })],
      }),
    );

    expect(outcome.skip_reason).toBe('scale_in_conviction_delta_not_met');
  });

  it('reversing out of a position that has no filled size yet', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'bearish' }),
        positionState: async () => [
          openPosition({ side: 'buy', filled_size: 0, order_state: 'submitted' }),
        ],
      }),
    );

    expect(outcome.skip_reason).toBe('exit_no_filled_size');
  });

  it('reports the divergence, not a flat-lot skip, when a lot records more closed than it ever opened', async () => {
    const overExited = openPosition({
      idempotency_key: 'lot-over-exited',
      side: 'buy',
      filled_size: 10,
    });
    const sibling = openPosition({
      idempotency_key: 'lot-sibling',
      side: 'buy',
      filled_size: 4,
    });

    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'bearish', confidence: 0.9, converged: true }),
        positionState: async () => [overExited, sibling],
        exitFillSizes: async () => new Map([['lot-over-exited', 14]]),
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('exit_held_quantity_diverged');
  });

  it('reports no reason at all when an order was produced', async () => {
    const outcome = await decideWithReason(traderInput());

    expect(outcome.intent).not.toBeNull();
    expect(outcome.skip_reason).toBeNull();
  });

  it('carries the ATR the stop was priced from', async () => {
    const outcome = await decideWithReason(traderInput());

    expect(outcome.atr).toBe(2);
    expect(outcome.intent?.entry).toBe(ENTRY_PRICE);
  });

  it('reports the scale_in ATR, not a stale one from the entry path', async () => {
    const outcome = await decideWithReason(
      traderInput({
        marketData: new FixtureMarketData(bars(15, 6)),
        debate: debateResult({ confidence: 0.95 }),
        positionState: async () => [openPosition({ conviction: 0.5 })],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('scale_in');
    expect(outcome.atr).toBe(6);
    expect(outcome.intent?.entry).toBeDefined();
    expect((outcome.intent?.entry ?? 0) - (outcome.intent?.stop ?? 0)).toBeCloseTo(12, 10);
  });

  it('is the same decision `decide` makes, projected', async () => {
    const input = traderInput({ debate: debateResult({ confidence: 0.1 }) });

    expect(await decide(input)).toBeNull();
    expect((await decideWithReason(input)).intent).toBeNull();
  });
});

describe('decideWithReason — decision class and reason detail (#1109)', () => {
  it('classifies a genuinely neutral, converged debate as declined_on_signal', async () => {
    const outcome = await decideWithReason(
      traderInput({ debate: debateResult({ direction: 'neutral', converged: true }) }),
    );

    expect(outcome.skip_reason).toBe('neutral_direction_while_flat');
    expect(outcome.decision_class).toBe('declined_on_signal');
  });

  it('classifies a flat-side neutral as could_not_decide when the debate timed out with zero rounds', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({
          direction: 'neutral',
          converged: false,
          rounds_completed: 0,
          timed_out: { budget_ms: 8_000, elapsed_ms: 8_050 },
        }),
      }),
    );

    expect(outcome.skip_reason).toBe('neutral_direction_while_flat');
    expect(outcome.decision_class).toBe('could_not_decide');
  });

  it('classifies a flat-side neutral as could_not_decide when the debate timed out with some rounds completed', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({
          direction: 'neutral',
          converged: false,
          rounds_completed: 1,
          timed_out: { budget_ms: 8_000, elapsed_ms: 8_050 },
        }),
      }),
    );

    expect(outcome.decision_class).toBe('could_not_decide');
  });

  it('classifies a flat-side neutral as could_not_decide when the debate was rate-limited (not admitted)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({
          direction: 'neutral',
          converged: false,
          rounds_completed: 0,
          rate_limited: { reason: 'model rate limit' },
        }),
      }),
    );

    expect(outcome.decision_class).toBe('could_not_decide');
  });

  it('classifies a flat-side neutral as could_not_decide when the debate result is unread (#1393)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({
          direction: 'neutral',
          converged: false,
          rounds_completed: 0,
          read: false,
        }),
      }),
    );

    expect(outcome.skip_reason).toBe('neutral_direction_while_flat');
    expect(outcome.decision_class).toBe('could_not_decide');
    expect(outcome.decision_class).not.toBe('declined_on_signal');
  });

  it('classifies a holding refusal as declined_on_signal when the debate genuinely did not converge', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'bullish', converged: false }),
        positionState: async () => [openPosition()],
      }),
    );

    expect(outcome.skip_reason).toBe('holding_neutral_or_non_converged');
    expect(outcome.decision_class).toBe('declined_on_signal');
  });

  it('classifies a holding refusal as could_not_decide when the non-convergence is a timeout', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({
          direction: 'bullish',
          converged: false,
          rounds_completed: 0,
          timed_out: { budget_ms: 8_000, elapsed_ms: 8_050 },
        }),
        positionState: async () => [openPosition()],
      }),
    );

    expect(outcome.skip_reason).toBe('holding_neutral_or_non_converged');
    expect(outcome.decision_class).toBe('could_not_decide');
  });

  it('classifies a below-conviction-floor decline as could_not_decide when the entry debate is a degraded partial', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({
          direction: 'bullish',
          confidence: 0.1,
          converged: false,
          rounds_completed: 1,
          timed_out: { budget_ms: 8_000, elapsed_ms: 8_050 },
        }),
      }),
    );

    expect(outcome.skip_reason).toBe('below_conviction_floor');
    expect(outcome.decision_class).toBe('could_not_decide');
  });

  it('classifies session_closing as declined_on_signal even when the debate is degraded', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(new Date('2026-07-15T19:56:00Z')),
        debate: debateResult({
          direction: 'bullish',
          converged: false,
          rounds_completed: 1,
          timed_out: { budget_ms: 8_000, elapsed_ms: 8_050 },
        }),
      }),
    );

    expect(outcome.skip_reason).toBe('session_closing');
    expect(outcome.decision_class).toBe('declined_on_signal');
  });

  it('classifies session_closing as declined_on_signal even when the debate is unread (#1393)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(new Date('2026-07-15T19:56:00Z')),
        debate: debateResult({
          direction: 'bullish',
          converged: false,
          rounds_completed: 0,
          read: false,
        }),
      }),
    );

    expect(outcome.skip_reason).toBe('session_closing');
    expect(outcome.decision_class).toBe('declined_on_signal');
  });

  it('carries the compared value and the threshold on a conviction-floor decline', async () => {
    const outcome = await decideWithReason(
      traderInput({ debate: debateResult({ confidence: 0.1 }) }),
    );

    expect(outcome.skip_reason).toBe('below_conviction_floor');
    expect(outcome.decision_class).toBe('declined_on_signal');
    expect(outcome.reason_detail).toEqual({
      compared_value: 0.1,
      threshold: DEFAULT_TRADER_CONFIG.conviction_floor,
    });
  });

  it('carries the compared value and the threshold on a below-minimum-notional decline', async () => {
    const outcome = await decideWithReason(
      traderInput({ config: configWith({ min_viable_notional: 1_000_000 }) }),
    );

    expect(outcome.skip_reason).toBe('below_min_notional');
    expect(outcome.reason_detail).toEqual({
      compared_value: EXPECTED_SIZE * ENTRY_PRICE,
      threshold: 1_000_000,
    });
  });

  it('carries the compared value and the threshold on a scale-in conviction-delta decline', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ confidence: 0.6 }),
        positionState: async () => [openPosition({ conviction: 0.6 })],
      }),
    );

    expect(outcome.skip_reason).toBe('scale_in_conviction_delta_not_met');
    expect(outcome.reason_detail).toEqual({
      compared_value: 0.6 - 0.6,
      threshold: DEFAULT_TRADER_CONFIG.scale_in_conviction_delta,
    });
  });

  it('carries no reason_detail on a skip that has no threshold to compare', async () => {
    const corrupt = bars(15, 2).map((bar, index) =>
      index === 7 ? { ...bar, high: Number.NaN } : bar,
    );

    const outcome = await decideWithReason(
      traderInput({ marketData: new FixtureMarketData(corrupt) }),
    );

    expect(outcome.skip_reason).toBe('atr_not_finite');
    expect(outcome.reason_detail).toBeNull();
    expect(outcome.decision_class).toBe('input_unusable');
  });

  it('carries the compared value and the threshold on an insufficient-bars decline', async () => {
    const outcome = await decideWithReason(
      traderInput({ marketData: new FixtureMarketData(bars(2, 2)) }),
    );

    expect(outcome.skip_reason).toBe('atr_insufficient_bars');
    expect(outcome.reason_detail).toEqual({
      compared_value: 2,
      threshold: minimumBarsFor(
        atrIndicatorSpec(DEFAULT_TRADER_CONFIG.atr_lookback, DEFAULT_TRADER_CONFIG.atr_timeframe),
      ),
    });
    expect(outcome.decision_class).toBe('input_unusable');
  });

  it('classifies a data-quality skip as input_unusable, not declined_on_signal', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'bearish' }),
        positionState: async () => [
          openPosition({ side: 'buy', filled_size: 0, order_state: 'submitted' }),
        ],
      }),
    );

    expect(outcome.skip_reason).toBe('exit_no_filled_size');
    expect(outcome.decision_class).toBe('input_unusable');
  });

  it('reports no decision_class and no reason_detail when an order was produced', async () => {
    const outcome = await decideWithReason(traderInput());

    expect(outcome.intent).not.toBeNull();
    expect(outcome.decision_class).toBeNull();
    expect(outcome.reason_detail).toBeNull();
  });
});

describe('checkExitsWithReason — the tick-path exit entry point (#743)', () => {
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');
  const OUTSIDE_WINDOW = new Date('2026-07-15T15:00:00Z');
  const TICK_BAR = new Date('2026-07-15T18:00:00Z');
  const SESSION_CLOSE = new Date('2026-07-15T20:00:00Z');

  function marketDataWithLiveSignal(): FixtureMarketData {
    const marketData = new FixtureMarketData(bars(15, 2));
    marketData.indicatorReads.set('rsi', 60);
    marketData.indicatorReads.set('macd_histogram', 0.5);
    return marketData;
  }

  function exitInput(overrides: Partial<ExitCheckInput> = {}): ExitCheckInput {
    const base = traderInput();
    return {
      trace_id: base.trace_id,
      instrument: base.instrument,
      clock: new ManualClock(INSIDE_WINDOW),
      config: base.config,
      marketData: marketDataWithLiveSignal(),
      sessionCalendars: base.sessionCalendars,
      positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
      exitFillSizes: base.exitFillSizes,
      unresolvedFlattens: base.unresolvedFlattens,
      bar: TICK_BAR,
      ...overrides,
    };
  }

  it('skips with no_open_position when flat', async () => {
    const outcome = await checkExitsWithReason(exitInput({ positionState: async () => [] }));

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('no_open_position');
    expect(outcome.decision_class).toBe('declined_on_signal');
  });

  it('classifies exit_no_filled_size as input_unusable on the tick path (#1109)', async () => {
    const outcome = await checkExitsWithReason(
      exitInput({
        positionState: async () => [
          openPosition({ side: 'buy', filled_size: 0, order_state: 'submitted' }),
        ],
      }),
    );

    expect(outcome.skip_reason).toBe('exit_no_filled_size');
    expect(outcome.decision_class).toBe('input_unusable');
  });

  it('skips with signal_still_supports_position when holding outside the window on a live signal — "flat" and "waiting" stay distinguishable', async () => {
    const outcome = await checkExitsWithReason(
      exitInput({ clock: new ManualClock(OUTSIDE_WINDOW) }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('signal_still_supports_position');
  });

  it('emits the flatten inside the window, attributed to the debate that OPENED the lot', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.side).toBe('sell');
    expect(outcome.intent?.size).toBe(10);
    expect(outcome.intent?.metadata.debate_id).toBe('debate-existing');
    expect(outcome.intent?.metadata.conviction).toBe(0.6);
  });

  it('keys the flatten to the SESSION CLOSE, not to any bar (#1389)', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.idempotency_key).toBe(
      computeFlattenIdempotencyKey(exitInput().instrument, SESSION_CLOSE),
    );
    expect(outcome.intent?.idempotency_key).not.toBe(
      computeIdempotencyKey(exitInput().instrument, TICK_BAR, 'close'),
    );
    expect(outcome.intent?.idempotency_key).not.toBe(
      computeIdempotencyKey(exitInput().instrument, new Date('2026-07-15T19:00:00Z'), 'close'),
    );
  });

  describe('the grace past the bell (#1389)', () => {
    const INSIDE_GRACE = new Date('2026-07-15T20:04:00Z');
    const PAST_GRACE = new Date('2026-07-15T20:06:00Z');

    it('still emits the mandatory flatten four minutes AFTER the close', async () => {
      const outcome = await checkExitsWithReason(
        exitInput({ clock: new ManualClock(INSIDE_GRACE) }),
      );

      expect(outcome.intent?.intent_type).toBe('exit');
      expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
      expect(outcome.intent?.metadata.mandatory_flatten).toBe(true);
    });

    it('keys the post-bell flatten to the SAME close the in-window one enforced', async () => {
      const before = await checkExitsWithReason(exitInput());
      const after = await checkExitsWithReason(exitInput({ clock: new ManualClock(INSIDE_GRACE) }));

      expect(after.intent?.idempotency_key).toBe(before.intent?.idempotency_key);
      expect(after.intent?.idempotency_key).toBe(
        computeFlattenIdempotencyKey(INSTRUMENT, SESSION_CLOSE),
      );
    });

    it('produces exactly ONE key across every tick in the window and the grace', async () => {
      const keys = new Set<string>();
      for (
        let at = SESSION_CLOSE.getTime() - 5 * 60_000;
        at <= SESSION_CLOSE.getTime() + 5 * 60_000;
        at += 30_000
      ) {
        const outcome = await checkExitsWithReason(
          exitInput({ clock: new ManualClock(new Date(at)) }),
        );
        expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
        if (outcome.intent !== null) keys.add(outcome.intent.idempotency_key);
      }

      expect(keys.size).toBe(1);
    });

    it('closes the window again once the grace expires', async () => {
      const outcome = await checkExitsWithReason(exitInput({ clock: new ManualClock(PAST_GRACE) }));

      expect(outcome.intent?.metadata.exit_reason).not.toBe('flatten');
    });
  });

  describe('the in-flight flatten guard (#1389)', () => {
    it('produces no flatten while this arm holds an unresolved flatten for the instrument', async () => {
      const outcome = await checkExitsWithReason(
        exitInput({
          unresolvedFlattens: async () => [{ instrument: INSTRUMENT }],
        }),
      );

      expect(outcome.intent).toBeNull();
      expect(outcome.skip_reason).toBe('flatten_in_flight');
    });

    it('does NOT fall through to the decay release when it skips', async () => {
      const decayed = marketDataWithLiveSignal();
      decayed.indicatorReads.set('rsi', 40);
      decayed.indicatorReads.set('macd_histogram', -0.5);

      const outcome = await checkExitsWithReason(
        exitInput({
          marketData: decayed,
          unresolvedFlattens: async () => [{ instrument: INSTRUMENT }],
        }),
      );

      expect(outcome.intent).toBeNull();
      expect(outcome.skip_reason).toBe('flatten_in_flight');
    });

    it('is scoped to the instrument — another name in flight does not block this one', async () => {
      const outcome = await checkExitsWithReason(
        exitInput({
          unresolvedFlattens: async () => [{ instrument: 'SOME-OTHER-NAME' }],
        }),
      );

      expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    });
  });

  it('attributes to the MOST RECENT lot when several are open', async () => {
    const older = openPosition({ side: 'buy', filled_size: 10 });
    const newer = openPosition({
      idempotency_key: 'newer-key',
      debate_id: 'debate-newer',
      side: 'buy',
      filled_size: 5,
      conviction: 0.9,
      opened_at: new Date('2026-07-15T14:00:00Z'),
    });
    const outcome = await checkExitsWithReason(
      exitInput({ positionState: async () => [older, newer] }),
    );

    expect(outcome.intent?.metadata.debate_id).toBe('debate-newer');
    expect(outcome.intent?.size).toBe(15);
  });

  it("ignores other instruments — their lots are not this instrument's exit", async () => {
    const outcome = await checkExitsWithReason(
      exitInput({
        positionState: async () => [
          openPosition({ instrument: 'TSLA', side: 'buy', filled_size: 10 }),
        ],
      }),
    );

    expect(outcome.skip_reason).toBe('no_open_position');
  });
});

describe('checkExitsWithReason — the indicator-based early exit (#748)', () => {
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');
  const OUTSIDE_WINDOW = new Date('2026-07-15T15:00:00Z');
  const TICK_BAR = new Date('2026-07-15T18:00:00Z');
  const SESSION_CLOSE = new Date('2026-07-15T20:00:00Z');

  const MOMENTUM_BULLISH = { rsi: 60, macd: 0.5 };
  const MOMENTUM_BEARISH = { rsi: 40, macd: -0.5 };
  const MOMENTUM_FLAT = { rsi: 50, macd: 0 };

  function marketDataWithMomentum(momentum: {
    rsi: number | Error;
    macd: number | Error;
  }): FixtureMarketData {
    const marketData = new FixtureMarketData(bars(15, 2));
    marketData.indicatorReads.set('rsi', momentum.rsi);
    marketData.indicatorReads.set('macd_histogram', momentum.macd);
    return marketData;
  }

  const BRACKETS_UNTOUCHED = { stop: 90, target: 110 };

  function exitInput(overrides: Partial<ExitCheckInput> = {}): ExitCheckInput {
    const base = traderInput();
    return {
      trace_id: base.trace_id,
      instrument: base.instrument,
      clock: new ManualClock(OUTSIDE_WINDOW),
      config: base.config,
      marketData: marketDataWithMomentum(MOMENTUM_BEARISH),
      sessionCalendars: base.sessionCalendars,
      positionState: async () => [
        openPosition({ side: 'buy', filled_size: 10, ...BRACKETS_UNTOUCHED }),
      ],
      exitFillSizes: base.exitFillSizes,
      unresolvedFlattens: base.unresolvedFlattens,
      bar: TICK_BAR,
      ...overrides,
    };
  }

  it('releases a decayed LONG before either bracket is touched', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.metadata.exit_reason).toBe('signal_decay');
    expect(outcome.intent?.entry).toBeGreaterThan(BRACKETS_UNTOUCHED.stop);
    expect(outcome.intent?.entry).toBeLessThan(BRACKETS_UNTOUCHED.target);
  });

  it('releases a decayed SHORT — decay is read against the HELD side, not the market', async () => {
    const bullish = marketDataWithMomentum(MOMENTUM_BULLISH);

    const shortOutcome = await checkExitsWithReason(
      exitInput({
        marketData: bullish,
        positionState: async () => [
          openPosition({ side: 'sell', filled_size: 10, ...BRACKETS_UNTOUCHED }),
        ],
      }),
    );
    const longOutcome = await checkExitsWithReason(exitInput({ marketData: bullish }));

    expect(shortOutcome.intent?.metadata.exit_reason).toBe('signal_decay');
    expect(shortOutcome.intent?.side).toBe('buy');
    expect(longOutcome.intent).toBeNull();
    expect(longOutcome.skip_reason).toBe('signal_still_supports_position');
  });

  it('can only REDUCE OR CLOSE — the release is the held quantity, on the closing side, as an exit', async () => {
    const outcome = await checkExitsWithReason(
      exitInput({
        positionState: async () => [
          openPosition({ side: 'buy', filled_size: 10, ...BRACKETS_UNTOUCHED }),
          openPosition({
            idempotency_key: 'second-lot',
            side: 'buy',
            filled_size: 4,
            ...BRACKETS_UNTOUCHED,
          }),
        ],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.side).toBe('sell');
    expect(outcome.intent?.size).toBe(14);
    expect(outcome.intent?.stop).toBe(outcome.intent?.entry);
    expect(outcome.intent?.target).toBe(outcome.intent?.entry);
  });

  it('cannot OPEN a position — a fully decayed signal on a flat book emits nothing', async () => {
    const outcome = await checkExitsWithReason(exitInput({ positionState: async () => [] }));

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('no_open_position');
  });

  it('takes its decay threshold from INJECTED config, not a constant', async () => {
    const flat = marketDataWithMomentum(MOMENTUM_FLAT);

    const atDefault = await checkExitsWithReason(exitInput({ marketData: flat }));
    const atZero = await checkExitsWithReason(
      exitInput({
        marketData: flat,
        config: configWith({ early_exit: { momentum_release_at: 0 } }),
      }),
    );

    expect(DEFAULT_TRADER_CONFIG.early_exit.momentum_release_at).toBe(-1);
    expect(atDefault.intent).toBeNull();
    expect(atDefault.skip_reason).toBe('signal_still_supports_position');
    expect(atZero.intent?.metadata.exit_reason).toBe('signal_decay');
  });

  it('consults ONLY the momentum indicators — two reads, no analyst view, no model call', async () => {
    const marketData = marketDataWithMomentum(MOMENTUM_BEARISH);
    const requested: string[] = [];
    const originalGetIndicator = marketData.getIndicator.bind(marketData);
    marketData.getIndicator = async (instrument: string, spec: IndicatorSpec, asOf: Date) => {
      requested.push(spec.indicator);
      return originalGetIndicator(instrument, spec, asOf);
    };

    await checkExitsWithReason(exitInput({ marketData }));

    expect(MACD_SPEC.lookback).toBeGreaterThan(RSI_SPEC.lookback);
    expect(requested).toEqual([MACD_SPEC.indicator, RSI_SPEC.indicator]);
  });

  it('names all THREE in-process exit reasons apart — flatten, signal_decay, direction_flip', async () => {
    const flatten = await checkExitsWithReason(
      exitInput({ clock: new ManualClock(INSIDE_WINDOW) }),
    );
    const decay = await checkExitsWithReason(exitInput());
    const flip = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'bearish' }),
        positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
      }),
    );

    expect(flatten.intent?.metadata.exit_reason).toBe('flatten');
    expect(decay.intent?.metadata.exit_reason).toBe('signal_decay');
    expect(flip.intent?.metadata.exit_reason).toBe('direction_flip');
    expect(
      new Set([
        flatten.intent?.metadata.exit_reason,
        decay.intent?.metadata.exit_reason,
        flip.intent?.metadata.exit_reason,
      ]).size,
    ).toBe(3);
  });

  it('keys an early exit APART from a same-bar flatten, so the flatten is never deduped away', async () => {
    const decay = await checkExitsWithReason(exitInput());
    const flatten = await checkExitsWithReason(
      exitInput({ clock: new ManualClock(INSIDE_WINDOW) }),
    );

    expect(decay.intent?.idempotency_key).toBe(
      computeIdempotencyKey(INSTRUMENT, TICK_BAR, 'early_close'),
    );
    expect(flatten.intent?.idempotency_key).toBe(
      computeFlattenIdempotencyKey(INSTRUMENT, SESSION_CLOSE),
    );
    expect(decay.intent?.idempotency_key).not.toBe(flatten.intent?.idempotency_key);
  });

  it('skips with early_exit_signal_unavailable on an instrument too cold to read', async () => {
    const cold = marketDataWithMomentum({
      rsi: MOMENTUM_BEARISH.rsi,
      macd: new InsufficientBarsError({
        indicator: 'macd_histogram',
        period: 9,
        required: 34,
        received: 12,
      }),
    });

    const outcome = await checkExitsWithReason(exitInput({ marketData: cold }));

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('early_exit_signal_unavailable');
  });

  it('FAILS LOUD on a non-InsufficientBarsError — a store outage must not silently disable the exit', async () => {
    const broken = marketDataWithMomentum({
      rsi: new Error('market data store unavailable'),
      macd: MOMENTUM_BEARISH.macd,
    });

    await expect(checkExitsWithReason(exitInput({ marketData: broken }))).rejects.toThrow(
      'market data store unavailable',
    );
  });

  it('flattens inside the window even when the decay read THROWS — the flatten is decided first', async () => {
    const broken = marketDataWithMomentum({
      rsi: new Error('market data store unavailable'),
      macd: new Error('market data store unavailable'),
    });

    const outcome = await checkExitsWithReason(
      exitInput({ clock: new ManualClock(INSIDE_WINDOW), marketData: broken }),
    );

    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    expect(outcome.intent?.size).toBe(10);
  });

  it('flattens inside the window when the signal STILL SUPPORTS the position (early exit would never fire)', async () => {
    const outcome = await checkExitsWithReason(
      exitInput({
        clock: new ManualClock(INSIDE_WINDOW),
        marketData: marketDataWithMomentum(MOMENTUM_BULLISH),
      }),
    );

    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
  });

  it('does not read an indicator at all when the flatten is due — the flatten costs nothing extra', async () => {
    const marketData = marketDataWithMomentum(MOMENTUM_BEARISH);
    let reads = 0;
    const originalGetIndicator = marketData.getIndicator.bind(marketData);
    marketData.getIndicator = async (instrument: string, spec: IndicatorSpec, asOf: Date) => {
      reads += 1;
      return originalGetIndicator(instrument, spec, asOf);
    };

    const outcome = await checkExitsWithReason(
      exitInput({ clock: new ManualClock(INSIDE_WINDOW), marketData }),
    );

    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    expect(reads).toBe(0);
  });

  it('marks the flat-by-close flatten as mandatory, on the tick path', async () => {
    const outcome = await checkExitsWithReason(
      exitInput({
        clock: new ManualClock(INSIDE_WINDOW),
        marketData: marketDataWithMomentum(MOMENTUM_FLAT),
      }),
    );

    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    expect(outcome.intent?.metadata.mandatory_flatten).toBe(true);
  });

  it('marks it on the DECISION path too — the same builder, the same window', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
      }),
    );

    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    expect(outcome.intent?.metadata.mandatory_flatten).toBe(true);
  });

  it('does NOT mark a signal_decay release — a discretionary exit stays gated', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.metadata.exit_reason).toBe('signal_decay');
    expect(outcome.intent?.metadata.mandatory_flatten).toBeUndefined();
  });

  it('does NOT mark a direction_flip exit', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(OUTSIDE_WINDOW),
        debate: debateResult({ direction: 'bearish', confidence: 0.9 }),
        positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
      }),
    );

    expect(outcome.intent?.metadata.exit_reason).toBe('direction_flip');
    expect(outcome.intent?.metadata.mandatory_flatten).toBeUndefined();
  });

  it('does NOT mark an entry', async () => {
    const outcome = await decideWithReason(
      traderInput({ clock: new ManualClock(OUTSIDE_WINDOW), positionState: async () => [] }),
    );

    expect(outcome.intent?.intent_type).toBe('entry');
    expect(outcome.intent?.metadata.mandatory_flatten).toBeUndefined();
  });
});

describe('decide/checkExits — the mark read fails (#826)', () => {
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');
  const OUTSIDE_WINDOW = new Date('2026-07-15T15:00:00Z');
  const TICK_BAR = new Date('2026-07-15T18:00:00Z');
  const STALL = 'alpaca: request timed out after 3 attempts';

  class MarkStalledMarketData extends FixtureMarketData {
    override async getMark(): Promise<Mark> {
      throw new Error(STALL);
    }
  }

  function stalled(): MarkStalledMarketData {
    const marketData = new MarkStalledMarketData(bars(15, 2));
    marketData.indicatorReads.set('rsi', 60);
    marketData.indicatorReads.set('macd_histogram', 0.5);
    return marketData;
  }

  function exitInput(overrides: Partial<ExitCheckInput> = {}): ExitCheckInput {
    const base = traderInput();
    return {
      trace_id: base.trace_id,
      instrument: base.instrument,
      clock: new ManualClock(INSIDE_WINDOW),
      config: base.config,
      marketData: stalled(),
      sessionCalendars: base.sessionCalendars,
      positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
      exitFillSizes: base.exitFillSizes,
      unresolvedFlattens: base.unresolvedFlattens,
      bar: TICK_BAR,
      ...overrides,
    };
  }

  it('still flattens on the tick path, unpriced, rather than carrying the position overnight', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    expect(outcome.intent?.side).toBe('sell');
    expect(outcome.intent?.size).toBe(10);
    expect(outcome.intent?.asset_class).toBe('stocks');
    expect(outcome.intent?.entry).toBe(0);
    expect(outcome.intent?.stop).toBe(0);
    expect(outcome.intent?.target).toBe(0);
    expect(outcome.intent?.metadata.unpriced_exit).toBe(true);
  });

  it('carries both `unpriced_exit` and `mandatory_flatten` on the same intent', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.metadata.unpriced_exit).toBe(true);
    expect(outcome.intent?.metadata.mandatory_flatten).toBe(true);
  });

  it('reports the unpriced flatten, so the degradation is never silent', async () => {
    const reports: { instrument: string; reason: string }[] = [];

    const outcome = await checkExitsWithReason(
      exitInput({ onUnpricedFlatten: (report) => reports.push(report) }),
    );

    expect(outcome.intent?.metadata.unpriced_exit).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.instrument).toBe(INSTRUMENT);
    expect(reports[0]?.reason).toContain('timed out');
  });

  it('flattens even when the report channel throws — a page must not cost the exit', async () => {
    const outcome = await checkExitsWithReason(
      exitInput({
        onUnpricedFlatten: () => {
          throw new Error('telegram is unreachable');
        },
      }),
    );

    expect(outcome.intent?.metadata.unpriced_exit).toBe(true);
  });

  it('flattens unpriced on the DECISION path too — a debate bar reaches the same branch', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        marketData: stalled(),
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    expect(outcome.intent?.metadata.unpriced_exit).toBe(true);
  });

  it('does NOT degrade a signal_decay release — it still fails loudly', async () => {
    const marketData = stalled();
    marketData.indicatorReads.set('rsi', 40);
    marketData.indicatorReads.set('macd_histogram', -0.5);

    await expect(
      checkExitsWithReason(exitInput({ clock: new ManualClock(OUTSIDE_WINDOW), marketData })),
    ).rejects.toThrow(STALL);
  });

  it('does NOT degrade a direction_flip exit — it still fails loudly', async () => {
    await expect(
      decideWithReason(
        traderInput({
          clock: new ManualClock(OUTSIDE_WINDOW),
          marketData: stalled(),
          debate: debateResult({ direction: 'bearish', confidence: 0.9 }),
          positionState: async () => [openPosition({ side: 'buy', filled_size: 10 })],
        }),
      ),
    ).rejects.toThrow(STALL);
  });

  it('does NOT degrade an ENTRY — a position must never be opened without a price', async () => {
    await expect(
      decideWithReason(
        traderInput({
          clock: new ManualClock(OUTSIDE_WINDOW),
          marketData: stalled(),
          positionState: async () => [],
        }),
      ),
    ).rejects.toThrow(STALL);
  });

  it('does NOT degrade a scale_in either — the same builder serves both call sites (#900)', async () => {
    await expect(
      decideWithReason(
        traderInput({
          clock: new ManualClock(OUTSIDE_WINDOW),
          marketData: stalled(),
          debate: debateResult({ direction: 'bullish', confidence: 0.775, converged: true }),
          positionState: async () => [
            openPosition({ side: 'buy', filled_size: 10, conviction: 0.6 }),
          ],
        }),
      ),
    ).rejects.toThrow(STALL);
  });

  it('leaves a HEALTHY flatten priced and unflagged — the degradation is reached only on a failure', async () => {
    const marketData = new FixtureMarketData(bars(15, 2));
    marketData.indicatorReads.set('rsi', 60);
    marketData.indicatorReads.set('macd_histogram', 0.5);

    const outcome = await checkExitsWithReason(exitInput({ marketData }));

    expect(outcome.intent?.entry).toBe(ENTRY_PRICE);
    expect(outcome.intent?.metadata.unpriced_exit).toBeUndefined();
  });
});
