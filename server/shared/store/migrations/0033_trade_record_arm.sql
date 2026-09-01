-- Falsifier arm 2's trade record (#753).
--
-- ADR-0014 amendment 2 and ADR-0017's Consequences mandate falsifier arm 2 —
-- *same name selection, same exit rule, same stop, entry by indicator alone, no
-- LLM in the path* — as the system's PRIMARY matched control, run in parallel
-- with the live arm from the first soak day. `docs/research/12-edge-hypothesis-critique.md`
-- D4 additionally rules out the tempting substitute: a return-only comparison
-- against a risk-targeted stream is inadmissible, so both arms must be
-- measurable on return AND drawdown over the same tape.
--
-- None of that is possible while the two arms' trades are indistinguishable in
-- the record. Before this migration `open_positions` and `closed_trades` carried
-- no notion of which arm produced a row, so "the control's trades" could only
-- ever be INFERRED (from a `debate_id` prefix, say) rather than queried. #753's
-- acceptance criterion is explicit that it must be a real, queryable property:
--
--     SELECT * FROM closed_trades WHERE arm = 'control'
--
-- ## Why DEFAULT 'live' rather than a nullable column
--
-- Every row already in these tables was produced by the debate-driven arm,
-- because that is the only arm that existed. `'live'` is therefore the true
-- value for every backfilled row, not a placeholder — which is why the column is
-- NOT NULL with a default rather than nullable. A NULL would mean "unknown", and
-- there is nothing unknown here.
--
-- The default also keeps every existing writer correct without being edited: a
-- caller that never mentions `arm` writes a live row, which is what it meant.
-- The arm-scoped store (`SqliteExecutionStore`, constructed with an `arm`)
-- stamps the column explicitly on both tables and filters its two SCAN queries
-- (`getOpenPositions`, `getUnprotectedResidualLots`) on it, so the control arm's
-- lots can never enter the live arm's exposure caps, its portfolio valuation, or
-- its residual-protection sweep — the arms share a tape, not a book.
--
-- Key-based lookups (`findByKey`, `updatePositionState`, the lot advances) are
-- deliberately NOT filtered: `arm` is a hash input to `idempotency_key` since
-- #753 (see `computeIdempotencyKey`), so the two arms occupy disjoint key spaces
-- and a key lookup cannot cross arms even in principle. Filtering there as well
-- would add a predicate that can only ever be redundant, and would read as
-- though the key space were shared.
--
-- ## ALTER TABLE, not a table rebuild
--
-- Unlike 0031 (`close_reason`, which had to widen a CHECK constraint) this adds
-- a column whose CHECK is new, so SQLite's `ALTER TABLE ... ADD COLUMN` applies
-- it without a rebuild. Both tables keep their PRIMARY KEY and every other
-- constraint untouched.

ALTER TABLE open_positions
  ADD COLUMN arm TEXT NOT NULL DEFAULT 'live' CHECK(arm IN ('live', 'control'));

ALTER TABLE closed_trades
  ADD COLUMN arm TEXT NOT NULL DEFAULT 'live' CHECK(arm IN ('live', 'control'));

-- The live arm's hot reads are `getOpenPositions()` (every tick, both stages) and
-- `getUnprotectedResidualLots()` (the #549 sweep), both of which now carry
-- `arm = ?` alongside the `order_state NOT IN (...)` predicate 0005 indexed for.
-- Leading with `arm` keeps the existing instrument index untouched and gives the
-- scan a two-value discriminator to start from, which is the whole selectivity
-- the control arm adds.
CREATE INDEX idx_open_positions_arm ON open_positions(arm, opened_at);

-- The comparison report reads `closed_trades` per arm, ordered by close time —
-- that is the ONE query shape #753's report has, and it is the whole reason a
-- return-and-drawdown series can be built per arm over the same window.
CREATE INDEX idx_closed_trades_arm ON closed_trades(arm, closed_at);
