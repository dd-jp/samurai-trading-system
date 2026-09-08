-- Closes the cross-arm leak #1124 found: `flatten_submissions` had no `arm`
-- column, and `getUnresolvedFlattens()` — unlike `getOpenPositions()` and
-- `getUnprotectedResidualLots()` (migration 0033's own doc names both as the
-- arm-scoped SCANS) — read the whole table with no `arm` predicate at all.
--
-- ## The mechanism this closes
--
-- The live arm's periodic `reconcile()` (fill-sync.ts's `fillSync`, over
-- `AlpacaBrokerAdapter`) and the control arm's own periodic `reconcile()`
-- (`controlFillSync`, over `SimulatedBrokerAdapter`) both read
-- `getUnresolvedFlattens()` against the ONE shared `config.db` connection
-- (`production.ts` stamps `guardedStore(config.db, 'execution')` into both
-- `SqliteExecutionStore`s). Unfiltered, EITHER arm's pass would pick up the
-- OTHER arm's still-unresolved row and ask its OWN broker about a
-- `client_order_id` that broker never received:
--
-- - A control-arm flatten's row, read by the live arm's pass, gets asked of
--   the REAL Alpaca venue — which genuinely has no such order (it was placed
--   against the SIMULATED book), so it genuinely answers "no such order".
--   That is #1124's observed `action: "undetermined"` line: not a race in
--   `SimulatedBrokerAdapter`'s `accepted` map (that map is never asked in
--   this branch at all), but the WRONG adapter being asked about a key it
--   was never going to hold. The control arm's OWN later pass then asks the
--   RIGHT adapter and adopts correctly — which is why the two lines carry
--   the SAME `idempotency_key` and both self-resolve within one poll
--   interval, and why `fill-sync.ts`'s shared `RECONCILE_TRACE_ID` on both
--   loops (a separate, non-load-bearing confusion, filed as #1321) made the
--   two independent passes look like one.
-- - The narrower, unobserved-but-real direction: if the live arm's pass reads
--   a control row still at `'submitting'` (the control's own `submitFlatten`
--   has not yet returned), the SAME wrong-broker null looks like "the
--   write-ahead never landed" and the live pass calls
--   `resolveFlattenError`, durably terminating a row the control's own
--   in-flight submission was about to resolve to `'submitted'` moments
--   later — an unfiltered scan does not merely mislabel a divergence, it can
--   race a live write.
--
-- `open_positions`/`closed_trades` never had this hole (migration 0033
-- already scopes both SCANS the arms' books read from) — `flatten_submissions`
-- is the one table #753 missed, because it predates #753 (migration 0019,
-- months before falsifier arm 2) and is read only by SCANS, not by an
-- OpenPosition-shaped per-instrument comparison that would have surfaced the
-- gap the way `getOpenPositions()`'s own arm scoping did.
--
-- ## The backfill: derived per row, with `'live'` only as the fallback
--
-- This migration runs IN PLACE on a DB that already holds pre-#1124 rows —
-- the paper soak DB was at `schema_migrations` max 48 when this was written,
-- with 13 `flatten_submissions` rows, and `DEFAULT 'live'` alone would have
-- mislabelled 11 of them. Those rows are NOT all live: the control arm's
-- flatten path has been writing here since it shipped, it just could not
-- SAY so without this column. A blanket `'live'` is therefore a wrong
-- value, not a conservative one, and once `getUnresolvedFlattens()` starts
-- filtering on `arm` a mislabelled row is worse than an unlabelled one: it
-- becomes visible only to the WRONG arm's reconcile pass, which is the very
-- failure this migration exists to close, minus the pre-fix unfiltered scan
-- that used to self-heal it.
--
-- The true arm IS derivable. Each row's `lot_idempotency_keys` names the
-- lots it flattened, and those lots carry `arm` in `closed_trades` /
-- `open_positions` (migration 0033). The `UPDATE` below resolves it from
-- there; on the soak DB it resolved all 13 rows with no NULLs — 2 live
-- (SPY, TSLA) and 11 control.
--
-- `'live'` survives as the COALESCE fallback for the case the join cannot
-- answer: `sweepTerminalPositions` deletes from `open_positions`, so a lot
-- aged out of both tables leaves its flatten row underivable. It is the
-- column's DEFAULT for that reason and no other — a value for the rows
-- nothing else can speak for, not a claim about the rows that can.
--
-- Note this is NOT migration 0033's posture, despite the identical column
-- declaration. 0033 introduced `arm` in the first place, so at the moment it
-- ran there was no control arm to have written anything and its blanket
-- `'live'` was, in its own words, "the true value for every backfilled row,
-- not a placeholder". That reasoning does not transfer here: the control
-- arm has been writing to THIS table since it shipped, which is what the
-- 11-of-13 measurement above says.
--
-- ## Key-based reads/writes stay unfiltered
--
-- `resolveFlattenSubmitted`, `resolveFlattenError`, `isRetryableFlattenError`,
-- `recordFlattenOrderStateObserved`, `markFlattenFillsSwept` and
-- `getFlattenAttribution` all take an `idempotency_key` naming exactly one
-- row — `arm` is a hash input to that key (#753, `computeIdempotencyKey`), so
-- a key-based call cannot cross arms even unfiltered, the same invariant
-- migration 0033 already relies on for `findByKey`/`updatePositionState`.
-- Only `getUnresolvedFlattens()`, the one SCAN over this table, needed the
-- predicate.
ALTER TABLE flatten_submissions
  ADD COLUMN arm TEXT NOT NULL DEFAULT 'live' CHECK(arm IN ('live', 'control'));

-- `closed_trades` first: a flattened lot ends there, and `open_positions`
-- still holds the row only until `sweepTerminalPositions` removes it, so the
-- closed record is the longer-lived witness. `LIMIT 1` because a multi-lot
-- flatten's lots are all one arm by construction: the sole writer of
-- `lot_idempotency_keys` is `writeAheadFlatten`, called from exactly one
-- place (`execute.ts`'s `executeExit`), and its list is `heldLots` — the
-- arm-scoped `getOpenPositions()` filtered by instrument. The two arms' key
-- spaces are disjoint on top of that: `computeIdempotencyKey` (#753) hashes
-- a three-field payload for `'live'` and a four-field one carrying `arm` for
-- `'control'`, so no key can be read as belonging to both. A cross-arm lot
-- list is unconstructible. The limit therefore picks an arbitrary row, and
-- that is sound because there is nothing to pick BETWEEN — not because it
-- fixes scan order, which it does not: `["lot-L","lot-c"]` and its reverse
-- resolve to different arms.
--
-- Guarded by `json_valid`, not merely `IS NOT NULL`: `lot_idempotency_keys`
-- is nullable AND untrusted enough that `getFlattenAttribution` validates it
-- on every read (#524/#571). `json_each` over a malformed value raises.
-- `runMigrations` runs each migration file inside `db.transaction()`, so a
-- raise rolls back and leaves no half-applied version — the damage is not a
-- bricked DB but a refusal to open one: nothing catches the throw between
-- there and `openSharedStore`, so the orchestrator would not boot on the host
-- holding that row, on this pass or any later one. Guarded, such a row simply
-- keeps the `'live'` default, the same as one whose lots have aged out.
UPDATE flatten_submissions
   SET arm = COALESCE(
         (SELECT ct.arm
            FROM json_each(flatten_submissions.lot_idempotency_keys) AS lot
            JOIN closed_trades ct ON ct.idempotency_key = lot.value
           LIMIT 1),
         (SELECT op.arm
            FROM json_each(flatten_submissions.lot_idempotency_keys) AS lot
            JOIN open_positions op ON op.idempotency_key = lot.value
           LIMIT 1),
         'live')
 WHERE lot_idempotency_keys IS NOT NULL
   AND json_valid(lot_idempotency_keys);

-- `getUnresolvedFlattens()`'s own WHERE shape is `arm = ? AND (status = ... OR
-- (status = ... AND fills_swept_at IS NULL))` — `arm` leads for the same
-- two-value-discriminator reason migration 0033's indexes lead with it.
CREATE INDEX idx_flatten_submissions_arm ON flatten_submissions(arm, status);
