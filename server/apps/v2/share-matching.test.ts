import { describe, expect, it } from 'vitest';
import { type MatchLeg, matchShares, type ShareMatch } from './share-matching.js';

function buy(date: string, qty: number, price: number, charges = 0): MatchLeg {
  return { kind: 'acquisition', date, qty, amountGbp: qty * price, chargesGbp: charges };
}

function sell(date: string, qty: number, price: number, charges = 0): MatchLeg {
  return { kind: 'disposal', date, qty, amountGbp: qty * price, chargesGbp: charges };
}

function matched(legs: readonly MatchLeg[]): readonly ShareMatch[] {
  const outcome = matchShares(legs);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.matches;
}

function closeTo(match: ShareMatch) {
  return {
    ...match,
    qty: expect.closeTo(match.qty, 9),
    proceedsGbp: expect.closeTo(match.proceedsGbp, 9),
    costGbp: expect.closeTo(match.costGbp, 9),
  };
}

// Worked examples built from the rules in docs/cgt-disposal-matching.md (TCGA92 ss105-106A,
// HMRC CG51560/CG51570/CG51575); the figures are this file's own, chosen so each rule's
// arithmetic can be checked by hand
describe('matchShares: section 104 pool (CG51575)', () => {
  it('prices each disposal at the running average cost, charges included, and shrinks the pool', () => {
    expect(
      matched([
        buy('2024-05-01', 1_000, 2, 10),
        buy('2024-09-02', 500, 3.2, 10),
        sell('2025-06-02', 600, 4, 12),
        sell('2025-12-01', 900, 3),
      ]).map(closeTo),
    ).toEqual(
      [
        {
          disposalDate: '2025-06-02',
          acquisitionDate: null,
          qty: 600,
          proceedsGbp: 2_388,
          costGbp: (3_620 * 600) / 1_500,
          rule: 'section-104',
        },
        {
          disposalDate: '2025-12-01',
          acquisitionDate: null,
          qty: 900,
          proceedsGbp: 2_700,
          costGbp: 3_620 - (3_620 * 600) / 1_500,
          rule: 'section-104',
        },
      ].map(closeTo),
    );
  });

  it('adds an acquisition made after a disposal only to later disposals', () => {
    const [first, second] = matched([
      buy('2025-01-06', 100, 10),
      sell('2025-03-03', 100, 12),
      buy('2025-06-02', 100, 20),
      sell('2025-09-01', 100, 25),
    ]);
    expect(first).toMatchObject({ rule: 'section-104', costGbp: 1_000 });
    expect(second).toMatchObject({ rule: 'section-104', costGbp: 2_000 });
  });

  it('refuses a disposal the pool cannot cover rather than price it at zero cost', () => {
    expect(matchShares([buy('2025-01-06', 100, 10), sell('2025-03-03', 150, 12)])).toEqual({
      ok: false,
      reason:
        'section 104 pool holds 100 shares but the disposal on 2025-03-03 needs 150: a short ' +
        'sale, or acquisitions missing from the fill history (CG51575)',
    });
    expect(matchShares([sell('2025-03-03', 1, 12), buy('2025-06-02', 1, 10)])).toMatchObject({
      ok: false,
    });
  });

  it('tolerates float dust between fractional acquisitions and the disposal they cover', () => {
    const matches = matched([
      buy('2025-01-06', 0.1, 10),
      buy('2025-01-07', 0.2, 10),
      sell('2025-03-03', 0.3, 12),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.costGbp).toBeCloseTo(3, 9);
  });
});

describe('matchShares: same-day rule (CG51560)', () => {
  it('matches a day’s acquisitions, pooled at their average, before the section 104 pool', () => {
    expect(
      matched([
        buy('2025-01-06', 1_000, 5),
        buy('2025-03-03', 200, 6),
        sell('2025-03-03', 500, 7),
        buy('2025-03-03', 100, 6.3),
      ]).map(closeTo),
    ).toEqual(
      [
        {
          disposalDate: '2025-03-03',
          acquisitionDate: '2025-03-03',
          qty: 300,
          proceedsGbp: 2_100,
          costGbp: 1_830,
          rule: 'same-day',
        },
        {
          disposalDate: '2025-03-03',
          acquisitionDate: null,
          qty: 200,
          proceedsGbp: 1_400,
          costGbp: 1_000,
          rule: 'section-104',
        },
      ].map(closeTo),
    );
  });

  it('pools a day’s disposals too, and leaves the unmatched part of the acquisition to the pool', () => {
    const matches = matched([
      buy('2025-03-03', 500, 4, 5),
      sell('2025-03-03', 100, 6, 1),
      sell('2025-03-03', 100, 8, 1),
      sell('2025-06-02', 300, 5),
    ]).map(closeTo);
    expect(matches).toEqual(
      [
        {
          disposalDate: '2025-03-03',
          acquisitionDate: '2025-03-03',
          qty: 200,
          proceedsGbp: 1_398,
          costGbp: 802,
          rule: 'same-day',
        },
        {
          disposalDate: '2025-06-02',
          acquisitionDate: null,
          qty: 300,
          proceedsGbp: 1_500,
          costGbp: 1_203,
          rule: 'section-104',
        },
      ].map(closeTo),
    );
  });
});

describe('matchShares: 30-day bed and breakfast rule (CG51560/CG51570)', () => {
  it('matches a loss-harvesting sale with the buy-back, leaving the pool cost untouched', () => {
    expect(
      matched([
        buy('2025-01-06', 1_000, 5),
        sell('2025-04-01', 1_000, 4),
        buy('2025-04-15', 1_000, 4.1),
        sell('2025-09-01', 1_000, 6),
      ]),
    ).toEqual([
      {
        disposalDate: '2025-04-01',
        acquisitionDate: '2025-04-15',
        qty: 1_000,
        proceedsGbp: 4_000,
        costGbp: 4_100,
        rule: '30-day',
      },
      {
        disposalDate: '2025-09-01',
        acquisitionDate: null,
        qty: 1_000,
        proceedsGbp: 6_000,
        costGbp: 5_000,
        rule: 'section-104',
      },
    ]);
  });

  it('reaches the 30th day after the disposal and stops before the 31st', () => {
    const onDay30 = matched([
      buy('2025-01-06', 100, 5),
      sell('2025-04-01', 100, 4),
      buy('2025-05-01', 100, 4.5),
    ]);
    expect(onDay30[0]).toMatchObject({ rule: '30-day', acquisitionDate: '2025-05-01' });
    const onDay31 = matched([
      buy('2025-01-06', 100, 5),
      sell('2025-04-01', 100, 4),
      buy('2025-05-02', 100, 4.5),
    ]);
    expect(onDay31[0]).toMatchObject({ rule: 'section-104', costGbp: 500 });
  });

  it('never matches an acquisition made before the disposal, however recent', () => {
    const matches = matched([buy('2025-03-30', 100, 5), sell('2025-04-01', 100, 4)]);
    expect(matches).toEqual([
      {
        disposalDate: '2025-04-01',
        acquisitionDate: null,
        qty: 100,
        proceedsGbp: 400,
        costGbp: 500,
        rule: 'section-104',
      },
    ]);
  });

  it('gives an acquisition to the earlier disposal first, then the rest of the later one to the pool', () => {
    expect(
      matched([
        buy('2025-01-06', 1_000, 5),
        sell('2025-06-02', 300, 6),
        sell('2025-06-10', 300, 6.5),
        buy('2025-06-20', 400, 5.5),
      ]).map(closeTo),
    ).toEqual(
      [
        {
          disposalDate: '2025-06-02',
          acquisitionDate: '2025-06-20',
          qty: 300,
          proceedsGbp: 1_800,
          costGbp: 1_650,
          rule: '30-day',
        },
        {
          disposalDate: '2025-06-10',
          acquisitionDate: '2025-06-20',
          qty: 100,
          proceedsGbp: 650,
          costGbp: 550,
          rule: '30-day',
        },
        {
          disposalDate: '2025-06-10',
          acquisitionDate: null,
          qty: 200,
          proceedsGbp: 1_300,
          costGbp: 1_000,
          rule: 'section-104',
        },
      ].map(closeTo),
    );
  });

  it('takes later acquisitions in date order once the earliest is used up', () => {
    const matches = matched([
      sell('2025-02-03', 150, 10),
      buy('2025-02-20', 100, 9),
      buy('2025-02-10', 50, 8),
    ]);
    expect(matches.map(({ acquisitionDate, qty }) => ({ acquisitionDate, qty }))).toEqual([
      { acquisitionDate: '2025-02-10', qty: 50 },
      { acquisitionDate: '2025-02-20', qty: 100 },
    ]);
  });

  it('covers a short sale bought back inside the window', () => {
    expect(matched([sell('2025-02-03', 100, 10, 1), buy('2025-02-10', 100, 9, 1)])).toEqual([
      {
        disposalDate: '2025-02-03',
        acquisitionDate: '2025-02-10',
        qty: 100,
        proceedsGbp: 999,
        costGbp: 901,
        rule: '30-day',
      },
    ]);
  });

  it('lists nothing when there is no disposal', () => {
    expect(matchShares([buy('2025-02-10', 100, 9)])).toEqual({ ok: true, matches: [] });
  });
});
