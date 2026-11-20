-- #2147: the one pinned cheap-model call per run (G11 ruling 3) turns qualifying lesson buckets into
-- one-sentence claims; every number stays in v2_lesson_buckets, the model writes only the claim
CREATE TABLE IF NOT EXISTS v2_lessons (
  as_of           TEXT NOT NULL,
  book_id         TEXT NOT NULL,
  bucket          TEXT NOT NULL,
  claim           TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_hash     TEXT NOT NULL,
  inputs_hash     TEXT NOT NULL,
  trace_id        TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  PRIMARY KEY (as_of, book_id, bucket),
  FOREIGN KEY (as_of, book_id, bucket) REFERENCES v2_lesson_buckets (as_of, book_id, bucket)
);

CREATE TRIGGER IF NOT EXISTS v2_lessons_no_update
BEFORE UPDATE ON v2_lessons
BEGIN
  SELECT RAISE(ABORT, 'v2_lessons is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_lessons_no_delete
BEFORE DELETE ON v2_lessons
BEGIN
  SELECT RAISE(ABORT, 'v2_lessons is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_lessons_no_replace
BEFORE INSERT ON v2_lessons
WHEN EXISTS (
  SELECT 1 FROM v2_lessons
  WHERE as_of = NEW.as_of AND book_id = NEW.book_id AND bucket = NEW.bucket
)
BEGIN
  SELECT RAISE(ABORT, 'v2_lessons is append-only');
END;
