import { openSharedStore, type StoreHandle, toStoredTimestamp } from '../../shared/store/index.js';
import { matchDisposals } from './cgt-disposal-matching.js';
import { SqliteCgtFillSource } from './sqlite-cgt-fill-source.js';

interface OpenPositionSeed {
  idempotency_key: string;
  instrument: string;
  asset_class: 'stocks' | 'crypto';
  side: 'buy' | 'sell';
  arm: 'live' | 'control';
  order_state: string;
}

function seedOpenPosition(db: StoreHandle, p: OpenPositionSeed): void {
  db.prepare(
    `INSERT INTO open_positions (
       idempotency_key, debate_id, instrument, asset_class, side, intent_type,
       requested_size, filled_size, avg_entry_price, stop, target, order_state,
       broker_order_ids, opened_at, decision_timestamp, arm
     ) VALUES (?, 'debate-1', ?, ?, ?, 'entry', 10, 10, 100, 90, 120, ?, '[]', ?, ?, ?)`,
  ).run(
    p.idempotency_key,
    p.instrument,
    p.asset_class,
    p.side,
    p.order_state,
    toStoredTimestamp(new Date('2025-06-01T08:00:00Z')),
    toStoredTimestamp(new Date('2025-06-01T08:00:00Z')),
    p.arm,
  );
}

function seedClosedTrade(
  db: StoreHandle,
  key: string,
  instrument: string,
  assetClass: 'stocks' | 'crypto',
  side: 'buy' | 'sell',
  arm: 'live' | 'control',
): void {
  db.prepare(
    `INSERT INTO closed_trades (
       idempotency_key, debate_id, instrument, asset_class, side, entry, stop,
       filled_size, realized_pnl_net, fees_total, opened_at, closed_at,
       close_reason, arm, modelled_cost_charged
     ) VALUES (?, 'debate-1', ?, ?, ?, 100, 90, 10, 197, 3, ?, ?, 'target', ?, 1)`,
  ).run(
    key,
    instrument,
    assetClass,
    side,
    toStoredTimestamp(new Date('2025-06-02T08:00:00Z')),
    toStoredTimestamp(new Date('2025-06-02T14:00:00Z')),
    arm,
  );
}

function seedFill(
  db: StoreHandle,
  key: string,
  brokerFillId: string,
  leg: 'entry' | 'stop' | 'target' | 'exit',
  price: number,
  qty: number,
  fee: number,
  timestamp: Date,
  feeCurrency: string | null = null,
): void {
  db.prepare(
    `INSERT INTO fills (idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, fee_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(key, brokerFillId, leg, price, qty, fee, toStoredTimestamp(timestamp), feeCurrency);
}

describe('SqliteCgtFillSource — resolves instrument/arm across closed AND open lots', () => {
  it('reads a fully closed lot via closed_trades', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'closed-1', 'LSE:TEST', 'stocks', 'buy', 'live');
    seedFill(db, 'closed-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'));
    seedFill(db, 'closed-1', 'f2', 'target', 120, 10, 2, new Date('2025-06-02T14:00:00Z'));

    const { legs } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.instrument === 'LSE:TEST')).toBe(true);
    expect(legs.find((l) => l.kind === 'acquisition')?.grossAmount).toBe(1000);
    expect(legs.find((l) => l.kind === 'disposal')?.grossAmount).toBe(1200);
  });

  it('reads a still-open lot via open_positions — the pure-closed_trades join would silently drop this', () => {
    const db = openSharedStore(':memory:');
    seedOpenPosition(db, {
      idempotency_key: 'open-1',
      instrument: 'LSE:OPEN',
      asset_class: 'stocks',
      side: 'buy',
      arm: 'live',
      order_state: 'filled',
    });
    seedFill(db, 'open-1', 'f1', 'entry', 50, 20, 1, new Date('2025-06-03T08:00:00Z'));

    const { legs } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(legs).toHaveLength(1);
    expect(legs[0].instrument).toBe('LSE:OPEN');
    expect(legs[0].kind).toBe('acquisition');
  });

  it('prefers closed_trades over open_positions when a key names a row in both, without duplicating legs', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'both-1', 'LSE:CLOSED', 'stocks', 'buy', 'live');
    seedOpenPosition(db, {
      idempotency_key: 'both-1',
      instrument: 'LSE:STALE-OPEN-ROW',
      asset_class: 'stocks',
      side: 'buy',
      arm: 'live',
      order_state: 'filled',
    });
    seedFill(db, 'both-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'));
    seedFill(db, 'both-1', 'f2', 'target', 120, 10, 2, new Date('2025-06-02T14:00:00Z'));

    const { legs } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    // Both PKs are single-column on idempotency_key, so the two LEFT JOINs
    // cannot fan out — 2 legs, not 4 — and closed_trades wins the `??`.
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.instrument === 'LSE:CLOSED')).toBe(true);
  });

  it('excludes the control arm even when it shares the instrument with a live lot', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'control-1', 'LSE:TEST', 'stocks', 'buy', 'control');
    seedFill(db, 'control-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'));
    seedFill(db, 'control-1', 'f2', 'target', 120, 10, 2, new Date('2025-06-02T14:00:00Z'));

    const { legs } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(legs).toHaveLength(0);
  });

  it('excludes crypto rows — this report is scoped to the Saxo GIA equity leg', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'crypto-1', 'BTC-USD', 'crypto', 'buy', 'live');
    seedFill(db, 'crypto-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'));
    seedFill(db, 'crypto-1', 'f2', 'target', 120, 10, 2, new Date('2025-06-02T14:00:00Z'));

    const { legs } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(legs).toHaveLength(0);
  });

  it('throws on a side=sell lot rather than silently pricing a short sale', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'short-1', 'LSE:TEST', 'stocks', 'sell', 'live');
    seedFill(db, 'short-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'));

    expect(() => new SqliteCgtFillSource(db).getLiveEquityFillLegs()).toThrow(/short/i);
  });

  it('throws on a fill whose lot is in neither closed_trades nor open_positions', () => {
    const db = openSharedStore(':memory:');
    seedFill(db, 'orphan-1', 'f1', 'exit', 100, 10, 1, new Date('2025-06-02T08:05:00Z'));

    expect(() => new SqliteCgtFillSource(db).getLiveEquityFillLegs()).toThrow(/instrument/i);
  });
});

describe('SqliteCgtFillSource — currency handling (#1518 review round 1, finding 1)', () => {
  it('normalises a GBX (pence) fee/price to GBP rather than summing pence as pounds', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'gbx-1', 'LSE:TEST', 'stocks', 'buy', 'live');
    seedFill(db, 'gbx-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'), 'GBX');

    const { legs, unconverted } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(unconverted).toHaveLength(0);
    expect(legs).toHaveLength(1);
    expect(legs[0].grossAmount).toBe(10); // (100 * 10) / 100
    expect(legs[0].charges).toBeCloseTo(0.01); // 1 / 100
  });

  it('normalises GBp (lowercase p, vendor pence spelling) the same as GBX — pence-first check, not swallowed by a case-insensitive GBP match', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'gbp-lower-1', 'LSE:TEST', 'stocks', 'buy', 'live');
    seedFill(db, 'gbp-lower-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'), 'GBp');

    const { legs, unconverted } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(unconverted).toHaveLength(0);
    expect(legs).toHaveLength(1);
    expect(legs[0].grossAmount).toBe(10); // (100 * 10) / 100, not 1000 — 'GBp'.toUpperCase() === 'GBP' would 100x this if pence weren't checked first
    expect(legs[0].charges).toBeCloseTo(0.01);
  });

  it('routes a non-GBP/GBX fee (e.g. USD) to the unconverted list, in native currency, rather than aborting the report or inventing an FX rate', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'usd-1', 'LSE:TEST', 'stocks', 'buy', 'live');
    seedFill(db, 'usd-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'), 'USD');
    seedFill(db, 'usd-1', 'f2', 'target', 120, 10, 2, new Date('2025-06-02T14:00:00Z'), 'USD');

    const { legs, unconverted } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(legs).toHaveLength(0);
    expect(unconverted).toHaveLength(2);
    expect(unconverted.every((f) => f.currency === 'USD')).toBe(true);
    expect(unconverted.find((f) => f.kind === 'acquisition')?.grossAmount).toBe(1000);
    expect(unconverted.find((f) => f.kind === 'disposal')?.grossAmount).toBe(1200);
  });

  it('treats a null fee_currency (pre-#1220 legacy fills) as GBP, unchanged from before', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'legacy-1', 'LSE:TEST', 'stocks', 'buy', 'live');
    seedFill(db, 'legacy-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'), null);

    const { legs, unconverted } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();

    expect(unconverted).toHaveLength(0);
    expect(legs).toHaveLength(1);
    expect(legs[0].grossAmount).toBe(1000);
  });
});

describe('SqliteCgtFillSource + matchDisposals — cross-check against closed_trades.realized_pnl_net', () => {
  it('a full same-day round trip: total gain equals the independently-computed realized_pnl_net, never read from closed_trades itself', () => {
    const db = openSharedStore(':memory:');
    seedClosedTrade(db, 'closed-1', 'LSE:TEST', 'stocks', 'buy', 'live');
    seedFill(db, 'closed-1', 'f1', 'entry', 100, 10, 1, new Date('2025-06-02T08:05:00Z'));
    seedFill(db, 'closed-1', 'f2', 'target', 120, 10, 2, new Date('2025-06-02T14:00:00Z'));

    const { legs } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();
    const matched = matchDisposals(legs);
    const totalGain = matched.reduce((sum, m) => sum + m.gain, 0);

    // qty*(exit-entry) - totalFees = 10*(120-100) - 3 = 197, the SAME formula
    // `closedTrade()` uses for `realized_pnl_net` — computed here from the raw
    // fills, independently of the `closed_trades` row seeded above.
    expect(totalGain).toBe(197);
  });
});
