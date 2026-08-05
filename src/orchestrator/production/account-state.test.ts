import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlpacaAccount, AlpacaClient } from '../../execution/index.js';
import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../market-data-service/index.js';
import type { ClosedTrade } from '../../shared/index.js';
import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import { SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import { SqliteSessionEquityStore } from '../sqlite-session-equity-store.js';
import type { LogEntry, Logger } from '../types.js';
import {
  AlpacaAccountStateProvider,
  type AlpacaAccountStateProviderInput,
  type ClosedTradeReader,
} from './account-state.js';

const asOf = new Date('2026-08-03T12:00:00Z');

/**
 * Saturday 12:00 UTC — the weekend instant the two calendars disagree about.
 * Crypto's session opened that morning at 00:00 UTC; the stock session has been
 * open since Friday's 16:00 ET close, which is 20:00 UTC (EDT, UTC-4).
 */
const SATURDAY_NOON_UTC = new Date('2026-08-01T12:00:00Z');
const CRYPTO_OPEN = '2026-08-01T00:00:00.000Z';
const STOCKS_OPEN = '2026-07-31T20:00:00.000Z';
/** Friday evening: after the stock session opened, before the crypto one did. */
const FRIDAY_EVENING = '2026-07-31T22:00:00.000Z';

interface Harness {
  store: SqliteAccountStateStore;
  sessionEquity: SqliteSessionEquityStore;
  db: SharedStore;
  cleanup: () => void;
}

function openStore(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-account-state-'));
  const db = openSharedStore(join(dir, 'test.sqlite'));
  return {
    store: new SqliteAccountStateStore(db),
    sessionEquity: new SqliteSessionEquityStore(db),
    db,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function makeAccount(overrides: Partial<AlpacaAccount> = {}): AlpacaAccount {
  return { cash: '50000', equity: '100000', ...overrides };
}

function makeClient(account: AlpacaAccount = makeAccount()): AlpacaClient {
  return {
    submitOrder: vi.fn(),
    getOrder: vi.fn(),
    getOrderByClientOrderId: vi.fn(),
    getAccount: vi.fn().mockResolvedValue(account),
  } as unknown as AlpacaClient;
}

function makeTrade(pnl: number, closedAt: string): ClosedTrade {
  return {
    idempotency_key: `key-${closedAt}`,
    debate_id: 'debate-abc123',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 95,
    filled_size: 10,
    realized_pnl_net: pnl,
    fees_total: 0,
    opened_at: new Date(closedAt),
    closed_at: new Date(closedAt),
    close_reason: 'stop',
  };
}

function makeTradeReader(trades: ClosedTrade[]): ClosedTradeReader {
  return { getClosedTradesBetween: vi.fn().mockReturnValue(trades) };
}

/** Writes a `closed_trades` row directly — the realized numerator is read in SQL. */
function insertClosedTrade(
  db: SharedStore,
  args: { key: string; assetClass: 'crypto' | 'stocks'; pnl: number; closedAt: string },
): void {
  db.prepare(
    `INSERT INTO closed_trades (
       idempotency_key, debate_id, instrument, asset_class, side,
       entry, stop, filled_size, realized_pnl_net, fees_total,
       opened_at, closed_at, close_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.key,
    'debate-abc123',
    args.assetClass === 'crypto' ? 'BTC-USD' : 'AAPL',
    args.assetClass,
    'buy',
    100,
    95,
    10,
    args.pnl,
    0,
    args.closedAt,
    args.closedAt,
    'stop',
  );
}

function makeProvider(
  harness: Harness,
  overrides: Partial<AlpacaAccountStateProviderInput> = {},
): AlpacaAccountStateProvider {
  return new AlpacaAccountStateProvider({
    client: makeClient(),
    store: harness.store,
    sessionEquity: harness.sessionEquity,
    closedTrades: makeTradeReader([]),
    logger: makeLogger(),
    calendars: { crypto: new AlwaysOpenCalendar(), stocks: new UsEquityRegularHoursCalendar() },
    mode: 'paper',
    // Well before every boundary these fixtures use — the healthy case, where
    // the process was already running when the session opened.
    startedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });
}

describe('SqliteAccountStateStore', () => {
  it('raises the high-water mark and never lowers it when equity dips', () => {
    const { store, cleanup } = openStore();
    try {
      expect(store.recordEquity(100_000, asOf)).toBe(100_000);
      expect(store.recordEquity(120_000, asOf)).toBe(120_000);
      // The drawdown breaker divides by this. A peak revised downward makes
      // every later drawdown read shallower than it is.
      expect(store.recordEquity(80_000, asOf)).toBe(120_000);
      expect(store.peakEquity()).toBe(120_000);
    } finally {
      cleanup();
    }
  });

  it('survives being reopened — the mark is durable, not per-process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samurai-account-state-'));
    const path = join(dir, 'test.sqlite');
    try {
      new SqliteAccountStateStore(openSharedStore(path)).recordEquity(150_000, asOf);
      // The whole point of the table: a restart must not reset the peak, or
      // the hard portfolio-drawdown breaker silently re-baselines.
      expect(new SqliteAccountStateStore(openSharedStore(path)).peakEquity()).toBe(150_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no mark before the first tick records one', () => {
    const { store, cleanup } = openStore();
    try {
      expect(store.peakEquity()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('refuses a non-finite equity rather than writing a mark the breaker divides by', () => {
    const { store, cleanup } = openStore();
    try {
      expect(() => store.recordEquity(Number.NaN, asOf)).toThrow('must be finite');
    } finally {
      cleanup();
    }
  });
});

describe('SqliteSessionEquityStore', () => {
  it('round-trips a snapshot and overwrites it on the next put', () => {
    const { sessionEquity, cleanup } = openStore();
    try {
      expect(sessionEquity.get('crypto')).toBeNull();

      sessionEquity.put('crypto', 100_000, new Date(CRYPTO_OPEN), true);
      expect(sessionEquity.get('crypto')).toEqual({
        open_equity: 100_000,
        open_at: new Date(CRYPTO_OPEN),
        observed_at_boundary: true,
      });

      sessionEquity.put('crypto', 90_000, new Date('2026-08-02T00:00:00.000Z'), true);
      expect(sessionEquity.get('crypto')?.open_equity).toBe(90_000);
    } finally {
      cleanup();
    }
  });

  it('keeps the three keys independent', () => {
    const { sessionEquity, cleanup } = openStore();
    try {
      sessionEquity.put('crypto', 1, new Date(CRYPTO_OPEN), true);
      sessionEquity.put('stocks', 2, new Date(STOCKS_OPEN), true);
      sessionEquity.put('portfolio', 3, new Date(CRYPTO_OPEN), true);

      expect(sessionEquity.get('crypto')?.open_equity).toBe(1);
      expect(sessionEquity.get('stocks')?.open_equity).toBe(2);
      expect(sessionEquity.get('portfolio')?.open_equity).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('sums realized PnL strictly after the open, scoped to the asset class', () => {
    const { sessionEquity, db, cleanup } = openStore();
    try {
      insertClosedTrade(db, {
        key: 'before',
        assetClass: 'crypto',
        pnl: -999,
        closedAt: '2026-07-31T23:00:00.000Z',
      });
      insertClosedTrade(db, {
        key: 'at-boundary',
        assetClass: 'crypto',
        pnl: -111,
        closedAt: CRYPTO_OPEN,
      });
      insertClosedTrade(db, {
        key: 'after',
        assetClass: 'crypto',
        pnl: -50,
        closedAt: '2026-08-01T06:00:00.000Z',
      });
      insertClosedTrade(db, {
        key: 'other-class',
        assetClass: 'stocks',
        pnl: 700,
        closedAt: '2026-08-01T06:00:00.000Z',
      });

      // Strict `>`: a trade closing exactly at the boundary belongs to the
      // session that just ended, not the one opening.
      expect(sessionEquity.realizedSince('crypto', new Date(CRYPTO_OPEN))).toBe(-50);
      expect(sessionEquity.realizedSinceAllClasses(new Date(CRYPTO_OPEN))).toBe(650);
    } finally {
      cleanup();
    }
  });

  it('reports zero, not null, for a session with no closes yet', () => {
    const { sessionEquity, cleanup } = openStore();
    try {
      // SUM over no rows is SQL NULL; a fresh session has realized 0, and a
      // null leaking out here would become NaN in the division.
      expect(sessionEquity.realizedSince('crypto', new Date(CRYPTO_OPEN))).toBe(0);
      expect(sessionEquity.realizedSinceAllClasses(new Date(CRYPTO_OPEN))).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-finite open equity rather than writing a denominator', () => {
    const { sessionEquity, cleanup } = openStore();
    try {
      expect(() => sessionEquity.put('crypto', Number.NaN, new Date(CRYPTO_OPEN), true)).toThrow(
        'must be finite',
      );
    } finally {
      cleanup();
    }
  });
});

describe('AlpacaAccountStateProvider — account scalars', () => {
  it('sources cash from the account ledger and peak_equity from the durable store', async () => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, {
        client: makeClient(makeAccount({ cash: '25000', equity: '90000' })),
      });

      const state = await provider.getAccountState(asOf);

      expect(state.cash).toBe(25_000);
      expect(state.peak_equity).toBe(90_000);
    } finally {
      harness.cleanup();
    }
  });

  it('counts the loss streak backwards and stops at the first win', async () => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, {
        closedTrades: makeTradeReader([
          makeTrade(-50, '2026-08-01T10:00:00Z'),
          makeTrade(120, '2026-08-02T10:00:00Z'), // the win that breaks it
          makeTrade(-30, '2026-08-03T09:00:00Z'),
          makeTrade(-20, '2026-08-03T10:00:00Z'),
        ]),
      });

      expect((await provider.getAccountState(asOf)).consecutive_losses).toBe(2);
    } finally {
      harness.cleanup();
    }
  });

  it('treats a break-even trade as breaking the streak', async () => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, {
        closedTrades: makeTradeReader([
          makeTrade(-40, '2026-08-03T08:00:00Z'),
          makeTrade(0, '2026-08-03T09:00:00Z'),
          makeTrade(-10, '2026-08-03T10:00:00Z'),
        ]),
      });

      // The breaker stops a run of *losing* decisions; flat is not losing.
      expect((await provider.getAccountState(asOf)).consecutive_losses).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  /**
   * The three shapes that must not become a number, one per failure mode:
   * outright garbage, a `parseFloat`-truncatable figure, and a blank that
   * `Number` would call zero. The last two are the dangerous ones — they
   * produce a *finite* wrong answer rather than a NaN anyone would notice.
   */
  it.each([
    ['outright garbage', 'N/A'],
    ['a thousands-separated figure parseFloat would truncate to 100', '100,000.50'],
    ['a trailing-unit figure', '100000 USD'],
    ['an empty string Number would call zero', ''],
    ['whitespace Number would call zero', '   '],
    ['a null the wire type does not admit', null as unknown as string],
  ])('rejects %s instead of feeding a wrong number to the breakers', async (_label, equity) => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, { client: makeClient(makeAccount({ equity })) });

      await expect(provider.getAccountState(asOf)).rejects.toThrow("unparseable 'equity'");
    } finally {
      harness.cleanup();
    }
  });

  it('still accepts the ordinary decimal string Alpaca actually sends', async () => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, {
        client: makeClient(makeAccount({ cash: '49999.37' })),
      });

      expect((await provider.getAccountState(asOf)).cash).toBe(49_999.37);
    } finally {
      harness.cleanup();
    }
  });
});

describe('AlpacaAccountStateProvider — session boundaries (#332)', () => {
  /**
   * THE acceptance test: a weekend spanning a crypto boundary must measure the
   * crypto figure from 00:00 UTC Saturday, not from Friday's 16:00 ET close.
   *
   * The fixture discriminates the two calendars with one trade per class,
   * both closing Friday 22:00 UTC — after the stock session opened (Friday
   * 20:00 UTC = 16:00 EDT) but before the crypto one did (Saturday 00:00 UTC).
   * A crypto figure anchored to the equity calendar would sweep up the crypto
   * trade; anchored correctly it cannot see it.
   */
  it('measures crypto from 00:00 UTC, not from Friday 16:00 ET, across a weekend', async () => {
    const harness = openStore();
    try {
      insertClosedTrade(harness.db, {
        key: 'crypto-friday-evening',
        assetClass: 'crypto',
        pnl: -5_000,
        closedAt: FRIDAY_EVENING,
      });
      insertClosedTrade(harness.db, {
        key: 'stocks-friday-evening',
        assetClass: 'stocks',
        pnl: -3_000,
        closedAt: FRIDAY_EVENING,
      });

      const provider = makeProvider(harness);
      const { daily_basis } = await provider.getAccountState(SATURDAY_NOON_UTC);

      expect(daily_basis.crypto.known).toBe(true);
      expect(daily_basis.stocks.known).toBe(true);
      if (!daily_basis.crypto.known || !daily_basis.stocks.known) return;

      // Friday 22:00 UTC is BEFORE Saturday 00:00 UTC, so the crypto loss
      // belongs to Friday's crypto session, not this one.
      expect(daily_basis.crypto.realized_pnl).toBe(0);
      // The same instant is INSIDE the stock session that opened Friday 16:00 ET.
      expect(daily_basis.stocks.realized_pnl).toBe(-3_000);

      // And the boundaries themselves, as persisted.
      expect(harness.sessionEquity.get('crypto')?.open_at.toISOString()).toBe(CRYPTO_OPEN);
      expect(harness.sessionEquity.get('stocks')?.open_at.toISOString()).toBe(STOCKS_OPEN);
    } finally {
      harness.cleanup();
    }
  });

  it('records open_at as the session start instant, not the time of the write', async () => {
    const harness = openStore();
    try {
      // asOf is twelve hours past the crypto boundary. Recording the write
      // time would bake that drift in as if it were the open; recording the
      // boundary leaves it visible.
      await makeProvider(harness).getAccountState(SATURDAY_NOON_UTC);

      expect(harness.sessionEquity.get('crypto')?.open_at.toISOString()).toBe(CRYPTO_OPEN);
      expect(harness.sessionEquity.get('crypto')?.open_at.toISOString()).not.toBe(
        SATURDAY_NOON_UTC.toISOString(),
      );
    } finally {
      harness.cleanup();
    }
  });

  it('advances the snapshot when a boundary is crossed, re-basing to current equity', async () => {
    const harness = openStore();
    try {
      // Yesterday's session, at a different equity.
      harness.sessionEquity.put('crypto', 80_000, new Date('2026-07-31T00:00:00.000Z'), true);

      const provider = makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '100000' })),
      });
      const { daily_basis } = await provider.getAccountState(SATURDAY_NOON_UTC);

      expect(harness.sessionEquity.get('crypto')).toEqual({
        open_equity: 100_000,
        open_at: new Date(CRYPTO_OPEN),
        observed_at_boundary: true,
      });
      expect(daily_basis.crypto).toEqual({
        known: true,
        open_equity: 100_000,
        realized_pnl: 0,
      });
    } finally {
      harness.cleanup();
    }
  });

  it('leaves the snapshot alone on a later tick inside the same session', async () => {
    const harness = openStore();
    try {
      harness.sessionEquity.put('crypto', 80_000, new Date(CRYPTO_OPEN), true);

      const provider = makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '100000' })),
      });
      const { daily_basis } = await provider.getAccountState(SATURDAY_NOON_UTC);

      // The advance is strict (`stored < sessionStart`). A `<=` would re-base
      // the open to current equity every tick, and the daily figure would read
      // ~0 forever no matter how far the account fell.
      expect(harness.sessionEquity.get('crypto')?.open_equity).toBe(80_000);
      expect(daily_basis.crypto).toEqual({ known: true, open_equity: 80_000, realized_pnl: 0 });
    } finally {
      harness.cleanup();
    }
  });

  it('gives crypto and portfolio the same UTC boundary, but different numerators', async () => {
    const harness = openStore();
    try {
      insertClosedTrade(harness.db, {
        key: 'crypto-sat',
        assetClass: 'crypto',
        pnl: -100,
        closedAt: '2026-08-01T06:00:00.000Z',
      });
      insertClosedTrade(harness.db, {
        key: 'stocks-sat',
        assetClass: 'stocks',
        pnl: -20,
        closedAt: '2026-08-01T06:00:00.000Z',
      });

      const { daily_basis } = await makeProvider(harness).getAccountState(SATURDAY_NOON_UTC);

      expect(harness.sessionEquity.get('portfolio')?.open_at.toISOString()).toBe(CRYPTO_OPEN);
      if (!daily_basis.crypto.known || !daily_basis.portfolio.known) throw new Error('unknown');
      expect(daily_basis.crypto.realized_pnl).toBe(-100);
      // The portfolio numerator spans every class over the same UTC window.
      expect(daily_basis.portfolio.realized_pnl).toBe(-120);
    } finally {
      harness.cleanup();
    }
  });
});

describe('AlpacaAccountStateProvider — cold start (#332)', () => {
  it('seeds from current equity and warns, in paper mode', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      const provider = makeProvider(harness, {
        mode: 'paper',
        logger,
        startedAt: SATURDAY_NOON_UTC,
      });

      const { daily_basis } = await provider.getAccountState(SATURDAY_NOON_UTC);

      expect(daily_basis.crypto).toEqual({
        known: true,
        open_equity: 100_000,
        realized_pnl: 0,
      });
      const warnings = logger.entries.filter((entry) => entry.level === 'warn');
      expect(warnings.length).toBeGreaterThanOrEqual(3);
      expect(warnings[0]?.message).toContain('mid-session base');
    } finally {
      harness.cleanup();
    }
  });

  it('reports UNKNOWN in live mode — never a zero that reads as a flat day', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      const provider = makeProvider(harness, {
        mode: 'live',
        logger,
        startedAt: SATURDAY_NOON_UTC,
      });

      const { daily_basis } = await provider.getAccountState(SATURDAY_NOON_UTC);

      // The property that matters: not known, and carrying no number at all.
      // A `0` here would tell the daily-loss breaker the account is flat when
      // in truth nobody knows what it has done today.
      for (const key of ['crypto', 'stocks', 'portfolio'] as const) {
        expect(daily_basis[key].known).toBe(false);
        expect(daily_basis[key]).not.toHaveProperty('open_equity');
        expect(Object.values(daily_basis[key])).not.toContain(0);
      }

      expect(logger.entries.some((entry) => entry.message.includes('UNKNOWN'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('keeps the live cold-start unknown for the rest of that session', async () => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, { mode: 'live', startedAt: SATURDAY_NOON_UTC });

      await provider.getAccountState(SATURDAY_NOON_UTC);
      const later = await provider.getAccountState(new Date('2026-08-01T18:00:00Z'));

      expect(later.daily_basis.crypto.known).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('stays unknown in live across a RESTART inside the same session', async () => {
    const harness = openStore();
    try {
      // First process cold-seeds at Saturday noon and dies.
      await makeProvider(harness, { mode: 'live', startedAt: SATURDAY_NOON_UTC }).getAccountState(
        SATURDAY_NOON_UTC,
      );

      // A second process comes up at 19:00, still inside the same crypto
      // session. The row on disk now has open_at == this session's start, so
      // nothing about its shape distinguishes it from a real observation — only
      // the persisted verdict does. A process-memory flag would have forgotten,
      // and this figure would read as a flat day against a base captured after
      // whatever the account had already lost.
      const restarted = makeProvider(harness, {
        mode: 'live',
        startedAt: new Date('2026-08-01T19:00:00Z'),
        client: makeClient(makeAccount({ equity: '90000' })),
      });
      const after = await restarted.getAccountState(new Date('2026-08-01T19:30:00Z'));

      expect(after.daily_basis.crypto.known).toBe(false);
      expect(harness.sessionEquity.get('crypto')?.observed_at_boundary).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('treats a restart that missed the boundary as a cold start, not a clean advance', async () => {
    const harness = openStore();
    try {
      // A snapshot from Friday's crypto session, properly observed then.
      harness.sessionEquity.put('crypto', 100_000, new Date('2026-07-31T00:00:00.000Z'), true);

      // The process was down over the boundary and comes up Saturday noon. The
      // stale row advances — but the equity written is a mid-session sample,
      // not Saturday's open, so it must NOT inherit the old row's trust.
      const provider = makeProvider(harness, { mode: 'live', startedAt: SATURDAY_NOON_UTC });
      const { daily_basis } = await provider.getAccountState(SATURDAY_NOON_UTC);

      expect(daily_basis.crypto.known).toBe(false);
      expect(harness.sessionEquity.get('crypto')).toEqual({
        open_equity: 100_000,
        open_at: new Date(CRYPTO_OPEN),
        observed_at_boundary: false,
      });
    } finally {
      harness.cleanup();
    }
  });

  it('becomes known in live once a real boundary crossing supersedes the seed', async () => {
    const harness = openStore();
    try {
      // Started Saturday noon: it missed Saturday's open, but is up for Sunday's.
      const provider = makeProvider(harness, { mode: 'live', startedAt: SATURDAY_NOON_UTC });

      await provider.getAccountState(SATURDAY_NOON_UTC);
      // Sunday: a boundary this process actually observed, so the snapshot is
      // a genuine session open and the figure is knowable again.
      const sunday = await provider.getAccountState(new Date('2026-08-02T09:00:00Z'));

      expect(sunday.daily_basis.crypto).toEqual({
        known: true,
        open_equity: 100_000,
        realized_pnl: 0,
      });
      expect(harness.sessionEquity.get('crypto')?.open_at.toISOString()).toBe(
        '2026-08-02T00:00:00.000Z',
      );
    } finally {
      harness.cleanup();
    }
  });

  it('reports unknown rather than Infinity when session-open equity is non-positive', async () => {
    const harness = openStore();
    try {
      harness.sessionEquity.put('crypto', 0, new Date(CRYPTO_OPEN), true);

      const { daily_basis } = await makeProvider(harness).getAccountState(SATURDAY_NOON_UTC);

      // Dividing by this would give Infinity or NaN, and both compare false
      // against the breaker threshold — the figure would read as "no loss".
      expect(daily_basis.crypto.known).toBe(false);
      if (daily_basis.crypto.known) return;
      expect(daily_basis.crypto.reason).toContain('non-positive');
    } finally {
      harness.cleanup();
    }
  });
});

describe('AlpacaAccountStateProvider — GAP-8 retired (#332)', () => {
  it('never reads last_equity, and no longer warns about an unverified boundary', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      // A `last_equity` the old code would have divided by, and a value that
      // would have made the old guard return 0. Neither is read now.
      const account = { cash: '50000', equity: '90000', last_equity: '0' } as AlpacaAccount;

      const provider = makeProvider(harness, { client: makeClient(account), logger });
      const state = await provider.getAccountState(asOf);

      expect(state).not.toHaveProperty('daily_pnl_pct');
      expect(logger.entries.some((entry) => entry.message.includes('GAP-8'))).toBe(false);
      // '0' as last_equity used to be a special case; it is now simply ignored.
      expect(state.cash).toBe(50_000);
    } finally {
      harness.cleanup();
    }
  });
});

describe('AlpacaAccountStateProvider — calendar wiring', () => {
  it('asks each class its own calendar for the boundary', async () => {
    const harness = openStore();
    try {
      const cryptoStart = new Date('2026-08-01T00:00:00.000Z');
      const stocksStart = new Date('2026-07-31T20:00:00.000Z');
      const crypto: TradingCalendar = {
        isOpen: () => true,
        isTradingDay: () => true,
        sessionStart: vi.fn().mockReturnValue(cryptoStart),
      };
      const stocks: TradingCalendar = {
        isOpen: () => true,
        isTradingDay: () => true,
        sessionStart: vi.fn().mockReturnValue(stocksStart),
      };

      await makeProvider(harness, { calendars: { crypto, stocks } }).getAccountState(
        SATURDAY_NOON_UTC,
      );

      // crypto twice — the portfolio row shares the UTC boundary.
      expect(crypto.sessionStart).toHaveBeenCalledTimes(2);
      expect(stocks.sessionStart).toHaveBeenCalledTimes(1);
      expect(harness.sessionEquity.get('portfolio')?.open_at).toEqual(cryptoStart);
    } finally {
      harness.cleanup();
    }
  });
});
