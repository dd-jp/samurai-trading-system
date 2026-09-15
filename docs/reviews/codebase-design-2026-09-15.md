# Codebase design — deep-module review of the whole repo, 2026-09-15

**Subject.** Every module under `contracts/` and `server/` at `f96bd9dc` (~121k non-test TypeScript
lines), judged on one axis: **is each module deep — a lot of behaviour behind a small interface —
is its seam in the right place, and can it be tested through that interface?** Vocabulary is the
`codebase-design` skill's: *module*, *interface* (everything a caller must know, not just the
type), *seam*, *adapter*, *depth-as-leverage*, the *deletion test*, and *one adapter = hypothetical
seam, two = real*. `client/` was reviewed on this axis 2026-09-04
([`client-module-design-2026-09-04.md`](client-module-design-2026-09-04.md)) and is not re-reviewed;
its server-side pointer (F5, the second spend-cap constant) is confirmed closed in §6.

**Visual companion:** [`codebase-design-2026-09-15.html`](codebase-design-2026-09-15.html) — one card per finding with files, before/after diagrams, proposed signatures (Tailwind + Mermaid via CDN; open in a browser).

**This is a design review, not an implementation.** Standing Pipeline Rule 1 bars implementation
without a resolved wayfinder map and a written spec. Every finding states a **proposed interface as
a signature** so a map/spec can lift it. Nothing here was applied to code. The two standards rules
in §7 are the only change made alongside this report.

**Prior reports referenced, not re-filed.** [`entire-app-2026-09-04.md`](entire-app-2026-09-04.md)
(S1 barrel bypass, S3 issue-ref density, reachability pass, Fowler map #1179),
[`codebase-review-2026-08-06.md`](codebase-review-2026-08-06.md) (vendor-leak clearance at
`c06c0cc`, the `Anthropic*` rename deferral),
[`orchestrator-dashboard-architecture-2026-08-07.md`](orchestrator-dashboard-architecture-2026-08-07.md)
(the `DashboardQueryStore` port, the supervisor both-down policy). §6 records prior pins that no
longer hold at `f96bd9dc`.

**Method and its limits.** Five parallel reviewers, one per area (contracts+shared; analysts/
debate/trader; risk/verdict/execution/feedback/control-arm/cgt/benchmark; providers;
apps+tools), each reading barrels in full and the 8–14 largest implementation files plus the
largest test suites. **The reviewers' shells were refused by the worktree-isolation hook**, so
their importer counts come from files read, not repo-wide grep; every count in §2–§4 below was
then **re-measured by the synthesiser with grep over non-test `.ts`** and is stated as measured.
Where a reviewer's count could not be re-measured it says "read", not "counted". Coverage is a
sample; silence over a file is not clearance. Per-area reports are Appendices A–E with their
`file:line` evidence.

---

## 1. Already deep — do not flatten

Stated first because the largest risk a review like this carries is a refactor that flattens a
module which is earning its keep. Each of these has a small interface, a large implementation,
and tests that cross the same seam callers do.

| Module | Interface | Why it is deep |
|---|---|---|
| `BrokerAdapter` (`execution/types/broker.ts:211-408`) | 9 methods + `prices_own_fills` | **Three real adapters** (Alpaca, Saxo, Simulated); callers branch on capability or typed error, never venue (`execute.ts:523`, `residual-protection-sweep.ts:299`) |
| `DataSource` (`market-data-service/types.ts:196-200`) | `getBars`-shaped | ≥7 adapters read (Alpaca, Failover, AssetClassRouting, SessionNormalized, LseMark, Fixture, Lazy); `MarketDataServiceImpl` tests run through `FixtureDataSource` + real SQLite, nothing mocks fetch |
| `SequentialTickRunner` + `TickSteps` (`orchestrator/tick-runner.ts:124-524`, `types.ts:348-484`) | `runInstrument(signal, ctx)` | Root binds six callables; runner owns ordering, `position_check` vs decision pass, control-arm await, intent tail. **The root never hand-sequences stages** |
| `runTickPlan` + `TailSequencer` (`tick-loop.ts:116-440`) | one call | Phase split (#1040), crash rows, decision gate all inside |
| `DashboardQueryStore` → `SqliteQueryStore` / `InMemoryQueryStore` | 17 bounded queries | Two adapters; `buildSnapshot` (`service-api/snapshot.ts:232`) has zero SQL; fixture and real server share `createDashboardServer` |
| `startSupervisor(effects)` (`supervisor.ts:158-277`) | `SupervisorEffects` | Spawn/signal/exit-code policy behind one injected-effects seam |
| `AnthropicLlmClient.complete<T>` (`debate-engine/llm/anthropic-client.ts:424-467`) | one method | Retry, timeout, abort, failure classification, metering, prompt safety; 44 tests through the wire fake, asserting rendered wire text |
| `enforceLatencyBudget` (`latency-budget.ts:248-404`) | one call | Race, cancellation, partial-state fallback; 776 test lines through the interface |
| `decideWithReason` / `checkExitsWithReason` → `TraderOutcome` (`trader/decide.ts`) | returns data | `direct-bind.ts:381-507` logs/alerts without reaching in; `decide.test.ts` (3218 lines) has 0 `vi.mock`, 0 `as any` |
| `RiskManager.evaluate` + `ENTRY_CAP_GATES` (`risk-manager/index.ts:548-553, 963-971`) | one `RiskDecision` out | Gates non-exported; one decision leaves |
| `SharedStore` role split (`execution/types/store.ts`) | `LotJournal`/`FillJournal`/`FlattenJournal`/… via `Pick` | `writeAheadFlatten` is the single atomic gate between two flatten submitters |
| `TokenBucket` (`shared/http/token-bucket.ts:210-446`) | `acquire`, `acquireBackground` | 236 lines of re-check loop, lane folding, abortable wait |
| `guardedStore` (`shared/store/write-guard.ts:294-324`) | `(store, stage) → StoreHandle` | SQL parser fully hidden; returns bare handle when off |
| `NormalizingDataSource` / `FailoverDataSource` / `GdeltGkgClient` / `MarketIntelligenceStore.getContext` | see Appendix D | One widen/session invariant every vendor rides; breaker behind `DataSource`; zip/crc caps hidden; restatement collapse in one place |
| `held-quantity`, `safe-log.logCaughtFailure`, `CONTRACT_VERSION`, `readProductionEnvironment` | see Appendix A/E | Single definitions three stages share; one call replacing a 5-line guard; typed env read once |

Falsified as shallow during verification (kept, no action): `ExecutionImpl` (closes over
`ExecutionInput` so the root sees 4 methods, not 13 fields); `shared/index.ts` (95 names, but a
union of ~20 documented modules — 398 importers is the load a barrel is for); `contracts/snapshot.ts`
(906 lines of types — the types *are* the interface); `AnthropicMessagesClient` and
`PolymarketWireClient` (one production adapter each, but the test fake is the second — that is the
testability payoff, not a hypothetical seam); store ports in `shared/types/ports.ts` (same
argument; do not add a driver seam over `better-sqlite3`).

---

## 2. Cross-cutting findings, ranked by leverage

Per-area findings (Appendices A–E, IDs C/P/X/V/A) cluster into eight shapes. The shapes are the
findings; the per-area IDs are their evidence.

### D1 — The dependency graph is inverted at two hubs: `tools/backtest` and `pipeline/debate-engine` **(HIGH)**

**Measured.** Non-test files importing `../tools/backtest/index.js` from *below* `tools/`: **19**,
including `pipeline/execution/types/execution.ts:13` (`CostModel`, `CostVenue`),
`pipeline/execution/execute.ts:20` (`CostBreakdown`, `FillRequest`, `MarketState`),
`execution/adapters/saxo-adapter.ts:46` (`SAXO_COMMISSION_RATE`), `execution/simulated-adapter.ts`,
`pipeline/feedback-loop/types/metrics.ts:8` (`MetricsSuite`), `service-api/sqlite-query-store.ts:68`,
and 9 files under `apps/orchestrator`. In the other direction `tools/` imports
`apps/orchestrator` at **18** sites (`backtest/trial-execution.ts:42`, `backtest/types.ts:15`,
`check-live-money-gates.ts`, `place-soak-position.ts`, …), which is why `credentialRequirements()`
is a lazily-evaluated function (`orchestrator/index.ts:329-334`, comment names the cycle).

The second hub: the LLM port lives in the Debate stage. `LlmClient` is imported by **9** non-test
files outside `debate-engine` — `risk-manager/critic.ts:97`, `market-intelligence/mi-ingest-agent.ts`,
`scoring/item-scorer.ts`, four `production/*` files, `production.ts`, `smoke-run.ts`; `SpendCap` by 6;
`classifyFailureCause` by 5. Providers import `floorToBar`/`DEBATE_BAR_TIMEFRAME_MS` from
`debate-engine/debate-log-store.js` directly (`market-intelligence/index.ts:12-15`,
`gdelt-scoring-pass.ts:61-64`). `shared/types/records.ts:6` imports `AnalystContribution, Direction`
**upward** from `pipeline/debate-engine`, and `contracts/primitives.ts:69` already declares `Direction`.
`trader/decide.ts:51` imports `BookValuationError` from the downstream Risk stage.

**Why it matters.** The repo's stated layering (`contracts` ← `shared` ← `providers` ← `pipeline`
← `apps`, with `tools` a leaf) does not hold: the money path's cost model and the feedback loop's
metrics vocabulary are addressed under `tools/`, and every stage or provider that makes a model
call depends on the Debate barrel's 120-export graph (P7). A Risk-stage module importing a
Debate-stage barrel is a stage-order inversion. Deletion test: delete `tools/` and `production.ts`
fails to compile; delete `debate-engine/llm/` and Risk, MI scoring and the composition root fail.
Neither folder is its owner's.

**Proposed interfaces (moves, not rewrites).**

```ts
// server/shared/cost-model/index.ts   (from tools/backtest)
export { CostModelImpl, type CostModel, type CostConfig, type CostVenue, type CostBreakdown,
         type FillRequest, type MarketState, SAXO_COMMISSION_RATE } 
export { type MetricsSuite }                        // feedback-loop's vocabulary, not a backtest's
export { SqliteStage2SelectionStore }               // consumed by production.ts:3161

// server/shared/llm/index.ts   (absorbs debate-engine/llm/*)
export { type LlmClient, type LlmRequest, type LlmResponse, type LlmRequestContext,
         LLM_CONTEXT_FIELD_KIND, AnthropicLlmClient, NousMessagesClient, MockLlmClient,
         type SpendCap, type LlmSpendSink, type RateLimiter, classifyFailureCause,
         wrapUntrusted, unwrapFencedJson, BARE_JSON_INSTRUCTION, /* Llm*Error */ }
export { floorToBar, DEBATE_BAR_TIMEFRAME_MS }      // bar grid is a domain constant

// server/shared/types/records.ts: declare AnalystContribution here; take Direction from contracts.
// debate-engine/index.ts: re-export nothing from shared/llm; ≤30 debate-only exports (P7).
// shared/: BookValuationError (portfolio-view error, not a risk rule) — P8.
```

Sources: A3, P1, P8, V4, C3, X2 (the `SAXO_COMMISSION_RATE` half). Risk: mechanical (~80 import
sites, `tsc` catches every miss); do the deferred `Anthropic*` rename (review 2026-08-06 :84) in the
same move.

### D2 — The composition root is three layers and one 4,383-line file **(HIGH)**

**Evidence.** Adapter selection happens in (i) the `orchestrator/index.ts` entry guard
(`:1210-1285`, `resolveBrokerVenue`, `startingProfileForMode`), (ii) `startFromEnvironment`
(`:692-961` — `new JsonLogger()`, `openSharedStore`, `new MiArchiveStore`, `buildAlertChannels`,
`new SystemClock()`, `buildSaxoVenueClient`, `await buildSaxoBroker`, `new LseRegularHoursCalendar()`),
and (iii) `production.ts` — `buildProductionComponents` (`:828-2379`, ~1,550 lines, ~50 `new X(`)
and `buildProductionOrchestrator` (`:3023-4383`, ~1,360 lines) which embeds `runMetricsCheck`,
`runArmComparison`, `runFeedbackCycle`, `scheduleFeedbackCycle` and a 530-line `start()`.
`saxo-venue.ts:10-20` explains the hoist: the Saxo build is async and the root is sync.
`ProductionComponents` exposes 23 fields, several documented "so a test can assert wiring".

**Measured duplicates inside the root:** `SqliteClosedTradeStore('feedback-loop')` constructed at
`production.ts:1541, :2249, :3121`; `SqliteDebateLogStore` at `:1269, :3122`; `SqliteLlmSpendStore` at
`:1759, :1795`; `SqliteAccountStateStore` at `:1528, :2216` — two write guards and two
prepared-statement caches per table. `config.logger ?? new JsonLogger()` at five sites.
`orchestrator/index.ts` is simultaneously the package barrel (~80 re-exports, `:105-232`), the entry
point, and a second wiring layer; `service-api/index.ts` has no `main` at all — side effects on
import (`:44, :65, :110, :290`), which is why `fixture-server.ts` re-derives port/host/credential
(`:50-65, :178, :188`).

**Why it matters.** A reader must read three files to learn which broker, store and logger a run
uses; the venue branch lives outside the module whose doc says it exists "without the composition
root growing a broker-selection branch" (`config.ts:653-658`). Testability is achieved by widening
the returned struct instead of by seams — the exact pressure that grows the file (S3's 286 issue
refs). `place-soak-position.ts:241-250` had to build its own Alpaca adapter + stores because there is
no callable execution-bindings module, and it does so *unguarded* (no `guardedStore`).

**Proposed interfaces.**

```ts
// orchestrator/production/venue.ts — the ONE async adapter step, above the sync root
export interface VenueBindings { broker: BrokerAdapter; accountFunding?: AccountFundingSource; tradingCalendar: TradingCalendar }
export function buildVenue(venue: BrokerVenue, deps: { mode; universe; db; logger; clock; alerts: AlertChannelSlots }): Promise<VenueBindings>;

// orchestrator/production/stores.ts — built once, passed by reference
export interface Stores { closedTrades: SqliteClosedTradeStore; debateLog: SqliteDebateLogStore; llmSpend: SqliteLlmSpendStore; accountState: SqliteAccountStateStore; /* … */ }
export function buildStores(db: StoreHandle): Stores;

// orchestrator/production/daily-jobs.ts
export interface DailyJobs { runMetricsCheck(now: Date): Promise<void>; runArmComparison(now: Date): Promise<void>; runFeedbackCycle(now: Date): Promise<void> }
export function buildDailyJobs(deps: { stores: Stores; clock: Clock; logger: Logger; feedback: FeedbackCycleConfig; alerts: Pick<AlertChannelSlots,'breachAlerts'|'loosenNotices'|'armDivergenceAlerts'> }): DailyJobs;

// orchestrator/production/execution-bindings.ts — shared by production.ts and place-soak-position.ts
export function buildExecutionBindings(deps: { mode: 'paper'; db: StoreHandle; logger: Logger; clock: Clock; alerts: AlertChannelSlots }): { broker: BrokerAdapter; store: SqliteExecutionStore; submit(intent: OrderIntent, trace_id: string): Promise<ExecutionResult> };

// orchestrator/index.ts = barrel only; orchestrator/main.ts = entry point.
// service-api: readDashboardEnvironment(env) + startDashboard(env, deps?) replacing module side effects.
```

Sources: A1, A2, A5, A6, A7. Risk: medium-high on the money path — do it behind the existing smoke
gate; `smoke-run.ts` and ~10 wiring tests read `ProductionComponents` fields and shrink with it.

### D3 — Stage boundaries carry producer internals; the Debate stage has no module interface **(HIGH)**

**Evidence.**
- `DebateResult` (`debate-engine/types.ts:71-226`): 16 fields, **five hand-built literal producers**
  (`round-orchestrator.ts:222-238`, `latency-budget.ts:360-403` ×2, `debate-adapter.ts:532-553,
  656-677`), no constructor. Trader reads eight fields plus `contributions[].final_position`;
  `synthesis, position, open_items, disagreement_summary, latency_ms, rounds_completed` have 0
  reads in `trader/`. `debate-adapter.ts:549-551` explains why a refusal must set `read: true` — a
  flag whose meaning requires knowing the producer.
- The Debate stage itself has no interface: `DebaterPersona`/`MediatorPersona`
  (`round-orchestrator.ts:62-64, 101-103`) have **one** production adapter, and it lives in the
  orchestrator (`production/debate-adapter.ts:220-266`, 1,217 lines) which composes memo, replay,
  spend cap, rate limit, latency budget, weights, persistence and failure-rate guard from parts
  each with exactly one caller. That adapter drops `RoundContext.priorArguments`
  (`anthropic-client.ts:296-300`: bull/bear prompt "byte-identical across every round") and fakes
  stances by echoing `view.direction` (`:263-266`). Multi-round argument is unreachable through
  the only adapter that exists.
- `AnalystInput` (`analysts/types.ts:126-180`) is **service-shaped** — `market_data:
  MarketDataService`, `market_intelligence: MarketIntelligenceStore`, `calendar` all required — so
  `technical-analyst.test.ts:8-20, 135-140` builds `FixtureDataSource + SqliteMarketDataStore +
  MarketDataServiceImpl + MarketIntelligenceStore` to test a pure indicator rule, and
  `orchestrator.test.ts:57-101` repeats it. The MI dependency is a **concrete class**
  (`market-intelligence/index.ts:135`), so `mi-ingest-agent.test.ts:75, :97` cast around it.
- `NormalizedFill` (`execution/types/broker.ts:143-165`) crosses the `BrokerAdapter` seam carrying
  fields set *above* it (`exit_reason`, `flatten_idempotency_key` — set by `splitFlattenFills`,
  never by an adapter), one Alpaca-only transport field (`qty_is_cumulative`) and one
  Simulated-only field (`cost_breakdown`); Simulated tags a flatten fill `leg:'entry'`
  (`simulated-adapter.ts:268`) and ingest forces `'exit'` — leg semantics are not pinned by the seam.
- The `Trader` port (`trader/types.ts:488-496`, "the single test seam") has **0 implementations**;
  production binds `decideWithReason`/`checkExitsWithReason` directly. Seven trader barrel exports
  have 0 external importers.

**Proposed interfaces.**

```ts
// debate-engine — the stage as a module
export interface DebateStage { run(input: { trace_id: string; instrument: string; asset_class: AssetClass; bar: Date; views: AnalystView[] }, signal?: AbortSignal): Promise<DebateResult> }
export function buildDebateEngine(deps: { llm: LlmClient; log: DebateLogStore; spendCap: SpendCap; rateLimiter: RateLimiter; clock: Clock; logger?: Logger; weights?: AnalystWeightSource }): DebateStage;
export function debateResult(core: DebateCore, outcome: DebateOutcome): DebateResult;   // single constructor
export type TraderDebateInput = Pick<DebateResult,'debate_id'|'bar_timestamp'|'direction'|'confidence'|'converged'|'contributions'> & { degraded: null | { kind: 'timed_out'|'rate_limited'|'not_read'; reason: string } };

// analysts — data-shaped input, one reader
export interface AnalystReads { bars5m: Bar[]; bars1h: Bar[]; indicators: Record<IndicatorKindKey, number | InsufficientBars>; mi: MarketContext; session: TradingCalendar }
run(input: { trace_id: string; signal: Signal; bar: Date; asOf: Date; reads: AnalystReads }): AnalystView
export function readAnalystInputs(deps: { market_data: MarketDataService; mi: MarketIntelligenceReader; calendar: TradingCalendar }, signal: Signal, asOf: Date): Promise<AnalystReads>;

// market-intelligence — interfaces, not the class
export interface MarketIntelligenceReader { getContext(assetClass: AssetClass, timeWindowMs: number, bar?: Date, entity?: string): MarketContext }
export interface MarketIntelligenceWriter { ingest(intelligence: AgentIntelligence): void }

// execution — what the venue knows vs what ingest attributes
type VenueFill = Pick<NormalizedFill,'broker_fill_id'|'client_order_id'|'leg'|'qty'|'price'|'fee'|'timestamp'|'fee_currency'|'fx_rate_to_gbp'|'fx_rate_to_gbp_source'> & { qty_basis: 'increment'|'cumulative' };
type AttributedFill = VenueFill & { idempotency_key: string; exit_reason?: ExitReason; flatten_idempotency_key?: string; cost_breakdown?: CostBreakdown };
interface BrokerAdapter { fetchNewFills(since: Date): Promise<VenueFill[]>; /* … */ }

// trader — the port that is actually bound
export interface Trader { decide(input: TraderInput): Promise<TraderOutcome>; checkExits(input: ExitCheckInput): Promise<TraderOutcome> }
```

Sources: P2, P3, P4, P5, V1, X3. Risk: P2 is a behavioural change if `priorArguments` starts
rendering (prompt hash #1514 moves) — that is the point, and it needs a spec line. X3 touches three
adapters and the store row types. Keep the full `DebateResult` for `buildDebateLog` and
feedback-loop attribution; narrow only the Trader side.

### D4 — Duplicated behaviour that is a module with no interface **(MEDIUM, money path in one case)**

| Behaviour | Copies (measured) | Where |
|---|---|---|
| Flatten submit walk (closing-side inversion, bounded `${key}:suffix-N` retry, `writeAheadFlatten → submitFlatten → resolveFlattenSubmitted`, `UnresolvedFlattenForInstrumentError` catch) | 2 implementations | `execute.ts:729-1033` (`executeExit`, 305 lines) and `residual-reflatten.ts:116-342` (227 lines). `residual-reflatten.ts:29-35` argues the split is deliberate (lot-scoped, no cancel) — that justifies two *callers*, not two *implementations*. #516's double-sell hazard lives here (`reconcile.ts:180-211`) |
| Closing-side inversion `side === 'buy' ? 'sell' : 'buy'` | **8** | `trader/decide.ts:1001`, `execute.ts:588, :780`, `residual-reflatten.ts:225`, `saxo-adapter.ts:566`, `alpaca-adapter.ts:996`, `alpaca-crypto-emulation.ts:661`, `backtest/replay-driver.ts:612` |
| Nous HTTP transport (gate acquire/release, headers, `fetchWithTimeout`, `ttfb_ms`, `buildApiError`, JSON-parse error) | 2 | `shared/llm/nous-chat.ts:153-214`, `nous-responses.ts:339-393`; seven option fields repeated. `nous-wire.ts:6-12` says the split exists so a money bug is "implemented once and forgotten once" — the transport half was not moved |
| `truncateForError` | **4 definitions** + `maskAndCap` | `shared/http/response-errors.ts:41` (surrogate-safe), `shared/llm/nous-wire.ts:158` (not), `market-intelligence/sources/alpaca-news-client.ts:71`, `tools/backtest/free-stack-aggregates-client.ts:105`, `sanitize-log-text.ts:238`. A Nous error line can carry a lone high surrogate today; an Alpaca one cannot |
| `MarketState` assembly (7 fields from `getMark/getIndicator/getSpreadEstimate/getADV`) | 2 | `execute.ts:546-560`, `simulated-adapter.ts:343-364`; `prices_own_fills` exists to stop one module's logic running twice |
| Wire-client plumbing: rate-limiter-inside-retry, hand-rolled pagination with separate caps, private default `TokenBucket`s, JSON-salvage regex + `#unreadable` | 2 / 2 / 3 / 2 | Appendix D V5 |
| Alert fire-and-forget + `CREDENTIALS` swallow posture | 3 | `residual-protection.ts:500-525`, `reconcile.ts:519-539`, `ingest-fills.ts` (per `:506-507`); 10 one-method `*AlertChannel` types on the execution barrel (`index.ts:84-160`) |
| Analyst quorum + timeout | 2, one dead | `analyst-response-collector.ts` (0 callers, self-documented `:103-105`) vs `analysts/orchestrator.ts:282-325, 492-517` |

**Proposed interfaces.**

```ts
// execution/flatten-submitter.ts — one implementation, two callers
export interface FlattenSubmitter {
  submit(req: { lotKeys: readonly string[]; instrument: string; heldSide: 'buy'|'sell'; size: number; exit_reason: ExitReason;
                keyScheme: { base: string; suffix: string; maxAttempts: number }; modelled_cost_breakdown: CostBreakdown | null }, now: Date):
    Promise<{ kind: 'submitted'; key: string; ack: BrokerAck } | { kind: 'deduped'; key: string } | { kind: 'exhausted' } | { kind: 'failed'; error: unknown }>;
}
export const closingSide = (held: 'buy'|'sell'): 'buy'|'sell' => held === 'buy' ? 'sell' : 'buy';   // contracts or shared

// shared/llm/nous-wire.ts
export function nousPost(options: NousTransportOptions, path: '/chat/completions' | '/responses', body: unknown): Promise<{ status: number; body: unknown; ttfb_ms: number }>;

// shared/http
export function truncateForError(text: string, maxChars = MAX_ERROR_BODY_CHARS): string;   // the surrogate-safe one; others call it
export function pagedFetch<T>(first: () => Promise<Page<T>>, next: (token: string) => Promise<Page<T>>, opts: { maxPages: number; onExceeded(): never }): Promise<T[]>;
export function withPacedRetry<T>(fn: () => Promise<T>, opts: { bucket: TokenBucket; retry: RetryConfig; isRetryable(e: unknown): boolean }): Promise<T>;
export function salvageJsonObject(raw: string): unknown | undefined;

// providers/market-data-service
export interface MarketStateSource { read(instrument: string, asset_class: AssetClass, asOf: Date): Promise<MarketState> }

// execution alerts — one swallow implementation, per-kind payloads kept
export interface ExecutionAlerts { post<K extends keyof ExecutionAlertPayloads>(kind: K, payload: ExecutionAlertPayloads[K]): Promise<boolean> }
```

Sources: X1, X4, X5, C1, C2, V5, P6. Risk: X1 is medium (money path) but both copies already have
multi-thousand-line suites driven through `BrokerAdapter` + real SQLite, so the refactor is testable
through the seam. The rest is low.

### D5 — Hypothetical seams and dead ports **(MEDIUM)**

One adapter means a hypothetical seam. These are ports with one or zero adapters, each carrying
code that a real seam would justify and a hypothetical one does not.

| Port | Adapters | Lines carried | Evidence |
|---|---|---|---|
| `LseMarkClient` (`market-data-service/sources/lse-mark-source.ts:204-215`) | **0** ("ships with no concrete client" `:32-33`; factory arm "UNREACHABLE in production" `source-factory.ts:32-40`; boot refuses when absent `defaults.ts:683-704`) | ~500 | Live venue is Saxo; a Saxo instrument resolver already exists (`lse-etp-pool.ts:394-397`). Real value is `toBookCurrency` `:266-282` and the allow-list guard `:325-432`, both vendor-agnostic |
| `DebaterPersona` / `MediatorPersona` | 1, in the orchestrator | — | D3 |
| `Trader` (`trader/types.ts:488-496`) | **0** | — | D3 |
| `verdict.PositionStore` (`verdict/types.ts:23-26`) | 1; `store.ts:60-63` says it is "identical to" `LotJournal.findByKey` | — | Verdict gate 3 (`verdict/index.ts:309-312`) and `executeVerdict` (`execute.ts:131`) both run the dedup |
| `ApprovalChannel` in Verdict | unreachable in production (Appendix C) | — | ADR-0007: no human gate |
| `CiiScoreProvider` (`worldmonitor-adapter/cii-consumer.ts:20-23`) | 0, "not implemented yet" | 103 | Parked by design (memory: WorldMonitor adapter parked) — reference only |
| `VENUE_KEYS = alpaca\|ccxt\|ibkr\|saxo` (`shared/http/venue-pacing.ts:65`) | 2 live | — | Loop at `:571-580` refuses boot on a malformed `SAMURAI_PACING_CCXT_*` — the "dead before the first tick" failure the file's own Polygon argument warns about |
| `analyst-response-collector.ts` | 0 callers | 193 + 350 test | D4 |

**Proposed.** `withLseTradeableGuard(inner: DataSource, opts): DataSource` as a decorator, and let
the Saxo mark source implement `DataSource` directly (coordinate with open #895); delete
`verdict.PositionStore` and type the field `Pick<LotJournal,'findByKey'>`; delete the `Trader`
port's `OrderIntent|null` shape and the `decide()` projection; delete the collector;
`resolveVenuePacing(env, venues: readonly VenueKey[] = LIVE_VENUE_KEYS)`. Sources: V3, X6, P4, P6,
C9. Risk: low except V3 (medium, #895).

### D6 — Barrels as god surfaces, test doubles and vendor shapes exported **(MEDIUM)**

| Barrel | Measured | Problem |
|---|---|---|
| `pipeline/debate-engine/index.ts` | **120 named exports**, 51 external files reference it | Hosts the LLM port (D1), re-exports `shared/llm/pricing` wholesale; `collectAnalystViews, validateAnalystView, MockLlmClient, MODEL_RATES, priceUsage, LLM_CALLS_PER_ROUND, DebateBudgetExceededError` have 0 external importers |
| `pipeline/execution/index.ts` | 165 lines, ~75 symbols, 53 venue-word hits | Exports adapters, HTTP clients, env-var names, throttle constants and 10 one-method `*AlertChannel` types; the `Execution` port itself is 4 methods |
| `pipeline/feedback-loop/index.ts` | 6 `InMemory*` exports (`:27-34`) | `fixture-stores.ts:1-10` calls them "the in-memory pair for tests"; barrel also exports attribution/guardrail primitives while `FeedbackLoop` is 2 methods |
| `providers/market-data-service/index.ts` | `AlpacaBar/AlpacaQuote/AlpacaMarketDataClient/toAlpacaTimeframe/LseVendor*` (`:56-70, :88-103`) | `ProductionConfig.alpacaDataClient` types the seam on a vendor client and forces the mixed-universe refusal (`defaults.ts:800-810`) |
| `shared/llm/index.ts` | 17 barrel imports vs **18 deep** | `nousResponses`/`NousCitation` absent from the barrel, so `x-search-client.ts:77` has no legal route (extends S1/#1158) |
| `pipeline/risk-manager/index.ts` (1,000 lines) and `pipeline/verdict/index.ts` (538) | implementation living in the barrel file | `RiskManagerImpl.evaluate` (283 lines) and `VerdictImpl.decide` (257) are defined *in* `index.ts` |
| `contracts` vs `shared/store` | same names, different shapes | `FillRow`, `ClosedTradeRow`, `STORE_MODES/StoreMode` exist in both; `service-api/types.ts:38-59` re-exports the wire `FillRow` from a module that also reads store rows |

**Proposed.** Debate barrel ≤30 exports after D1/D3; `feedback-loop/testing.ts` and equivalent
for every `InMemory*`/`Fixture*` double (not re-exported from the module barrel — standards rule
§7); `ProductionConfig.dataSourceFor?: (assetClass: AssetClass) => DataSource` replacing
`alpacaDataClient`; add the missing Nous exports; rename store rows `FillDbRow`/`ClosedTradeDbRow`;
move `RiskManagerImpl`/`VerdictImpl` out of their `index.ts` into `risk-manager.ts`/`verdict.ts`.
Sources: P7, X5, X8, V7, C4, C7. Risk: mechanical.

### D7 — Interface contracts keyed on prose or mixed within one chain **(LOW, but a live-alert seam)**

- `assertThresholdsWithinBounds` throws a plain `Error` for ≥2 violations
  (`shared/threshold-bounds.ts:275-278`) and `isThresholdBoundViolation` (`:296-299`) recognises it by
  `message.includes('in-code clamp')` — the alert seam is coupled to the constructor's wording at
  `:220`. The file argues "no second reader"; this function is the second reader. Proposed:
  `class ThresholdBoundViolationsError extends Error { readonly violations: readonly
  ThresholdBoundViolationError[] }` and a type-guard over both.
- Two of seven Risk entry gates **throw** `PerSubclassCapUnresolvableError`
  (`risk-manager/index.ts:761, 782, 819, 843, 927, 946`) while five return `{name, allowedAdditional}
  | null`; the orchestrator catches the class (`direct-bind.ts:60`). `next_breaker_state` is echoed
  input→output (`types.ts:657, 713`). Proposed: `type EntryCapGate = (ctx) => { name;
  allowedAdditional } | { name; unresolvable: string } | null`, `evaluate` maps `unresolvable` to
  `status:'reject'` with `binding_constraint`; drop the echo.
- Risk's thrown error strings name `Alpaca GET /v2/account` and `Saxo GET /port/v1/balances/me`
  (`risk-manager/index.ts:822, :828-829, :930, :937-938`) and a reject reason names Saxo (`:322-325`);
  `risk-manager/types.ts` carries 17 venue-word hits (`long_only_instruments`,
  `same_currency_verified`). Review 2026-08-06 cleared "zero vendor leaks" at `c06c0cc`; the decay is
  at Risk, not Execution (`execute.ts`, `reconcile.ts`, `residual-*.ts` are clean in code; the 8
  hits in `trader/decide.ts` are all comments). Proposed: `PortfolioView.equity_currency_verified:
  boolean` + `account_read_source: string` supplied by the root; derive `long_only` from
  `Instrument.shortable === false`.
- `nous-config.ts` samples `process.env` internally (`:120-123`) while every other env reader in
  `shared/` injects; there is no `nous-config.test.ts`, so the unpriced-model refusal (`:154-161`, a
  spend-cap safety check) is untested at its own interface. Proposed: `nousCredentials(role, env =
  process.env)`. Measured repo-wide: **43 `process.env.` reads across 18 non-test files**, with
  `production.ts:1097` (`resolveVenuePacing()`) and `:1720` (`tryNousCredentials`) bypassing
  `readProductionEnvironment`, so `processEnv` injection does not cover them.

Sources: C5, C6, X2, X7, A4. Risk: low.

### D8 — Crypto residue at the type level **(reference; extends #1179 / entire-app items 7, 16)**

Not re-filed. Recorded because it changes what D3/D6 cost: `Mark.asset_class: 'crypto'|'stocks'`;
`AssetClassRoutingDataSource` constructor **requires both** classes (`:72-83`); `buildAlpacaDataSource`
defaults `'crypto'` for an empty universe (`defaults.ts:765`); `AlpacaCryptoLegEmulation` (839 lines)
constructed unconditionally (`alpaca-adapter.ts:383-389`) with `ocoDoubleFillAlerts` required;
`STALENESS_THRESHOLD_MS.crypto`; `FailoverEvent.leg: 'crypto'`. **The deletion is not free:**
`SMOKE_TEST_UNIVERSE` is BTC/ETH (`defaults.ts:153-154`; `production.ts:327`), so the crypto path is
what `yarn smoke` exercises. Narrowing the types needs a smoke-universe decision first — a
`wayfinder:grilling` ticket, not a refactor.

---

## 3. Testability through the interface — what the suites actually reach for

Measured on the largest suites. **Good:** `decide.test.ts` (3,218 lines) has 0 `vi.mock`/`vi.spyOn`/
`as any`; `execute.test.ts` (3,611) and `ingest-fills.test.ts` (5,024) implement `BrokerAdapter`
(`makeBroker`, `ScriptedBroker`) and use real SQLite via `openTestExecutionStore`;
`anthropic-client.test.ts` drives 44 cases through the wire fake; `service.test.ts` runs
`MarketDataServiceImpl` through `FixtureDataSource`. **Reaching past:** `technical-analyst.test.ts`
and `orchestrator.test.ts` stand up a real market-data service to test a pure rule (D3, P5);
`mi-ingest-agent.test.ts:75, :97` casts (`as unknown as AlpacaNewsClient`, `as any`) because the seam
is a class (D3, V1); `ingest-fills.test.ts:19-20` imports control-arm's `buildArmComparison` (cross-
module test reach); Simulated exposes test observables `getProtectedQty`/`isCancelled`
(`simulated-adapter.ts:212, 298`); `write-guard.test.ts:12` and `open-shared-store.test.ts:8-90` pin
internals deliberately and say so. Net: the testability defects are the seam defects in D3 — fix the
interface and the test set-up collapses with it.

## 4. Size, for the record (not findings)

Files over 1,500 non-test lines: `smoke-run.ts` 7,119 (filed, Fowler §), `production.ts` 4,383 (D2),
`paper-profile.ts` 2,910 (data; narrow interface — fine), `lse-etp-pool.ts` 2,258 (V8: 360-line
header + 1,130 rows + 480 lines of lookups with import-time `assertValidPool` — split
schema/data/lookups, validate at the root), `saxo-adapter.ts` 1,766, `trader/decide.ts` 1,690,
`alpaca-adapter.ts` 1,638, `ingest-fills.ts` 1,627 (S3/#1160). God *functions*: `executeExit` 305,
`RiskManagerImpl.evaluate` 283, `maybeRearmResidual` 261, `VerdictImpl.decide` 257,
`reflattenResidual` 227. Size alone is not a finding here; each is listed above only where a seam
is missing.

## 5. Suggested order

1. **D1** (moves only; unblocks everything, zero behaviour change).
2. **D6** barrel trims + test-double relocation (mechanical, lands with D1).
3. **D2** — `Stores` first (fixes the duplicate write guards, smallest blast radius), then
   `buildExecutionBindings` (closes the unguarded soak-tool path), then `DailyJobs`, then the
   entry/barrel split.
4. **D4 X1** flatten submitter (money path; behind smoke).
5. **D3** — P3/P4/X3 type narrowing first (compile-checked), then P5/V1, then P2 which needs a
   spec line on stance evolution.
6. **D5, D7** as they are touched.
7. **D8** only after the smoke-universe grilling.

## 6. Prior pins that no longer hold at `f96bd9dc`

- `createDataSource` "zero call sites" (entire-app :38-48, #1151): **now called** at
  `defaults.ts:706` (`'lse'`) and `:768` (`'alpaca'`). #1151 should be re-verified before any dedupe.
- "Dead crypto candle clients" (entire-app :69-71, #1157): **gone** — no coinbase/bitstamp/ccxt/
  kraken/tiingo/saxo files under `sources/`; `ohlcv-failover.ts:6-8` records the removal.
- `verdict/index.ts:376`/`:409` `DiscordChannel`, `SignedApprovalChannel` (entire-app reachability;
  #1153/#1154): **no longer exist** anywhere in non-test `server/` — re-verify those issues.
- `contracts/index.ts` "nothing imports its barrel" (S1): **23 importers now**; one deep import
  survives.
- `early-exit.ts:86` deep import (entire-app :111): fixed — now `from '../analysts/index.js'`.
- `universe-pool` has no barrel (S1 companion): fixed 2026-09-05.
- Client F5 second spend-cap constant: **closed** — `sqlite-query-store.ts:589-593` reads the armed
  cap from `SqliteLlmSpendCapStore`.
- Entire-app S4 `ENV_X_MAX_SEARCH_RESULTS` mid-wiring read: fixed (`environment.ts:111-119`).

## 7. Standards fallout

Two rules added to `docs/coding-standards.md` in this change: **dependency direction** (`contracts`
← `shared` ← `providers` ← `pipeline` ← `apps`; `tools/` is a leaf that imports and is never
imported; a type two layers need lives in the lower one) and **test doubles are not barrel
exports**. Both are stated as the rule the findings above breach, with this report as the citation.

## 8. Where each finding should go

Filing is David's call. Suggested shape: one `wayfinder-map` for D1+D6 (address moves, no
decisions to grill beyond "is `shared/llm` the home?"), one for D2 (root shape — grill the async
venue step), one `wayfinder:grilling` for D3's P2 (stance evolution is a product question), and
plain implementation tickets for D4 X1/C1/C2, D5, D7 once the maps resolve.

---

## Appendix A — `contracts/` and `server/shared/`

### A.1 Inventory

| Module | Lines | Exports | Ext. sites | Verdict | Reason |
|---|---|---|---|---|---|
| `contracts/index.ts` | 88 | 63 names | 23 barrel | deep (type registry) | S1's "nothing imports the barrel" is now false; one deep import survives |
| `contracts/snapshot.ts` | 906 | 29 | via barrel | god-by-size, types only | 19-field `DashboardSnapshot` + hashed `CONTRACT_VERSION` (:821-906) |
| `contracts/pipeline.ts` / `metrics.ts` / `primitives.ts` / `providers.ts` | 225/135/124/67 | 12/3/7/6 | via barrel | deep | vocabulary + 3 pure fns |
| `shared/index.ts` | 137 | ~95 names | 398 | barrel, curated | every block carries a consumer note (:52-67, :92-96) |
| `clock.ts` | 53 | 3 | many | deep, real seam | `SystemClock` + `SimulatedClock` (:11, :27) |
| `held-quantity.ts` | 157 | 12 | Trader/Exec/sweep | deep | one flatness judgement (`coversQty` :129) |
| `safe-log.ts` | 166 | 5 | ≥4 | deep | swallow-on-log, render guarded (:153-166) |
| `sanitize-log-text.ts` | 243 | 3 | 2 deep + barrel | deep | pattern list single-owned |
| `threshold-bounds.ts` | 299 | 9 | 3 packages | deep; error-mode leak (C5) | |
| `trace-context.ts` / `env-integer.ts` / `book-currency.ts` / `escalation-cadence.ts` | 73/96/49/18 | 2/3/3/2 | — | small, deep | single definitions that earn keep |
| `stdout-fault-guard.ts` | 126 | 7 | 2 entrypoints | shallow but injectable (:112-120) | |
| `decision-records.ts` | 148 | 4 | dashboard+stages | types+ports; misplaced (C3) | |
| `types.ts` → `types/{ports,primitives,records}.ts` | 41 → 140/108/756 | 4→5/6/15 | 9 deep | sub-barrel; upward import (C3) | |
| `http/token-bucket.ts` | 446 | 7 (2 on barrel) | 3 adapters + data client | deep | 2 public methods |
| `http/venue-pacing.ts` | 645 | 10 (5 on barrel) | root, adapters | deep; 290 lines provenance prose | dead venues (C9) |
| `http/retry.ts` / `fetch-with-timeout.ts` / `delay.ts` / `response-errors.ts` | 159/38/14/193 | 4/1/1/9 | every client | deep | |
| `llm/index.ts` | 57 | ~30 | 17 barrel vs 18 deep | barrel bypassed (C4) | |
| `llm/nous-chat.ts` / `nous-responses.ts` / `nous-wire.ts` | 267/477/267 | 6/6/12 | 4+1 deep | duplicated transport (C2), truncation (C1) | |
| `llm/nous-config.ts` | 186 | 10 | root | deep; untestable env read (C6) | no `nous-config.test.ts` |
| `llm/pricing.ts` / `in-flight-gate.ts` / `prompt-template-hash.ts` | 378/399/20 | 12/8/1 | 4 / 3 / 6 deep | deep | gate has 2 adapters (`NousAccountInFlightGate`, `UNGATED_LLM_IN_FLIGHT` :151, :173) |
| `store/index.ts` | 49 | ~30 | 151 | barrel | |
| `store/open-shared-store.ts` | 214 | 8 | both apps | deep | `StoreHandle = BetterSqlite3.Database` (:22) — no driver seam, accepted |
| `store/write-guard.ts` | 324 | 7 | root | deep | Proxy over `prepare`/`exec` (:302-323) |
| `store/{fill,open-position,closed-trade}-row.ts` | 59/150/73 | 2/4/2 | Exec + dashboard | deep | single column list; name clash (C7) |
| `store/sqlite-utils.ts` / `migrate.ts` / `key-scheme-guard.ts` / `prune-llm-call-log.ts` | 92/66/105/97 | 6/3/4/2 | many | deep | |
| `store/sqlite-decision-record-stores.ts` / `sqlite-llm-spend-cap-store.ts` | 109/83 | 2/2 | orchestrator+dashboard | thin adapters | SQL is the implementation |
| `recording-logger.ts` / `strip-comments.ts` | 24/97 | 1/2 | 19 tests / 2 tests | test helpers, off-barrel by design | |

### A.2 Findings

**C1 — Truncation is three modules with no interface, two of which disagree.**
`http/response-errors.ts:41-47` (surrogate-safe), `llm/nous-wire.ts:158-162` (same name, same
`MAX_ERROR_BODY_CHARS = 500` at :34, no surrogate guard), `sanitize-log-text.ts:238-243`
(`maskAndCap` re-spells the suffix). `nous-chat.ts:36` and `nous-responses.ts` take the wire copy;
`sanitize-log-text.ts:20` takes the http copy. Synthesiser's grep found two more definitions
(`alpaca-news-client.ts:71`, `free-stack-aggregates-client.ts:105`). Deletion test: delete nous-wire's
copy → nothing reappears; delete response-errors' → reappears at 3 sites.

**C2 — `nousChat` and `nousResponses` share a 45-line transport with no seam.**
`nous-chat.ts:153-214` and `nous-responses.ts:339-393`. `NousChatOptions` (:101-124) and
`NousResponsesOptions` (:140-162) repeat seven fields. Tests already stub global `fetch`
(`nous-chat.test.ts:35-51`), so they pass unchanged.

**C3 — `shared/` imports upward from a pipeline stage, and the type graph is cyclic.**
`types/records.ts:6` imports `AnalystContribution, Direction` from `pipeline/debate-engine`;
`contracts/primitives.ts:69` already declares `Direction`. `debate-engine/index.ts:19` re-exports
`DebateLog, DebateLogStore, DebateTermination` from `shared/types.js` (a third route), and
`records.ts:7` → `held-quantity.ts:27` → `types.ts` → `records.ts`. `DebateLog.contributions` is
persisted (`debate-log-store.ts:32`), so `AnalystContribution` is a record shape. Adjacent:
`decision-records.ts:140-148` holds two ports and `types/ports.ts` holds five — fold them.

**C4 — `shared/llm` barrel is bypassed more than used, and cannot be complied with for one export.**
17 barrel imports vs 18 deep (`prompt-template-hash` 6 incl. `risk-manager/critic.ts:96`,
`debate-engine/personas.ts:12`; `nous-chat` at `nous-messages-client.ts:27`,
`nous-sentiment-client.ts:89`; `pricing` at `spend-sink.ts:31` and re-exported wholesale by
`debate-engine/index.ts:10-18`). `nousResponses`/`NousCitation` are absent from `llm/index.ts` —
`x-search-client.ts:77` has no legal route. Extends S1/#1158.

**C5 — `threshold-bounds` aggregate failure is keyed on prose.** See D7.

**C6 — `nous-config` samples `process.env` internally.** See D7. `readEnv` (:120-123), used by
`nousCredentials` (:134-164) and `tryNousCredentials` (:180-186), versus `resolveVenuePacing(env)`
(:569), `isStoreWriteGuardEnabled(environment)` (:188-194), `resolveStoreMode(raw)` (:81).

**C7 — Same names, different shapes, across the two barrels a dashboard file imports.**
`FillRow` — wire at `contracts/index.ts:69` (`snapshot.ts:339`), DB row at `store/index.ts:7`
(`fill-row.ts:12`); `ClosedTradeRow` — `contracts:61` vs `store:6`; `STORE_MODES/StoreMode` —
`contracts:45-46` and `store/index.ts:26-27` via `open-shared-store.ts:59`.

**C8 — Store ports: one production adapter each, in-memory pairs for tests.** Verdict: keep —
the second adapter is the test double, which is the testability payoff. No change.

**C9 — `resolveVenuePacing` validates venues the product no longer has, at live boot.** See D5.
Test at `venue-pacing.test.ts:25-29` overrides ccxt and needs the full list passed.

### A.3 Falsified

`contracts/index.ts` unused (S1) — 23 importers now. `shared/index.ts` as god-module — union of
~20 documented modules. `contracts/snapshot.ts` 906 lines — types are the interface.
`venue-pacing.ts` 645 lines — 290 are provenance prose on `DEFAULT_VENUE_PACING` (:126-417).
`stdout-fault-guard.ts` as pass-through — `installContinueOnFault` takes `effects` (:112-120).
`sqlite-utils.fromStoredTimestamp` as missing validator — leniency is stated (:80-83); the
invariant is write-side. `UNGATED_LLM_IN_FLIGHT` as no-op hiding a hypothetical seam — `nousChat`
requires a gate (:108-113); the no-op is the second adapter every unit test uses.

---

## Appendix B — `analysts/`, `debate-engine/`, `trader/`

Method: 100 in-scope files (30,016 lines); all three barrels, 14 largest implementation files, the
two composition-root adapters (`production/analysts-adapter.ts`, `production/debate-adapter.ts`,
`production/direct-bind.ts`) for seam placement, heads of the five largest test files.

### B.1 Inventory

| Module | Lines | Exports | External non-test importers | Verdict | Reason |
|---|---|---|---|---|---|
| `analysts/index.ts` | 39 | ~21 | 2 + 1 (`early-exit.ts`) | pass-through | fine |
| `analysts/orchestrator.ts` | 530 | 5 | 2 | deep | `runAnalysts(trace,signal,clock,bar) -> AnalystRunResult` hides timeout/retry/quorum; `analysts()` L521-529 has 0 non-test callers |
| `analysts/technical-analyst.ts` | 1169 | 14 | 1 (`trader/early-exit.ts:86`) | deep | one `Analyst` object; 5 axes behind `run()` |
| `fundamental-analyst.ts` / `sentiment-analyst.ts` | 112 / 109 | 1 each | 0 | shallow | entire-app :191 (filed) |
| `analysts/types.ts` | 265 | 12 | — | contract | `AnalystInput` L126-180 is service-shaped (P5) |
| `debate-engine/index.ts` | 135 | **120** named | 51 files outside module | god | P7 |
| `llm/anthropic-client.ts` | 711 | 9 | 1 (`production/defaults.ts`) | deep | `complete<T>()` L424-467 |
| `llm/nous-messages-client.ts` | 161 | 2 | 1 | shallow adapter | sole impl of `AnthropicMessagesClient` (L72); misnamed, self-documented L12-17 |
| `llm/types.ts` | 158 | 8 | `LlmClient` 9 importers, 5 impls | deep contract | `LLM_CONTEXT_FIELD_KIND` L100-104 compile-enforced |
| `llm/spend-sink.ts` / `spend-cap.ts` | 427 / 342 | 4 / 9 | 2 / 6 | deep | 2 adapters each = real seams |
| `latency-budget.ts` | 426 | 9 | 1 (`debate-adapter.ts`) | deep | `DebateBudgetExceededError`, `LLM_CALLS_PER_ROUND` 0 external importers |
| `round-orchestrator.ts` | 239 | 12 | 1 | deep but hollow | `priorArguments` L172-188 built every round, never consumed (P2) |
| `personas.ts` | 256 | 7 | 1 | shallow | three near-identical fns L177-256; prompt construction inline |
| `analyst-response-collector.ts` | 193 | 4 | **0** | dead | self-documented L103-105 (P6) |
| `disagreement-detector.ts` / `conviction-score.ts` | 231 / 258 | 3 / 2 | 1 / 2 | deep | pure over `AnalystView[]`; never-throws L145-181 |
| `debate-engine/types.ts` | 226 | 4 | `DebateResult` 9 files | contract | 16 fields, 5 hand-built producers (P3) |
| `trader/index.ts` | 59 | 36 | 3 files | pass-through | 7 exports with 0 external importers (P4) |
| `trader/decide.ts` | 1690 | 19 | 1 (`direct-bind.ts`) | deep | returns `TraderOutcome`; 157 `it(` with 0 mocks |
| `trader/build-bracket.ts` / `subclass-bracket.ts` / `setup-vector.ts` | 265 / 403 / 98 | 12 / 8 / 2 | 0 / 0 / 0 | deep | pure; `TradeDirection` excludes neutral (build-bracket.ts:22) |
| `trader/types.ts` | 669 | 12 | 3 | contract | `Trader` L488-496 has **0 implementations** (P4) |
| `trader/early-exit.ts` | 218 | 5 | 0 | deep | no LLM path by construction (L63-65) |

### B.2 Findings

**P1 — The LLM port is housed in the Debate stage but is a cross-cutting seam.** See D1. Barrel
comment `debate-engine/index.ts:72-78` admits the risk critic is "the first consumer OUTSIDE this
module"; `anthropic-client.ts:221-223`: one client "shared across the debate personas, the
disagreement detector, the risk critic and MI scoring". Deletion test: delete `debate-engine/llm/`
and the debate engine, risk critic, MI scoring and root all fail to compile.

**P2 — The Debate stage has no module-level interface; the persona port has one adapter and it
lives in the orchestrator.** See D3. `runDebate`, `enforceLatencyBudget`, `computeConvictionScore`,
`detectDisagreements`, `applyAnalystWeights`, `computeDebateId`, `buildDebateLog` each have exactly
one external caller — all `debate-adapter.ts`. Deletion test: delete `runBullPersona`/
`runBearPersona`/`runMediatorPersona` → only `debate-adapter.ts` breaks; delete `DebaterPersona` →
same file and `round-orchestrator.test.ts:255`.

**P3 — `DebateResult` leaks producer internals and has no constructor.** See D3. Deletion test:
delete `DebateResult.read` → 5 producers and `debateWasDegraded` change; a Pick-typed Trader would not.

**P4 — `Trader` port is dead; trader barrel exports what nothing imports.** See D3/D5. Barrel
symbols with 0 external non-test importers: `decide, retrieveCosinePrecedent, FixtureSetupStore,
computeIdempotencyKey, buildSetupVector, ADR_0018_SUBCLASS_BRACKETS, TraderInput`.
`trader/index.ts:37-43` claims "both the root and its tests read the bracket table" — the root does
not. Deletion test: delete the `Trader` interface → 3 type-only imports need a doc-comment edit.

**P5 — `AnalystInput` is service-shaped, so analyst tests reach past the interface.** See D3.
`technical-analyst.ts:1015-1046` issues 6 service calls whose cost depends on
`MarketDataServiceImpl.cachedBars` (L106-123); one `readAnalystInputs` collapses the three
`MI_CONTEXT_WINDOW_MS` declarations. Risk: medium — the single-fetch collapse and enrichment
pre-checks move to the reader; `technical-axes.test.ts` pins them.

**P6 — Two quorum implementations, one uncalled.** See D4. Delete `analyst-response-collector.ts`,
its barrel lines (`index.ts:22-23`), and `analysts()`.

**P7 — `debate-engine/index.ts` is a god barrel.** See D6.

**P8 — Trader depends on the downstream Risk stage.** `decide.ts:51` imports `BookValuationError`
to narrow a control-arm valuation throw. Move to `shared/`.

### B.3 Falsified / already filed

`early-exit.ts:86` deep import — fixed. `fundamental`/`sentiment` duplication, `routeDecision`
preamble, `decide.ts` comment density — entire-app :191, :194, :134, :114. `AnthropicMessagesClient`
as hypothetical seam — 45 test fakes across 3 files make it the wire-fake seam; keep, rename only.
`TraderConfig` inert fields — live on the `bracket === null` path (`build-bracket.ts:76, 81, 171`);
spec-side at entire-app P11. `RateLimiter`, `SpendCap`, `LlmSpendSink`, `DebateLogStore`,
`SetupStore` — ≥2 production adapters each. `technical-analyst.test.ts:216-390` asserts on
`key_points` prose — acceptable while `key_points` is the debate's input contract.

---

## Appendix C — `risk-manager/`, `verdict/`, `execution/`, `feedback-loop/`, `control-arm/`, `cgt/`, `outside-benchmark/`

### C.1 Inventory

| Module | Lines (non-test) | Exported symbols | External call sites read | Verdict | Reason |
|---|---|---|---|---|---|
| execution | ~17,900 (saxo-adapter 1766, alpaca-adapter 1638, ingest-fills 1627, sqlite-shared-store 1214, execute 1117) | ~75 (`index.ts:1-165`; 10 `*AlertChannel` at `:84-160`) | `ExecutionImpl`, `SharedStore`, 5 alert types in `direct-bind.ts:28-39` | deep core, wide rim | `Execution` = 4 methods (`types/execution.ts:476-529`) over 18k lines; barrel leaks adapters, http clients, env-var names |
| risk-manager | 4,793 | ~55 (`index.ts:39-118`) + `RiskManagerImpl`, `PerSubclassCapUnresolvableError` | `direct-bind.ts:40-63` imports 13 | deep | `RiskManager.evaluate(input): RiskDecision` (`types.ts:717-719`); gates internal |
| verdict | 1,783 | 27 | `direct-bind.ts:74-85` (7), `alert-transport.ts:97` (2) | deep, one hypothetical seam | `Verdict.decide` one method; `ApprovalChannel` unreachable in prod |
| feedback-loop | 6,577 | ~70 (6 `InMemory*` at `:27-34`) | 4 cycle fns wired (entire-app :483) | shallow-wide | `FeedbackLoop` port 2 methods (`types/cycle.ts:85-95`); barrel exports internals + doubles |
| control-arm | 1,641 | 6 | `orchestrator/control-arm.ts` | deep | pure fns, no LLM import (`axis-vote-decision.ts:53-61`) |
| cgt | 1,594 | 12 | `tools/report-cgt-disposals.ts` | deep | pure matcher + one SQL source |
| outside-benchmark | 729 | 6 | feedback-loop cycle | deep | closed union, D4 structural (`outside-benchmark.ts:41-49`) |

### C.2 Findings

**X1 — Two flatten submitters with no shared interface.** See D4.
**X2 — Venue names leaked into Risk Manager (above the seam); `saxo-adapter.ts:46` imports
`SAXO_COMMISSION_RATE` from `tools/backtest`.** See D1/D7.
**X3 — `NormalizedFill` carries ingest-side and transport-side fields across the `BrokerAdapter`
seam.** See D3. Deletion test: removing `exit_reason` from `NormalizedFill` breaks only
`flatten-attribution.ts` + sqlite store → belongs downstream.
**X4 — Duplicate `MarketState` assembly and second `CostModel.fill` draw.** See D4.
`captureSubmitSnapshot` prices entry+protective leg (`execute.ts:569, 585-594`) and skips when
`broker.prices_own_fills` (`:523`).
**X5 — Alert channels: 10 one-method interfaces on the execution rim, swallow posture
hand-copied 3×.** See D4. `AlertChannelSlots` exhaustiveness is enforced at the root
(`alert-transport.ts:141-169`) — the count is the cost, not the safety.
**X6 — Verdict `PositionStore` is a hypothetical seam; dedup gate duplicated.** See D5. Keep the
Verdict-side gate only if `no_go_reason: 'duplicate'` is consumed (verdict_log).
**X7 — Mixed gate contract in Risk: two of seven gates throw.** See D7.
**X8 — Feedback-loop barrel exports test doubles and internals.** See D6. Attribution primitives'
external use not measured — flag, don't file.
**X9 — `AlpacaCryptoLegEmulation` (839 lines) constructed unconditionally.** See D8.
`submitBracket` routes `asset_class==='crypto'` (`:633`); `rearmProtectiveLegs` `-USD` heuristic
(`:888`).
**X10 — God functions (size, not seams).** See §4.

### C.3 Falsified

Risk gate chain exposed individually — false (`index.ts:592-960` non-exported). Verdict/execution
split not a real seam — false: distinct one/four-method ports, both wrapped by decorators
(`LoggingVerdict`, `NotifyingVerdict`). `ExecutionImpl` a needless middle-man (entire-app :213) —
partially false; keep. Tests reach past `BrokerAdapter` — false for execute/ingest-fills.
Commission rate duplicated as computation — false: one computation (`CostModel.fill`), one
reconciliation (`chargeTopUpTo`); the defect is the import direction. `BrokerVenue` leaks upward —
false: `broker-state-store.ts:33` is map-key/filter only. Stale prior pins: `verdict/index.ts:376`/
`:409` `DiscordChannel`, `SignedApprovalChannel` no longer exist (§6).

---

## Appendix D — `providers/`

### D.1 Inventory

| Module | Lines | Exports | External call sites | Verdict | Reason |
|---|---|---|---|---|---|
| MDS `service.ts` (`MarketDataServiceImpl`) | 693 | 2 | `production.ts`; `analysts/types.ts:133` via port | deep | 6-method port hides cache/in-flight dedupe/TTL/telemetry (`:103, :158, :216-248, :499-564`) |
| MDS `sources/normalizing-data-source.ts` | 513 | 6 | subclassed by 3 | deep | 3 abstract hooks (`:307`), widen loop `:383-478` |
| MDS `sources/failover-data-source.ts` | 379 | 5 | `production/data-failover.ts:103` | deep | breaker `:236-294` behind `DataSource` |
| MDS `sources/alpaca-http-client.ts` | 779 | 8 | `defaults.ts:32, :593` (root only) | shallow-ish adapter | 3 crypto branches (`:584, :620, :737`, #1179) |
| MDS `sources/polygon-bars-client.ts` | 286 | 1 | `data-failover.ts:105, :359` | adapter | |
| MDS `sources/lse-mark-source.ts` | 438 | 8 | only `source-factory.ts` `'lse'` arm | hypothetical seam | `LseMarkClient` port `:204-215`, zero adapters (`:32-33`) |
| MDS `source-factory.ts` | 55 | 2 | `defaults.ts:706, :768` | fine | now wired (§6) |
| MDS `index.ts` | 158 | ~70 | — | leaky | exports `Alpaca*`/`LseVendor*` (`:56-70, :88-103`) |
| MDS `trading-calendar.ts` | 1050 | port + 3 impls | trader, orchestrator, analysts | deep | one `TradingCalendar` port `:14-60` |
| MDS `indicators.ts` | 883 | `computeIndicator`, warmup fns | analysts, `defaults.ts:35` | deep | single dispatch entry, rounding fixed `:10` |
| MI `index.ts` (barrel + `MarketIntelligenceStore`) | 558 | ~45 + concrete class `:135` | analysts, agents, smoke, coverage | concrete class as seam | `getContext` `:312-352` is the only read |
| MI `mi-ingest-agent.ts` | 550 | 3 | `production.ts` | deep but hand-wired | deps all concrete (`:120-148`) |
| MI `grok/grok-agent.ts` | 526 | 6 | `production.ts` | deep | `GrokSentimentClient` `:85-134` — real seam (Nous `:130`, XSearch `:251`) |
| MI `polymarket/polymarket-agent.ts` | 832 | 7 | `production.ts` | deep | `PolymarketWireClient` `:254-257`, 1 prod adapter + test fake |
| MI `gdelt-ingest-agent.ts` / `gdelt-scoring-pass.ts` | 365 / 300 | 3 / 5 | `production.ts` | deep | write-only + derive-at-read split |
| MI `sources/gdelt-gkg-client.ts` | 591 | 4 | `GdeltIngestAgent` | deep | zip/crc/size caps behind `latestBatchUrl/fetchBatch` |
| MI `archive/mi-archive-store.ts` | 470 | 6 | agents, scoring pass, root | concrete | Polymarket-only `refusalStreak*` `:432-465` on generic archive (V9) |
| MI `scoring/item-scorer.ts` | 283 | 3 | `MiIngestAgent` | deep | never throws, `degraded` flag `:144-147` |
| MI `worldmonitor-adapter/cii-consumer.ts` | 103 | 3 | none | hypothetical seam | parked by design |
| universe-pool `lse-etp-pool.ts` | 2258 | 21 (via 31-line barrel) | `defaults.ts:38, :624-626`, analysts, `mi-ingest-agent.ts:41` | god-file | header `:1-360`, rows `:641-1773`, lookups `:1775-2256`, import-time `assertValidPool` `:2258` (V8) |

### D.2 Findings

**V1 — MI read/write seam is a concrete class, and tests cast around it.** See D3.
**V2 — MI agents behind no common interface; the class-wide pollers duplicate wrappers.**
`MiIngestAgent.refresh(trace_id, instrument, asset_class)` `:246` and `GrokAgent.refresh` `:303`
share a shape (real seam, 2 adapters). `PolymarketAgent.refresh`/`whenIdle` (`:463, :491`) and
`GdeltIngestAgent.refresh`/`whenIdle` (`:170, :221`) are a second unnamed shape with own
`log/logFailure` wrappers; `MI_SOURCE_HYDRATION` (`mi-sources.ts:68-103`) is compile-enforced for
hydration but nothing enforces "every source has a poller". Proposed:
```ts
export interface MiClassWidePoller { readonly source: MiSourceId; poll(trace_id: string): Promise<boolean>; whenIdle(): Promise<void> }
export type MiPollers = Record<Exclude<MiSourceId, 'alpacaNews' | 'x'>, MiClassWidePoller>;
```
**V3 — `LseMarkClient` is a hypothetical seam carrying ~500 lines.** See D5.
**V4 — Providers depend on `pipeline/debate-engine`.** See D1. Also `lse-etp-pool.test.ts:2-6`
imports `pipeline/trader/subclass-bracket`.
**V5 — Duplicated wire-client infrastructure.** `isFiniteNumber` twice (`alpaca-http-client.ts:215`,
`polygon-bars-client.ts:111`); rate-limiter-inside-retry twice (`alpaca-http-client.ts:532-569`,
`polygon-bars-client.ts:218-238`); two pagination loops with separate caps
(`alpaca-http-client.ts:125, 602-663`; `alpaca-news-client.ts:40, 183-232`); three private default
`TokenBucket`s (`alpaca-news-client.ts:161`, `polymarket-client.ts:165`, `gdelt-gkg-client.ts:116`);
JSON-salvage + `#unreadable` duplicated (`nous-sentiment-client.ts:273, 318-330`,
`x-search-client.ts:390, 545-557`); three symbol translators (`wireSymbol`
`mi-ingest-agent.ts:548-550`, `toAlpacaCryptoSymbol` `alpaca-http-client.ts:311-313`,
`resolveMiSubject` `lse-etp-pool.ts:1838`). See D4.
**V6 — Crypto residue at the type level.** See D8.
**V7 — MDS barrel exports vendor shapes; `ProductionConfig` seam typed on a vendor client.** See D6.
Pipeline output types are clean (`Bar.source: string` audit-only `types.ts:15-32`).
**V8 — `lse-etp-pool.ts` god-file with import-time validation.** See §4. Split `pool-schema.ts`
(types, `assertValidPool`, `assertValidFallbackSubset`, `liquidityGateStatus`), `pool-data.ts` (rows),
`pool-lookups.ts`; validate at the root. Lookups are 5-line functions over `LseEtpPoolRow[]`,
already testable with `makeRow` (`lse-etp-pool.test.ts:28-53`).
**V9 — `MiArchiveStore` knows one source's concept.** `refusalStreak*` `:432-465` serve only
`PolymarketAgent.#refuse` `:790-817`. Low leverage.

### D.3 Falsified

`createDataSource` zero callers — stale (§6). Dead crypto candle clients — gone (§6). Per-vendor
leakage into `pipeline/` — not found; vendors named only in `apps/orchestrator/production/*` and
`data-failover.ts:121-123`. `PolymarketWireClient` hypothetical — test fake is the second adapter;
keep. `AlpacaHttpDataClient` tests stub `fetch` and assert URL shape — that file *is* the wire
adapter; acceptable. `universe-pool` has no barrel — fixed.

---

## Appendix E — `apps/` and `tools/`

### E.1 Inventory

| Module | Lines | Exported symbols | External call sites read | Verdict | Reason |
|---|---|---|---|---|---|
| `orchestrator/production.ts` | 4384 | `buildProductionComponents`, `buildProductionOrchestrator`, `buildDefaultAlpacaBrokerClient`, `startTickLoop`, `ProductionComponents` (23 fields) + ~10 | `index.ts`, `smoke-run.ts`, `tools/place-soak-position.ts:67` | god | one 1550-line function + one 1360-line function |
| `orchestrator/index.ts` | 1286 | ~80 re-exports (`:105-232`) + `startFromEnvironment`, `credentialRequirements`, `buildShutdownHandler` | tools ×4, `service-api/sqlite-query-store.ts:69` | god / pass-through | entrypoint AND barrel AND second composition layer (`:692-961`) |
| `orchestrator/smoke-run.ts` | 7120 | `evaluateSmokeGate`, `PROBES`, … | `yarn smoke` | god | already filed (Fowler §) |
| `orchestrator/paper-profile.ts` | 2910 | `paperStartingProfile`, … | `index.ts`, `tools/report-arm-comparison.ts:53` | deep (data) | wide file, narrow interface |
| `orchestrator/production/direct-bind.ts` | 1600 | `buildTraderStep/RiskStep/VerdictStep/ExecutionStep`, providers | `production.ts` | deep | four `TickSteps[...]` closures, each `build*Step(deps)` (`:1415`) |
| `orchestrator/production/config.ts` | 1232 | `ProductionConfig` (≈75 optional fields), `AlertChannelSlots` (26), 2 fns | root, profiles, tests | shallow-wide | honest seam, 75-field bag |
| `orchestrator/production/defaults.ts` | 932 | ~10 `DEFAULT_*` + builders | `production.ts` | deep | default-client builders behind config fields |
| `orchestrator/production/environment.ts` | 293 | `readProductionEnvironment` + 4 | `production.ts:921` | deep | single typed env read |
| `orchestrator/production/saxo-venue.ts` | 363 | `buildSaxoBroker`, `buildSaxoVenueClient`, `resolveBrokerVenue`, … | `index.ts` ×3 | deep | async adapter build behind `ProductionConfig.broker` |
| `orchestrator/tick-runner.ts` | 594 | `SequentialTickRunner` | `production.ts:3029` | deep | §1 |
| `orchestrator/tick-loop.ts` | 441 | `runTickPlan`, `TailSequencer`, `TickLoopConfig` | `production.ts:2841` | deep | §1 |
| `orchestrator/types.ts` | 485 | `TickSteps`, `TickRunner`, `Scheduler`, `TickContext`, `TickPlan`… | everywhere | deep (interfaces) | the real seams |
| `service-api/sqlite-query-store.ts` | 1057 | `SqliteQueryStore`, `percentile` | `index.ts:284` | deep | 17 public methods = `DashboardQueryStore`; reads only |
| `service-api/snapshot.ts` | 440 | `buildSnapshot` | `server.ts:369` | deep | pure; no inline SQL |
| `service-api/server.ts` | 418 | `createDashboardServer`, bundle helpers | `index.ts`, `fixture-server.ts` | deep | HTTP transport behind `DashboardServerOptions` |
| `service-api/types.ts` | 367 | `DashboardQueryStore` (`:207-366`) + shapes | store, snapshot, fixture | deep (interface) | one port, two adapters |
| `service-api/index.ts` | 308 | none | — | shallow | side effects on import; 4 raw env reads; `new SqliteQueryStore(db, 30, alertChatId)` inline |
| `service-api/fixture-server.ts` | 193 | none | Playwright | pass-through | same `createDashboardServer` seam |
| `supervisor/supervisor.ts` | 278 | `startSupervisor`, `SupervisorEffects`, `SpawnFn`, `SupervisedChild` | `index.ts:45` | deep | §1 |
| `supervisor/index.ts` | 65 | none | `yarn serve` | pass-through | correct thin entry (`import.meta.url` guard `:20`) |
| `tools/backtest/index.ts` | 227 | ~70 re-exports (38 export lines) | 19 non-test files below `tools/` | barrel | D1 |
| `tools/place-soak-position.ts` | 312 | none | `yarn place-soak-position` | re-implementation | A6 |
| `tools/run-stage2.ts` | — | `runStage2`, cost configs | `data-cli.ts:26` | pass-through | sequences backtest seams; correct |
| `tools/report-arm-comparison.ts` | — | `formatArmComparison`, `DEFAULT_WINDOW_DAYS` | CLI | deep (pure) | calls `buildArmComparison`; does not re-implement |
| `tools/check-live-money-gates.ts` | — | `checkLiveMoneyGates`, types | CLI | deep | injected lookup; deliberately bypasses the orchestrator barrel "to avoid dragging the whole runtime in" (`:42-44`) |

### E.2 Findings

**A1 — The composition root is three layers, and the outer two make adapter decisions.** See D2.
**A2 — `production.ts` is a god-module; `ProductionComponents` is a test back-door.** See D2.
`buildProductionOrchestrator` embeds `runMetricsCheck` `:3186-3246`, `runArmComparison`
`:3365-3412`, `runFeedbackCycle` `:3419-3539`, `scheduleFeedbackCycle` `:3659-3771`, `start()`
`:3789-4318` (orphan scan, two reconciles, seeds, heartbeat, GDELT/Polymarket timers, two
`startFillSync`, tick loop).
**A3 — `apps/orchestrator` ⇄ `tools/backtest` is a cycle; app depends on a tool.** See D1.
`tools/backtest/index.ts:2` says the harness "drives the Orchestrator's Scheduler + TickRunner" — it
no longer does (#1156 deleted `BacktestHarness`).
**A4 — Env reads outside a config module.** See D7. `orchestrator/index.ts` `:556, :712, :716,
:1236`; `service-api/index.ts` `:75, :76, :84, :264`; `fixture-server.ts:51, :178, :188`;
`place-soak-position.ts:103-104`; indirect via helpers with env defaults: `production.ts:1097,
:1720`, `saxo-venue.ts:290`, `defaults.ts` `nousCredentials`. Proposed `ProductionEnvironment` gains
`venuePacing` and `sentimentCredentials`; `readDashboardEnvironment(env)` + `startDashboard(env,
deps?)` for the service API.
**A5 — `service-api/index.ts` is module-level wiring with no function.** See D2. Two entry points
= two adapters of "start the dashboard" → the seam is real and missing.
**A6 — `place-soak-position.ts` re-implements execution wiring.** See D2. Hand-rolls an Alpaca
latest-trade HTTP call with raw env reads (`:98-121`) instead of `AlpacaHttpDataClient.getLatestQuote`;
stubs `costModel/marketData/config` with throwing proxies (`:137-146`); no `guardedStore` at `:244`
(unlike `saxo-venue.ts:226`).
**A7 — `orchestrator/index.ts` is barrel + entrypoint + config layer.** See D2.

### E.3 Falsified

Tick loop hand-sequenced by the root — false (`production.ts:2841` → `runTickPlan`; stages in
`tick-runner.ts:148-524`). `SqliteQueryStore` god-module — false (17 methods mirror the port 1:1,
delegate to owning stores `:570-583`; F1's zeroed metrics prior-filed). Supervisor seam ad hoc —
false; no health probing is a stated policy (`:34-38`). Fixture and real dashboard use different
servers — false. Stage-2 runners re-implement the cost model — false (`run-stage2.ts:29` uses
`CostModelImpl`; A3 is an address problem). `LLM_SPEND_CAP_USD` duplicate (client F5) — closed.
