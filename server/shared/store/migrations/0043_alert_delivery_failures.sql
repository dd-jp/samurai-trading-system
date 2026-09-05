-- Durable record of a Telegram alert send that exhausted retries (#1108).
--
-- Ten escalation alerts on 2026-09-04 were raised and never delivered, and
-- the only trace was a log line — unqueryable, and gone once the process
-- restarted. `audit_log` was considered and rejected as the home for this:
-- its existing readers (sqlite-query-store.ts's pipeline view,
-- getPipelineActivity) filter `stage IN (...)` over the seven pipeline stage
-- names, so a row parked there would be durable but invisible to every query
-- that already exists — answering "how many escalations went undelivered"
-- would still need new query surface, at which point a dedicated table costs
-- the same and reads better: `SELECT COUNT(*) FROM
-- alert_delivery_failures` is the literal question #1108 asks.
--
-- One row per SEND that exhausted `TelegramBotApiClient`'s retry policy
-- (`DEFAULT_RETRY`, 3 attempts) — not one row per attempt, and not rows for
-- sends that eventually succeeded on retry. `body` and `error` are both
-- truncated the same way an HTTP error message already is
-- (`truncateForError`, 500 chars, shared/http/response-errors.ts) so the
-- identifying content (what fired, which instrument, when) an operator needs
-- to reconstruct the alert survives without the table holding an unbounded
-- blob per row.
--
-- No PK, like `audit_log`: nothing here is looked up by row identity, only
-- counted and listed newest-first.
CREATE TABLE alert_delivery_failures (
  chat_id TEXT NOT NULL,
  method TEXT NOT NULL,
  body TEXT NOT NULL,
  error TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

-- Same shape as 0025's `audit_log` index and the same reason: newest-first
-- reads over a table that grows with history forever.
CREATE INDEX idx_alert_delivery_failures_timestamp ON alert_delivery_failures(timestamp);
