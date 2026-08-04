-- Durable BrokerAdapter-local state that survives a crash-restart (#287,
-- closing #294/#295; code review 2026-08-01 C1/C3/H3 + security C1/H4).
--
-- Every live adapter previously held money-critical state in process-local
-- `Map`s: the ccxt OCO emulation's phase + leg ids, the IBKR venue-order-id →
-- leg reverse index, the Alpaca client-order-id → parent-order-id index, and
-- the ccxt observed-fill queue. All of them are empty after a restart, which
-- is precisely the moment they are needed. For ccxt that is the sharp end: a
-- crash between the entry filling and the protective legs being armed left a
-- LIVE POSITION WITH NO STOP on the venue and no local record that one was
-- owed — CONTEXT.md invariant #5 ("crash-restart must not lose open
-- positions") failing silently.
--
-- These two tables are the adapters' write-through journal. The in-process
-- Maps stay the working set (they must: the ccxt emulation's exactly-once
-- sibling cancel depends on claiming a phase transition SYNCHRONOUSLY, and an
-- awaited persistence call in that window would reopen the double-arm race).
-- better-sqlite3 is synchronous, so the journal write sits inside the same
-- synchronous claim without weakening it.
--
-- WHY NOT an existing table. `open_positions` is the lot's system-of-record
-- and is owned by the store seam ABOVE the adapter (`SharedStore`, of which
-- Execution is the sole writer, cross-spec §4). Adapter state is a different
-- grain and a different owner: it is venue bookkeeping — which venue order id
-- is which leg, how far the emulation has got — that no consumer above the
-- broker boundary may read, because nothing above the adapter is allowed to
-- know a venue needs hand-holding (execution-spec.md "Module: Broker
-- Abstraction"). Folding it into `open_positions` would leak the emulation
-- through the seam and give a second writer to the lot record.
--
-- WHY ONE TABLE FOR ALL THREE VENUES. No consumer reads across venues — each
-- adapter loads only its own rows, `WHERE venue = ?`, and the `venue` column
-- is in the primary key so two adapters can never collide on a shared client
-- order id. Three near-identical tables would buy nothing but three copies of
-- the same DDL. The cost is that several columns are venue-specific; that is
-- spelled out per column below rather than left to be inferred.

-- One row per bracket the adapter has placed (or rehydrated from the venue).
--
-- Per-venue column applicability:
--   ccxt   — ALL columns. This is the emulation's whole durable state: the
--            phase machine, both leg ids, the arming quantity and the arm
--            attempt (which fixes the deterministic leg client-order-id
--            suffix, so a recovery re-arm addresses the SAME leg the venue
--            may already hold, and its duplicate-client-order-id rejection
--            stays a real safety net instead of being defeated by a fresh id).
--   ibkr   — identity + the three order ids. `phase` is always 'armed': the
--            venue's OCA group is the state machine, so there is no local one.
--   alpaca — identity + the three order ids, same as IBKR and for the same
--            reason. Only `entry_order_id` is READ back (the adapter's index
--            is client-order-id → bracket parent, and `fetchNewFills` reaches
--            the children through the parent's `legs`), but both children are
--            written because the submit response carries them and a recorded
--            venue id costs nothing while a missing one cannot be recovered.
--
-- The request columns (`instrument` .. `time_in_force`) are NULLABLE, and the
-- nullability is load-bearing rather than lax: every adapter writes them in
-- full at submit time, but the two REHYDRATION paths (`AlpacaBrokerAdapter`
-- and `IbkrBrokerAdapter`'s `getOrder`, which learn of a bracket by asking the
-- venue about a client order id) legitimately know the venue's order ids and
-- NOT the original request. Writing zeros or empty strings there would be
-- fabricating a request the system never made — the same posture the adapters
-- take when they refuse to book a fill the venue cannot price. A ccxt row
-- always has them, because only ccxt needs to re-place a leg from them.
--
-- `client_order_id` carries the same value as `open_positions.idempotency_key`
-- (NativeBracketRequest.client_order_id is set from the OrderIntent's
-- idempotency key). It is named for the ADAPTER's vocabulary because this
-- table is written from below the store seam, where the concept is the
-- broker-native idempotency handle, not the pipeline's decision key — the same
-- distinction `NormalizedFill.client_order_id` already draws.
CREATE TABLE broker_brackets (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca')),
  client_order_id  TEXT NOT NULL,
  -- ccxt's emulated lifecycle; always 'armed' on a native-bracket venue.
  phase            TEXT NOT NULL CHECK(phase IN ('pending_entry', 'arming', 'armed', 'resolved')),
  entry_order_id   TEXT NULL,       -- ccxt entry / IBKR parent / Alpaca bracket parent
  stop_order_id    TEXT NULL,
  target_order_id  TEXT NULL,
  instrument       TEXT NULL,
  asset_class      TEXT NULL CHECK(asset_class IS NULL OR asset_class IN ('crypto', 'stocks')),
  side             TEXT NULL CHECK(side IS NULL OR side IN ('buy', 'sell')),
  size             REAL NULL,       -- REQUESTED size; not the filled quantity
  entry_price      REAL NULL,       -- the request's limit prices, NOT open_positions'
  stop_price       REAL NULL,       -- live protective levels: named apart on purpose
  target_price     REAL NULL,
  time_in_force    TEXT NULL,
  armed_qty        REAL NULL,       -- ccxt: quantity the LIVE legs protect
  arming_qty       REAL NULL,       -- ccxt: quantity the IN-FLIGHT arming episode is placing
  arm_attempt      INTEGER NOT NULL DEFAULT 0,  -- ccxt: fixes the leg client-order-id suffix
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (venue, client_order_id)
);

-- The ccxt adapter's observed-fill queue, made durable.
--
-- Only ccxt writes here today, and the reason is a real asymmetry rather than
-- an oversight: Alpaca and IBKR DERIVE their fills from the venue on every
-- `fetchNewFills` (a per-bracket `getOrder`, an account-wide execution feed),
-- so persisting their bracket rows is enough to make those feeds whole again
-- after a restart. ccxt's fills are GENERATED BY A TRANSITION — `advanceEntry`
-- normalizes the entry fill exactly once, on the `pending_entry` → `arming`
-- edge, and nothing ever re-derives it. So an `armed` bracket whose entry fill
-- had not yet been drained by `ingestFills()` lost that fill forever on a
-- crash, and its lot would sit at `filled_size` 0 against a live position.
--
-- Append-only and UNPRUNED, and unlike the in-memory array it replaces this
-- one is unbounded over TIME, not just over a process lifetime: the adapter
-- loads its whole venue partition on construction and `fetchNewFills` scans it
-- per call. That is a real cost this ticket accepts rather than hides. It is
-- correct but not free, and it grows forever.
--
-- Pruning is deliberately NOT invented here, because the safe retention rule
-- is a decision this ticket has no standing to make: a row may only be dropped
-- once its fill is certain to have been booked into `fills`, and that
-- certainty lives above the broker seam in `ingestFills()`, which this table's
-- writer cannot see. Guessing a window would silently drop an undrained fill —
-- the exact loss the table exists to prevent. Tracked for a follow-up.
-- Re-offering a row `ingestFills()` already booked, meanwhile, costs nothing:
-- it dedups on `broker_fill_id`.
--
-- PK shape mirrors the `fills` table's `(idempotency_key, broker_fill_id)`,
-- with `venue` prefixed for the same reason as above. No secondary index: the
-- only query is the venue-partition load, which the PK's leading column
-- already serves, and `since` filtering happens in the adapter, not in SQL.
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
