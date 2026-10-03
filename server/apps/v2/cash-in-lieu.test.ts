import { describe, expect, it, vi } from 'vitest';
import type { BrokerCashInLieu, BrokerCashInLieuReader } from '../../../contracts/index.js';
import type { LogEntry } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { CASH_IN_LIEU_LOOKBACK_DAYS, readBrokerCashInLieu } from './cash-in-lieu.js';
import { Journal } from './journal/index.js';

const PAID: BrokerCashInLieu = {
  activity_id: 'cil-1',
  instrument: 'NVDA',
  activity_date: '2026-09-30',
  qty: 0.5,
  amount: 61.2,
  currency: 'USD',
  status: 'executed',
};

const MARKET = {
  gbpUsdAtYearStart: () => 1.25,
  gbpUsdYearStartFixDate: () => '2025-12-31',
};

function storeWithEstimate(
  fillDate: string | null,
  outcome = 'submitted',
  venue = 'alpaca',
): StoreHandle {
  const db = openSharedStore(':memory:');
  db.prepare(
    `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
       leg, side, dry_run, outcome, payload, recorded_at)
     VALUES ('o1', NULL, 'debate/primary', '2026-09-01', 'NVDA', ?, 'entry', 'buy', 0, ?, '{}',
       '2026-09-01T14:00:00.000Z')`,
  ).run(venue, outcome);
  db.prepare(
    `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
       side, qty, price_gbp, fee_gbp, recorded_at, fill_date, broker_mode)
     VALUES ('cil', 'o1', 'debate/primary', '2026-09-29', 'NVDA', ?, 'cash_in_lieu', 'sell', 0.5,
       90, 0, '2026-09-29T07:00:00.000Z', ?, 'paper')`,
  ).run(venue, fillDate);
  return db;
}

function harness(db: StoreHandle, read: BrokerCashInLieuReader['read'] = async () => [PAID]) {
  const clock = new SimulatedClock(new Date('2026-10-01T07:00:00.000Z'));
  const entries: LogEntry[] = [];
  const reader = { venue: 'alpaca' as const, read: vi.fn(read) };
  const deps = {
    cashInLieu: reader,
    journal: new Journal(db, clock),
    market: MARKET,
    logger: { log: (entry: LogEntry) => entries.push(entry) },
  };
  return { deps, reader, entries };
}

const rows = (db: StoreHandle) => db.prepare('SELECT * FROM v2_cash_in_lieu').all();

describe('readBrokerCashInLieu (#2001)', () => {
  it("journals each broker payment once with the run's booking rate, and logs it", async () => {
    const db = storeWithEstimate('2026-09-29');
    const { deps, reader, entries } = harness(db);
    await expect(readBrokerCashInLieu(deps, '2026-10-01')).resolves.toBe(1);
    expect(reader.read).toHaveBeenCalledWith('2026-08-30');
    expect(rows(db)).toEqual([
      {
        venue: 'alpaca',
        activity_id: 'cil-1',
        instrument: 'NVDA',
        activity_date: '2026-09-30',
        qty: 0.5,
        amount_native: 61.2,
        currency: 'USD',
        status: 'executed',
        fx_quote_per_gbp: 1.25,
        fx_source: 'boe-xudluss:year-start:2026@2025-12-31',
        trading_date: '2026-10-01',
        recorded_at: '2026-10-01T07:00:00.000Z',
      },
    ]);
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'v2_cash_in_lieu_read',
        message:
          'alpaca reported 61.2 USD cash in lieu of 0.5 NVDA on 2026-09-30 (activity cil-1, executed); the tax log uses it in place of the latest-close estimate',
      }),
    ]);

    await expect(readBrokerCashInLieu(deps, '2026-10-02')).resolves.toBe(0);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)).toMatchObject([{ trading_date: '2026-10-01', amount_native: 61.2 }]);
    expect(entries).toHaveLength(1);
  });

  it('adds a row when a later read reports the same activity in another status', async () => {
    const db = storeWithEstimate('2026-09-29');
    const { deps, reader } = harness(db);
    await readBrokerCashInLieu(deps, '2026-10-01');
    reader.read.mockResolvedValue([PAID, { ...PAID, status: 'canceled' }]);
    await expect(readBrokerCashInLieu(deps, '2026-10-02')).resolves.toBe(1);
    expect(rows(db)).toMatchObject([
      { activity_id: 'cil-1', status: 'executed', trading_date: '2026-10-01' },
      { activity_id: 'cil-1', status: 'canceled', trading_date: '2026-10-02' },
    ]);
  });

  it('takes no booking rate when the broker reports nothing', async () => {
    const db = storeWithEstimate('2026-09-29');
    const { deps, entries } = harness(db, async () => []);
    const market = {
      gbpUsdAtYearStart: () => {
        throw new Error('no fix');
      },
      gbpUsdYearStartFixDate: () => '2025-12-31',
    };
    await expect(readBrokerCashInLieu({ ...deps, market }, '2026-10-01')).resolves.toBe(0);
    expect(entries).toEqual([]);
  });

  it('logs a failed booking rate or journal write at warn and lets the run go on', async () => {
    const failures = [
      (deps: ReturnType<typeof harness>['deps']) => ({
        ...deps,
        market: {
          gbpUsdAtYearStart: () => {
            throw new Error('no fix');
          },
          gbpUsdYearStartFixDate: () => '2025-12-31',
        },
      }),
      (deps: ReturnType<typeof harness>['deps']) => {
        vi.spyOn(deps.journal, 'recordCashInLieu').mockImplementation(() => {
          throw new Error('disk full');
        });
        return deps;
      },
    ];
    for (const fail of failures) {
      const db = storeWithEstimate('2026-09-29');
      const { deps, entries } = harness(db);
      await expect(readBrokerCashInLieu(fail(deps), '2026-10-01')).resolves.toBe(0);
      expect(rows(db)).toEqual([]);
      expect(entries).toEqual([
        expect.objectContaining({ level: 'warn', event: 'v2_cash_in_lieu_read_failed' }),
      ]);
    }
  });

  it('names an unstated qty in the log line', async () => {
    const db = storeWithEstimate('2026-09-29');
    const { deps, entries } = harness(db, async () => [{ ...PAID, qty: null }]);
    await readBrokerCashInLieu(deps, '2026-10-01');
    expect(entries[0]?.message).toContain('cash in lieu of unstated NVDA');
    expect(rows(db)).toMatchObject([{ qty: null }]);
  });

  it('reads nothing from the broker when no broker-routed estimate is inside the lookback', async () => {
    const cases: [StoreHandle, string][] = [
      [storeWithEstimate('2026-09-29', 'simulated'), '2026-10-01'],
      [storeWithEstimate('2026-09-29', 'refused_dry_run'), '2026-10-01'],
      [storeWithEstimate('2026-09-29', 'submitted', 'saxo'), '2026-10-01'],
      [storeWithEstimate('2026-09-29'), '2026-12-29'],
    ];
    for (const [db, date] of cases) {
      const { deps, reader } = harness(db);
      await expect(readBrokerCashInLieu(deps, date)).resolves.toBe(0);
      expect(reader.read).not.toHaveBeenCalled();
      expect(rows(db)).toEqual([]);
    }
  });

  it(`still reads for an estimate exactly ${CASH_IN_LIEU_LOOKBACK_DAYS} days old, dated by its trading date when it has no fill date`, async () => {
    const dated = storeWithEstimate('2026-09-29');
    const { deps, reader } = harness(dated);
    await readBrokerCashInLieu(deps, '2026-12-28');
    expect(reader.read).toHaveBeenCalledWith('2026-08-30');

    const undated = storeWithEstimate(null);
    const second = harness(undated);
    await readBrokerCashInLieu(second.deps, '2026-10-01');
    expect(second.reader.read).toHaveBeenCalledWith('2026-08-30');
  });

  it('logs a failed read, journals nothing and lets the run go on', async () => {
    const db = storeWithEstimate('2026-09-29');
    const { deps, entries } = harness(db, async () => {
      throw new Error('503 from broker');
    });
    await expect(readBrokerCashInLieu(deps, '2026-10-01')).resolves.toBe(0);
    expect(rows(db)).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'v2_cash_in_lieu_read_failed',
        message: expect.stringContaining(
          'alpaca cash-in-lieu read failed; the tax log keeps the latest-close estimate: ',
        ),
      }),
    ]);
    expect(entries[0]?.message).toContain('503 from broker');
  });

  it('does nothing without a reader, as on a dry run or a replay', async () => {
    const db = storeWithEstimate('2026-09-29');
    const { deps } = harness(db);
    await expect(
      readBrokerCashInLieu({ ...deps, cashInLieu: undefined }, '2026-10-01'),
    ).resolves.toBe(0);
    expect(rows(db)).toEqual([]);
  });
});
