-- Distinguishes a flatten from an indicator-driven early release in
-- `closed_trades.close_reason` (#793 — the gap #748 left open).
--
-- Before this, `close_reason` named a bracket hit ('stop'/'target') but
-- collapsed every OTHER way a lot closes into one value, 'exit' — the
-- flat-by-close invariant firing (#668/ADR-0014) and the momentum axis
-- turning against the held side (#748) were the same row. `trader_log`,
-- `audit_log` and the flatten-submission idempotency key already carry the
-- three named reasons (`ExitReason`: 'flatten' | 'signal_decay' |
-- 'direction_flip' — shared/types/records.ts); this migration threads the
-- SAME three values down into the one table a per-trade "why did this
-- close?" query actually reads.
--
-- Three changes, one migration:
--
-- 1. `flatten_submissions.exit_reason` — the durable source. Written at
--    `executeExit`'s write-ahead time from the exit intent's own
--    `metadata.exit_reason`, so `ingestFills()`'s flatten redistribution can
--    read back WHY this particular flatten was submitted, not just which
--    lots it named. Nullable, no CHECK, mirroring 0030's `trader_log`
--    column: rows written before this migration recorded no such reason.
--
-- 2. `fills.exit_reason` — carried onto the SPLIT fill `redistributeOneFlatten`
--    persists per named lot, copied straight from the journalled value above.
--    A plain nullable ADD COLUMN, not a rebuild: `fills.leg` keeps its
--    existing CHECK and existing four values unchanged (`'exit'` still means
--    "a market order that closed the position" at the fill-mechanics level;
--    both adapters tag a flatten's raw fill the same way regardless of why it
--    was submitted, so there is no adapter-level signal to preserve here —
--    see PR body). This column is durable per-fill so `closedTrade()` can
--    read the closing fill's reason on ANY poll, not only the one that
--    ingested it.
--
-- 3. `closed_trades.close_reason` — SQLite cannot alter a CHECK constraint in
--    place, so the table is rebuilt column-for-column, exactly as 0017,
--    0022, 0028 and 0029 did. Existing rows keep their stored 'exit' value
--    unchanged: which of the three in-process reasons produced them was
--    never recorded, and inventing a distinction for historically ambiguous
--    rows would be worse than leaving them as the honest "an exit, reason
--    unknown" legacy value. 'exit' stays a legal value in the new CHECK for
--    exactly that reason — it is not dropped, only no longer the only answer
--    a NEW exit-family close can produce.

ALTER TABLE flatten_submissions ADD COLUMN exit_reason TEXT;

ALTER TABLE fills ADD COLUMN exit_reason TEXT;

CREATE TABLE closed_trades_new (
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
  -- 'exit' retained as the legacy value for pre-0031 rows (see doc above).
  -- 'flatten' | 'signal_decay' | 'direction_flip' are the same three values
  -- `ExitReason` (shared/types/records.ts) already names.
  close_reason       TEXT NOT NULL CHECK(close_reason IN (
                        'stop', 'target', 'exit',
                        'flatten', 'signal_decay', 'direction_flip'
                      ))
);

INSERT INTO closed_trades_new SELECT * FROM closed_trades;

DROP TABLE closed_trades;

ALTER TABLE closed_trades_new RENAME TO closed_trades;

CREATE INDEX idx_closed_trades_closed_at ON closed_trades(closed_at);
