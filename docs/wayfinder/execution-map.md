# Wayfinder Map: Execution (thin actor — pipeline tail)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/execution-spec.md](../specs/execution-spec.md).

## Destination

Design the **Execution** component — the thin actor at the tail of the pipeline (NOT one of the 6 pipeline stages). It acts on a Verdict `go`, expands the abstract `OrderIntent` bracket into broker-native multi-leg orders behind the mandatory broker abstraction (ccxt for crypto / IBKR for stocks), writes fills/positions/closed-trades to the shared SQLite store, dedupes on the Trader-assigned idempotency key so crash-restart never double-submits, and handles partial fills, retries, rate limits, and position reconciliation vs the broker. Destination = docs/specs/execution-spec.md.

## Notes

- Upstream: Verdict `VerdictDecision` (`status: 'go'`, the possibly-trimmed `OrderIntent`, `idempotency_key`, `timestamp`). Only `go` decisions reach Execution. See [verdict-spec.md](../specs/verdict-spec.md).
- Downstream: the **shared SQLite store** — Execution is the sole writer of positions/fills/closed-trades. Read by the portfolio-accounting view (Risk, Stage 4), the Feedback Loop (Stage 6, outcomes + setup labelling), and the Trader (Stage 3, position awareness). See [risk-manager-spec.md](../specs/risk-manager-spec.md), [feedback-loop-spec.md](../specs/feedback-loop-spec.md), [trader-spec.md](../specs/trader-spec.md).
- Broker: **abstraction mandatory** — strategy code / `OrderIntent` must never know which broker. Kraken (paper first) / Coinbase Advanced via ccxt; IBKR for stocks (techstack.md). A **simulated** adapter serves backtest/paper on the same code path.
- CONTEXT.md: "Verdict triggers → Execution (idempotent orders)"; "Execution produces fills → Feedback Loop". Invariants: crash-restart must not lose open positions (#5); every fill logged (#4); idempotent orders (Idempotent Order glossary).
- Apply research constraints (docs 00/01/02): realistic transaction-cost modelling in the sim path (Execution *consumes* the cost model — a separate component — it does not build it); backtest = paper = live on one code path so measured costs are honest.
- Grill one question at a time; wayfinder produces decisions, not code.

## Decisions so far

- **Role = thin mechanical actor, no LLM, gate-vs-actor split.** Verdict decides; Execution acts. Execution never re-evaluates the trade — it places what Verdict cleared. Deterministic and backtestable (same discipline as Trader/Risk/Verdict).

- **Two surfaces, not one — the bracket lifecycle is async and outlives a single call.** A bracket's protective exit leg can fill *days* later (stocks). So Execution exposes:
  1. `execute(verdictDecision) -> ExecutionResult` — the **primary test seam**. Dedupe → expand bracket → submit → persist initial order/position state → return. It does NOT block to "filled".
  2. `ingestFills() / reconcile()` — a **secondary surface** that ingests later fills (WebSocket/poll live; simulated-adapter callbacks in replay), advances the order state machine, and on round-trip-to-flat emits/persists a `ClosedTrade`. Mirrors the Feedback Loop's multi-method seam (`runDailyCycle` + `onTradeClose` + `computeMetrics`). Without this second surface the design cannot close trades or feed the Feedback Loop.

- **Broker abstraction = a `BrokerAdapter` interface over a normalized bracket.** Execution hands the adapter a broker-agnostic bracket; each adapter (ccxt-Kraken/Coinbase, IBKR, Simulated) maps it to native multi-leg orders and normalizes broker fills/positions/order-state back. The abstract contract guarantees **atomic bracket with one-cancels-other (OCO) exit semantics** at the boundary; adapters fulfil it natively (IBKR bracket / OCA group) or via **Execution-managed emulation** (ccxt/Kraken, where native OCO/attached-close is limited — Execution places the entry, then arms stop+target and cancels the sibling when one fills). The layer above the adapter never sees the difference.

- **Idempotent submission keyed on the Trader's `idempotency_key = hash(instrument + bar/timestamp)`.** Belt-and-suspenders dedup: (1) **local** — before submit, check the shared store for an existing order/fill under this key → skip if present (this is also Verdict's dedup gate; Execution re-checks because it is the last line before money moves and may be re-entered on crash-restart); (2) **broker-native** — pass the key (or a deterministic derivation) as the broker **client order ID**, so a duplicate submit is rejected/deduped by the venue itself. Result: submitted N times → exactly one fill (Idempotent Order invariant).
  - *Note:* uses `hash(instrument + bar/timestamp)` per trader-spec.md / CONTEXT.md / verdict-spec.md — NOT `debate_id` (debate_id is volatile across the Debate Engine's re-run-from-scratch). trader-map.md line 30 still shows a stale `debate_id +` prefix; the spec is canonical.

- **Order state machine:** `pending → submitted → partially_filled → filled → (bracket armed) → closed`, with terminal `cancelled` / `rejected` / `expired`. Persisted at every transition (write-ahead before submit) so a crash mid-flight is recoverable. Partial fills are first-class: the state lingers in `partially_filled` and the protective legs are sized to *filled* quantity.

- **Crash-restart safety = write-ahead + reconcile against the broker as source of truth.** Execution writes the intended order (state `pending`, keyed by idempotency_key) to the store *before* calling the broker. On restart it (a) finds in-flight `pending`/`submitted` records and (b) queries the broker by client-order-id to learn whether the order actually landed, then corrects the store. The broker is the tie-break authority; on any store-vs-broker mismatch the store is corrected and the divergence logged/alerted (dead-man's-switch philosophy). This reconciliation is also what actually prevents a double-submit after a crash.

- **Partial-fill / retry / rate-limit resilience.**
  - **Partial fills:** protective stop+target legs size to *filled* quantity, not requested; persist BOTH requested and filled size (plus avg_fill_price and fees) so downstream R and exposure are computed on reality, never intent.
  - **Retries:** transient broker errors (network, 5xx, timeouts) → bounded exponential backoff with jitter; non-transient (rejected: insufficient funds / bad instrument / min-size) → terminal `rejected`, logged, no retry.
  - **Rate limits:** a per-adapter token-bucket throttle plus backoff on 429/pacing violations. **Broker rate limits ≠ the LLM/Claude rate limit.** CONTEXT.md invariant 6 / CLAUDE.md "HARD STOP" govern *LLM usage* limits on the LLM-bearing stages (Analysts/Debate); Execution is mechanical and LLM-free, so that rule never touches its broker path — a broker 429 is a resilience event (throttle + retry), not a system halt. Persistent broker errors do feed the operational latency/error halt (Risk's kill-switch path), but that is a halt-new-entries signal, not the LLM hard stop.

- **Fill / trade-record schema — the load-bearing cross-spec deliverable.** Three record types in the shared store, all written by Execution (see spec for full fields):
  1. **`OpenPosition` / open-order** — live state for Trader position-awareness and Risk exposure (instrument, asset_class, side, size, avg entry, current bracket stop/target, order-state, broker order ids, idempotency_key, debate_id).
  2. **`Fill`** — one row per (partial) fill (idempotency_key, broker fill id, price, qty, fee, timestamp, leg = entry|stop|target|exit); partials append.
  3. **`ClosedTrade`** — emitted on round-trip-to-flat: the entry bracket (**entry, stop, size**), realized PnL net of fees, `debate_id`, `idempotency_key`, open/close timestamps, asset_class, side. This is exactly what the Feedback Loop's `onTradeClose(ClosedTrade)` and setup-store R-labelling consume (`R = realized PnL ÷ initial risk`, `initial risk = |entry − stop| × filled_size`) and what Risk's realized PnL / consecutive-loss accounting reads. **The Feedback Loop spec references `ClosedTrade` but never defines it — Execution defines it. Headline cross-spec addition.**

- **Scale-in = per-lot accounting (v1).** The Trader can emit `intent_type: 'scale_in'`. To preserve the Feedback Loop's single-entry-bracket `R = |entry−stop|×size` assumption, each `entry`/`scale_in` is tracked as **its own lot** with its own bracket, `debate_id`, and `ClosedTrade`/R at close. Blended-average-position accounting is deferred (v2). `execute()` routes all three `intent_type`s: `entry`/`scale_in` open a bracketed lot; `exit` flattens the position (market/limit close, no attached protective bracket — the exit *is* the close).

- **Backtest / paper / live on one code path.** The only difference is which `BrokerAdapter` is injected. The **Simulated adapter** is deterministic: it fills against the injected clock and the injected **cost model** (transaction-cost + market-impact — a separate uncharted component Execution *consumes*, does not design), emitting the same normalized fills/positions the live adapters do. Paper trading = live market data + Simulated (or Kraken paper) adapter. So measured slippage/costs are comparable live-vs-backtest (research docs 00/01/02 Stage 1/3).

- **Thin on notifications.** Execution writes fills to the store and returns an `ExecutionResult`; it does NOT own the Telegram/Discord trade channel (Verdict does — verdict-spec story 14). Who-posts-fills is a light wiring concern (Verdict/orchestrator reads the fill and posts), not Execution logic.

## Frontier

All frontier decisions resolved. Map complete.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

1. **`ClosedTrade` contract (NEW — defined here, must be adopted).** The Feedback Loop spec's `onTradeClose(trade: ClosedTrade, ...)` names `ClosedTrade` but never defines it. Execution is the producer and defines it (see spec). Fields the Feedback Loop and Risk MUST rely on: `entry`, `stop`, `filled_size`, `realized_pnl_net` (net of fees), `debate_id`, `idempotency_key`, `asset_class`, `side`, `opened_at`, `closed_at`. Reconcile into feedback-loop-spec.

2. **Shared-store trade record persists the entry bracket + `debate_id` (already required by FL/Trader — Execution fulfils it).** feedback-loop-spec line 130 and feedback-loop-map require the trade record to carry `(entry, stop, size) + debate_id` so `R = |entry−stop|×size` and the attribution join compute at close. Execution is the writer that satisfies this. `debate_id` therefore flows Trader → `OrderIntent.metadata` → Verdict → Execution → `Fill`/`OpenPosition`/`ClosedTrade`. Confirm `OrderIntent.metadata.debate_id` survives the Verdict handoff (Verdict carries the full `order`, so it does).

3. **Requested-vs-filled size is a contract, not a detail.** Downstream (Risk exposure, FL R) must read `filled_size` + `avg_fill_price`, never requested size, for a partially-filled position. Flagged so the accounting view and FL adopt the filled fields.

4. **Broker is source-of-truth for the position store (already in trader-map/risk-map).** Execution owns the reconciliation routine; the position store is "reconciled against the broker as source of truth." Confirmed consistent — Execution is where that reconciliation actually runs.

5. **Second consumer note stays intact.** Risk's mark-to-market and FL's metrics need *current* price from the Market Data Service; Execution supplies *fills/positions/realized PnL*, not marks. No conflict — just confirming Execution does not owe current marks.

## Out of scope

- **Verdict gating / go-no-go** (Stage 5) — Execution trusts a `go`; it does not re-decide (beyond the mechanical idempotency re-check).
- **The transaction-cost / market-impact model** — a separate uncharted component. Execution *consumes* it in the Simulated adapter; it does not design it (same treatment as the backtest harness in feedback-loop-spec).
- **The Market Data Service** — separate Stage 0 component; supplies current marks to Risk/FL, not to Execution.
- **Portfolio-accounting view / metrics / R computation** — Risk (Stage 4) and Feedback Loop (Stage 6) own these; Execution supplies the raw fills/closed-trades they read.
- **Trade-channel provisioning + fill/no-go notifications** — Verdict owns the channel (ops setup); Execution only writes fills.
- **Kill-switch / circuit-breaker decisions** — Risk/Verdict own the decision to halt; Execution obeys (does not place new orders while halted). **Forced liquidation** may be exposed as an Execution capability (a `flatten`), but *deciding* to flatten (emergency module / kill-switch) is out of scope — risk-manager-spec defers "forced liquidation" to "a separate emergency module or Execution."
- **Exact values** — retry/backoff counts, throttle rates, reconciliation cadence, poll intervals are config, tuned in paper trading.
