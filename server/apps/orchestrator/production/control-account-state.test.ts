/**
 * #753 — the control arm's account state is its OWN.
 *
 * The property under test is independence in one direction and responsiveness in
 * the other, and both halves have to be asserted together: a filter bug that
 * returns no rows at all would satisfy "the live arm cannot move it" perfectly
 * while making the control arm unmeasurable.
 */
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
import { openSharedStore, type SharedStore } from '../../../shared/store/index.js';
import { ControlArmAccountStateProvider } from './control-account-state.js';

/** Saturday noon UTC: the crypto session opened at 00:00 UTC the same morning. */
const AS_OF = new Date('2026-08-01T12:00:00Z');
const BEFORE_THE_SESSION = new Date('2026-07-30T09:00:00.000Z');
const IN_THE_SESSION = new Date('2026-08-01T06:00:00.000Z');

const BOOK = 1_000;

function openStore(): { db: SharedStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-control-account-'));
  const db = openSharedStore(join(dir, 'test.sqlite'));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** As `account-state.test.ts`'s helper: `closed_at` normalized through `toISOString()`. */
function insertClosedTrade(
  db: SharedStore,
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

/** A filled long lot, written straight to the table so `filled_size` is non-zero. */
function insertOpenLot(
  db: SharedStore,
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

function makeProvider(db: SharedStore): ControlArmAccountStateProvider {
  return new ControlArmAccountStateProvider({
    book: BOOK,
    // `arm: 'control'` — the whole point. The live arm's Feedback Loop takes
    // the same class's default.
    closedTrades: new SqliteClosedTradeStore(db, 'control'),
    getOpenPositions: () => new SqliteExecutionStore(db, 'control').getOpenPositions(),
    calendars: { crypto: new AlwaysOpenCalendar(), stocks: new UsEquityRegularHoursCalendar() },
  });
}

describe('ControlArmAccountStateProvider (#753)', () => {
  /**
   * The blocking defect this class was written for. The control arm trades a
   * simulated venue and never touches the real broker, so a shared
   * `AccountStateProvider` — which reads `GET /v2/account` — made the control's
   * D5 sizing and its drawdown-halt timing functions of the LIVE arm's realized
   * cash. Same shape as `SqliteSessionEquityStore`'s `arm = 'live'` fix, in the
   * other direction.
   */
  it('is unmoved by the live arm banking a profit and opening a lot', async () => {
    const { db, cleanup } = openStore();
    try {
      const provider = makeProvider(db);
      const before = await provider.getAccountState(AS_OF);
      expect(before.cash).toBe(BOOK);
      expect(before.peak_equity).toBe(BOOK);

      // The live arm banks £400 and deploys £350 — a large cash movement on the
      // real account, which is exactly what the shared provider used to report.
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

  /**
   * The converse, in the same file on purpose: a filter that returned zero rows
   * would pass the case above and this one is what catches it.
   */
  it("moves on the control arm's OWN closes and its own open lots", async () => {
    const { db, cleanup } = openStore();
    try {
      // Settled before the session opened: it moves the denominator, not the
      // numerator.
      insertClosedTrade(db, {
        key: 'control-old',
        assetClass: 'crypto',
        pnl: 100,
        closedAt: BEFORE_THE_SESSION,
        arm: 'control',
      });
      // Inside the session: the daily numerator, and a loss, so the streak moves.
      insertClosedTrade(db, {
        key: 'control-today',
        assetClass: 'crypto',
        pnl: -40,
        closedAt: IN_THE_SESSION,
        arm: 'control',
      });
      insertOpenLot(db, { key: 'control-lot', arm: 'control', price: 25, size: 4 });

      const state = await makeProvider(db).getAccountState(AS_OF);

      // book + realized (100 − 40) − deployed (25 × 4)
      expect(state.cash).toBeCloseTo(BOOK + 60 - 100, 9);
      // The realized high-water mark: book + 100 was reached before the loss.
      expect(state.peak_equity).toBe(BOOK + 60);
      expect(state.consecutive_losses).toBe(1);

      const crypto = state.daily_basis.crypto;
      expect(crypto.known).toBe(true);
      if (crypto.known) {
        // Everything realized BEFORE the boundary is the denominator…
        expect(crypto.open_equity).toBe(BOOK + 100);
        // …and only what closed after it is the numerator.
        expect(crypto.realized_pnl).toBe(-40);
      }
      // The class filter is on the numerator only, exactly as the live provider
      // does it: the stock session opened Friday 16:00 ET, before this crypto
      // trade closed, but the trade is not a stock trade.
      const stocks = state.daily_basis.stocks;
      expect(stocks.known).toBe(true);
      if (stocks.known) expect(stocks.realized_pnl).toBe(0);
    } finally {
      cleanup();
    }
  });

  /**
   * `peak_equity` divides the drawdown breaker, so a peak that fell back with
   * equity would make a drawdown unmeasurable — the breaker would never see one.
   */
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

  /**
   * The live provider's non-positive-base guard, kept: a zero denominator makes
   * the daily fraction Infinity or NaN, and both compare false against the
   * breaker's threshold — a wiped-out book would read as a flat day.
   */
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
  /**
   * The composition-root half of the same property, one layer up: the two arms
   * must not share a `ClosedTradeStore` instance either. `SqliteClosedTradeStore`
   * defaults to the live arm — the Feedback Loop's reading — and only the control
   * provider asks for the other one.
   */
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
