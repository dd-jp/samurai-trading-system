-- Adds trader_log.exit_reason (#748, the indicator-based early exit).
--
-- The Trader can now emit three DIFFERENT in-process exits — the flat-by-close
-- flatten (#668, a time condition), an indicator-based early release (#748, a
-- signal condition), and the debate reversing direction (a decision condition)
-- — and until this column every one of them landed here as an
-- `intent_type = 'exit'` row with nothing to tell them apart. "The system
-- released a position because its thesis died" and "the session ended" are not
-- the same fact, and a soak that cannot separate them cannot count either.
--
-- A plain ADD COLUMN, not a table rebuild: the column is new and nullable, and
-- `trader_log` carries no CHECK constraint over it. Rows written before this
-- migration carry NULL, which is the honest reading — the reason was not
-- recorded, rather than being any particular one of the three.
--
-- NULL is also correct going forward on every non-exit row: an entry and a
-- scale-in have no exit reason, and the writer sets it exactly when
-- `intent_type = 'exit'`.

ALTER TABLE trader_log ADD COLUMN exit_reason TEXT;
