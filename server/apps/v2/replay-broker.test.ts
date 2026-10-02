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

  it('reads a flatten only by the fills journalled by the first reconcile, as the resume saw it live', async () => {
    order('late-exit', 'submitted', { size: 10 });
    fill('alpaca:l1', 'late-exit', 7, 0, { qty: 4, at: `${DAY}T07:31:00.000Z` });
    reconciled(`${DAY}T07:32:00.000Z`);
    fill('alpaca:l2', 'late-exit', 7, 0, { qty: 6, at: `${DAY}T07:40:00.000Z` });
    order('swept-exit', 'submitted', { size: 3 });
    fill('alpaca:s1', 'swept-exit', 7, 0, { at: `${DAY}T07:40:00.000Z` });
    const state = async (id: string) => (await broker().resumeFlatten(id))?.order_state;
    expect(await state('late-exit')).toBe('partially_filled');
    expect(await state('swept-exit')).toBe('submitted');
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

  it('replaces a stale stop as the journalled replace went: refused at its step with its detail, else accepted (#1990)', async () => {
    order('entry', 'submitted', {});
    const replace = {
      entryClientOrderId: 'entry',
      instrument: 'UP',
      side: 'buy' as const,
      qty: 3,
      stop: 9,
      target: 12,
    };
    await expect(broker().replaceProtectiveLegs(replace)).resolves.toBeUndefined();
    order('v2-debate-primary-2026-09-30-UP-restop', 'rejected', {
      detail: 'oco refused',
      failed_step: 'place',
    });
    await expect(broker().replaceProtectiveLegs(replace)).rejects.toMatchObject({
      name: 'ProtectiveReplaceError',
      step: 'place',
      message: 'oco refused',
    });
  });

  it('replays a journalled replace refused with no step journalled as a cancel failure', async () => {
    order('entry', 'submitted', {});
    order('v2-debate-primary-2026-09-30-UP-restop', 'rejected', {});
    await expect(
      broker().replaceProtectiveLegs({
        entryClientOrderId: 'entry',
        instrument: 'UP',
        side: 'buy',
        qty: 3,
        stop: 9,
        target: 12,
      }),
    ).rejects.toMatchObject({ step: 'cancel', message: '' });
  });

  it('accepts a replace the journal sent and the venue accepted', async () => {
    order('entry', 'submitted', {});
    order('v2-debate-primary-2026-09-30-UP-restop', 'submitted', { detail: 'submitted' });
    await expect(
      broker().replaceProtectiveLegs({
        entryClientOrderId: 'entry',
        instrument: 'UP',
        side: 'buy',
        qty: 3,
        stop: 9,
        target: 12,
      }),
    ).resolves.toBeUndefined();
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
      openOrders: [
        { clientOrderId: 'rest', instrument: 'NEW', protects: null, qty: null, stopPrice: null },
      ],
    }));

  it('mirrors the replayed store, each position guarded, after a clean journalled reconcile', async () => {
    reconcile('clean');
    await expect(books().read('alpaca')).resolves.toEqual({
      positions: [
        { instrument: 'UP', qty: 3 },
        { instrument: 'DN', qty: -2 },
      ],
      openOrders: [
        { clientOrderId: 'rest', instrument: 'NEW', protects: null, qty: null, stopPrice: null },
        {
          clientOrderId: 'replay-UP-stop',
          instrument: 'UP',
          protects: 'long',
          qty: 3,
          stopPrice: null,
        },
        {
          clientOrderId: 'replay-DN-stop',
          instrument: 'DN',
          protects: 'short',
          qty: 2,
          stopPrice: null,
        },
      ],
      cashQuote: 0,
    });
  });

  it('fails the read, so entries block, after any other journalled reconcile or none', async () => {
    await expect(books().read('alpaca')).rejects.toThrow('reconcile on 2026-09-30 was not run');
    reconcile('mismatch');
    await expect(books().read('alpaca')).rejects.toThrow('was mismatch: detail');
  });

  const mismatched = (diffs: readonly Record<string, unknown>[]) =>
    db
      .prepare(
        `INSERT INTO v2_reconciles (trading_date, venue, source, status, book_ids, diffs, detail,
           recorded_at)
         VALUES (?, 'alpaca', 'broker', 'mismatch', '[]', ?, 'stale', 'now')`,
      )
      .run(DAY, JSON.stringify(diffs));
  const diff = (kind: string, fields: Record<string, unknown>) => ({
    kind,
    instrument: 'UP',
    order_id: null,
    store: 3,
    broker: null,
    ...fields,
  });

  it('mirrors a reconcile that found only stale stops with those stops, so the replay re-finds them (#1990)', async () => {
    mismatched([
      diff('protective_qty', { broker: 2 }),
      diff('protective_price', { order_id: 'leg', store: 6, broker: 9 }),
    ]);
    const { openOrders } = await books().read('alpaca');
    expect(openOrders.slice(1)).toEqual([
      { clientOrderId: 'leg', instrument: 'UP', protects: 'long', qty: 2, stopPrice: 9 },
      {
        clientOrderId: 'replay-DN-stop',
        instrument: 'DN',
        protects: 'short',
        qty: 2,
        stopPrice: null,
      },
    ]);
  });

  it('mirrors a stale price alone at the mirrored qty', async () => {
    mismatched([diff('protective_price', { order_id: 'leg', store: 6, broker: 9 })]);
    const { openOrders } = await books().read('alpaca');
    expect(openOrders[1]).toEqual({
      clientOrderId: 'leg',
      instrument: 'UP',
      protects: 'long',
      qty: 3,
      stopPrice: 9,
    });
  });

  it('mirrors a reconcile that found a position with no stop without its stop, so the replay re-arms it (#1990)', async () => {
    mismatched([diff('position_unprotected', { broker: 3 })]);
    const { openOrders } = await books().read('alpaca');
    expect(openOrders.map((order) => order.clientOrderId)).not.toContain('replay-UP-stop');
    expect(openOrders.at(-1)).toEqual({
      clientOrderId: 'replay-DN-stop',
      instrument: 'DN',
      protects: 'short',
      qty: 2,
      stopPrice: null,
    });
  });

  it('still fails the read on a mismatch that is not only stale stops', async () => {
    mismatched([diff('protective_qty', { broker: 2 }), diff('position_qty', { broker: 4 })]);
    await expect(books().read('alpaca')).rejects.toThrow('was mismatch: stale');
  });
});
