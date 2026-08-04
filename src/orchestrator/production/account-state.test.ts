import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlpacaAccount, AlpacaClient } from '../../execution/index.js';
import type { ClosedTrade } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import type { LogEntry, Logger } from '../types.js';
import { AlpacaAccountStateProvider, type ClosedTradeReader } from './account-state.js';

const asOf = new Date('2026-08-03T12:00:00Z');

function openStore(): { store: SqliteAccountStateStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-account-state-'));
  const db = openSharedStore(join(dir, 'test.sqlite'));
  return {
    store: new SqliteAccountStateStore(db),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function makeAccount(overrides: Partial<AlpacaAccount> = {}): AlpacaAccount {
  return { cash: '50000', equity: '100000', last_equity: '100000', ...overrides };
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

describe('AlpacaAccountStateProvider', () => {
  it('sources cash from the account ledger and peak_equity from the durable store', async () => {
    const { store, cleanup } = openStore();
    try {
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(makeAccount({ cash: '25000', equity: '90000' })),
        store,
        closedTrades: makeTradeReader([]),
        logger: makeLogger(),
      });

      const state = await provider.getAccountState(asOf);

      expect(state.cash).toBe(25_000);
      expect(state.peak_equity).toBe(90_000);
    } finally {
      cleanup();
    }
  });

  it('computes daily_pnl_pct from equity against last_equity', async () => {
    const { store, cleanup } = openStore();
    try {
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(makeAccount({ equity: '99000', last_equity: '100000' })),
        store,
        closedTrades: makeTradeReader([]),
        logger: makeLogger(),
      });

      expect((await provider.getAccountState(asOf)).daily_pnl_pct).toBeCloseTo(-0.01);
    } finally {
      cleanup();
    }
  });

  it('warns that the daily_pnl_pct boundary is unverified (GAP-8), once', async () => {
    const { store, cleanup } = openStore();
    try {
      const logger = makeLogger();
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(),
        store,
        closedTrades: makeTradeReader([]),
        logger,
      });

      await provider.getAccountState(asOf);
      await provider.getAccountState(asOf);

      // A figure feeding a circuit breaker must not look verified when it is
      // not — but the warning must not spam once per tick either.
      const warnings = logger.entries.filter((e) => e.message.includes('GAP-8'));
      expect(warnings).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('returns 0 rather than Infinity when last_equity is zero', async () => {
    const { store, cleanup } = openStore();
    try {
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(makeAccount({ equity: '1000', last_equity: '0' })),
        store,
        closedTrades: makeTradeReader([]),
        logger: makeLogger(),
      });

      // Infinity/NaN here compares false in the breaker, so the daily-loss
      // breaker would silently never trip.
      expect((await provider.getAccountState(asOf)).daily_pnl_pct).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('counts the loss streak backwards and stops at the first win', async () => {
    const { store, cleanup } = openStore();
    try {
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(),
        store,
        closedTrades: makeTradeReader([
          makeTrade(-50, '2026-08-01T10:00:00Z'),
          makeTrade(120, '2026-08-02T10:00:00Z'), // the win that breaks it
          makeTrade(-30, '2026-08-03T09:00:00Z'),
          makeTrade(-20, '2026-08-03T10:00:00Z'),
        ]),
        logger: makeLogger(),
      });

      expect((await provider.getAccountState(asOf)).consecutive_losses).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('treats a break-even trade as breaking the streak', async () => {
    const { store, cleanup } = openStore();
    try {
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(),
        store,
        closedTrades: makeTradeReader([
          makeTrade(-40, '2026-08-03T08:00:00Z'),
          makeTrade(0, '2026-08-03T09:00:00Z'),
          makeTrade(-10, '2026-08-03T10:00:00Z'),
        ]),
        logger: makeLogger(),
      });

      // The breaker stops a run of *losing* decisions; flat is not losing.
      expect((await provider.getAccountState(asOf)).consecutive_losses).toBe(1);
    } finally {
      cleanup();
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
    const { store, cleanup } = openStore();
    try {
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(makeAccount({ equity })),
        store,
        closedTrades: makeTradeReader([]),
        logger: makeLogger(),
      });

      await expect(provider.getAccountState(asOf)).rejects.toThrow("unparseable 'equity'");
    } finally {
      cleanup();
    }
  });

  it('still accepts the ordinary decimal string Alpaca actually sends', async () => {
    const { store, cleanup } = openStore();
    try {
      const provider = new AlpacaAccountStateProvider({
        client: makeClient(makeAccount({ cash: '49999.37' })),
        store,
        closedTrades: makeTradeReader([]),
        logger: makeLogger(),
      });

      expect((await provider.getAccountState(asOf)).cash).toBe(49_999.37);
    } finally {
      cleanup();
    }
  });
});
