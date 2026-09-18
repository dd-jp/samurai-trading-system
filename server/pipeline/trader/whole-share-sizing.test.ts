import {
  AlwaysOpenCalendar,
  type Bar,
  type BarWindow,
  collectMarks,
  type IndicatorSpec,
  type IndicatorValue,
  type Mark,
  type MarketDataService,
  type MarkRead,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock, OpenPosition } from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { decide, decideWithReason } from './decide.js';
import { FixtureSetupStore } from './fixture-setup-store.js';
import type { TraderConfig, TraderInput } from './types.js';
import { DEFAULT_TRADER_CONFIG } from './types.js';

const INSTRUMENT = 'AAPL';
const DECISION_BAR = new Date('2026-07-15T10:00:00Z');
const ENTRY_PRICE = 100;
const EQUITY = 100_000;
const UNQUANTISED_SIZE = 93.75;

class ManualClock implements Clock {
  constructor(private readonly time: Date) {}

  now(): Date {
    return this.time;
  }
}

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
  async getBars(_instrument: string, _window: BarWindow, _asOf: Date): Promise<Bar[]> {
    return bars(15, 2);
  }

  async getMark(_instrument: string, _asOf: Date): Promise<Mark> {
    return {
      price: ENTRY_PRICE,
      observed_at: DECISION_BAR,
      source: 'fixture',
      asset_class: 'stocks',
    };
  }

  async getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
  }

  async getIndicator(
    _instrument: string,
    _spec: IndicatorSpec,
    _asOf: Date,
  ): Promise<IndicatorValue> {
    throw new Error('FixtureMarketData.getIndicator: not part of the entry path');
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
    debate_id: 'debate-941',
    bar_timestamp: DECISION_BAR,
    read: true,
    ...overrides,
  };
}

function configWith(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return { ...DEFAULT_TRADER_CONFIG, ...overrides };
}

function traderInput(overrides: Partial<TraderInput> = {}): TraderInput {
  return {
    trace_id: 'trace-941',
    instrument: INSTRUMENT,
    debate: debateResult(),
    clock: new ManualClock(DECISION_BAR),
    marketData: new FixtureMarketData(),
    equity: async () => EQUITY,
    config: configWith({ whole_share_sizing: true }),
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

describe('whole_share_sizing quantises the ENTRY to the venue grid (#941)', () => {
  it('floors a fractional D5 size to a whole share', async () => {
    const intent = await decide(traderInput());

    expect(intent?.size).toBe(93);
  });

  it('floors DOWN rather than to nearest — 93.75 must not become 94', async () => {
    const intent = await decide(traderInput());

    expect(intent?.size).toBeLessThan(UNQUANTISED_SIZE);
    expect(intent?.size).not.toBe(94);
  });

  it('floors the SHORT side toward zero exposure too, not away from it', async () => {
    const intent = await decide(
      traderInput({ debate: debateResult({ direction: 'bearish', position: 'Enter short.' }) }),
    );

    expect(intent?.side).toBe('sell');
    expect(intent?.size).toBe(93);
  });

  it('deploys no more than the unquantised D5 envelope', async () => {
    const intent = await decide(traderInput());

    expect((intent?.size ?? 0) * (intent?.entry ?? 0)).toBeLessThanOrEqual(
      UNQUANTISED_SIZE * ENTRY_PRICE,
    );
  });

  it('leaves the size untouched when the flag is off, so backtests are unmoved', async () => {
    const intent = await decide(traderInput({ config: configWith({ whole_share_sizing: false }) }));

    expect(intent?.size).toBe(UNQUANTISED_SIZE);
  });
});

describe('whole_share_sizing records the deviation it introduces (#941)', () => {
  it('records the size D5 actually sized when the floor moved it', async () => {
    const intent = await decide(traderInput());

    expect(intent?.metadata.sizing.unquantised_size).toBe(UNQUANTISED_SIZE);
  });

  it('omits the record when the floor changed nothing', async () => {
    const intent = await decide(traderInput({ equity: async () => EQUITY * 4 }));

    expect(intent?.size).toBe(375);
    expect(intent?.metadata.sizing.unquantised_size).toBeUndefined();
  });

  it('omits the record entirely when the flag is off', async () => {
    const intent = await decide(traderInput({ config: configWith({ whole_share_sizing: false }) }));

    expect(intent?.metadata.sizing.unquantised_size).toBeUndefined();
  });
});

describe('an entry that cannot buy one whole share (#941)', () => {
  const SUB_ONE_SHARE_EQUITY = 1_000;

  it('skips as rounds_to_zero_shares rather than submitting a zero quantity', async () => {
    const outcome = await decideWithReason(
      traderInput({ equity: async () => SUB_ONE_SHARE_EQUITY }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('rounds_to_zero_shares');
  });

  it('is NOT caught by the dust floor — the intended notional clears it comfortably', async () => {
    expect(0.9375 * ENTRY_PRICE).toBeGreaterThan(DEFAULT_TRADER_CONFIG.min_viable_notional);

    const unquantised = await decide(
      traderInput({
        equity: async () => SUB_ONE_SHARE_EQUITY,
        config: configWith({ whole_share_sizing: false }),
      }),
    );

    expect(unquantised?.size).toBe(0.9375);
  });

  it('still reports below_min_notional when the STRATEGY sized nothing (#870)', async () => {
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ confidence: DEFAULT_TRADER_CONFIG.conviction_floor }),
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('below_min_notional');
  });
});

describe('the flatten is never quantised (#941)', () => {
  const CLOSE = new Date('2026-07-15T20:00:00Z');
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');

  function holding(overrides: Partial<OpenPosition> = {}): OpenPosition {
    return {
      idempotency_key: 'existing-key',
      debate_id: 'debate-existing',
      instrument: INSTRUMENT,
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10.5,
      filled_size: 10.5,
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

  it('flattens the held quantity verbatim, fraction and all', async () => {
    expect(CLOSE.getTime() - INSIDE_WINDOW.getTime()).toBeLessThan(
      DEFAULT_TRADER_CONFIG.flatten_before_close_ms,
    );

    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        positionState: async () => [holding()],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.size).toBe(10.5);
  });

  it('does not zero a sub-one-share flatten', async () => {
    const outcome = await decideWithReason(
      traderInput({
        clock: new ManualClock(INSIDE_WINDOW),
        positionState: async () => [holding({ requested_size: 0.4, filled_size: 0.4 })],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.size).toBe(0.4);
  });
});
