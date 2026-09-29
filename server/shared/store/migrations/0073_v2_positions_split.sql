ALTER TABLE v2_positions ADD COLUMN split_factor REAL NOT NULL DEFAULT 1;
ALTER TABLE v2_positions ADD COLUMN split_anchor_date TEXT;
