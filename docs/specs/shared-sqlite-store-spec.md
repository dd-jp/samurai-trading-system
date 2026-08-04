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
- **One SQLite file per environment** (`data/samurai-paper.sqlite`, `data/samurai-live.sqlite`) — not a single file with an environment column, so paper/live PnL cross-contamination is physically impossible. Tests use a fresh temp file or `:memory:`.
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

**`data/samurai-{env}.sqlite`** at repo root — one file per environment (`data/samurai-paper.sqlite`, `data/samurai-live.sqlite`), not a single file with an environment column, so paper/live PnL cross-contamination is physically impossible. Tests use a fresh temp file or `:memory:`, never a checked-in test DB. (Resolved: [Decide: DB file path convention](https://github.com/dd-jp/samurai-trading-system/issues/168).)

### Module: Consolidated Schema

Every `CREATE TABLE` the store needs, collected from the eleven specs that implicitly define them plus the three that had no schema anywhere until this map resolved them (`verdict_log` and `breaker_state` were added later, per #206 and #203 respectively). `cii_snapshots` was added later still, per #182 (`0003_cii_snapshots.sql`). `account_state` was added later still, per the transport-layer-spec.md cross-verify pass (2026-07-31), closing a gap where `AccountStateProvider`'s `peak_equity` had no durable home. `broker_brackets` and `broker_observed_fills` were added last, per [#287](https://github.com/dd-jp/samurai-trading-system/issues/287) (`0007_broker_adapter_state.sql`), closing the gap where every live `BrokerAdapter` held money-critical venue state in process-local memory. Field-level non-collision was re-verified across all twenty tables (see **Non-Collision Verification** below).

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
CREATE TABLE open_positions (
  idempotency_key     TEXT PRIMARY KEY,
  debate_id           TEXT NOT NULL,
  instrument          TEXT NOT NULL,
  asset_class         TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side                TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  intent_type         TEXT NOT NULL CHECK(intent_type IN ('entry', 'scale_in')),
  requested_size      REAL NOT NULL,
  filled_size         REAL NOT NULL,   -- cumulative; downstream reads THIS, never requested_size
  avg_entry_price     REAL NOT NULL,
  stop                REAL NOT NULL,   -- live protective leg (resized on partial fill)
  target              REAL NOT NULL,
  order_state         TEXT NOT NULL,
  broker_order_ids    TEXT NOT NULL,   -- JSON string[]
  opened_at           TEXT NOT NULL,
  decision_timestamp  TEXT NOT NULL    -- the bar/decision time (from OrderIntent)
);
CREATE INDEX idx_open_positions_instrument ON open_positions(instrument, asset_class);

-- One row per (partial) fill — every fill logged (CONTEXT.md invariant #4). Append-only.
CREATE TABLE fills (
  idempotency_key      TEXT NOT NULL,
  broker_fill_id       TEXT NOT NULL,
  leg                  TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  price                REAL NOT NULL,
  qty                  REAL NOT NULL,
  fee                  REAL NOT NULL,
  timestamp            TEXT NOT NULL,
  cost_breakdown_json  TEXT NULL,      -- JSON {spread_cost, commission, slippage, market_impact}; Simulated-adapter fills only (undefined/null on real broker fills)
  PRIMARY KEY (idempotency_key, broker_fill_id)
);

-- Emitted on round-trip-to-flat — the Feedback Loop / Risk realized record. Append-only.
CREATE TABLE closed_trades (
  idempotency_key    TEXT PRIMARY KEY,   -- per-lot
  debate_id          TEXT NOT NULL,      -- attribution + setup-store join key
  instrument         TEXT NOT NULL,
  asset_class        TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side               TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  entry              REAL NOT NULL,      -- avg entry, from fills
  stop               REAL NOT NULL,      -- initial protective stop → initial risk
  filled_size        REAL NOT NULL,      -- initial risk = |entry - stop| x filled_size
  realized_pnl_net   REAL NOT NULL,      -- net of fees
  fees_total         REAL NOT NULL,
  opened_at          TEXT NOT NULL,
  closed_at          TEXT NOT NULL,
  close_reason       TEXT NOT NULL CHECK(close_reason IN ('stop', 'target', 'exit'))
);
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
-- One table for all three venues because no consumer reads across them: each adapter
-- loads only `WHERE venue = ?`, and `venue` is in the PK so two adapters can never
-- collide on a shared client order id. Per-venue column applicability:
--   ccxt   -- all columns; this IS the emulation's state machine.
--   ibkr   -- identity + the three order ids; phase is always 'armed' (the OCA group is
--             the state machine).
--   alpaca -- identity + the three order ids, same as IBKR. Only entry_order_id is read
--             back (the adapter indexes client-order-id -> bracket parent and reaches the
--             children through the parent's legs); both children are written anyway
--             because the submit response carries them.
-- The request columns are nullable because the two REHYDRATION paths (Alpaca/IBKR
-- getOrder, which learn of a bracket by asking the venue) legitimately know the order
-- ids and not the request that produced them; inventing values there would be worse
-- than none. A ccxt row always carries them, being the only venue that re-places legs.
CREATE TABLE broker_brackets (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca')),
  client_order_id  TEXT NOT NULL,    -- same value as open_positions.idempotency_key
  phase            TEXT NOT NULL CHECK(phase IN ('pending_entry', 'arming', 'armed', 'resolved')),
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
CREATE TABLE broker_observed_fills (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca')),
  client_order_id  TEXT NOT NULL,
  broker_fill_id   TEXT NOT NULL,
  leg              TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  price            REAL NOT NULL,
  qty              REAL NOT NULL,
  fee              REAL NOT NULL,
  timestamp        TEXT NOT NULL,
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
  reason      TEXT NOT NULL  -- machine-readable cause, e.g. 'attribution', 'proposal', 'proposal:backtest_auto_approved' (#197)
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
CREATE TABLE debate_log (
  debate_id           TEXT PRIMARY KEY,
  instrument          TEXT NOT NULL,
  bar_timestamp       TEXT NOT NULL,
  contributions_json  TEXT NOT NULL,   -- JSON AnalystContribution[] (influence_score, stance, per analyst)
  direction           TEXT NOT NULL CHECK(direction IN ('bullish', 'bearish', 'neutral')),
  rounds              INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);
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
CREATE TABLE verdict_log (
  trace_id        TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  instrument      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('go', 'no_go')),
  no_go_reason    TEXT,
  hitl_override   INTEGER NOT NULL,
  timestamp       TEXT NOT NULL
);
```

Resolved: [Verdict: implement VerdictLogStore against the shared SQLite store (#206)](https://github.com/dd-jp/samurai-trading-system/issues/206), closing GAP-4 from the 2026-07-26 cross-verify pass ([docs/specs/cross-verify-2026-07-26.md](cross-verify-2026-07-26.md)) — `audit_log.output_digest` is a hash, not a queryable payload, so it cannot answer `VerdictAuditEntry.reason`/`.hitl_override`; `verdict_log` is Verdict's own real-field record, keyed by `trace_id` (the correlation ID threaded from the Orchestrator's tick) with `idempotency_key` retained as a non-PK column for cross-reference to `open_positions`/`fills`. `no_go_reason` is nullable (`null` on `go`); `hitl_override` is the dashboard-facing derived flag — true whenever `VerdictDecision.approval_path !== 'automated'` (a human path was actually taken, live or backtest-bypassed-but-recorded), not `would_require_approval` (which is also true on an automated-bypass backtest run where no override occurred).

**Correction ([#302](https://github.com/dd-jp/samurai-trading-system/issues/302), 2026-08-04):** #206 was closed as "implement `VerdictLogStore` against the shared SQLite store," but only the in-memory reference implementation (`InMemoryVerdictLogStore`) and the port existed — no SQLite-backed store was ever written, and nothing in `direct-bind.ts`'s production composition constructed either one. With no writer, `verdict_log` stayed permanently empty in every real run, so `OrphanVerdictScanner`'s crash-recovery query always reported zero orphans regardless of the truth. #302 adds `SqliteVerdictLogStore` (`src/verdict/sqlite-verdict-log-store.ts`) and wires it into `buildVerdictStep` via the `LoggingVerdict` decorator that already called the port correctly. It upserts on `trace_id` (`ON CONFLICT ... DO UPDATE`) rather than a bare `INSERT`, matching this spec's other Sqlite* stores' idempotent-retry posture.

**Orchestrator** — owner: `docs/specs/orchestrator-spec.md`

```sql
-- One row per stage-decision per trace_id. Append-only. Powers the dashboard read-only.
CREATE TABLE audit_log (
  trace_id       TEXT NOT NULL,
  stage          TEXT NOT NULL,
  decision       TEXT NOT NULL,
  input_digest   TEXT NOT NULL,
  output_digest  TEXT NOT NULL,
  timestamp      TEXT NOT NULL
);
CREATE INDEX idx_audit_log_trace_id ON audit_log(trace_id);

-- Disposable, best-effort progress state -- NOT a system-of-record. Upserted per-instrument
-- before each stage call, deleted on tick completion. Losing it on crash costs nothing but a
-- stale progress indicator.
CREATE TABLE current_tick (
  instrument    TEXT PRIMARY KEY,
  asset_class   TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  stage         TEXT NOT NULL CHECK(stage IN ('analysts', 'debate', 'trader', 'risk', 'verdict', 'execution')),
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
```

### Non-Collision Verification

`cross-spec-contracts.md`'s "shared-store table non-collision" spot-check was clean at the table-name level; re-verified here at the field level across all twenty tables above:

- **`latest_mark` was missing `asset_class`** (#183) — the `Mark` interface (market-data-service-spec.md) declares it, the original persistence bullet dropped it. **Fixed above**, not silently — this DDL is the first place the full column list was ever written out, so there was no prior "wrong" schema to correct, only an incomplete prose description.
- **`Fill` vs. the cost model's result type** — already resolved pre-existing (GAP-F renamed the cost model's return type to `CostModelResult` specifically to avoid colliding with the persisted `fills` table; `cross-spec-contracts.md` confirms this explicitly).
- **`debate_id` type/semantics** — a deterministic hash string, consistent everywhere it's reused as a join key: `open_positions.debate_id`, `closed_trades.debate_id`, `cosine_setups.debate_id` (PK here), and `debate_log.debate_id` (PK there) are all `TEXT`, all populated from the same Debate Engine-issued hash (debate-engine-spec.md / trader-spec.md). No divergence.
- **`idempotency_key` type/semantics** — `TEXT` everywhere it appears (`open_positions` PK, `fills` composite PK component, `closed_trades` PK, `cosine_setups` non-unique column, `verdict_log` non-unique column). `cosine_setups` and `verdict_log` are the two tables where it is deliberately **not** the primary key — see the notes under each table — which is a real asymmetry with `open_positions`/`closed_trades` but not a collision: each table's key is dictated by its own write pattern (one `cosine_setups` row per *debate*, one `verdict_log` row per *decision*, keyed on `trace_id` since that's the correlation ID Verdict actually receives, one `open_positions`/`closed_trades` row per *decision lifecycle*), matching this spec's "every table's own consumer dictates its key" principle.
- **`asset_class` type/semantics** — the `CHECK(asset_class IN ('crypto', 'stocks'))` constraint and column name are identical across all five tables that carry it (`latest_mark`, `open_positions`, `closed_trades`, `cosine_setups`, `current_tick`). No divergence.
- **`breaker_state`** (#203) — `tier` is its own PK, disjoint from every other table's `debate_id`/`trace_id`/`idempotency_key` keying convention. `tripped_at`/`reset_at` are nullable `TEXT` timestamps (null while never-tripped/still-tripped respectively) — no other table has a comparable nullable-timestamp pair to collide with. No divergence.
- **`dial_adjustments` was missing `reason`** (#197) — `Adjustment.reason` (feedback-loop-spec.md's "Module: Guardrailed Tuning") was already a required field consumed by `daily-cycle.ts`/`metrics.ts`; the original DDL bullet dropped it, the same class of gap as `latest_mark`/`asset_class` above. **Fixed above**, plus a real migration (`0002_dial_adjustments_reason.sql`, `ALTER TABLE ... ADD COLUMN reason TEXT NOT NULL DEFAULT ''`) since `0001_init.sql` had already shipped without it.
- **`cii_snapshots`** (#182) — `country_code` is a plain `TEXT` code (WorldMonitor country codes, e.g. `'RU'`), disjoint from every other table's keying convention; not the same value space as `asset_class`'s `crypto`/`stocks` enum despite both being country/market-adjacent classifiers. `(country_code, captured_at)` composite PK is the append-only-history pattern already used by `bars`' `(instrument, timeframe, open_time)`. No divergence.
- **`account_state`** (transport-layer-spec.md, 2026-07-31) — `key` is its own single-row PK (`'default'`), disjoint from every other table's keying convention; no other table carries a bare running-max scalar like `peak_equity`. No divergence.
- **`broker_brackets` / `broker_observed_fills`** (#287, 2026-08-04) — three deliberate near-misses, all resolved by naming rather than left to be inferred:
  - **`client_order_id` vs `idempotency_key`** — the same VALUE (`NativeBracketRequest.client_order_id` is set from the OrderIntent's idempotency key), a different NAME. These two tables are written from below the `SharedStore` seam, where the concept is the broker-native idempotency handle rather than the pipeline's decision key — the same distinction `NormalizedFill.client_order_id` already draws in code. Renaming it `idempotency_key` here would imply the adapter knows about a pipeline concept it deliberately does not.
  - **`entry_price`/`stop_price`/`target_price` vs `open_positions.avg_entry_price`/`stop`/`target`** — named APART on purpose, because they mean different things: these are the prices the bracket was REQUESTED at and never change, whereas `open_positions.stop`/`target` are the live protective levels that get resized on partial fill. Reusing `stop`/`target` would invite exactly the wrong join.
  - **`broker_observed_fills` vs `fills`** — same grain (one row per observed fill) but different owner and different lifetime: `fills` is the append-only system-of-record written by `ingestFills()` above the seam, `broker_observed_fills` is one adapter's undrained queue below it. The PK shape is deliberately parallel (`(venue, client_order_id, broker_fill_id)` against `(idempotency_key, broker_fill_id)`), with `venue` prefixed for the same reason it is in `broker_brackets`'.
  - `venue`, `phase`, `arm_attempt`, `armed_qty` and `arming_qty` appear in no other table. `asset_class`/`side`/`leg` carry the identical CHECK constraints as everywhere else, minus the `IS NULL OR` relaxation the nullable request columns require. No divergence.
- No other field-level collisions found.

## Testing Decisions

### What Makes a Good Test

- Test the migration runner: applying migrations to an empty `:memory:` DB produces the exact schema above; re-applying is a no-op; `schema_migrations` reflects applied versions.
- Test `openSharedStore`: returns a handle backed by the given path; runs pending migrations; WAL mode and `synchronous=FULL` are set on the connection.
- Test each table's constraints directly (e.g. `open_positions.asset_class` CHECK rejects an invalid value; `config_trials` upsert-on-conflict overwrites `result_json`; `dial_adjustments.status` transitions correctly; `cosine_setups.debate_id` PK rejects a duplicate write for the same debate).
- No LLM to mock — this is pure schema/migration/connection-config testing.

### Modules to Test

**Migrations** — fresh-DB apply, idempotent re-apply, version tracking.

**Driver/Connection Config** — WAL mode, `synchronous=FULL`, one file per environment (paper/live never share a path).

**Schema Constraints** — CHECK constraints on enums (`asset_class`, `side`, `intent_type`, `close_reason`, `dial_type`, `status`), PK uniqueness, upsert semantics on `config_trials`, nullable-pair semantics on `cosine_setups` (`r_multiple`/`closed_at` set together, never independently).

### Prior Art

- No implementation yet. This spec's tables are each already covered by their owning spec's own testing section (e.g. `open_positions`/`fills`/`closed_trades` behavior is tested at the Execution seam, not here) — this spec's own tests are schema/migration/connection-level only, not business-logic tests, which belong to the owning spec.

## Out of Scope

**Market Intelligence's replay store** — confirmed a separate SQLite file (90-day auto-purge policy incompatible with this store's permanent-retention requirement — CLAUDE.md: track everything for HMRC/CGT). Not part of this spec.

**Per-component cutover order/sequencing** — deferred to `/to-tickets`, not a spec-content decision.

**The Orchestrator's live composition root** — where `openSharedStore` actually gets called at boot is separate, not-yet-charted "paper trading launch" work; this spec only promises an injectable `SharedStore` handle for it to consume later.

**Business logic of any owning stage** — this spec defines tables and the store's own infrastructure (driver, migrations, crash-safety, wiring). It does not redefine what Execution, the Trader, Risk, the Feedback Loop, the Debate Engine, or the Orchestrator do with their own tables — each remains that spec's concern.

## Further Notes

### Integration with Pipeline

```
Market Data Service → bars, latest_mark
Execution           → open_positions, fills, closed_trades  (sole writer)
Cost-Model/Backtest → config_trials
Feedback Loop       → analyst_weights, strategy_params, risk_thresholds, dial_adjustments, cosine_setups (labels only; Trader writes)
Trader              → cosine_setups (writes; FL labels)
Debate Engine       → debate_log
Verdict             → verdict_log
Orchestrator        → audit_log, current_tick
Transport Layer     → account_state (AccountStateProvider, peak_equity)
```

Every stage above reads/writes through the one `SharedStore` handle from `openSharedStore(dbPath)`, injected at each stage's construction.

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
