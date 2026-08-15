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
  type IndicatorValue,
  LseRegularHoursCalendar,
  type Mark,
  type MarketDataService,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import type { Clock, OpenPosition } from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { decide, decideWithReason } from './decide.js';
import { FixtureSetupStore } from './fixture-setup-store.js';
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
  async getIndicator(): Promise<IndicatorValue> {
    throw new Error('FixtureMarketData.getIndicator: decide must compute ATR from getBars');
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
    equity: EQUITY,
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
 * `DEFAULT_TRADER_CONFIG` the expected values (`1h`, 15) coincide with
 * `atr_lookback = 14` and with the `DEFAULT_INDICATOR_TIMEFRAME` that
 * `getIndicator` hardcodes, so a default-config assertion would pin two
 * coincidences instead of two relationships.
 */
describe('decide — ATR bar window (#304)', () => {
  it('fetches exactly atr_lookback + 1 bars, so ATR stays a plain mean', async () => {
    // The `+ 1` is load-bearing. `computeIndicator`'s `atr` seeds on the
    // first `period` true ranges and Wilder-smooths the rest; N + 1 bars
    // yield only N ranges, so in production the smoothing loop never runs
    // and the result is the plain mean Trader's stops were calibrated on.
    // Widen this fetch and every stop in the system moves — see
    // atr-equivalence.test.ts, which pins the algorithmic half.
    //
    // The assertion here is on the REQUEST, not the resulting ATR: the
    // fixture serves its 15 bars whatever it is asked for, so the value
    // computed on this path is not the one production would see. The
    // request width is the only half a fixture can pin, and it is the half
    // nothing pinned before.
    const marketData = new FixtureMarketData(bars(15, 2));

    await decide(traderInput({ marketData, config: configWith({ atr_lookback: 7 }) }));

    expect(marketData.requestedWindow?.lookback).toBe(8);
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
    const intent = await decide(traderInput({ equity: 100 }));

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
    const intent = await decide(traderInput({ equity: Number.NaN }));

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

  it('still separates two different bars', async () => {
    const nextBar = new FixtureMarketData(bars(15, 2));
    nextBar.markObservedAt = new Date('2026-07-15T11:03:00Z');

    const first = await decide(traderInput());
    const next = await decide(
      traderInput({
        marketData: nextBar,
        clock: new ManualClock(new Date('2026-07-15T11:03:00Z')),
      }),
    );

    expect(next?.idempotency_key).not.toBe(first?.idempotency_key);
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
