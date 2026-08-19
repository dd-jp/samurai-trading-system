/**
 * Trader core decision tests (ticket #73) — the no-position entry path.
 * Tested at the `decide(input)` seam per docs/specs/trader-spec.md (Testing
 * Decisions): a DebateResult + a fixture MarketDataService + a mock clock,
 * asserting on the returned OrderIntent (or null). There is no LLM to mock.
 */
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
  recommendedWarmupFor,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock, OpenPosition } from '../../shared/index.js';
// #748: the early exit reads the analyst's own momentum specs, so the tests pin
// THOSE rather than hand-rebuilt copies that would keep passing on drift.
import { MACD_SPEC, RSI_SPEC } from '../analysts/technical-analyst.js';
import type { DebateResult } from '../debate-engine/index.js';
import {
  atrIndicatorSpec,
  checkExitsWithReason,
  decide,
  decideWithReason,
  type ExitCheckInput,
} from './decide.js';
import { FixtureSetupStore } from './fixture-setup-store.js';
// Imported so the #687 cases can state WHICH bar the key must be on, rather
// than only comparing two `decide()` calls against each other — two calls that
// re-derive the same wrong bar agree with one another perfectly.
import { computeIdempotencyKey } from './idempotency-key.js';
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
/** The next hour on the debate's grid — bar N+1 to `DECISION_BAR`'s N (#687). */
const NEXT_BAR = new Date('2026-07-15T11:00:00Z');
const ENTRY_PRICE = 100;
const EQUITY = 100_000;

/**
 * Bars whose true range is exactly `trueRange` on every candle, so ATR is
 * exactly `trueRange` and the sizing arithmetic in these tests is checkable
 * by hand. TR = max(high-low, |high-prevClose|, |prevClose-low|) = high-low
 * when closes are flat.
 */
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

/** Serves a fixed bar window and mark — the Trader's only data dependency. */
class FixtureMarketData implements MarketDataService {
  /**
   * The window `decide` last ASKED for. Recorded, not just ignored, because
   * the fetch width is itself a correctness property: `decide.ts` requests
   * `atr_lookback + 1` bars precisely so `computeIndicator`'s `atr` stays a
   * plain mean, and a wider request would engage Wilder smoothing and move
   * every stop in the system. Serving fixed bars regardless of the request
   * means nothing else in this file can observe that regression.
   */
  requestedWindow: BarWindow | undefined;

  /**
   * What `getMark` reports as `observed_at`.
   *
   * Defaults to `DECISION_BAR` — a value already ON the bar grid, which is
   * exactly the shape the BACKTEST source produces and exactly why #616 stayed
   * invisible here. In paper and live this is the venue's latest-quote wire
   * timestamp at millisecond resolution and moves every tick, so a fixture
   * that can only sit on the grid cannot express the production case.
   */
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

  /**
   * #289 H8: the batch form, over this double's own `getMark`. Shared
   * `collectMarks` rather than a hand-rolled loop so a double cannot express a
   * partial-failure policy the real service does not have.
   */
  async getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
  }

  /**
   * The three `MarketDataService` members `decide` must never reach for, and
   * the reason they are present at all: the `implements` clause above went
   * unchecked until `tsconfig.test.json` existed, so this double claimed to
   * satisfy a five-method port while supplying two.
   *
   * They throw rather than return a plausible value on purpose. `decide.ts`
   * deliberately fetches bars and computes the ATR itself instead of routing
   * through `getIndicator`, because `getIndicator` hardcodes its own
   * timeframe and would silently pin ATR to 1h whatever `atr_timeframe`
   * says — see the comment at that call site. A stub returning a number
   * would let that regression back in quietly; one that throws fails the
   * suite the moment `decide` starts using it.
   */
  /**
   * #748: the tick path's early exit DOES read `getIndicator` — the momentum
   * axis — so this can no longer throw unconditionally. It still throws for
   * `atr`, which is the regression the original guard exists to catch, and it
   * throws for any kind no case configured, so a new indicator read cannot
   * arrive silently on a plausible stub value.
   */
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
    // #687: the bar the Debate stage floored and hashed into `debate_id`. Equal
    // to `DECISION_BAR` by default so every key expectation below is unchanged
    // — but it now comes from the DEBATE, not from flooring the clock, which is
    // what the straddle cases at the end of this suite turn on.
    bar_timestamp: DECISION_BAR,
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
    // #568: no exit fill on record for any lot — "missing is absent", so held
    // quantity is `filled_size`, which is what every pre-#568 case here means.
    exitFillSizes: async () => new Map<string, number>(),
    setupStore: new FixtureSetupStore(),
    // #668. The real calendars, not stubs — DECISION_BAR is 10:00 UTC (06:00
    // ET), ten hours from the 16:00 ET close, so every pre-#668 case here sits
    // far outside the flatten window and is unaffected. The flat-by-close cases
    // below move the clock instead of swapping the calendar, which is what makes
    // them exercise the boundary the production path actually resolves.
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

/**
 * The worked example the size assertions below are pinned to, under
 * DEFAULT_TRADER_CONFIG with ATR = 2 and entry = 100:
 *   vol floor      = 0.002 x 100 = 0.2, so ATR (2) governs
 *   stop distance  = atr_k (2) x 2 = 4
 *   conviction     = (0.775 - 0.55) / (1 - 0.55) = 0.5
 *   base risk      = 0.01 x 1.0 (stocks) x 0.5 = 0.005
 *   risk fraction  = 0.005 x 1 (converged) x 0.75 (no precedent) = 0.00375
 *   size           = (100_000 x 0.00375) / 4 = 93.75
 */
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

    const low = await sizeAt(0.6625); // conviction multiplier 0.25
    const mid = await sizeAt(0.775); //  conviction multiplier 0.50
    const high = await sizeAt(1.0); //   conviction multiplier 1.00

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
    // ATR, entry, conviction, and equity are identical across the two runs —
    // only asset_class differs — so nothing but the risk multiplier can
    // account for the difference.
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

/**
 * `time_in_force` is a venue constraint, not a tuning knob, and the two venues
 * disagree (#381). Alpaca's crypto endpoint accepts `gtc`/`ioc` and rejects
 * `day`; equities take `day`. With a universe spanning both, a single value
 * guarantees that one asset class has every order rejected at submission —
 * which looks like a strategy that never trades, not like a config error.
 */
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
    // Swap the two values and the stamped result must swap too. A resolver
    // that ignored `asset_class` — or one left reading a flat field — answers
    // identically for both and fails here.
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
    // ATR 0.02 sits far below the floor of 0.002 x 100 = 0.2, so the floor
    // governs the stop and caps how large ultra-low vol can inflate size.
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

/**
 * ATR is computed by the Market Data Service now (#304), so the only ATR
 * input Trader still controls is the BAR WINDOW it asks for. These pin that
 * window. Both assertions use a NON-default config on purpose: at
 * `DEFAULT_TRADER_CONFIG` the expected values (`1h`, `recommendedWarmupFor`
 * of `atr_lookback = 14`) coincide with the `DEFAULT_INDICATOR_TIMEFRAME`
 * that `getIndicator` hardcodes, so a default-config assertion would pin two
 * coincidences instead of two relationships.
 */
describe('decide — ATR bar window (#304, #757)', () => {
  it('fetches the CONVERGED ATR width, not the atr_lookback + 1 arity floor (#757)', async () => {
    // Until #757 this fetched exactly `atr_lookback + 1` bars — one true
    // range past the seed, so `computeIndicator`'s `atr` smoothing loop ran
    // ZERO times in production and the value was a plain mean wearing
    // Wilder's name (the same warm-up gap #722 fixed for `RSI_SPEC`).
    // Measured before adopting (median relative shift 3.0%, p90 6.9% against
    // a declared median<=15%/p90<=30% gate,
    // `docs/reviews/indicator-characterisation-2026-08-16.md` F1) and cleared
    // it, so the fetch now asks for `recommendedWarmupFor` instead — see
    // `atr-equivalence.test.ts` for the algorithmic half (still pinned at the
    // historical `atr_lookback + 1` width, which is no longer what production
    // requests).
    //
    // The assertion here is on the REQUEST, not the resulting ATR: the
    // fixture serves its 15 bars whatever it is asked for, so the value
    // computed on this path is not the one production would see. The
    // request width is the only half a fixture can pin.
    const marketData = new FixtureMarketData(bars(15, 2));

    await decide(traderInput({ marketData, config: configWith({ atr_lookback: 7 }) }));

    expect(marketData.requestedWindow?.lookback).toBe(
      recommendedWarmupFor(atrIndicatorSpec(7, DEFAULT_TRADER_CONFIG.atr_timeframe)),
    );
    expect(marketData.requestedWindow?.lookback).toBe(29);
  });

  it('fails loudly if getBars serves a descending window, rather than mispricing the stop', async () => {
    // Trader stopped re-sorting defensively when #304 moved ATR to MDS, so
    // ascending order became a trusted contract of `MarketDataService.getBars`.
    // Trust without enforcement is a silent misprice: reversed bars yield a
    // plausible ATR, not an error, and every stop sized from it is wrong.
    // `computeIndicator` asserts the order, so a broken source costs one
    // logged tick (production.ts's tick loop catches it) instead of live
    // money. This pins that Trader's path really is covered by that assertion.
    const descending = [...bars(15, 2)].reverse();

    await expect(
      decide(traderInput({ marketData: new FixtureMarketData(descending) })),
    ).rejects.toThrow(/ascending by close_time/);
  });

  it('fetches on config.atr_timeframe, not the indicator default', async () => {
    // Why `decide.ts` calls `computeIndicator` on its own bar slice instead
    // of `marketData.getIndicator`: `IndicatorSpec` has no timeframe, so
    // `getIndicator` would pin ATR to its hardcoded 1h whatever this config
    // says (#315). That justification is only worth anything if a non-1h
    // timeframe actually reaches the fetch — which is what this asserts.
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
    // Equity 100 yields a notional of 9.375, just under the 10 minimum.
    const intent = await decide(traderInput({ equity: async () => 100 }));

    expect(intent).toBeNull();
  });

  it('returns null when there is not enough history to compute ATR', async () => {
    const intent = await decide(traderInput({ marketData: new FixtureMarketData(bars(1, 2)) }));

    expect(intent).toBeNull();
  });

  it('returns null on an empty bar window rather than sizing off NaN', async () => {
    // A cold instrument with nothing ingested yet. Since #319
    // `computeIndicator` THROWS on a window this short rather than answering
    // NaN, so `atrFor`'s length pre-check is what turns that into Trader's
    // existing skip instead of a rejected tick. Before #304 the same window
    // produced a NaN that defeated every downstream guard (`stopDistance <=
    // 0` and the min-notional check are both false against NaN) and reached
    // an emitted intent; either way the skip has to happen before an intent
    // is built.
    const intent = await decide(traderInput({ marketData: new FixtureMarketData(bars(0, 2)) }));

    expect(intent).toBeNull();
  });

  it('returns null when the computed ATR is not finite, rather than sizing off NaN', async () => {
    // The bar-count guard only covers the EMPTY-SEED path to NaN. A corrupt
    // feed — one bar with a non-numeric high/low — produces a NaN true range
    // on a perfectly well-sized window, and NaN then defeats every guard
    // downstream of `atrFor`: `Math.max(NaN, volFloor)` is NaN,
    // `stopDistance <= 0` is false against NaN, and `size * entry <
    // min_viable_notional` is false too. Without the finiteness check this
    // emits a live OrderIntent with NaN size, stop AND target.
    const corrupt = bars(15, 2);
    // biome-ignore lint/style/noNonNullAssertion: fixed-length fixture built two lines above.
    corrupt[7]!.high = Number.NaN;

    const intent = await decide(traderInput({ marketData: new FixtureMarketData(corrupt) }));

    expect(intent).toBeNull();
  });

  it('returns null when the mark price is not finite, rather than pricing off NaN', async () => {
    // The sibling case to the corrupt-ATR test above, on the input that was
    // NOT defended: the ATR is fine and the bars are fine, but the QUOTE is
    // corrupt. `AlpacaHttpDataClient` casts the wire body
    // (`as CryptoLatestQuoteResponse`) without validating that `ap`/`bp` are
    // numbers, so a null field arrives here as a NaN `mark.price`.
    //
    // NaN then defeats the same three guards the ATR comment lists —
    // `Math.max(atr, NaN)` is NaN, `stopDistance <= 0` is false, `size *
    // entry < min_viable_notional` is false — and lands in an EMITTED intent
    // whose entry, stop AND target are all NaN.
    const intent = await decide(
      traderInput({ marketData: new FixtureMarketData(bars(15, 2), 'stocks', Number.NaN) }),
    );

    expect(intent).toBeNull();
  });

  it('returns null when equity is not finite, rather than sizing off NaN', async () => {
    // The third NaN inlet. `equity` is supplied by the caller from an account
    // read, so a malformed broker response reaches sizing the same way a
    // malformed quote reaches pricing. `size` is the choke point every
    // numeric input funnels through — guarding it covers this case and any
    // later one, which the per-input `entry` check alone would not.
    const intent = await decide(traderInput({ equity: async () => Number.NaN }));

    expect(intent).toBeNull();
  });

  it('skips one bar short of the ATR width and trades at exactly that width (#319)', async () => {
    // Both sides of the boundary `atrFor` now sits on, in one test because
    // neither half means anything alone.
    //
    // The SKIP side is the behaviour change #319 bought. This used to trade
    // on TWO bars: `computeIndicator`'s `atr` divides by `seedRanges.length`,
    // so a 2-bar window answered a single true range and Trader labelled it
    // ATR(14) and sized a live stop off it. Every width from 2 to
    // `atr_lookback` was that same fabrication, differing only in how many
    // ranges it averaged. `atr_lookback` bars — one short — must now skip.
    //
    // The TRADE side stops the guard being over-tightened: a freshly warmed
    // instrument at exactly `atr_lookback + 1` bars yields exactly
    // `atr_lookback` true ranges, which is a genuine ATR(14), and must still
    // trade. It produces the same intent as the default fixture because
    // `bars()` gives every candle an identical true range.
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
    // The crash-restart case: the same bar re-decided at a later wall-clock
    // moment must produce the same key, or Execution would place a second order.
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

  /**
   * #616 — the LIVE/PAPER case, which no test exercised before.
   *
   * The suite above passes because `FixtureMarketData` reports `observed_at`
   * already on the bar grid, which is what the BACKTEST source really does. In
   * paper and live it is the venue's latest-quote wire timestamp at millisecond
   * resolution and moves on every tick, and the mark cache cannot bridge ticks
   * (`markTtlMs` 5s against a 15-minute tick). The key therefore changed every
   * pass, and `findByKey`, the `open_positions` PK and the broker
   * `client_order_id` were all inert in exactly the two modes that place real
   * orders.
   *
   * This test fails against the pre-#616 `decisionBar = mark.observed_at`.
   */
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
    // And the coordinate is the bar itself, which is what makes it the same
    // value `debate_id` hashes.
    expect(sameBarLater?.decision_timestamp).toEqual(DECISION_BAR);
  });

  /**
   * The same live case on the EXIT path. Every test above enters, and #616 was
   * itself a live path no test exercised — so leaving the exit uncovered here
   * would repeat the defect's own shape.
   *
   * A suppressed exit is the worse half of the two. A suppressed ENTRY is a
   * trade not taken; a suppressed EXIT leaves filled exposure on the venue with
   * the flatten silently swallowed by `findByKey`, the `open_positions` PK or
   * the broker `client_order_id`, and `trader_log` records it as a skip.
   *
   * Note what this test PINS rather than blesses: within one bar the exit key is
   * stable, which is the #616 fix. That the entry and the exit for one
   * instrument in one bar share that key is the SEPARATE defect #686 — this
   * asserts tick-to-tick stability, not that the key space is adequate.
   */
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
  });

  it('still separates two different bars', async () => {
    const nextBar = new FixtureMarketData(bars(15, 2));
    nextBar.markObservedAt = new Date('2026-07-15T11:03:00Z');

    const first = await decide(traderInput());
    const next = await decide(
      traderInput({
        // #687: the bar comes from the DEBATE now, so a genuinely new bar is a
        // new DEBATE. Moving only the clock would no longer be a new bar — it
        // would be the same debate re-decided late, which is precisely the
        // straddle this ticket stopped mis-keying.
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

  /**
   * #687 — THE BOUNDARY STRADDLE, on the entry path.
   *
   * The debate is keyed to bar N (`bar_timestamp`), and the Trader runs after
   * the hour boundary, in bar N+1. Before this ticket `decisionBarFor` floored
   * its OWN `clock.now()`, so the intent was keyed to N+1 while its `debate_id`
   * said N — and bar N+1's own genuine decision, when it arrived, computed the
   * key the straddling intent had already taken and was suppressed as a
   * duplicate by `findByKey` / the `open_positions` PK / the broker
   * `client_order_id`.
   *
   * The expectation is written against `computeIdempotencyKey` directly rather
   * than against another `decide()` call, so it is an independent statement of
   * WHICH bar the key must be on. Reverting to a floored clock read makes this
   * fail: the key would be bar N+1's.
   */
  it('#687: keys a straddling debate to the debate bar, not the bar the Trader ran in', async () => {
    const lateTick = new FixtureMarketData(bars(15, 2));
    lateTick.markObservedAt = new Date('2026-07-15T11:07:42.310Z');

    const straddled = await decide(
      traderInput({
        // Bar N — the debate started here and is logged here.
        debate: debateResult({ bar_timestamp: DECISION_BAR }),
        marketData: lateTick,
        // Bar N+1 — the LLM round-trips crossed the boundary.
        clock: new ManualClock(new Date('2026-07-15T11:07:42.310Z')),
      }),
    );

    expect(straddled?.idempotency_key).toBe(
      computeIdempotencyKey(INSTRUMENT, DECISION_BAR, 'open'),
    );
    expect(straddled?.decision_timestamp).toEqual(DECISION_BAR);
  });

  /**
   * The same straddle on the EXIT path, which hashes `'close'` rather than
   * `'open'` and reaches `computeIdempotencyKey` through a second call site in
   * `buildExitIntent`. A fix applied to one of the two would leave the flatten
   * — the more expensive half — still splitting from its debate.
   */
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

  /**
   * The other half of #687, and the reason the straddle mattered at all: bar
   * N+1's own genuine decision must still get its own key. If the straddling
   * intent above had taken N+1's key, this order would be the one suppressed —
   * and a suppressed order looks like a skip.
   */
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

  /**
   * And the suppression the key space exists for is intact: a TRUE duplicate —
   * the same bar's decision re-run at a later wall-clock moment, which is the
   * crash-replay case — still collapses onto one key.
   */
  it('#687: a true duplicate of the same bar still computes one key', async () => {
    const replayed = new FixtureMarketData(bars(15, 2));
    replayed.markObservedAt = new Date('2026-07-15T10:58:03.941Z');

    const first = await decide(traderInput());
    const replay = await decide(
      traderInput({
        // Same debate, same bar — a re-decide, not a new decision.
        debate: debateResult({ bar_timestamp: DECISION_BAR }),
        marketData: replayed,
        clock: new ManualClock(new Date('2026-07-15T10:58:03.941Z')),
      }),
    );

    expect(replay?.idempotency_key).toBe(first?.idempotency_key);
    expect(replay?.idempotency_key).toBe(computeIdempotencyKey(INSTRUMENT, DECISION_BAR, 'open'));
  });

  it('keys on the debate bar grid, not on atr_timeframe', async () => {
    // The decision bar is the DEBATE's bar by definition — it is what makes the
    // idempotency key and `debate_id` the same coordinate. `atr_timeframe` is a
    // separate, independently tunable knob (the window the ATR is measured
    // over), and tying the order-dedup coordinate to a risk-tuning setting
    // would be #616 inverted: a finer grid collapses several decision bars onto
    // one key, and the suppressed orders look exactly like skips.
    const fine = await decide(traderInput({ config: configWith({ atr_timeframe: '15m' }) }));
    const coarse = await decide(traderInput());

    expect(fine?.decision_timestamp).toEqual(DECISION_BAR);
    expect(fine?.decision_timestamp).toEqual(coarse?.decision_timestamp);
  });
});

/**
 * #668 — ADR-0014's "intraday, flat by market close, no overnight carry".
 *
 * 2026-07-15 is a Wednesday; the US close is 20:00 UTC (16:00 EDT), so the
 * default 5-minute window opens at 19:55 UTC.
 */
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

  /**
   * The ordering assertion, and the reason the check sits above every other
   * holding branch. `neutral` was 92 of the 94 debates in the soak — if the
   * neutral skip ran first it would suppress the flatten on almost every tick
   * and carry the book overnight, which is the exact failure the rule exists
   * to prevent.
   */
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

  /**
   * #847 — THE SIZING READ MUST NOT GATE THE FLATTEN.
   *
   * `TraderInput.equity` is a thunk backed by a whole-book valuation that
   * REFUSES when any held instrument's mark is dark or stale. Until #847 the
   * composition root resolved it eagerly, before `decide` was even called, so
   * one dark name anywhere in the book aborted the whole decision pass before
   * `routeDecision` could reach the flat-by-close branch — the flatten was
   * delayed to the next tick, against ADR-0014.
   *
   * The thunk here throws if it is invoked at all, so this goes red the moment
   * anyone re-eagers the read inside `decide`: an exit sizes to the held
   * quantity and must never consult equity.
   */
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

  /**
   * The other half of #847, and the costlier regression of the two. An ENTRY
   * is sized off equity, and every exposure cap reads an absent instrument as
   * ZERO exposure — so a refusal must stay a refusal here. It propagates as a
   * throw (aborting the tick into `tick-loop.ts`'s `error` catch, #507) rather
   * than becoming a quiet `skip_reason`, exactly as the eager read did.
   */
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

  /**
   * #668 is explicit that a crypto flatten must NOT be implemented ahead of
   * #667, which is David's thesis amendment. `AlwaysOpenCalendar.sessionEnd`
   * returns null and the rule declines to act, rather than inventing one of
   * #667's four options.
   */
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

  /**
   * The rule follows the INSTRUMENT'S venue, not the runtime mode. #656
   * measured LSE 08:00-16:30 London against US 14:30-21:00 UTC — only two
   * hours of overlap — so a shared wall-clock constant would be wrong for one
   * leg. At 19:56 UTC the LSE has been shut for hours; its next close is the
   * following day, so this instant is nowhere near ITS window.
   */
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
    // 16:26 London in July (BST) = 15:26 UTC, inside the 15:25 window.
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

  /**
   * #691 — the flatten window's two edge inputs, asserted through `decide`
   * rather than against the helper, because the helper is private and because
   * the point is what the MONEY PATH does.
   *
   * The two are NOT equivalent, and the difference is worth stating up front so
   * nobody reads more into the first pair than they should:
   *
   * - A past close (below) already flattened before this change. Those two
   *   tests pass against the old code and are characterisation, not regression
   *   guards.
   * - A non-positive `flatten_before_close_ms` genuinely did nothing and now
   *   throws. That one is a real behaviour change, and it fails against the
   *   old code.
   *
   * Neither is reachable through the two calendars in this tree or the shipped
   * config — both calendars compare `close > instant`, and the default window
   * is 5 minutes. That was the old argument for leaving them unchecked, and it
   * is an argument about the current implementers rather than about the seam:
   * both the calendar map and the config are injected.
   */
  it('flattens rather than holding when the calendar reports a close already past', async () => {
    // CHARACTERISATION, not a regression guard — and deliberately kept as one.
    // This passes against the pre-#691 code too, because `remaining <= window`
    // was already true for every negative `remaining`. What it pins is that
    // flattening is the INTENDED answer here rather than an accident of the
    // comparison, so a later "tidy-up" that makes a past close return false —
    // or throw, which was this change's first cut — fails a test that says why.
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
    // The same answer read on the entry path: "inside the window" means open
    // nothing. Together with the flatten above this is what makes a
    // permanently-wrong calendar park the book flat and stop, rather than loop.
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

  /**
   * #698. The behaviour above is unchanged and these do not re-test it — what
   * they pin is that the conditions are now AUDIBLE, which is the whole ticket.
   * Each of these was previously indistinguishable from a healthy quiet tick.
   */
  it('reports a stale session close as a diagnostic, on the same pass that exits (#698)', async () => {
    // The load-bearing case for the diagnostic's placement: this path returns an
    // INTENT, not a skip. A diagnostic modelled as a variant of `skip_reason`
    // could not have reported it, which is why `TraderOutcome.diagnostics` is
    // orthogonal to the intent/skip pair rather than a third alternative.
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
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'session_end_in_past',
    ]);
    expect(outcome.diagnostics[0]?.asset_class).toBe('stocks');
  });

  it('reports a non-crypto calendar that cannot resolve a session end at all (#698)', async () => {
    // The silent case the ticket names: `null` is the DOCUMENTED answer for
    // crypto and a broken calendar for anything else, and both returned the
    // identical `false` with nothing marking the difference — so an equity leg
    // whose calendar had stopped resolving sessions never flattened and carried
    // overnight against ADR-0014.
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

    // Unchanged behaviour: no session end means not inside the window, so the
    // holding path falls through to its ordinary neutral skip.
    expect(outcome.intent).toBeNull();
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'session_end_absent_on_non_crypto',
    ]);
  });

  it('stays silent when CRYPTO has no session end, which is the intended answer (#698)', async () => {
    // `AlwaysOpenCalendar` returns null by design — a venue that never closes.
    // Alerting on it would fire on every crypto tick forever, which is how an
    // operator learns to mute a channel that also carries breach alerts
    // (ADR-0008 §1). The diagnostic is keyed to the ASSET CLASS for this reason.
    const outcome = await decideWithReason(
      traderInput({
        debate: debateResult({ direction: 'neutral' }),
        positionState: async () => [holding({ asset_class: 'crypto' })],
      }),
    );

    expect(outcome.diagnostics).toEqual([]);
  });

  it('leaves diagnostics empty on an ordinary healthy decision (#698)', async () => {
    // The case that must stay quiet, and the one that would make the channel
    // useless if it did not: the overwhelmingly common tick.
    const outcome = await decideWithReason(traderInput());

    expect(outcome.intent).not.toBeNull();
    expect(outcome.diagnostics).toEqual([]);
  });

  it('reports corrupt bar data that yields a non-finite ATR (#698)', async () => {
    // The third kind, and the one whose REACHABILITY had to be established
    // rather than assumed. `computeIndicator` throws on a short window and on a
    // misordered one, so the natural reading is that it throws here too and the
    // `Number.isFinite` else-branch is dead code — a mechanism nothing can call,
    // which is this repo's dominant defect class. It is not: `assertAscending`
    // checks `close_time` only, and `atr()` is plain arithmetic over the price
    // legs, so a non-finite price PROPAGATES to the return value instead of
    // raising. This test is what keeps that true.
    const corrupt = bars(15, 2).map((bar, index) =>
      index === 7 ? { ...bar, high: Number.NaN } : bar,
    );

    const outcome = await decideWithReason(
      traderInput({ marketData: new FixtureMarketData(corrupt) }),
    );

    // Unchanged behaviour: a stop cannot be priced off an ATR that does not
    // exist, so the tick still skips — it is now merely audible while doing it.
    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('atr_not_finite');
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(['atr_not_finite']);
  });

  it('does NOT see a broken calendar while the book is flat — the known limitation (#698)', async () => {
    // Pinned as a test rather than left as prose in the PR, because it is the
    // DOMINANT state and not an edge: #625 recorded 96 debates and 0 trades, so
    // the book is flat and the debate neutral on almost every tick, and
    // `routeDecision` answers `neutral_direction_while_flat` before any calendar
    // is consulted. A calendar that has stopped resolving sessions is therefore
    // invisible until a position exists — which is exactly the tick where it
    // starts to cost something.
    //
    // Left as-is deliberately: the asset class is not on `TraderInput` and is
    // reached through `getMark`, so covering this path means adding a vendor
    // fetch to the most frequent branch in the system. That is a behaviour
    // change, and #698 asked for audibility without one. Tracked in the PR.
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
    // Zero is the dangerous value, not negative: it reads like "no offset" and
    // is what someone reaches for to "turn the window off", when what it
    // actually turns off is ADR-0014's flat-by-close rule entirely — silently,
    // and only visibly as positions carrying overnight.
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

  /**
   * #686 — the regression this file previously pinned as a KNOWN GAP.
   *
   * `computeIdempotencyKey` was keyed on `(instrument, bar)` alone. Since #616
   * the bar is stable across every tick inside it, and bars are 1h while
   * `flatten_before_close_ms` is 5 minutes — so an entry taken earlier in the
   * session's LAST bar and the mandatory flat-by-close exit in that same bar
   * produced the SAME key.
   *
   * That key is what `findByKey`, the `open_positions` primary key and the broker
   * `client_order_id` all dedupe on, so the flatten was the one that lost: a
   * suppressed mandatory exit leaves the book carrying a position overnight,
   * which ADR-0014 forbids and which #668 exists to prevent.
   *
   * Neither change caused it alone — #616 made keys stable within a bar, #668 put
   * a second intent in the bar — which is why it appeared only once both landed.
   *
   * The assertion is now `not.toBe`. Both halves are kept: the intents must still
   * be the entry and the exit (otherwise the test could pass by the flatten
   * simply not firing, which is the failure it exists to catch).
   */
  it('keys a same-bar entry and the mandatory flatten separately (#686)', async () => {
    // 19:50 and 19:56 UTC both floor to the 19:00 bar; only 19:56 is inside the
    // 5-minute flatten window, so the entry is legal and so is the flatten.
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
    // Closing a long is a sell, flattening the combined filled exposure of every lot.
    expect(intent?.side).toBe('sell');
    expect(intent?.size).toBe(75);
  });

  // #568: the lot stays OPEN after a partial flatten (`getOpenPositions()`
  // excludes only terminal states) and its `filled_size` is the entry total
  // that no exit fill ever reduces. Sizing the next exit off it sold the
  // original quantity into a venue holding only the residual — 4 short of a
  // 10-lot flattened by 4 is a REVERSE position, with no lot, no bracket and
  // no protective leg.
  it('sizes an exit to what the venue still holds after a partial flatten, not the original filled size', async () => {
    const partiallyFlattened = openPosition({ side: 'buy', filled_size: 10 });
    const debate = debateResult({ direction: 'bearish', confidence: 0.9, converged: true });

    const intent = await decide(
      traderInput({
        debate,
        positionState: async () => [partiallyFlattened],
        // 4 of the 10 already closed by an earlier partial flatten.
        exitFillSizes: async () => new Map([[partiallyFlattened.idempotency_key, 4]]),
      }),
    );

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.size).toBe(6);
  });

  it('holds (null) rather than exiting a lot whose exit fills already cover it', async () => {
    // Flat at the venue but not yet marked terminal — the close lands on the
    // next `ingestFills()` poll. There is nothing left to sell in between, so
    // emitting an exit here would be the same oversell in miniature.
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
    // Rose past the older lot's conviction (0.5) but not past the newer
    // lot's (0.7) by the required delta — should hold, not scale_in.
    const debate = debateResult({ direction: 'bullish', confidence: 0.75, converged: true });

    const intent = await decide(
      traderInput({ debate, positionState: async () => [olderLot, newerLot] }),
    );

    expect(intent).toBeNull();
  });
});

/**
 * #432. The mechanism (#75) and the store (#198) both existed; `decide` called
 * neither, so every intent carried a hardcoded 0.75x and `cosine_setups` stayed
 * empty for the life of the process. These pin the two call sites.
 */
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
    // `decide` runs the same path in live and in replay (ADR-0003), and a
    // crash-restart re-decides the bar it died on. `debate_id` is a hash of the
    // debate's inputs, so the second pass writes the same key; a store that
    // threw there would take the tick down.
    const setupStore = new FixtureSetupStore();

    await decide(traderInput({ setupStore }));
    await expect(decide(traderInput({ setupStore }))).resolves.not.toBeNull();

    expect(setupStore.getWritten()).toHaveLength(1);
  });

  it('writes NO setup when the decision is a skip', async () => {
    const setupStore = new FixtureSetupStore();
    // Below the conviction floor: no intent, so nothing for the Feedback Loop
    // to ever label. A row written here would sit unlabelled forever.
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
    // The neighbor is the vector this exact setup produces, so similarity is
    // 1.0 by construction — taken from a first run rather than hand-built, so
    // the test cannot drift away from the real feature layout.
    const probe = new FixtureSetupStore();
    const baseline = await decide(traderInput({ setupStore: probe }));
    const vector = probe.getWritten()[0]?.vector;
    if (vector === undefined) throw new Error('probe run wrote no setup');

    const withPrecedent = new FixtureSetupStore([
      { vector, r_multiple: 2, closed_at: new Date('2026-07-14T10:00:00Z') },
    ]);
    const intent = await decide(traderInput({ setupStore: withPrecedent }));

    // r_multiple 2 saturates the multiplier to its 1.5x bound.
    expect(intent?.metadata.sizing.cosine_multiplier).toBe(1.5);
    expect(intent?.metadata.cosine_precedent).toEqual({
      neighbor_count: 1,
      weighted_mean_r: 2,
      no_precedent: false,
    });
    // Applied, not merely recorded — multiplicative stacking is a spec
    // invariant, so the size must move with the multiplier.
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
  /**
   * Every skip path, named. Until #475 `trader_log.skip_reason` recorded the
   * constant `'decide() returned no intent'` for all of them, so a soak could
   * not tell "the conviction floor is too high" from "the market data feed is
   * returning NaN marks". These assertions are what stop a future skip path
   * from being added without a name of its own.
   */

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
    // Null, not the ATR: the skip fired before any ATR was computed. "How far
    // did it get" is half the value of the row.
    expect(outcome.atr).toBeNull();
  });

  it('too few bars to compute an ATR', async () => {
    // Benign — a warm-up or a data gap, expected early in a soak, and
    // deliberately distinct from a non-finite ATR, which never is.
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
    // The opposite-side path reaches the exit builder, which has nothing to
    // flatten because the lot is still pending at the venue.
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

  // #568 review: an over-exited lot netting a positive sibling to <= 0 is the
  // SAME failure the held-quantity fix closes — a negative hiding inside a
  // total that looks benign. Here it would suppress the exit the sibling
  // genuinely needs, and `executeExit`'s loud refusal never runs because no
  // order is emitted for it to refuse, so this reason is what makes it
  // visible at all.
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
        // 14 closed against an entry of 10 → held -4, which nets the
        // sibling's real +4 to exactly zero.
        exitFillSizes: async () => new Map([['lot-over-exited', 14]]),
      }),
    );

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('exit_held_quantity_diverged');
  });

  it('reports no reason at all when an order was produced', async () => {
    // The other half of the contract: a successful decision must not carry a
    // skip reason, or a soak query counting skips would double-count trades.
    const outcome = await decideWithReason(traderInput());

    expect(outcome.intent).not.toBeNull();
    expect(outcome.skip_reason).toBeNull();
  });

  it('carries the ATR the stop was priced from', async () => {
    // #475's other half: `trader_log.atr` was a hardcoded null while the value
    // sat inside `buildBracket`. It is what explains a stop distance.
    const outcome = await decideWithReason(traderInput());

    expect(outcome.atr).toBe(2);
    expect(outcome.intent?.entry).toBe(ENTRY_PRICE);
  });

  it('reports the scale_in ATR, not a stale one from the entry path', async () => {
    // `buildBracket` serves entry AND scale_in, and the reported `atr` must be
    // the one THIS call priced its stop from. Pinned with a different true
    // range from the default fixture so a stale or defaulted value cannot pass.
    const outcome = await decideWithReason(
      traderInput({
        marketData: new FixtureMarketData(bars(15, 6)),
        debate: debateResult({ confidence: 0.95 }),
        positionState: async () => [openPosition({ conviction: 0.5 })],
      }),
    );

    expect(outcome.intent?.intent_type).toBe('scale_in');
    expect(outcome.atr).toBe(6);
    // And it is genuinely the stop's input: stop distance = atr_k (2) x 6.
    expect(outcome.intent?.entry).toBeDefined();
    expect((outcome.intent?.entry ?? 0) - (outcome.intent?.stop ?? 0)).toBeCloseTo(12, 10);
  });

  it('is the same decision `decide` makes, projected', async () => {
    // `decide` is a wrapper over this, so the two cannot drift. If it ever
    // stops being a projection, this fails rather than the pair silently
    // disagreeing.
    const input = traderInput({ debate: debateResult({ confidence: 0.1 }) });

    expect(await decide(input)).toBeNull();
    expect((await decideWithReason(input)).intent).toBeNull();
  });
});

/**
 * The Trader's exit-only entry point (#743) — what the tick path runs 29 of
 * every 30 passes. `ExitCheckInput` carries no `debate` and no views by
 * construction; everything asserted here must be reachable from position
 * state, the calendar and a mark alone.
 */
describe('checkExitsWithReason — the tick-path exit entry point (#743)', () => {
  // Same US-equity geometry as the flat-by-close suite above: close 20:00 UTC,
  // `flatten_before_close_ms` 5 min, so 19:56 is inside the window.
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');
  const OUTSIDE_WINDOW = new Date('2026-07-15T15:00:00Z');
  // Deliberately NOT the bar the clock would floor to (19:56 floors to 19:00):
  // the runner floored this pass's bar once and passed it down, and re-deriving
  // it from the clock in here is the #687 defect shape one seam down. The key
  // assertion below fails if the implementation re-floors.
  const TICK_BAR = new Date('2026-07-15T18:00:00Z');

  /**
   * BULLISH momentum (#748): RSI above 50 and a positive MACD histogram, so
   * `momentumVote` is `+1` and the default long lot below is still supported.
   * Every case in THIS suite therefore reaches the same branch it did before
   * the early exit existed. The decay branch is `#748`'s own suite.
   */
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
      bar: TICK_BAR,
      ...overrides,
    };
  }

  it('skips with no_open_position when flat', async () => {
    const outcome = await checkExitsWithReason(exitInput({ positionState: async () => [] }));

    expect(outcome.intent).toBeNull();
    expect(outcome.skip_reason).toBe('no_open_position');
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
    // There is no debate on a tick pass; the attribution is read off the open
    // lot — the decision this exit is a consequence of.
    expect(outcome.intent?.metadata.debate_id).toBe('debate-existing');
    expect(outcome.intent?.metadata.conviction).toBe(0.6);
  });

  it('keys the exit to the PASSED bar, not a clock re-floor', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    // 19:56 floors to 19:00; the passed bar is 18:00. Equal keys prove the
    // passed coordinate won — and this is the same key a decision-pass flatten
    // on the same bar computes, so the two paths dedupe on one order.
    expect(outcome.intent?.idempotency_key).toBe(
      computeIdempotencyKey(exitInput().instrument, TICK_BAR, 'close'),
    );
    expect(outcome.intent?.idempotency_key).not.toBe(
      computeIdempotencyKey(exitInput().instrument, new Date('2026-07-15T19:00:00Z'), 'close'),
    );
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
    // ...while the SIZE still flattens the whole book, both lots.
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

/**
 * The indicator-based early exit (#748) — `trader-spec.md`'s third clause of
 * the exit model, restored.
 *
 * Every case here is a real tick-path pass: no `debate`, no `AnalystView`, no
 * `equity`, no `setupStore` — `ExitCheckInput` has no field any of those could
 * arrive through, which is orchestrator-spec.md constraint 4 stated as a type.
 */
describe('checkExitsWithReason — the indicator-based early exit (#748)', () => {
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');
  const OUTSIDE_WINDOW = new Date('2026-07-15T15:00:00Z');
  const TICK_BAR = new Date('2026-07-15T18:00:00Z');

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

  /**
   * A long lot with its brackets deliberately WIDE of the mark: stop 90,
   * target 110, mark 100. Every case below therefore runs on a bar where
   * neither bracket has been touched — which is the whole point of an early
   * exit and the first acceptance criterion.
   */
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
      bar: TICK_BAR,
      ...overrides,
    };
  }

  it('releases a decayed LONG before either bracket is touched', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.metadata.exit_reason).toBe('signal_decay');
    // The mark is strictly inside the bracket on this bar: the stop has not
    // been hit, the target has not been reached, and the position is released
    // anyway. A price-only exit would still be holding it.
    expect(outcome.intent?.entry).toBeGreaterThan(BRACKETS_UNTOUCHED.stop);
    expect(outcome.intent?.entry).toBeLessThan(BRACKETS_UNTOUCHED.target);
  });

  it('releases a decayed SHORT — decay is read against the HELD side, not the market', async () => {
    // Bullish momentum supports a long and contradicts a short. The same read
    // must therefore hold one and release the other.
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
    // Opposite the held side — an intent that could OPEN or INCREASE would be
    // on the held side, and `buildFlattenExit` cannot produce one.
    expect(outcome.intent?.side).toBe('sell');
    // Exactly the held quantity, never more: 10 + 4.
    expect(outcome.intent?.size).toBe(14);
    // Degenerate legs: an exit carries no new risk and opens no bracket.
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

    // Same tape, same position, two configs, opposite answers — which is only
    // possible if the threshold is read from config.
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

    // The named, priced subset — and the whole of it. A third read here is a
    // per-tick cost this change did not price.
    //
    // The ORDER is asserted, not incidental. `cachedBars` rejects a hit on
    // `rows.length < window.lookback` before it consults the per-interval fetch
    // record, so the widest window has to go first or the second call misses on
    // depth and issues a second upstream fetch. MACD's warm-up is 112 bars and
    // RSI's is 57; reversing these two lines doubles the network cost this
    // change priced at one fetch per bar interval.
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
    // Distinct values, not one reason wearing three names.
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

    // Same instrument, same bar, two different keys — otherwise Execution's
    // `findByKey` suppresses whichever came second, which is the flatten (#686).
    expect(decay.intent?.idempotency_key).toBe(
      computeIdempotencyKey(INSTRUMENT, TICK_BAR, 'early_close'),
    );
    expect(flatten.intent?.idempotency_key).toBe(
      computeIdempotencyKey(INSTRUMENT, TICK_BAR, 'close'),
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

    // NOT released on a read nobody could take, and NOT folded into the
    // healthy-hold reason.
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

  // ── Flat-by-close is unaffected. The three cases below are the ticket's
  // highest-stakes line: the flatten is evaluated on a tick and nowhere else.
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
});

/**
 * #826 — THE MARK SOURCE STALLS.
 *
 * `FailoverDataSource` fails BARS over to a second vendor and deliberately
 * does not fail MARKS over, so an Alpaca stall makes `getMark` throw for the
 * whole outage. Before this ticket that throw was on the flatten's path: the
 * exit never got built, `tick-loop.ts` logged the instrument as failed, and
 * under ADR-0014's flat-by-close invariant a stall in the last hour of a
 * session was a missed exit rather than a pause.
 *
 * The decision recorded in `readExitPrice`: the MANDATORY flatten degrades to
 * an unpriced market exit; everything else still fails loudly. These cases pin
 * BOTH halves — a suite that only asserted the flatten would go green on an
 * implementation that swallowed every mark failure everywhere.
 */
describe('decide/checkExits — the mark read fails (#826)', () => {
  const INSIDE_WINDOW = new Date('2026-07-15T19:56:00Z');
  const OUTSIDE_WINDOW = new Date('2026-07-15T15:00:00Z');
  const TICK_BAR = new Date('2026-07-15T18:00:00Z');
  const STALL = 'alpaca: request timed out after 3 attempts';

  /** The live shape of the outage: bars still answer, the mark does not. */
  class MarkStalledMarketData extends FixtureMarketData {
    override async getMark(): Promise<Mark> {
      throw new Error(STALL);
    }
  }

  function stalled(): MarkStalledMarketData {
    const marketData = new MarkStalledMarketData(bars(15, 2));
    // Momentum that still SUPPORTS a long, so nothing here reaches the early
    // exit by accident — the flatten window is the only thing that fires.
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
      bar: TICK_BAR,
      ...overrides,
    };
  }

  it('still flattens on the tick path, unpriced, rather than carrying the position overnight', async () => {
    const outcome = await checkExitsWithReason(exitInput());

    expect(outcome.intent?.intent_type).toBe('exit');
    expect(outcome.intent?.metadata.exit_reason).toBe('flatten');
    expect(outcome.intent?.side).toBe('sell');
    // Sized to the HELD quantity — the number that never needed a price.
    expect(outcome.intent?.size).toBe(10);
    // Asset class off the open lot, which is what the position was opened as.
    expect(outcome.intent?.asset_class).toBe('stocks');
    // The three price fields are zero and flagged as meaningless, rather than
    // carrying a stale or invented number a later reader would trust.
    expect(outcome.intent?.entry).toBe(0);
    expect(outcome.intent?.stop).toBe(0);
    expect(outcome.intent?.target).toBe(0);
    expect(outcome.intent?.metadata.unpriced_exit).toBe(true);
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

  /**
   * The other half, and the one that keeps the degradation honest. A DECAY
   * release is the system choosing to close, not the session forcing it —
   * deferring one to the next tick costs nothing, and a feed that cannot
   * answer is a real reason to do less. If this ever goes green with an
   * intent, the "only the mandatory flatten degrades" claim is false.
   */
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
          // Holding long while the debate resolves short: the flip exit, which
          // the debate decides rather than the clock.
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

  it('leaves a HEALTHY flatten priced and unflagged — the degradation is reached only on a failure', async () => {
    const marketData = new FixtureMarketData(bars(15, 2));
    marketData.indicatorReads.set('rsi', 60);
    marketData.indicatorReads.set('macd_histogram', 0.5);

    const outcome = await checkExitsWithReason(exitInput({ marketData }));

    expect(outcome.intent?.entry).toBe(ENTRY_PRICE);
    expect(outcome.intent?.metadata.unpriced_exit).toBeUndefined();
  });
});
