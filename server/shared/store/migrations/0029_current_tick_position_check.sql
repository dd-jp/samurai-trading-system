-- Adds 'position_check' to current_tick.stage (#743, the tick/decision split).
--
-- The tick runner now runs two cadences (orchestrator-spec.md, "The
-- tick/decision split"): a cheap position-facing pass on every tick, and the
-- full stage chain once per debate bar. The cheap pass upserts its progress
-- row with stage 'position_check' on entry — without this value the 2-minute
-- exit cadence either leaves no progress row at all (the dashboard shows a
-- dead system that is working) or leaves a stale one from the last decision
-- (a stage that finished up to an hour ago).
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt —
-- but unlike 0017/0022/0028 no rows are copied across. current_tick is
-- documented (0001_init.sql, orchestrator-spec.md story 15) as disposable,
-- best-effort progress state whose loss "costs nothing but a stale progress
-- indicator": the row is re-upserted on the next tick, at most one tick
-- interval away. Copying rows would preserve, at best, a stale indicator from
-- the pre-migration process — the exact artifact the next tick clobbers.

DROP TABLE current_tick;

CREATE TABLE current_tick (
  instrument    TEXT PRIMARY KEY,
  asset_class   TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  stage         TEXT NOT NULL CHECK(stage IN ('position_check', 'analysts', 'debate', 'trader', 'risk', 'verdict', 'execution')),
  trace_id      TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
