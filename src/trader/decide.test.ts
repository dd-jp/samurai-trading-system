/**
 * Trader core decision tests (ticket #73: the no-position entry path;
 * ticket #74: position-aware branching). Tested at the `decide(input)`
 * seam per docs/specs/trader-spec.md (Testing Decisions): a DebateResult +
 * fixture MarketDataService/PositionStore + a mock clock, asserting on the
 * returned OrderIntent (or null). There is no LLM to mock.
 */
import { describe, expect, it } from 'vitest';
import type { DebateResult } from '../debate-engine/index.js';
import type { Bar, BarWindow, Mark, MarketDataService } from '../market-data-service/index.js';
import type { Clock } from '../shared/clock.js';
import { decide } from './decide.js';
import type {
  AssetClass,
  HeldPosition,
  PositionStore,
  TraderConfig,
  TraderInput,
} from './types.js';
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
  constructor(
    private readonly fixtureBars: Bar[],
    private readonly assetClass: AssetClass = 'stocks',
    private readonly price: number = ENTRY_PRICE,
  ) {}

  async getBars(_instrument: string, _window: BarWindow, _asOf: Date): Promise<Bar[]> {
    return this.fixtureBars;
  }

  async getMark(_instrument: string, _asOf: Date): Promise<Mark> {
    return {
      price: this.price,
      observed_at: DECISION_BAR,
      source: 'fixture',
      asset_class: this.assetClass,
    };
  }
}

/** Serves a fixed (or absent) held position — the Trader's position-awareness dependency. */
class FixturePositionStore implements PositionStore {
  constructor(private readonly position: HeldPosition | null) {}

  async getOpenPosition(_instrument: string, _asOf: Date): Promise<HeldPosition | null> {
    return this.position;
  }
}

const NO_POSITION = new FixturePositionStore(null);

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
    positionState: NO_POSITION,
    equity: EQUITY,
    config: DEFAULT_TRADER_CONFIG,
    ...overrides,
  };
}

function configWith(overrides: Partial<TraderConfig>): TraderConfig {
  return { ...DEFAULT_TRADER_CONFIG, ...overrides };
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
    expect(intent?.time_in_force).toBe(DEFAULT_TRADER_CONFIG.time_in_force);
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
  const HELD_LONG: HeldPosition = { side: 'buy', filled_size: 50 };
  const HELD_SHORT: HeldPosition = { side: 'sell', filled_size: 50 };
  // Above DEFAULT_TRADER_CONFIG.scale_in_conviction_threshold (0.75).
  const HIGH_CONVICTION = 0.9;

  it('branch 1 — no position: emits a fresh entry (the #73 path)', async () => {
    const intent = await decide(traderInput({ positionState: NO_POSITION }));

    expect(intent?.intent_type).toBe('entry');
    expect(intent?.side).toBe('buy');
  });

  it('branch 2a — same direction, held position, conviction at/above the scale-in threshold: bounded scale_in', async () => {
    const intent = await decide(
      traderInput({
        positionState: new FixturePositionStore(HELD_LONG),
        debate: debateResult({ direction: 'bullish', confidence: HIGH_CONVICTION }),
      }),
    );
    if (!intent) throw new Error('expected a scale_in intent');

    expect(intent.intent_type).toBe('scale_in');
    expect(intent.side).toBe('buy');

    // "never an unbounded add" — the scale-in lot is sized by the same
    // per-trade risk formula as an entry, so it never exceeds the
    // configured max_risk_per_trade on its own.
    const riskedFraction = (intent.size * Math.abs(intent.entry - intent.stop)) / EQUITY;
    expect(riskedFraction).toBeLessThanOrEqual(DEFAULT_TRADER_CONFIG.max_risk_per_trade);
  });

  it('branch 2b — same direction, held position, conviction below the scale-in threshold: hold (null)', async () => {
    const intent = await decide(
      traderInput({
        positionState: new FixturePositionStore(HELD_LONG),
        // Above conviction_floor (qualifies for a fresh entry) but below
        // scale_in_conviction_threshold — proves the scale-in gate is
        // stricter than the entry gate, not the same one.
        debate: debateResult({ direction: 'bullish', confidence: 0.7 }),
      }),
    );

    expect(intent).toBeNull();
  });

  it('branch 3 — opposite direction, held position: flattens the full held size, not a blended flip', async () => {
    const intent = await decide(
      traderInput({
        positionState: new FixturePositionStore(HELD_LONG),
        debate: debateResult({ direction: 'bearish', confidence: HIGH_CONVICTION }),
      }),
    );
    if (!intent) throw new Error('expected an exit intent');

    expect(intent.intent_type).toBe('exit');
    expect(intent.side).toBe('sell'); // closes a held long
    expect(intent.size).toBe(HELD_LONG.filled_size);
  });

  it('branch 3 — mirrors for a held short flattened by a bullish debate', async () => {
    const intent = await decide(
      traderInput({
        positionState: new FixturePositionStore(HELD_SHORT),
        debate: debateResult({ direction: 'bullish', confidence: HIGH_CONVICTION }),
      }),
    );
    if (!intent) throw new Error('expected an exit intent');

    expect(intent.intent_type).toBe('exit');
    expect(intent.side).toBe('buy'); // closes a held short
    expect(intent.size).toBe(HELD_SHORT.filled_size);
  });

  it('branch 3 — exit bypasses the min-viable-notional dust skip: a tiny held position still flattens', async () => {
    const tiny: HeldPosition = { side: 'buy', filled_size: 0.001 };

    const intent = await decide(
      traderInput({
        positionState: new FixturePositionStore(tiny),
        debate: debateResult({ direction: 'bearish', confidence: HIGH_CONVICTION }),
      }),
    );

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.size).toBe(tiny.filled_size);
  });

  it('branch 4 — non-converged debate on a held position: hold (null), regardless of direction or conviction', async () => {
    const sameDirection = await decide(
      traderInput({
        positionState: new FixturePositionStore(HELD_LONG),
        debate: debateResult({
          direction: 'bullish',
          confidence: HIGH_CONVICTION,
          converged: false,
        }),
      }),
    );
    const oppositeDirection = await decide(
      traderInput({
        positionState: new FixturePositionStore(HELD_LONG),
        debate: debateResult({
          direction: 'bearish',
          confidence: HIGH_CONVICTION,
          converged: false,
        }),
      }),
    );

    expect(sameDirection).toBeNull();
    expect(oppositeDirection).toBeNull();
  });

  it('a neutral debate on a held position holds (null), same as the no-position case', async () => {
    const intent = await decide(
      traderInput({
        positionState: new FixturePositionStore(HELD_LONG),
        debate: debateResult({ direction: 'neutral' }),
      }),
    );

    expect(intent).toBeNull();
  });
});
