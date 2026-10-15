import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  formatSignalFillFidelity,
  main,
  pairSignalFills,
  readSignalEntries,
  reportSignalFillFidelity,
  type SignalEntryRow,
  summariseSignalFills,
} from './signal-fill-fidelity.js';

const PRIMARY = 'signals/primary';
const SHADOW = 'signals/no-veto';
const OPEN = { from: '0000-01-01', to: '9999-12-31' };

interface OrderSeed {
  readonly book: string;
  readonly signal: string | undefined;
  readonly date?: string;
  readonly instrument?: string;
  readonly venue?: string;
  readonly leg?: string;
  readonly dryRun?: number;
  readonly outcome?: string;
  readonly fills?: readonly {
    readonly qty: number;
    readonly price: number;
    readonly leg?: string;
  }[];
}

function seededStore(orders: readonly OrderSeed[]): StoreHandle {
  const db = migratedMemoryStore();
  const book = db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES (?, ?, ?, 7000, 7000, '2026-10-01T00:00:00Z')`,
  );
  book.run(PRIMARY, 'signals', 'primary');
  book.run(SHADOW, 'signals', 'no-veto');
  book.run('debate/primary', 'debate', 'primary');
  const decision = db.prepare(
    `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
       direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
     VALUES (?, ?, ?, ?, 'alpaca', 'h', 'bullish', 1, 'enter_long', 'r', 10, 90, ?, 't')`,
  );
  const order = db.prepare(
    `INSERT INTO v2_orders (client_order_id, decision_id, book_id, trading_date, instrument, venue,
       leg, side, dry_run, outcome, payload, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'buy', ?, ?, '{}', 't')`,
  );
  const fill = db.prepare(
    `INSERT INTO v2_fills (fill_id, client_order_id, book_id, trading_date, instrument, venue, leg,
       side, qty, price_gbp, fee_gbp, price_native, recorded_at, broker_mode)
     VALUES (?, ?, ?, ?, ?, 'alpaca', ?, 'buy', ?, 1, 0, ?, 't', 'paper')`,
  );
  orders.forEach((seed, index) => {
    const id = `o${index}`;
    const date = seed.date ?? '2026-10-14';
    const instrument = seed.instrument ?? 'AAPL';
    const payload = seed.signal === undefined ? {} : { signal_id: seed.signal };
    decision.run(`d${index}`, seed.book, date, instrument, JSON.stringify(payload));
    order.run(
      id,
      `d${index}`,
      seed.book,
      date,
      instrument,
      seed.venue ?? 'alpaca',
      seed.leg ?? 'entry',
      seed.dryRun ?? 0,
      seed.outcome ?? (seed.book === SHADOW ? 'simulated' : 'submitted'),
    );
    (seed.fills ?? []).forEach((part, n) => {
      fill.run(
        `${id}-f${n}`,
        id,
        seed.book,
        date,
        instrument,
        part.leg ?? 'entry',
        part.qty,
        part.price,
      );
    });
  });
  return db;
}

function row(overrides: Partial<SignalEntryRow>): SignalEntryRow {
  return {
    signal_id: 's1',
    instrument: 'AAPL',
    variant: 'primary',
    at_broker: 1,
    filled_qty: 10,
    filled_value_native: 1000,
    ...overrides,
  };
}

describe('readSignalEntries', () => {
  it('reads signals entries in the window with their native fill totals', () => {
    const db = seededStore([
      {
        book: PRIMARY,
        signal: 's1',
        fills: [
          { qty: 4, price: 100 },
          { qty: 6, price: 101 },
        ],
      },
      { book: SHADOW, signal: 's1', fills: [{ qty: 10, price: 100.5 }] },
      { book: PRIMARY, signal: 's2', dryRun: 1, outcome: 'refused_dry_run' },
      { book: PRIMARY, signal: 's3', fills: [{ qty: 10, price: 50, leg: 'stop' }] },
      { book: PRIMARY, signal: 's4', date: '2026-10-20' },
      { book: PRIMARY, signal: 's5', leg: 'exit' },
      { book: 'debate/primary', signal: 's6' },
      { book: PRIMARY, signal: undefined },
    ]);
    const rows = readSignalEntries(db, { from: '2026-10-01', to: '2026-10-19' });
    db.close();
    expect(rows).toEqual([
      row({ filled_value_native: 1006 }),
      row({ variant: 'no-veto', at_broker: 0, filled_value_native: 1005 }),
      row({ signal_id: 's2', at_broker: 0, filled_qty: null, filled_value_native: null }),
      row({ signal_id: 's3', filled_qty: null, filled_value_native: null }),
    ]);
  });

  it('counts only a submitted or cancelled Alpaca primary as at the broker', () => {
    const db = seededStore([
      { book: PRIMARY, signal: 'a', outcome: 'cancelled' },
      { book: PRIMARY, signal: 'b', outcome: 'rejected' },
      { book: PRIMARY, signal: 'c', venue: 'saxo' },
    ]);
    const atBroker = readSignalEntries(db, OPEN).map((entry) => entry.at_broker);
    db.close();
    expect(atBroker).toEqual([1, 0, 0]);
  });
});

describe('pairSignalFills', () => {
  it('pairs the real fill with the shadow fill and signs the delta against the real leg', () => {
    expect(
      pairSignalFills([
        row({ filled_value_native: 1010 }),
        row({ variant: 'no-veto', at_broker: 0, filled_value_native: 1000 }),
      ]),
    ).toEqual([
      {
        signalId: 's1',
        instrument: 'AAPL',
        pairing: 'paired',
        primaryPrice: 101,
        shadowPrice: 100,
        deltaBps: 100,
      },
    ]);
  });

  it('names why a signal has no pair', () => {
    const shadowOf = (signal_id: string, filled: boolean) =>
      row({
        signal_id,
        variant: 'no-veto',
        at_broker: 0,
        filled_qty: filled ? 10 : null,
        filled_value_native: filled ? 1000 : null,
      });
    const unfilledPrimary = (signal_id: string) =>
      row({ signal_id, filled_qty: 0, filled_value_native: 0 });
    const pairs = pairSignalFills([
      shadowOf('vetoed', true),
      row({ signal_id: 'dry', at_broker: 0 }),
      shadowOf('dry', true),
      row({ signal_id: 'lone' }),
      unfilledPrimary('p-miss'),
      shadowOf('p-miss', true),
      row({ signal_id: 's-miss' }),
      shadowOf('s-miss', false),
      unfilledPrimary('both'),
      shadowOf('both', false),
      row({ signal_id: 'no-value', filled_value_native: null }),
      shadowOf('no-value', false),
    ]);
    expect(
      pairs.map((pair) => [pair.signalId, pair.pairing, pair.primaryPrice, pair.shadowPrice]),
    ).toEqual([
      ['vetoed', 'no_broker_primary', undefined, 100],
      ['dry', 'no_broker_primary', undefined, 100],
      ['lone', 'no_shadow', 100, undefined],
      ['p-miss', 'primary_unfilled', undefined, 100],
      ['s-miss', 'shadow_unfilled', 100, undefined],
      ['both', 'both_unfilled', undefined, undefined],
      ['no-value', 'both_unfilled', undefined, undefined],
    ]);
    expect(pairs.every((pair) => pair.deltaBps === undefined)).toBe(true);
  });
});

function paired(signalId: string, deltaBps: number) {
  return {
    signalId,
    instrument: 'AAPL',
    pairing: 'paired' as const,
    primaryPrice: 100 + deltaBps / 100,
    shadowPrice: 100,
    deltaBps,
  };
}

describe('summariseSignalFills', () => {
  it('averages the paired deltas only, and takes the middle pair for an even count', () => {
    const unpaired = { ...paired('x', 0), pairing: 'no_shadow' as const, deltaBps: undefined };
    const summary = summariseSignalFills([
      paired('a', 10),
      paired('b', -30),
      paired('c', 20),
      paired('d', 40),
      unpaired,
    ]);
    expect(summary).toEqual({
      counts: {
        paired: 4,
        no_broker_primary: 0,
        no_shadow: 1,
        primary_unfilled: 0,
        shadow_unfilled: 0,
        both_unfilled: 0,
      },
      meanBps: 10,
      medianBps: 15,
      meanAbsBps: 25,
    });
  });

  it('takes the middle delta for an odd count and reports nothing with no pair', () => {
    expect(summariseSignalFills([paired('a', 5), paired('b', -1), paired('c', 9)]).medianBps).toBe(
      5,
    );
    const none = summariseSignalFills([]);
    expect([none.meanBps, none.medianBps, none.meanAbsBps]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('formatSignalFillFidelity', () => {
  it('prints the summary, the unpaired counts and one line per signal', () => {
    const unfilled = {
      signalId: 'b',
      instrument: 'MSFT',
      pairing: 'shadow_unfilled' as const,
      primaryPrice: 50.12346,
      shadowPrice: undefined,
      deltaBps: undefined,
    };
    expect(formatSignalFillFidelity([paired('a', 12.34), unfilled])).toBe(
      [
        '1 paired: mean 12.3 bps, median 12.3 bps, mean absolute 12.3 bps (positive: the real leg paid more than the shadow)',
        'unpaired: no broker primary 0, no shadow 0, primary unfilled 0, shadow unfilled 1, both unfilled 0',
        'per signal:',
        'a AAPL paired: real 100.1234, shadow 100.0000, delta 12.3 bps',
        'b MSFT shadow_unfilled: real 50.1235, shadow -, delta n/a',
      ].join('\n'),
    );
  });

  it('says so when the window holds no signals entry', () => {
    expect(formatSignalFillFidelity([])).toBe('no signals entries in the window');
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('reportSignalFillFidelity', () => {
  it('reads a store file read-only and reports its window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-fill-fidelity-'));
    dirs.push(dir);
    const path = join(dir, 'store.sqlite');
    const db = seededStore([
      { book: PRIMARY, signal: 's1', fills: [{ qty: 10, price: 101 }] },
      { book: SHADOW, signal: 's1', fills: [{ qty: 10, price: 100 }] },
    ]);
    writeFileSync(path, db.serialize());
    db.close();
    const report = reportSignalFillFidelity({ storePath: path, ...OPEN });
    expect(report.split('\n')[0]).toBe(
      '1 paired: mean 100.0 bps, median 100.0 bps, mean absolute 100.0 bps (positive: the real leg paid more than the shadow)',
    );
  });

  it('closes the store when the read throws', () => {
    let closed = false;
    const broken = {
      prepare: () => {
        throw new Error('no such table');
      },
      close: () => {
        closed = true;
      },
    } as unknown as StoreHandle;
    expect(() => reportSignalFillFidelity({ storePath: 'x', ...OPEN }, () => broken)).toThrow(
      'no such table',
    );
    expect(closed).toBe(true);
  });
});

describe('main', () => {
  it('passes the window and the default store through', async () => {
    const calls: unknown[] = [];
    const lines: string[] = [];
    const code = await main(
      ['2026-10-12', '2026-10-16'],
      (line) => lines.push(line),
      (inputs) => {
        calls.push(inputs);
        return 'report';
      },
    );
    expect([code, lines, calls]).toEqual([
      0,
      ['report'],
      [{ storePath: 'data/samurai-v2-paper.sqlite', from: '2026-10-12', to: '2026-10-16' }],
    ]);
  });

  it('passes an explicit store through', async () => {
    const stores: string[] = [];
    await main(
      ['2026-10-12', '2026-10-16', 'other.sqlite'],
      () => undefined,
      (inputs) => {
        stores.push(inputs.storePath);
        return '';
      },
    );
    expect(stores).toEqual(['other.sqlite']);
  });

  it('refuses a missing or malformed date with exit 1', async () => {
    const lines: string[] = [];
    const never = (): string => {
      throw new Error('not reached');
    };
    const missing = await main([], (line) => lines.push(line), never);
    const malformed = await main(['2026-10-12', '16/10/2026'], (line) => lines.push(line), never);
    expect([missing, malformed, lines]).toEqual([
      1,
      1,
      [
        'usage: v2:signal-fill-fidelity <from YYYY-MM-DD> <to YYYY-MM-DD> [store]; bad from (missing)',
        'usage: v2:signal-fill-fidelity <from YYYY-MM-DD> <to YYYY-MM-DD> [store]; bad to 16/10/2026',
      ],
    ]);
  });
});
