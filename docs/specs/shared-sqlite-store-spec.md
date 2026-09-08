# Shared SQLite Store Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-07-26
**Wayfinder map:** [Shared SQLite Store (#162)](https://github.com/dd-jp/samurai-trading-system/issues/162)

## Problem Statement

Eleven of Samurai's twelve backend specs already assume a persistent shared store exists — positions, fills, closed trades, bars, marks, debates, verdicts, weights, config trials, the cosine setup store, the audit log. Every spec currently backs its own piece with a throwaway in-memory fixture store, and the schema for each table is scattered across those eleven documents rather than collected anywhere. This spec is that collection point: it locks the concrete driver, migration strategy, crash-safety mode, module surface, file-path convention, and the full consolidated DDL, so the store can actually be built once and injected everywhere, matching how the other eleven components were specced before implementation.

This spec produces the store's design, not its implementation — implementation is handed to `/to-tickets` afterward.

## Solution

The shared store is a single **better-sqlite3** database per environment (`data/samurai-{env}.sqlite`), opened through one `openSharedStore(dbPath)` factory that runs pending migrations and returns a typed `SharedStore` handle, injected into every stage via constructor injection — the same `store: SharedStore` pattern already used throughout the Execution, Trader, and Risk specs. WAL mode + `synchronous=FULL` gives crash-restart safety without meaningfully taxing this system's tick-based (not HFT) write rate. Migrations are hand-rolled numbered SQL files tracked in a `schema_migrations` table — no ORM, matching the project's existing direct-SQL posture.

Every table's schema was already implicitly decided by the spec that owns it; this document's job was mostly synthesis (collecting eleven specs' worth of implicit DDL into one place) plus five genuinely open decisions this map resolved: the SQLite driver, the migration strategy, the crash-safety mode, the module wiring pattern, the DB file-path convention, and three tables that had no schema anywhere (`config_trials`, the Feedback Loop's dial + adjustment-history tables, and the `cosine_setups` store).

Key architectural decisions:
- **better-sqlite3**, not `node:sqlite`, for maturity (`node:sqlite` is still experimental on Node 22).
- **Hand-rolled numbered migrations** (`migrations/0001_init.sql`, ...) + a `schema_migrations` runner table — no ORM, no new dependency.
- **WAL mode + `synchronous=FULL`** — implements CONTEXT.md's crash-restart invariant; throughput cost is negligible at this system's write rate.
- **`openSharedStore(dbPath): SharedStore` factory** — constructor injection everywhere, matching the existing pattern; the Orchestrator's composition root (where the factory is actually called) is separate, not-yet-charted work.
- **One SQLite file per environment** (`data/samurai-paper.sqlite`, `data/samurai-live.sqlite`) <!-- cite-exempt: untracked — runtime store files, created on first run and gitignored by design; this line names the convention, not files expected to be in the tree --> — not a single file with an environment column, so paper/live PnL cross-contamination is physically impossible. Tests use a fresh temp file or `:memory:`.
- **JSON columns for rich, non-queried nested data** (a WorldMonitor/audit_log-style JSONB pattern) — `config_trials.result_json`/`config_json`, `cosine_setups.debate_features_json`/`market_features_json` — rather than decomposing every nested structure into its own columns.
- **Every table's own consumer dictates its key** — no generic catch-all tables; `analyst_weights`/`strategy_params`/`risk_thresholds` are three tables, not one, because three different stages read them by three different natural keys.

## Implementation Decisions

### Module: Driver

**better-sqlite3.** Chosen over the built-in `node:sqlite` for maturity — `node:sqlite` is still experimental despite being available on Node 22. (Resolved: [Decide: SQLite driver/library](https://github.com/dd-jp/samurai-trading-system/issues/163).)

### Module: Migrations

Hand-rolled numbered SQL files (`migrations/0001_init.sql`, `migrations/0002_...sql`, ...), applied in order by a small runner that tracks applied versions in a `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
```

No ORM — matches the project's existing direct-SQL posture (no ORM anywhere else in the codebase). Needed because the live DB holds real trade data that must survive schema changes post-launch, while tests need the same schema built fresh and deterministically from the same migration files. (Resolved: [Decide: migration/versioning strategy](https://github.com/dd-jp/samurai-trading-system/issues/164).)

The full DDL below is the eventual content of **`migrations/0001_init.sql`** — not created by this spec (spec-writing only; the migrations directory itself is implementation, handed to `/to-tickets`).

### Module: Crash-Safety Mode

**WAL mode + `synchronous=FULL`.** Implements CONTEXT.md's "crash-restart must not lose open positions" invariant and CLAUDE.md's flagged power/WiFi-drop risk. Throughput cost is negligible for a low-frequency (tick-based, not HFT) system. (Resolved: [Decide: crash-safety mode](https://github.com/dd-jp/samurai-trading-system/issues/165).)

### Module: Wiring

```typescript
function openSharedStore(dbPath: string): SharedStore;
```

Runs pending migrations, returns a typed handle. Components receive it via constructor injection, matching the `store: SharedStore` pattern already used throughout the Execution, Trader, and Risk specs. Confirms the existing injection pattern rather than inventing a new one; the Orchestrator's actual composition root (where the factory gets called at boot) is separate, not-yet-charted work. (Resolved: [Decide: module surface / wiring](https://github.com/dd-jp/samurai-trading-system/issues/166).)

### Module: DB File Path Convention

**`data/samurai-{env}.sqlite`** at repo root — one file per environment (`data/samurai-paper.sqlite`, `data/samurai-live.sqlite`) <!-- cite-exempt: untracked — runtime store files, created on first run and gitignored by design; this line names the convention, not files expected to be in the tree -->, not a single file with an environment column, so paper/live PnL cross-contamination is physically impossible. Tests use a fresh temp file or `:memory:`, never a checked-in test DB. (Resolved: [Decide: DB file path convention](https://github.com/dd-jp/samurai-trading-system/issues/168).)

### Module: Consolidated Schema

Every `CREATE TABLE` the store needs, collected from the eleven specs that implicitly define them plus the three that had no schema anywhere until this map resolved them (`verdict_log` and `breaker_state` were added later, per #206 and #203 respectively). `cii_snapshots` was added later still, per #182 (`0003_cii_snapshots.sql`). `account_state` was added later still, per the transport-layer-spec.md cross-verify pass (2026-07-31), closing a gap where `AccountStateProvider`'s `peak_equity` had no durable home. `session_equity` was added per [#332](https://github.com/dd-jp/samurai-trading-system/issues/332) (`0009_session_equity.sql`), resolving GAP-8 by giving the session-scoped daily-PnL denominator a durable per-class home instead of reading Alpaca's blended `last_equity`. `broker_brackets` and `broker_observed_fills` were added last, per [#287](https://github.com/dd-jp/samurai-trading-system/issues/287) (`0007_broker_adapter_state.sql`), closing the gap where every live `BrokerAdapter` held money-critical venue state in process-local memory. `broker_unpriced_fills` was added last of all, per [#298](https://github.com/dd-jp/samurai-trading-system/issues/298) (`0008_broker_unpriced_fills.sql`), giving a permanently-unpriced fill a durable age-out clock so it escalates to an operator instead of leaving a lot stuck in silence. Field-level non-collision was re-verified across the original twenty-two tables (see **Non-Collision Verification** below) — a manual recount against today's schema actually gives twenty-three for that same original batch (`daily_equity` joined the AccountStateProvider block without this figure being bumped for it); not corrected further here since it predates and is outside this paragraph's own scope, but named so it is not silently repeated as fact.

Four more tables were added after that pass, each checked for collision at the point it joined (`llm_spend`, `risk_critic_log`, `arm_comparison_samples`, `outside_benchmark_samples` — see each one's own subsection below). [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174) closed a further gap: eight real, migrated tables (`stage2_selected_config`, `trader_log`, `risk_log`, `flatten_submissions`, `llm_call_log`, `alert_delivery_failures`, `feedback_cycle_schedule`, `llm_spend_cap`) were named as owned in the "Integration with Pipeline" map (two of them — `alert_delivery_failures` and `feedback_cycle_schedule` — were not even named there) but carried no DDL anywhere in this document; their `CREATE TABLE` statements and per-table collision notes are appended after `outside_benchmark_samples`, each folded to its CURRENT effective shape (every later `ALTER TABLE` migration read and applied), not just its creating migration.

The store now has **thirty-five** real tables in total — `CONSOLIDATED_SCHEMA_TABLE_COUNT` in `server/shared/store/open-shared-store.test.ts` holds the same figure and fails if a migration adds a table without updating it; nothing compares this paragraph to that constant, so drift here is still possible and must be caught by hand. All thirty-five now carry DDL somewhere in this document, closing #1174's acceptance criterion that the "full consolidated DDL" claim be true or narrowed. **#1174 left it narrowed rather than fully true, in one respect: table-level completeness is not the same claim as column-level currency.** Six tables that were already declared here before that pass had DDL blocks predating later `ALTER TABLE` migrations, missing the columns/indexes/CHECK values those migrations added — `audit_log`, `open_positions`, `closed_trades`, `debate_log`, `fills`, `llm_spend`, and (verified rather than assumed correct) `verdict_log`'s index and `risk_critic_log`'s two comment-disclosed columns. **[#1251](https://github.com/dd-jp/samurai-trading-system/issues/1251) closed that gap**: every already-declared table below is now folded to its current effective shape, `risk_critic_log`'s two 0040 columns are inlined rather than commented (see that table's own subsection for why the earlier comment-only choice no longer applies), and #1251's verification pass — building a real migrated `:memory:` DB and diffing it against the spec's own fenced DDL, in both directions, column-by-column and CHECK-by-CHECK — found further drift #1174 did not name: `closed_trades.close_reason`'s widened CHECK (0031) and `modelled_cost_charged` (0049), `verdict_log`'s missing index (0005, not re-checked when #1234 fixed its columns), `flatten_submissions.arm` + its index (0050), the three `broker_*` tables' `venue` CHECK missing `'saxo'` (0048) and `broker_brackets.phase`'s CHECK missing `'submitting'`/`'cancelling_sibling'` (0017/0022), `arm_comparison_samples`' missing table-level CHECK, and `dial_adjustments.reason`'s missing `DEFAULT ''` (0002) — all fixed in the same pass. **[`server/shared/store/spec-schema-drift.test.ts`](../../server/shared/store/spec-schema-drift.test.ts) now enforces this claim mechanically** — it builds both a `:memory:` DB from this document's own fenced `CREATE TABLE`/`CREATE INDEX` blocks and a second `:memory:` DB from the real migration chain, and fails on any column, index, or CHECK-constraint difference between them, in either direction. Every table below is folded to its current effective shape, each verified column-by-column against a freshly migrated `:memory:` database (`PRAGMA table_info`), and each `CHECK` constraint and `CREATE INDEX` cross-checked directly against that database's `sqlite_master.sql` — not merely transcribed from its creating migration. Say this plainly: a folded `CREATE TABLE` below is a record of a table's current shape, not something you can hand to `sqlite3` and replay in migration order to reach that shape — it collapses N migrations into one statement, and the prose above each block is what carries which migration contributed which column.

**Market Data Service** — owner: `docs/specs/market-data-service-spec.md`

```sql
-- Append-only bar history; the survivorship-free history AND the bulk cache tier.
CREATE TABLE bars (
  instrument   TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  open_time    TEXT NOT NULL,
  close_time   TEXT NOT NULL,
  open         REAL NOT NULL,
  high         REAL NOT NULL,
  low          REAL NOT NULL,
  close        REAL NOT NULL,
  volume       REAL NOT NULL,
  source       TEXT NOT NULL,          -- 'kraken' | 'ibkr' | 'alpaca' ... (audit only)
  PRIMARY KEY (instrument, timeframe, open_time)
);
CREATE INDEX idx_bars_close_time ON bars(instrument, timeframe, close_time);

-- One upserted row per instrument; read synchronously by Risk/Verdict. Never read in backtest.
CREATE TABLE latest_mark (
  instrument   TEXT PRIMARY KEY,
  price        REAL NOT NULL,
  observed_at  TEXT NOT NULL,
  asset_class  TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),  -- FIX (#183): dropped from the original persistence bullet; the `Mark` interface (market-data-service-spec.md) already declares this field, restored here to match
  source       TEXT NOT NULL
);
```

**Market Intelligence** — owner: `docs/specs/market-intelligence-spec.md`

```sql
-- Post-launch CII history capture (#182) — the drawdown-correlation study #173 couldn't
-- run for lack of any WorldMonitor-side history (ADR-0002 §6). Append-only; a missing/null
-- provider read records no row, never a NULL score.
CREATE TABLE cii_snapshots (
  country_code  TEXT NOT NULL,
  score         REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  captured_at   TEXT NOT NULL,
  PRIMARY KEY (country_code, captured_at)
);
CREATE INDEX idx_cii_snapshots_captured_at ON cii_snapshots(captured_at);
```

**Execution** — owner: `docs/specs/execution-spec.md`, sole writer of all three tables below

```sql
-- Live open state — Trader position-awareness + Risk exposure. Mutable.
-- Folded in by #1251: conviction/converged (0004), residual_unprotected_since/
-- residual_rearm_alerted_at (0024), key_scheme (0027), arm + idx_open_positions_arm
-- (0033), decision_price/quote_bid/quote_ask/quote_mid/quote_observed_at/
-- modelled_cost_breakdown_json (0037), sizing_capital_ceiling (0045).
CREATE TABLE open_positions (
  idempotency_key              TEXT PRIMARY KEY,
  debate_id                    TEXT NOT NULL,
  instrument                   TEXT NOT NULL,
  asset_class                  TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side                         TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  intent_type                  TEXT NOT NULL CHECK(intent_type IN ('entry', 'scale_in')),
  requested_size               REAL NOT NULL,
  filled_size                  REAL NOT NULL,   -- cumulative; downstream reads THIS, never requested_size
  avg_entry_price              REAL NOT NULL,
  stop                         REAL NOT NULL,   -- live protective leg (resized on partial fill)
  target                       REAL NOT NULL,
  order_state                  TEXT NOT NULL,
  broker_order_ids             TEXT NOT NULL,   -- JSON string[]
  opened_at                    TEXT NOT NULL,
  decision_timestamp           TEXT NOT NULL,   -- the bar/decision time (from OrderIntent)
  conviction                   REAL NOT NULL DEFAULT 1,
  converged                    INTEGER NOT NULL DEFAULT 0,
  residual_unprotected_since   TEXT,
  residual_rearm_alerted_at    TEXT,
  key_scheme                   INTEGER NOT NULL DEFAULT 2,
  arm                          TEXT NOT NULL DEFAULT 'live' CHECK(arm IN ('live', 'control')),
  decision_price               REAL,
  quote_bid                    REAL,
  quote_ask                    REAL,
  quote_mid                    REAL,
  quote_observed_at            TEXT,
  modelled_cost_breakdown_json TEXT,
  sizing_capital_ceiling       REAL
);

CREATE INDEX idx_open_positions_instrument ON open_positions(instrument, asset_class);
CREATE INDEX idx_open_positions_arm ON open_positions(arm, opened_at);

-- One row per (partial) fill — every fill logged (CONTEXT.md invariant #4). Append-only.
-- exit_reason (0031, threaded from flatten_submissions.exit_reason — see 0031's
-- doc comment) and flatten_idempotency_key (0037, the flatten write-ahead row's
-- own idempotency_key, so a split flatten fill can be traced back to its
-- submission) folded in by #1251, alongside idx_fills_broker_fill_id (0005) —
-- present since one of this table's earliest migrations (the table itself is
-- 0001) but never folded into this block until now.
CREATE TABLE fills (
  idempotency_key          TEXT NOT NULL,
  broker_fill_id           TEXT NOT NULL,
  leg                      TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  price                    REAL NOT NULL,
  qty                      REAL NOT NULL,
  fee                      REAL NOT NULL,
  timestamp                TEXT NOT NULL,
  cost_breakdown_json      TEXT NULL,      -- JSON {spread_cost, commission, slippage, market_impact}; Simulated-adapter fills only (undefined/null on real broker fills)
  exit_reason              TEXT,
  flatten_idempotency_key  TEXT,
  PRIMARY KEY (idempotency_key, broker_fill_id)
);
CREATE INDEX idx_fills_broker_fill_id ON fills(broker_fill_id);

-- Emitted on round-trip-to-flat — the Feedback Loop / Risk realized record. Append-only.
-- Folded in by #1251: arm + idx_closed_trades_arm (0033), sizing_capital_ceiling
-- (0045), modelled_cost_charged (0049 — whether the modelled cost model was
-- actually charged against this trade's realized_pnl_net; see 0049's doc comment
-- for the per-arm backfill). close_reason's CHECK also widened by 0031 (#793)
-- to the three ExitReason values named below, alongside the original
-- bracket-hit/legacy set -- 'exit' stays legal for pre-0031 rows whose
-- specific reason was never recorded (0031's doc comment).
-- idx_closed_trades_closed_at predates all of that -- 0005_hot_path_indexes.sql
-- (the table itself is 0001; 0005 is one of its earliest migrations, not the
-- first) -- and had never been folded into this block; 0031's table rebuild
-- (for the CHECK widening above) recreates the same index as a byproduct but
-- does not originate it.
CREATE TABLE closed_trades (
  idempotency_key        TEXT PRIMARY KEY,   -- per-lot
  debate_id              TEXT NOT NULL,      -- attribution + setup-store join key
  instrument             TEXT NOT NULL,
  asset_class            TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side                   TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  entry                  REAL NOT NULL,      -- avg entry, from fills
  stop                   REAL NOT NULL,      -- initial protective stop → initial risk
  filled_size            REAL NOT NULL,      -- initial risk = |entry - stop| x filled_size
  realized_pnl_net       REAL NOT NULL,      -- net of fees
  fees_total             REAL NOT NULL,
  opened_at              TEXT NOT NULL,
  closed_at              TEXT NOT NULL,
  close_reason           TEXT NOT NULL CHECK(close_reason IN (
                            'stop', 'target', 'exit',
                            'flatten', 'signal_decay', 'direction_flip'
                          )),
  arm                    TEXT NOT NULL DEFAULT 'live' CHECK(arm IN ('live', 'control')),
  sizing_capital_ceiling REAL,
  modelled_cost_charged  INTEGER NOT NULL DEFAULT 1 CHECK (modelled_cost_charged IN (0, 1))
);
CREATE INDEX idx_closed_trades_closed_at ON closed_trades(closed_at);
CREATE INDEX idx_closed_trades_arm ON closed_trades(arm, closed_at);
```

**Broker Adapters** — owner: `docs/specs/execution-spec.md` ("Module: Broker Abstraction"), written from BELOW the `SharedStore` seam

```sql
-- Durable BrokerAdapter-local venue bookkeeping (#287). NOT part of open_positions:
-- that is the lot's system-of-record, owned by the store seam ABOVE the adapter, and
-- adapter state is a different grain with a different owner -- which venue order id is
-- which leg, how far the ccxt OCO emulation has got. Nothing above the broker boundary
-- may read it; folding it into open_positions would leak the emulation through the seam
-- and give the lot record a second writer.
--
-- One table for all four venues because no consumer reads across them: each adapter
-- loads only `WHERE venue = ?`, and `venue` is in the PK so two adapters can never
-- collide on a shared client order id. Per-venue column applicability:
--   ccxt   -- all columns; this IS the emulation's state machine.
--   ibkr   -- identity + the three order ids; phase is always 'armed' (the OCA group is
--             the state machine).
--   alpaca -- identity + the three order ids, same as IBKR. Only entry_order_id is read
--             back (the adapter indexes client-order-id -> bracket parent and reaches the
--             children through the parent's legs); both children are written anyway
--             because the submit response carries them.
--   saxo   -- identity + the three order ids, same shape as Alpaca/IBKR. 'saxo' joined
--             the venue set via 0048 (#1032 item 1) -- the live equity leg (ADR-0015,
--             2026-08-30 amendment).
-- The request columns are nullable because the two REHYDRATION paths (Alpaca/IBKR
-- getOrder, which learn of a bracket by asking the venue) legitimately know the order
-- ids and not the request that produced them; inventing values there would be worse
-- than none. A ccxt row always carries them, being the only venue that re-places legs.
-- phase's CHECK also carries 'submitting' (0017, #312) and 'cancelling_sibling' (0022,
-- #586), both added before saxo joined and folded in here by #1251.
CREATE TABLE broker_brackets (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca', 'saxo')),
  client_order_id  TEXT NOT NULL,    -- same value as open_positions.idempotency_key
  phase            TEXT NOT NULL CHECK(phase IN ('submitting', 'pending_entry', 'arming', 'armed', 'cancelling_sibling', 'resolved')),
  entry_order_id   TEXT NULL,        -- ccxt entry / IBKR parent / Alpaca bracket parent
  stop_order_id    TEXT NULL,
  target_order_id  TEXT NULL,
  instrument       TEXT NULL,
  asset_class      TEXT NULL CHECK(asset_class IS NULL OR asset_class IN ('crypto', 'stocks')),
  side             TEXT NULL CHECK(side IS NULL OR side IN ('buy', 'sell')),
  size             REAL NULL,        -- REQUESTED size, not the filled quantity
  entry_price      REAL NULL,        -- the request's limit prices, NOT open_positions'
  stop_price       REAL NULL,        -- live protective levels: named apart on purpose
  target_price     REAL NULL,
  time_in_force    TEXT NULL,
  armed_qty        REAL NULL,        -- ccxt: quantity the LIVE legs protect
  arming_qty       REAL NULL,        -- ccxt: quantity the IN-FLIGHT arming episode places
  arm_attempt      INTEGER NOT NULL DEFAULT 0,  -- ccxt: fixes the leg client-order-id suffix
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (venue, client_order_id)
);

-- The ccxt adapter's observed-fill queue, made durable. Only ccxt writes here, and the
-- asymmetry is real rather than an oversight: Alpaca and IBKR DERIVE their fills from the
-- venue on every fetchNewFills, so a durable bracket row is enough to make those feeds
-- whole after a restart. ccxt's fills are generated by a TRANSITION (advanceEntry
-- normalizes the entry fill exactly once, on the pending_entry -> arming edge) and nothing
-- re-derives them, so an armed bracket's undrained entry fill was lost outright on a crash.
-- Append-only and UNPRUNED, and unbounded over time rather than over a process lifetime as
-- the in-memory array it replaces was: the adapter loads its whole venue partition on
-- construction. Pruning is deferred, not forgotten -- a row may only be dropped once its
-- fill is certain to be in `fills`, and that certainty lives above the broker seam in
-- ingestFills(), which this table's writer cannot see. ingestFills() dedups on
-- broker_fill_id, so a re-offered row costs nothing.
-- venue's CHECK widened to 'saxo' by 0048, same as broker_brackets above.
CREATE TABLE broker_observed_fills (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca', 'saxo')),
  client_order_id  TEXT NOT NULL,
  broker_fill_id   TEXT NOT NULL,
  leg              TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  price            REAL NOT NULL,
  qty              REAL NOT NULL,
  fee              REAL NOT NULL,
  timestamp        TEXT NOT NULL,
  PRIMARY KEY (venue, client_order_id, broker_fill_id)
);

-- The age-out clock for a fill the venue reports filled and will not price (#298,
-- 0008_broker_unpriced_fills.sql). An adapter refuses to book such a fill -- a zero price is
-- fabricated, and it flows into weighted-average entry, realized PnL and the R-multiple --
-- and relies on the next poll re-offering it priced. Right for the transient case, silent
-- for the permanent one: the lot stays under-filled, its stop is never resized to the real
-- quantity, no ClosedTrade is emitted, and nothing escalates. This table remembers WHEN the
-- anomaly was first seen, so the adapter can escalate it to an operator once past a
-- threshold and only once. DURABLE because the clock must outlive a restart: an unattended
-- soak (#238) contains restarts, and an in-process clock would age nothing out. Deleted when
-- the venue finally prices the fill. NOT `broker_observed_fills`: `price` is NOT NULL there,
-- and an unpriced row on that path is exactly what is being refused.
-- venue's CHECK widened to 'saxo' by 0048, same as broker_brackets above.
CREATE TABLE broker_unpriced_fills (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca', 'saxo')),
  client_order_id  TEXT NOT NULL,
  broker_fill_id   TEXT NOT NULL,
  leg              TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  instrument       TEXT NOT NULL,   -- denormalized from the parent: legs carry no symbol
  qty              REAL NOT NULL,   -- what the venue claims filled
  first_seen_at    TEXT NOT NULL,   -- set once, never updated -- THE clock
  last_seen_at     TEXT NOT NULL,
  alerted_at       TEXT NULL,       -- set only after the alert was accepted by the channel
  PRIMARY KEY (venue, client_order_id, broker_fill_id)
);
```

**Cost-Model / Backtest Harness** — owner: `docs/specs/cost-model-backtest-spec.md`

```sql
-- The trial-count discipline (load-bearing): N = COUNT(*), distinct by construction via PK.
CREATE TABLE config_trials (
  config_hash  TEXT PRIMARY KEY,
  seed         INTEGER NOT NULL,
  config_json  TEXT NOT NULL,      -- full BacktestConfig, verbatim
  result_json  TEXT NOT NULL,      -- full BacktestReport, verbatim
  recorded_at  TEXT NOT NULL
);
```

Resolved: [Decide: config_trials column schema (#179)](https://github.com/dd-jp/samurai-trading-system/issues/179). `recordTrial` upserts on conflict (`INSERT ... ON CONFLICT(config_hash) DO UPDATE ...`) — a re-run of the same config overwrites the stored result with the latest run's output. `distinctTrialCount()` is `SELECT COUNT(*) FROM config_trials`. FL's revalidation path must read this table (`SELECT ... WHERE config_hash = ?`) and never call `recordTrial` — schema cannot enforce this; flagged for `feedback-loop-spec.md`/`cost-model-backtest-spec.md` as [#185](https://github.com/dd-jp/samurai-trading-system/issues/185).

**Feedback Loop** — owner: `docs/specs/feedback-loop-spec.md`

```sql
-- Current dial values — one table per dial, keyed to match each dial's own consumer.
CREATE TABLE analyst_weights (
  analyst_id  TEXT PRIMARY KEY,
  weight      REAL NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE strategy_params (
  param_name  TEXT PRIMARY KEY,
  value       REAL NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE risk_thresholds (
  threshold_name  TEXT PRIMARY KEY,
  value           REAL NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Shared adjustment-history log across all three dial types. "Reversible" = another logged
-- adjustment, not a distinct undo mechanism. pending_approval rows are mutated in place on
-- approval/rejection (the one exception to append-only) -- this is the same row, not a new one.
CREATE TABLE dial_adjustments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dial_type   TEXT NOT NULL CHECK(dial_type IN ('analyst_weight', 'strategy_param', 'risk_threshold')),
  dial_name   TEXT NOT NULL,   -- analyst_id / param_name / threshold_name, depending on dial_type
  from_value  REAL NOT NULL,
  to_value    REAL NOT NULL,
  direction   TEXT CHECK(direction IN ('tighten', 'loosen') OR direction IS NULL),  -- NULL for weight adjustments
  status      TEXT NOT NULL CHECK(status IN ('applied', 'pending_approval', 'rejected', 'reverted')),
  cycle_date  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT ''  -- machine-readable cause, e.g. 'attribution', 'proposal', 'proposal:backtest_auto_approved' (#197). DEFAULT '' is 0002's ALTER default, not a spec choice -- SqliteAdjustmentLog always supplies a real reason on write, so it exists purely to backfill the rows written before this column existed.
);
CREATE INDEX idx_dial_adjustments_dial ON dial_adjustments(dial_type, dial_name, created_at);
CREATE INDEX idx_dial_adjustments_status ON dial_adjustments(status);

-- The cosine setup store -- Trader writes at decision time, FL labels on trade close.
-- PK is debate_id (not idempotency_key): one setup vector per debate, matching how the
-- Trader derives a SetupVector from a single DebateResult before sizing produces an order.
-- idempotency_key is kept as a required, non-unique indexed column purely for FL's
-- trade-close join (ClosedTrade carries idempotency_key, not debate_id alone, as its PK).
CREATE TABLE cosine_setups (
  debate_id             TEXT PRIMARY KEY,  -- one row per debate; Trader's setup-vector key
  idempotency_key       TEXT NOT NULL,     -- FL's trade-close join column (non-unique: see note below)
  instrument            TEXT NOT NULL,     -- retrieval scoping
  asset_class           TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),  -- retrieval scoping
  debate_features_json  TEXT NOT NULL,     -- serialized number[] (SetupVector.debate_features)
  market_features_json  TEXT NOT NULL,     -- serialized number[] (SetupVector.market_features)
  r_multiple            REAL NULL,         -- NULL = open/unlabelled; set once by FL's onTradeClose. Also the open/closed signal: no separate status column.
  closed_at             TEXT NULL,         -- nullable; set together with r_multiple, for point-in-time backtest correctness (retrieval must exclude setups not yet closed as of the injected clock)
  created_at            TEXT NOT NULL      -- decision time
);
CREATE INDEX idx_cosine_setups_idempotency_key ON cosine_setups(idempotency_key);
CREATE INDEX idx_cosine_setups_r_multiple ON cosine_setups(r_multiple);
```

Resolved: [Decide: Feedback Loop dial tables + adjustment-history schema (#180)](https://github.com/dd-jp/samurai-trading-system/issues/180), [Decide: cosine setup store schema (#181)](https://github.com/dd-jp/samurai-trading-system/issues/181). Note the `idempotency_key` column on `cosine_setups` is intentionally **not** unique/indexed-unique: a debate can in principle be revisited by more than one order-intent lifecycle over time (e.g. a skipped setup that's later re-evaluated under a fresh idempotency key), so uniqueness is enforced only on `debate_id`, the Trader's actual write key.

**Debate Engine** — owner: `docs/specs/debate-engine-spec.md`

```sql
-- Append-only. FL's system-of-record for per-analyst attribution, joined by debate_id.
-- Folded in by #1251: trace_id + idx_debate_log_trace (0015, correlation to the
-- Orchestrator's tick); confidence/synthesis/position/disagreement_summary/
-- open_items_json/converged (0026, the Debate Engine's structured verdict);
-- termination (0041); termination_cause (0051, #1380 — 'budget' vs
-- 'llm_failure', so a budget-tuning query can exclude LLM-outage rows without
-- reading `termination` itself, which stays 'latency_truncated' either way).
-- idx_debate_log_created_at (0005 — dashboard time-windowed reads).
CREATE TABLE debate_log (
  debate_id            TEXT PRIMARY KEY,
  instrument           TEXT NOT NULL,
  bar_timestamp        TEXT NOT NULL,
  contributions_json   TEXT NOT NULL,   -- JSON AnalystContribution[] (influence_score, stance, per analyst)
  direction            TEXT NOT NULL CHECK(direction IN ('bullish', 'bearish', 'neutral')),  -- tracks the registry's `Direction` (cross-spec-contracts.md); the CHECK's literal set must move in lockstep with that type
  rounds               INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  trace_id             TEXT,
  confidence           REAL,
  synthesis            TEXT,
  position             TEXT,
  disagreement_summary TEXT,
  open_items_json      TEXT,
  converged            INTEGER,
  termination          TEXT,
  termination_cause    TEXT
);
CREATE INDEX idx_debate_log_created_at ON debate_log(created_at);
CREATE INDEX idx_debate_log_trace ON debate_log (trace_id);
```

**Risk Manager** — owner: `docs/specs/risk-manager-spec.md`

```sql
-- One row per breaker tier. Crash-restart-safe home for the two sticky
-- breakers (hard peak-to-trough drawdown, kill-switch) -- everything else
-- CircuitBreakers computes is stateless/derived fresh each call and does
-- not need persistence. Upserted by the caller after every RiskManagerImpl
-- evaluate() call from RiskDecision.next_breaker_state; CircuitBreakers
-- loads these rows on construction/restart instead of starting untripped.
CREATE TABLE breaker_state (
  tier        TEXT PRIMARY KEY CHECK(tier IN ('portfolio_drawdown', 'kill_switch')),
  tripped     INTEGER NOT NULL,
  tripped_at  TEXT,
  reset_at    TEXT,
  reason      TEXT
);
```

Resolved: [Risk Manager: fix BreakerState persistence (crash-restart safety) (#203)](https://github.com/dd-jp/samurai-trading-system/issues/203) — closes the gap the 2026-07-26 cross-verify pass found (this consolidation had zero mention of "breaker" or "circuit" anywhere despite `risk-manager-spec.md` consuming `BreakerState` as an opaque `evaluate()` input with no stated writer). `tripped`/`tripped_at`/`reset_at`/`reason` mirror the four in-memory sticky fields `CircuitBreakers` already tracked (`hardTripped`, `hardTrippedAt`, `killSwitchEngaged`, `killSwitchReason`); the four stateless breakers (daily-loss, consecutive-loss, both volatility halts) are derived fresh from `PortfolioView` each call and never touch this table.

**Verdict** — owner: `docs/specs/verdict-spec.md`

```sql
-- One row per VerdictDecision, keyed by trace_id. Real-field companion to the
-- generic audit_log (which only holds digests/hashes) -- mirrors debate_log's
-- pattern of a stage-specific table alongside audit_log. Powers the dashboard's
-- getVerdictHistory, which audit_log's hash-only columns cannot answer.
-- no_go_detail_measured_ms/no_go_detail_bound_ms added by 0046_verdict_log_no_go_detail.sql (#1111):
-- what a no-go gate measured and the bound it broke, both nullable (NULL for `go`
-- and for gates that don't compare a number to a bound). Appended at the end,
-- matching ALTER TABLE ADD COLUMN's live physical order (PRAGMA table_info).
-- idx_verdict_log_timestamp predates all of that -- 0005_hot_path_indexes.sql,
-- one of this table's earliest migrations -- and had never been folded into
-- this block; #1251's verification pass found it (#1234 fixed this table's
-- columns but did not re-check its indexes).
CREATE TABLE verdict_log (
  trace_id                  TEXT PRIMARY KEY,
  idempotency_key           TEXT NOT NULL,
  instrument                TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK(status IN ('go', 'no_go')),
  no_go_reason              TEXT,
  hitl_override             INTEGER NOT NULL,
  timestamp                 TEXT NOT NULL,
  no_go_detail_measured_ms  REAL,
  no_go_detail_bound_ms     REAL
);
CREATE INDEX idx_verdict_log_timestamp ON verdict_log(timestamp);
```

Resolved: [Verdict: implement VerdictLogStore against the shared SQLite store (#206)](https://github.com/dd-jp/samurai-trading-system/issues/206), closing GAP-4 from the 2026-07-26 cross-verify pass ([docs/reviews/cross-verify-2026-07-26.md](../reviews/cross-verify-2026-07-26.md)) — `audit_log.output_digest` is a hash, not a queryable payload, so it cannot answer `VerdictAuditEntry.reason`/`.hitl_override`; `verdict_log` is Verdict's own real-field record, keyed by `trace_id` (the correlation ID threaded from the Orchestrator's tick) with `idempotency_key` retained as a non-PK column for cross-reference to `open_positions`/`fills`. `no_go_reason` is nullable (`null` on `go`); `hitl_override` is the dashboard-facing derived flag — true whenever `VerdictDecision.approval_path !== 'automated'` (a human path was actually taken, live or backtest-bypassed-but-recorded), not `would_require_approval` (which is also true on an automated-bypass backtest run where no override occurred).

**Correction ([#302](https://github.com/dd-jp/samurai-trading-system/issues/302), 2026-08-04):** #206 was closed as "implement `VerdictLogStore` against the shared SQLite store," but only the in-memory reference implementation (`InMemoryVerdictLogStore`) and the port existed — no SQLite-backed store was ever written, and nothing in `direct-bind.ts`'s production composition constructed either one. With no writer, `verdict_log` stayed permanently empty in every real run, so `OrphanVerdictScanner`'s crash-recovery query always reported zero orphans regardless of the truth. #302 adds `SqliteVerdictLogStore` (`server/pipeline/verdict/sqlite-verdict-log-store.ts`) and wires it into `buildVerdictStep` via the `LoggingVerdict` decorator that already called the port correctly. It upserts on `trace_id` with `ON CONFLICT(trace_id) DO NOTHING` rather than a bare `INSERT` — first-write-wins, because the row is Verdict's audit record and the original decision must survive untouched. `OrphanVerdictScanner` (`server/apps/orchestrator/orphan-verdict-scan.ts`) is the reason this matters at runtime: its crash-recovery scan depends on the original `go`/`no_go` row still being there, unaltered, to compare against `audit_log`. *(Corrected 2026-09-06, [#1169](https://github.com/dd-jp/samurai-trading-system/issues/1169): this entry previously said `DO UPDATE`, the semantics `sqlite-verdict-log-store.ts`'s doc comment explicitly considered and rejected — `DO UPDATE` would let a later write (e.g. a re-check landing differently the second time) silently replace an original `go` row with a `no_go` one, erasing exactly the evidence `OrphanVerdictScanner`'s scan exists to find at restart. `DO NOTHING` matches `VerdictLogStore`'s port doc (`server/shared/types/ports.ts`), which promises "Append-only: no update/delete, one row per trace_id".)*

**Orchestrator** — owner: `docs/specs/orchestrator-spec.md`

```sql
-- One row per stage-decision per trace_id. Append-only. Powers the dashboard read-only.
-- instrument/asset_class added by 0013 (dashboard filtering, matching debate_log's
-- own instrument column); idx_audit_log_timestamp added by 0025, for the dashboard's
-- time-windowed reads. Both folded in by #1251.
CREATE TABLE audit_log (
  trace_id       TEXT NOT NULL,
  stage          TEXT NOT NULL,
  decision       TEXT NOT NULL,
  input_digest   TEXT NOT NULL,
  output_digest  TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  instrument     TEXT,
  asset_class    TEXT
);
CREATE INDEX idx_audit_log_trace_id ON audit_log(trace_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);

-- Disposable, best-effort progress state -- NOT a system-of-record. Upserted per-instrument
-- before each stage call, deleted on tick completion. Losing it on crash costs nothing but a
-- stale progress indicator.
--
-- Migration 0029_current_tick_position_check.sql (#743, the tick/decision split) rebuilt this
-- table to add 'position_check' to the CHECK below -- SQLite cannot alter a CHECK in place, so
-- the table is dropped and recreated rather than migrated column-by-column.
CREATE TABLE current_tick (
  instrument    TEXT PRIMARY KEY,
  asset_class   TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  stage         TEXT NOT NULL CHECK(stage IN ('position_check', 'analysts', 'debate', 'trader', 'risk', 'verdict', 'execution')),
  trace_id      TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

**AccountStateProvider** — owner: `docs/specs/transport-layer-spec.md`

```sql
-- Durable account-level running state AccountStateProvider needs but Alpaca's
-- account API doesn't carry (no all-time high-water-mark field). Deliberately
-- NOT part of current_tick: that table is disposable, best-effort, and
-- deleted on tick completion (see comment above) -- a monotonic high-water
-- mark stored there would be silently wiped every tick, disabling the hard
-- portfolio-drawdown circuit breaker (risk-manager-spec.md) that peak_equity
-- feeds. Single durable row (key = 'default'), upserted every tick, never deleted.
CREATE TABLE account_state (
  key           TEXT PRIMARY KEY,
  peak_equity   REAL NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Per-asset-class session-open equity (transport-layer-spec.md, #332,
-- 0009_session_equity.sql) -- the denominator of risk-manager-spec.md's
-- session-scoped daily PnL. One row per class plus a portfolio-level row.
--
-- Deliberately NOT columns on account_state: that table is keyed
-- one-row-per-account around a NOT NULL peak_equity, so three per-class rows
-- would each need a dummy or nullable high-water mark, and a NULL denominator
-- reads as zero drawdown forever -- the exact crash-safety invariant
-- account_state exists to hold.
--
-- open_at is the SESSION START INSTANT, never the write time: the snapshot is
-- taken at the first tick after a boundary (historical cash is stored nowhere,
-- so the equity at the boundary itself cannot be reconstructed), and recording
-- the boundary keeps that drift visible rather than baking it in. ISO-8601 UTC,
-- matching closed_trades.closed_at -- the realized-PnL filter is a TEXT
-- `closed_at > open_at` comparison and depends on both sides being written the
-- same fixed-width, Z-suffixed way.
--
-- observed_at_boundary records whether the writing process was actually running
-- when the session opened, and is durable rather than in-process because a
-- restart cannot otherwise tell a real open from a mid-session sample: after a
-- restart the row's open_at already equals the current session start.
CREATE TABLE session_equity (
  asset_class          TEXT PRIMARY KEY CHECK(asset_class IN ('crypto', 'stocks', 'portfolio')),
  open_equity          REAL NOT NULL,
  open_at              TEXT NOT NULL,
  observed_at_boundary INTEGER NOT NULL CHECK(observed_at_boundary IN (0, 1))
);

-- Append-only daily equity series (feedback-loop-spec.md, #345,
-- 0011_daily_equity.sql) -- the evenly spaced periodic observations
-- computeMetrics derives a live ReturnSeries from. One row per PORTFOLIO
-- session, i.e. per UTC day.
--
-- Deliberately NOT session_equity above, which is the same boundary sampled
-- OVER ITSELF: that table is keyed asset_class PRIMARY KEY and upserts with
-- ON CONFLICT DO UPDATE, so it holds three rows and each boundary destroys the
-- previous session's open. Correct for the live daily-loss denominator, useless
-- as history. Widening it to a composite key would change what
-- SqliteSessionEquityStore.get(key) means for the breaker that trades real
-- money, so the series is a second table sampling the same boundary instead.
--
-- The PORTFOLIO boundary (00:00 UTC) is what makes the series admissible as a
-- ReturnSeries: consecutive UTC midnights are exactly 86,400,000 ms apart, so
-- periodsPerYear is 365 with no approximation. The stocks boundary (prior 16:00
-- ET close) skips weekends and holidays -- a Friday->Monday step is three days
-- wide -- and annualizing those as single periods is wrong by construction.
--
-- session_start is the boundary instant, never the sample time. ON CONFLICT DO
-- NOTHING, never DO UPDATE: equity is sampled on the first tick after the
-- boundary, so the first observation of a session is closest to the true open
-- and a later tick must not overwrite it. That is also what makes a restart
-- harmless -- the returning process finds the row and leaves it alone.
--
-- observed_at_boundary carries session_equity's honesty flag for the same
-- reason. Such rows are KEPT (the spacing is still exactly one day, and
-- dropping them would punch a hole in an otherwise usable run), but the flag
-- stays queryable so a suspicious return can be traced to a late sample.
CREATE TABLE daily_equity (
  session_start        TEXT PRIMARY KEY,
  equity               REAL NOT NULL,
  recorded_at          TEXT NOT NULL,
  observed_at_boundary INTEGER NOT NULL CHECK(observed_at_boundary IN (0, 1))
);
```

#### `invalidation_log` — does not exist, and never will (restated 2026-09-03)

Specced 2026-08-05 ([Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291)) as a standalone table for a standalone `invalidation` stage. David declined that stage 2026-09-02 (*"fold this to risk critic"*); [#994](https://github.com/dd-jp/samurai-trading-system/issues/994) folded the typed invalidation-condition mechanism into the Risk Critic instead, per `risk-manager-spec.md`'s "Module: Risk Critic — the invalidation fold" and `cross-spec-contracts.md` §8. This table, its `(instrument, bar_timestamp)` unique index, and its `evaluated`/`no_conditions`/`unavailable` status column are retired with the stage — none of it was ever built, and none of it is coming.

What exists instead: `risk_critic_log` (migration 0032) gains two **nullable** `TEXT` columns via migration 0040 —

```sql
ALTER TABLE risk_critic_log ADD COLUMN conditions_json TEXT NULL;
ALTER TABLE risk_critic_log ADD COLUMN dropped_conditions_json TEXT NULL;
```

`conditions_json` holds the persisted `EvaluatedCondition[]`, `dropped_conditions_json` the persisted `DroppedCondition[]` — both additive and optional, with **no backfill**: a row written before the fold, or one whose persisted list is unreadable, replays as an empty list reported `no_conditions`. Both columns are keyed by the same `debate_id` the rest of `risk_critic_log` already uses; there is no separate `(instrument, bar_timestamp)` coordinate and no `thesis_restated` column — the critic's verdict is already keyed by the debate it attacks, so a second, model-restated thesis has nothing to answer that the key doesn't already answer.

#### `llm_spend` (added retroactively 2026-08-06 — was in code since #367, never in this spec)

Owned by the Debate Engine (`server/pipeline/debate-engine/llm/spend-sink.ts` writes it; `spend-cap.ts` reads
it, and the dashboard sums it). It backs [ADR-0008](../adr/0008-llm-spend-cap.md)'s $50/14-day
cap, so it is money-critical despite being a telemetry table. Not part of the twenty-two/twenty-three-table
non-collision pass below — it postdates it, and its column names (`input_tokens`, `cost_usd`,
`latency_ms`) collide with nothing. Documented here late: the table
shipped in `0010_llm_spend.sql` and was extended by `0012_llm_spend_latency_debate_id.sql`, but
this consolidated schema never listed it — the gap this closes
(`docs/reviews/triage-2026-08-06.md` F-9).

`cost_usd` is deliberately nullable: NULL means "this model's price is unknown to us", which must
stay distinguishable from a real zero, or an uncosted model would silently read as free against
the cap. `timestamp` is ISO-8601 UTC TEXT like every other time column here — the dashboard's
window filter is a lexicographic TEXT comparison, correct only because every writer is
fixed-width, zero-padded and Z-suffixed.

```sql
CREATE TABLE llm_spend (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id                     TEXT    NOT NULL,
  stage                        TEXT    NOT NULL,
  model                        TEXT    NOT NULL,
  input_tokens                 INTEGER NOT NULL DEFAULT 0,
  output_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd                     REAL,              -- NULL = price unknown, NOT zero
  timestamp                    TEXT    NOT NULL,
  -- Added by 0012 (#326): per-call latency and per-debate attribution.
  latency_ms                   INTEGER,
  debate_id                    TEXT,
  -- Added by 0018 (#476): server-side tool calls, billed but token-invisible.
  server_tool_calls            INTEGER NOT NULL DEFAULT 0,
  -- Added by 0038: time-to-first-byte, a strict lower bound inside latency_ms's span.
  ttfb_ms                      INTEGER
);

-- The operator surface's only access pattern is "sum the last N hours/days" —
-- a range scan on `timestamp` alone.
CREATE INDEX idx_llm_spend_timestamp ON llm_spend(timestamp);
```

#### `risk_critic_log` (2026-09-01, [#957](https://github.com/dd-jp/samurai-trading-system/issues/957))

Owned by the Risk Manager (`server/pipeline/risk-manager/critic-store.ts` writes and reads it;
migration `0032_risk_critic_log.sql`). It is what makes [ADR-0003](../adr/0003-risk-manager-critic-layer.md) §2's
replay-from-log determinism real: `live`/`paper` persist the critic's verdict here, and a `backtest`
run READS this table instead of calling the model again — so a replay of the same history reaches
the same decision and Stage 2's PBO/DSR/MinBTL statistics stay valid.

Keyed on `debate_id`, the join key `debate_log` and `cosine_setups` already carry (#162) — one
debate produces at most one gated intent, so one verdict per debate is the grain, and the PK is
what makes a re-run idempotent instead of accumulating a second, possibly different, verdict for
one decision. Postdates the non-collision pass below; `verdict`, `max_notional` and `reasoning`
collide with nothing.

`verdict = 'unavailable'` is a real row rather than an absent one: the critic was consulted and
could not answer (provider failure, spend-cap refusal, unreadable response). `evaluate()` is still
handed NOTHING in that case, so the decision keeps its explicit `risk_critic: skipped` reason —
the row is for the operator, and so a replay sees the same "no verdict" input the live run had.

**Migration `0040` (added 2026-09-03 as part of #994's invalidation fold) adds two further nullable columns, inlined below.** They were originally disclosed only in a comment, on the reasoning that #1174's mandate was whole-table absence, not re-folding an already-declared table — but #1251, which re-folds exactly that class of already-declared-table drift, makes that reasoning expire: a comment-disclosed column here would be a standing, permanently-exempted hole in the class of drift `spec-schema-drift.test.ts` exists to close, and `verdict_log`'s own two 0046 columns were inlined by #1234 rather than commented, so this brings `risk_critic_log` to the same standard. See "`invalidation_log` — does not exist, and never will" above for the full account of what they hold and why there is no separate table.

```sql
CREATE TABLE risk_critic_log (
  debate_id                 TEXT NOT NULL PRIMARY KEY,
  verdict                   TEXT NOT NULL CHECK(verdict IN ('pass', 'trim', 'reject', 'unavailable')),
  -- Meaningful only for 'trim': the notional the critic argues this intent
  -- should be capped at. The pipeline can only ever use it to REDUCE size.
  max_notional              REAL NULL,
  reasoning                 TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  conditions_json           TEXT NULL,
  dropped_conditions_json   TEXT NULL
);

CREATE INDEX idx_risk_critic_log_created_at ON risk_critic_log(created_at);
```

#### `arm_comparison_samples` (2026-09-01, [#971](https://github.com/dd-jp/samurai-trading-system/issues/971))

Owned by the Feedback Loop (`server/pipeline/feedback-loop/sqlite-arm-comparison-sample-store.ts`;
migration `0034_arm_comparison_samples.sql`). One row per comparison cycle: the live arm and
falsifier arm 2 measured over the same window, plus the divergence verdict FL reached on it. The
Feedback Loop is the sole writer; the dashboard's service-api process is a reader only.

**Persisted rather than recomputed at read time** for three reasons. FL owns the computation
([#636](https://github.com/dd-jp/samurai-trading-system/issues/636)) and a second implementation in
the read path would be a second thing to keep matched. The reader is a *different process* over the
same store, so there is no in-memory result to share. And the panel shows a trend, which needs a
series — a recompute only ever yields "now".

**Both arms' `return_pct` and `max_drawdown_pct` are NOT NULL.** This is
`docs/research/12-edge-hypothesis-critique.md` D4 enforced in the schema: a row that carries a
return without the drawdown beside it cannot be written, so no reader can render a return-only
comparison even by accident. `divergence_reason` is nullable and is NULL exactly when
`diverged = 0`. Postdates the non-collision pass below; every column name here is new.

**`min_trades_per_arm` (migration `0035`, [#982](https://github.com/dd-jp/samurai-trading-system/issues/982)) is the per-arm closed-trade floor THIS row's verdict was actually tested against** — stored per row rather than read live off `MIN_TRADES_PER_ARM_FOR_DIVERGENCE`, the same choice `basis` already makes on this table and for the same reason: a row must stay interpretable against the policy value it was measured with even after that constant later changes. `ALTER TABLE ... ADD COLUMN ... DEFAULT 5` needed no rebuild, and `5` is not a placeholder for the backfilled rows — it is the only value the constant has held since this table was created in `0034`.

```sql
CREATE TABLE arm_comparison_samples (
  computed_at             TEXT PRIMARY KEY,
  window_from              TEXT NOT NULL,
  window_to                TEXT NOT NULL,
  basis                    REAL NOT NULL,

  live_trade_count         INTEGER NOT NULL,
  live_realized_pnl_net    REAL NOT NULL,
  live_return_pct          REAL NOT NULL,
  live_max_drawdown_pct    REAL NOT NULL,

  control_trade_count      INTEGER NOT NULL,
  control_realized_pnl_net REAL NOT NULL,
  control_return_pct       REAL NOT NULL,
  control_max_drawdown_pct REAL NOT NULL,

  diverged                 INTEGER NOT NULL CHECK(diverged IN (0, 1)),
  divergence_reason        TEXT,
  min_trades_per_arm       INTEGER NOT NULL DEFAULT 5,

  -- `divergence_reason` is non-NULL if and only if `diverged = 1` -- the same
  -- invariant `ArmDivergenceVerdict` documents and `evaluateArmDivergence`
  -- constructs, enforced at the schema layer since this table's creation (0034)
  -- rather than only asserted by readers. #1251 found this table-level CHECK
  -- had never made it into this block despite being part of `0034` from day one.
  CHECK (
    (diverged = 0 AND divergence_reason IS NULL) OR
    (diverged = 1 AND divergence_reason IS NOT NULL)
  )
);

CREATE INDEX idx_arm_comparison_samples_computed_at ON arm_comparison_samples(computed_at DESC);
```

#### `outside_benchmark_samples` (2026-09-01, [#981](https://github.com/dd-jp/samurai-trading-system/issues/981))

Owned by the Feedback Loop
(`server/pipeline/feedback-loop/sqlite-outside-benchmark-sample-store.ts`; migration
`0036_outside_benchmark_samples.sql`). One row per benchmark per comparison cycle: SPY and the
60/40 (SPY/AGG) blend measured over **the same window** `arm_comparison_samples` recorded for that
cycle. FL is the sole writer; service-api is a reader only.

**A separate table, not columns on `arm_comparison_samples`.** A benchmark has no trade count, no
realized PnL, no verdict and no arm tag, so folding it in would mean four nullable columns and, worse,
would make the outside benchmark render as a third arm — the exact "the thing to beat" reading
[#636](https://github.com/dd-jp/samurai-trading-system/issues/636) rules out. The benchmarks are
secondary context; the schema keeps them in their own table so a reader has to opt into them.

**`buy_and_hold_return_pct`, not `return_pct`.** The name differs from the arms' column on purpose:
the denominators differ. A benchmark is fully invested through every night; the book is flat by close
(ADR-0014), so its `return_pct` is realized PnL on capital at risk only while a trade is on. Two
columns with the same name would invite a `UNION` that is arithmetic nonsense.

**Both `buy_and_hold_return_pct` and `max_drawdown_pct` are NOT NULL** — doc 12 D4 in the schema, the
same rule `arm_comparison_samples` enforces. There is no way to write a return-only benchmark row.

**Primary key `(computed_at, benchmark)`**, because one cycle writes one row per benchmark. **An
absent row means the benchmark was not measured that cycle** — FL persists nothing when a leg's
series is unavailable rather than writing a zero, and the reason is in the log. A `CHECK` pins the
benchmark id to the settled set.

```sql
CREATE TABLE outside_benchmark_samples (
  computed_at             TEXT NOT NULL,
  benchmark               TEXT NOT NULL CHECK(benchmark IN ('spy', 'sixty_forty')),
  window_from             TEXT NOT NULL,
  window_to               TEXT NOT NULL,
  buy_and_hold_return_pct REAL NOT NULL,
  max_drawdown_pct        REAL NOT NULL,
  observation_count       INTEGER NOT NULL,
  PRIMARY KEY (computed_at, benchmark)
);

CREATE INDEX idx_outside_benchmark_samples_computed_at
  ON outside_benchmark_samples(computed_at DESC);
```

**(restated 2026-09-03 after #994's fold.)** The three paragraphs this replaces — retrieval by `(instrument, bar_timestamp)`, a `floorToBar` write-path requirement, and "raw emission over validated list" as the reason for that table's `conditions_json` shape — were design rationale for `invalidation_log`, the table declined along with the standalone stage (see "`invalidation_log` — does not exist, and never will" above). None of it applies to what replaced it: `risk_critic_log`'s `conditions_json`/`dropped_conditions_json` (migration 0040) are retrieved by the same `debate_id` every other column on that row already uses — no separate coordinate, and so no floor-to-bar-boundary write discipline to get right or wrong. The raw-vs-validated distinction is unchanged in substance (`conditions_json` still means the raw, tagged emission per `EvaluatedCondition`/`DroppedCondition`, not a post-validator-only list), it simply now lives on an existing row rather than a bespoke table.

**`current_tick.stage`'s `CHECK` carries seven names live, not six.** Migration `0029_current_tick_position_check.sql` (#743, the tick/decision split) rebuilt the table to add `'position_check'` — `CHECK(stage IN ('position_check', 'analysts', 'debate', 'trader', 'risk', 'verdict', 'execution'))` — for a reason unrelated to `invalidation`. The standalone `invalidation` stage was declined 2026-09-02 (its mechanism folds into the Risk Critic instead, [#994](https://github.com/dd-jp/samurai-trading-system/issues/994)), so the *separate* table-rebuild migration this entry previously anticipated — an eighth name, for `invalidation` — is never needed: SQLite cannot alter a `CHECK` in place, but there is no `invalidation` name to add it for. `audit_log.stage` is unconstrained `TEXT` and needs no migration either way. *(Corrected 2026-09-06, [#1168](https://github.com/dd-jp/samurai-trading-system/issues/1168): this entry previously said the CHECK "stays at the six original stage names," missing that migration 0029 landed 2026-08-17 — roughly two weeks before the 2026-09-02/03 restatements that got this wrong — and had already rebuilt it to seven for `position_check`, a change unrelated to `invalidation`. `cross-spec-contracts.md` CV-28 has this right.)*

#### `stage2_selected_config` (migration `0014`, [#375](https://github.com/dd-jp/samurai-trading-system/issues/375) / [#384](https://github.com/dd-jp/samurai-trading-system/issues/384)) — DDL added by [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174)

Owned by the Cost-Model/Backtest Harness (`backtest` in `write-guard.ts`'s `STAGE_OWNED_TABLES`), and already named there and in the "Integration with Pipeline" map above — this document simply never carried its `CREATE TABLE`, until now. The frozen Stage 2 selection: `live_backtest_divergence_over_max` compares the live Sharpe against the selected config's OWN backtest Sharpe, and the other three kill-lines (`pbo_over_max`, `oos_sharpe_under_min`, `dsr_insignificant`) all read `DailyMetricsSample.revalidation`, which nothing populated without a persisted Stage 2 run. One table closed both #375 and #384.

One row per (config, asset class, run) — never the latest selection as a mutable row. A Stage 2 re-run is evidence about a different sample; overwriting the previous verdict would destroy the audit trail the live-graduation decision rests on, so readers take the newest row by `selected_at` and history stays. `pbo`/`dsr` are nullable, and that is load-bearing — `renderStage2Verdict` returns typed refusals ("no CSCV pass was requested"), and a refusal is not a zero. No later migration touches this table.

```sql
CREATE TABLE stage2_selected_config (
  config_hash       TEXT    NOT NULL,   -- joins config_trials.config_hash
  asset_class       TEXT    NOT NULL CHECK (asset_class IN ('crypto', 'stocks')),
  selected_at       TEXT    NOT NULL,   -- ISO-8601 UTC; readers take the newest row for an asset class
  window_start      TEXT    NOT NULL,   -- the backtest sample's bounds; staleness is checked against this
  window_end        TEXT    NOT NULL,
  backtest_sharpe   REAL    NOT NULL,   -- the selected config's whole-sample annualized Sharpe
  oos_sharpe        REAL    NOT NULL,   -- mean of the walk-forward test-fold Sharpes
  fold_sharpes_json TEXT    NOT NULL,   -- JSON number[]: RevalidationSnapshot.walk_forward_sharpe_distribution
  pbo               REAL,               -- NULL = refused (see prose above), never a stored zero
  dsr               REAL,               -- NULL = refused, same reason
  n_trials          INTEGER NOT NULL,   -- distinct trials DSR was deflated by
  overall_pass      INTEGER NOT NULL CHECK (overall_pass IN (0, 1)),
  PRIMARY KEY (config_hash, asset_class, selected_at)
);

-- The only read pattern: newest selection for an asset class.
CREATE INDEX idx_stage2_selected_config_lookup
  ON stage2_selected_config (asset_class, selected_at DESC);
```

**Not part of the twenty-two/twenty-three-table non-collision pass; checked here.** `config_hash` deliberately shares its name AND value space with `config_trials.config_hash` — a join is the point, this row names one of the trials. `asset_class` matches the schema-wide `CHECK(... IN ('crypto', 'stocks'))` convention exactly. `window_start`/`window_end` name the same concept `arm_comparison_samples`/`outside_benchmark_samples` name `window_from`/`window_to` — a genuine, pre-existing naming inconsistency between three measurement tables, not introduced by this pass and not fixed here: renaming a live column is a code change, and this is a docs-only pass. Every other column here is new. No unintentional collision found.

#### `trader_log` and `risk_log` (migration `0016`, [#328](https://github.com/dd-jp/samurai-trading-system/issues/328)) — DDL added by [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174)

Owned by the Trader (`trader_log`) and Risk (`risk_log`) respectively, per `write-guard.ts`. `audit_log` is digest-only — it proves a stage ran and its I/O hashed to X, and cannot reconstruct a single value. These are the two stages' real-field companions, answering what `audit_log` alone cannot: which precedents moved conviction, what portfolio state Risk sized against, why a size came out at N rather than 2N, and why a tick stopped at `risk` instead of reaching Verdict. `trader_log` holds one row per Trader decision INCLUDING a decision not to trade — `TickOutcome.final_stage` records where a tick stopped and never why, and a skip is itself a decision. `risk_log` holds one row per Risk evaluation, including a rejection. Both keyed `(trace_id, instrument)`; both indexed on `created_at` for the dashboard's 15-minute pipeline window.

`trader_log` was amended twice after `0016`. Migration `0030` (#748) added `exit_reason`, distinguishing the flat-by-close flatten from an indicator-driven early release and from a debate-reversal exit — before it, all three landed identically as `intent_type = 'exit'`. Migration `0042` (#1109) added `decision_class` plus `reason_detail_compared_value`/`reason_detail_threshold`, classifying WHY a skip fired at the granularity an operator's next action needs (starvation vs. the system working as intended) and, on the four skip reasons that compare a value against a configured threshold, the compared value and the threshold itself.

`risk_log` was amended once. Migration `0028` (#726) widened `status`'s `CHECK` from `('approved', 'rejected')` to add `'error'` — the gate pipeline threw before a decision could be reached (a subclass with no deployment cap declared, for instance), distinguished from a decision that reached `'rejected'` cleanly by running the gates and declining. SQLite cannot alter a `CHECK` constraint in place, so `0028` rebuilds the table column-for-column; the DDL below is that rebuilt shape.

```sql
CREATE TABLE trader_log (
  trace_id                      TEXT    NOT NULL,
  instrument                    TEXT    NOT NULL,
  debate_id                     TEXT    NOT NULL,  -- joins debate_log; the debate's own content is not duplicated here
  intent_type                   TEXT,              -- 'entry' | 'scale_in' | 'exit', or NULL when decide() returned null
  skip_reason                   TEXT,              -- populated only on a skip
  base_risk_fraction            REAL,
  conviction_multiplier         REAL,
  vol_floor_factor              REAL,
  non_converged_haircut         REAL,
  cosine_multiplier             REAL,
  neighbor_count                INTEGER,
  weighted_mean_r               REAL,
  no_precedent                  INTEGER CHECK(no_precedent IN (0, 1)),
  atr                           REAL,
  entry                         REAL,
  stop                          REAL,
  size                          REAL,
  created_at                    TEXT    NOT NULL,
  exit_reason                   TEXT,   -- 0030 (#748): 'flatten' | 'signal_decay' | 'direction_flip'; NULL pre-migration and on non-exit rows
  decision_class                TEXT,   -- 0042 (#1109): TraderDecisionClass's string value; no CHECK (see migration doc)
  reason_detail_compared_value  REAL,   -- 0042: populated with reason_detail_threshold on the four threshold-comparison skip reasons only
  reason_detail_threshold       REAL,
  PRIMARY KEY (trace_id, instrument)
);

CREATE TABLE risk_log (
  trace_id            TEXT    NOT NULL,
  instrument          TEXT    NOT NULL,
  status              TEXT    NOT NULL CHECK(status IN ('approved', 'rejected', 'error')),  -- 'error' added by 0028 (#726)
  binding_constraint  TEXT,
  reasons_json        TEXT    NOT NULL,
  original_size       REAL,
  final_size          REAL,
  stop_tightened      INTEGER NOT NULL CHECK(stop_tightened IN (0, 1)),
  portfolio_tripped   INTEGER NOT NULL CHECK(portfolio_tripped IN (0, 1)),
  crypto_tripped      INTEGER NOT NULL CHECK(crypto_tripped IN (0, 1)),
  stocks_tripped      INTEGER NOT NULL CHECK(stocks_tripped IN (0, 1)),
  armed_breakers_json TEXT    NOT NULL,
  equity              REAL    NOT NULL,
  drawdown_pct        REAL    NOT NULL,
  gross_exposure      REAL    NOT NULL,
  consecutive_losses  INTEGER NOT NULL,
  daily_pnl_portfolio_pct  REAL,
  daily_pnl_crypto_pct     REAL,
  daily_pnl_stocks_pct     REAL,
  daily_pnl_unknown_reason TEXT,
  created_at          TEXT    NOT NULL,
  PRIMARY KEY (trace_id, instrument)
);

CREATE INDEX idx_trader_log_created_at ON trader_log(created_at);
CREATE INDEX idx_risk_log_created_at ON risk_log(created_at);
```

**Not part of the twenty-two/twenty-three-table non-collision pass; checked here.** `trace_id`/`instrument`/`debate_id` reuse the schema-wide conventions already established elsewhere (consistent `TEXT` correlation keys, no divergence). Three real near-misses, all deliberate rather than accidental:
- **`intent_type`** — `open_positions.intent_type` is `CHECK(... IN ('entry', 'scale_in'))`; `trader_log.intent_type` is a superset (adds `'exit'`, and is nullable for a skip) with no `CHECK` enforcing it in SQL. Same name, deliberately wider domain: `trader_log` records the stage's decision including its refusals, `open_positions` only ever holds a lot that actually opened.
- **`entry`/`stop`/`size`** — bare names reused across `trader_log` (the priced inputs the Trader computed at decision time), `open_positions`/`closed_trades` (`stop`, the live/frozen protective level; `entry`, the realized average), `broker_brackets` (`size`, the requested venue quantity) and `flatten_submissions` (`size`, the flatten's own order size). Each is the same *kind* of value at a different point in one lot's lifecycle; none of these tables is ever joined by `entry`/`stop`/`size` alone — every real join in this schema goes through `trace_id`/`debate_id`/`idempotency_key`.
- **`status`** — `risk_log.status` (`'approved'|'rejected'|'error'`), `flatten_submissions.status` (`'submitting'|'submitted'|'error'`) and `verdict_log.status` (`'go'|'no_go'`) share the literal `'error'` between the first two by coincidence, not by shared meaning: `risk_log`'s means a gate pipeline threw before evaluating; `flatten_submissions`'s means the flatten provably never reached the broker. Consistent with this spec's own "every table's own consumer dictates its key" principle, extended here to status vocabularies.

No other field-level collisions found for either table.

#### `flatten_submissions` (migration `0019`, [#508](https://github.com/dd-jp/samurai-trading-system/issues/508) review / PR #516) — DDL added by [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174)

Owned by Execution — the durable write-ahead journal for `execute()`'s exit path. An exit intent never wrote a row to `open_positions` (`OpenPosition.intent_type` deliberately excludes `'exit'` — "exits close a lot; they never create one"), so a replayed flatten had nothing to dedupe against and a lost `submitFlatten` response left no durable trace for reconcile to resolve. `'submitting' -> 'submitted' | 'error'`, mirroring `broker_brackets.phase` and `open_positions.order_state`'s own pending-to-submitted transition. No bracket-shaped columns: a flatten is a plain market order.

Amended six times after `0019`. Migration `0020` (#517) added `lot_idempotency_keys`, the originating lot(s)' identity, written at submit time so `ingestFills()` can attribute a fill back to the lot it closed instead of inferring it after the fact. Migration `0021` (#571) added `lot_held_quantities`, positionally parallel to the keys, so a partial flatten's fill splits by what each lot actually held rather than by what its entry once filled. Migration `0023` (#519/#526) added `fills_swept_at`, the durable "done" signal that bounds `reconcile()`'s sweep to genuinely in-flight rows instead of every flatten this database has ever recorded. Migration `0031` (#793) added `exit_reason`, threading the same three named reasons (`ExitReason`: `'flatten' | 'signal_decay' | 'direction_flip'`) that `trader_log.exit_reason` and `fills.exit_reason` also carry. Migration `0037` (#1001) added `decision_price`/`quote_bid`/`quote_ask`/`quote_mid`/`quote_observed_at`/`modelled_cost_breakdown_json` — the SAME six columns added to `open_positions` by the same migration, so a real-broker fill's realised half-spread and slippage can be computed on the exit leg exactly as on the entry leg. Migration `0050` (#1124) added `arm` (same domain and default as `open_positions.arm`/`closed_trades.arm`) plus `idx_flatten_submissions_arm`, closing a cross-arm leak where a flatten's own arm had to be inferred rather than read.

```sql
CREATE TABLE flatten_submissions (
  idempotency_key               TEXT PRIMARY KEY,
  instrument                    TEXT NOT NULL,
  asset_class                   TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side                          TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  size                          REAL NOT NULL,
  status                        TEXT NOT NULL CHECK(status IN ('submitting', 'submitted', 'error')),
  order_state                   TEXT,     -- set once the broker acks; NULL while 'submitting'
  broker_order_ids              TEXT,     -- JSON string[]; NULL while 'submitting'
  reason                        TEXT,     -- set on 'error'
  submitted_at                  TEXT NOT NULL,   -- write-ahead time
  resolved_at                   TEXT,            -- set on transition to 'submitted' or 'error'
  lot_idempotency_keys          TEXT,  -- 0020 (#517): JSON string[] of open_positions.idempotency_key, in opened_at order
  lot_held_quantities           TEXT,  -- 0021 (#571): JSON number[], positionally parallel to lot_idempotency_keys
  fills_swept_at                TEXT,  -- 0023 (#519/#526): set once every named lot's fill share has durably applied
  exit_reason                   TEXT,  -- 0031 (#793): 'flatten' | 'signal_decay' | 'direction_flip'
  decision_price                REAL, -- 0037 (#1001): the Trader's decision-time price -- see open_positions' own column
  quote_bid                     REAL, -- 0037: NULL together with quote_ask on any source without fetchQuote
  quote_ask                     REAL, -- 0037
  quote_mid                     REAL, -- 0037: (quote_bid + quote_ask) / 2, NULL iff the pair is
  quote_observed_at             TEXT, -- 0037: the quote's own timestamp
  modelled_cost_breakdown_json  TEXT, -- 0037: JSON {spread_cost, commission, slippage, market_impact}
  arm                           TEXT NOT NULL DEFAULT 'live' CHECK(arm IN ('live', 'control'))  -- 0050 (#1124)
);
CREATE INDEX idx_flatten_submissions_instrument ON flatten_submissions(instrument);
CREATE INDEX idx_flatten_submissions_arm ON flatten_submissions(arm, status);
```

**Not part of the twenty-two/twenty-three-table non-collision pass; checked here.** `instrument`/`asset_class`/`side` match this schema's established conventions exactly. `idempotency_key` as this table's own `PRIMARY KEY` uses the same type (`TEXT`) as every other appearance of that name, but is a fresh key space — a flatten submission's own idempotency key, never `open_positions.idempotency_key` (that identity is instead carried inside `lot_idempotency_keys`). `order_state`/`broker_order_ids` share their names and value spaces with `open_positions`' columns of the same name by design (`0019`'s own doc: "mirroring... `execute()`'s own pending -> submitted transition"); nullable here only because this row is written before the broker ack, where `open_positions`' equivalent is not. `decision_price`/`quote_bid`/`quote_ask`/`quote_mid`/`quote_observed_at`/`modelled_cost_breakdown_json` are the identical six columns `open_positions` carries, added by the same migration on purpose (`0037`'s own doc: "six columns, added to BOTH ... the parallel write-aheads"). `exit_reason` is the same three-value domain `trader_log.exit_reason` and `fills.exit_reason` carry, threaded deliberately (`0031`'s own doc). No unintentional divergence found.

#### `llm_call_log` (migration `0039`, [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)) — DDL added by [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174)

Owned by the Debate Engine. What was actually asked of an LLM, and what actually came back — `llm_spend` carries every fact ABOUT a call (model, tokens, cost, latency) but not its content, and `debate_log` carries the synthesized outcome, not any single call's text. A separate table because two hot readers (`SqliteSpendCap`'s all-time trading-path sum over `llm_spend`, the dashboard's range-scan of it) read that table for numbers and never for text, and multi-KB TEXT columns inline into the row and would balloon that b-tree for reads that select none of it. Pruned by a row ceiling (`DEFAULT_MAX_LLM_CALL_ROWS`, `prune-llm-call-log.ts`, #1045) rather than a time window, since disk is the resource actually at risk and the call rate is cadence-bound while a row ceiling is not. `spend_id` carries no `FOREIGN KEY` on purpose — `llm_spend`'s own write already swallows its failures by design, and a real FK would turn one swallowed metering failure into a cascading one that also loses the text. No later migration touches this table.

```sql
CREATE TABLE llm_call_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  spend_id   INTEGER,          -- llm_spend.id; never NULL from today's writer, nullable for a future text-only writer
  trace_id   TEXT    NOT NULL, -- joins to the tick, and to every log line for it
  stage      TEXT    NOT NULL, -- 'debate' | 'risk_critic' | 'sentiment'
  debate_id  TEXT,             -- joins debate_log; NULL outside a debate
  model      TEXT    NOT NULL, -- the SERVED model, matching llm_spend.model
  prompt     TEXT,
  response   TEXT,
  timestamp  TEXT    NOT NULL
);

CREATE INDEX idx_llm_call_log_timestamp ON llm_call_log(timestamp);
CREATE INDEX idx_llm_call_log_trace ON llm_call_log(trace_id);
```

**Not part of the twenty-two/twenty-three-table non-collision pass; checked here.** One genuine divergence, and it is a design choice rather than a bug: **`stage`** here is `'debate' | 'risk_critic' | 'sentiment'` — an LLM-calling context — while `audit_log.stage`/`current_tick.stage` use the disjoint `PIPELINE_STAGES` vocabulary (`'position_check' | 'analysts' | ... | 'execution'`). Same column name, two unrelated enumerations, each dictated by its own table's consumer; `audit_log.stage` is unconstrained `TEXT` so nothing in SQL enforces either vocabulary against the other. `llm_spend.stage` carries the SAME LLM-context vocabulary as this table's `stage`, consistently. `model`/`debate_id`/`trace_id`/`timestamp` all match `llm_spend`'s own columns of the same name by design (the migration's own doc: "matching `llm_spend.model`"). No unintentional divergence found.

#### `alert_delivery_failures` (migration `0043`, [#1108](https://github.com/dd-jp/samurai-trading-system/issues/1108)) — DDL added by [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174)

Owned by the Orchestrator. This table appeared nowhere in this document before now — not even in the "Integration with Pipeline" map, which the four-table version of this gap (F-9's own class) had at least done. One row per Telegram send that exhausted `TelegramBotApiClient`'s retry policy (`DEFAULT_RETRY`, 3 attempts) — not one row per attempt, and not a send that eventually succeeded on retry. `body`/`error` are masked and capped by `sanitizeLogText` (mask-then-cap, `MAX_ERROR_BODY_CHARS` = 500 — the same bound an HTTP error body gets) so the identifying content survives without the table holding an unbounded or credential-carrying blob. No PK, like `audit_log`: nothing here is looked up by row identity, only counted. No later migration touches this table.

Age-bounded since [#1131](https://github.com/dd-jp/samurai-trading-system/issues/1131), which is also when the Rail's alert-channel tile stopped counting this table all-time: `SqliteAlertDeliveryLog.pruneOlderThan` deletes rows strictly older than `SAMURAI_ALERT_DELIVERY_FAILURE_RETENTION_DAYS` (default 30) at boot and again on the daily feedback timer, through the orchestrator write guard. Age-based rather than the row ceiling `llm_call_log` gets, for the reason the DDL above already implies: with no `id`/PK there is no offset-based delete to hang a ceiling on, and this table's growth tracks outage frequency rather than a tick cadence. The retention floor is **2 days, not 1** — refused at startup below that — because 1 day is exactly the tile's trailing count window, and retention has to outlive the window it backstops or the raw table answers nothing the tile does not already show. `server/apps/orchestrator/production.ts`'s `alertDeliveryFailureRetentionDaysFromEnvironment` carries the full argument.

```sql
CREATE TABLE alert_delivery_failures (
  chat_id   TEXT NOT NULL,
  method    TEXT NOT NULL,
  body      TEXT NOT NULL,
  error     TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX idx_alert_delivery_failures_timestamp ON alert_delivery_failures(timestamp);
```

**Not part of the twenty-two/twenty-three-table non-collision pass; checked here.** `timestamp` matches the generic ISO-8601 UTC event-time convention already used by `fills`/`broker_observed_fills`/`llm_spend`/`llm_call_log` (and, under the name `captured_at`, `cii_snapshots`) — never a join key, no divergence. `chat_id`/`method`/`body`/`error` are new names found nowhere else. No collision found.

#### `feedback_cycle_schedule` (migration `0044`, [#1110](https://github.com/dd-jp/samurai-trading-system/issues/1110)) — DDL added by [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174)

Owned by the Feedback Loop (`feedback-loop` in `write-guard.ts`) even though the table exists to serve `production.ts`'s `scheduleFeedbackCycle`. Like `alert_delivery_failures`, this table appeared nowhere in this document before now, including the "Integration with Pipeline" map. The daily feedback cycle's restart-durable schedule: one column, `last_boundary`, holds the most recently completed WALL-CLOCK boundary rather than a raw "last ran at" timestamp, so "did today's cycle already happen" is a single inequality across any number of restarts, and catch-up after a gap is capped at exactly one cycle regardless of how many boundaries were missed. Two durable rows (`key = 'default'` / `'attempt'`) use the same free-form-TEXT-PK, upsert-forever shape `account_state` (migration `0006`) already uses for the same reason — a schedule that never has more than a handful of instances does not need an invented identity. `key = 'attempt'` was added within the same migration's "pass-2 fix", stamping the boundary about to run BEFORE `runFeedbackCycle` executes, so a restart before a cycle starts is distinguishable from one landing after the attempt was stamped. No later migration touches this table.

```sql
CREATE TABLE feedback_cycle_schedule (
  key           TEXT PRIMARY KEY,
  last_boundary TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

**Not part of the twenty-two/twenty-three-table non-collision pass; checked here.** `key` as a single/few-row literal-valued `PRIMARY KEY` is the same pattern `account_state.key` already uses, explicitly modelled on it per the migration's own doc — a deliberate shared idiom, not a collision. `last_boundary` is a new name found nowhere else. `updated_at` matches the generic last-modified-timestamp convention already shared by `account_state`/`analyst_weights`/`strategy_params`/`risk_thresholds`/`broker_brackets`. No divergence found.

#### `llm_spend_cap` (migration `0047`, [#1140](https://github.com/dd-jp/samurai-trading-system/issues/1140)) — DDL added by [#1174](https://github.com/dd-jp/samurai-trading-system/issues/1174)

Owned by the Orchestrator — the composition root arms it at boot with the LLM spend ceiling actually enforced, and the dashboard reads this row so its meter measures against that cap rather than a copy of the number. One row, rewritten at every boot; `budget_usd` NULL records an uncapped run. No later migration touches this table.

```sql
CREATE TABLE llm_spend_cap (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  budget_usd  REAL,
  armed_at    TEXT NOT NULL
);
```

**Not part of the twenty-two/twenty-three-table non-collision pass; checked here.** `id INTEGER PRIMARY KEY CHECK (id = 1)` is a single-row idiom distinct from `account_state`/`feedback_cycle_schedule`'s literal-TEXT-key idiom for the same "a handful of rows, forever" problem — a real but harmless stylistic divergence between two tables solving the same problem two different ways; neither is ever joined to the other, so it costs nothing. `budget_usd`/`armed_at` are new names found nowhere else. No divergence found.

### Non-Collision Verification

`cross-spec-contracts.md`'s "shared-store table non-collision" spot-check was clean at the table-name level; re-verified here at the field level across the original twenty-two tables above (a recount against today's schema gives twenty-three for that same batch — see the count discussion above; the field-level pass below was not re-run against the recount, only against the batch as it stood at the time):

- **`latest_mark` was missing `asset_class`** (#183) — the `Mark` interface (market-data-service-spec.md) declares it, the original persistence bullet dropped it. **Fixed above**, not silently — this DDL is the first place the full column list was ever written out, so there was no prior "wrong" schema to correct, only an incomplete prose description.
- **`Fill` vs. the cost model's result type** — already resolved pre-existing (GAP-F renamed the cost model's return type to `CostModelResult` specifically to avoid colliding with the persisted `fills` table; `cross-spec-contracts.md` confirms this explicitly).
- **`debate_id` type/semantics** — a deterministic hash string, consistent everywhere it's reused as a join key: `open_positions.debate_id`, `closed_trades.debate_id`, `cosine_setups.debate_id` (PK here), and `debate_log.debate_id` (PK there) are all `TEXT`, all populated from the same Debate Engine-issued hash (debate-engine-spec.md / trader-spec.md). No divergence.
- **`idempotency_key` type/semantics** — `TEXT` everywhere it appears (`open_positions` PK, `fills` composite PK component, `closed_trades` PK, `cosine_setups` non-unique column, `verdict_log` non-unique column). `cosine_setups` and `verdict_log` are the two tables where it is deliberately **not** the primary key — see the notes under each table — which is a real asymmetry with `open_positions`/`closed_trades` but not a collision: each table's key is dictated by its own write pattern (one `cosine_setups` row per *debate*, one `verdict_log` row per *decision*, keyed on `trace_id` since that's the correlation ID Verdict actually receives, one `open_positions`/`closed_trades` row per *decision lifecycle*), matching this spec's "every table's own consumer dictates its key" principle.
- **`asset_class` type/semantics** — the `CHECK(asset_class IN ('crypto', 'stocks'))` constraint and column name are identical across all five tables that carry it (`latest_mark`, `open_positions`, `closed_trades`, `cosine_setups`, `current_tick`). No divergence.
- **`breaker_state`** (#203) — `tier` is its own PK, disjoint from every other table's `debate_id`/`trace_id`/`idempotency_key` keying convention. `tripped_at`/`reset_at` are nullable `TEXT` timestamps (null while never-tripped/still-tripped respectively) — no other table has a comparable nullable-timestamp pair to collide with. No divergence.
- **`dial_adjustments` was missing `reason`** (#197) — `Adjustment.reason` (feedback-loop-spec.md's "Module: Guardrailed Tuning") was already a required field consumed by `daily-cycle.ts`/`metrics.ts`; the original DDL bullet dropped it, the same class of gap as `latest_mark`/`asset_class` above. **Fixed above**, plus a real migration (`0002_dial_adjustments_reason.sql`, `ALTER TABLE ... ADD COLUMN reason TEXT NOT NULL DEFAULT ''`) since `0001_init.sql` had already shipped without it.
- **`cii_snapshots`** (#182) — `country_code` is a plain `TEXT` code (WorldMonitor country codes, e.g. `'RU'`), disjoint from every other table's keying convention; not the same value space as `asset_class`'s `crypto`/`stocks` enum despite both being country/market-adjacent classifiers. `(country_code, captured_at)` composite PK is the append-only-history pattern already used by `bars`' `(instrument, timeframe, open_time)`. No divergence.
- **`account_state`** (transport-layer-spec.md, 2026-07-31) — `key` is its own single-row PK (`'default'`), disjoint from every other table's keying convention; no other table carries a bare running-max scalar like `peak_equity`. No divergence.
- **`session_equity`** (transport-layer-spec.md, #332) — `asset_class` as a PK is unique to this table; every other `asset_class` column is a non-key attribute (`closed_trades`, `open_positions`, `latest_mark`) and carries the same `'crypto'`/`'stocks'` domain, widened here by a third `'portfolio'` member that exists nowhere else. `open_equity`/`open_at`/`observed_at_boundary` appear in no other table. No divergence.
- **`daily_equity`** (feedback-loop-spec.md, #345) — one deliberate near-miss with `session_equity` directly above, resolved by keying rather than left to be inferred. Both carry an equity figure anchored to a `TradingCalendar.sessionStart` boundary, and `observed_at_boundary` is intentionally the *same* name with the *same* meaning in both (it answers the identical question: was the writing process running when this session opened). What differs is the key and the write mode: `session_equity` is keyed `asset_class` and upserts `DO UPDATE`, holding only the session in force; `daily_equity` is keyed `session_start` and appends `DO NOTHING`, holding every session forever. `equity`/`recorded_at`/`session_start` appear in no other table — note `session_start` is a column here and a *method* on `TradingCalendar`, not a column anywhere else, and `recorded_at` is distinct from `session_equity`'s `open_at` precisely because this table stores both the anchor and the sample time rather than folding them together. No divergence.
- **`broker_brackets` / `broker_observed_fills`** (#287, 2026-08-04) — three deliberate near-misses, all resolved by naming rather than left to be inferred:
  - **`client_order_id` vs `idempotency_key`** — the same VALUE (`NativeBracketRequest.client_order_id` is set from the OrderIntent's idempotency key), a different NAME. These two tables are written from below the `SharedStore` seam, where the concept is the broker-native idempotency handle rather than the pipeline's decision key — the same distinction `NormalizedFill.client_order_id` already draws in code. Renaming it `idempotency_key` here would imply the adapter knows about a pipeline concept it deliberately does not.
  - **`entry_price`/`stop_price`/`target_price` vs `open_positions.avg_entry_price`/`stop`/`target`** — named APART on purpose, because they mean different things: these are the prices the bracket was REQUESTED at and never change, whereas `open_positions.stop`/`target` are the live protective levels that get resized on partial fill. Reusing `stop`/`target` would invite exactly the wrong join.
  - **`broker_observed_fills` vs `fills`** — same grain (one row per observed fill) but different owner and different lifetime: `fills` is the append-only system-of-record written by `ingestFills()` above the seam, `broker_observed_fills` is one adapter's undrained queue below it. The PK shape is deliberately parallel (`(venue, client_order_id, broker_fill_id)` against `(idempotency_key, broker_fill_id)`), with `venue` prefixed for the same reason it is in `broker_brackets`'.
  - `venue`, `phase`, `arm_attempt`, `armed_qty` and `arming_qty` appear in no other table. `asset_class`/`side`/`leg` carry the identical CHECK constraints as everywhere else, minus the `IS NULL OR` relaxation the nullable request columns require. No divergence.
- **`broker_unpriced_fills`** ([#298](https://github.com/dd-jp/samurai-trading-system/issues/298), 2026-08-04) — shares `venue`/`client_order_id`/`broker_fill_id`/`leg`/`qty` with `broker_observed_fills` by design (same venue vocabulary, same PK shape, same reason for the `venue` prefix), and is deliberately NOT that table: the two hold opposite facts about a fill. `broker_observed_fills` is a queue of PRICED fills waiting to be drained (`price` NOT NULL); this is the record of fills that could not be priced at all, so it carries no `price` column to fabricate one into. `instrument` is denormalized rather than joined because the alert built from a row must be actionable standalone; it means the same thing as `open_positions.instrument`, with the same value space. `first_seen_at`/`last_seen_at`/`alerted_at` appear in no other table — they are an escalation clock, not a market or lot timestamp, and are named apart from `timestamp`/`opened_at`/`closed_at` for that reason. No divergence.
- No other field-level collisions found.

## Testing Decisions

### What Makes a Good Test

- Test the migration runner: applying migrations to an empty `:memory:` DB produces the exact schema above; re-applying is a no-op; `schema_migrations` reflects applied versions.
- Test `openSharedStore`: returns a handle backed by the given path; runs pending migrations; WAL mode and `synchronous=FULL` are set on the connection.
- Test each table's constraints directly (e.g. `open_positions.asset_class` CHECK rejects an invalid value; `config_trials` upsert-on-conflict overwrites `result_json`; `dial_adjustments.status` transitions correctly; `cosine_setups.debate_id` PK rejects a duplicate write for the same debate).
- Test that this document's own DDL matches the real schema, mechanically (#1251) — `server/shared/store/spec-schema-drift.test.ts` builds a `:memory:` DB from this document's fenced `CREATE TABLE`/`CREATE INDEX` blocks and a second from the real migration chain, then diffs every table's columns, indexes, and normalized `CREATE TABLE` text (which catches CHECK-constraint drift the other two can't see) in both directions — every table except SQLite's own implicit `sqlite_sequence` AUTOINCREMENT bookkeeping, which neither DB build declares and so is excluded rather than diffed. `CONSOLIDATED_SCHEMA_TABLE_COUNT` in `open-shared-store.test.ts` (above) only ever checked that every table is *named*; this checks that its DDL is *current*.
- No LLM to mock — this is pure schema/migration/connection-config testing.

### Modules to Test

**Migrations** — fresh-DB apply, idempotent re-apply, version tracking.

**Driver/Connection Config** — WAL mode, `synchronous=FULL`, one file per environment (paper/live never share a path).

**Schema Constraints** — CHECK constraints on enums (`asset_class`, `side`, `intent_type`, `close_reason`, `dial_type`, `status`), PK uniqueness, upsert semantics on `config_trials`, nullable-pair semantics on `cosine_setups` (`r_multiple`/`closed_at` set together, never independently).

### Prior Art

- No implementation yet. This spec's tables are each already covered by their owning spec's own testing section (e.g. `open_positions`/`fills`/`closed_trades` behavior is tested at the Execution seam, not here) — this spec's own tests are schema/migration/connection-level only, not business-logic tests, which belong to the owning spec.

## Out of Scope

**Market Intelligence's replay store** — confirmed a separate SQLite file (90-day auto-purge policy incompatible with this store's permanent-retention requirement — CLAUDE.md: track everything for HMRC/CGT). Not part of this spec. The purge itself is implemented in `server/providers/market-intelligence/archive/mi-archive-store.ts` and wired at the orchestrator composition root, not here — see `docs/specs/market-intelligence-spec.md`'s "Retention" section and [#1060](https://github.com/dd-jp/samurai-trading-system/issues/1060).

**Per-component cutover order/sequencing** — deferred to `/to-tickets`, not a spec-content decision.

**The Orchestrator's live composition root** — where `openSharedStore` actually gets called at boot is separate, not-yet-charted "paper trading launch" work; this spec only promises an injectable `SharedStore` handle for it to consume later.

**Business logic of any owning stage** — this spec defines tables and the store's own infrastructure (driver, migrations, crash-safety, wiring). It does not redefine what Execution, the Trader, Risk, the Feedback Loop, the Debate Engine, or the Orchestrator do with their own tables — each remains that spec's concern.

## Further Notes

### Integration with Pipeline

```
Market Data Service → bars, latest_mark
Execution           → open_positions, fills, closed_trades  (sole writer)
                      flatten_submissions, broker_brackets,
                      broker_observed_fills, broker_unpriced_fills
Cost-Model/Backtest → config_trials, stage2_selected_config
Feedback Loop       → analyst_weights, strategy_params, risk_thresholds, dial_adjustments,
                      arm_comparison_samples, outside_benchmark_samples,
                      feedback_cycle_schedule,
                      cosine_setups (labels only; Trader writes)
Trader              → cosine_setups (writes; FL labels), trader_log
Risk                → breaker_state, risk_log, risk_critic_log
Debate Engine       → debate_log, llm_spend, llm_call_log
Verdict             → verdict_log
Orchestrator        → audit_log, current_tick, daily_equity, llm_spend_cap, alert_delivery_failures
Transport Layer     → account_state (AccountStateProvider, peak_equity)
Transport Layer     → session_equity (AccountStateProvider, per-class daily PnL basis)
service-api         → (nothing — reader only)
control-arm         → (nothing — reader only; its comparison source reads both arms)
```

Every stage above reads/writes through the one `SharedStore` handle from `openSharedStore(dbPath)`, injected at each stage's construction.

**The ownership above is asserted in debug builds, not left to convention ([#837](https://github.com/dd-jp/samurai-trading-system/issues/837) M9, 2026-09-03).** `server/shared/store/write-guard.ts` holds the machine-readable copy of this map (`STAGE_OWNED_TABLES`) and `guardedStore(db, stage)` returns a handle that throws when a statement writes a table the stage does not own. Five properties define its scope, and each is deliberate:

- **Per-owning-stage, not per-table** — matching how cross-spec-contracts.md §4 states the guarantee.
- **Debug/test only** — `isStoreWriteGuardEnabled` is a pure predicate that answers `false` under `NODE_ENV=production` and for `SAMURAI_MODE=live`, so the live-money path pays nothing and cannot be taken down by the guard's own SQL parsing. `SAMURAI_STORE_GUARD=off` disables it anywhere and `=on` re-enables it under a `NODE_ENV=production` build — but `on` deliberately does NOT beat `SAMURAI_MODE=live`, because a stray variable must not put the guard's parser on the live order path.
- **Default permissive** — an undeclared handle (the raw `SharedStore`) behaves exactly as before, so wiring is incremental and a missed construction site loses detection there rather than breaking it.
- **Fails open** — a statement whose write target cannot be parsed is allowed; reads are never inspected.
- **DML only** — `INSERT`/`REPLACE`/`UPDATE`/`DELETE` are scanned; `CREATE`/`DROP`/`ALTER` are not, so even a declared-empty reader handle could still alter the schema through `exec()`. Out of scope by construction (migrations run on the raw handle before any guarding) and left that way on purpose: widening the scan widens the false-positive surface that would fail an orchestrator boot.

The stage names are the store class's **owning directory**, not the caller: one instance can legitimately serve two stages (`SqliteSetupStore` is constructed once and handed to both the Trader, which writes `cosine_setups`, and Execution's trade-close hookup, which labels them), and the declaration lives on the handle. `account_state`/`session_equity` are the Transport Layer's tables above but their stores live under `apps/orchestrator/` and are built in the orchestrator's composition root, so the guard declares them `orchestrator`. `schema_migrations` (written by the migration runner before any handle is guarded) and `cii_snapshots` (no writer in code yet) are unowned and therefore unguarded.

### Domain Glossary Alignment

Per CONTEXT.md's Shared State Store entry: this spec is that store, made concrete. No new glossary terms — `analyst_weights`/`strategy_params`/`risk_thresholds`/`dial_adjustments`/`cosine_setups`/`config_trials` are all named after their owning spec's existing vocabulary (`SetupVector`, `DailyCycleResult`, `BacktestReport`), not invented here.

### Future Extensions

- A separate SQLite file for the bar cache if write contention appears against the crash-critical `open_positions` table (the documented scale valve in market-data-service-spec.md — not adopted in v1).
- Cross-cycle trend-detection state for the Market Intelligence convergence engine (ADR-0002) will need its own table once designed — not part of this spec, since that design doesn't exist yet.

## Resolved Decisions (Sources)

Wayfinder decisions for this stage live on the [Shared SQLite Store map (#162)](https://github.com/dd-jp/samurai-trading-system/issues/162). Decisions synthesized here:

- **Driver** — better-sqlite3 ([#163](https://github.com/dd-jp/samurai-trading-system/issues/163)).
- **Migrations** — hand-rolled numbered SQL files + `schema_migrations` runner table ([#164](https://github.com/dd-jp/samurai-trading-system/issues/164)).
- **Crash-safety** — WAL + `synchronous=FULL` ([#165](https://github.com/dd-jp/samurai-trading-system/issues/165)).
- **Wiring** — `openSharedStore(dbPath): SharedStore` factory, constructor injection ([#166](https://github.com/dd-jp/samurai-trading-system/issues/166)).
- **DB path convention** — `data/samurai-{env}.sqlite`, one file per environment ([#168](https://github.com/dd-jp/samurai-trading-system/issues/168)).
- **config_trials schema** — JSON blobs, PK-based upsert ([#179](https://github.com/dd-jp/samurai-trading-system/issues/179)).
- **Feedback Loop dial + adjustment-history schema** — three current-value tables, one shared history log, status-based approval gating ([#180](https://github.com/dd-jp/samurai-trading-system/issues/180)).
- **Cosine setup store schema** — `cosine_setups` table, `debate_id` PK, `idempotency_key` retained as a required indexed non-unique join column, JSON feature vectors, nullable `r_multiple` as the open/closed signal, nullable `closed_at` for point-in-time correctness ([#181](https://github.com/dd-jp/samurai-trading-system/issues/181)).
- **Consolidated DDL + field-level non-collision re-check** — this document ([#167](https://github.com/dd-jp/samurai-trading-system/issues/167)).

**Dependencies:** none upstream — this is the foundational persistence layer every other stage's spec already assumes. Consumed by: Market Data Service, Execution, Cost-Model/Backtest Harness, Feedback Loop, Trader, Debate Engine, Orchestrator, Risk Manager, Verdict, and the Dashboard (read-only, via `audit_log` for tick status and `verdict_log` for verdict history).
