import { describe, expect, it } from 'vitest';
import type {
  BookSpec,
  BrokerBook,
  BrokerMode,
  ExecutionRoute,
  JournalledOrder,
  JournalledReconcile,
  JournalledRefusal,
  Position,
  Venue,
} from '../../../contracts/index.js';
import type { LogEntry } from '../../shared/index.js';
import {
  blockEntriesOnThrow,
  type ReconcileDeps,
  reconcileBooks,
  reconcileOrBlockEntries,
  storeView,
} from './reconcile.js';

const FX = 1.25;
const DATE = '2026-09-28';

const PRIMARY: BookSpec = {
  id: 'debate/primary',
  sleeve: 'debate',
  variant: 'primary',
  instantiated: true,
};
const SHADOW: BookSpec = {
  id: 'debate/no-macro-gate',
  sleeve: 'debate',
  variant: 'no-macro-gate',
  instantiated: true,
};
const TREND: BookSpec = {
  id: 'trend/primary',
  sleeve: 'trend',
  variant: 'primary',
  instantiated: true,
};

function held(instrument: string, qty: number, venue: Venue = 'alpaca'): Position {
  return {
    instrument,
    venue,
    qty,
    avgPriceGbp: 10,
    stopGbp: 9,
    targetGbp: 12,
    clientOrderId: `entry-${instrument}`,
    exitClientOrderId: undefined,
    openedDate: '2026-09-25',
    marksHeld: 1,
    stray: false,
    splitFactor: 1,
    splitAnchorDate: undefined,
  };
}

function resting(
  clientOrderId: string,
  instrument: string,
  venue: Venue = 'alpaca',
): JournalledOrder {
  return {
    client_order_id: clientOrderId,
    decision_id: 'd',
    book_id: PRIMARY.id,
    trading_date: '2026-09-25',
    instrument,
    venue,
    leg: 'entry',
    side: 'buy',
    dry_run: false,
    outcome: 'submitted',
    payload: {},
  };
}

interface Ledger {
  readonly books: readonly BookSpec[];
  readonly positions: Record<string, readonly Position[]>;
  readonly resting: Record<string, readonly JournalledOrder[]>;
  readonly cash: Record<string, number>;
}

const LEDGER: Ledger = {
  books: [PRIMARY, SHADOW],
  positions: {
    [PRIMARY.id]: [held('AAPL', 6), held('ISF', 40, 'saxo')],
    [SHADOW.id]: [held('MSFT', 2)],
  },
  resting: { [PRIMARY.id]: [resting('entry-NVDA', 'NVDA'), resting('entry-VUSA', 'VUSA', 'saxo')] },
  cash: { [PRIMARY.id]: 800, [SHADOW.id]: 950 },
};

const CLEAN_BROKER: BrokerBook = {
  positions: [{ instrument: 'AAPL', qty: 6 }],
  openOrders: [
    { clientOrderId: 'aapl-stop', instrument: 'AAPL', protects: 'long' },
    { clientOrderId: 'entry-NVDA', instrument: 'NVDA', protects: null },
  ],
  cashQuote: 800 * FX,
};

interface Harness {
  readonly deps: ReconcileDeps;
  readonly reconciles: JournalledReconcile[];
  readonly refusals: JournalledRefusal[];
  readonly logs: LogEntry[];
  readonly reads: Venue[];
}

function harness(
  broker: BrokerBook | Error,
  options: {
    simulatesAll?: boolean;
    tolerance?: number | undefined;
    ledger?: Ledger;
    brokerMode?: BrokerMode;
  } = {},
): Harness {
  const ledger = options.ledger ?? LEDGER;
  const reconciles: JournalledReconcile[] = [];
  const refusals: JournalledRefusal[] = [];
  const logs: LogEntry[] = [];
  const reads: Venue[] = [];
  const simulates = (route: ExecutionRoute) =>
    options.simulatesAll === true || route.bookVariant !== 'primary' || route.venue !== 'alpaca';
  const deps: ReconcileDeps = {
    registry: { ids: () => [...new Set(ledger.books.map((book) => book.sleeve))] },
    books: {
      forSleeve: (sleeveId) => ledger.books.filter((book) => book.sleeve === sleeveId),
      positions: (bookId) => ledger.positions[bookId] ?? [],
      cash: (bookId) => ledger.cash[bookId] ?? 0,
    },
    journal: {
      restingEntries: (bookId) => ledger.resting[bookId] ?? [],
      recordReconcile: (run) => reconciles.push(run),
      recordRefusal: (refusal) => refusals.push(refusal),
    },
    executor: { simulates },
    market: { gbpUsdAtYearStart: () => FX },
    brokerBooks: {
      read: (venue) => {
        reads.push(venue);
        return broker instanceof Error ? Promise.reject(broker) : Promise.resolve(broker);
      },
    },
    brokerMode: options.brokerMode ?? 'live',
    reconcileCashToleranceGbp: 'tolerance' in options ? options.tolerance : 0.01,
    logger: { log: (entry) => logs.push(entry) },
  };
  return { deps, reconciles, refusals, logs, reads };
}

describe('storeView', () => {
  it('sums one venue across books: positions, resting entries and cash', () => {
    const { deps } = harness(CLEAN_BROKER, {
      ledger: {
        ...LEDGER,
        positions: {
          [PRIMARY.id]: [held('AAPL', 6)],
          [TREND.id]: [held('AAPL', -2), held('ISF', 1, 'saxo')],
        },
      },
    });
    expect(storeView(deps, 'alpaca', [PRIMARY, TREND])).toEqual({
      positions: new Map([['AAPL', 4]]),
      openOrders: [{ clientOrderId: 'entry-NVDA', instrument: 'NVDA', protects: null }],
      cashGbp: 800,
    });
  });
});

describe('reconcileBooks', () => {
  it('reads the broker once per real venue and records a clean run that blocks nothing', async () => {
    const { deps, reconciles, refusals, logs, reads } = harness(CLEAN_BROKER);
    const outcome = await reconcileBooks(deps, DATE);

    expect(reads).toEqual(['alpaca']);
    expect(outcome).toEqual({ blockedBookIds: new Set(), refusals: [] });
    expect(refusals).toEqual([]);
    expect(logs).toEqual([]);
    expect(reconciles).toEqual([
      {
        trading_date: DATE,
        venue: 'alpaca',
        source: 'broker',
        status: 'clean',
        book_ids: [PRIMARY.id],
        diffs: [],
        detail: '',
      },
      {
        trading_date: DATE,
        venue: 'saxo',
        source: 'simulated',
        status: 'clean',
        book_ids: [PRIMARY.id, SHADOW.id],
        diffs: [],
        detail: 'simulated venue: the ledger is its book',
      },
      {
        trading_date: DATE,
        venue: 'saxo_cfd_gbp',
        source: 'simulated',
        status: 'clean',
        book_ids: [PRIMARY.id, SHADOW.id],
        diffs: [],
        detail: 'simulated venue: the ledger is its book',
      },
      {
        trading_date: DATE,
        venue: 'saxo_cfd_usd',
        source: 'simulated',
        status: 'clean',
        book_ids: [PRIMARY.id, SHADOW.id],
        diffs: [],
        detail: 'simulated venue: the ledger is its book',
      },
      {
        trading_date: DATE,
        venue: 'alpaca',
        source: 'simulated',
        status: 'clean',
        book_ids: [SHADOW.id],
        diffs: [],
        detail: 'simulated venue: the ledger is its book',
      },
    ]);
  });

  it('never reads a broker when every route is simulated (dry run, backtest)', async () => {
    const { deps, reconciles, reads } = harness(new Error('must not be read'), {
      simulatesAll: true,
    });
    const outcome = await reconcileBooks(deps, DATE);

    expect(reads).toEqual([]);
    expect(outcome.blockedBookIds.size).toBe(0);
    expect(reconciles.map((run) => [run.venue, run.source, run.status])).toEqual([
      ['alpaca', 'simulated', 'clean'],
      ['saxo', 'simulated', 'clean'],
      ['saxo_cfd_gbp', 'simulated', 'clean'],
      ['saxo_cfd_usd', 'simulated', 'clean'],
    ]);
  });

  it('on a mismatch blocks every book on that venue, alerts critical, journals the diff and a refusal per book', async () => {
    const { deps, reconciles, refusals, logs } = harness({
      ...CLEAN_BROKER,
      positions: [...CLEAN_BROKER.positions, { instrument: 'MSFT', qty: 5 }],
      openOrders: [
        ...CLEAN_BROKER.openOrders,
        { clientOrderId: 'msft-stop', instrument: 'MSFT', protects: 'long' },
      ],
    });
    const outcome = await reconcileBooks(deps, DATE);

    const diffs = [
      {
        kind: 'position_missing_in_store',
        instrument: 'MSFT',
        order_id: null,
        store: 0,
        broker: 5,
      },
      {
        kind: 'order_unknown_to_store',
        instrument: 'MSFT',
        order_id: 'msft-stop',
        store: null,
        broker: null,
      },
    ];
    const summary =
      'alpaca broker reconcile mismatch: position_missing_in_store MSFT store 0 broker 5; ' +
      'order_unknown_to_store MSFT msft-stop store - broker -';
    expect(outcome).toEqual({
      blockedBookIds: new Set([PRIMARY.id]),
      refusals: [`${PRIMARY.id}: entries blocked, ${summary}`],
    });
    expect(reconciles[0]).toMatchObject({ source: 'broker', status: 'mismatch', diffs });
    expect(logs).toEqual([
      {
        trace_id: `v2-${DATE}`,
        stage: 'v2',
        level: 'error',
        event: 'v2_reconcile_mismatch',
        message: summary,
        payload: diffs,
      },
    ]);
    expect(refusals).toEqual([
      {
        trading_date: DATE,
        scope: 'reconcile',
        parameter: 'BROKER_RECONCILE',
        ticket: '#1927',
        message: `${PRIMARY.id}: entries blocked, ${summary}`,
        book_id: PRIMARY.id,
      },
    ]);
  });

  it('compares broker cash in GBP at the venue rate', async () => {
    const off = harness({ ...CLEAN_BROKER, cashQuote: 800 }, { tolerance: 10 });
    await reconcileBooks(off.deps, DATE);
    expect(off.reconciles[0]).toMatchObject({
      status: 'mismatch',
      diffs: [{ kind: 'cash', instrument: null, order_id: null, store: 800, broker: 640 }],
      detail: 'cash cash store 800 broker 640',
    });
  });

  it('a broker read failure blocks entries fail-closed with a warning, never throws', async () => {
    const { deps, reconciles, refusals, logs } = harness(new Error('alpaca 503'));
    const outcome = await reconcileBooks(deps, DATE);

    expect(outcome.blockedBookIds).toEqual(new Set([PRIMARY.id]));
    expect(reconciles[0]).toMatchObject({ status: 'read_failed', diffs: [], detail: 'alpaca 503' });
    expect(logs).toMatchObject([
      {
        level: 'warn',
        event: 'v2_reconcile_read_failed',
        message: 'alpaca broker reconcile read_failed: alpaca 503',
      },
    ]);
    expect(refusals).toMatchObject([{ parameter: 'BROKER_RECONCILE_READ', book_id: PRIMARY.id }]);
  });

  it('a broker cash that is not a number is a read failure', async () => {
    const { deps, reconciles } = harness({ ...CLEAN_BROKER, cashQuote: Number.NaN });
    const outcome = await reconcileBooks(deps, DATE);
    expect(outcome.blockedBookIds).toEqual(new Set([PRIMARY.id]));
    expect(reconciles[0]).toMatchObject({
      status: 'read_failed',
      detail: 'broker cash NaN is not a number',
    });
  });

  it('with no cash tolerance set, blocks as unverified through a refusal, without a critical alert', async () => {
    const { deps, reconciles, refusals, logs } = harness(CLEAN_BROKER, { tolerance: undefined });
    const outcome = await reconcileBooks(deps, DATE);

    expect(outcome.blockedBookIds).toEqual(new Set([PRIMARY.id]));
    expect(reconciles[0]).toMatchObject({
      status: 'unverified',
      diffs: [{ kind: 'cash_unverified', store: 800, broker: 800 }],
    });
    expect(logs).toEqual([]);
    expect(refusals).toMatchObject([
      { parameter: 'RECONCILE_CASH_TOLERANCE_GBP', ticket: '#1927', book_id: PRIMARY.id },
    ]);
  });

  it('an unverified cash beside a real difference is a mismatch', async () => {
    const { deps, reconciles, logs } = harness(
      { ...CLEAN_BROKER, positions: [] },
      { tolerance: undefined },
    );
    await reconcileBooks(deps, DATE);
    expect(reconciles[0]?.status).toBe('mismatch');
    expect(logs.map((entry) => entry.level)).toEqual(['error']);
  });

  it('pools every primary book on one account: a position split across books reconciles clean', async () => {
    const { deps, reconciles } = harness(
      { ...CLEAN_BROKER, positions: [{ instrument: 'AAPL', qty: 9 }], cashQuote: 1_700 * FX },
      {
        ledger: {
          books: [PRIMARY, TREND],
          positions: { [PRIMARY.id]: [held('AAPL', 6)], [TREND.id]: [held('AAPL', 3)] },
          resting: LEDGER.resting,
          cash: { [PRIMARY.id]: 800, [TREND.id]: 900 },
        },
      },
    );
    await reconcileBooks(deps, DATE);
    expect(reconciles[0]).toMatchObject({
      source: 'broker',
      status: 'clean',
      book_ids: [PRIMARY.id, TREND.id],
    });
  });
  it('on paper never compares cash, even with no tolerance set, and journals that it did not', async () => {
    const { deps, reconciles, refusals, logs } = harness(
      { ...CLEAN_BROKER, cashQuote: 1 },
      { brokerMode: 'paper', tolerance: undefined },
    );
    const outcome = await reconcileBooks(deps, DATE);

    expect(outcome.blockedBookIds.size).toBe(0);
    expect(refusals).toEqual([]);
    expect(logs).toEqual([]);
    expect(reconciles[0]).toMatchObject({
      source: 'broker',
      status: 'clean',
      diffs: [],
      detail: 'cash not compared on paper (David 2026-09-29, #1872)',
    });
  });

  it('on paper still blocks a position difference, naming that cash was not compared', async () => {
    const { deps, reconciles } = harness(
      { ...CLEAN_BROKER, positions: [] },
      { brokerMode: 'paper', tolerance: undefined },
    );
    const outcome = await reconcileBooks(deps, DATE);

    expect(outcome.blockedBookIds).toEqual(new Set([PRIMARY.id]));
    expect(reconciles[0]).toMatchObject({
      status: 'mismatch',
      detail:
        'position_missing_at_broker AAPL store 6 broker 0; cash not compared on paper (David 2026-09-29, #1872)',
    });
  });
});

describe('reconcileOrBlockEntries', () => {
  it('passes a completed reconcile through unchanged', async () => {
    const { deps } = harness(CLEAN_BROKER);
    expect(await reconcileOrBlockEntries(deps, DATE)).toEqual({
      blockedBookIds: new Set(),
      refusals: [],
    });
  });

  it('a store throw blocks every book with an error alert and journals nothing (#1927)', async () => {
    const { deps, refusals, logs } = harness(CLEAN_BROKER, {
      ledger: { ...LEDGER, books: [PRIMARY, SHADOW, TREND] },
    });
    const outcome = await reconcileOrBlockEntries(
      {
        ...deps,
        journal: {
          ...deps.journal,
          recordReconcile: () => {
            throw new Error('SQLITE_BUSY');
          },
        },
      },
      DATE,
    );

    const summary = 'reconcile threw: SQLITE_BUSY';
    expect(outcome).toEqual({
      blockedBookIds: new Set([PRIMARY.id, SHADOW.id, TREND.id]),
      refusals: [PRIMARY.id, SHADOW.id, TREND.id].map((id) => `${id}: entries blocked, ${summary}`),
    });
    expect(refusals).toEqual([]);
    expect(logs).toEqual([
      {
        trace_id: `v2-${DATE}`,
        stage: 'v2',
        level: 'error',
        event: 'v2_reconcile_threw',
        message: summary,
      },
    ]);
  });

  it('a throwing logger does not escape the catch (#1927)', async () => {
    const { deps } = harness(CLEAN_BROKER);
    const outcome = await reconcileOrBlockEntries(
      {
        ...deps,
        logger: {
          log: () => {
            throw new Error('logger down');
          },
        },
        books: {
          ...deps.books,
          positions: () => {
            throw new Error('SQLITE_CORRUPT');
          },
        },
      },
      DATE,
    );
    expect(outcome.blockedBookIds).toEqual(new Set([PRIMARY.id, SHADOW.id]));
  });

  it('still blocks every book when no logger is wired', async () => {
    const { deps } = harness(CLEAN_BROKER);
    const outcome = await reconcileOrBlockEntries(
      {
        ...deps,
        logger: undefined,
        books: {
          ...deps.books,
          positions: () => {
            throw new Error('SQLITE_CORRUPT');
          },
        },
      },
      DATE,
    );
    expect(outcome.blockedBookIds).toEqual(new Set([PRIMARY.id, SHADOW.id]));
  });
});

describe('blockEntriesOnThrow', () => {
  it('journals a read_failed run for every venue group, so a same-date clean run no longer reads as the latest (#1927)', () => {
    const { deps, reconciles } = harness(CLEAN_BROKER);
    blockEntriesOnThrow(
      deps,
      DATE,
      { event: 'v2_fill_sweep_threw', what: 'fill sweep' },
      new Error('SQLITE_BUSY'),
    );

    expect(reconciles.map((run) => [run.venue, run.source, run.book_ids])).toEqual([
      ['alpaca', 'broker', [PRIMARY.id]],
      ['saxo', 'simulated', [PRIMARY.id, SHADOW.id]],
      ['saxo_cfd_gbp', 'simulated', [PRIMARY.id, SHADOW.id]],
      ['saxo_cfd_usd', 'simulated', [PRIMARY.id, SHADOW.id]],
      ['alpaca', 'simulated', [SHADOW.id]],
    ]);
    const failed = {
      trading_date: DATE,
      status: 'read_failed',
      diffs: [],
      detail: 'fill sweep threw: SQLITE_BUSY',
    };
    expect(reconciles).toEqual(reconciles.map(() => expect.objectContaining(failed)));
  });

  it('still blocks every book when the journal write throws too', () => {
    const { deps } = harness(CLEAN_BROKER);
    const outcome = blockEntriesOnThrow(
      {
        ...deps,
        journal: {
          ...deps.journal,
          recordReconcile: () => {
            throw new Error('SQLITE_BUSY');
          },
        },
      },
      DATE,
      { event: 'v2_split_rescale_threw', what: 'split rescale' },
      new Error('SQLITE_BUSY'),
    );
    expect(outcome.blockedBookIds).toEqual(new Set([PRIMARY.id, SHADOW.id]));
  });
});
