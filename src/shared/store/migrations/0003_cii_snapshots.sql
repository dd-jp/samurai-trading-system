-- Market Intelligence — owner: docs/specs/market-intelligence-spec.md
-- Post-launch history capture for #182: no CII time series exists anywhere
-- (ADR-0002 §6), so the drawdown-correlation study #173 couldn't run is
-- blocked on Samurai accumulating its own. One append-only row per
-- (country, capture time); a missing/null read from the provider records no
-- row at all rather than a NULL score (avoids silently corrupting AVG(score)
-- once the correlation study runs).
CREATE TABLE cii_snapshots (
  country_code  TEXT NOT NULL,
  score         REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  captured_at   TEXT NOT NULL,
  PRIMARY KEY (country_code, captured_at)
);
CREATE INDEX idx_cii_snapshots_captured_at ON cii_snapshots(captured_at);
