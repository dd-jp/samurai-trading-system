-- The Market Intelligence archive (#554, map #552).
--
-- Its own database file, NOT the shared store. SQLite has a single writer, MI
-- ingestion is materially higher-write than bars, and a GDELT 15-minute pull
-- must not hold the write lock while Execution is journalling a flatten to
-- `flatten_submissions`. The money path does not wait on news ingestion. This
-- adopts the scale valve `docs/specs/market-data-service-spec.md:236` documents
-- and defers; the cost is a second backup/restore story and no cross-store
-- transaction, and the latter is free because the pipeline only ever READS MI.
--
-- TWO TABLES, not one wide one. `mi_archive_raw` holds immutable vendor bytes;
-- `mi_items` holds the normalized `IntelligenceItem`s derived from them. The
-- deciding argument is re-normalizability: with the raw bytes kept, a
-- normalizer bug is fixable RETROACTIVELY across history already collected —
-- and #553 made Alpaca's 2015 history load-bearing for lookahead-safe replay.
-- A wide table could only apply a normalizer change going forward, silently,
-- over the deepest history we have.

-- Immutable vendor bytes, exactly as fetched.
CREATE TABLE mi_archive_raw (
  source       TEXT NOT NULL,
  -- TEXT, not INTEGER: this carries Alpaca's int64 news ids AND GDELT's
  -- URL-keyed records (#553 put both in v1), so the column has to hold both
  -- from the first migration rather than being widened later.
  native_id    TEXT NOT NULL,
  -- The VENDOR's revision stamp. Revisions are APPENDED as new rows rather
  -- than collapsed to first-seen (#554), so a correction is preserved
  -- alongside the text that preceded it.
  updated_at   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  -- OUR knowledge time — the visibility gate for replay (#558). Distinct from
  -- `updated_at`, and the distinction is load-bearing: a vendor can stamp a
  -- revision in the past relative to when we received it, so filtering on
  -- `updated_at` would admit a row we did not yet hold.
  ingested_at  TEXT NOT NULL,
  -- 'live' | 'backfill' (#558). GDELT backfill is equivalent to live (its
  -- batch timestamp IS the knowledge timestamp, MD5-checked). Alpaca backfill
  -- is NOT: `created_at` is publisher time, so a backfilled row asserts we
  -- would have seen the item the instant it published — optimistic by an
  -- unknown margin, and the likeliest way a promising backtest turns out to
  -- have been reading the future. Marked so a backtest cannot silently blend
  -- two lookahead guarantees and report one number.
  fidelity     TEXT NOT NULL CHECK(fidelity IN ('live', 'backfill')),
  PRIMARY KEY (source, native_id, updated_at)
);

-- Replay's hot path: "everything knowable at t", per #558.
CREATE INDEX idx_mi_archive_raw_ingested ON mi_archive_raw (ingested_at);

-- Normalized + scored items, derived from `mi_archive_raw`.
--
-- `entity` completes the key because ONE raw row yields MANY items: an Alpaca
-- news article carries a `symbols[]` array, so a single article about three
-- tickers is three items. Keying without it would silently keep one.
CREATE TABLE mi_items (
  source       TEXT NOT NULL,
  native_id    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  entity       TEXT NOT NULL,
  asset_class  TEXT NOT NULL,
  -- The item's own event time (publisher/batch time), which is what
  -- `MarketIntelligenceStore.getContext` windows on. NOT the visibility gate.
  timestamp    TEXT NOT NULL,
  -- Scored at LIVE INGEST and stored (#555/#558). Never recomputed at replay:
  -- per-item LLM scoring is non-deterministic, so re-scoring would make two
  -- runs of one backtest disagree — disqualified under ADR-0003 §2 exactly as
  -- a live LLM call inside a replayed path is.
  sentiment    INTEGER NOT NULL CHECK(sentiment IN (-1, 0, 1)),
  confidence   REAL NOT NULL,
  item_json    TEXT NOT NULL,
  ingested_at  TEXT NOT NULL,
  PRIMARY KEY (source, native_id, updated_at, entity),
  FOREIGN KEY (source, native_id, updated_at)
    REFERENCES mi_archive_raw (source, native_id, updated_at)
);

-- The read `MarketIntelligenceStore` hydration performs: one asset class,
-- everything knowable at t.
CREATE INDEX idx_mi_items_class_ingested ON mi_items (asset_class, ingested_at);
