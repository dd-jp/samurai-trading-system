# Codebase Review — 2026-08-06

Full-codebase hostile review at HEAD `c06c0cc`: architecture, data/API cost flow, complexity, readability. Three parallel exploration passes (architecture map, external-data audit, code-quality audit), every load-bearing claim then re-verified by direct source read. Suggestions only — each code change below is approved per-item before implementation.

Scope discipline: `docs/reviews/code-quality-2026-08-05.md` and `spec-conformance-2026-08-05.md` already litigated comment density (ruled an asset), the 16 bare-catch blocks (all cleared), and findings M1–M4/P1–P4/L1–L3. Those are referenced, not re-filed. This review reports what is new, changed, or previously out of scope (dead-code sweep, data-cost flow).

---

## Premise correction: the Polygon subscription

The review was commissioned partly on the premise "we pay $49/mo for Polygon pro to fetch 5-year data." Verified against in-repo probes (`docs/research/08-stage2-verdict-first-real-run-2026-08-05.md:54-66`, `09-…:127-140`, both 2026-08-05):

- The key serves **2-year** history on both asset classes — free-tier depth. A 3-year request returns `{"status":"NOT_AUTHORIZED","message":"Your plan doesn't include this data timeframe."}`.
- There are **zero scheduled Polygon data calls** in the codebase. Total data load: 6 requests per manual Stage-2 script run (`run-stage2.ts`, no npm script, hand-invoked).
- The only recurring Polygon traffic is the dashboard reachability probe: `/v1/marketstatus/now` every 60s = **1,440 calls/day** (`src/dashboard/provider-status.ts:136,150`), fetching no data.

**Decision (David, 2026-08-06): Polygon drops to free tier; Tiingo fetches 5-year history once, cached locally.** Billing-page action is David's; code consequences are A1–A5 below.

---

## A. Data layer

| # | Finding | Evidence | Suggested fix |
|---|---|---|---|
| A1 | Polygon has no venue pacing (spec-audit F-13 still open) — free tier allows 5 calls/min | `src/shared/http/venue-pacing.ts:38` `VenueKey = 'alpaca'\|'ccxt'\|'ibkr'` | Add polygon pacing (~15s between symbols) or sleep in the ingest loop |
| A2 | No Tiingo integration exists (zero refs repo-wide) | — | New `TiingoClient` implementing the client interface `Stage2HistoricalStore.ingest()` consumes (`src/cost-model-backtest/http-polygon-client.ts:77` shape); one-time 5yr ingest for the 6-symbol universe; `TIINGO_API_KEY` in `.env.local`, never committed. Tiingo free tier (~50 req/hr, 1000/day, decades of EOD depth — verify at signup) trivially covers 6 symbols |
| A3 | Duplicate OHLCV schema justified by a claim that was never true: `stage2_bars` header says the shared `bars` table "doesn't exist yet" — it exists in the very first migration with identical columns and PK | `src/cost-model-backtest/stage2-historical-store.ts:6-9` vs `src/shared/store/migrations/0001_init.sql:7-18` | Migrate Stage-2 storage onto shared `bars` (the `source` column distinguishes provenance), or minimum: correct the false comment and document the split as deliberate |
| A4 | Primary Stage-2 caller bypasses its own idempotent cache: `dbPath ?? ':memory:'` re-fetches all 6 symbols every run. (The scratch-store/shared-store split itself is deliberate — `run-stage2.ts:178,530`; only the volatility of the scratch path is the defect) | `src/scripts/run-stage2.ts:311` vs persisting siblings `run-stage2-cost-decomposition.ts:192-195`, `run-spread-calibration.ts:257-260` | Default the scratch path to a persistent file under `data/`. One line |
| A5 | Dashboard Polygon probe alone breaches free-tier rate limits: 1,440 authenticated calls/day for a reachability tile | `src/dashboard/provider-status.ts:136` `DEFAULT_POLL_INTERVAL_MS = 60_000`, `:150` probe path | Raise interval to ≥15 min and/or gate behind env flag |
| A6 | Daily EOD refresh of the local history store: **deferred**. Pinned-window design means Stage-2 reruns don't need fresh bars; build only when rerun cadence is known | `run-stage2.ts:161-164` `STAGE2_PINNED_WINDOW` | None now |
| A7 | `getMark` refetches the venue quote unconditionally on every call in live mode — no TTL, several call sites per instrument per tick | `src/market-data-service/service.ts:144` | Short (seconds) per-instrument mark TTL |

Also noted: the ADR-0008 $50/14d cap meters `llm_spend` only (`src/debate-engine/llm/spend-cap.ts:158`) — Polygon/Alpaca/Tiingo traffic sits entirely outside any budget guard. Acceptable while they're free tiers; worth remembering if a paid data SKU returns.

## B. Safety-critical correctness (highest priority)

**B1 — A tripped circuit breaker does not survive restart.** `breaker_state` table exists (`0001_init.sql:172`); `RiskDecision.next_breaker_state` is produced every tick; `risk-manager/types.ts:264` promises "the caller persists this to the `breaker_state` table so a restart survives a tripped breaker" — and **no non-test `INSERT`/`SELECT` on `breaker_state` exists anywhere**. `ProductionConfig.initialBreakerState` is consumed (`production.ts:1434`) and supplied by nothing. Under ADR-0007 (no human gate) the breakers are the only remaining stop; a 14-day soak on a laptop will restart. Fix: persist `next_breaker_state` after the risk stage, load at boot, smoke assertion per coding-standards §"Wiring a mechanism".

**B2 — Fill-ingest crash gap is unrecoverable by design of its own dedup.** `advanceLot()` (`src/execution/ingest-fills.ts:62-102`) does three separate un-transacted writes: `writeFill` → `updatePositionFill` → `writeClosedTrade`. Only two `.transaction(` sites exist in all non-test src, neither in execution. Crash between writes → next poll's `hasFill()` returns true → early return → `filled_size`/`avg_entry_price`/`closed_trades` never repaired. `reconcile()` explicitly scopes itself to `pending`/`submitted` and cannot repair it either. Risk's exposure caps then compute from a permanently stale position, and the Feedback Loop never sees the round trip. Fix: one `better-sqlite3` transaction around the three writes.

**B3 — Risk critic (ADR-0003 step 7) fails open silently.** `src/risk-manager/critic.ts` does not exist; `direct-bind.ts:267` references it in prose; `RiskDecision.reasons` cannot distinguish "critic passed" from "critic never ran". Minimum: record `critic_skipped` explicitly. Full: build the producer or descope by ADR note.

**B4 — Three account-state reads per instrument per tick.** `computeCurrentPortfolioAndBreakers` called independently by trader/risk/verdict steps (`direct-bind.ts:139/:248/:364`), each hitting account state, market data, volatility, open positions — three reads can observe three different portfolios within one tick, contradicting the "single source" comment at `:137`. Fix: fetch once per instrument-tick, thread the value.

## C. Dead code — ~1,900+ lines with zero non-test, non-barrel consumers

- `CcxtBrokerAdapter` (1,195 lines), `IbkrBrokerAdapter` (527) — including three interface methods recently implemented on adapters nothing constructs
- `createDataSource` (`market-data-service/source-factory.ts`) — zero consumers, itself the sole constructor of `CcxtDataSource`/`IbkrDataSource`
- `InMemoryRiskCriticStore`, `TradeChannel` (composite-channel), `captureCiiSnapshot` + `SqliteCiiSnapshotStore`, `formingCandleClient` (test fixture in prod source), `TelegramApprovalGateway` (descoped by ADR-0007 — production wires `UnwiredApprovalChannel` which throws)
- Tables with no writer: `breaker_state` (wire it — B1), `strategy_params`

Recommendation: **delete; git history is the attic.** "Dual-target from day one" (CLAUDE.md) is exactly how this repo's dominant defect class (9× recurrence, coding-standards §smoke) breeds — unconstructed code that reads as capability. Restore from history when a second venue is actually wired. David decides delete vs keep.

## D. Structure / complexity

1. **`production.ts` (2,269 lines) regressed past the prior audit.** L1 filed `buildProductionComponents` at 270 lines; it is now **467**, plus `buildProductionOrchestrator` **488**, `start` **251**, `ProductionConfig` **315** (44 flat fields). Split into per-concern wiring modules under `src/orchestrator/production/` (stores / clients / stages / timers), keeping the `direct-bind.ts` pattern; group `ProductionConfig` into sub-configs.
2. **No env seam.** 23 env vars read across 16 files + `paper-profile.ts` literals + injected config = three overlapping resolution mechanisms, precedence documented only in prose. Centralize `process.env` parsing into one module consumed by `startFromEnvironment`.
3. **Section-header comments mark extraction seams never taken.** `risk-manager/index.ts` `evaluate` (192 lines): "Step 1…Step 8" comments (`:192-315`) over bare `{}` scoping blocks — a block scope under a header comment *is* a function that wasn't extracted. Extract 8 named gate predicates returning the uniform trim/reason shape. Same pattern: `feedback-loop/daily-cycle.ts` (Dial 1/2/3), `smoke-run.ts` `evaluateSmokeGate` (189 lines).
4. **`paper-profile.ts` is 82% comments applying a taxonomy in prose.** The SPEC/DERIVED/UNSOURCED provenance labels per value are data expressed as comments. Typed provenance field per entry → greppable, and testable ("no UNSOURCED value ships to live").
5. **Dashboard and runner disagree on the stage count.** Runner: 6 stages (`orchestrator/types.ts:77`); dashboard renders 7 including reserved-unbuilt `invalidation` (`dashboard/pipeline-types.ts:21`); `invalidation` appears nowhere in non-test src outside `src/dashboard/`. Spec exists (`docs/specs/devils-advocate-spec.md`). Build the stage or remove the station.

## E. Duplication (new items only)

- Three `mapOrderState` implementations (`alpaca-adapter.ts:709`, `ibkr-adapter.ts:513`, `ccxt-adapter.ts:1180`). The shared tail (`filled > 0 ? 'partially_filled' : 'submitted'`) and the duplicated "Never `closed`" doc comment are in **ibkr + ccxt only** — both dead adapters. Evaporates if C deletes them.
- `run-*.ts` scripts share unextracted scaffolding: `print` fallback, `makeAssetClass`, `printReport` duplicated across `run-stage2.ts` / `run-stage2-cost-decomposition.ts` / `run-spread-calibration.ts`. Extract a shared script-support module. Also: `run-spread-calibration.ts:179` uses raw `fetch`, bypassing the shared HTTP layer (no retry/timeout/pacing).
- Prior audit M1–M4 remain open; not re-filed.

## F. Error typing

296 `new Error` vs 17 typed error classes; typed errors exist only at wire boundaries where retry classification needs them. Domain invariant violations throw generic `Error`, so callers can only match message text. Suggest typed errors **only where a caller actually branches** — no blanket conversion.

## G. Test quality

- Implementation-coupled hotspots: `production.test.ts` (2,228 lines, 29 call-assertions), `retry.test.ts` (22 in one block). Repo-wide ratio is healthy (283 call-assertions / 4,556 expects).
- 73 `as any`/`as unknown as`/`@ts-expect-error` in tests. This already caused a real miss: a `VolatilityReading` stub with the wrong shape behind an `as` cast meant the volatility breaker never actually evaluated in the composed-tick test (prior audit H2). Rule → coding-standards: stubs must type-check without casts.
- Shared fixture extraction candidates: `production.test.ts` `stubConfig` (95 lines), `sqlite-query-store.test.ts` `seedMark` (187 lines), `pipeline-view.test.ts` 272-line block. Test code (48.9k lines) now exceeds production code (45.6k).

## Not defects — examined and cleared

- Comment density overall: load-bearing WHY comments, per the 2026-08-05 ruling. The problem is narrower (D3/D4, ticket archaeology).
- Naming: clean. `build*`/`make*`/`*Row` conventions consistent; no junk-drawer modules.
- Error swallowing: all log-and-continue sites carry written arguments; cleared 2026-08-05, re-confirmed.
- Vendor leaks into strategy code: none. Zero vendor types/imports cross a stage boundary (the leak is in `ProductionConfig` naming, part of D1).
- LLM consolidation (ADR-0009): real. One wire helper (`nous-chat.ts`), spend cap + rate limiter wired. Residual: `Anthropic*` naming lies (rename deferred, self-documented), `MockLlmClient` reachable from the production root (verify which branch).

## Disposition

- Standards fallout → `docs/coding-standards.md` new sections (same commit as this review).
- Code changes: per-item approval, ordered B1/B2 → A4/A5/A1 → A2/A3 → B4/B3 → C → D. Each lands with `yarn lint && yarn typecheck && yarn test` + `yarn smoke`; B1/B2 with failing-first tests.
