-- #197: dial_adjustments was missing `reason` — Adjustment.reason ("Machine-readable
-- cause, e.g. 'attribution', 'proposal', 'proposal:backtest_auto_approved'",
-- src/feedback-loop/types.ts) has nowhere to persist without it. DEFAULT '' only
-- satisfies NOT NULL for SQLite's ADD COLUMN requirement; every real writer
-- (SqliteAdjustmentLog) always supplies a real reason.
ALTER TABLE dial_adjustments ADD COLUMN reason TEXT NOT NULL DEFAULT '';
