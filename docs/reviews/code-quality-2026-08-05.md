# Code Quality Audit — 2026-08-05

Scope: whole `src/` tree at `9d67044`. 347 TypeScript files, 35,647 non-test lines, 153 test files / 40,023 lines / 1,925 tests.

Axes requested: duplication, performance, efficiency. **Report only — no code changed.**

Findings ranked by (live-money risk × effort to fix). An "Examined, not a defect" section at the end records what was checked and deliberately left alone — read it before acting on anything above, because several patterns that look like duplication are load-bearing.

**Not covered.** This audit did not sweep for dead code or exported-but-never-called mechanisms — that is a correctness axis, not a duplication/performance one, and it deserves its own pass. Nor did it review spec conformance or security. Absence from this report is not evidence of absence in the code.

**Location note.** `docs/reviews/` is a new directory, not in CLAUDE.md's docs convention table. Relocate if another home fits better.

---

## Baseline health

Measured, not assumed:

| Check | Result |
| --- | --- |
| `biome check .` | 351 files, clean |
| `tsc -p tsconfig.json --noEmit` | clean |
| `tsc -p tsconfig.test.json` | **did not exist** — see H2; now clean |
| `vitest run` | 1,924 passed, 1 skipped, **9.3s** (1,926 after the H1 tests) |
| `: any` / `as any` (non-test) | **5** occurrences |
| `tsconfig` strictness | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride` |

This is a well-kept codebase. Comment density is unusually high and the comments carry *reasons*, not restatements — that is a real asset and none of the findings below ask to reduce it. The problems are concentrated in three places: the wire boundary, the composition root, and the test fixtures.

---

## Status

**H1 and H2 are fixed** (commits `9caaaf6`, `683a20c` and the four between them). Everything else below is still open. What the two fixes actually turned up is recorded inline under each finding — in both cases it was worse than this report first predicted.

---

## High — fix before more live capital

### H1. Wire JSON is cast, never validated — GUARD LANDED, VALIDATION STILL OPEN

> **Done (`9caaaf6`):** the two `Number.isFinite` guards in `decide.ts`, plus tests that fail without them. The `NaN`-priced-intent path described below is closed.
>
> **Still open:** the wire-level validation. `alpaca-http-client.ts`, `http-polygon-client.ts` and `anthropic-http-client.ts` still cast unvalidated JSON — Trader now refuses the bad value instead of trading on it, but every other consumer of those clients is still unguarded.


`src/market-data-service/sources/alpaca-http-client.ts:515,531,615,635`
`src/cost-model-backtest/http-polygon-client.ts:128`
`src/debate-engine/llm/anthropic-http-client.ts:117,179`

```ts
)) as CryptoBarsResponse;      // alpaca-http-client.ts:515
const body = (await response.json()) as PolygonAggregatesResponse;   // :128
```

`RawAlpacaBar` declares `o/h/l/c/v: number` and `RawAlpacaQuote` declares `ap/bp: number`; nothing checks either at runtime. `toAlpacaBar` (`:210`) is a bare field-for-field passthrough — no guard of any kind. `normalizing-data-source.ts` validates bar *counts*, not bar *values*.

**The ATR path is already defended.** `trader/decide.ts:114` returns `null` from `atrFor` unless `Number.isFinite(atr)`, and `decide` bails on that. Credit where due — that hole is closed.

**The price path is not.** `decide.ts:196-200`:

```ts
const entry = mark.price;                                  // never checked finite
const volFloor = config.vol_floor_fraction * entry;
const effectiveVol = Math.max(atr, volFloor);
const stopDistance = config.atr_k * effectiveVol;
if (stopDistance <= 0) return null;                        // NaN <= 0 is FALSE — guard passes
```

`mark.price` traces back to `RawAlpacaQuote.ap`/`bp` at `alpaca-http-client.ts:615,635`, cast and never validated. If Alpaca returns `"ap": null` for one quote, `entry` is `NaN`, `volFloor` is `NaN`, `Math.max(atr, NaN)` is `NaN`, `stopDistance` is `NaN` — **and `NaN <= 0` evaluates false, so the one guard on that line lets it through.** A `NaN`-priced `OrderIntent` proceeds to Risk, which contains no finiteness check at all.

`strict` mode cannot catch this; the cast tells the compiler to stop looking.

**Fix.** One narrow-parse function per wire type, at the cast site, replacing the assertion:

```ts
function parseRawBar(raw: unknown, context: string): RawAlpacaBar {
  const r = raw as Record<string, unknown>;
  for (const k of ['o', 'h', 'l', 'c', 'v'] as const) {
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) {
      throw new AlpacaDataProviderError(
        `Alpaca bar field '${k}' is not a finite number (${context}): ${JSON.stringify(raw)}`,
      );
    }
  }
  if (typeof r.t !== 'string') throw new AlpacaDataProviderError(...);
  return r as unknown as RawAlpacaBar;
}
```

Throwing an existing `*ProviderError` means the existing retry/classification path already handles it — no new plumbing. Do the same for `RawAlpacaQuote`, `PolygonAggregatesResponse`, and the Anthropic response body. Effort: ~1 day including tests. No dependency needed; a schema library (zod/valibot) would work but is not required for four shapes.

**Belt-and-braces — done in `9caaaf6`.** Two guards, not one: `!Number.isFinite(entry)` at the quote inlet so a skip names the bad input, and `!Number.isFinite(size)` before the min-notional check, since `size` is the choke point every numeric input funnels through — including `equity`, which arrives from an account read this module also does not validate. Both tests fail without the guards.

### H2. The test suite is never type-checked — FIXED (`683a20c`)

> **Done.** `tsconfig.test.json` + `yarn typecheck`, and the full backlog cleared. The prediction below was that a first run would surface a backlog; it surfaced **126 real errors across 37 files**, and four of them were tests that had stopped testing anything. See "What H2 found" after the fix description.


`tsconfig.json:22`

```json
"exclude": ["node_modules", "dist", "**/*.test.ts"]
```

`tsc` skips every `.test.ts`. Vitest transpiles without type-checking, and `vitest.config.ts` sets no `typecheck` block.

**Checked for a second entry point and found none:** `tsconfig.json` is the only tsconfig in the repo; `package.json` invokes `tsc` exactly once (`build`, against that config); the sole CI workflow (`.github/workflows/ai-review.yml`) runs `pip install openai` and `python .github/scripts/run_review.py` — no `tsc`, no `typecheck`, no `vitest --typecheck` anywhere under `.github/`.

So **40,023 lines of test code — 53% of the repo — have zero type coverage.** A test that constructs a stale `OrderIntent`, or a mock whose method signature no longer matches its port, compiles and passes silently. For a system whose safety argument rests on its tests, that is the wrong side of the trade.

**Fix.** Keep the build config lean, add a checking config:

```jsonc
// tsconfig.test.json
{ "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*.ts"] }
```

and `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json"`.

**Two implementation notes, both learned the hard way.**

`extends` inherits the base `exclude`, and `exclude` filters whatever `include` matched — so widening `include` alone leaves `**/*.test.ts` excluded and the config silently checks **nothing**. The first version of this file reported "0 errors" and was checking zero test files. Both keys must be set. Verify by injecting `const x: number = 'nope'` into a `.test.ts` and confirming it fails; do that again after any later edit to the config.

`vitest.config.ts` sets `globals: true`, so the config needs `"types": ["node", "vitest/globals"]` or every `describe`/`it`/`expect` is unresolved. The build config stays on `["node"]` — shipped code must not see them.

`noUncheckedIndexedAccess` is relaxed **in the test config only**. Measured: 193 errors with it on, 66 from the rule itself across 15 files, none a real defect — all `arr[0]` after an explicit length assertion. Each would need a `biome-ignore lint/style/noNonNullAssertion` line under this repo's style (~130 lines of noise), and the failure mode differs: silent `undefined` propagation in production, a loud throw in a test. Production keeps the rule.

#### What H2 found

126 errors across 37 files. Most were doubles that had fallen behind their ports, but four were tests that had quietly stopped testing their subject:

- **The volatility breaker was inert in the composed-tick integration test.** `production.test.ts` stubbed `VolatilityReading` as `{ atr_percentile: 0.5 }` behind an `as VolatilityReading` cast. The type is `{ crypto, stocks }`, so both real fields were `undefined`, every comparison against the trip threshold was false, and the breaker has never actually evaluated in that chain. Correcting the shape made the test fail — because the breaker finally ran.
- **A vacuous assertion in `rate-limit-wiring.test.ts`:** `expect(config.alpacaBrokerClient?.listOrders).not.toHaveBeenCalled()`. `AlpacaClient` has no `listOrders`, so this read `undefined` off the stub and passed whatever the wiring did.
- **`alpaca-adapter.test.ts` had one construction missing `unpricedFillAlerts`** — the seam whose own doc comment says a construction that forgets it "cannot exist".
- **`snapshot.test.ts`'s spend fixture never grew `per_debate`** (added by #326, `cbea81f`), so the dashboard snapshot tests asserted against a window shape production had stopped producing.

Three fixes went into production code rather than tests, because the port was the problem: `buildRiskStep` now takes `CiiScoreSource` (`Pick<CiiConsumer, 'getScores'>`) instead of the concrete class, whose private `cache`/`inFlight`/`provider`/`clock` made a structural double impossible; `AlpacaBrokerAdapter.getOrder` and `AlwaysOpenCalendar.isOpen`/`isTradingDay` now declare the parameters their ports pass.

**CI does not run it.** `.github/workflows/ai-review.yml` is the only workflow and it runs a Python review script. `yarn typecheck` is local-only until that changes — worth a CI step, or the backlog rebuilds.

---

## Medium — duplication

### M1. Four hand-copied vendor error hierarchies

`src/market-data-service/sources/alpaca-data-errors.ts` (170 lines)
`src/execution/adapters/alpaca-broker-errors.ts` (111)
`src/verdict/notifications/telegram/telegram-errors.ts`
`src/debate-engine/llm/anthropic-http-client.ts` + `llm/errors.ts`

Each independently defines the identical five-part shape:

1. `{Vendor}TimeoutError`, `{Vendor}RateLimitError` (with `retryAfterMs`), `{Vendor}ProviderError` (with `status`)
2. a union type of the three
3. `isRetryable{Vendor}Error` — `Timeout | RateLimit | Provider with status >= 500`
4. `classify{Vendor}Response` — `429 → RateLimit`, `408|504 → Timeout`, else `Provider`
5. `classify{Vendor}NetworkError` — `DOMException` named `TimeoutError` → `Timeout`, else `Provider`

`diff alpaca-data-errors.ts alpaca-broker-errors.ts` is, past the doc comments, a find-and-replace of `Data` → `Broker`.

**The separation itself is correct and documented** — the two Alpaca APIs must not couple their classification, and the doc comments say so explicitly. What is duplicated is the *mechanism*, not the *decision*.

**Fix — extract the logic, keep the classes hand-written.** Three small helpers in `shared/http/`, alongside the `truncateForError` / `parseRetryAfterMs` that already live there:

```ts
// shared/http/read-error-body.ts — verbatim in all four files today
export async function readErrorDetail(response: Response): Promise<string> {
  let bodyText: string;
  try { bodyText = await response.text(); } catch { bodyText = ''; }
  return bodyText.length > 0 ? truncateForError(bodyText) : response.statusText;
}

// shared/http/classify-status.ts
export type HttpErrorKind = 'rate-limit' | 'timeout' | 'provider';
export function classifyStatus(status: number): HttpErrorKind {
  if (status === 429) return 'rate-limit';
  if (status === 408 || status === 504) return 'timeout';
  return 'provider';
}

// shared/http/is-timeout-abort.ts
export function isTimeoutAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}
```

Each vendor module then keeps its own three error classes, its own union, its own exported names, and its own doc comment explaining why it stays separate — its `classifyXResponse` just shrinks from ~15 lines to ~4. Vendors that deviate (Telegram reads `parameters.retry_after` out of the JSON body; Alpaca-data adds a non-retryable `SparseHistory` case) keep those locally. Removes ~120 lines. Effort: ~2 hours.

**Deliberately *not* recommending a `createVendorErrors(name)` factory** that mints the classes too. It would cut more lines, but classes returned from a function are not usable as type names — every consumer would have to write `InstanceType<typeof AlpacaDataErrors.TimeoutError>` instead of `AlpacaDataTimeoutError`, and the per-vendor union types get worse in the same way. The three classes per vendor are 12 lines of boilerplate that read fine; the fifteen-line classifier bodies are the part that actually costs something to keep in sync.

### M2. `ClosedTradeRow` + `fromClosedTradeRow` triplicated byte-for-byte

`src/dashboard/sqlite-query-store.ts:117,182`
`src/feedback-loop/sqlite-closed-trade-store.ts:19,50`
`src/execution/sqlite-store-harness.ts:35,94`

The three `fromClosedTradeRow` bodies hash identically (`md5 995699e4…`). The three `ClosedTradeRow` interfaces differ only in writing `asset_class: AssetClass` vs the inlined `'crypto' | 'stocks'` — which `shared/types.ts:15` defines as exactly that union, so they are the same type spelled two ways.

Note that keeping `ClosedTradeRow` (`opened_at: string`) separate from `ClosedTrade` (`opened_at: Date`) is the right call — see "Examined, not a defect". The defect is having **three copies of the same row type**, one of which is in test-only scaffolding.

**Fix.** `src/shared/store/closed-trade-row.ts` exporting `ClosedTradeRow` and `fromClosedTradeRow`; the three sites import it. `sqlite-shared-store.ts:30` already gestures at this ("Exported for `sqlite-store-harness.ts`, which reads the same row shape") — finish the move. Effort: ~1 hour. Zero behavioural risk; the mappers are provably identical.

### M3. 209 hand-rolled test fixture builders, no shared module

| Builder | Files defining it locally |
| --- | --- |
| `makeIntent` | **16** |
| `makeView` | **14** |
| `makeTrade` | 6 |
| `makeDecision` | 5 |
| `makePosition` | 4 |
| `makeBars` | 2 |
| — total `function make*` in tests | **209** |

The duplicate scan's top hits are all this: the same `OrderIntent` literal — `idempotency_key: 'AAPL-2026-07-15T13:55:00Z'`, `conviction: 0.72`, `base_risk_fraction: 0.01` — appears verbatim in 14 files. `src/` has fixture modules for *stores* (`fixture-store.ts`, `fixture-stores.ts`, `fixture-setup-store.ts`) but none for *domain objects*.

**Why it matters beyond tidiness:** adding a required field to `OrderIntent` means editing 16 fixtures. Because of H2, forgetting one does not fail the build — it fails at runtime, in a test, possibly as a false pass. M3 and H2 compound.

**Fix.** `src/shared/testing/fixtures.ts` with `makeIntent(overrides?: Partial<OrderIntent>)`, `makeView`, `makeTrade`, `makeDecision`, `makePosition` — the existing signatures already take `Partial<T>` overrides, so migration is mechanical (delete local builder, add import). Add `src/shared/testing/**` to the coverage `exclude` list in `vitest.config.ts`. Effort: ~half a day, high leverage. Do this *after* H2 so the compiler catches migration slips.

### M4. Small verbatim copies

| What | Where | Fix |
| --- | --- | --- |
| `truncateForError` | local copy at `debate-engine/llm/anthropic-http-client.ts:96`, canonical at `shared/http/response-errors.ts:29` | import the shared one |
| `sleep` / `delay` | `shared/http/retry.ts:21`, `shared/http/token-bucket.ts:26`, `orchestrator/smoke-run.ts:733` — all `new Promise((resolve) => setTimeout(resolve, ms))` | export one from `shared/` |
| OHLCV field block | `market-data-service/types.ts:22`, `ingestion.ts:23`, `sqlite-market-data-store.ts:19`, `sources/ibkr-source.ts:21`, `cost-model-backtest/stage2-historical-store.ts:51` | check each: some are `Bar`, some are row types (legitimate), some are re-declarations (not) |

Effort: under an hour total.

---

## Medium — performance and efficiency

**Framing first.** This system is not throughput-bound. Six instruments on a scheduled tick, 1,925 tests in 9.3s, SQLite on local disk. The dominant cost driver is **LLM call count × tick cadence**, not CPU or SQL — no amount of query tuning touches that, and only cadence does. Nothing below will move the P&L. They are listed because they are cheap to fix and two of them are quadratic, which stops being free as the universe widens.

### P1. `ingest-fills` is O(positions × fills)

`src/execution/ingest-fills.ts:36-56`

```ts
const fills = await broker.fetchNewFills(since);
for (const position of positions) {
  await advanceLot(input, position, fills, now);   // :38
}
// inside advanceLot:
const lotFills = fills.filter((fill) => fill.client_order_id === position.idempotency_key && ...);
```

The full fill array is re-scanned once per open position. `since` is the *oldest* open lot's `opened_at`, so on a long-lived process with one stale open lot, `fills` grows to cover that whole span while `positions` grows with the universe.

**Fix.** Bucket once before the loop:

```ts
const byLot = new Map<string, NormalizedFill[]>();
for (const fill of fills) {
  const bucket = byLot.get(fill.client_order_id);
  if (bucket === undefined) byLot.set(fill.client_order_id, [fill]);
  else bucket.push(fill);
}
```

then `advanceLot` takes `byLot.get(position.idempotency_key) ?? []`. The `timestamp <= now` no-lookahead filter stays inside `advanceLot` — it is per-call semantics, not a grouping key. Effort: 30 min.

### P2. Serialized broker round-trips in `reconcile`

`src/execution/reconcile.ts:45`

```ts
for (const position of inFlight) {
  const divergence = await reconcileLot(input, position);   // each does await broker.getOrder(...)
}
```

N sequential network calls at startup, one per in-flight lot. On a crash-restart with a dozen stranded lots this is a dozen serial round-trips before the first tick.

**Caveat — verify before changing.** This repo has `shared/http/venue-pacing.ts` and `shared/http/token-bucket.ts`, and `alpaca-http-client.ts:168` documents a shared ~200 req/min budget with an explicit warning that a market-data crawl "could starve live order placement". Some serialization here may be deliberate. **Do not blanket-apply `Promise.all`.** If it is changed, use bounded concurrency (4–8) routed through the existing token bucket, and confirm `reconcileLot`'s store writes are safe interleaved. Same shape at `orchestrator/orphan-verdict-scan.ts:108` (sequential `postOrphanAlert`) — there the serialization is arguably correct, since alert channels are rate-limited and ordering is meaningful.

Effort: 2 hours including the pacing verification. Low payoff — startup-only. Listed for completeness, not urgency.

### P3. Dashboard N+1 on marks

`src/dashboard/snapshot.ts:48` calls `store.getMark(position.instrument, asOf)` inside the position loop; `sqlite-query-store.ts:331` runs `SELECT * FROM latest_mark WHERE instrument = ?` per call, re-compiling the statement each time. One HTTP request to the dashboard = one query per open position.

**Fix.** Add `getMarks(instruments: string[]): Map<string, Mark>` using `WHERE instrument IN (...)`, keep `getMark` delegating to it for the single-instrument callers. Effort: ~1 hour.

### P4. Prepared statements are never cached — *footnote, measure first*

83 `.prepare()` call sites across 20 store modules, every one inside a method body rather than the constructor, so `better-sqlite3` recompiles the SQL on each call (it does not cache internally). Example: `orchestrator/sqlite-session-equity-store.ts:47,82,110,127`.

At tick cadence this is irrelevant — do not churn 20 files for it. It is worth doing **only** on the dashboard read path (P3), where it is per-HTTP-request rather than per-tick. Pattern:

```ts
export class SqliteSessionEquityStore {
  readonly #get = this.db.prepare('SELECT ... WHERE asset_class = ?');
  constructor(private readonly db: SharedStore) {}
}
```

Measure before generalising.

---

## Low — structure and maintainability

### L1. `production.ts` is a 1,891-line composition root

- 52 imports
- `ProductionConfig` interface: **283 lines** (`:262-544`)
- `buildProductionComponents`: **270 lines** (`:1078-1347`)
- its test file is 2,058 lines — the largest file in the repo

The `production/` subdirectory already exists (`debate-adapter.ts`, `account-state.ts`, `direct-bind.ts`, …), so the pattern for splitting is established and partially applied. Suggested split, respecting existing seams:

- `production/config.ts` — `ProductionConfig`, `FeedbackCycleConfig`, `DailyMetricsConfig`, and their defaults
- `production/defaults.ts` — `buildDefaultLlmClient`, `buildDefaultAlpacaBrokerClient`, `buildDefaultAlpacaDataClient`, `buildAlpacaDataSource`
- `production.ts` — retains `buildProductionComponents` / `buildProductionTickRunner` / `buildProductionOrchestrator` / `startTickLoop`

Re-export from `production.ts` so no import site changes. Effort: ~half a day, mechanical, but touches the highest-risk file in the repo — do it on its own branch with the 2,058-line test as the gate.

The payoff is not aesthetic. A composition root this size is exactly where a wired-but-never-called mechanism hides: the component is built, its unit tests pass, and nothing in the 270-line `buildProductionComponents` actually reaches it. Smaller, single-purpose builder modules make that omission visible at review.

`paper-profile.ts` (1,248) and `smoke-run.ts` (907) are the next two; both are configuration-as-code and less urgent.

### L2. `SELECT *` + row cast defeats the type system

14 `SELECT *` queries paired with `as SomeRow[]`. `sqlite-query-store.ts:220,232,257,320` are the concentration.

A migration that renames or drops a column type-checks perfectly and fails at runtime with `undefined` where a number was promised. The cast is unavoidable with `better-sqlite3` — the column list is not.

**Fix.** Name the columns in the `SELECT`. It does not make the cast sound, but it turns a silent `undefined` into a loud SQLite error at the query, at startup, in the right module. `sqlite-session-equity-store.ts:50` already does this correctly — apply that style repo-wide. Effort: ~2 hours.

### L3. Tests emit production JSON logs to stdout

`yarn test` prints hundreds of structured log lines (`"ProductionConfig.feedback is not set — the daily feedback cycle will NEVER run…"` and friends) interleaved with results. Real failures are easy to lose in it, and the noise discourages reading the output at all.

**Fix.** Inject a null logger in the orchestrator tests that do not assert on log content, or add a vitest `setupFiles` that silences the default sink unless `SAMURAI_TEST_LOGS=1`. Effort: ~1 hour.

---

## Examined, not a defect

Recorded so nobody re-opens these.

**All 16 bare `catch {}` blocks are correct and documented.** Every one was read with surrounding context. They fall into three justified groups: (a) reading an error response body that itself fails — `alpaca-data-errors.ts:143`, `alpaca-broker-errors.ts:81`, `telegram-errors.ts:109`, `anthropic-http-client.ts:117`, all degrading to `''`/`undefined` and falling back to `response.statusText`; (b) parsing untrusted JSON where malformed input *is* the expected case and returns a typed `{ valid: false, reason }` — `personas.ts:87,105`, `disagreement-detector.ts:77,193`; (c) last-resort logging/shutdown paths with an explicit written argument for why the exception has nowhere to go — `rotating-file-sink.ts:279,368`, `logger.ts:113`, and `alpaca-adapter.ts:451`, which discards a channel error deliberately because the error text would carry a bot token. **This is a strength, not a finding.**

**Row types separate from domain types — keep.** `SessionEquityRow.open_at: string` vs `SessionEquitySnapshot.open_at: Date`; `ClosedTradeRow.opened_at: string` vs `ClosedTrade.opened_at: Date`; `observed_at_boundary: number` vs `boolean`. The duplicate scanner flags these as near-identical interfaces. They are not duplication — they are the SQLite representation deliberately not leaking into the domain. M2 asks only that the *three copies of one row type* be collapsed, never that row and domain be merged.

**Four vendor `{o,h,l,c}` DTOs — keep.** `http-polygon-client.ts:45`, `stage2-historical-store.ts:33`, `alpaca-http-client.ts:179`, `alpaca-source.ts:24`. Four independent wire formats that happen to share field names today. Unifying them would couple this system's types to a coincidence between two vendors' JSON.

**Retry is already centralised.** 13 files matched `backoff|maxRetries|retries`, which looked like reimplementation. It is not: `shared/http/retry.ts:81` holds the only `for (let attempt = ...)` loop in the codebase, and the three real callers (`alpaca-http-client.ts:433`, `telegram-bot-api-client.ts:485`, `anthropic-client.ts:220`) all go through `withRetry`. The other hits are type aliases and doc comments referencing it. No finding.

**`IndicatorCache` is bounded.** `indicator-cache.ts` implements a 50k-entry LRU over insertion-ordered `Map`, with a doc comment naming the OOM risk it closes (code-review 2026-08-01, C4). Correct.

**Store layer is properly funnelled.** Exactly one module opens a database with a pragma set (`shared/store/open-shared-store.ts:98-100`: WAL, `synchronous = FULL`, `foreign_keys = ON`); migrations are centralised in `shared/store/migrations/`. `cost-model-backtest/stage2-historical-store.ts:22` opens its own — correct, it is a separate backtest corpus, not the trading DB.

---

## Suggested order

| # | Item | Effort | Why this order |
| --- | --- | --- | --- |
| ~~0~~ | ~~**H1 quick guard**~~ | — | **Done** `9caaaf6` |
| ~~1~~ | ~~**H2** typecheck the tests~~ | — | **Done** `683a20c` — 126 errors cleared |
| 2 | **H1** validate wire JSON | ~1 day | Still the only finding that can put a wrong number into an order, for every consumer except Trader |
| 3 | **M2** shared `ClosedTradeRow` | 1 hr | Provably identical; zero risk |
| 4 | **M4** small dupes | 1 hr | Trivial |
| 5 | **P1** `ingest-fills` bucketing | 30 min | Quadratic, isolated |
| 6 | **M3** shared test fixtures | ~half day | Needs H2 first to catch migration slips |
| 7 | **M1** shared HTTP error helpers | 2 hrs | ~120 lines, four files stop drifting |
| 8 | **L2** name the `SELECT` columns | 2 hrs | Turns silent drift into loud failure |
| 9 | **P3** batch dashboard marks (+ cache those statements) | 1 hr | Only place P4 is worth doing |
| 10 | **L3** silence test logs | 1 hr | Makes failures readable |
| 11 | **L1** split `production.ts` | ~half day | Highest risk file; own branch, own PR |
| — | **P2** reconcile concurrency | 2 hrs | Verify venue pacing first; may be correct as-is |

Items 0 and 1 are done. The rest is roughly three focused days.

**One item M3 should absorb:** the H2 pass added two copies of a five-line `resolvedUnexpectedly` helper (`orchestrator/index.test.ts`, `orchestrator/startup.test.ts`) because there is nowhere shared to put it. That is the same gap M3 describes — when `src/shared/testing/` exists, both move there.
