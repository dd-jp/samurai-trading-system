import { describe, expect, it } from 'vitest';
import { InMemoryDebateLogStore } from '../debate-engine/debate-log-store.js';
import type { AnalystContribution, Direction } from '../debate-engine/types.js';
import type { ClosedTrade, DebateLog } from '../shared/types.js';
import {
  accumulateCredit,
  creditForContribution,
  impliedWeight,
  realizedR,
} from './attribution.js';
import type { FeedbackConfig, TunableDial } from './types.js';

const SHADOW: Pick<FeedbackConfig, 'shadow_credit' | 'shadow_influence_ceiling'> = {
  shadow_credit: 0.1,
  shadow_influence_ceiling: 0.2,
};

function makeContribution(overrides: Partial<AnalystContribution> = {}): AnalystContribution {
  return {
    analyst_id: 'analyst-1',
    analyst_type: 'technical',
    stance_during_debate: ['bullish'],
    final_position: 'bullish',
    rationale: 'trend intact',
    influence_score: 0.8,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    // initial risk = |100 - 90| * 10 = 100, so realized_pnl_net 200 => R = 2.
    realized_pnl_net: 200,
    fees_total: 1,
    opened_at: new Date('2026-07-01T10:00:00Z'),
    closed_at: new Date('2026-07-02T10:00:00Z'),
    close_reason: 'target',
    ...overrides,
  };
}

function makeLog(debate_id: string, contributions: AnalystContribution[]): DebateLog {
  return {
    debate_id,
    instrument: 'AAPL',
    bar_timestamp: new Date('2026-07-01T09:00:00Z'),
    contributions,
    direction: 'bullish',
    rounds: 2,
    created_at: new Date('2026-07-01T09:00:00Z'),
  };
}

function makeDial(overrides: Partial<TunableDial> = {}): TunableDial {
  return { max_step: 0.05, floor: 0.1, ceiling: 0.9, tighten_is: 'decrease', ...overrides };
}

describe('realizedR', () => {
  it('divides net PnL by initial risk using filled_size, never requested size', () => {
    expect(realizedR(makeTrade())).toBe(2);
  });

  it('is negative for a losing trade', () => {
    expect(realizedR(makeTrade({ realized_pnl_net: -100 }))).toBe(-1);
  });

  it('returns null when the bracket has zero width — R is undefined, not infinite', () => {
    expect(realizedR(makeTrade({ entry: 100, stop: 100 }))).toBeNull();
  });

  it('returns null when nothing filled', () => {
    expect(realizedR(makeTrade({ filled_size: 0 }))).toBeNull();
  });
});

describe('creditForContribution — signed by stance-vs-outcome', () => {
  const cases: Array<{
    name: string;
    stance: Direction;
    direction: Direction;
    r: number;
    positive: boolean;
  }> = [
    {
      name: 'backed a winning long',
      stance: 'bullish',
      direction: 'bullish',
      r: 2,
      positive: true,
    },
    {
      name: 'backed a losing long',
      stance: 'bullish',
      direction: 'bullish',
      r: -1,
      positive: false,
    },
    {
      name: 'backed a winning short',
      stance: 'bearish',
      direction: 'bearish',
      r: 2,
      positive: true,
    },
    {
      name: 'opposed a losing trade — was right',
      stance: 'bearish',
      direction: 'bullish',
      r: -1,
      positive: true,
    },
    {
      name: 'opposed a winning trade — was wrong',
      stance: 'bearish',
      direction: 'bullish',
      r: 2,
      positive: false,
    },
  ];

  for (const { name, stance, direction, r, positive } of cases) {
    it(`${positive ? 'credits' : 'debits'} an analyst that ${name}`, () => {
      const credit = creditForContribution(
        makeContribution({ final_position: stance }),
        r,
        direction,
        SHADOW,
      );
      expect(Math.sign(credit)).toBe(positive ? 1 : -1);
    });
  }

  it('gives a neutral analyst neither credit nor blame — it took no stand', () => {
    const credit = creditForContribution(
      makeContribution({ final_position: 'neutral' }),
      2,
      'bullish',
      SHADOW,
    );
    expect(credit).toBe(0);
  });

  it('scales credit by influence — the louder driver of a winner gains more', () => {
    const loud = creditForContribution(makeContribution({ influence_score: 0.9 }), 2, 'bullish', {
      ...SHADOW,
      shadow_credit: 0,
    });
    const quiet = creditForContribution(makeContribution({ influence_score: 0.3 }), 2, 'bullish', {
      ...SHADOW,
      shadow_credit: 0,
    });
    expect(loud).toBeGreaterThan(quiet);
  });

  it('adds shadow credit to a right-but-low-influence analyst', () => {
    const quiet = makeContribution({ influence_score: 0.1 });
    const withShadow = creditForContribution(quiet, 2, 'bullish', SHADOW);
    const withoutShadow = creditForContribution(quiet, 2, 'bullish', {
      ...SHADOW,
      shadow_credit: 0,
    });
    expect(withShadow).toBeGreaterThan(withoutShadow);
    // "Small" — the shadow term must not swamp the influence-weighted signal.
    expect(withShadow - withoutShadow).toBeCloseTo(SHADOW.shadow_credit * 2, 10);
  });

  it('withholds shadow credit from a high-influence analyst — it did sway the debate', () => {
    const loud = makeContribution({ influence_score: 0.8 });
    expect(creditForContribution(loud, 2, 'bullish', SHADOW)).toBe(
      creditForContribution(loud, 2, 'bullish', { ...SHADOW, shadow_credit: 0 }),
    );
  });

  it('does not double-penalise a quietly-wrong analyst — shadow credit is upside-only', () => {
    const quiet = makeContribution({ influence_score: 0.1 });
    expect(creditForContribution(quiet, -1, 'bullish', SHADOW)).toBe(
      creditForContribution(quiet, -1, 'bullish', { ...SHADOW, shadow_credit: 0 }),
    );
  });
});

describe('accumulateCredit — the DebateLog join', () => {
  it('reads contributions from the debate log joined by debate_id', () => {
    const log = new InMemoryDebateLogStore();
    log.writeLog(
      makeLog('debate-1', [
        makeContribution({ analyst_id: 'bull', final_position: 'bullish' }),
        makeContribution({ analyst_id: 'bear', final_position: 'bearish' }),
      ]),
    );

    const credits = accumulateCredit([makeTrade({ debate_id: 'debate-1' })], log, SHADOW);

    expect([...credits.keys()].sort()).toEqual(['bear', 'bull']);
    // Winning long: the bull gains, the bear loses.
    expect(credits.get('bull')?.total_credit).toBeGreaterThan(0);
    expect(credits.get('bear')?.total_credit).toBeLessThan(0);
  });

  it('accumulates across trades, counting each analyst once per attributed trade', () => {
    const log = new InMemoryDebateLogStore();
    log.writeLog(makeLog('debate-1', [makeContribution({ analyst_id: 'bull' })]));
    log.writeLog(makeLog('debate-2', [makeContribution({ analyst_id: 'bull' })]));

    const credits = accumulateCredit(
      [makeTrade({ debate_id: 'debate-1' }), makeTrade({ debate_id: 'debate-2' })],
      log,
      SHADOW,
    );

    expect(credits.get('bull')?.trade_count).toBe(2);
  });

  it('skips a trade whose debate was never logged — no evidence, no attribution', () => {
    const credits = accumulateCredit(
      [makeTrade({ debate_id: 'never-logged' })],
      new InMemoryDebateLogStore(),
      SHADOW,
    );
    expect(credits.size).toBe(0);
  });

  it('skips a trade with an undefined R rather than attributing an infinite outcome', () => {
    const log = new InMemoryDebateLogStore();
    log.writeLog(makeLog('debate-1', [makeContribution({ analyst_id: 'bull' })]));

    const credits = accumulateCredit([makeTrade({ stop: 100 })], log, SHADOW);
    expect(credits.size).toBe(0);
  });
});

describe('impliedWeight', () => {
  it('implies the band midpoint for an even record', () => {
    const dial = makeDial({ floor: 0.1, ceiling: 0.9 });
    const implied = impliedWeight({ analyst_id: 'a', total_credit: 0, trade_count: 4 }, dial);
    expect(implied).toBeCloseTo(0.5, 10);
  });

  it('is monotonic — a better record never implies a lower weight', () => {
    const dial = makeDial();
    const good = impliedWeight({ analyst_id: 'a', total_credit: 4, trade_count: 2 }, dial);
    const better = impliedWeight({ analyst_id: 'a', total_credit: 10, trade_count: 2 }, dial);
    expect(better).toBeGreaterThan(good);
  });

  it('saturates inside the hard band even for an absurd R', () => {
    const dial = makeDial({ floor: 0.1, ceiling: 0.9 });
    const implied = impliedWeight({ analyst_id: 'a', total_credit: 1e9, trade_count: 1 }, dial);
    expect(implied).toBeLessThanOrEqual(dial.ceiling);
    expect(implied).toBeGreaterThanOrEqual(dial.floor);
  });

  it('uses the mean per trade, so a long good record is not diluted by its length', () => {
    const dial = makeDial();
    const short = impliedWeight({ analyst_id: 'a', total_credit: 2, trade_count: 2 }, dial);
    const long = impliedWeight({ analyst_id: 'a', total_credit: 20, trade_count: 20 }, dial);
    expect(long).toBeCloseTo(short, 10);
  });
});
