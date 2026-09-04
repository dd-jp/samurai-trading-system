# Entire-app review — 2026-09-04

Two-axis review of the whole codebase at `6087581`, run as eleven parallel reviewers: five on
**Standards** (does the code follow `docs/coding-standards.md`, plus a Fowler smell baseline), five on
**Spec** (does the code match `docs/specs/` as amended by ADR-0014–0018 and ADR-0008 §2), and one
dedicated **reachability** pass. The two axes are reported separately and deliberately not merged or
cross-ranked: a change can follow every standard while implementing the wrong thing, and the reverse.

## Method and its limits

- **There is no diff.** `HEAD` is clean on `main`, so the review unit is the file set per module, not
  `git diff`. Scope was cut along `docs/specs/`'s ~1:1 mapping onto module directories.
- **Coverage is a sample, not exhaustive.** The tree is ~97k non-test TypeScript lines across 908
  tracked files. Each reviewer states what it read; silence over a file is not clearance. The one
  exception is the reachability pass, whose *mechanical* sweep is complete (903 exports across 360
  production files, full relative-import graph); only its judgement layer — is this export a
  *mechanism* or an internal helper? — is a sample of ~30.
- **Prior findings are referenced, not re-filed** (`docs/reviews/README.md` convention). Every
  reviewer was given the live reports to dedupe against, with particular weight on
  `universe-path-gap-sweep-2026-09-03.md`, written the day before this one.
- **Spec findings are typed.** Every Spec finding is either **(i) CODE IS WRONG** or **(ii) SPEC IS
  STALE**. On this repo an undifferentiated "code ≠ spec" is mostly (ii) and is what makes a report
  unusable. Reviewers carried an explicit supersession suppression list (crypto out of scope
  2026-08-16; `EQUITY_LEG_FRACTION_OF_CAPITAL` deleted; Saxo not T212, #946; the tranche ladder
  rejected #708; ADR-0016's expectancy wrong in sign; `devils-advocate` declined 2026-09-02).

---

## Standards

### The dominant defect class is still live: seven unwired mechanisms

`docs/coding-standards.md` names this repo's dominant defect as "a complete, tested mechanism with no
production caller", recurring 9+ times (#327, #364, #366, #371, #374, #379, #388, #432, #433), and
notes "unit tests cannot see it by construction". The reachability pass found seven current
instances. Two reviewers independently found the first.

1. **`createDataSource` — UNWIRED.** `server/providers/market-data-service/source-factory.ts:41`. Its
   only non-test references are its own declaration and the barrel re-export at
   `market-data-service/index.ts:43`. Zero call sites. It is the switch turning a `DataSourceConfig`
   into a source, and production instead constructs directly in `production/defaults.ts`
   (`buildAlpacaDataSource`) and `production/data-failover.ts`. So the whole `DataSourceConfig` union
   is capability-shaped code with no consumer, including the `kind: 'lse'` arm added by #734 — and
   three source classes reachable only through it are unconstructed: `IbkrDataSource`
   (`sources/ibkr-source.ts:55`), `CcxtDataSource` (`ccxt-source.ts:195`), `LseMarkDataSource`
   (`lse-mark-source.ts:332`) — ~865 lines plus the 56-line factory. `IbkrClient` has no
   implementation in the tree at all. The factory's own header states the intent it does not meet:
   "the single place a source name resolves to an implementation".
2. **`ConsoleApprovalChannel` — UNWIRED, with a stale comment asserting the opposite.**
   `server/apps/orchestrator/console-channels.ts:713` is never constructed outside tests;
   `production.ts:1912` reads `approvals: config.approvals ?? new UnwiredApprovalChannel()`. But
   `server/apps/orchestrator/alert-transport.ts:87` states "`ProductionConfig.approvals` still falls
   back to `ConsoleApprovalChannel`". That is false, and it is load-bearing prose about a live-money
   HITL gate.
3. **`SignedApprovalChannel` — UNWIRED.**
   `server/pipeline/verdict/notifications/verified-approval-channel.ts:45`, barrel-exported at
   `verdict/index.ts:409`, never constructed. Distinct from the `TelegramApprovalGateway` entry
   already in `codebase-review-2026-08-06.md:49`.
4. **`DiscordChannel` — UNWIRED.** `verdict/notifications/discord-channel.ts:14`, exported at
   `verdict/index.ts:376`, never constructed, while its sibling `TelegramChannel` is
   (`alert-transport.ts:477`). Note the `DiscordClient` *transport type* is live; the
   `TradeChannelNotifier` adapter class is not.
5. **`crossesPromptTier` — UNWIRED.** `server/shared/llm/pricing.ts:375`, zero references outside its
   own file. Its doc comment states its purpose is "so a caller can WARN on a crossing rather than
   have a 2.5x unit-cost change happen silently inside the meter" — there is no such caller, so a
   2.5× prompt-tier cost step *does* happen silently.
6. **`BacktestHarness` / `SqliteConfigTrialLog` — UNWIRED.** `server/tools/backtest/backtest.ts:58`,
   `sqlite-config-trial-log.ts:40`. Neither is constructed by any tool entry point.
7. **Crypto candle clients retained post-descope.** `sources/bitstamp-candles-client.ts`,
   `coinbase-candles-client.ts` are reachable only from `server/tools/`, never from an app entry
   point. Crypto left scope 2026-08-16.
8. **UNASSERTED (weaker).** `miRefreshQueue` (7 references in `production.ts`, 0 in the gate) and
   `resolveVenuePacing` have no `evaluateSmokeGate` row. Both have composition-root wiring tests,
   which is the escape hatch `smoke-run.ts:3560ff` sanctions for #1083 — residual risk, not a
   violation.

**Gate quality is good.** `evaluateSmokeGate` is genuinely enforcement-aimed: every evidence bundle
is a *required* parameter with a recorded mutation-kill rationale, and no assertion was found that
checks construction rather than effect. The standard's own origin example is also fixed, twice over:
`risk-manager/index.ts` `evaluate()` now runs `ENTRY_CAP_GATES` in a loop with named gate functions,
and `feedback-loop/daily-cycle.ts`'s "Dial 1/2/3" headers now sit on extracted
`tuneAnalystWeights` / `applyTuningProposals`.

### Hard violations

**S1 — Barrel routing is breached at ~45 sites, and three modules make compliance impossible.**
Two distinct defects wear one label:

- *A legal route exists and is bypassed.* `contracts/` is bypassed **wholesale — 18 sites**:
  `contracts/index.ts` is a real barrel, yet nothing imports it. `server/apps/service-api/types.ts:18-25`
  reaches `contracts/metrics.js`, `contracts/pipeline.js`, `contracts/primitives.js`,
  `contracts/snapshot.js` directly; also `pipeline-query.ts:38`, `sqlite-query-store.ts:31`,
  `provider-status.ts:63,72`, `orchestrator/debate-decision.ts:33`, `shared/types/records.ts:379,383`,
  `shared/store/key-scheme-guard.ts:32`, and more. `boundary.test.ts` enforces *outbound* purity only,
  so nothing catches inbound routing. Consequence already visible: `StoreMode` has three routes and
  one module uses two of them (`service-api/types.ts:20` vs `service-api/server.ts:28`).
  `shared/store/sqlite-utils.js` is deep-imported at ~10 sites across `orchestrator/`, `service-api/`,
  `pipeline/` and `tools/` despite being exported at `shared/store/index.ts:32`; `safe-log` likewise
  (`shared/index.ts:75`) at `production.ts:204` and both fault-guards.
- *No legal route exists.* **`server/shared/http/` has no `index.ts` at all** — `delay.ts`,
  `fetch-with-timeout.ts`, `retry.ts`, `response-errors.ts`, `token-bucket.ts`, `venue-pacing.ts` —
  so `smoke-run.ts:218` and `provider-status.ts:43` *cannot* comply. **`server/providers/universe-pool/`
  likewise has no barrel**, and six cross-module files reach into `lse-etp-pool.ts` directly
  (`analysts/{sentiment,fundamental,technical}-analyst.ts`, `mi-ingest-agent.ts:41`,
  `production/mi-coverage.ts:46`, `production/defaults.ts:36`). `env-integer.ts` and
  `stdout-fault-guard.ts` are re-exported from nowhere. **These are missing-barrel defects, not
  importer defects** — fix the barrels first, then the importers.
- *Not repointable.* `trader/early-exit.ts:86` is a **value** import into another module's internals
  for symbols the barrel doesn't carry: `import { type AxisVote, MACD_SPEC, momentumVote, RSI_SPEC }
  from '../analysts/technical-analyst.js'`. Needs those four added to `analysts/index.ts`.
- *A rule that needs a ruling.* `trader/decide.ts:38` imports `type DebateResult` from
  `../debate-engine/types.js` — a deliberate, in-file-argued breach to avoid pulling the engine's
  graph into the Trader. The standard carries no type-only carve-out. Either amend the standard or
  fix the import; today it is both.

**S2 — Comments that are now factually wrong.** "A wrong comment is worse than none" (CLAUDE.md), and
these mis-state counts a future edit would trust:
- `trader/decide.ts:1315` — "The Trader has thirteen distinct ways to produce no order". `TraderSkipReason`
  (`:1097`) has **19** members. `:1281` says "the twelve skip sites … a fourteenth" — neither correct.
- `decide.ts:1073` — an orphaned docblock describing `routeDecision` sits immediately above
  `TraderSkipReason`'s own docblock at `:1086`; the function it documents is 90 lines away.
- `feedback-loop/fixture-stores.ts:9-10` — "These survive as the in-memory pair for tests **and for the
  offline backtest**". Zero non-test constructors exist; the backtest half is false.
- `client/src/lib/trace.ts:41-45` — a doc comment for `cellsByStageOf` is attached to `decisionOf`.
- `supervisor/supervisor.ts:19` — "`sharedStorePath()` derives the database filename from `NODE_ENV`".
  False since #330; `open-shared-store.ts:118` keys on `SAMURAI_MODE`. The conclusion survives, the
  stated reason does not.
- `analysts/types.ts:225` ("weight store … not built yet" — built, #371/#435), `analysts/orchestrator.ts:3-5`
  (crypto persona split), `conviction-score.ts:13-15` ("formula … TBD" — resolved 2026-08-14).

**S3 — Changelog comments, concentrated in three files.** The standard keeps *reasons* and bans the
how-it-got-here essay. `trader/decide.ts` is 974 comment lines of 1532, with 121 issue refs — against
the 144 in `production.ts` the standard cites as its own pathology. Clearest instances: `decide.ts:76`
quotes a commit SHA ("the exact off-by-one commit `0281a8c` already had to fix once");
`decisionBarFor` `:330-345` carries a "## Two earlier shapes, and why each failed" section; `:576-590`
is a comment narrating prior revisions of itself ("PR #461 review corrected an earlier version of this
comment that claimed otherwise"). `execution/ingest-fills.ts` carries **129** refs in 1813 lines,
including a 50-line `EVALUATED AND DECLINED` essay on #838 inside `ingestFills`'s body whose actual
rule is one sentence; `execution/execute.ts:284` opens with "NOT 'never blocking' — an earlier revision
of this comment claimed that, and it was false."
*Cleared:* `production.ts`'s 286 refs are against 3,582 lines (was 1,891 at 144) and only ~8 match the
narrative shape. The 2026-08-06 cleanup largely held; this is a targeted sweep of three files, not a
systemic regression.

**S4 — One genuine mid-wiring `process.env` read.** `production.ts:1590`, inside
`buildProductionComponents`: `positiveIntegerFromEnv(process.env[ENV_X_MAX_SEARCH_RESULTS], …)`. Its
two neighbours are compliant (`config.sentimentEnabled ?? process.env…`); this one has no config
field, so a programmatic caller cannot set it. Every other `process.env` hit in scope is a sanctioned
option-site default. **This rule is otherwise in good health** across providers, `write-guard.ts`,
`venue-pacing.ts`, `logger.ts` and `live-profile.ts`.

**S5 — `formatQty` can render a bare trailing dot.** `client/src/lib/format.ts:155`:
`return value.toFixed(4).replace(/0+$/, '')`. Verified: `1.00001 → "1."`, `100.00004 → "100."`. The
module's own docblock promises "none of them can emit `NaN` into visible text"; this is the same
class. Reached from `LiveTab.tsx:216`, `ReviewTab.tsx:458`, `GlanceTab.tsx:184` (fill sizes). Latent
against current fixtures; a fractional fill at 5+ dp hits it. Fix: `/\.?0+$/`.

**S6 — Test stubs behind casts.** 97 `as unknown as` / `@ts-expect-error` in `apps/` + `shared/` tests
— exactly the shape the standard names. Worst: `rate-limit-wiring.test.ts:168`
`rateLimiterConfig: {} as unknown as NonNullable<ProductionConfig['rateLimiterConfig']>` — an empty
object standing in for the very config whose wiring the test exists to prove.

**S7 — A test fixture ships in production source.**
`market-data-service/forming-candle-client.ts:1` is headed "Shared test fixture (issue #362 review)",
is not a `.test.ts` file, is in the build output, and its only importers are two test files. It is also
unreachable from every entry point (see reachability). Already noted at
`codebase-review-2026-08-06.md:49`; referenced, not re-filed.

**S8 — Section-header banners.** `smoke-run.ts:1604-1846` is eight `// --- Scenario N (#…) ---`
banners over inline blocks; `client/src/lib/format.ts:82-91` and
`tools/run-spread-calibration.ts:377-379` carry the same shape. The standard's ruling: a section header
is an unextracted function.

### Judgement calls (Fowler baseline)

- **Divergent Change + Long Function — `evaluateSmokeGate`, `smoke-run.ts:3427-4571`: 1,144 lines, one
  function, 86 `failures.push` sites.** Every new mechanism edits this one function. Not covered by
  prior reviews (code-quality-2026-08-05's L1 was `production.ts`). The refactor is constrained: the
  standard's "prefer a required argument" rule was mutation-earned, so any split must preserve the
  compile-error property.
- **Data Clumps — eleven `*Evidence` options fields** threaded individually into that gate
  (`smoke-run.ts:3468-3557`), each with a paragraph defending its required-ness by hand. A
  `SmokeScenario` interface (`run()` → evidence, `assert(failures)`) collapses the clump *and* keeps the
  property mechanically.
- **Data Clump — `quote_bid`/`quote_ask`/`quote_mid`/`quote_observed_at`** travel flat through
  `execute.ts:258-262`, `types/store.ts:442-445`, `sqlite-shared-store.ts:166/294/618`, with the same
  per-field null-spread repeated three times. One `QuoteSample` type removes it.
- **Duplicated Code — `fundamental-analyst.ts` / `sentiment-analyst.ts`.** `directionFrom` and
  `confidenceFrom` are byte-identical, and the whole `run` body is the same shape differing only in
  `.news` vs `.social` and one market read. `MI_CONTEXT_WINDOW_MS` is declared three times.
- **Duplicated Code — `routeDecision` (`decide.ts:1345`) / `routeExitCheck` (`:1461`)** share an
  identical preamble including the flatten-window ordering, which comments at `:1379` and `:1489`
  *separately* declare load-bearing on each path. Exactly the shape where a future fix lands on one
  path only.
- **Duplicated Code — `requestInit()` is byte-identical** at `gdelt-gkg-client.ts:108` and
  `polymarket-client.ts:123`, rationale comment included. Note the divergence it reveals: MDS clients
  use `shared`'s `fetchWithTimeout`, MI clients hand-roll.
- **Duplicated Code — three main-guard idioms across 17 sites** in `server/tools/`. The naive
  `import.meta.url === \`file://${process.argv[1]}\`` form breaks on paths with spaces, which is why the
  other two exist. One shared `isMain()`.
- **Duplicated Code — the running-peak/drawdown walk** at `control-arm/arm-comparison.ts:167-183` and
  `outside-benchmark/outside-benchmark.ts:281-310`. Denominators genuinely differ; extract with a
  parameter, don't merge.
- **Duplicated Code — `MarketContext` is built twice field-for-field** at
  `market-intelligence/index.ts:331-339` and `:394-402`.
- **Speculative Generality — `MarketContext.conflicts`** is written `[]` at both construction sites and
  read by nothing; `ConflictResolution` is never constructed, only re-exported. Delete both.
  `getContext`'s third parameter `_trace_id` is unused yet mandatory (`index.ts:300`).
  `Track`'s `thick?: boolean` has one call site.
- **Middle Man — `ExecutionImpl`** (`execute.ts:35-67`): three of four methods are one-line forwards
  whose doc comments say "Delegated whole". The class earns its keep as the `Execution` port; say that
  once instead of three delegation essays.
- **Repeated Switches — `assetClass === 'crypto'`** is re-tested at `alpaca-http-client.ts:584`, `:620`,
  `:737`, with matching residue at `market-intelligence/index.ts:58`. Post-descope, delete the arm or
  resolve it once at construction. (`server/apps/` and `server/pipeline/` are clean of this — the
  descope did land there.)
- **Mysterious Name — `screeningInstrumentFor` / `resolveMiSubject`** (`lse-etp-pool.ts:1324`, `:1352`)
  are the same lookup differing only in null-vs-identity fallback, each carrying ~15 lines explaining
  it is *not* the other. `…OrNull` / `…OrSelf` carries that in the name.
- **React — avoidable re-renders.** `onSelect={() => onSelect({…})}` (`LiveTab.tsx:135`,
  `ReviewTab.tsx:414`) allocates a closure per row on every 3s poll; `PnlCard`/`OpenRiskCard` recompute
  from scratch each poll. Cheap at 6 lanes, memoised nowhere.
- **Duplicated Code — drawer scaffold** repeated at `LiveTab.tsx:166-174` and `ReviewTab.tsx:450-456`.

Client code quality is otherwise high — pure `lib/`, typed exhaustive Records, every empty state names
its reason.

---

## Spec

### Blocking

**P1 — A tripped breaker blocks the flat-by-close flatten at Verdict. Two specs contradict each other,
and code follows the wrong one.**

`risk-manager-spec.md:24` states an absolute, system-wide invariant:

> **No breaker, cap, or halt may block the flatten.** A tripped breaker that suppressed the flatten
> would hold a position overnight *specifically because* the book was in trouble — the worst possible
> time.

`verdict-spec.md:190` authorises exactly that: gate 6 "**Fire-time kill-switch / breaker re-check** —
tripped → no-go (`breaker`)", with no flatten carve-out — and the #826 amendment at `:145` reaffirms it
in terms ("Gates 1, 4, 5, 6 and 7 all still run").

Code follows `verdict-spec`, deliberately and in writing. `verdict/index.ts:229-234` is
`if (breakerTripped) return noGo('breaker', …)` with **no `mandatory_flatten` exemption**, while gate 1
(`:185`) and the price gates (`:211`) both carry one; two separate comments state the intent ("the
breaker re-check (5) still applies"), and tests lock it (`verdict/index.test.ts:911`, `:1007`).
Nothing recovers it: `residual-protection-sweep.ts:228` only calls `broker.rearmProtectiveLegs` and
never submits a flatten, so each subsequent tick's flatten re-hits the same gate. The outcome is a
leveraged ETP held overnight because the book drew down — ADR-0014's invariant broken at the one moment
it matters.

`cross-spec-contracts.md:353` (CV-27) enumerates the flatten's path as "Trader → Risk → Execution",
omitting Verdict. That is precisely how this survived a frozen-registry pass.

**This is a ruling for David, not a patch to apply.** Both documents are current and they disagree on
a live-money safety property; the code implements one of them on purpose. Whichever way it goes, the
losing spec and CV-27's path both need amending in the same change.

*Correction to the reviewing agent's framing:* it cited `risk-manager/index.ts:665-667` as falsified by
this. It is not — that claim is scoped to throws inside `ENTRY_CAP_GATES`, which `evaluate()` returns
before on an exit, and is true as written.

**P2 — Gate 4 (`market_closed`) has the same hole.** `verdict/index.ts:222-226`, with
`allow_extended_hours: false` (`paper-profile.ts:1575`). The first attempt inside the close−5min window
passes, but any retry after the bell — or a `TradingCalendar` disagreeing with the venue — no-gos the
mandatory exit. Same seam, same fix, decided by the same ruling.

### (i) Code is wrong

**P3 — Every Polymarket item is invisible to every analyst.** Verified directly.
`polymarket-agent.ts` sets **no `scope` field anywhere in the file**, and `IntelligenceItem.scope`
(`market-intelligence/types.ts:62`) is optional, so items default to `'entity'`. Their entities are
macro series names from `curated-markets.ts` — `FOMC-2026-09`, `US-RECESSION-2026`. The filter at
`market-intelligence/index.ts:325` admits only
`entity === undefined || item.scope === 'asset_class' || item.entity === entity`, and all three
analysts pass a resolved ticker (`fundamental-analyst.ts:60-75`, `sentiment-analyst.ts:71`,
`technical-analyst.ts:1031`). No ticker equals `FOMC-2026-09`, so **zero Polymarket items reach the
debate**. GDELT does it correctly at `gdelt-scorer.ts:306` (`scope: 'asset_class'`). Second
consequence: `latestClassWideRestatementOnly` (`index.ts:93-113`) `continue`s on anything not
`scope === 'asset_class'`, so Polymarket's trailing-24h restatements are never collapsed — the exact
time-axis inflation that mechanism exists to prevent. Hidden because `smoke-run.ts:2674` calls
`getContext` with no entity. **One-line fix:** set `scope: 'asset_class'` on the constructed item.
This is #481's adopted macro/event feed, built and dark — the same defect class as the unwired
mechanisms above, one level down in the data.

**P4 — A divergence with a null reason renders as a pass.** `dashboard-spec.md:224`: "A non-divergence
must not be rendered as a passing result"; `contracts/snapshot.ts:151` requires the reason be "`null`
exactly when `diverged` is false". `ReviewTab.tsx:124` requires **both** `row.diverged &&
row.divergence_reason !== null` to take the `diverged` branch, so a `diverged: true / reason: null` row
falls through to `ok` and prints "Did not diverge: the control is not ahead…"
(`ReviewTab.tsx:158-163`). The one contract breach the client can actually observe is converted into
the exact false reassurance the panel exists to prevent. Branch on `row.diverged` alone; render the
missing sentence as missing.

**P5 — `MarketContext` has no `intel` bucket.** `market-intelligence-spec.md:231-241` defines
`news` / `social` / **`intel`** / `signals`. `types.ts:82-90` has `news`, `social`, and a dead
`conflicts: ConflictResolution[]`. `signals` is legitimately stale-by-design (spec `:47-57` records the
AS-BUILT narrowing); `intel` has no such carve-out, so macro/GDELT/Polymarket items are shoved into
`news` undifferentiated while a superseded type ships in the wire model. Compounds P3.

**P6 — Closed-trade rows drop `side`.** `dashboard-spec.md:207` lists "instrument, **side**, when, held
duration, close reason as a word, why taken, signed net P&L". `ReviewTab.tsx:376-396` renders no side
column; side survives only in the `aria-label` (`:358`). The entry→exit price pair standing in its
place is scope creep — the spec puts prices in the drawer (`:208`).

**P7 (LOW) — The rail's "poll clock" is not a poll clock.** `dashboard-spec.md:253` gives the rail a
poll clock beside the snapshot clock. `Rail.tsx:47` prints `polled {snapshot.generated_at}` — a
*server* timestamp — while the client's real `lastSuccessAt` is `visually-hidden` (`Rail.tsx:283`).
During a stall the visible "polled" word freezes with the data it is supposed to date.

**P8 (LOW, latent) — The universe is still resolved twice, which the spec forbids by name.**
`orchestrator-spec.md:371`: "the universe must be resolved **once and shared** … **which today are two
independent `config.universe ?? SMOKE_TEST_UNIVERSE` resolutions**". Still two —
`production.ts:867` and `:2679` — plus a third at `index.ts:675`. All read the same config today, so
they cannot yet disagree. The companion requirement *is* met (`index.ts:233` puts `universe` in
`REQUIRED_INJECTED_CONFIG`).

### (ii) Spec is stale

**P9 (HIGH) — The store spec asserts a `current_tick.stage` CHECK the live schema has not had since
migration 0029.** `shared-sqlite-store-spec.md:684`: "**`current_tick.stage`'s `CHECK` stays at the six
original stage names.**" The live constraint has **seven** —
`migrations/0029_current_tick_position_check.sql:22`, a real `DROP TABLE`/rebuild — and
`cross-spec-contracts.md:354` (CV-28) says the opposite. The sentence argues correctly against
`invalidation` but states a false fact about the schema. A migration author treating the store spec as
DDL authority rebuilds back to six, and every tick-path `upsert`
(`sqlite-current-tick-store.ts:34`) starts throwing on the ~29-of-30 common pass.

**P10 (HIGH) — The spec says `verdict_log` upserts `DO UPDATE`; the code deliberately does
`DO NOTHING`.** `shared-sqlite-store-spec.md:395` vs
`verdict/sqlite-verdict-log-store.ts:60`, which carries 20 lines of rationale (`:22-38`): `DO UPDATE`
would let a re-check replace an original `go` with `no_go` and erase the evidence
`OrphanVerdictScanner` exists to find. Code is right; the spec records the *rejected* semantics as
fact.

**P11 — The trader spec forbids the stop geometry the paper soak actually runs.**
`trader-spec.md:226`: "`atr_k` and `vol_floor` are inert config under this rule — they must not be read
to compute a live stop". `decide.ts:618`:
`const stopDistance = bracket === null ? config.atr_k * effectiveVol : bracket.stop_pct * entry;`.
The null branch is deliberate and fails loud when partly armed (CV-24), so the code is right — but the
spec's absolutism hides the live consequence: `subclass_of` is empty on `DEFAULT_UNIVERSE`
(`paper-profile.ts:532,1200`), so **every soak trade prices its stop off `atr_k`**, geometry no ADR
declares. The spec must state the pre-#751 fallback and its expiry.

**P12 — The trader spec's interfaces predate the control arm.** `:128` `decide(input): OrderIntent | null`
(code returns `TraderOutcome`); `:143` `equity: number` vs `types.ts:328` `equity: () => Promise<number>`
(#847); `:185-201` `OrderIntentMetadata` lacks `arm`, `frozen_bracket`, `unquantised_size`. `arm` is the
worst: a whole falsifier-arm-2 path (#753 — CLAUDE.md's primary control) with `arm` in the idempotency
hash and a `control_arm_valuation_refused` skip (`decide.ts:466`) is absent from the spec.
**Implementing to spec collides idempotency keys across arms.**

**P13 — The transport spec mandates "No jitter"; the shared retry loop is full-jitter by design.**
`transport-layer-spec.md:87` ("no thundering-herd risk to jitter against") vs
`shared/http/retry.ts:56-70` (`Math.random() * Math.min(raw, maxDelayMs)`), which argues the opposite
premise. The spec's "single-process polling" premise is also now false —
`maxConcurrentInstruments: 6` (`production.ts:2282`) fans out concurrent callers. `retryAfterMs`
precedence and 4xx/5xx classification do conform; note `status >= 500` carries no 599 upper bound.

**P14 — Conviction's mediator rule is unconditional in spec, conditional in code.**
`debate-engine-spec.md:172` ("The mediator's final stance is counted as one more participant") vs
`conviction-score.ts`, which excludes it when `analystMean === 0` (#683) and returns `|analystMean|`
when there is no verdict. Undocumented; a reimplementation diverges silently.

**P15 — Four live tables are named as owned but never declared.**
`shared-sqlite-store-spec.md:18` claims "the full consolidated DDL" and `:10` calls itself the
collection point, yet `trader_log`, `risk_log`, `llm_call_log` and `flatten_submissions` appear only in
the ownership map. All four are real (`migrations/0019`, `0028`, `0039`, `0031`). Same class as F-9 in
`spec-conformance-2026-08-05.md`, fixed for one table and left for four.

**P16 — The universe-selector spec's pool geometry is wrong.** `universe-selector-spec.md:255`: "32 rows
across 26 distinct `screening_instrument`s, 20 of them single-stock". Measured at
`lse-etp-pool.ts:512`: **30 rows, 8 `index_etp_3x` + 22 `single_stock_etp_3x`, 26 distinct screening
instruments**. Both the row count and the single-stock count are wrong, and `:231` ("under ~25 rows,
ship without the ranking") and `:241` ("the 20 single-stock underlyings only") are computed off the
wrong figure. Distinct from the 2026-09-03 sweep's F9, which faulted `cross-verify-2026-08-26.md`.

**P17 — Registry asserts a relocation that landed nowhere.** `analysts-spec.md:341` relocates response
cache / cheap-premium tiers / temperature-0 replay to the Debate Engine; `cross-spec-contracts.md:355`
(CV-29) says "no debate-engine-spec change made, since those decisions already exist there". They
appear in neither that spec nor `server/pipeline/debate-engine/`. Low consequence — replay covers
determinism and #840 cut the bill to ~£58/yr — but **CV-29 is factually wrong**, in the frozen registry.

**P18 — Feedback-loop story 7's human loosening gate.** `feedback-loop-spec.md:47` ("require human
approval to loosen") was deleted by ADR-0013 D2 / #736; `guardrails.ts:9-14` documents the removal and
`applyGuardrail` has no gate parameter by design. Story 6 carries an amendment banner; story 7 was
missed.

**P19 — Minor stale.** `execution-spec.md:122` mandates four `BrokerAdapter` implementations including
ccxt (dead) and IBKR (disqualified, #906); `adapters/` holds Alpaca + Simulated. No Saxo adapter exists
— known, #946, not re-filed. `market-intelligence-spec.md:211`'s `agent_id` union omits three built
sources (`alpaca-news`, `polymarket`, `gdelt-gkg`) and lists parked `worldmonitor`.
`cost-model-backtest-spec.md:150/157` mandates funding/borrow accrual (crypto-dead, though note the
live universe's real holding cost — leveraged-ETP daily-reset decay and TER — is specced and modelled
nowhere); `:127` partial fills, which `:318` itself assigns to Execution;
`:120` cites a moved path (CV-19 / #645). `dashboard-spec.md:129` keeps story 20 while `:72` records it
dropped in v3. `cosine-precedent.ts` hardcodes k/0.75/0.5–1.5× against `trader-spec.md:323` ("config,
tuned in paper trading").

**P20 — Scope note, not a finding.** `server/apps/supervisor/` is specced nowhere (zero hits across
`docs/specs/`; only ADR-0019/ADR-0012), so it is unreviewable on this axis.

### Verified conformant

Worth recording, because several are load-bearing and were checked hard: `subclass-bracket.ts`
reproduces ADR-0018 D3/D5 exactly, including the 2026-09-03 #897 headroom reserve (D5 cap at the
0.35/0.25 envelope, first tranche 31.5%/22.5%); `perSubclassDeploymentCap` nets across the subclass and
throws on unknown (CV-24/CV-26); `invalidation.ts` is folded into the critic and wired
(`critic.ts:101`) — no seventh stage, and #994's fold is partly landed; the control arm asserts the
shared bracket with no ladder; six stages exactly (`contracts/pipeline.ts:31-38`,
`orchestrator/types.ts:129-136`), plus `position_check`, with the tick/decision split and #1040 phase
split as specced; cross-spec §4 (Execution sole writer) holds against every `INSERT/UPDATE/DELETE`;
`openSharedStore` sets WAL + `synchronous=FULL`; `computeMetrics`/`runDailyCycle`/
`runOutsideBenchmarkCycle`/`runArmComparisonCycle` all have production callers; `#625`'s three
conviction corrections, `early-exit.ts` momentum-only, `wrapUntrusted` containment, and replay-from-log
satisfying ADR-0003 §2 all hold; the dashboard spec on disk **is** v3 and the client carries no crypto
panel, no invalidation column, no `£750`. The 2026-09-03 sweep's F1 and F4 are both closed in code
(`saxo_tradeable` with a `'vacuous'` refusal at `lse-etp-pool.ts:1451`; `fallback_default` on all rows
with five rules at `:1643`).

One caveat found while clearing §4: **`write-guard.ts` is off under `NODE_ENV=production` and
`SAMURAI_MODE=live`** (`shared-sqlite-store-spec.md:769`), so nothing enforces the sole-writer contract
on the live path. `service-api/index.ts:104` opening the store write-capable is F2 of
`orchestrator-dashboard-architecture-2026-08-07.md` — referenced, not re-filed.

---

## Summary

**Standards — 8 hard-violation groups + 7 unwired mechanisms + 16 judgement calls.** Worst: the
repo's own named dominant defect class is live in seven places, and `createDataSource`
(`source-factory.ts:41`) is the deepest — a factory with zero call sites keeping ~865 lines of
unconstructed source classes alive, including the `kind: 'lse'` arm added for the live venue's mark
problem.

**Spec — 2 blocking + 6 code-wrong + 12 spec-stale.** Worst: `risk-manager-spec.md:24` and
`verdict-spec.md:190` contradict each other on whether a tripped breaker may block the flat-by-close
flatten, and `verdict/index.ts:229` implements the permissive reading on purpose. That is a live-money
ruling David has to make, and CV-27's path enumeration is why a frozen-registry pass did not catch it.

The two axes are not cross-ranked. Note their shapes rhyme: the Standards axis found seven mechanisms
with no caller, and the Spec axis found an adopted intelligence feed (#481's Polymarket) whose items
cannot reach a single consumer for want of one field. Both are the composition-root defect class the
coding standard already names — the second one just lives in data rather than wiring.

**Cheapest high-value fixes**, none of which need a ruling: `scope: 'asset_class'` in
`polymarket-agent.ts` (P3, one line, restores a whole feed); `/\.?0+$/` in `format.ts:155` (S5);
branching on `row.diverged` alone in `ReviewTab.tsx:124` (P4); adding barrels to `shared/http/` and
`universe-pool/` (S1, unblocks ~15 importers that cannot currently comply); correcting the four wrong
comments in S2.
