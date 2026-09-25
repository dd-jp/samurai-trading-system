import { describe, expect, it, vi } from 'vitest';
import type { BrokerAdapter } from '../../pipeline/execution/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { PaperBooks } from './books.js';
import { type CycleDeps, calendarDaysBetween, runCycle } from './cycle.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { Journal } from './journal.js';
import { CYCLE_LEVEL_PARAMETERS } from './parameters.js';
import { SaxoPaperBrokerAdapter } from './saxo-paper-adapter.js';
import { type Sleeve, type SleeveDecision, SleeveRegistry } from './sleeve.js';

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));

const longAapl: SleeveDecision = {
  sleeve_id: 'debate',
  instrument: 'AAPL',
  venue: 'alpaca',
  direction: 'bullish',
  confidence: 1,
  action: 'enter_long',
  reason: 'judge bullish',
  price: 20,
  atr: 0.4,
  stop_price: 19.2,
  inputs_hash: 'h',
  debate_id: 'd',
  payload: {},
};

function deps(
  decisions: readonly SleeveDecision[],
  brokers: Record<'alpaca' | 'saxo', BrokerAdapter>,
  dryRun: boolean,
): CycleDeps {
  const db = openSharedStore(':memory:');
  const registry = new SleeveRegistry();
  const sleeve: Sleeve = {
    id: 'debate',
    decide: () =>
      Promise.resolve({
        decisions,
        refusals: [{ scope: 'universe', parameter: 'P', ticket: '#1', message: 'unset' }],
      }),
  };
  registry.register(sleeve);
  return {
    registry,
    books: new PaperBooks(db, clock),
    journal: new Journal(db, clock),
    brokers,
    gbpUsdAtYearStart: 1.25,
    riskFraction: 0.005,
    targetAtrMultiple: 3,
    clock,
    dryRun,
  };
}

describe('runCycle', () => {
  it('dry run journals every book and refuses every submission', async () => {
    const alpaca = new DryRunBrokerAdapter();
    const cycle = deps([longAapl], { alpaca, saxo: new DryRunBrokerAdapter() }, true);
    const report = await runCycle(cycle, '2026-09-25');
    expect(report).toMatchObject({
      dry_run: true,
      sleeves: ['debate'],
      decisions: 1,
      entries: 1,
      submitted_orders: 0,
      dry_run_refusals: 1,
      rejected_orders: 0,
      macro: { macroDay: false, covered: true },
    });
    expect(report.books.map((book) => book.book_id)).toEqual([
      'debate/primary',
      'debate/no-macro-gate',
      'debate/no-sentiment',
      'debate/no-social',
      'debate/large-cap-only',
    ]);
    expect(report.refusals).toEqual([
      ...CYCLE_LEVEL_PARAMETERS.map(
        (parameter) => `${parameter.name} is not set: needs David (${parameter.ticket})`,
      ),
      'P: unset',
    ]);
    expect(alpaca.refused).toHaveLength(1);
    expect(alpaca.refused[0]?.client_order_id).toBe('v2-debate-primary-2026-09-25-AAPL');
    expect(alpaca.refused[0]?.payload.size).toBe(6);
    expect(cycle.journal.sizeShares('debate/primary', '2026-09-25', 'AAPL')).toBe(6);
    expect(cycle.journal.countOrders('refused_dry_run')).toBe(1);
    expect(cycle.journal.countOrders('submitted')).toBe(0);
    for (const book of report.books) {
      expect(cycle.journal.decisionsFor(book.book_id, '2026-09-25')).toEqual([
        { instrument: 'AAPL', action: 'enter_long', inputs_hash: 'h' },
      ]);
    }
  });

  it('submits to the Saxo paper adapter outside a dry run and halves size on a macro day', async () => {
    const saxo = new SaxoPaperBrokerAdapter({ clock, halfSpreadBps: () => 0 });
    const lse: SleeveDecision = {
      ...longAapl,
      instrument: 'CSP1',
      venue: 'saxo',
      price: 20,
      atr: 1,
      stop_price: 18,
    };
    const skipped: SleeveDecision = {
      ...longAapl,
      instrument: 'SKIP',
      action: 'skip',
      reason: 'x',
    };
    const cycle = deps([lse], { alpaca: new DryRunBrokerAdapter(), saxo }, false);
    const fomc = await runCycle(cycle, '2026-09-16');
    expect(fomc.macro).toMatchObject({ macroDay: true, sources: ['fomc'] });
    expect(fomc.submitted_orders).toBe(1);
    const positions = await saxo.getOpenPositions();
    expect(positions[0]?.qty).toBe(1);
    const shadow = cycle.journal.decisionsFor('debate/no-macro-gate', '2026-09-16');
    expect(shadow).toHaveLength(1);
    expect(cycle.journal.sizeShares('debate/primary', '2026-09-16', 'CSP1')).toBe(1);
    expect(cycle.journal.sizeShares('debate/no-macro-gate', '2026-09-16', 'CSP1')).toBe(2);
  });

  it('converts US prices at the year-start FX, sends shorts as sells, and skips zero-size entries', async () => {
    const alpaca = new DryRunBrokerAdapter();
    const saxo = new SaxoPaperBrokerAdapter({ clock, halfSpreadBps: () => 0 });
    const lse: SleeveDecision = {
      ...longAapl,
      instrument: 'CSP1',
      venue: 'saxo',
      price: 20,
      atr: 1,
      stop_price: 18,
    };
    const skipped: SleeveDecision = {
      ...longAapl,
      instrument: 'SKIP',
      action: 'skip',
      reason: 'x',
    };
    const short: SleeveDecision = {
      ...longAapl,
      instrument: 'SHRT',
      action: 'enter_short',
      stop_price: 20.8,
    };
    const unaffordable: SleeveDecision = {
      ...longAapl,
      instrument: 'PRICY',
      price: 5_000,
      atr: 100,
      stop_price: 4_800,
    };
    const cycle = deps([longAapl, lse, short, unaffordable, skipped], { alpaca, saxo }, false);
    const report = await runCycle(cycle, '2026-09-25');
    expect(report.decisions).toBe(5);
    expect(cycle.journal.sizeShares('debate/primary', '2026-09-25', 'SKIP')).toBe(0);
    expect(cycle.journal.sizeShares('debate/primary', '2026-09-25', 'CSP1')).toBe(2);
    expect(cycle.journal.sizeShares('debate/primary', '2026-09-25', 'AAPL')).toBe(6);
    expect(cycle.journal.sizeShares('debate/primary', '2026-09-25', 'PRICY')).toBe(0);
    expect(report.entries).toBe(3);
    expect(report.submitted_orders).toBe(1);
    expect(report.dry_run_refusals).toBe(2);
    expect(alpaca.refused.map((entry) => [entry.instrument, entry.payload.side])).toEqual([
      ['AAPL', 'buy'],
      ['SHRT', 'sell'],
    ]);
    expect(alpaca.refused[0]?.payload).toMatchObject({
      asset_class: 'stocks',
      time_in_force: 'gtc',
      entry: 20,
      stop: 19.2,
      target: expect.closeTo(21.2, 9),
    });
    expect(cycle.journal.countOrders('refused_dry_run')).toBe(2);
    expect(cycle.journal.countOrders('submitted')).toBe(1);
    expect(
      cycle.journal
        .ordersFor('debate/primary')
        .map((order) => [order.client_order_id, order.outcome, order.payload]),
    ).toEqual([
      [
        'v2-debate-primary-2026-09-25-AAPL',
        'refused_dry_run',
        {
          size: 6,
          detail: 'dry run refused bracket v2-debate-primary-2026-09-25-AAPL',
          price: 20,
          stop: 19.2,
          target: expect.closeTo(21.2, 9),
        },
      ],
      [
        'v2-debate-primary-2026-09-25-CSP1',
        'submitted',
        { size: 2, detail: expect.any(String), price: 20, stop: 18, target: 23 },
      ],
      [
        'v2-debate-primary-2026-09-25-SHRT',
        'refused_dry_run',
        {
          size: 6,
          detail: 'dry run refused bracket v2-debate-primary-2026-09-25-SHRT',
          price: 20,
          stop: 20.8,
          target: expect.closeTo(18.8, 9),
        },
      ],
    ]);
    expect(cycle.journal.ordersFor('debate/no-social')).toEqual([]);
  });

  it('rejects an entry without a stop or ATR and journals an uncovered macro calendar', async () => {
    const noStop: SleeveDecision = { ...longAapl, stop_price: undefined };
    const noAtr: SleeveDecision = { ...longAapl, instrument: 'NOATR', atr: undefined };
    const noAtrCycle = deps(
      [noAtr],
      { alpaca: new DryRunBrokerAdapter(), saxo: new DryRunBrokerAdapter() },
      false,
    );
    await runCycle(noAtrCycle, '2026-09-25');
    expect(noAtrCycle.journal.sizeShares('debate/primary', '2026-09-25', 'NOATR')).toBe(0);
    expect(noAtrCycle.journal.ordersFor('debate/primary')).toEqual([]);
    const cycle = deps(
      [noStop],
      { alpaca: new DryRunBrokerAdapter(), saxo: new DryRunBrokerAdapter() },
      false,
    );
    const log = vi.fn();
    const report = await runCycle({ ...cycle, logger: { log } }, '2026-12-02');
    expect(report.macro).toMatchObject({ macroDay: true, covered: false });
    expect(report.rejected_orders).toBe(1);
    expect(cycle.journal.ordersFor('debate/primary')).toMatchObject([
      { outcome: 'rejected', dry_run: false, payload: { detail: 'no_stop_price' } },
    ]);
    expect(log).toHaveBeenCalledWith({
      trace_id: 'v2-2026-12-02',
      stage: 'v2',
      level: 'info',
      event: 'v2_cycle_complete',
      message: 'v2 cycle 2026-12-02: 1 decisions, 0 submitted',
      payload: report,
    });
    expect(report.refusals.some((refusal) => refusal.includes('fail-closed'))).toBe(true);
    expect(cycle.journal.refusalsFor('2026-12-02')).toEqual([
      ...CYCLE_LEVEL_PARAMETERS.map((parameter) => ({
        trading_date: '2026-12-02',
        scope: 'parameter',
        parameter: parameter.name,
        ticket: parameter.ticket,
        message: `${parameter.name} is not set: needs David (${parameter.ticket})`,
      })),
      {
        trading_date: '2026-12-02',
        scope: 'macro',
        parameter: 'MACRO_CALENDARS',
        ticket: 'docs/specs/debate-sleeve-spec.md §6',
        message: report.macro.reason,
      },
      {
        trading_date: '2026-12-02',
        scope: 'universe',
        parameter: 'P',
        ticket: '#1',
        message: 'unset',
      },
    ]);
  });

  it('journals a broker rejection and never counts it as submitted', async () => {
    class Rejecting extends DryRunBrokerAdapter {
      override submitBracket() {
        return Promise.reject(new Error('422 target required'));
      }
    }
    const rejecting: BrokerAdapter = new Rejecting();
    const cycle = deps([longAapl], { alpaca: rejecting, saxo: new DryRunBrokerAdapter() }, false);
    const report = await runCycle(cycle, '2026-09-25');
    expect(report.rejected_orders).toBe(1);
    expect(report.submitted_orders).toBe(0);
    expect(cycle.journal.countOrders('rejected')).toBe(1);
  });

  it('sizes nothing without a risk fraction and submits nothing without a target multiple', async () => {
    const alpaca = new DryRunBrokerAdapter();
    const brokers = { alpaca, saxo: new DryRunBrokerAdapter() };
    const noRisk = { ...deps([longAapl], brokers, true), riskFraction: undefined };
    expect(await runCycle(noRisk, '2026-09-25')).toMatchObject({
      decisions: 1,
      entries: 0,
      dry_run_refusals: 0,
    });
    expect(noRisk.journal.sizeShares('debate/primary', '2026-09-25', 'AAPL')).toBe(0);
    const noTarget = { ...deps([longAapl], brokers, true), targetAtrMultiple: undefined };
    expect(await runCycle(noTarget, '2026-09-25')).toMatchObject({
      decisions: 1,
      entries: 0,
      dry_run_refusals: 0,
    });
    expect(noTarget.journal.sizeShares('debate/primary', '2026-09-25', 'AAPL')).toBe(6);
    expect(noTarget.journal.ordersFor('debate/primary')).toEqual([]);
    expect(alpaca.refused).toEqual([]);
  });

  it('counts calendar days between marks and never negatively', () => {
    expect(calendarDaysBetween(undefined, '2026-09-25')).toBe(0);
    expect(calendarDaysBetween('2026-09-22', '2026-09-25')).toBe(3);
    expect(calendarDaysBetween('2026-09-25', '2026-09-25')).toBe(0);
    expect(calendarDaysBetween('2026-09-26', '2026-09-25')).toBe(0);
  });

  it('rejects a malformed date and refuses to run a date twice', async () => {
    const cycle = deps(
      [],
      { alpaca: new DryRunBrokerAdapter(), saxo: new DryRunBrokerAdapter() },
      true,
    );
    await expect(runCycle(cycle, 'nope')).rejects.toThrow(/bad ISO date/);
    await runCycle(cycle, '2026-09-25');
    const decide = vi.spyOn(cycle.registry.list()[0] as Sleeve, 'decide');
    await expect(runCycle(cycle, '2026-09-25')).rejects.toThrow(/already marked/);
    await expect(runCycle(cycle, '2026-09-24')).rejects.toThrow(/already marked/);
    expect(decide).not.toHaveBeenCalled();
  });
});
