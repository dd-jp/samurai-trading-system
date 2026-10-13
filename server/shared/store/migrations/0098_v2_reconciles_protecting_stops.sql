-- #2090: the closing stops a broker reconcile counted as protection for each held name, as JSON;
-- NULL where the broker was not read and on rows journalled before this migration
ALTER TABLE v2_reconciles ADD COLUMN protecting_stops TEXT;
