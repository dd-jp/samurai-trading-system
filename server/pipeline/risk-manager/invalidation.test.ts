/**
 * The deterministic half of the invalidation fold (#994).
 *
 * These are the properties the mechanism rests on, in order of how expensive
 * they are to get wrong:
 *
 *  - A model can never produce a breach. It proposes; measured data decides.
 *  - A malformed or absent conditions half never voids the prose verdict, and
 *    never fabricates enforcement — it reports `no_conditions`.
 *  - Every drop is recorded WITH its reason, so a systematically bad prompt is
 *    visible instead of degrading into "conditions never fire" for a month.
 *  - An observable this module has no declared semantics for is NOT dropped:
 *    adding a member to `INDICATOR_KINDS` must never become a trade-blocking
 *    event.
 */

import type { Bar, MarketDataService } from '../../providers/market-data-service/index.js';
import {
  breachedConditions,
  evaluateConditions,
  invalidationReasons,
  MAX_INSPECTED_CONDITIONS,
  MAX_INVALIDATION_CONDITIONS,
  MAX_INVALIDATION_LOOKBACK,
  NO_CONDITIONS_REASON,
  readPersistedConditions,
  readPersistedDroppedConditions,
  validateConditions,
} from './invalidation.js';
import type {
  DroppedCondition,
  EvaluatedCondition,
  InvalidationCondition,
  RiskCriticVerdict,
} from './types.js';

const NOW = new Date('2026-09-03T14:00:00.000Z');

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    observable: { kind: 'mark' },
    comparator: '<',
    threshold: 95,
    rationale: 'below 95 the breakout that justified the entry has already failed',
    ...overrides,
  };
}

function condition(overrides: Partial<InvalidationCondition> = {}): InvalidationCondition {
  return {
    id: 'c1',
    observable: { kind: 'mark' },
    comparator: '<',
    threshold: 95,
    rationale: 'audit only',
    ...overrides,
  };
}

function bar(volume: number): Bar {
  return {
    instrument: '3USL',
    timeframe: '1h',
    open_time: NOW,
    close_time: NOW,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume,
    source: 'test',
  };
}

/** Real shape, no cast — a mis-shaped stub behind `as` would disable the check under test. */
function marketData(overrides: Partial<MarketDataService> = {}): MarketDataService {
  const unused = (name: string) => () => Promise.reject(new Error(`${name} not stubbed`));
  return {
    getMark: () =>
      Promise.resolve({ price: 100, observed_at: NOW, source: 'test', asset_class: 'stocks' }),
    getIndicator: () => Promise.resolve({ indicator: 'rsi', value: 50, as_of_bar_close: NOW }),
    getBars: () => Promise.resolve([]),
    getMarks: unused('getMarks'),
    getSpreadEstimate: unused('getSpreadEstimate'),
    getQuote: unused('getQuote'),
    getADV: unused('getADV'),
    ...overrides,
  };
}

describe('validateConditions', () => {
  it('accepts a well-formed, side-coherent condition', () => {
    const { accepted, dropped } = validateConditions([raw()], 'buy');
    expect(dropped).toEqual([]);
    expect(accepted).toEqual([
      {
        id: 'c1',
        observable: { kind: 'mark' },
        comparator: '<',
        threshold: 95,
        rationale: 'below 95 the breakout that justified the entry has already failed',
      },
    ]);
  });

  it('treats an absent conditions half as nothing proposed and nothing refused', () => {
    // The Q3 shape too: a pre-fold row has no field here at all.
    expect(validateConditions(undefined, 'buy')).toEqual({ accepted: [], dropped: [] });
  });

  it('records a non-array conditions payload as one unparseable drop, not a throw', () => {
    const { accepted, dropped } = validateConditions('conditions: none really', 'buy');
    expect(accepted).toEqual([]);
    expect(dropped).toEqual([
      { id: null, raw: expect.stringContaining('conditions'), reason: 'unparseable' },
    ]);
  });

  it.each([
    ['a blank id', raw({ id: '  ' })],
    ['a missing rationale', raw({ rationale: '' })],
    ['an unknown comparator', raw({ comparator: '~=' })],
    ['a non-finite threshold', raw({ threshold: Number.NaN })],
    ['a threshold that is not a number', raw({ threshold: 'ninety-five' })],
    ['an observable that is not an object', raw({ observable: 'the mark' })],
    [
      'a bar window with no baseline to divide by',
      raw({
        comparator: '<',
        observable: {
          kind: 'bars',
          window: { timeframe: '1h', lookback: 1 },
          measure: 'volume_ratio',
        },
      }),
    ],
  ])('drops %s as unparseable rather than coercing it', (_label, element) => {
    const { accepted, dropped } = validateConditions([element], 'buy');
    expect(accepted).toEqual([]);
    expect(dropped[0]?.reason).toBe('unparseable');
  });

  it('drops an observable that binds to no service the risk step can read', () => {
    // Including `mi_context`, which the 2026-08-05 proposal had and the fold
    // deliberately does not carry — the risk step holds no MI context store.
    const { dropped } = validateConditions(
      [raw({ observable: { kind: 'mi_context', window_ms: 3_600_000, measure: 'news_count' } })],
      'buy',
    );
    expect(dropped[0]).toEqual({
      id: 'c1',
      raw: expect.stringContaining('mi_context'),
      reason: 'unknown_observable',
    });
  });

  it('drops an indicator the Market Data Service does not compute', () => {
    const { dropped } = validateConditions(
      [
        raw({
          observable: {
            kind: 'indicator',
            spec: { indicator: 'ichimoku', params: {}, lookback: 20, timeframe: '1h' },
          },
        }),
      ],
      'buy',
    );
    expect(dropped[0]?.reason).toBe('unknown_indicator');
  });

  it('drops a threshold outside the observable’s range — it could only be permanently true or false', () => {
    const { dropped } = validateConditions(
      [
        raw({
          threshold: 140,
          observable: {
            kind: 'indicator',
            spec: { indicator: 'rsi', params: { period: 14 }, lookback: 30, timeframe: '1h' },
          },
        }),
      ],
      'buy',
    );
    expect(dropped[0]?.reason).toBe('threshold_out_of_range');
  });

  it('drops a condition that would fire when the thesis is WORKING', () => {
    // A long thesis falsified by the price going UP is not a falsifier.
    const { accepted, dropped } = validateConditions([raw({ comparator: '>' })], 'buy');
    expect(accepted).toEqual([]);
    expect(dropped[0]?.reason).toBe('direction_incoherent');
  });

  it('inverts that rule for a short, rather than hard-coding "<"', () => {
    expect(
      validateConditions([raw({ comparator: '>', threshold: 105 })], 'sell').accepted,
    ).toHaveLength(1);
    expect(validateConditions([raw({ comparator: '<' })], 'sell').dropped[0]?.reason).toBe(
      'direction_incoherent',
    );
  });

  it('holds volume_ratio to "<" on BOTH sides — thinning falsifies conviction either way', () => {
    const thinning = raw({
      comparator: '<',
      threshold: 0.5,
      observable: {
        kind: 'bars',
        window: { timeframe: '1h', lookback: 20 },
        measure: 'volume_ratio',
      },
    });
    expect(validateConditions([thinning], 'buy').accepted).toHaveLength(1);
    expect(validateConditions([thinning], 'sell').accepted).toHaveLength(1);
    expect(validateConditions([{ ...thinning, comparator: '>' }], 'sell').dropped[0]?.reason).toBe(
      'direction_incoherent',
    );
  });

  it('does NOT drop an indicator kind with no declared direction or range', () => {
    // The rule `devils-advocate-spec.md` states explicitly: an observable whose
    // semantics are undeclared falls through to the other rules. Otherwise
    // adding a member to `INDICATOR_KINDS` becomes a trade-blocking event.
    const undeclared = raw({
      comparator: '>',
      threshold: -0.5,
      observable: {
        kind: 'indicator',
        spec: {
          indicator: 'macd_histogram',
          params: { fast: 12, slow: 26, signal: 9 },
          lookback: 60,
          timeframe: '1h',
        },
      },
    });
    const { accepted, dropped } = validateConditions([undeclared], 'buy');
    expect(dropped).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it('drops an indicator condition whose lookback exceeds the cap, without ever reading it', async () => {
    const overLookback = raw({
      observable: {
        kind: 'indicator',
        spec: {
          indicator: 'rsi',
          params: { period: 14 },
          lookback: MAX_INVALIDATION_LOOKBACK + 1,
          timeframe: '1h',
        },
      },
    });
    const { accepted, dropped } = validateConditions([overLookback], 'buy');
    expect(accepted).toEqual([]);
    expect(dropped[0]?.reason).toBe('lookback_too_large');

    // Dropped at validation means it never reaches `evaluateConditions` — the
    // fake throws if `getIndicator` is ever called, so a call would fail loud.
    const results = await evaluateConditions({
      conditions: accepted,
      instrument: '3USL',
      marketData: marketData({
        getIndicator: () => Promise.reject(new Error('must not be called')),
      }),
      asOf: NOW,
    });
    expect(results).toEqual([]);
  });

  it('drops a bars condition whose lookback exceeds the cap, without ever reading it', async () => {
    const overLookback = raw({
      comparator: '<',
      observable: {
        kind: 'bars',
        window: { timeframe: '1h', lookback: MAX_INVALIDATION_LOOKBACK + 1 },
        measure: 'volume_ratio',
      },
    });
    const { accepted, dropped } = validateConditions([overLookback], 'buy');
    expect(accepted).toEqual([]);
    expect(dropped[0]?.reason).toBe('lookback_too_large');

    const results = await evaluateConditions({
      conditions: accepted,
      instrument: '3USL',
      marketData: marketData({ getBars: () => Promise.reject(new Error('must not be called')) }),
      asOf: NOW,
    });
    expect(results).toEqual([]);
  });

  it('accepts an indicator condition at exactly the lookback cap', () => {
    const atCap = raw({
      observable: {
        kind: 'indicator',
        spec: {
          indicator: 'rsi',
          params: { period: 14 },
          lookback: MAX_INVALIDATION_LOOKBACK,
          timeframe: '1h',
        },
      },
    });
    const { accepted, dropped } = validateConditions([atCap], 'buy');
    expect(dropped).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it('accepts a bars condition at exactly the lookback cap', () => {
    const atCap = raw({
      comparator: '<',
      observable: {
        kind: 'bars',
        window: { timeframe: '1h', lookback: MAX_INVALIDATION_LOOKBACK },
        measure: 'volume_ratio',
      },
    });
    const { accepted, dropped } = validateConditions([atCap], 'buy');
    expect(dropped).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  it('caps the surviving list and records the excess as over_cap', () => {
    const many = Array.from({ length: MAX_INVALIDATION_CONDITIONS + 2 }, (_, index) =>
      raw({ id: `c${index}` }),
    );
    const { accepted, dropped } = validateConditions(many, 'buy');
    expect(accepted).toHaveLength(MAX_INVALIDATION_CONDITIONS);
    expect(dropped.map((entry) => entry.reason)).toEqual(['over_cap', 'over_cap']);
  });

  it('bounds the INSPECTED length, so a 1000-element emission cannot write 1000 reason lines', () => {
    // Every drop becomes a reason line on the RiskDecision and a row in
    // `risk_critic_log.dropped_conditions_json`. Iterating the whole array
    // makes the model's emission length the only limit on both, so a hostile
    // or looping emission is a persistence and log-volume amplifier.
    const flood = Array.from({ length: 1000 }, (_, index) => raw({ id: `c${index}` }));
    const { accepted, dropped } = validateConditions(flood, 'buy');

    expect(accepted).toHaveLength(MAX_INVALIDATION_CONDITIONS);
    expect(dropped.length).toBeLessThanOrEqual(MAX_INSPECTED_CONDITIONS + 1);
    expect(dropped.every((entry) => entry.reason === 'over_cap')).toBe(true);

    // The uninspected remainder is ONE summarising drop that names the count,
    // so the fact of a flood is still auditable.
    const summary = dropped[dropped.length - 1];
    expect(summary?.id).toBeNull();
    expect(summary?.raw).toContain(String(1000 - MAX_INSPECTED_CONDITIONS));
    expect(summary?.raw).toContain('1000');

    const reasons = invalidationReasons({
      verdict: 'pass',
      reasoning: 'r',
      conditions: [],
      dropped_conditions: dropped,
    } as unknown as RiskCriticVerdict);
    expect(reasons.length).toBeLessThanOrEqual(MAX_INSPECTED_CONDITIONS + 2);
  });

  it('does not add a summary drop when the emission fits the inspected bound', () => {
    const exact = Array.from({ length: MAX_INSPECTED_CONDITIONS }, (_, index) =>
      raw({ id: `c${index}` }),
    );
    const { accepted, dropped } = validateConditions(exact, 'buy');
    expect(accepted).toHaveLength(MAX_INVALIDATION_CONDITIONS);
    expect(dropped).toHaveLength(MAX_INSPECTED_CONDITIONS - MAX_INVALIDATION_CONDITIONS);
    expect(dropped.every((entry) => entry.id !== null)).toBe(true);
  });

  it('KEEPS a list shorter than three — a thin emission is recorded, never dropped', () => {
    // Dropping a valid 2-condition set would enforce strictly less than the
    // emission supports: the same safety regression as discarding the prose
    // verdict over a malformed conditions half.
    const { accepted, dropped } = validateConditions([raw({ id: 'a' }), raw({ id: 'b' })], 'buy');
    expect(accepted).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it('has no way for a model to assert a state — the extra field is simply not read', () => {
    const { accepted } = validateConditions(
      [{ ...raw(), state: 'breached', severity: 'critical', confidence: 0.99 }],
      'buy',
    );
    expect(accepted[0]).toEqual({
      id: 'c1',
      observable: { kind: 'mark' },
      comparator: '<',
      threshold: 95,
      rationale: 'below 95 the breakout that justified the entry has already failed',
    });
    expect(accepted[0]).not.toHaveProperty('state');
  });
});

describe('evaluateConditions', () => {
  const evaluateOne = (conditionUnderTest: InvalidationCondition, service: MarketDataService) =>
    evaluateConditions({
      conditions: [conditionUnderTest],
      instrument: '3USL',
      marketData: service,
      asOf: NOW,
    });

  it('breaches on a measured mark below the threshold', async () => {
    const [evaluated] = await evaluateOne(
      condition(),
      marketData({
        getMark: () =>
          Promise.resolve({ price: 90, observed_at: NOW, source: 'test', asset_class: 'stocks' }),
      }),
    );
    expect(evaluated).toEqual({ condition: condition(), state: 'breached', observed: 90 });
  });

  it('does not breach at the threshold on a strict comparator', async () => {
    const [evaluated] = await evaluateOne(condition({ threshold: 100 }), marketData());
    expect(evaluated?.state).toBe('not_breached');
  });

  it('measures an indicator through the service, at the point-in-time asOf', async () => {
    let seenAsOf: Date | undefined;
    const [evaluated] = await evaluateOne(
      condition({
        observable: {
          kind: 'indicator',
          spec: { indicator: 'rsi', params: { period: 14 }, lookback: 30, timeframe: '1h' },
        },
        comparator: '<',
        threshold: 40,
      }),
      marketData({
        getIndicator: (_instrument, _spec, asOf) => {
          seenAsOf = asOf;
          return Promise.resolve({ indicator: 'rsi', value: 31, as_of_bar_close: NOW });
        },
      }),
    );
    expect(seenAsOf).toEqual(NOW);
    expect(evaluated?.state).toBe('breached');
  });

  it('measures volume_ratio as the latest bar over the mean of the rest', async () => {
    const [evaluated] = await evaluateOne(
      condition({
        observable: {
          kind: 'bars',
          window: { timeframe: '1h', lookback: 4 },
          measure: 'volume_ratio',
        },
        comparator: '<',
        threshold: 0.5,
      }),
      marketData({ getBars: () => Promise.resolve([bar(100), bar(100), bar(100), bar(30)]) }),
    );
    expect(evaluated?.observed).toBeCloseTo(0.3);
    expect(evaluated?.state).toBe('breached');
  });

  it.each([
    ['a throwing read', marketData({ getMark: () => Promise.reject(new Error('feed down')) })],
    [
      'a non-finite value',
      marketData({
        getMark: () =>
          Promise.resolve({
            price: Number.NaN,
            observed_at: NOW,
            source: 'test',
            asset_class: 'stocks' as const,
          }),
      }),
    ],
  ])('derives unevaluable mechanically from %s, and never throws', async (_label, service) => {
    const [evaluated] = await evaluateOne(condition(), service);
    expect(evaluated?.state).toBe('unevaluable');
    expect(evaluated?.observed).toBeNull();
  });

  it('is unevaluable, not breached, when the window has too few bars to divide', async () => {
    const [evaluated] = await evaluateOne(
      condition({
        observable: {
          kind: 'bars',
          window: { timeframe: '1h', lookback: 20 },
          measure: 'volume_ratio',
        },
        comparator: '<',
        threshold: 0.5,
      }),
      marketData({ getBars: () => Promise.resolve([bar(100)]) }),
    );
    expect(evaluated?.state).toBe('unevaluable');
  });
});

describe('invalidationReasons / breachedConditions', () => {
  const verdict = (overrides: Partial<RiskCriticVerdict> = {}): RiskCriticVerdict => ({
    verdict: 'pass',
    max_notional: null,
    reasoning: 'nothing narrative',
    ...overrides,
  });

  it('records the single no_conditions line when nothing checkable came out', () => {
    // One line for all four causes — nothing emitted, everything dropped, an
    // unreadable half, and a pre-fold row — because they are one code path.
    expect(invalidationReasons(verdict())).toEqual([NO_CONDITIONS_REASON]);
    expect(invalidationReasons(verdict({ conditions: [] }))).toEqual([NO_CONDITIONS_REASON]);
  });

  it('names every dropped condition with its reason, so a bad prompt is visible', () => {
    const reasons = invalidationReasons(
      verdict({
        dropped_conditions: [{ id: 'c9', raw: '{"kind":"runes"}', reason: 'unknown_observable' }],
      }),
    );
    expect(reasons[0]).toContain('c9');
    expect(reasons[0]).toContain('unknown_observable');
    expect(reasons).toContain(NO_CONDITIONS_REASON);
  });

  it('summarises the evaluated states with what was measured', () => {
    const reasons = invalidationReasons(
      verdict({ conditions: [{ condition: condition(), state: 'breached', observed: 90 }] }),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('c1');
    expect(reasons[0]).toContain('breached');
    expect(reasons[0]).toContain('observed 90');
  });

  it('counts only measured breaches — never an unevaluable, and never an absent list', () => {
    expect(breachedConditions(undefined)).toEqual([]);
    expect(breachedConditions(verdict())).toEqual([]);
    expect(
      breachedConditions(
        verdict({ conditions: [{ condition: condition(), state: 'unevaluable', observed: null }] }),
      ),
    ).toEqual([]);
    expect(
      breachedConditions(
        verdict({ conditions: [{ condition: condition(), state: 'breached', observed: 90 }] }),
      ),
    ).toHaveLength(1);
  });
});

/**
 * The persisted-shape readers (#994 review, MUST 1).
 *
 * `risk_critic_log`'s two JSON columns are TEXT: a cast alone lets `[{}]`
 * throw inside `evaluate()` and lets `[{"state":"breached"}]` reach a HARD
 * REJECT with no measurement behind it. These are the direct tests for that
 * boundary — the store-level tests exercise it through SQLite.
 */
describe('readPersistedConditions / readPersistedDroppedConditions', () => {
  const wellFormed: EvaluatedCondition = {
    condition: {
      id: 'c1',
      observable: { kind: 'mark' },
      comparator: '<',
      threshold: 95,
      rationale: 'below 95 the breakout that justified the entry has already failed',
    },
    state: 'breached',
    observed: 90,
  };

  it('round-trips a well-formed list unchanged', () => {
    expect(readPersistedConditions(JSON.parse(JSON.stringify([wellFormed])))).toEqual([wellFormed]);
  });

  it('drops only the malformed element and keeps the surviving subset (#1068)', () => {
    // Element-wise salvage: a corrupt sibling must not cost a well-formed
    // condition its place in the replayed checklist.
    expect(readPersistedConditions([wellFormed, {}])).toEqual([wellFormed]);
  });

  it('reports no_conditions only when NOTHING survives', () => {
    expect(readPersistedConditions([{}, { also: 'garbage' }])).toBeUndefined();
  });

  it('reads an emitted-but-empty list as [], not no_conditions — the two stay distinguishable (#1068)', () => {
    // writeJsonList (critic-store.ts) writes "never emitted" as NULL and
    // "everything dropped at validation time" as `[]` specifically so a
    // caller can tell them apart. An empty array is not corrupt, so it must
    // not collapse to undefined alongside the actually-malformed cases above.
    expect(readPersistedConditions([])).toEqual([]);
  });

  it.each([
    ['a non-array', { conditions: [wellFormed] }],
    ['a string', '[]'],
    ['null', null],
    ['undefined', undefined],
  ])('reads %s as no list at all', (_label, parsed) => {
    expect(readPersistedConditions(parsed)).toBeUndefined();
  });

  it('requires observed: null on unevaluable — a measured value contradicts the state', () => {
    expect(
      readPersistedConditions([{ ...wellFormed, state: 'unevaluable', observed: null }]),
    ).toHaveLength(1);
    expect(
      readPersistedConditions([{ ...wellFormed, state: 'unevaluable', observed: 90 }]),
    ).toBeUndefined();
  });

  it('requires a finite observed on a measured state — a breach with nothing behind it is refused', () => {
    expect(readPersistedConditions([{ ...wellFormed, observed: null }])).toBeUndefined();
    expect(readPersistedConditions([{ ...wellFormed, state: 'invented' }])).toBeUndefined();
  });

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '90'],
  ])('refuses a non-finite observed (%s) on a measured state', (_label, observed) => {
    expect(readPersistedConditions([{ ...wellFormed, observed }])).toBeUndefined();
  });

  it('rejects a persisted indicator lookback above the cap, never re-running the read on replay', () => {
    const overLookback: EvaluatedCondition = {
      condition: {
        id: 'c2',
        observable: {
          kind: 'indicator',
          spec: {
            indicator: 'rsi',
            params: { period: 14 },
            lookback: MAX_INVALIDATION_LOOKBACK + 1,
            timeframe: '1h',
          },
        },
        comparator: '<',
        threshold: 30,
        rationale: 'oversold reversal thesis needs rsi above 30',
      },
      state: 'breached',
      observed: 20,
    };
    expect(readPersistedConditions([overLookback])).toBeUndefined();
  });

  it('accepts a persisted indicator lookback exactly at the cap', () => {
    const atCap: EvaluatedCondition = {
      condition: {
        id: 'c2',
        observable: {
          kind: 'indicator',
          spec: {
            indicator: 'rsi',
            params: { period: 14 },
            lookback: MAX_INVALIDATION_LOOKBACK,
            timeframe: '1h',
          },
        },
        comparator: '<',
        threshold: 30,
        rationale: 'oversold reversal thesis needs rsi above 30',
      },
      state: 'not_breached',
      observed: 45,
    };
    expect(readPersistedConditions([atCap])).toEqual([atCap]);
  });

  it('accepts a persisted indicator kind no longer in INDICATOR_KINDS — registry drift is deliberate leniency', () => {
    const retired: EvaluatedCondition = {
      condition: {
        id: 'c3',
        observable: {
          kind: 'indicator',
          // Cast: this indicator never existed, or has since been retired from
          // `INDICATOR_KINDS`. The state was measured at the time, so the
          // historical replay must reach the same decision.
          spec: { indicator: 'stochastic_rsi' as never, params: {}, lookback: 20, timeframe: '1h' },
        },
        comparator: '<',
        threshold: 20,
        rationale: 'a retired indicator kind, measured before it left the registry',
      },
      state: 'not_breached',
      observed: 55,
    };
    expect(readPersistedConditions([retired])).toEqual([retired]);
  });

  it('rejects a retired indicator kind whose lookback is over the cap — registry drift does not waive the safety cap', () => {
    const retiredOverCap: EvaluatedCondition = {
      condition: {
        id: 'c3',
        observable: {
          kind: 'indicator',
          spec: {
            indicator: 'stochastic_rsi' as never,
            params: {},
            lookback: MAX_INVALIDATION_LOOKBACK + 1,
            timeframe: '1h',
          },
        },
        comparator: '<',
        threshold: 20,
        rationale: 'a retired indicator kind with an oversized lookback',
      },
      state: 'not_breached',
      observed: 55,
    };
    expect(readPersistedConditions([retiredOverCap])).toBeUndefined();
  });

  it.each([
    ['no window at all', { kind: 'bars', measure: 'volume_ratio' }],
    [
      'a window missing lookback',
      { kind: 'bars', measure: 'volume_ratio', window: { timeframe: '1h' } },
    ],
    [
      'a window whose lookback is below the 2-bar minimum',
      { kind: 'bars', measure: 'volume_ratio', window: { timeframe: '1h', lookback: 1 } },
    ],
    [
      'a window whose lookback exceeds the cap',
      {
        kind: 'bars',
        measure: 'volume_ratio',
        window: { timeframe: '1h', lookback: MAX_INVALIDATION_LOOKBACK + 1 },
      },
    ],
  ])('rejects a bars observable with %s', (_label, observable) => {
    const malformedBars: EvaluatedCondition = {
      condition: {
        id: 'c4',
        observable: observable as InvalidationCondition['observable'],
        comparator: '<',
        threshold: 0.5,
        rationale: 'thinning volume falsifies conviction',
      },
      state: 'breached',
      observed: 0.2,
    };
    expect(readPersistedConditions([malformedBars])).toBeUndefined();
  });

  it('accepts a well-formed bars observable with a well-formed window', () => {
    const wellFormedBars: EvaluatedCondition = {
      condition: {
        id: 'c4',
        observable: {
          kind: 'bars',
          measure: 'volume_ratio',
          window: { timeframe: '1h', lookback: 20 },
        },
        comparator: '<',
        threshold: 0.5,
        rationale: 'thinning volume falsifies conviction',
      },
      state: 'not_breached',
      observed: 0.8,
    };
    expect(readPersistedConditions([wellFormedBars])).toEqual([wellFormedBars]);
  });

  describe('end-to-end: no corrupt fixture ever reaches breachedConditions as a breach', () => {
    it.each([
      ['non-finite observed', [{ ...wellFormed, observed: Number.NaN }]],
      ['breached with observed: null', [{ ...wellFormed, observed: null }]],
      [
        'oversized indicator lookback',
        [
          {
            condition: {
              id: 'c2',
              observable: {
                kind: 'indicator',
                spec: {
                  indicator: 'rsi',
                  params: {},
                  lookback: MAX_INVALIDATION_LOOKBACK + 1,
                  timeframe: '1h',
                },
              },
              comparator: '<',
              threshold: 30,
              rationale: 'r',
            },
            state: 'breached',
            observed: 20,
          },
        ],
      ],
      [
        'bars with a missing window',
        [
          {
            condition: {
              id: 'c4',
              observable: { kind: 'bars', measure: 'volume_ratio' },
              comparator: '<',
              threshold: 0.5,
              rationale: 'r',
            },
            state: 'breached',
            observed: 0.2,
          },
        ],
      ],
      // A well-formed survivor alongside a corrupt sibling must not turn into
      // a false breach either — only the corrupt element is dropped.
      [
        'a mix of one well-formed not_breached entry and one corrupt breached entry',
        [
          { ...wellFormed, state: 'not_breached', observed: 100 },
          { observed: null, state: 'breached' },
        ],
      ],
    ])('%s', (_label, parsed) => {
      const conditions = readPersistedConditions(parsed);
      const verdict: RiskCriticVerdict = {
        verdict: 'pass',
        max_notional: null,
        reasoning: 'test',
        ...(conditions === undefined ? {} : { conditions }),
      };
      expect(breachedConditions(verdict)).toEqual([]);
    });
  });

  it('reads a well-formed dropped list, and collapses one with a bad reason code', () => {
    const dropped: DroppedCondition = { id: 'c1', raw: '{}', reason: 'unparseable' };
    expect(
      readPersistedDroppedConditions([dropped, { id: null, raw: '', reason: 'over_cap' }]),
    ).toHaveLength(2);
    expect(readPersistedDroppedConditions([{ ...dropped, reason: 'made_up' }])).toBeUndefined();
    expect(readPersistedDroppedConditions([{ ...dropped, raw: 5 }])).toBeUndefined();
    expect(readPersistedDroppedConditions('[]')).toBeUndefined();
  });
});
