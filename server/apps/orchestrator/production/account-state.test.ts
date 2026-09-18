import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlpacaAccount, AlpacaBrokerClient } from '../../../pipeline/execution/index.js';
import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import { type ClosedTrade, runWithTraceId, type TradingArm } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import { SqliteDailyEquityStore } from '../sqlite-daily-equity-store.js';
import { SqliteSessionEquityStore } from '../sqlite-session-equity-store.js';
import type { LogEntry, Logger } from '../types.js';
import {
  alpacaFunding,
  BrokerAccountStateProvider,
  type BrokerAccountStateProviderInput,
  type ClosedTradeReader,
} from './account-state.js';

const asOf = new Date('2026-08-03T12:00:00Z');

const SATURDAY_NOON_UTC = new Date('2026-08-01T12:00:00Z');
const CRYPTO_OPEN = '2026-08-01T00:00:00.000Z';
const STOCKS_OPEN = '2026-07-31T20:00:00.000Z';
const FRIDAY_EVENING = '2026-07-31T22:00:00.000Z';

interface Harness {
  store: SqliteAccountStateStore;
  sessionEquity: SqliteSessionEquityStore;
  dailyEquity: SqliteDailyEquityStore;
  db: StoreHandle;
  cleanup: () => void;
}

function openStore(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-account-state-'));
  const db = openSharedStore(join(dir, 'test.sqlite'));
  return {
    store: new SqliteAccountStateStore(db),
    sessionEquity: new SqliteSessionEquityStore(db),
    dailyEquity: new SqliteDailyEquityStore(db),
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

function makeClient(account: AlpacaAccount = makeAccount()): AlpacaBrokerClient {
  return {
    submitOrder: vi.fn(),
    getOrder: vi.fn(),
    getOrderByClientOrderId: vi.fn(),
    getAccount: vi.fn().mockResolvedValue(account),
  } as unknown as AlpacaBrokerClient;
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
    modelled_cost_charged: true,
  };
}

function makeTradeReader(trades: ClosedTrade[]): ClosedTradeReader {
  return { getClosedTradesBetween: vi.fn().mockReturnValue(trades) };
}

function insertClosedTrade(
  db: StoreHandle,
  args: {
    key: string;
    assetClass: 'crypto' | 'stocks';
    pnl: number;
    closedAt: Date;
    arm?: TradingArm;
  },
): void {
  const closedAt = args.closedAt.toISOString();
  db.prepare(
    `INSERT INTO closed_trades (
       idempotency_key, debate_id, instrument, asset_class, side,
       entry, stop, filled_size, realized_pnl_net, fees_total,
       opened_at, closed_at, close_reason, arm
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    closedAt,
    closedAt,
    'stop',
    args.arm ?? 'live',
  );
}

function makeProvider(
  harness: Harness,
  overrides: Partial<Omit<BrokerAccountStateProviderInput, 'funding'>> & {
    client?: AlpacaBrokerClient;
  } = {},
): BrokerAccountStateProvider {
  const { client, ...rest } = overrides;
  return new BrokerAccountStateProvider({
    funding: alpacaFunding(client ?? makeClient()),
    store: harness.store,
    sessionEquity: harness.sessionEquity,
    dailyEquity: harness.dailyEquity,
    closedTrades: makeTradeReader([]),
    logger: makeLogger(),
    calendars: { crypto: new AlwaysOpenCalendar(), stocks: new UsEquityRegularHoursCalendar() },
    mode: 'paper',
    startedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...rest,
  });
}

describe('SqliteAccountStateStore', () => {
  it('raises the high-water mark and never lowers it when equity dips', () => {
    const { store, cleanup } = openStore();
    try {
      expect(store.recordEquity(100_000, asOf)).toBe(100_000);
      expect(store.recordEquity(120_000, asOf)).toBe(120_000);
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
        closedAt: new Date('2026-07-31T23:00:00.000Z'),
      });
      insertClosedTrade(db, {
        key: 'at-boundary',
        assetClass: 'crypto',
        pnl: -111,
        closedAt: new Date(CRYPTO_OPEN),
      });
      insertClosedTrade(db, {
        key: 'after',
        assetClass: 'crypto',
        pnl: -50,
        closedAt: new Date('2026-08-01T06:00:00.000Z'),
      });
      insertClosedTrade(db, {
        key: 'other-class',
        assetClass: 'stocks',
        pnl: 700,
        closedAt: new Date('2026-08-01T06:00:00.000Z'),
      });

      expect(sessionEquity.realizedSince('crypto', new Date(CRYPTO_OPEN))).toBe(-50);
      expect(sessionEquity.realizedSinceAllClasses(new Date(CRYPTO_OPEN))).toBe(650);
    } finally {
      cleanup();
    }
  });

  it('discriminates the boundary to the millisecond, both sides same-width', () => {
    const { sessionEquity, db, cleanup } = openStore();
    try {
      const boundary = new Date(CRYPTO_OPEN);
      insertClosedTrade(db, {
        key: 'one-ms-before',
        assetClass: 'crypto',
        pnl: -700,
        closedAt: new Date(boundary.getTime() - 1),
      });
      insertClosedTrade(db, {
        key: 'one-ms-after',
        assetClass: 'crypto',
        pnl: -3,
        closedAt: new Date(boundary.getTime() + 1),
      });

      expect(sessionEquity.realizedSince('crypto', boundary)).toBe(-3);
    } finally {
      cleanup();
    }
  });

  it('reports zero, not null, for a session with no closes yet', () => {
    const { sessionEquity, cleanup } = openStore();
    try {
      expect(sessionEquity.realizedSince('crypto', new Date(CRYPTO_OPEN))).toBe(0);
      expect(sessionEquity.realizedSinceAllClasses(new Date(CRYPTO_OPEN))).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('sums the live arm only — falsifier arm 2 must not move the live breaker (#753)', () => {
    const { db, sessionEquity, cleanup } = openStore();
    try {
      const after = new Date(new Date(CRYPTO_OPEN).getTime() + 60_000);
      insertClosedTrade(db, { key: 'live-1', assetClass: 'crypto', pnl: -50, closedAt: after });
      insertClosedTrade(db, {
        key: 'control-1',
        assetClass: 'crypto',
        pnl: -5_000,
        closedAt: after,
        arm: 'control',
      });
      insertClosedTrade(db, {
        key: 'control-2',
        assetClass: 'stocks',
        pnl: 9_000,
        closedAt: after,
        arm: 'control',
      });

      expect(sessionEquity.realizedSince('crypto', new Date(CRYPTO_OPEN))).toBe(-50);
      expect(sessionEquity.realizedSinceAllClasses(new Date(CRYPTO_OPEN))).toBe(-50);
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

describe('BrokerAccountStateProvider — account scalars', () => {
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
          makeTrade(120, '2026-08-02T10:00:00Z'),
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

      expect((await provider.getAccountState(asOf)).consecutive_losses).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

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

describe('BrokerAccountStateProvider — session boundaries (#332)', () => {
  it('measures crypto from 00:00 UTC, not from Friday 16:00 ET, across a weekend', async () => {
    const harness = openStore();
    try {
      insertClosedTrade(harness.db, {
        key: 'crypto-friday-evening',
        assetClass: 'crypto',
        pnl: -5_000,
        closedAt: new Date(FRIDAY_EVENING),
      });
      insertClosedTrade(harness.db, {
        key: 'stocks-friday-evening',
        assetClass: 'stocks',
        pnl: -3_000,
        closedAt: new Date(FRIDAY_EVENING),
      });

      const provider = makeProvider(harness);
      const { daily_basis } = await provider.getAccountState(SATURDAY_NOON_UTC);

      expect(daily_basis.crypto.known).toBe(true);
      expect(daily_basis.stocks.known).toBe(true);
      if (!daily_basis.crypto.known || !daily_basis.stocks.known) return;

      expect(daily_basis.crypto.realized_pnl).toBe(0);
      expect(daily_basis.stocks.realized_pnl).toBe(-3_000);

      expect(harness.sessionEquity.get('crypto')?.open_at.toISOString()).toBe(CRYPTO_OPEN);
      expect(harness.sessionEquity.get('stocks')?.open_at.toISOString()).toBe(STOCKS_OPEN);
    } finally {
      harness.cleanup();
    }
  });

  it('records open_at as the session start instant, not the time of the write', async () => {
    const harness = openStore();
    try {
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
        closedAt: new Date('2026-08-01T06:00:00.000Z'),
      });
      insertClosedTrade(harness.db, {
        key: 'stocks-sat',
        assetClass: 'stocks',
        pnl: -20,
        closedAt: new Date('2026-08-01T06:00:00.000Z'),
      });

      const { daily_basis } = await makeProvider(harness).getAccountState(SATURDAY_NOON_UTC);

      expect(harness.sessionEquity.get('portfolio')?.open_at.toISOString()).toBe(CRYPTO_OPEN);
      if (!daily_basis.crypto.known || !daily_basis.portfolio.known) throw new Error('unknown');
      expect(daily_basis.crypto.realized_pnl).toBe(-100);
      expect(daily_basis.portfolio.realized_pnl).toBe(-120);
    } finally {
      harness.cleanup();
    }
  });
});

describe('BrokerAccountStateProvider — cold start (#332)', () => {
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
      await makeProvider(harness, { mode: 'live', startedAt: SATURDAY_NOON_UTC }).getAccountState(
        SATURDAY_NOON_UTC,
      );

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
      harness.sessionEquity.put('crypto', 100_000, new Date('2026-07-31T00:00:00.000Z'), true);

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
      const provider = makeProvider(harness, { mode: 'live', startedAt: SATURDAY_NOON_UTC });

      await provider.getAccountState(SATURDAY_NOON_UTC);
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

      expect(daily_basis.crypto.known).toBe(false);
      if (daily_basis.crypto.known) return;
      expect(daily_basis.crypto.reason).toContain('non-positive');
    } finally {
      harness.cleanup();
    }
  });
});

describe('BrokerAccountStateProvider — trace_id (#1280)', () => {
  it('falls back to the account-state constant outside a tick — live mode', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      const provider = makeProvider(harness, {
        mode: 'live',
        logger,
        startedAt: SATURDAY_NOON_UTC,
      });

      await provider.getAccountState(SATURDAY_NOON_UTC);

      const warning = logger.entries.find((entry) => entry.message.includes('UNKNOWN'));
      expect(warning?.trace_id).toBe('account-state');
    } finally {
      harness.cleanup();
    }
  });

  it('joins the live-mode mid-session line to the enclosing tick instead', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      const provider = makeProvider(harness, {
        mode: 'live',
        logger,
        startedAt: SATURDAY_NOON_UTC,
      });

      await runWithTraceId('tick-x', () => provider.getAccountState(SATURDAY_NOON_UTC));

      const warning = logger.entries.find((entry) => entry.message.includes('UNKNOWN'));
      expect(warning?.trace_id).toBe('tick-x');
    } finally {
      harness.cleanup();
    }
  });

  it('falls back to the account-state constant outside a tick — paper mode', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      const provider = makeProvider(harness, {
        mode: 'paper',
        logger,
        startedAt: SATURDAY_NOON_UTC,
      });

      await provider.getAccountState(SATURDAY_NOON_UTC);

      const warning = logger.entries.find((entry) => entry.message.includes('mid-session base'));
      expect(warning?.trace_id).toBe('account-state');
    } finally {
      harness.cleanup();
    }
  });

  it('joins the paper-mode mid-session line to the enclosing tick instead', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      const provider = makeProvider(harness, {
        mode: 'paper',
        logger,
        startedAt: SATURDAY_NOON_UTC,
      });

      await runWithTraceId('tick-x', () => provider.getAccountState(SATURDAY_NOON_UTC));

      const warning = logger.entries.find((entry) => entry.message.includes('mid-session base'));
      expect(warning?.trace_id).toBe('tick-x');
    } finally {
      harness.cleanup();
    }
  });
});

describe('BrokerAccountStateProvider — GAP-8 retired (#332)', () => {
  it('never reads last_equity, and no longer warns about an unverified boundary', async () => {
    const harness = openStore();
    try {
      const logger = makeLogger();
      const account = { cash: '50000', equity: '90000', last_equity: '0' } as AlpacaAccount;

      const provider = makeProvider(harness, { client: makeClient(account), logger });
      const state = await provider.getAccountState(asOf);

      expect(state).not.toHaveProperty('daily_pnl_pct');
      expect(logger.entries.some((entry) => entry.message.includes('GAP-8'))).toBe(false);
      expect(state.cash).toBe(50_000);
    } finally {
      harness.cleanup();
    }
  });
});

describe('BrokerAccountStateProvider — calendar wiring', () => {
  it('asks each class its own calendar for the boundary', async () => {
    const harness = openStore();
    try {
      const cryptoStart = new Date('2026-08-01T00:00:00.000Z');
      const stocksStart = new Date('2026-07-31T20:00:00.000Z');
      const crypto: TradingCalendar = {
        isOpen: () => true,
        isTradingDay: () => true,
        sessionStart: vi.fn().mockReturnValue(cryptoStart),
        sessionEnd: () => null,
      };
      const stocks: TradingCalendar = {
        isOpen: () => true,
        isTradingDay: () => true,
        sessionStart: vi.fn().mockReturnValue(stocksStart),
        sessionEnd: () => null,
      };

      await makeProvider(harness, { calendars: { crypto, stocks } }).getAccountState(
        SATURDAY_NOON_UTC,
      );

      expect(crypto.sessionStart).toHaveBeenCalledTimes(2);
      expect(stocks.sessionStart).toHaveBeenCalledTimes(1);
      expect(harness.sessionEquity.get('portfolio')?.open_at).toEqual(cryptoStart);
    } finally {
      harness.cleanup();
    }
  });
});

describe('BrokerAccountStateProvider — daily equity series', () => {
  const DAY_1 = new Date('2026-08-01T00:00:00.000Z');
  const DAY_2 = new Date('2026-08-02T00:00:00.000Z');

  it('records one observation per UTC day, anchored to the boundary not the sample time', async () => {
    const harness = openStore();
    try {
      const client = makeClient(makeAccount({ equity: '100000' }));
      await makeProvider(harness, { client }).getAccountState(new Date('2026-08-01T09:17:00.000Z'));

      const series = harness.dailyEquity.all();
      expect(series).toHaveLength(1);
      expect(series[0]?.session_start).toEqual(DAY_1);
      expect(series[0]?.recorded_at).toEqual(new Date('2026-08-01T09:17:00.000Z'));
      expect(series[0]?.equity).toBe(100_000);
    } finally {
      harness.cleanup();
    }
  });

  it('is evenly spaced across a boundary — one row per day, exactly 24h apart', async () => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '100000' })),
      });
      for (const at of ['00:00:30', '06:00:00', '23:59:00']) {
        await provider.getAccountState(new Date(`2026-08-01T${at}.000Z`));
      }
      for (const at of ['00:00:30', '11:00:00']) {
        await provider.getAccountState(new Date(`2026-08-02T${at}.000Z`));
      }

      const series = harness.dailyEquity.all();
      expect(series.map((o) => o.session_start)).toEqual([DAY_1, DAY_2]);
      expect(
        (series[1]?.session_start.getTime() as number) -
          (series[0]?.session_start.getTime() as number),
      ).toBe(24 * 60 * 60 * 1_000);
    } finally {
      harness.cleanup();
    }
  });

  it('keeps the first sample of a day as equity moves through it', async () => {
    const harness = openStore();
    try {
      await makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '100000' })),
      }).getAccountState(new Date('2026-08-01T00:00:30.000Z'));
      await makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '61000' })),
      }).getAccountState(new Date('2026-08-01T20:00:00.000Z'));

      expect(harness.dailyEquity.all()).toHaveLength(1);
      expect(harness.dailyEquity.all()[0]?.equity).toBe(100_000);
    } finally {
      harness.cleanup();
    }
  });

  it('samples only the portfolio boundary — the stocks close must not enter the series', async () => {
    const harness = openStore();
    try {
      await makeProvider(harness).getAccountState(SATURDAY_NOON_UTC);

      const series = harness.dailyEquity.all();
      expect(series).toHaveLength(1);
      expect(series[0]?.session_start.toISOString()).toBe(CRYPTO_OPEN);
      expect(series.map((o) => o.session_start.toISOString())).not.toContain(STOCKS_OPEN);
    } finally {
      harness.cleanup();
    }
  });

  it('survives a restart mid-session without losing or overwriting the day', async () => {
    const harness = openStore();
    try {
      await makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '100000' })),
        startedAt: new Date('2026-07-31T00:00:00.000Z'),
      }).getAccountState(new Date('2026-08-01T00:00:30.000Z'));

      await makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '55000' })),
        startedAt: new Date('2026-08-01T14:00:00.000Z'),
      }).getAccountState(new Date('2026-08-01T14:00:10.000Z'));

      const series = harness.dailyEquity.all();
      expect(series).toHaveLength(1);
      expect(series[0]?.equity).toBe(100_000);
    } finally {
      harness.cleanup();
    }
  });

  it('fills the day even when the process comes up mid-session', async () => {
    const harness = openStore();
    try {
      await makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '100000' })),
      }).getAccountState(new Date('2026-08-01T00:00:30.000Z'));
      await makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '104000' })),
        startedAt: new Date('2026-08-02T10:00:00.000Z'),
      }).getAccountState(new Date('2026-08-02T10:00:05.000Z'));
      await makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '90000' })),
        startedAt: new Date('2026-08-02T18:00:00.000Z'),
      }).getAccountState(new Date('2026-08-02T18:00:05.000Z'));

      const series = harness.dailyEquity.all();
      expect(series.map((o) => o.session_start)).toEqual([DAY_1, DAY_2]);
      expect(series[1]?.equity).toBe(104_000);
      expect(series[1]?.observed_at_boundary).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('flags an observation taken by a process that WAS running at the boundary', async () => {
    const harness = openStore();
    try {
      const provider = makeProvider(harness, {
        client: makeClient(makeAccount({ equity: '100000' })),
        startedAt: new Date('2026-08-01T09:00:00.000Z'),
      });
      await provider.getAccountState(new Date('2026-08-01T09:00:05.000Z'));
      await provider.getAccountState(new Date('2026-08-02T00:00:20.000Z'));

      const series = harness.dailyEquity.all();
      expect(series[0]?.observed_at_boundary).toBe(false);
      expect(series[1]?.observed_at_boundary).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
