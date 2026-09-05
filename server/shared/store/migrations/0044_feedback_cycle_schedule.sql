-- The Feedback Loop daily cycle's restart-durable schedule (#1110).
--
-- Before this table the cycle was armed by a plain `setInterval` started at
-- process boot, with nothing written down about when it last ran. A soak
-- restarted more often than once a day therefore never accumulated 24h of
-- continuous uptime, so the timer never fired even once in the store's whole
-- history — `arm_comparison_samples` held 0 rows ever, silently, because
-- nothing here recorded that the cycle owed one.
--
-- ## What is persisted: the boundary, not the instant
--
-- One column, `last_boundary` — the most recently completed WALL-CLOCK
-- boundary (see `currentBoundary` in cycle-schedule.ts), not "the last time
-- the cycle ran" as a raw timestamp. A boundary is idempotent to record twice
-- (two restarts inside the same period both compute the same boundary), so
-- comparing boundaries rather than elapsed time is what makes "did today's
-- cycle already happen" a question this table can answer with a single
-- inequality, across any number of restarts.
--
-- Storing only the SINGLE most recent boundary (not a queue of every boundary
-- ever completed, and not a per-boundary log) is what caps catch-up at one
-- cycle after any gap: a process that comes back after a week down sees "the
-- current boundary is newer than the stored one" exactly once, runs exactly
-- one cycle, and stamps the current boundary — it cannot tell, and does not
-- need to tell, how many earlier boundaries were missed. See the composition
-- root (production.ts, `scheduleFeedbackCycle`) for the two design decisions
-- (wall-clock boundary vs. elapsed interval; capped catch-up) recorded in
-- full where the table is read and written.
--
-- ## Single durable row (key = 'default')
--
-- Same shape as `account_state` (migration 0006) for the same reason: there
-- is exactly one feedback cycle per process, so a free-form TEXT primary key
-- with one row upserted forever is simpler than inventing an identity for a
-- schedule that never has a second instance.
CREATE TABLE feedback_cycle_schedule (
  key           TEXT PRIMARY KEY,
  last_boundary TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
