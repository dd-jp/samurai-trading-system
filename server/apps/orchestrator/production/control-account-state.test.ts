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
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { CONTROL_BOOK_ANCHOR_KEY, SqliteAccountStateStore } from '../sqlite-account-state-store.js';
import {
  buildControlBookAnchorResolver,
  ControlArmAccountStateProvider,
} from './control-account-state.js';

/** Saturday noon UTC: the crypto session opened at 00:00 UTC the same morning. */
const AS_OF = new Date('2026-08-01T12:00:00Z');
const BEFORE_THE_SESSION = new Date('2026-07-30T09:00:00.000Z');
const IN_THE_SESSION = new Date('2026-08-01T06:00:00.000Z');

const BOOK = 1_000;

function openStore(): { db: StoreHandle; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-control-account-'));
  const db = openSharedStore(join(dir, 'test.sqlite'));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** As `account-state.test.ts`'s helper: `closed_at` normalized through `toISOString()`. */
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

/** A filled long lot, written straight to the table so `filled_size` is non-zero. */
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
      // The realized high-water mark: book + 100 was reached before the loss,
      // and the loss gives cash back without giving the PEAK back to a level
      // the net final balance alone would understate.
      expect(state.peak_equity).toBe(BOOK + 100);
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

/**
 * The book ANCHOR (#753, second pass).
 *
 * The first version of this provider took a constant `LIVE_BOOK_GBP`. `npm run
 * smoke` proved what that costs on a paper account — measured BEFORE #1112,
 * when paper's `capitalCeilingUsd` did not exist and neither arm's Trader
 * ask was clamped: the live arm sized off its full ~100,000 broker equity
 * while a control anchored at £1,000 sized off £1,000 alone, so every
 * control intent came back `rounds_to_zero_shares` and the arm took no trade
 * at all — a control that cannot be told apart from one that never found a
 * setup. Since #1112, both arms clamp to the same declared
 * `capitalCeilingUsd`, so this anchor's remaining job is only to stay above
 * that shared ceiling — see `ControlArmAccountStateProviderInput.resolveBook`'s
 * own doc for what is and is not settled about anchoring at the ceiling
 * itself.
 *
 * The property is therefore two-sided, exactly like the independence tests
 * above: the anchor must TRACK the live arm once, at boot, and must never track
 * it again.
 */
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
      // The live arm's account is wiped out between the two calls. The control
      // arm's book must not notice: it is a matched control, not a mirror.
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

  /**
   * #972 fix 1 — `peak_equity` has to survive a restart, not just retention
   * within one running process.
   *
   * The test above ("holds the realized high-water mark…") only proves that a
   * SINGLE `ControlArmAccountStateProvider` instance remembers a peak it
   * itself observed mid-process. It says nothing about what a FRESH instance
   * — the shape every process restart actually produces — reports when it
   * cold-reads the same trade history. The doc comment on `#peakEquity`
   * claims the peak is "re-derivable from the trade record on the next tick
   * after a restart (max of the cumulative realized curve)"; the
   * implementation this test targets does not do that walk, so a fresh
   * instance under-reports the peak whenever the account gave back some of
   * its high after the process that saw the high goes away.
   */
  it('reconstructs the true high-water mark from the trade record after a restart', async () => {
    const { db, cleanup } = openStore();
    try {
      // Control runs +250 then -300 (net -50) while some process is up.
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

      // A restart: a FRESH provider instance, never having seen the +250 tick
      // itself, reading the SAME store.
      const restarted = makeProvider(db, async () => BOOK);
      const state = await restarted.getAccountState(AS_OF);

      // The true peak was reached after the +250 close, before the -300 loss —
      // NOT the anchor (BOOK) and NOT the net (BOOK - 50), either of which a
      // running-sum-reset-to-the-anchor implementation would report instead.
      expect(state.peak_equity).toBe(BOOK + 250);
      expect(state.cash).toBe(BOOK - 50);
    } finally {
      cleanup();
    }
  });
});

/**
 * The anchor POLICY — persisted value first, one live observation second, the
 * declared book only as a last resort.
 *
 * Persistence is the load-bearing half. A lazily resolved anchor that is not
 * written down re-anchors on every process restart, so across a multi-restart
 * soak the control's book would slowly track the live arm's performance — a
 * re-coupling of exactly the kind the provider above exists to remove.
 */
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

      // A second process, started after the live arm has run its book up.
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
      // Not merely the right number: the live account is not consulted at all.
      expect(readsLive).toEqual([]);
      // And the live arm's own row is untouched — different key, same table.
      expect(new SqliteAccountStateStore(db).peakEquity()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('anchors on the account’s scale, not on what is left after deployment', async () => {
    const { db, cleanup } = openStore();
    try {
      // A restart taken while the live arm holds lots: `cash` is the residual,
      // `peak_equity` is the account. Anchoring on `cash` alone would start the
      // control at a fraction of the live arm's size for no stated reason.
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

      // Not a throw: this resolves on the first decision tick, and an account
      // read that fails must not take the live arm's tick down with it.
      expect(await resolve(AS_OF)).toBe(BOOK);
    } finally {
      cleanup();
    }
  });

  /**
   * #972 fix 2 — the declared-book fallback must NOT persist on a transient
   * failure.
   *
   * `store.anchorEquity` is first-write-wins (`ON CONFLICT(key) DO NOTHING`).
   * The test above proves the fallback is RETURNED on a failing read, but not
   * that it stays unwritten — and writing it would permanently pin the
   * control's book at the declared £1,000 against the live arm's real
   * ~100,000-scale account (the exact `rounds_to_zero_shares` inertness the
   * anchor mechanism exists to solve), recoverable only by hand-deleting the
   * DB row. A single bad tick must not be able to do that.
   */
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

      // Tick 1: the live read throws. The fallback is used for THIS tick only.
      expect(await resolve(AS_OF)).toBe(BOOK);
      expect(anchorRow.peakEquity()).toBeNull();

      // Tick 2: the live read succeeds. The anchor is persisted at the real
      // live value — first-write-wins now has something real to win with.
      shouldFail = false;
      expect(await resolve(AS_OF)).toBe(250_000);
      expect(anchorRow.peakEquity()).toBe(250_000);

      // Tick 3: reads the persisted real anchor, not the fallback — even
      // though the live account happens to be unreadable again.
      shouldFail = true;
      expect(await resolve(AS_OF)).toBe(250_000);
    } finally {
      cleanup();
    }
  });

  /**
   * The same non-persistence hazard as a throw (#972 fix 2), but for a
   * successful read that comes back unusable — zero, negative, or
   * non-finite. Persisting a nonsense observation would pin the anchor at
   * that value forever via `store.anchorEquity`'s first-write-wins upsert,
   * same as persisting the fallback would. Not asked for by #972's text,
   * but the same hazard the fix targets, so it gets the same treatment.
   */
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

  /**
   * #972 fix 3 — the primary (live-read) anchor path ignores `live_book_ceiling`
   * while the fallback path already resolves through it (`fallbackBook` in
   * `production.ts` is `config.riskConfig.live_book_ceiling?.book ??
   * LIVE_BOOK_GBP`). If the ceiling is meant to clamp the sizing basis, the
   * anchor and the live arm's own sizing basis must not be able to diverge.
   */
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

    /**
     * The divergence from `liveBookCeiling` (risk-manager/index.ts), which
     * THROWS a `currency_mismatch` refusal when `same_currency_verified` is
     * unset. This resolver cannot do the same: it runs on the control arm's
     * decision path for exits as well as entries, and it has none of the
     * `ENTRY_CAP_GATES`-array structural guarantee that only entries reach it
     * — a throw here would be the "guard above an early return blocks exits"
     * defect class in a new file. So an unverified ceiling is left unapplied
     * (the pre-#972 behaviour) rather than refused outright.
     */
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
