-- Per-call Anthropic token usage, priced locally (#: provider balances on the
-- dashboard).
--
-- WHY THIS TABLE EXISTS AT ALL: Anthropic publishes no credit-balance
-- endpoint. `GET /v1/organizations/balance` is a 404, and the only monetary
-- surface — the Usage & Cost Admin API (`/v1/organizations/cost_report`) —
-- needs a separate `sk-ant-admin01-` key AND an Organization, which is
-- explicitly unavailable to individual accounts. There is therefore no
-- provider-side number to render, and the honest substitute is a meter this
-- system owns: what THIS bot spent, counted from the `usage` block Anthropic
-- returns on every Messages API response.
--
-- Read that scope limit literally. This is bot spend, not account spend: it
-- cannot see Console usage, another machine running the same key, or anything
-- that happened before this table existed. A tile labelled "balance" over this
-- data would be a lie; the dashboard labels it "spend (metered locally)".
--
-- ONE ROW PER API CALL, not per tick or per debate. A debate round issues
-- several calls, and rolling them up at write time would discard exactly the
-- breakdown that makes an unexpected bill diagnosable (which model, which
-- stage, how much of it was cache). Aggregation is the reader's job — the
-- dashboard's `getLlmSpend` sums with a `WHERE timestamp >= ?`.
--
-- `cost_usd` IS NULLABLE ON PURPOSE. Pricing is a hardcoded rate table
-- (shared/llm/pricing.ts) that cannot know a model released after this
-- code shipped. Storing 0.0 for an unpriced model would silently understate
-- the total and look identical to a genuinely free call; NULL forces the
-- reader to show "unpriced" and keeps the token counts — which are always
-- exact, straight off the wire — usable regardless. Same reasoning as
-- `DailyPnl` being a tagged union rather than `number | null`: an unknown must
-- not be representable as a plausible-looking zero.
--
-- Token columns are NOT NULL with a 0 default because the API omits the cache
-- fields entirely when no caching occurred; absent means zero there, and that
-- is a real zero rather than an unknown.
--
-- `timestamp` is ISO-8601 UTC TEXT (`toISOString()`), matching every other
-- time column in this schema — the dashboard's window filter is a
-- lexicographic TEXT comparison, correct only because every writer is
-- fixed-width, zero-padded and Z-suffixed.
CREATE TABLE llm_spend (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id                     TEXT    NOT NULL,
  stage                        TEXT    NOT NULL,
  model                        TEXT    NOT NULL,
  input_tokens                 INTEGER NOT NULL DEFAULT 0,
  output_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd                     REAL,
  timestamp                    TEXT    NOT NULL
);

-- The dashboard's only access pattern is "sum the last N hours/days", which is
-- a range scan on `timestamp` alone. Mirrors 0005_hot_path_indexes.sql's
-- posture: index the read the operator surface actually issues, nothing else.
CREATE INDEX idx_llm_spend_timestamp ON llm_spend(timestamp);
