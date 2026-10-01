import { describe, expect, it } from 'vitest';
import type { MarketData, SimulatedFillRequest, V2Bar } from '../../../contracts/index.js';
import {
  type BrokerOrder,
  costFidelityReport,
  costVerdict,
  formatCostFidelityReport,
  type QuoteFill,
} from './cost-fidelity.js';

const GBPUSD = 1.25;

function bar(date: string, open: number, low: number, high: number): V2Bar {
  return { date, open, low, high, close: open, rawClose: open, volume: 1_000_000 };
}

function marketOf(series: Record<string, readonly V2Bar[]>): MarketData {
  const before = (instrument: string, date: string) =>
    (series[instrument] ?? []).filter((one) => one.date < date);
  return {
    lastBarBefore: (instrument, date) => before(instrument, date).at(-1),
    barsBefore: (instrument, date, count) => before(instrument, date).slice(-count),
    gbpUsdAtYearStart: () => GBPUSD,
  };
}

const quoteCalls: [string, SimulatedFillRequest][] = [];

const tenBpsAndOneDollar: QuoteFill = (tradingDate, _venue, request) => {
  quoteCalls.push([tradingDate, request]);
  const sign = request.side === 'buy' ? 1 : -1;
  const slip = request.crossesSpread ? 0.001 : 0;
  return { price: request.price * (1 + sign * slip), fee: 1 };
};

function order(overrides: Partial<BrokerOrder>): BrokerOrder {
  return {
    clientOrderId: 'e1',
    tradingDate: '2026-09-01',
    instrument: 'AAA',
    venue: 'alpaca',
    leg: 'entry',
    side: 'buy',
    limit: 100,
    trigger: undefined,
    stop: 95,
    target: 110,
    cancelledOn: undefined,
    offsetBps: 0,
    fills: [],
    ...overrides,
  };
}

const MARKET = marketOf({
  AAA: [
    bar('2026-09-01', 99, 98, 101),
    bar('2026-09-02', 100, 99.5, 102),
    bar('2026-09-03', 96, 94, 97),
  ],
  BBB: [bar('2026-09-01', 50, 49, 50.5), bar('2026-09-02', 50, 49, 50.5)],
  CCC: [bar('2026-09-01', 30, 29.9, 31)],
});

const usd = (price: number) => price / GBPUSD;

const ENTRY_WITH_STOP = order({
  fills: [
    {
      leg: 'entry',
      side: 'buy',
      tradingDate: '2026-09-02',
      qty: 5,
      priceGbp: usd(99.148),
      feeGbp: 0,
    },
    {
      leg: 'entry',
      side: 'buy',
      tradingDate: '2026-09-02',
      qty: 5,
      priceGbp: usd(99.248),
      feeGbp: 0,
    },
    {
      leg: 'stop',
      side: 'sell',
      tradingDate: '2026-09-04',
      qty: 10,
      priceGbp: usd(94.9),
      feeGbp: 0.04,
    },
  ],
});

describe('costFidelityReport', () => {
  it('prices a cumulative entry and its stop against the simulator on the same order', () => {
    quoteCalls.length = 0;
    const report = costFidelityReport([ENTRY_WITH_STOP], MARKET, tenBpsAndOneDollar, 'paper');
    const near = (value: number) => expect.closeTo(value, 9);
    expect(report.rows).toMatchObject([
      {
        fidelity: 'match',
        cost: {
          notionalGbp: near(usd(990)),
          realisedSlippageGbp: near(usd(1.98)),
          realisedFeeGbp: 0,
          modelledSlippageGbp: near(usd(0.99)),
          modelledFeeGbp: near(usd(1)),
        },
      },
      {
        fidelity: 'match',
        cost: {
          realisedSlippageGbp: near(usd(1)),
          realisedFeeGbp: 0.04,
          modelledSlippageGbp: near(usd(0.95)),
        },
      },
    ]);
    expect(quoteCalls).toEqual([
      ['2026-09-02', { instrument: 'AAA', side: 'buy', qty: 10, price: 99, crossesSpread: true }],
      ['2026-09-04', { instrument: 'AAA', side: 'sell', qty: 10, price: 95, crossesSpread: true }],
    ]);
    expect(report.samples).toMatchObject([
      {
        counts: { match: 2 },
        realisedGbp: near(usd(1.98 + 1)),
        modelledGbp: near(usd(0.99 + 0.95)),
        verdict: 'fail',
      },
    ]);
  });

  it('adds the fee legs to the comparison on live', () => {
    const report = costFidelityReport([ENTRY_WITH_STOP], MARKET, tenBpsAndOneDollar, 'live');
    expect(report.samples).toMatchObject([
      {
        realisedGbp: expect.closeTo(usd(1.98 + 1) + 0.04, 9),
        modelledGbp: expect.closeTo(usd(0.99 + 1 + 0.95 + 1), 9),
        verdict: 'pass',
      },
    ]);
  });

  it('passes a paper fill that matches the modelled slippage although paper charges no fee', () => {
    const paperFill = order({
      fills: [
        {
          leg: 'entry',
          side: 'buy',
          tradingDate: '2026-09-02',
          qty: 10,
          priceGbp: usd(99.099),
          feeGbp: 0,
        },
      ],
    });
    const paper = costFidelityReport([paperFill], MARKET, tenBpsAndOneDollar, 'paper');
    expect(paper.rows[0]?.cost).toMatchObject({ realisedFeeGbp: 0, modelledFeeGbp: usd(1) });
    expect(paper.samples[0]?.ratio).toBeCloseTo(1, 9);
    expect(paper.samples[0]?.verdict).toBe('pass');
    expect(formatCostFidelityReport(paper).split('\n')).toEqual([
      '0 bps offset: 1 legs scored, realised £0.79, modelled £0.79, ratio 1.000, PASS (±25%, slippage only)',
      expect.any(String),
      'per order leg:',
      'e1 entry match realised £0.79 + fee £0.00, modelled £0.79 + fee £0.80, delta 0.0 bps',
    ]);
    const live = costFidelityReport([paperFill], MARKET, tenBpsAndOneDollar, 'live');
    expect(live.samples[0]?.verdict).toBe('fail');
  });

  it('caps the modelled entry at the limit, as the simulated book is', () => {
    const tight = order({
      limit: 99.05,
      fills: [
        {
          leg: 'entry',
          side: 'buy',
          tradingDate: '2026-09-02',
          qty: 10,
          priceGbp: usd(99.05),
          feeGbp: 0,
        },
      ],
    });
    const [row] = costFidelityReport([tight], MARKET, tenBpsAndOneDollar, 'paper').rows;
    expect(row?.cost?.modelledSlippageGbp).toBeCloseTo(usd(0.5), 9);
    expect(row?.cost?.realisedSlippageGbp).toBeCloseTo(usd(0.5), 9);
  });

  it('prices a short entry and a target exit with the sell-side sign', () => {
    const short = order({
      side: 'sell',
      limit: 100,
      stop: 105,
      target: 99.8,
      fills: [
        {
          leg: 'entry',
          side: 'sell',
          tradingDate: '2026-09-02',
          qty: 10,
          priceGbp: usd(99.9),
          feeGbp: 0,
        },
        {
          leg: 'target',
          side: 'buy',
          tradingDate: '2026-09-03',
          qty: 10,
          priceGbp: usd(99.8),
          feeGbp: 0,
        },
      ],
    });
    const [entry, target] = costFidelityReport([short], MARKET, tenBpsAndOneDollar, 'paper').rows;
    expect(entry?.fidelity).toBe('match');
    expect(entry?.cost?.realisedSlippageGbp).toBeCloseTo(usd(1), 9);
    expect(entry?.cost?.modelledSlippageGbp).toBeCloseTo(0, 9);
    expect(target?.fidelity).toBe('match');
    expect(target?.cost?.realisedSlippageGbp).toBeCloseTo(0, 9);
    expect(target?.cost?.modelledSlippageGbp).toBe(0);
  });

  it('flags a broker leg the simulator does not produce on its session bar', () => {
    const rows = costFidelityReport(
      [
        order({
          clientOrderId: 'target-untouched',
          fills: [
            {
              leg: 'target',
              side: 'sell',
              tradingDate: '2026-09-02',
              qty: 10,
              priceGbp: usd(110),
              feeGbp: 0,
            },
          ],
        }),
        order({
          clientOrderId: 'stop-read-as-target',
          target: 101,
          stop: 90,
          fills: [
            {
              leg: 'stop',
              side: 'sell',
              tradingDate: '2026-09-02',
              qty: 10,
              priceGbp: usd(90),
              feeGbp: 0,
            },
          ],
        }),
        order({
          clientOrderId: 'entry-missed',
          limit: 97,
          fills: [
            {
              leg: 'entry',
              side: 'buy',
              tradingDate: '2026-09-02',
              qty: 10,
              priceGbp: usd(97),
              feeGbp: 0,
            },
          ],
        }),
      ],
      MARKET,
      tenBpsAndOneDollar,
      'paper',
    ).rows;
    expect(rows.map((row) => [row.clientOrderId, row.fidelity, row.cost])).toEqual([
      ['target-untouched', 'broker_only', undefined],
      ['stop-read-as-target', 'broker_only', undefined],
      ['entry-missed', 'broker_only', undefined],
    ]);
  });

  it('flags a fill on a later bar than the simulator, and leaves it out of the cost', () => {
    const late = order({
      clientOrderId: 'late',
      instrument: 'BBB',
      limit: 50,
      offsetBps: 50,
      fills: [
        {
          leg: 'entry',
          side: 'buy',
          tradingDate: '2026-09-03',
          qty: 4,
          priceGbp: usd(50),
          feeGbp: 0,
        },
      ],
    });
    const report = costFidelityReport([late], MARKET, tenBpsAndOneDollar, 'paper');
    expect(report.rows[0]?.fidelity).toBe('bar_mismatch');
    expect(report.samples).toEqual([
      {
        offsetBps: 50,
        counts: {
          match: 0,
          bar_mismatch: 1,
          broker_only: 0,
          sim_only: 0,
          both_unfilled: 0,
          pending: 0,
        },
        realisedGbp: 0,
        modelledGbp: 0,
        ratio: undefined,
        verdict: 'insufficient',
      },
    ]);
  });

  it('holds a fill whose bars have not come in as pending', () => {
    const rows = costFidelityReport(
      [
        order({
          clientOrderId: 'no-bar-entry',
          instrument: 'ZZZ',
          fills: [
            {
              leg: 'entry',
              side: 'buy',
              tradingDate: '2026-09-02',
              qty: 1,
              priceGbp: 1,
              feeGbp: 0,
            },
          ],
        }),
        order({
          clientOrderId: 'no-bar-stop',
          instrument: 'ZZZ',
          fills: [
            {
              leg: 'stop',
              side: 'sell',
              tradingDate: '2026-09-02',
              qty: 1,
              priceGbp: 1,
              feeGbp: 0,
            },
          ],
        }),
        order({
          clientOrderId: 'no-bar-exit',
          instrument: 'ZZZ',
          leg: 'exit',
          side: 'sell',
          fills: [
            {
              leg: 'exit',
              side: 'sell',
              tradingDate: '2026-09-02',
              qty: 1,
              priceGbp: 1,
              feeGbp: 0,
            },
          ],
        }),
      ],
      MARKET,
      tenBpsAndOneDollar,
      'paper',
    ).rows;
    expect(rows.map((row) => row.fidelity)).toEqual(['pending', 'pending', 'pending']);
  });

  it('replays a market exit at the open of its first bar', () => {
    const exit = order({
      clientOrderId: 'flatten',
      leg: 'exit',
      side: 'sell',
      offsetBps: undefined,
      fills: [
        {
          leg: 'exit',
          side: 'sell',
          tradingDate: '2026-09-04',
          qty: 10,
          priceGbp: usd(95.9),
          feeGbp: 0,
        },
      ],
      tradingDate: '2026-09-03',
    });
    const report = costFidelityReport([exit], MARKET, tenBpsAndOneDollar, 'paper');
    expect(report.rows[0]?.fidelity).toBe('match');
    expect(report.rows[0]?.cost?.realisedSlippageGbp).toBeCloseTo(usd(1), 9);
    expect(report.samples[0]?.offsetBps).toBeUndefined();
  });

  it('checks every cancelled broker entry the simulator would have filled', () => {
    const rows = costFidelityReport(
      [
        order({ clientOrderId: 'would-fill', cancelledOn: '2026-09-02' }),
        order({ clientOrderId: 'no-fill', limit: 97, cancelledOn: '2026-09-02' }),
        order({ clientOrderId: 'no-bar', instrument: 'ZZZ', cancelledOn: '2026-09-02' }),
        order({ clientOrderId: 'resting' }),
        order({ clientOrderId: 'exit-cancelled', leg: 'exit', cancelledOn: '2026-09-02' }),
      ],
      MARKET,
      tenBpsAndOneDollar,
      'paper',
    ).rows;
    expect(rows.map((row) => [row.clientOrderId, row.fidelity])).toEqual([
      ['would-fill', 'sim_only'],
      ['no-fill', 'both_unfilled'],
      ['no-bar', 'pending'],
    ]);
  });

  it('splits the verdict by entry offset (#1815)', () => {
    const fill = (priceUsd: number) => [
      {
        leg: 'entry' as const,
        side: 'buy' as const,
        tradingDate: '2026-09-02',
        qty: 10,
        priceGbp: usd(priceUsd),
        feeGbp: usd(1),
      },
    ];
    const report = costFidelityReport(
      [
        order({ clientOrderId: 'zero', offsetBps: 0, fills: fill(99.099) }),
        order({ clientOrderId: 'fifty', offsetBps: 50, fills: fill(99.3) }),
        order({ clientOrderId: 'sleeve', offsetBps: null, fills: fill(99.099) }),
      ],
      MARKET,
      tenBpsAndOneDollar,
      'paper',
    );
    expect(report.samples.map((sample) => [sample.offsetBps, sample.verdict])).toEqual([
      [0, 'pass'],
      [50, 'fail'],
      [null, 'pass'],
    ]);
    expect(report.samples[0]?.ratio).toBeCloseTo(1, 9);
  });
});

describe('costVerdict', () => {
  it('passes inside ±25% inclusive and fails outside', () => {
    expect(costVerdict(1.25)).toBe('pass');
    expect(costVerdict(0.75)).toBe('pass');
    expect(costVerdict(1.2501)).toBe('fail');
    expect(costVerdict(0.7499)).toBe('fail');
    expect(costVerdict(undefined)).toBe('insufficient');
  });
});

describe('formatCostFidelityReport', () => {
  it('says so when the window holds no broker order', () => {
    expect(formatCostFidelityReport({ mode: 'paper', rows: [], samples: [] })).toBe(
      'no broker orders in the window',
    );
  });

  it('prints each offset sample, then each order leg with its delta, fees included on live', () => {
    const report = costFidelityReport(
      [
        order({
          fills: [
            {
              leg: 'entry',
              side: 'buy',
              tradingDate: '2026-09-02',
              qty: 10,
              priceGbp: usd(99.198),
              feeGbp: 0,
            },
          ],
        }),
        order({ clientOrderId: 'sleeve', offsetBps: null, cancelledOn: '2026-09-02' }),
        order({
          clientOrderId: 'orphan',
          offsetBps: undefined,
          limit: 97,
          cancelledOn: '2026-09-02',
        }),
      ],
      MARKET,
      tenBpsAndOneDollar,
      'live',
    );
    expect(formatCostFidelityReport(report).split('\n')).toEqual([
      '0 bps offset: 1 legs scored, realised £1.58, modelled £1.59, ratio 0.995, PASS (±25%, slippage and fees)',
      '  fidelity: bar mismatch 0, broker only 0, simulator only 0, both unfilled 0, pending 0',
      'sleeve-set limit: 0 legs scored, realised £0.00, modelled £0.00, ratio n/a, INSUFFICIENT (±25%, slippage and fees)',
      '  fidelity: bar mismatch 0, broker only 0, simulator only 1, both unfilled 0, pending 0',
      'entry not journalled: 0 legs scored, realised £0.00, modelled £0.00, ratio n/a, INSUFFICIENT (±25%, slippage and fees)',
      '  fidelity: bar mismatch 0, broker only 0, simulator only 0, both unfilled 1, pending 0',
      'per order leg:',
      'e1 entry match realised £1.58 + fee £0.00, modelled £0.79 + fee £0.80, delta -0.1 bps',
      'sleeve entry sim_only',
      'orphan entry both_unfilled',
    ]);
  });
});
