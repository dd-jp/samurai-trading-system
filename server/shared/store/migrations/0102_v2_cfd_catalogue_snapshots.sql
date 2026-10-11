-- David, 2026-10-11 on #2118: each CFD catalogue refresh is kept here, byte for byte the file the
-- cycle reads, so Litestream backs it up and a snapshot's sha256 is the digest of its body
CREATE TABLE IF NOT EXISTS v2_cfd_catalogue_snapshots (
  as_of        TEXT PRIMARY KEY
               CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body         BLOB NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_cfd_catalogue_snapshots_no_update
BEFORE UPDATE ON v2_cfd_catalogue_snapshots
BEGIN
  SELECT RAISE(ABORT, 'v2_cfd_catalogue_snapshots is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cfd_catalogue_snapshots_no_delete
BEFORE DELETE ON v2_cfd_catalogue_snapshots
BEGIN
  SELECT RAISE(ABORT, 'v2_cfd_catalogue_snapshots is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cfd_catalogue_snapshots_no_replace
BEFORE INSERT ON v2_cfd_catalogue_snapshots
WHEN EXISTS (SELECT 1 FROM v2_cfd_catalogue_snapshots WHERE as_of = NEW.as_of)
BEGIN
  SELECT RAISE(ABORT, 'v2_cfd_catalogue_snapshots is append-only');
END;
