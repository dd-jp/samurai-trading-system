-- Persists why a lot was auto-retired to the 'abandoned' terminal state (#1186).
--
-- A lot `reconcile()` adopted as `filled`/`partially_filled` whose `filled_size`
-- stays zero has no venue position (nothing filled) and no path back to a live
-- state (`ingestFills()`'s `advanceLot` only advances on a NEW fill, which this
-- lot structurally can never receive again — see `wedged-zero-fill-sweep.ts`).
-- `wedged-zero-fill-sweep.ts` retires such a lot to `order_state = 'abandoned'`
-- once it has stayed wedged past the bounded window, and writes the reason here
-- so the row explains itself without a log line to cross-reference — the same
-- "record survives on the row" posture `close_reason` gives a real `closed_trades`
-- exit. Plain additive nullable ADD COLUMN, following 0030/0031/0037/0054's
-- convention: NULL for every row abandoned before this migration existed (none
-- do — 'abandoned' is a new state introduced alongside this column) and for
-- every row that reaches a DIFFERENT terminal state.

ALTER TABLE open_positions ADD COLUMN abandon_reason TEXT;
