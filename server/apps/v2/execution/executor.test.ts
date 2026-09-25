import { describe, expect, it, vi } from 'vitest';
import type {
  BookSpec,
  Position,
  RiskApprovedOrder,
  SleeveDecision,
} from '../../../../contracts/index.js';
import type { BrokerAdapter, NormalizedFill } from '../../../pipeline/execution/index.js';
import { toBrokerFillId } from '../../../shared/index.js';
import { V2RiskGate } from '../risk/index.js';
import { DryRunRefusedError } from './dry-run-broker.js';
import { UnapprovedOrderError, V2OrderExecutor } from './executor.js';

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
  market: { lastBarBefore: () => undefined, gbpUsdAtYearStart: () => 1 },
  riskFraction: 0.005,
  targetAtrMultiple: 3,
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
    cancel: vi.fn().mockResolvedValue(undefined),
    resumeFlatten: vi.fn().mockResolvedValue(null),
    fetchNewFills: vi.fn().mockResolvedValue(fills),
  };
}

function asAdapter(broker: ReturnType<typeof fakeBroker>): BrokerAdapter {
  return broker as unknown as BrokerAdapter;
}

function executor(dryRun: boolean) {
  const alpaca = fakeBroker('alpaca');
  const simulated = fakeBroker('sim');
  return {
    alpaca,
    simulated,
    executor: new V2OrderExecutor({
      brokers: { alpaca: asAdapter(alpaca) },
      simulatedBroker: asAdapter(simulated),
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

  it('routes the primary to its venue broker and every shadow to the simulated broker', async () => {
    const { executor: paper, alpaca, simulated } = executor(false);
    expect(paper.simulates({ bookVariant: 'primary', venue: 'alpaca' })).toBe(false);
    expect(paper.simulates({ bookVariant: 'no-macro-gate', venue: 'alpaca' })).toBe(true);
    expect(paper.canRoute({ bookVariant: 'primary', venue: 'alpaca' })).toBe(true);
    expect(paper.canRoute({ bookVariant: 'primary', venue: 'saxo' })).toBe(false);
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

  it('rejects a primary order with no broker for its venue and a broker error', async () => {
    const { executor: paper, alpaca } = executor(false);
    expect(await paper.submit(entry(primary, 'saxo'))).toEqual({
      outcome: 'rejected',
      detail: 'no_broker_for_venue:saxo',
      approvalId: 'entry:e-primary-saxo:5',
    });
    alpaca.submitBracket.mockRejectedValueOnce(new Error('422 target required'));
    expect(await paper.submit(entry())).toMatchObject({
      outcome: 'rejected',
      detail: expect.stringContaining('422 target required'),
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
    expect(alpaca.submitBracket).not.toHaveBeenCalled();
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
      simulatedBroker: asAdapter(simulated),
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
      simulatedBroker: asAdapter(simulated),
      dryRun: true,
    });
    expect(await dry.fetchNewFills('2026-09-24T21:00:00.000Z')).toEqual({
      fills: [],
      failures: [],
    });
    expect(alpaca.fetchNewFills).toHaveBeenCalledTimes(1);
    const shared = new V2OrderExecutor({
      brokers: { alpaca: asAdapter(simulated) },
      simulatedBroker: asAdapter(simulated),
      dryRun: false,
    });
    await shared.fetchNewFills('2026-09-24T21:00:00.000Z');
    expect(simulated.fetchNewFills).toHaveBeenCalledTimes(3);
  });
});
