import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { JournalReplayBroker, JournalReplayBrokerBooks, nativeAmountFor } from './replay-broker.js';

const DAY = '2026-09-30';
const FX = 1.2731;
let db: StoreHandle;

function order(id: string, outcome: string, payload: Record<string, unknown>, day = DAY): void {
  db.prepare(
    `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
       leg, side, dry_run, outcome, payload, recorded_at)
     VALUES (?, NULL, 'debate/primary', ?, 'UP', 'alpaca', 'entry', 'buy', 0, ?, ?, ?)`,
  ).run(id, day, outcome, JSON.stringify(payload), `${day}T07:30:00.000Z`);
}

function fill(
  id: string,
  clientOrderId: string,
  priceGbp: number,
  feeGbp = 0,
  { qty = 3, at = `${DAY}T07:31:00.000Z`, day = DAY } = {},
): void {
  db.prepare(
    `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
       side, qty, price_gbp, fee_gbp, recorded_at)
     VALUES (?, ?, 'debate/primary', ?, 'UP', 'alpaca', 'entry', 'buy', ?, ?, ?, ?)`,
  ).run(id, clientOrderId, day, qty, priceGbp, feeGbp, at);
}

function reconciled(at: string): void {
  db.prepare(
    `INSERT INTO v2_reconciles (trading_date, venue, source, status, book_ids, diffs, detail,
       recorded_at)
     VALUES (?, 'alpaca', 'broker', 'clean', '[]', '[]', 'detail', ?)`,
  ).run(DAY, at);
}

beforeEach(() => {
  db = openSharedStore(':memory:');
  db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES ('debate/primary', 'debate', 'primary', 600, 600, 'now')`,
  ).run();
});

afterEach(() => {
  db.close();
});

const broker = () =>
  new JournalReplayBroker({ db, tradingDate: DAY, venue: 'alpaca', quotePerGbp: FX });

const bracket = (clientOrderId: string) => ({
  client_order_id: clientOrderId,
  instrument: 'UP',
  asset_class: 'stocks' as const,
  side: 'buy' as const,
  size: 3,
  entry: 10,
  stop: 9,
  target: 12,
  time_in_force: 'gtc',
});

describe('JournalReplayBroker', () => {
  it('answers a submission with the journalled state, a rejection with its detail, and refuses one never sent', async () => {
    order('sent', 'submitted', { detail: 'submitted' });
    order('later-cancelled', 'cancelled', { detail: 'pending', cancelled: '2026-10-01' });
    order('refused', 'rejected', { detail: 'insufficient buying power' });
    order('yesterday', 'submitted', { detail: 'submitted' }, '2026-09-29');
    await expect(broker().submitBracket(bracket('sent'))).resolves.toMatchObject({
      order_state: 'submitted',
    });
    await expect(broker().submitFlatten('UP', 'sell', 3, 'later-cancelled')).resolves.toMatchObject(
      { order_state: 'pending' },
    );
    await expect(broker().submitBracket(bracket('refused'))).rejects.toThrow(
      'insufficient buying power',
    );
    await expect(broker().submitBracket(bracket('yesterday'))).rejects.toThrow(
      `replay: yesterday was not sent on ${DAY}`,
    );
  });

  it('cancels only what the journal cancelled that day', async () => {
    order('cancelled-today', 'cancelled', { cancelled: DAY });
    order('cancelled-later', 'cancelled', { cancelled: '2026-10-01' });
    await expect(broker().cancel('cancelled-today')).resolves.toBeUndefined();
    await expect(broker().cancel('cancelled-later')).rejects.toThrow('was not cancelled');
    await expect(broker().cancel('unknown')).rejects.toThrow('was not cancelled');
  });

  it('re-serves the day broker fills so the cycle books the journalled bits, never a simulated fill', async () => {
    order('sent', 'submitted', {});
    fill('alpaca:abc#2', 'sent', 9.07 / FX, 0.0157 / FX);
    fill('alpaca:sim-sent', 'sent', 7);
    const fills = await broker().fetchNewFills();
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'sent', broker_fill_id: 'abc#2', qty: 3 });
    expect((fills[0]?.price ?? 0) / FX).toBe(9.07 / FX);
    expect((fills[0]?.fee ?? 0) / FX).toBe(0.0157 / FX);
  });

  it('serves at the first sweep only the fills journalled by the first reconcile, the rest from the second', async () => {
    order('sent', 'submitted', {});
    fill('alpaca:early', 'sent', 7, 0, { at: `${DAY}T07:31:00.000Z` });
    reconciled(`${DAY}T07:31:00.000Z`);
    reconciled(`${DAY}T07:40:00.000Z`);
    fill('alpaca:late', 'sent', 7, 0, { at: `${DAY}T07:35:00.000Z` });
    const sweeping = broker();
    const ids = async () => (await sweeping.fetchNewFills()).map((f) => f.broker_fill_id);
    expect(await ids()).toEqual(['early']);
    expect(await ids()).toEqual(['early', 'late']);
    expect(await ids()).toEqual(['early', 'late']);
  });

  it('serves every fill at the first sweep when the day journalled no reconcile', async () => {
    order('sent', 'submitted', {});
    fill('alpaca:late', 'sent', 7, 0, { at: `${DAY}T23:59:00.000Z` });
    expect(await broker().fetchNewFills()).toHaveLength(1);
  });

  it('reads a flatten short of its size as partially filled, across the days it filled on', async () => {
    order('partial-exit', 'submitted', { size: 10 });
    fill('alpaca:p1', 'partial-exit', 7, 0, { qty: 4, day: '2026-09-29' });
    const state = async () => (await broker().resumeFlatten('partial-exit'))?.order_state;
    expect(await state()).toBe('submitted');
    fill('alpaca:p2', 'partial-exit', 7, 0, { qty: 5 });
    fill('alpaca:p3', 'partial-exit', 7, 0, { qty: 1, day: '2026-10-01' });
    expect(await state()).toBe('partially_filled');
    fill('alpaca:p4', 'partial-exit', 7, 0, { qty: 1 });
    expect(await state()).toBe('filled');
  });

  it('reads a flatten as cancelled when the day rearmed it, filled when it filled, else still working', async () => {
    order('rearmed-exit', 'submitted', {});
    order('rearm', 'submitted', { exit_client_order_id: 'rearmed-exit' });
    order('filled-exit', 'submitted', {});
    fill('alpaca:x', 'filled-exit', 7);
    const state = async (id: string) => (await broker().resumeFlatten(id))?.order_state;
    expect(await state('rearmed-exit')).toBe('cancelled');
    expect(await state('filled-exit')).toBe('filled');
    expect(await state('working-exit')).toBe('submitted');
    await expect(broker().getOrder()).resolves.toBeNull();
    await expect(broker().getOpenPositions()).resolves.toEqual([]);
    await expect(broker().resizeProtectiveLegs()).resolves.toBeUndefined();
  });

  it('rearms as the journalled rearm went: refused with its detail, else accepted', async () => {
    order('entry', 'submitted', {});
    await expect(broker().rearmProtectiveLegs('entry', 'UP')).resolves.toBeUndefined();
    order('v2-debate-primary-2026-09-30-UP-rearm', 'rejected', { detail: 'legs held' });
    await expect(broker().rearmProtectiveLegs('entry', 'UP')).rejects.toThrow('legs held');
  });
});

describe('nativeAmountFor', () => {
  it('recovers a native amount whose quotient is the journalled GBP value', () => {
    for (const native of [0, 0.1, 0.127_31, 7.123_456_789, 1_234.567_89, 1e-7]) {
      for (const fx of [1, 1.25, 1.2731, 1.333_333_3]) {
        const gbp = native / fx;
        expect(nativeAmountFor(gbp, fx) / fx).toBe(gbp);
      }
    }
  });

  it('falls back to the plain product for a value no native amount divides to', () => {
    expect(nativeAmountFor(0.1, 1.2731)).toBe(0.1 * 1.2731);
  });
});

describe('JournalReplayBrokerBooks', () => {
  const reconcile = (status: string) =>
    db
      .prepare(
        `INSERT INTO v2_reconciles (trading_date, venue, source, status, book_ids, diffs, detail,
           recorded_at)
         VALUES (?, 'alpaca', 'broker', ?, '[]', '[]', 'detail', 'now')`,
      )
      .run(DAY, status);
  const books = () =>
    new JournalReplayBrokerBooks(db, DAY, () => ({
      positions: new Map([
        ['UP', 3],
        ['DN', -2],
      ]),
      openOrders: [{ clientOrderId: 'rest', instrument: 'NEW', protects: null }],
    }));

  it('mirrors the replayed store, each position guarded, after a clean journalled reconcile', async () => {
    reconcile('clean');
    await expect(books().read('alpaca')).resolves.toEqual({
      positions: [
        { instrument: 'UP', qty: 3 },
        { instrument: 'DN', qty: -2 },
      ],
      openOrders: [
        { clientOrderId: 'rest', instrument: 'NEW', protects: null },
        { clientOrderId: 'replay-UP-stop', instrument: 'UP', protects: 'long' },
        { clientOrderId: 'replay-DN-stop', instrument: 'DN', protects: 'short' },
      ],
      cashQuote: 0,
    });
  });

  it('fails the read, so entries block, after any other journalled reconcile or none', async () => {
    await expect(books().read('alpaca')).rejects.toThrow('reconcile on 2026-09-30 was not run');
    reconcile('mismatch');
    await expect(books().read('alpaca')).rejects.toThrow('was mismatch: detail');
  });
});
