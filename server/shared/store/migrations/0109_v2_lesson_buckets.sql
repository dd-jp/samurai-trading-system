-- #2147: G11's code statistics over settled debate outcomes, one row per qualifying bucket per as_of.
-- A rerun at the same as_of must reproduce these rows exactly, so nothing here reads the wall clock
CREATE TABLE IF NOT EXISTS v2_lesson_buckets (
  as_of                 TEXT NOT NULL,
  bucket                TEXT NOT NULL,
  book_id               TEXT NOT NULL,
  n                     INTEGER NOT NULL CHECK (n > 0),
  mean_excess           REAL NOT NULL,
  hit_rate              REAL NOT NULL,
  ci_low                REAL NOT NULL,
  ci_high               REAL NOT NULL,
  baseline_book_id      TEXT NOT NULL,
  baseline_n            INTEGER NOT NULL,
  baseline_mean_excess  REAL,
  evidence              TEXT NOT NULL CHECK (json_valid(evidence)),
  inputs_hash           TEXT NOT NULL,
  schema_version        INTEGER NOT NULL,
  PRIMARY KEY (as_of, book_id, bucket)
);

CREATE TRIGGER IF NOT EXISTS v2_lesson_buckets_no_update
BEFORE UPDATE ON v2_lesson_buckets
BEGIN
  SELECT RAISE(ABORT, 'v2_lesson_buckets is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_lesson_buckets_no_delete
BEFORE DELETE ON v2_lesson_buckets
BEGIN
  SELECT RAISE(ABORT, 'v2_lesson_buckets is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_lesson_buckets_no_replace
BEFORE INSERT ON v2_lesson_buckets
WHEN EXISTS (
  SELECT 1 FROM v2_lesson_buckets
  WHERE as_of = NEW.as_of AND book_id = NEW.book_id AND bucket = NEW.bucket
)
BEGIN
  SELECT RAISE(ABORT, 'v2_lesson_buckets is append-only');
END;
