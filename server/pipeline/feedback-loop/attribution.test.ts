import type { ClosedTrade, DebateLog } from '../../shared/index.js';
import type { AnalystContribution, Direction } from '../debate-engine/index.js';
import { InMemoryDebateLogStore } from '../debate-engine/index.js';
import {
  accumulateCredit,
  creditForContribution,
  impliedWeight,
  realizedR,
} from './attribution.js';
import type { TunableDial } from './types.js';

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
      );
      expect(Math.sign(credit)).toBe(positive ? 1 : -1);
    });
  }

  it('gives a neutral analyst neither credit nor blame — it took no stand', () => {
    const credit = creditForContribution(
      makeContribution({ final_position: 'neutral' }),
      2,
      'bullish',
    );
    expect(credit).toBe(0);
  });

  /*
   * #370. Credit used to be scaled by `influence_score`, with a shadow-credit
   * top-up below an influence ceiling. `computeInfluenceScore` measures how
   * often an analyst was MOVED, not how much it moved others, and it is 0 for
   * the one-round debates production actually produces — so the weighting ran
   * on a dead input and shadow credit silently carried the whole signal.
   * These pin that the input is gone, not merely currently zero.
   */
  it('ignores influence_score entirely — a loud and a quiet analyst earn the same', () => {
    const loud = creditForContribution(makeContribution({ influence_score: 0.9 }), 2, 'bullish');
    const quiet = creditForContribution(makeContribution({ influence_score: 0 }), 2, 'bullish');
    expect(loud).toBe(quiet);
  });

  it('is exactly agreement × R, so credit survives an all-zero influence debate', () => {
    // The production case: every contribution scores 0 influence. Under the
    // old formula this collapsed to the shadow term alone.
    const contribution = makeContribution({ influence_score: 0 });
    expect(creditForContribution(contribution, 2, 'bullish')).toBe(2);
    expect(creditForContribution(contribution, -1, 'bullish')).toBe(-1);
  });

  it('penalises a wrong analyst at the same magnitude it rewards a right one', () => {
    // Symmetry is the behavioural change #370 makes: shadow credit was
    // upside-only, so a zero-influence loser used to be floored near 0.
    const right = creditForContribution(
      makeContribution({ final_position: 'bullish' }),
      2,
      'bullish',
    );
    const wrong = creditForContribution(
      makeContribution({ final_position: 'bearish' }),
      2,
      'bullish',
    );
    expect(wrong).toBe(-right);
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

    const credits = accumulateCredit([makeTrade({ debate_id: 'debate-1' })], log);

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
    );

    expect(credits.get('bull')?.trade_count).toBe(2);
  });

  it('skips a trade whose debate was never logged — no evidence, no attribution', () => {
    const credits = accumulateCredit(
      [makeTrade({ debate_id: 'never-logged' })],
      new InMemoryDebateLogStore(),
    );
    expect(credits.size).toBe(0);
  });

  it('skips a trade with an undefined R rather than attributing an infinite outcome', () => {
    const log = new InMemoryDebateLogStore();
    log.writeLog(makeLog('debate-1', [makeContribution({ analyst_id: 'bull' })]));

    const credits = accumulateCredit([makeTrade({ stop: 100 })], log);
    expect(credits.size).toBe(0);
  });

  /**
   * #1081 — the Feedback Loop consumer this ticket's fix has to reach. A
   * latency-truncated debate's `contributions` are partial mediator state,
   * not evidence of any analyst's real performance; crediting or blaming an
   * analyst off it would tune weights on an infrastructure timeout.
   */
  it('skips a trade whose debate was truncated by the latency budget — no evidence to attribute', () => {
    const log = new InMemoryDebateLogStore();
    log.writeLog({
      ...makeLog('debate-1', [makeContribution({ analyst_id: 'bull' })]),
      converged: false,
      termination: 'latency_truncated',
    });

    const credits = accumulateCredit([makeTrade({ debate_id: 'debate-1' })], log);

    expect(credits.size).toBe(0);
  });

  it('still attributes a trade whose debate genuinely failed to converge', () => {
    const log = new InMemoryDebateLogStore();
    log.writeLog({
      ...makeLog('debate-1', [makeContribution({ analyst_id: 'bull', final_position: 'bullish' })]),
      converged: false,
      termination: 'non_converged',
    });

    const credits = accumulateCredit([makeTrade({ debate_id: 'debate-1' })], log);

    expect(credits.get('bull')?.trade_count).toBe(1);
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
