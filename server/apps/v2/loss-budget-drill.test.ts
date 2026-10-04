import { describe, expect, it } from 'vitest';
import type {
  BookFill,
  GbpUsdFix,
  LossBudgetState,
  MarketData,
  Sleeve,
  SleeveDecision,
  SleeveSpec,
} from '../../../contracts/index.js';
import type { DailyBar } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { SqliteCashAnchors } from './cash-anchor.js';
import { recordCashMove } from './cash-move.js';
import { runCycle } from './cycle.js';
import { addDays, macroGate } from './data/index.js';
import { DryRunBrokerAdapter } from './execution/dry-run-broker.js';
import { V2OrderExecutor } from './execution/executor.js';
import { Journal } from './journal/index.js';
import {
  CapitalConfigStore,
  ControlStore,
  PaperBooks,
  positionSizeShares,
  V2RiskGate,
} from './risk/index.js';
import { SleeveRegistry } from './signal/index.js';

const START_CAPITAL_GBP = 10_000;
const LOSS_CAP_GBP = 1_500;
const YEAR_START_GBP_USD = 1.25;
const PRIMARY = 'debate/primary';
const ENTRY_PRICE = 20;
const ATR = 1;
const STOP = 18;

const SPEC: SleeveSpec = {
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
  books: [{ variant: 'primary', instantiated: true }],
};

function enter(instrument: string): SleeveDecision {
  return {
    sleeve_id: 'debate',
    instrument,
    venue: 'alpaca',
    direction: 'bullish',
    confidence: 1,
    action: 'enter_long',
    reason: 'drill',
    price: ENTRY_PRICE,
    atr: ATR,
    stop_price: STOP,
    inputs_hash: 'h',
    debate_id: 'd',
    payload: {},
  };
}

function exit(instrument: string): SleeveDecision {
  return { ...enter(instrument), action: 'exit', direction: 'bearish' };
}

function flatBar(date: string): DailyBar {
  return { date, open: 20, high: 20.5, low: 19.5, close: 20, volume: 1_000_000, rawClose: 20 };
}

interface Drill {
  readonly db: StoreHandle;
  readonly books: PaperBooks;
  readonly cashAnchors: SqliteCashAnchors;
  readonly decide: (next: readonly SleeveDecision[]) => void;
  readonly setDailyGbpUsd: (rate: number) => void;
  readonly barOverride: Map<string, DailyBar>;
  readonly cycle: (tradingDate: string) => ReturnType<typeof runCycle>;
}

function drill(years: readonly number[] = [2026]): Drill {
  const clock = new SimulatedClock(new Date('2026-09-24T07:00:00.000Z'));
  const db = migratedMemoryStore();
  const capital = new CapitalConfigStore(db, clock);
  for (const year of years) capital.setYear(year, START_CAPITAL_GBP, LOSS_CAP_GBP);
  let decisions: readonly SleeveDecision[] = [];
  let dailyGbpUsd = YEAR_START_GBP_USD;
  const barOverride = new Map<string, DailyBar>();
  const sleeve: Sleeve = {
    id: 'debate',
    spec: SPEC,
    universe: () => ({ instruments: decisions.map((d) => d.instrument), refusals: [] }),
    decide: () => Promise.resolve({ decisions, refusals: [] }),
  };
  const registry = new SleeveRegistry();
  registry.register(sleeve);
  const barOn = (instrument: string, date: string) =>
    barOverride.get(`${instrument}:${date}`) ?? flatBar(date);
  const market: MarketData = {
    lastBarBefore: (instrument, tradingDate) => barOn(instrument, addDays(tradingDate, -1)),
    barsBefore: (instrument, tradingDate, count) =>
      Array.from({ length: count }, (_, back) =>
        barOn(instrument, addDays(tradingDate, back - count)),
      ),
    gbpUsdAtYearStart: () => YEAR_START_GBP_USD,
    gbpUsdYearStartFixDate: (year) => `${year - 1}-12-31`,
    gbpUsdOnDay: (date): GbpUsdFix => ({ gbpUsd: dailyGbpUsd, fixDate: date }),
  };
  const books = new PaperBooks(db, clock, capital, '2026-09-01', [sleeve]);
  const journal = new Journal(db, clock);
  const simulated = new DryRunBrokerAdapter();
  const cashAnchors = new SqliteCashAnchors(db, clock);
  const deps = {
    registry,
    books,
    journal,
    controls: new ControlStore(db),
    brokerBooks: { read: () => Promise.reject(new Error('a dry run never reads the broker')) },
    atomically: <T>(work: () => T) => db.transaction(work)(),
    brokerMode: 'paper' as const,
    reconcileCashToleranceGbp: undefined,
    cashAnchors,
    risk: new V2RiskGate({ books, capital, market, spec: () => SPEC }),
    executor: new V2OrderExecutor({
      brokers: {},
      simulatedBrokers: {
        alpaca: simulated,
        saxo: simulated,
        saxo_cfd_gbp: simulated,
        saxo_cfd_usd: simulated,
      },
      pricing: { halfSpreadBps: () => 0, impactBps: () => 0, fee: () => 0 },
      dryRun: true,
    }),
    market,
    clock,
    dryRun: true,
  };
  return {
    db,
    books,
    cashAnchors,
    barOverride,
    decide: (next) => {
      decisions = next;
    },
    setDailyGbpUsd: (rate) => {
      dailyGbpUsd = rate;
    },
    cycle: (tradingDate) => runCycle(deps, tradingDate),
  };
}

function loseGbp(target: Drill, loss: number, tradingDate: string): void {
  const entry: BookFill = {
    instrument: 'LOSS',
    venue: 'saxo',
    side: 'buy',
    leg: 'entry',
    qty: 1,
    priceGbp: 100 + loss,
    feeGbp: 0,
    clientOrderId: `loss-${tradingDate}`,
    tradingDate,
  };
  target.books.applyFill(PRIMARY, entry);
  target.books.applyFill(PRIMARY, { ...entry, side: 'sell', priceGbp: 100 });
}

function state(target: Drill): LossBudgetState {
  const day = target.books.lastDay(PRIMARY);
  if (day === undefined) throw new Error('drill: primary book never marked');
  return day.state;
}

function equity(target: Drill): number {
  return target.books.lastDay(PRIMARY)?.equityGbp ?? Number.NaN;
}

function sizedShares(target: Drill, tradingDate: string, instrument: string): number | undefined {
  const row = target.db
    .prepare(
      'SELECT size_shares FROM v2_decisions WHERE book_id = ? AND trading_date = ? AND instrument = ?',
    )
    .get(PRIMARY, tradingDate, instrument) as { size_shares: number } | undefined;
  return row?.size_shares;
}

function entryOrders(target: Drill, instrument: string): number {
  const row = target.db
    .prepare(
      "SELECT COUNT(*) AS n FROM v2_orders WHERE book_id = ? AND instrument = ? AND leg = 'entry'",
    )
    .get(PRIMARY, instrument) as { n: number };
  return row.n;
}

function expectedShares(equityGbp: number, sizeMultiplier: number, tradingDate: string): number {
  const limit = ENTRY_PRICE * 1.005;
  return positionSizeShares({
    equityGbp,
    riskFraction: SPEC.sizing.riskFraction,
    priceGbp: limit / YEAR_START_GBP_USD,
    atrGbp: ATR / YEAR_START_GBP_USD,
    stopAtrMultiple: SPEC.sizing.stopAtrMultiple,
    sizeMultiplier,
    macroDay: macroGate(tradingDate).macroDay,
    volumeCapShares: Number.POSITIVE_INFINITY,
    entryToStopGbp: (limit - STOP) / YEAR_START_GBP_USD,
  });
}

async function enterOn(target: Drill, tradingDate: string, instrument: string): Promise<number> {
  target.decide([enter(instrument)]);
  await target.cycle(tradingDate);
  target.decide([]);
  return sizedShares(target, tradingDate, instrument) ?? Number.NaN;
}

async function markLoss(target: Drill, loss: number, tradingDate: string): Promise<void> {
  loseGbp(target, loss, tradingDate);
  await target.cycle(tradingDate);
}

describe('loss-budget rehearsal through the cycle (doc 67 Step 4b, G6)', () => {
  it('a third, two thirds and the whole cap give half size, quarter size, then a halt that holds', async () => {
    const target = drill();
    await target.cycle('2026-09-24');
    const full = await enterOn(target, '2026-09-25', 'AAA');
    expect(full).toBe(expectedShares(START_CAPITAL_GBP, 1, '2026-09-25'));
    expect(full).toBeGreaterThan(8);

    await markLoss(target, 500, '2026-09-28');
    expect(state(target)).toMatchObject({ ytdLossGbp: 500, sizeMultiplier: 0.5, halted: false });
    await target.cycle('2026-09-29');
    const half = await enterOn(target, '2026-09-30', 'BBB');
    expect(half).toBe(expectedShares(9_500, 0.5, '2026-09-30'));
    expect(half).toBeLessThan(full);

    await markLoss(target, 500, '2026-10-01');
    expect(state(target)).toMatchObject({ ytdLossGbp: 1_000, sizeMultiplier: 0.25 });
    await target.cycle('2026-10-02');
    const quarter = await enterOn(target, '2026-10-05', 'CCC');
    expect(quarter).toBe(expectedShares(9_000, 0.25, '2026-10-05'));
    expect(quarter).toBeLessThan(half);

    await markLoss(target, 500, '2026-10-06');
    expect(state(target)).toMatchObject({ ytdLossGbp: 1_500, sizeMultiplier: 0, halted: true });
    await target.cycle('2026-10-07');
    expect(state(target)).toMatchObject({ halted: true, entriesBlockedAtNextFill: true });
    expect(await enterOn(target, '2026-10-08', 'DDD')).toBe(0);
    expect(entryOrders(target, 'DDD')).toBe(0);
  });

  it('the daily cap blocks the next entries while a signal exit and a resting stop still run', async () => {
    const target = drill();
    target.decide([enter('AAA'), enter('BBB')]);
    await target.cycle('2026-09-24');
    target.decide([]);
    await target.cycle('2026-09-25');
    expect(target.books.positions(PRIMARY).map((held) => held.instrument)).toEqual(['AAA', 'BBB']);

    await markLoss(target, START_CAPITAL_GBP * 0.01, '2026-09-28');
    expect(state(target)).toMatchObject({ sizeMultiplier: 1, entriesBlockedAtNextFill: true });

    target.barOverride.set('BBB:2026-09-28', { ...flatBar('2026-09-28'), low: 17 });
    target.decide([exit('AAA'), enter('CCC')]);
    await target.cycle('2026-09-29');
    expect(sizedShares(target, '2026-09-29', 'CCC')).toBe(0);
    expect(entryOrders(target, 'CCC')).toBe(0);
    expect(target.books.position(PRIMARY, 'BBB')).toBeUndefined();
    expect(target.books.position(PRIMARY, 'AAA')?.exitClientOrderId).toBeDefined();

    target.decide([]);
    await target.cycle('2026-09-30');
    expect(target.books.positions(PRIMARY)).toEqual([]);
    expect(state(target).entriesBlockedAtNextFill).toBe(false);
    expect(await enterOn(target, '2026-10-01', 'CCC')).toBeGreaterThan(0);
  });

  it('a GBP/USD move alone leaves equity, the loss and the next size unchanged (FX excluded)', async () => {
    const moved = drill();
    const still = drill();
    for (const target of [moved, still]) {
      target.decide([enter('AAA')]);
      await target.cycle('2026-09-24');
      target.decide([]);
      await target.cycle('2026-09-25');
    }
    expect(moved.books.position(PRIMARY, 'AAA')?.qty).toBeGreaterThan(0);
    const before = { equity: equity(moved), state: state(moved) };

    moved.setDailyGbpUsd(1.05);
    for (const target of [moved, still]) await target.cycle('2026-09-28');
    expect(equity(moved)).toBe(before.equity);
    expect(state(moved)).toEqual(before.state);
    expect(state(moved)).toMatchObject({ ytdLossGbp: 0, sizeMultiplier: 1 });

    moved.setDailyGbpUsd(1.6);
    const sizes = await Promise.all([moved, still].map((t) => enterOn(t, '2026-09-29', 'BBB')));
    expect(sizes[0]).toBe(sizes[1]);
    expect(state(moved)).toEqual(state(still));
  });

  it('the budget resets on 1 January: a December halt trades at full size in the new year', async () => {
    const target = drill([2026, 2027]);
    await target.cycle('2026-12-29');
    await markLoss(target, 1_600, '2026-12-30');
    expect(state(target)).toMatchObject({ halted: true, ytdLossGbp: 1_600 });
    await target.cycle('2026-12-31');
    expect(state(target).halted).toBe(true);

    const january = await enterOn(target, '2027-01-04', 'AAA');
    expect(january).toBe(expectedShares(START_CAPITAL_GBP - 1_600, 1, '2027-01-04'));
    expect(january).toBeGreaterThan(0);
    expect(state(target)).toMatchObject({
      referenceEquityGbp: START_CAPITAL_GBP - 1_600,
      ytdLossGbp: 0,
      sizeMultiplier: 1,
      halted: false,
    });

    await markLoss(target, 500, '2027-01-05');
    expect(state(target)).toMatchObject({ ytdLossGbp: 500, sizeMultiplier: 0.5 });
  });

  it('a deposit moves the cash anchor and never rebases the budget', async () => {
    const target = drill();
    await target.cycle('2026-09-24');
    await markLoss(target, 600, '2026-09-25');
    await target.cycle('2026-09-28');
    const before = state(target);
    expect(before).toMatchObject({ ytdLossGbp: 600, sizeMultiplier: 0.5 });

    target.cashAnchors.recordAnchor('alpaca', 'paper', 12_500, '2026-09-28');
    const anchored = recordCashMove(
      {
        venue: 'alpaca',
        kind: 'deposit',
        amountQuote: 5_000,
        reference: 'drill-deposit',
        tradingDate: '2026-09-29',
      },
      target.db,
      new SimulatedClock(new Date('2026-09-29T07:00:00.000Z')),
    );
    expect(anchored.cashQuote).toBe(17_500);

    const half = await enterOn(target, '2026-09-29', 'AAA');
    expect(state(target)).toEqual({ ...before, entriesBlockedAtNextFill: false });
    expect(half).toBe(expectedShares(START_CAPITAL_GBP - 600, 0.5, '2026-09-29'));
    expect(target.books.cash(PRIMARY)).toBe(START_CAPITAL_GBP - 600);
  });
});
