/**
 * #941 — `whole_share_sizing`, the venue's quantity grid applied to the entry.
 *
 * The constraint is MEASURED, not assumed. Probed live against
 * `paper-api.alpaca.markets` on 2026-08-30: a bracket order at any fractional
 * quantity is refused `422 42210000 fractional orders must be simple orders`
 * — long and short alike — and a fractional short is refused outright even as
 * a plain limit (`fractional orders cannot be sold short`). The same order at a
 * whole-share quantity, short included, is accepted. ADR-0018 D5 sizes by CASH,
 * so nearly every intent it produces is fractional, and two of the paper soak's
 * three entries were rejected at submission for exactly this.
 *
 * The worked example every size assertion below is pinned to, under
 * `DEFAULT_TRADER_CONFIG` with ATR = 2 and entry = 100:
 *   stop distance  = atr_k (2) x ATR (2)                        = 4
 *   conviction     = (0.775 - 0.55) / (1 - 0.55)                = 0.5
 *   base risk      = max_risk_per_trade (0.01) x 1.0 x 0.5      = 0.005
 *   risk fraction  = 0.005 x 1 (converged) x 0.75 (no precedent) = 0.00375
 *   size           = equity x 0.00375 / 4
 * At `EQUITY` that is 93.75 shares — deliberately fractional, so the floor has
 * something to bite on and a test that silently stopped exercising it would
 * fail rather than pass vacuously.
 */
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
/** `EQUITY x 0.00375 / 4` — see the header's worked example. */
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
    // The direction of the rounding is the whole point. Rounding to nearest
    // would submit MORE than the deployment D5 sized and more than the caps
    // the Risk Manager is about to approve against, turning a venue
    // accommodation into an unrecorded amendment of ADR-0018 D5. 93.75 is the
    // adversarial value precisely because nearest-rounding takes it UP.
    const intent = await decide(traderInput());

    expect(intent?.size).toBeLessThan(UNQUANTISED_SIZE);
    expect(intent?.size).not.toBe(94);
  });

  it('floors the SHORT side toward zero exposure too, not away from it', async () => {
    // `size` is unsigned — direction lives in `side` — so a naive `Math.trunc`
    // and a naive `Math.round` diverge here in opposite ways. A short floored
    // upward is a larger short, i.e. the same envelope breach as a long
    // rounded up, and it is the side the venue refuses outright when
    // fractional, so it is the side most likely to be special-cased wrongly.
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
    // The reason the flag exists rather than the floor being unconditional:
    // flooring changes the FILL SIZE, so switching it on globally would move
    // every backtest and fixture result and make runs on either side of #941
    // incomparable.
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
    // Presence must mean "this intent under-deploys D5", not merely "the flag
    // is on" — otherwise the field cannot be used to find the shortfall. At
    // 4x the equity the size is exactly 375, already on the grid.
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
  /** `1_000 x 0.00375 / 4` = 0.9375 shares, i.e. $93.75 of intended notional. */
  const SUB_ONE_SHARE_EQUITY = 1_000;

  it('skips as rounds_to_zero_shares rather than submitting a zero quantity', async () => {
    const outcome = await decideWithReason(
      traderInput({ equity: async () => SUB_ONE_SHARE_EQUITY }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('rounds_to_zero_shares');
  });

  it('is NOT caught by the dust floor — the intended notional clears it comfortably', async () => {
    // The reason this needs its own guard rather than falling through to
    // `min_viable_notional`: 0.9375 shares of a $100 name is $93.75 of
    // intended notional against a $10 dust floor. Left to that check it would
    // pass, and a zero quantity would go to the venue.
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
    // A conviction exactly at the floor gives a multiplier of 0 and a size of
    // exactly 0. That is the strategy declining to deploy, not the venue's
    // grid eating a real position, and conflating the two would make a damped
    // gate indistinguishable in a soak log from a sizing/universe mismatch.
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
    // Under this flag every entry fills whole, so a fractional holding should
    // not arise — but one CAN survive from a lot opened before the flag, and a
    // flatten that floored it would strand 0.5 shares overnight, which is the
    // one thing ADR-0014's flat-by-close horizon forbids.
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
    // The failure mode with teeth: a 0.4-share residual floored to zero is not
    // a smaller exit, it is NO exit, and the position carries overnight while
    // the log records a clean flatten decision.
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
