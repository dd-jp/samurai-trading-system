-- The age-out clock for fills the venue reports filled but cannot price (#298).
--
-- An Alpaca order with a positive `filled_qty` and a null `filled_avg_price`
-- is the venue contradicting itself. The adapter refuses to book it — a zero
-- price is a fabricated one, and it flows straight into the lot's weighted
-- average, realized PnL, the R-multiple and the Feedback Loop's weighting — and
-- relies on the next poll re-offering it priced. That is right for the common
-- (transient) case and silently wrong for the permanent one: if the venue never
-- supplies a price, the fill is never ingested, the lot sits under-filled
-- forever, its stop is never resized to the real quantity, no `ClosedTrade` is
-- ever emitted, and NOTHING escalates. During an unattended soak (#238) that is
-- an invisible stuck lot.
--
-- This table is the missing memory: one row per unpriced fill, stamped with
-- when it was FIRST seen. Past a configurable age the adapter escalates it to
-- an operator alert once, records that it did, and stops. The row is deleted
-- the moment the venue prices the fill and it is ingested normally.
--
-- WHY DURABLE. The clock has to outlive the process, or a restart resets every
-- age to zero and a 14-day unattended run with a nightly restart ages nothing
-- out at all — the failure mode is precisely "nobody was watching", so the
-- in-memory version would satisfy a test and not the requirement.
--
-- WHY NOT `broker_observed_fills`. That table is the ccxt adapter's queue of
-- fills that ARE priced and are waiting to be drained; `price` is NOT NULL
-- there, and making it nullable would put an unpriced row on the path that
-- feeds `ingestFills()` — the exact thing this whole ticket refuses to do. A
-- fill we cannot price is not a fill in the queue; it is an anomaly under
-- observation, which is a different grain with a different lifecycle (it is
-- deleted on resolution, whereas observed fills are append-only).
--
-- WHY NOT `open_positions`. Same reason 0007 gives: that table is the lot's
-- system-of-record above the broker seam, and venue bookkeeping does not belong
-- in it. Nothing above the adapter may learn that a venue needs hand-holding.
--
-- NO PRUNING, deliberately, and for 0007's reason: a row may only be dropped
-- once its fill is certainly resolved, and the only two things that know that
-- are (a) the adapter, which deletes the row itself when the fill finally
-- prices, and (b) a human who acted on the alert. Inventing a retention window
-- here would silently forget an unresolved anomaly — the failure the table
-- exists to prevent. Growth is bounded by how often the venue misprices a fill,
-- which is not a routine event.
--
-- `venue` is in the primary key for 0007's reason: the column is venue-agnostic
-- by design (any adapter that refuses an unpriceable fill can use it), so two
-- adapters over one database must never collide on a shared client order id.
-- Only the Alpaca adapter writes here today.
CREATE TABLE broker_unpriced_fills (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca')),
  -- Carries `open_positions.idempotency_key`, as in `broker_brackets` — the
  -- broker-native idempotency handle, named in the adapter's vocabulary.
  client_order_id  TEXT NOT NULL,
  -- The venue order id the fill would have been booked under, so an alert
  -- recipient can look it up on the venue's own dashboard.
  broker_fill_id   TEXT NOT NULL,
  leg              TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  -- Denormalized from the bracket parent rather than joined: the alert has to
  -- name the symbol and quantity to be actionable, and a row here must stay
  -- readable after whatever happened to the bracket row.
  instrument       TEXT NOT NULL,
  -- The quantity the venue claims filled — the reason this is an anomaly at
  -- all, since a zero-quantity report is simply "nothing filled yet".
  qty              REAL NOT NULL,
  -- Set once, on insert, and never updated. THE age-out clock.
  first_seen_at    TEXT NOT NULL,
  -- Refreshed every sweep that still sees it unpriced; diagnostic only, so an
  -- operator can tell "still happening" from "went quiet without resolving".
  last_seen_at     TEXT NOT NULL,
  -- Null until the age-out alert has actually been delivered. Set only AFTER
  -- the channel accepted it, so a failed delivery is retried next sweep rather
  -- than being recorded as an alert nobody received; non-null suppresses
  -- re-alerting, so a permanent anomaly does not page every poll forever.
  alerted_at       TEXT NULL,
  PRIMARY KEY (venue, client_order_id, broker_fill_id)
);
