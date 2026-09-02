-- Persist the quote and decision price at order submit (#1001).
--
-- THE GAP THIS CLOSES. `fills` records a fill price and, on the Simulated
-- adapter only, a modelled cost breakdown (0001_init.sql). Nothing anywhere
-- records what the system BELIEVED before it acted: the price the Trader
-- decided at, or the bid/ask the venue was quoting the instant the order was
-- submitted. Without those, a real-broker fill's realised half-spread and
-- realised slippage cannot be computed at all — there is nothing to diff the
-- fill price against.
--
-- SHAPE: six columns, added to BOTH `open_positions` (the bracket/entry path)
-- and `flatten_submissions` (the exit path, which writes no `OpenPosition` —
-- see 0019's own doc for why the two tables are the parallel write-aheads),
-- plus a seventh on `fills` alone (`flatten_idempotency_key` — see below)
-- that makes the exit-leg join unambiguous.
--
--   decision_price             -- OrderIntent.entry: the price the Trader's
--                               -- decision was formed at (decide.ts's
--                               -- `mark.price`, unchanged through Debate/
--                               -- Risk/Verdict). NOT the post-tick-rounding
--                               -- wire price `alpaca-adapter.ts` submits
--                               -- (`broker_brackets.entry_price` already
--                               -- carries that, joinable by
--                               -- (venue, client_order_id) — see the #1001
--                               -- PR description for the proof query).
--   quote_bid / quote_ask      -- The venue quote's own two sides, read at
--                               -- submit time via `MarketDataService.getQuote`
--                               -- (added by this same change) — genuinely
--                               -- observed, never derived from a scalar
--                               -- spread. NULL together on any source that
--                               -- does not implement `DataSource.fetchQuote`
--                               -- (Alpaca's own `AlpacaDataSource` is one —
--                               -- see that source's file doc) rather than a
--                               -- fabricated pair.
--   quote_mid                  -- (quote_bid + quote_ask) / 2 — a real
--                               -- derived midpoint of the SAME observed
--                               -- quote, not a separately-fetched mark. NULL
--                               -- iff the bid/ask pair is.
--   quote_observed_at          -- The quote's own timestamp (`Quote.observed_at`),
--                               -- distinct from `decision_timestamp` (when the
--                               -- Trader decided) and `opened_at`/`submitted_at`
--                               -- (when Execution wrote ahead) — the pipeline
--                               -- latency between Trader and Execution means
--                               -- these three can genuinely differ.
--   modelled_cost_breakdown_json -- JSON {spread_cost, commission, slippage,
--                               -- market_impact}, computed via the SAME
--                               -- `CostModel.fill()` the Simulated adapter
--                               -- calls (cost-model-backtest-spec.md), against
--                               -- a `MarketState` assembled the same way
--                               -- (`SimulatedBrokerAdapter.buildMarketState`'s
--                               -- pattern, reused). This is the "modelled"
--                               -- figure `fills.cost_breakdown_json` copies
--                               -- onto a real-broker fill (proration by fill
--                               -- qty share where one snapshot covers several
--                               -- fill rows — see `ingest-fills.ts`'s `toFill`
--                               -- and `redistributeOneFlatten`).
--
-- BEST-EFFORT, NEVER BLOCKING. Every one of these six is nullable and every
-- writer captures them in a try/catch that degrades to NULL on any failure —
-- see `execute.ts`'s `captureSubmitSnapshot`. This mirrors #826's mandatory
-- flat-by-close design: a stalled feed must never delay or refuse an order,
-- entry or exit. `execute.ts` also skips the read entirely when
-- `order.metadata.unpriced_exit` is set (the feed was already known dark this
-- tick — re-probing it inside the flatten window would just be a second
-- chance to hang).
--
-- ALPACA PAPER CAVEAT (see the #1001 issue and PR description): Alpaca's own
-- `AlpacaDataSource` does not implement `fetchQuote`, so on the paper venue
-- `quote_bid`/`quote_ask`/`quote_mid`/`quote_observed_at` are NULL for every
-- row and `modelled_cost_breakdown_json`'s `spread_cost` falls back to the
-- cost model's volatility-derived estimate. `decision_price` and
-- `modelled_cost_breakdown_json`'s other components are still populated.
-- Alpaca also books `fee = 0.0`, so the commission floor stays unvalidatable
-- there regardless of instrumentation — only the live Saxo leg (which has an
-- LSE mark source with real bid/ask) can validate spread AND commission
-- together. The schema exists everywhere now so it does not have to be added
-- again before that leg trades.
--
-- A SEVENTH column, on `fills` alone: `flatten_idempotency_key`. An exit
-- fill produced by `redistributeOneFlatten` is persisted under the LOT's
-- own `idempotency_key` (`fills`' PK convention — see 0001_init.sql), which
-- loses the link to the specific `flatten_submissions` row that priced it.
-- A lot can be partially flattened more than once (#571's residual re-arm
-- path), so more than one `flatten_submissions` row can legitimately name
-- the same lot — joining `fills` back to `flatten_submissions` by lot key
-- and timestamp proximity alone would be ambiguous in that case.
-- `redistributeOneFlatten` already holds the answer unambiguously (it looks
-- `getFlattenAttribution` up BY the flatten's own key before re-keying the
-- split fill to the lot), so this column just carries it through to the
-- persisted row. NULL on `'entry'`/`'stop'`/`'target'` fills (no flatten
-- submission behind those) and on any `'exit'` fill from before this
-- migration.
--
-- Plain ADD COLUMN, following 0030's convention: additive, nullable, no CHECK
-- constraint. NULL on every row written before this migration is the honest
-- reading — the value was never captured, not any particular number.

ALTER TABLE open_positions ADD COLUMN decision_price REAL;
ALTER TABLE open_positions ADD COLUMN quote_bid REAL;
ALTER TABLE open_positions ADD COLUMN quote_ask REAL;
ALTER TABLE open_positions ADD COLUMN quote_mid REAL;
ALTER TABLE open_positions ADD COLUMN quote_observed_at TEXT;
ALTER TABLE open_positions ADD COLUMN modelled_cost_breakdown_json TEXT;

ALTER TABLE flatten_submissions ADD COLUMN decision_price REAL;
ALTER TABLE flatten_submissions ADD COLUMN quote_bid REAL;
ALTER TABLE flatten_submissions ADD COLUMN quote_ask REAL;
ALTER TABLE flatten_submissions ADD COLUMN quote_mid REAL;
ALTER TABLE flatten_submissions ADD COLUMN quote_observed_at TEXT;
ALTER TABLE flatten_submissions ADD COLUMN modelled_cost_breakdown_json TEXT;

ALTER TABLE fills ADD COLUMN flatten_idempotency_key TEXT;
