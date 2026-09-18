import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutionStore } from '../../../pipeline/execution/index.js';
import { SqliteClosedTradeStore } from '../../../pipeline/feedback-loop/index.js';
import {
  AlwaysOpenCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { TradingArm } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { CONTROL_BOOK_ANCHOR_KEY, SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import {
  buildControlBookAnchorResolver,
  ControlArmAccountStateProvider,
} from './control-account-state.js';

const AS_OF = new Date('2026-08-01T12:00:00Z');
const BEFORE_THE_SESSION = new Date('2026-07-30T09:00:00.000Z');
const IN_THE_SESSION = new Date('2026-08-01T06:00:00.000Z');

const BOOK = 1_000;

function openStore(): { db: StoreHandle; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-control-account-'));
  const db = openSharedStore(join(dir, 'test.sqlite'));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function insertClosedTrade(
  db: StoreHandle,
  args: {
    key: string;
    assetClass: 'crypto' | 'stocks';
    pnl: number;
    closedAt: Date;
    arm: TradingArm;
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
    args.arm,
  );
}

function insertOpenLot(
  db: StoreHandle,
  args: { key: string; arm: TradingArm; price: number; size: number },
): void {
  db.prepare(
    `INSERT INTO open_positions (
       idempotency_key, debate_id, instrument, asset_class, side, intent_type,
       requested_size, filled_size, avg_entry_price, stop, target,
       order_state, broker_order_ids, opened_at, decision_timestamp,
       conviction, converged, arm
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.key,
    'debate-abc123',
    'BTC-USD',
    'crypto',
    'buy',
    'entry',
    args.size,
    args.size,
    args.price,
    args.price * 0.98,
    args.price * 1.02,
    'filled',
    '[]',
    BEFORE_THE_SESSION.toISOString(),
    BEFORE_THE_SESSION.toISOString(),
    0.7,
    1,
    args.arm,
  );
}

function makeProvider(
  db: StoreHandle,
  resolveBook: (asOf: Date) => Promise<number> = async () => BOOK,
): ControlArmAccountStateProvider {
  return new ControlArmAccountStateProvider({
    resolveBook,
    closedTrades: new SqliteClosedTradeStore(db, 'control'),
    getOpenPositions: () => new SqliteExecutionStore(db, 'control').getOpenPositions(),
    calendars: { crypto: new AlwaysOpenCalendar(), stocks: new UsEquityRegularHoursCalendar() },
  });
}

describe('ControlArmAccountStateProvider (#753)', () => {
  it('is unmoved by the live arm banking a profit and opening a lot', async () => {
    const { db, cleanup } = openStore();
    try {
      const provider = makeProvider(db);
      const before = await provider.getAccountState(AS_OF);
      expect(before.cash).toBe(BOOK);
      expect(before.peak_equity).toBe(BOOK);

      insertClosedTrade(db, {
        key: 'live-win',
        assetClass: 'crypto',
        pnl: 400,
        closedAt: IN_THE_SESSION,
        arm: 'live',
      });
      insertOpenLot(db, { key: 'live-lot', arm: 'live', price: 35, size: 10 });

      const after = await provider.getAccountState(AS_OF);

      expect(after.cash).toBe(BOOK);
      expect(after.peak_equity).toBe(BOOK);
      expect(after.consecutive_losses).toBe(0);
      expect(after.daily_basis).toEqual(before.daily_basis);
    } finally {
      cleanup();
    }
  });

  it("moves on the control arm's OWN closes and its own open lots", async () => {
    const { db, cleanup } = openStore();
    try {
      insertClosedTrade(db, {
        key: 'control-old',
        assetClass: 'crypto',
        pnl: 100,
        closedAt: BEFORE_THE_SESSION,
        arm: 'control',
      });
      insertClosedTrade(db, {
        key: 'control-today',
        assetClass: 'crypto',
        pnl: -40,
        closedAt: IN_THE_SESSION,
        arm: 'control',
      });
      insertOpenLot(db, { key: 'control-lot', arm: 'control', price: 25, size: 4 });

      const state = await makeProvider(db).getAccountState(AS_OF);

      expect(state.cash).toBeCloseTo(BOOK + 60 - 100, 9);
      expect(state.peak_equity).toBe(BOOK + 100);
      expect(state.consecutive_losses).toBe(1);

      const crypto = state.daily_basis.crypto;
      expect(crypto.known).toBe(true);
      if (crypto.known) {
        expect(crypto.open_equity).toBe(BOOK + 100);
        expect(crypto.realized_pnl).toBe(-40);
      }
      const stocks = state.daily_basis.stocks;
      expect(stocks.known).toBe(true);
      if (stocks.known) expect(stocks.realized_pnl).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('holds the realized high-water mark once the control arm gives it back', async () => {
    const { db, cleanup } = openStore();
    try {
      const provider = makeProvider(db);
      insertClosedTrade(db, {
        key: 'control-up',
        assetClass: 'crypto',
        pnl: 250,
        closedAt: BEFORE_THE_SESSION,
        arm: 'control',
      });
      expect((await provider.getAccountState(AS_OF)).peak_equity).toBe(BOOK + 250);

      insertClosedTrade(db, {
        key: 'control-down',
        assetClass: 'crypto',
        pnl: -300,
        closedAt: IN_THE_SESSION,
        arm: 'control',
      });
      const drawn = await provider.getAccountState(AS_OF);

      expect(drawn.cash).toBe(BOOK - 50);
      expect(drawn.peak_equity).toBe(BOOK + 250);
    } finally {
      cleanup();
    }
  });

  it('refuses a daily percentage against a wiped-out base', async () => {
    const { db, cleanup } = openStore();
    try {
      insertClosedTrade(db, {
        key: 'control-ruin',
        assetClass: 'crypto',
        pnl: -BOOK,
        closedAt: BEFORE_THE_SESSION,
        arm: 'control',
      });

      const state = await makeProvider(db).getAccountState(AS_OF);

      expect(state.daily_basis.crypto.known).toBe(false);
      expect(state.daily_basis.portfolio.known).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('the control arm is wired to its own account state, not the live one (#753)', () => {
  it('reads disjoint trade sets through one store class', () => {
    const { db, cleanup } = openStore();
    try {
      insertClosedTrade(db, {
        key: 'live-1',
        assetClass: 'crypto',
        pnl: -50,
        closedAt: IN_THE_SESSION,
        arm: 'live',
      });
      insertClosedTrade(db, {
        key: 'control-1',
        assetClass: 'crypto',
        pnl: 900,
        closedAt: IN_THE_SESSION,
        arm: 'control',
      });

      const window = { from: BEFORE_THE_SESSION, to: AS_OF };
      const live = new SqliteClosedTradeStore(db).getClosedTradesBetween(window.from, window.to);
      const control = new SqliteClosedTradeStore(db, 'control').getClosedTradesBetween(
        window.from,
        window.to,
      );

      expect(live.map((trade) => trade.realized_pnl_net)).toEqual([-50]);
      expect(control.map((trade) => trade.realized_pnl_net)).toEqual([900]);
    } finally {
      cleanup();
    }
  });
});

describe('the control arm’s book anchor (#753)', () => {
  it('resolves the starting book exactly once, then stops reading it', async () => {
    const { db, cleanup } = openStore();
    try {
      const seen: number[] = [];
      let liveEquity = 100_000;
      const provider = makeProvider(db, async () => {
        seen.push(liveEquity);
        return liveEquity;
      });

      const first = await provider.getAccountState(AS_OF);
      liveEquity = 20_000;
      const second = await provider.getAccountState(AS_OF);

      expect(seen).toEqual([100_000]);
      expect(first.cash).toBe(100_000);
      expect(second.cash).toBe(100_000);
      expect(second.peak_equity).toBe(100_000);
    } finally {
      cleanup();
    }
  });

  it('still moves on the control arm’s own realized PnL after anchoring', async () => {
    const { db, cleanup } = openStore();
    try {
      insertClosedTrade(db, {
        key: 'control-1',
        assetClass: 'crypto',
        pnl: 250,
        closedAt: IN_THE_SESSION,
        arm: 'control',
      });

      const state = await makeProvider(db, async () => 100_000).getAccountState(AS_OF);

      expect(state.cash).toBe(100_250);
    } finally {
      cleanup();
    }
  });

  it('reconstructs the true high-water mark from the trade record after a restart', async () => {
    const { db, cleanup } = openStore();
    try {
      insertClosedTrade(db, {
        key: 'control-up',
        assetClass: 'crypto',
        pnl: 250,
        closedAt: BEFORE_THE_SESSION,
        arm: 'control',
      });
      insertClosedTrade(db, {
        key: 'control-down',
        assetClass: 'crypto',
        pnl: -300,
        closedAt: IN_THE_SESSION,
        arm: 'control',
      });

      const restarted = makeProvider(db, async () => BOOK);
      const state = await restarted.getAccountState(AS_OF);

      expect(state.peak_equity).toBe(BOOK + 250);
      expect(state.cash).toBe(BOOK - 50);
    } finally {
      cleanup();
    }
  });
});

describe('buildControlBookAnchorResolver (#753)', () => {
  function accountReturning(cash: number, peak = cash) {
    return {
      getAccountState: async () => ({
        cash,
        peak_equity: peak,
        daily_basis: {
          crypto: { known: true as const, open_equity: cash, realized_pnl: 0 },
          stocks: { known: true as const, open_equity: cash, realized_pnl: 0 },
          portfolio: { known: true as const, open_equity: cash, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      }),
    };
  }

  it('writes the live arm’s equity once and re-reads it on the next boot', async () => {
    const { db, cleanup } = openStore();
    try {
      const firstBoot = buildControlBookAnchorResolver({
        liveAccountState: accountReturning(100_000),
        store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
        fallbackBook: BOOK,
      });
      expect(await firstBoot(AS_OF)).toBe(100_000);

      const readsLive: number[] = [];
      const secondBoot = buildControlBookAnchorResolver({
        liveAccountState: {
          getAccountState: async () => {
            readsLive.push(1);
            return accountReturning(500_000).getAccountState();
          },
        },
        store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
        fallbackBook: BOOK,
      });

      expect(await secondBoot(AS_OF)).toBe(100_000);
      expect(readsLive).toEqual([]);
      expect(new SqliteAccountStateStore(db).peakEquity()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('anchors on the account’s scale, not on what is left after deployment', async () => {
    const { db, cleanup } = openStore();
    try {
      const resolve = buildControlBookAnchorResolver({
        liveAccountState: accountReturning(10_000, 100_000),
        store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
        fallbackBook: BOOK,
      });

      expect(await resolve(AS_OF)).toBe(100_000);
    } finally {
      cleanup();
    }
  });

  it('falls back to the declared book when the live account cannot be read', async () => {
    const { db, cleanup } = openStore();
    try {
      const resolve = buildControlBookAnchorResolver({
        liveAccountState: {
          getAccountState: async () => {
            throw new Error('venue down');
          },
        },
        store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
        fallbackBook: BOOK,
      });

      expect(await resolve(AS_OF)).toBe(BOOK);
    } finally {
      cleanup();
    }
  });

  it('does not persist the fallback on a transient failure, and anchors for real once the read succeeds', async () => {
    const { db, cleanup } = openStore();
    try {
      let shouldFail = true;
      const resolve = buildControlBookAnchorResolver({
        liveAccountState: {
          getAccountState: async () => {
            if (shouldFail) throw new Error('venue down');
            return accountReturning(250_000).getAccountState();
          },
        },
        store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
        fallbackBook: BOOK,
      });
      const anchorRow = new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY);

      expect(await resolve(AS_OF)).toBe(BOOK);
      expect(anchorRow.peakEquity()).toBeNull();

      shouldFail = false;
      expect(await resolve(AS_OF)).toBe(250_000);
      expect(anchorRow.peakEquity()).toBe(250_000);

      shouldFail = true;
      expect(await resolve(AS_OF)).toBe(250_000);
    } finally {
      cleanup();
    }
  });

  it('does not persist a successful-but-unusable read (zero equity), and falls back for that tick', async () => {
    const { db, cleanup } = openStore();
    try {
      const resolve = buildControlBookAnchorResolver({
        liveAccountState: accountReturning(0, 0),
        store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
        fallbackBook: BOOK,
      });
      const anchorRow = new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY);

      expect(await resolve(AS_OF)).toBe(BOOK);
      expect(anchorRow.peakEquity()).toBeNull();
    } finally {
      cleanup();
    }
  });

  describe('live_book_ceiling clamp (#972)', () => {
    it('clamps a live-observed anchor to the ceiling when the observation exceeds it', async () => {
      const { db, cleanup } = openStore();
      try {
        const resolve = buildControlBookAnchorResolver({
          liveAccountState: accountReturning(5_000, 5_000),
          store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
          fallbackBook: BOOK,
          liveBookCeiling: {
            book: BOOK,
            refuse_above_tolerance: 0.1,
            same_currency_verified: true,
          },
        });

        expect(await resolve(AS_OF)).toBe(BOOK);
        expect(new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY).peakEquity()).toBe(BOOK);
      } finally {
        cleanup();
      }
    });

    it('leaves the anchor uncapped when the ceiling is not currency-verified', async () => {
      const { db, cleanup } = openStore();
      try {
        const resolve = buildControlBookAnchorResolver({
          liveAccountState: accountReturning(5_000, 5_000),
          store: new SqliteAccountStateStore(db, CONTROL_BOOK_ANCHOR_KEY),
          fallbackBook: BOOK,
          liveBookCeiling: { book: BOOK, refuse_above_tolerance: 0.1 },
        });

        expect(await resolve(AS_OF)).toBe(5_000);
      } finally {
        cleanup();
      }
    });
  });
});
