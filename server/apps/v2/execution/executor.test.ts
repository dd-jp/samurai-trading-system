import { describe, expect, it, vi } from 'vitest';
import type {
  BookSpec,
  Position,
  RiskApprovedOrder,
  SleeveDecision,
  Venue,
} from '../../../../contracts/index.js';
import type { BrokerAdapter, NormalizedFill } from '../../../pipeline/execution/index.js';
import { toBrokerFillId } from '../../../shared/index.js';
import { V2RiskGate } from '../risk/index.js';
import { DryRunRefusedError } from './dry-run-broker.js';
import { UnapprovedOrderError, V2OrderExecutor } from './executor.js';
import { venueFee } from './simulated-costs.js';
import { childOrders } from './slicing.js';

const PRICING = { halfSpreadBps: () => 10, impactBps: () => 2, fee: venueFee };

const primary: BookSpec = {
  id: 'debate/primary',
  sleeve: 'debate',
  variant: 'primary',
  instantiated: true,
};
const shadow: BookSpec = { ...primary, id: 'debate/no-macro-gate', variant: 'no-macro-gate' };
const decision: SleeveDecision = {
  sleeve_id: 'debate',
  instrument: 'AAPL',
  venue: 'alpaca',
  direction: 'bullish',
  confidence: 1,
  action: 'enter_long',
  reason: 'r',
  price: 20,
  atr: 0.4,
  stop_price: 19.2,
  inputs_hash: 'h',
  debate_id: 'd',
  payload: {},
};
const held: Position = {
  instrument: 'AAPL',
  venue: 'alpaca',
  qty: 6,
  avgPriceGbp: 16,
  stopGbp: undefined,
  targetGbp: undefined,
  clientOrderId: 'c0',
  exitClientOrderId: undefined,
  openedDate: '2026-09-01',
  marksHeld: 10,
  stray: false,
  splitFactor: 1,
  splitAnchorDate: undefined,
};

const gate = new V2RiskGate({
  books: { lastDay: () => undefined },
  capital: {
    inForce: () => ({
      year: 2026,
      effectiveFrom: '2026-01-01',
      startCapitalGbp: 2_000,
      lossCapGbp: 1_500,
    }),
  },
  market: {
    lastBarBefore: () => undefined,
    barsBefore: (_instrument, _tradingDate, count) =>
      Array.from({ length: count }, (_, back) => ({
        date: `2026-09-${String(24 - back).padStart(2, '0')}`,
        open: 20,
        high: 20,
        low: 20,
        close: 20,
        volume: 1_000_000,
        rawClose: 20,
      })).reverse(),
    gbpUsdAtYearStart: () => 1,
  },
  spec: () => ({
    capitalShare: 1,
    minimumCapitalGbp: 0,
    capacityGbp: Number.POSITIVE_INFINITY,
    validation: 'forward-paper',
    macroGate: true,
    sizing: {
      riskFraction: 0.005,
      stopAtrMultiple: 2,
      targetAtrMultiple: 3,
      timeStopTradingDays: 10,
      advShare: 0.01,
      advWindowBars: 20,
    },
    books: [],
  }),
});

function entry(book: BookSpec = primary, venue: SleeveDecision['venue'] = 'alpaca') {
  const { order } = gate.approveEntry({
    book,
    decision: { ...decision, venue },
    clientOrderId: `e-${book.variant}-${venue}`,
    tradingDate: '2026-09-25',
    equityGbp: 1_000,
    macroDay: false,
  });
  if (order === undefined) throw new Error('fixture must approve');
  return order;
}

function fakeBroker(name: string, fills: NormalizedFill[] = []) {
  return {
    name,
    submitBracket: vi.fn().mockResolvedValue({
      client_order_id: 'x',
      broker_order_ids: [name],
      order_state: `${name}-bracket`,
    }),
    submitFlatten: vi.fn().mockResolvedValue({
      client_order_id: 'x',
      broker_order_ids: [name],
      order_state: `${name}-flatten`,
    }),
    rearmProtectiveLegs: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    resumeFlatten: vi.fn().mockResolvedValue(null),
    fetchNewFills: vi.fn().mockResolvedValue(fills),
  };
}

function asAdapter(broker: ReturnType<typeof fakeBroker>): BrokerAdapter {
  return broker as unknown as BrokerAdapter;
}

function allVenues(broker: BrokerAdapter): Record<Venue, BrokerAdapter> {
  return { alpaca: broker, saxo: broker, saxo_cfd_gbp: broker, saxo_cfd_usd: broker };
}

function executor(dryRun: boolean) {
  const alpaca = fakeBroker('alpaca');
  const simulated = fakeBroker('sim');
  return {
    alpaca,
    simulated,
    executor: new V2OrderExecutor({
      brokers: { alpaca: asAdapter(alpaca) },
      simulatedBrokers: allVenues(asAdapter(simulated)),
      pricing: PRICING,
      dryRun,
    }),
  };
}

describe('V2OrderExecutor', () => {
  it('only accepts orders the risk module minted, at compile time and at run time', async () => {
    const { executor: paper, alpaca } = executor(false);
    const forged = {
      kind: 'flatten',
      approvalId: 'exit:forged:1',
      clientOrderId: 'forged',
      bookId: 'debate/primary',
      bookVariant: 'primary',
      venue: 'alpaca',
      instrument: 'AAPL',
      side: 'sell',
      size: 1,
    } as const;
    // @ts-expect-error an unapproved order lacks the risk brand and must not type-check
    await expect(paper.submit(forged)).rejects.toThrow(UnapprovedOrderError);
    const cast = forged as unknown as RiskApprovedOrder;
    await expect(paper.submit(cast)).rejects.toThrow(
      'executor refuses forged: not approved by the risk module (doc 66 D6)',
    );
    const copied = { ...entry() };
    await expect(paper.submit(copied)).rejects.toThrow(UnapprovedOrderError);
    expect(alpaca.submitBracket).not.toHaveBeenCalled();
    expect(alpaca.submitFlatten).not.toHaveBeenCalled();
  });

  it('spends an approval on its first submission', async () => {
    const { executor: paper, alpaca } = executor(false);
    const once = entry();
    expect((await paper.submit(once)).outcome).toBe('submitted');
    await expect(paper.submit(once)).rejects.toThrow(UnapprovedOrderError);
    expect(alpaca.submitBracket).toHaveBeenCalledTimes(1);
  });

  it('routes the primary to its venue broker and every shadow to the simulated broker', async () => {
    const { executor: paper, alpaca, simulated } = executor(false);
    expect(paper.simulates({ bookVariant: 'primary', venue: 'alpaca' })).toBe(false);
    expect(paper.simulates({ bookVariant: 'primary', venue: 'saxo' })).toBe(true);
    expect(paper.simulates({ bookVariant: 'no-macro-gate', venue: 'alpaca' })).toBe(true);
    expect(paper.canRoute({ bookVariant: 'primary', venue: 'alpaca' })).toBe(true);
    expect(paper.canRoute({ bookVariant: 'primary', venue: 'saxo' })).toBe(true);
    expect(paper.canRoute({ bookVariant: 'no-macro-gate', venue: 'saxo' })).toBe(true);
    expect(await paper.submit(entry())).toEqual({
      outcome: 'submitted',
      detail: 'alpaca-bracket',
      approvalId: 'entry:e-primary-alpaca:5',
    });
    expect(alpaca.submitBracket).toHaveBeenCalledWith({
      client_order_id: 'e-primary-alpaca',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      size: 5,
      entry: 20,
      stop: 19.2,
      target: expect.closeTo(21.2, 9),
      time_in_force: 'gtc',
    });
    expect(await paper.submit(entry(shadow))).toMatchObject({
      outcome: 'submitted',
      detail: 'sim-bracket',
    });
    const flatten = gate.approveExit({ book: primary, held, clientOrderId: 'x1' });
    expect(await paper.submit(flatten)).toEqual({
      outcome: 'submitted',
      detail: 'alpaca-flatten',
      approvalId: 'exit:x1:6',
    });
    expect(alpaca.submitFlatten).toHaveBeenCalledWith('AAPL', 'sell', 6, 'x1');
    expect(simulated.submitBracket).toHaveBeenCalledTimes(1);
  });

  it('routes a flatten through submitProtectedExit when the broker supports it, carrying the entry id and rearm prices', async () => {
    const { executor: paper, alpaca } = executor(false);
    const protectedExit = vi.fn().mockResolvedValue({
      client_order_id: 'x1',
      broker_order_ids: ['day-order'],
      order_state: 'submitted',
    });
    (alpaca as unknown as { submitProtectedExit: typeof protectedExit }).submitProtectedExit =
      protectedExit;
    const flatten = gate.approveExit({
      book: primary,
      held,
      clientOrderId: 'x1',
      rearm: { stop: 21, target: 18 },
    });
    expect(await paper.submit(flatten)).toEqual({
      outcome: 'submitted',
      detail: 'submitted',
      approvalId: 'exit:x1:6',
    });
    expect(protectedExit).toHaveBeenCalledWith({
      entryClientOrderId: 'c0',
      clientOrderId: 'x1',
      instrument: 'AAPL',
      side: 'sell',
      size: 6,
      rearm: { stop: 21, target: 18 },
    });
    expect(alpaca.submitFlatten).not.toHaveBeenCalled();
  });

  it('submits a rearm order by re-arming the entry side protective legs, not the flatten side', async () => {
    const { executor: paper, alpaca } = executor(false);
    const rearm = gate.approveRearm({
      book: primary,
      held,
      clientOrderId: 'r1',
      stop: 21,
      target: 18,
    });
    expect(await paper.submit(rearm)).toEqual({
      outcome: 'submitted',
      detail: 'submitted',
      approvalId: 'rearm:r1:6',
    });
    expect(alpaca.rearmProtectiveLegs).toHaveBeenCalledWith('c0', 'AAPL', 'buy', 6, 21, 18);
  });

  it('a primary saxo order routes to the simulated broker (#1400: no live Saxo adapter), and a broker error rejects', async () => {
    const { executor: paper, simulated, alpaca } = executor(false);
    expect(await paper.submit(entry(primary, 'saxo'))).toMatchObject({
      outcome: 'submitted',
      detail: 'sim-bracket',
      approvalId: 'entry:e-primary-saxo:5',
    });
    expect(simulated.submitBracket).toHaveBeenCalledTimes(1);
    alpaca.submitBracket.mockRejectedValueOnce(new Error('422 target required'));
    expect(await paper.submit(entry())).toMatchObject({
      outcome: 'rejected',
      detail: expect.stringContaining('422 target required'),
    });
  });

  it('rejects a primary order when no broker at all covers its venue', async () => {
    const { alpaca, simulated } = executor(false);
    const noSaxo = new V2OrderExecutor({
      brokers: { alpaca: asAdapter(alpaca) },
      simulatedBrokers: {
        ...allVenues(asAdapter(simulated)),
        saxo: undefined as unknown as BrokerAdapter,
      },
      pricing: PRICING,
      dryRun: false,
    });
    expect(await noSaxo.submit(entry(primary, 'saxo'))).toEqual({
      outcome: 'rejected',
      detail: 'no_broker_for_venue:saxo',
      approvalId: 'entry:e-primary-saxo:5',
    });
  });

  it('dry run simulates every route and books a refusal as refused for the primary only', async () => {
    const { executor: dry, alpaca, simulated } = executor(true);
    expect(dry.simulates({ bookVariant: 'primary', venue: 'alpaca' })).toBe(true);
    const refusal = new DryRunRefusedError({
      client_order_id: 'e',
      instrument: 'AAPL',
      kind: 'bracket',
    });
    simulated.submitBracket.mockRejectedValue(refusal);
    expect(await dry.submit(entry())).toMatchObject({
      outcome: 'refused_dry_run',
      detail: refusal.message,
    });
    expect(await dry.submit(entry(shadow))).toMatchObject({ outcome: 'simulated' });
    expect(await dry.submit(entry(primary, 'saxo'))).toMatchObject({ outcome: 'refused_dry_run' });
    expect(alpaca.submitBracket).not.toHaveBeenCalled();
  });

  it('a paper (non-dry-run) primary saxo refusal is simulated, not refused_dry_run (#1400: no live adapter)', async () => {
    const { executor: paper, simulated } = executor(false);
    const refusal = new DryRunRefusedError({
      client_order_id: 'e',
      instrument: 'CSP1',
      kind: 'bracket',
    });
    simulated.submitBracket.mockRejectedValueOnce(refusal);
    expect(await paper.submit(entry(primary, 'saxo'))).toMatchObject({ outcome: 'simulated' });
  });

  it.each([
    'saxo',
    'saxo_cfd_gbp',
    'saxo_cfd_usd',
  ] as const)('a primary order at %s is simulated outside a dry run and never reaches Alpaca', async (venue) => {
    const { executor: paper, alpaca, simulated } = executor(false);
    expect(paper.simulates({ bookVariant: 'primary', venue })).toBe(true);
    expect(await paper.submit(entry(primary, venue))).toMatchObject({
      outcome: 'submitted',
      detail: 'sim-bracket',
    });
    expect(simulated.submitBracket).toHaveBeenCalledTimes(1);
    expect(alpaca.submitBracket).not.toHaveBeenCalled();
  });

  it.each([
    'saxo_cfd_gbp',
    'saxo_cfd_usd',
  ] as const)('a dry-run refusal at %s is simulated in paper and refused_dry_run in a dry run', async (venue) => {
    const refusal = new DryRunRefusedError({
      client_order_id: 'e',
      instrument: 'VOD',
      kind: 'bracket',
    });
    const paper = executor(false);
    paper.simulated.submitBracket.mockRejectedValueOnce(refusal);
    expect(await paper.executor.submit(entry(primary, venue))).toMatchObject({
      outcome: 'simulated',
    });
    const dry = executor(true);
    dry.simulated.submitBracket.mockRejectedValueOnce(refusal);
    expect(await dry.executor.submit(entry(primary, venue))).toMatchObject({
      outcome: 'refused_dry_run',
    });
  });

  it('sends a CFD short bracket to the simulated broker as a sell with the stop above the entry', async () => {
    const { executor: paper, simulated } = executor(false);
    const { order } = gate.approveEntry({
      book: primary,
      decision: {
        ...decision,
        venue: 'saxo_cfd_usd',
        direction: 'bearish',
        action: 'enter_short',
        stop_price: 20.8,
      },
      clientOrderId: 'e-short',
      tradingDate: '2026-09-25',
      equityGbp: 1_000,
      macroDay: false,
    });
    if (order === undefined) throw new Error('fixture must approve');
    await paper.submit(order);
    expect(simulated.submitBracket.mock.calls[0]?.[0].target).toBeLessThan(20);
    expect(simulated.submitBracket).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'sell', entry: 20, stop: 20.8, target: expect.any(Number) }),
    );
  });

  it('a CFD fill with no CFD cost model throws instead of pricing a zero fee', () => {
    const { executor: paper } = executor(false);
    expect(() =>
      paper.quoteSimulatedFill('saxo_cfd_usd', {
        instrument: 'AAPL',
        side: 'sell',
        qty: 5,
        price: 20,
        crossesSpread: false,
      }),
    ).toThrow('needs #1850');
  });

  it('cancels and resumes flattens on the routed broker only', async () => {
    const { executor: paper, alpaca, simulated } = executor(false);
    await paper.cancel({ bookVariant: 'primary', venue: 'alpaca' }, 'c1', 'AAPL');
    await paper.cancel({ bookVariant: 'primary', venue: 'saxo' }, 'c2', 'CSP1');
    await paper.cancel({ bookVariant: 'no-macro-gate', venue: 'alpaca' }, 'c3', 'AAPL');
    expect(alpaca.cancel).toHaveBeenCalledWith('c1', 'AAPL');
    expect(simulated.cancel).toHaveBeenCalledWith('c3', 'AAPL');
    await paper.resumeFlatten({ bookVariant: 'primary', venue: 'alpaca' }, 'x1', 'AAPL');
    await paper.resumeFlatten({ bookVariant: 'no-macro-gate', venue: 'alpaca' }, 'x2', 'AAPL');
    expect(alpaca.resumeFlatten).toHaveBeenCalledWith('x1', 'AAPL');
    expect(simulated.resumeFlatten).not.toHaveBeenCalled();
  });

  it('sweeps fills from the simulated broker always and the venue brokers outside dry run', async () => {
    const fill: NormalizedFill = {
      client_order_id: 'c1',
      broker_fill_id: toBrokerFillId('f1'),
      leg: 'entry',
      price: 20,
      qty: 6,
      fee: 0.5,
      timestamp: new Date('2026-09-25T15:00:00.000Z'),
    };
    const alpaca = fakeBroker('alpaca', [fill]);
    const failing = fakeBroker('saxo');
    failing.fetchNewFills.mockRejectedValue(new Error('saxo down'));
    const simulated = fakeBroker('sim');
    const paper = new V2OrderExecutor({
      brokers: { alpaca: asAdapter(alpaca), saxo: asAdapter(failing) },
      simulatedBrokers: allVenues(asAdapter(simulated)),
      pricing: PRICING,
      dryRun: false,
    });
    expect(await paper.fetchNewFills('2026-09-24T21:00:00.000Z')).toEqual({
      fills: [
        { client_order_id: 'c1', broker_fill_id: 'f1', leg: 'entry', price: 20, qty: 6, fee: 0.5 },
      ],
      failures: [expect.stringContaining('saxo down')],
    });
    expect(alpaca.fetchNewFills).toHaveBeenCalledWith(new Date('2026-09-24T21:00:00.000Z'));
    expect(simulated.fetchNewFills).toHaveBeenCalledTimes(1);
    const dry = new V2OrderExecutor({
      brokers: { alpaca: asAdapter(alpaca) },
      simulatedBrokers: allVenues(asAdapter(simulated)),
      pricing: PRICING,
      dryRun: true,
    });
    expect(await dry.fetchNewFills('2026-09-24T21:00:00.000Z')).toEqual({
      fills: [],
      failures: [],
    });
    expect(alpaca.fetchNewFills).toHaveBeenCalledTimes(1);
    const shared = new V2OrderExecutor({
      brokers: { alpaca: asAdapter(simulated) },
      simulatedBrokers: allVenues(asAdapter(simulated)),
      pricing: PRICING,
      dryRun: false,
    });
    await shared.fetchNewFills('2026-09-24T21:00:00.000Z');
    expect(simulated.fetchNewFills).toHaveBeenCalledTimes(3);
  });
});

describe('childOrders', () => {
  it('sends the whole approved order as one child under its own client order id', () => {
    const order = entry();
    expect(childOrders(order)).toEqual([{ clientOrderId: order.clientOrderId, size: order.size }]);
  });
});

describe('quoteSimulatedFill', () => {
  it('charges a crossing fill half a spread plus impact against it and a resting fill neither, both with the venue fee', () => {
    const { executor: dry } = executor(true);
    const request = {
      instrument: 'AAPL',
      side: 'buy' as const,
      qty: 10,
      price: 100,
      crossesSpread: true,
    };
    expect(dry.quoteSimulatedFill('alpaca', request)).toEqual({
      price: 100.12,
      fee: venueFee('alpaca', 'buy', 10, 100.12),
    });
    expect(
      dry.quoteSimulatedFill('saxo', { ...request, side: 'sell', crossesSpread: false }),
    ).toEqual({
      price: 100,
      fee: 1000 * 0.0008,
    });
  });
});
