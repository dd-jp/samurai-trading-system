# Spec-vs-Implementation Conformance Audit — 2026-08-05

**Question asked:** is the implementation in line with the specs?

**Short answer:** the wiring layer — the thing the 2026-08-03 readiness audit found broken — is
now in good shape. `ingestFills()`/`reconcile()` are scheduled, `AccountStateProvider` is
built, `account_state` is migrated, the LLM rate limiter is enforced, the feedback timer runs.
What this audit finds instead sits one level up: **three specced learning/judgement layers are
built, unit-tested, and never reached in a running process** — Trader's cosine precedent
(F-1), the Feedback Loop's tuned dials (F-2), and Market Intelligence's entire ingestion side
(F-3). They are not independent defects. Together they mean a 14-day soak would run a system
that sizes every position at a fixed 0.75× "no precedent" haircut, learns nothing from any
trade it closes, and takes its analyst opinions from a store nothing ever writes to — one of
two on crypto, two of three on equities, including the *mandatory* one. **The soak would
execute fine and its output would not be evidence about the specced design.** That is the
decision this document is for.

Nothing here is hidden or undocumented in the code — every one of these descopes is stated
plainly in a comment at the site. The actionable delta is that **none of them is reflected in
the spec**, so the specs currently describe a system that does not exist, and each finding
below resolves either by wiring the code or by adding a phasing note to the document.

**Method.** All 15 component specs in `docs/specs/` read in full (`analysts`,
`cost-model-backtest`, `dashboard`, `debate-engine`, `execution`, `feedback-loop`,
`market-data-service`, `market-intelligence`, `orchestrator`, `risk-manager`,
`shared-sqlite-store`, `stage2-validation-execution`, `trader`, `transport-layer`, `verdict`).
The four `cross-*.md` files were read as existing registries, not as audit targets. One bias
was applied throughout: this repo's dominant defect class is a *tested mechanism nothing
calls*, so for every requirement that is a runtime behaviour rather than a pure function, the
question asked was "is it reachable from the composition root?", not "does the code exist?".
The wiring inventory was built once from `src/orchestrator/production.ts`,
`production/direct-bind.ts`, `orchestrator/index.ts` and `alert-transport.ts`.

**Base commit.** `7862e3a` (*"run Stage 2 against real market data and record the verdict
(#245) (#396)"*) — the tip of `origin/main` at the time of writing. This matters: an earlier
pass of this audit ran against a base four commits older and produced one finding (MinBTL's
trial cap computed from the requested rather than the ingested window) that #396 had already
fixed. It was withdrawn rather than published. Every finding below was re-verified against
`7862e3a` after rebasing.

**Baseline.** `yarn build` clean. `yarn test` — **1943 passed, 1 skipped (1944), zero
failures**. See F-12 for one flake observed on the older base that did not recur here.

**Relationship to prior audits.** `docs/paper-trading-readiness-2026-08-03.md` deliberately
did *not* read the specs ("Not read: the 19 specs in full … so the divergence half of the
question is answered from targeted checks"). This audit is that missing half. Its Tier-1
items 1 and 3 and divergence D2 have since closed; its D3 survives here as F-8.

---

## Tier 1 — makes a 14-day soak uninterpretable

### F-1 (HIGH) — Trader's cosine-precedent layer is fully built, fully tested, and never called

trader-spec.md devotes stories 12–16 and an entire module ("Module: Cosine Precedent
Retrieval") to sizing modulation by similarity-weighted precedent. The mechanism exists:
`src/trader/cosine-precedent.ts` (`retrieveCosinePrecedent`), `SqliteSetupStore`,
`FixtureSetupStore`, and the `SetupStore` port in `shared/types.ts`. **None of it has a
production caller.**

- `retrieveCosinePrecedent` is imported by nothing outside its own test.
- `src/trader/decide.ts:35` hardcodes `NO_PRECEDENT_COSINE_MULTIPLIER = 0.75` and emits
  `neighbor_count: 0, weighted_mean_r: null, no_precedent: true` on **every** intent
  (`decide.ts:245-251`, `decide.ts:305-312`).
- `SetupStore.writeSetup` has **no caller anywhere in `src/`** outside tests — story 16
  ("write each new setup vector to the store") is unimplemented, so `cosine_setups` stays
  empty for the life of the process.

**Failure scenario.** Every position in the soak is sized at a permanent 0.75× haircut with
`no_precedent: true`. Two knock-ons, both silent:

1. Verdict's `semi_auto` HITL flag set includes `no_precedent` (verdict-spec.md:125). Since
   that field is hardcoded `true`, **every trade is flagged**, the flag carries no
   information, and the `semi_auto` dial collapses into `manual`.
2. `withOnTradeClose` → `onTradeClose` → `SetupStore.labelSetup` throws on every close ("no
   pending setup for debate_id"), because nothing wrote the setup row. It is caught and
   logged at `error` (`on-trade-close-hookup.ts`), so the soak emits one `onTradeClose failed`
   error per closed trade for the whole run and the R-multiple labelling never happens.

`decide.ts:11` names #75 as the owner — so #75 built the mechanism and never wired it into
`decide()`.

### F-2 (HIGH) — the Feedback Loop's tuned dials have no reader on the decision path

feedback-loop-spec.md states this as an explicit cross-spec obligation (Module: Guardrailed
Tuning): *"FL's tuning only takes effect if the Trader reads its strategy params, and the Risk
Manager reads its thresholds, from the mutable shared store at decision/eval time — not from
static config baked in at startup … the cross-spec pass must confirm they read the live
(FL-written) values."* No consumer does. The three dials fail in three different ways:

| Dial | Written? | Read on the decision path? |
|---|---|---|
| `risk_thresholds` | **yes** — `autoTighten` calls `tuning.setRiskThreshold` (`metrics.ts:106`) on a kill-line breach | **no** — `RiskManagerImpl` (`index.ts:140`) holds a frozen `RiskConfig` from its constructor |
| `strategy_params` | **no** — moved only by `proposals`, and nothing in the repo produces one | **no** — `buildTraderStep` (`direct-bind.ts:117`) passes a frozen `deps.config` into `decide()` |
| `analyst_weights` | **yes** — seeded at startup, stepped daily by attribution | **no** — `src/debate-engine/` contains zero non-test occurrences of "weight" |

**Failure scenario — the `risk_thresholds` row is the sharp one.** It is live at the write end
and dead at the read end. `computeMetrics` detects a kill-threshold breach, calls
`autoTighten`, which writes every risk threshold toward its guardrail bound and records the
adjustment — and `RiskManagerImpl` never reads any of it. **The system's defensive response to
a detected dead edge has no effect on risk.** The loosen-approval gate (story 7) is inert for
the same reason at one remove: it only gates `proposals`, which nothing produces.

**The `analyst_weights` limb is a spec contradiction, not code drift, and no cross-verify pass
has caught it.** Three specs disagree about who applies weights:

- analysts-spec.md:117, 188-189 — analysts are weight-blind, *"weights are applied downstream
  in the Debate Engine"*, and `AnalystRunResult` carries a `weights` field for that handoff.
- feedback-loop-spec.md story 5 — *"As the Debate Engine, I want to read the updated weights
  when applying them downstream."*
- debate-engine-spec.md:392 — *"Weighted debates (some analysts have more influence based on
  track record)"* is listed under **Future Extensions**, i.e. explicitly out of scope.

The code follows debate-engine-spec.md, and `paper-profile.ts:236-238` records the choice
deliberately: *"What still does NOT happen is anything reading those weights at debate time;
that is a recorded decision, not an oversight."* `AnalystRunResult` (`analysts/types.ts:78`)
has no `weights` field. So this limb needs a spec decision before it needs code.

### F-3 (HIGH) — Market Intelligence has no ingestion path: two of three analysts are constant-neutral

market-intelligence-spec.md is the largest spec in the repo (652 lines) and defines eight
modules. `src/market-intelligence/` implements the store type and the WorldMonitor CII
consumer. **DeepResearch Agent, Grok Agent, WorldMonitor news Agent, Convergence Engine, Data
Delivery, Health & Metrics and the Backtesting Replay Store do not exist** — grep for
`deepresearch|grok|convergence` across `src/` returns nothing outside tests.

`MarketIntelligenceStore` has **no writer in production**. `production.ts:1138-1144`
constructs it empty and says why ("no such agent runs in this process yet"). The consequence
is not confined to the intelligence layer:

- `sentiment-analyst.ts:23-42` — zero items ⇒ `direction: 'neutral'`, `confidence: 0.05`.
- `fundamental-analyst.ts:21-42` — identical, and its role is **`mandatory`** for stocks.

**Failure scenario.** With #381's widening to the ADR-0001 six-instrument universe, each of
the four equities runs a debate in which the mandatory fundamental analyst and the optional
sentiment analyst both contribute a constant `neutral`/`0.05` view, every tick, for the life
of the run. Only the technical analyst carries information. The debate still runs and still
costs LLM spend, but the multi-analyst premise the architecture rests on is unexercised for
two of three analysts — and nothing in the logs distinguishes "sentiment sees nothing bullish"
from "sentiment has never had an input".

### F-4 (MEDIUM) — the Analysts failure policy is unimplemented, and no ticket covers it

analysts-spec.md "Module: Failure Handling" specifies three things.
`analysts/orchestrator.ts` implements one:

| Requirement | Status |
|---|---|
| Role-dependent skip (mandatory fails → skip tick; optional fails → reduced set) | implemented |
| "Uniform single bounded retry with a short timeout for any failing analyst" | **not implemented** — one attempt, no timeout |
| "An active alert fires only after 2 consecutive skipped ticks" | **not implemented** — no consecutive-skip tracking anywhere |

`orchestrator.ts:10-12` states it: *"Retry-on-failure and the 2-consecutive-skip alert … are
not built here — no ticket covers them yet."* That last clause is the finding: unlike every
other descope in this repo, this one has no issue behind it.

**Failure scenario.** One transient market-data hiccup on the technical analyst forfeits that
instrument's whole tick, with no retry. If the condition persists — a bad key, a data outage —
every tick skips, and because the 2-consecutive-skip alert does not exist, an unattended soak
produces no alert at all. `SAMURAI_ALERTS` carries four escalations; "the analyst stage has
skipped every tick for six hours" is not one of them.

---

## Tier 2 — blocks live money, not the paper soak

### F-5 (HIGH) — Risk Critic (check-pipeline step 7) has no producer

risk-manager-spec.md's Check Pipeline is eight ordered steps; step 7 is the red-team LLM
critic adopted in ADR-0003, with "trim or hard-reject … the same authority as every mechanical
step". The *consumption* half exists (`RiskInput.critic`, `RiskCriticVerdict`,
`InMemoryRiskCriticStore`) and `risk-manager/index.ts:143` destructures `critic`.

The *production* half does not. `risk-manager/types.ts:184` and `direct-bind.ts:183` both say
the verdict is "pre-fetched by critic.ts outside evaluate()" — **`src/risk-manager/critic.ts`
does not exist** (`find src -name 'critic*.ts'` returns only `critic-store.ts`).
`InMemoryRiskCriticStore` has zero callers. `buildRiskStep` passes no `critic` field, and
absent silently means pass.

**Failure scenario.** Step 7 of an 8-step pipeline never runs. Because the default is
fail-open, nothing in `RiskDecision.reasons` or `binding_constraint` distinguishes "the critic
passed this trade" from "the critic was never consulted". The spec presents step 7
unconditionally, with no phasing language.

### F-6 (HIGH) — the HITL approval gate is built end-to-end and not connected

> **RESOLVED 2026-08-06 as a deliberate descope — [ADR-0007](../adr/0007-fully-automatic-execution.md).**
> The gate is not being connected. `automation_level` is now `auto` for both
> asset classes in paper *and* live, because `Verdict.decide` awaits
> `requestApproval` inside the instrument pass while `runTickPlan` runs
> instruments one at a time — so one pending approval blocks the whole universe
> for up to `human_timeout`. The finding below was correct; the fix chosen was
> to remove the human, not to wire the transport.
>
> Two things changed rather than closed. The composition root's fallback is now
> `UnwiredApprovalChannel`, which **throws** instead of auto-approving, so the
> "reads as enforced, enforces nothing" hazard is gone. And the exposure named
> in the last sentence below — *"the mechanism stays unexercised right up to the
> day it must work"* — is now permanent by decision, which is why #384, #375 and
> #333 became the live-go gate: the breakers are the only stop left.

verdict-spec.md stories 10–13 and "Module: Human-in-the-Loop" are the staged-deployment
control: a per-asset-class `manual`/`semi_auto`/`auto` dial with Telegram approve/reject. The
parts are all there and individually tested — `SignedApprovalChannel`,
`approval-callback-verifier.ts`, `TelegramApprovalGateway`, `allowlist.ts`,
`correlation-tokens.ts`, `TelegramBotApiClient`.

Nothing constructs the chain. `SignedApprovalChannel` appears in `src/` only inside its own
subtree, its tests, and doc comments; `production.ts:1319` falls back to
`ConsoleApprovalChannel`, which **auto-approves**. `alert-transport.ts:87-91` says it plainly:
*"`ProductionConfig.approvals` still falls back to `ConsoleApprovalChannel`. Wiring HITL
approvals through Telegram is #275's remaining half."*

**Failure scenario.** Gate 6 passes everything automatically, so `automation_level: 'manual'`
and `'semi_auto'` behave identically to `'auto'` — the dial the staged-deployment plan rests
on is inert. `ConsoleApprovalChannel`'s constructor refuses `live` mode, so this fails closed
at the live boundary rather than auto-approving real money; the exposure is that the mechanism
stays unexercised right up to the day it must work. Note `TELEGRAM_ALLOWED_USER_IDS` is
already a *required* env var (`alert-transport.ts:160`), validated at boot, for a gate nothing
polls.

### F-7 (MEDIUM) — Trader's exit path dead-ends at Execution, and now costs an error per tick

Carried from the 2026-08-03 audit (item 6, #74), re-confirmed, with severity sharpened by what
is now wired. `trader/decide.ts:264` builds a real exit intent, risk-manager passes exits
verbatim by spec, Verdict emits `go`, and `execution/execute.ts:66-70` returns `error` with
*"intent_type 'exit' (flatten) is not implemented in #82 — see #83"*.

**Failure scenario.** A held lot receiving an opposite-direction converged debate emits an
exit intent *every tick* for as long as the disagreement lasts. Each traverses the full
pipeline — including a billed LLM debate — and terminates in an Execution error. The position
is not stranded (bracket legs exit venue-side), but the tick chain produces a recurring error
that looks like a transport fault.

### F-8 (MEDIUM) — `BrokerAdapter` is missing three specced methods

execution-spec.md:133-137 defines `submitFlatten`, `cancel` and `getOpenPositions` on
`BrokerAdapter`. `src/execution/types.ts:120-159` has none of them — only `submitBracket`,
`getOrder`, `fetchNewFills`, `resizeProtectiveLegs`. Unchanged since the 2026-08-03 audit
flagged it as D3, and still unresolved as *drift vs deliberate descope*
(`cross-verify-2026-07-31.md` GAP-2 owns the phasing question). Either way the capability is
absent: no order cancellation and no forced-liquidation path, which execution-spec.md:279
contemplates as Execution's job — that matters for a kill switch regardless of which document
is wrong.

**Concrete consequence, not previously stated.** execution-spec.md's "Module: Idempotency &
Crash-Restart" requires reconciliation to correct *"store shows a position the broker doesn't
(**or vice-versa**)"*. `reconcile.ts:39` iterates `store.getOpenPositions()` and looks each up
via `broker.getOrder`. That is the first direction only; the second needs
`BrokerAdapter.getOpenPositions()`. A lot the venue holds but the store never recorded — a
write-ahead that died before persisting, or a manual order — stays invisible to Risk's
exposure caps indefinitely.

---

## Tier 3 — documentation drift (code is fine; the spec is stale)

### F-9 — `llm_spend` exists in code and in no spec

Migrations `0010_llm_spend.sql` and `0012_llm_spend_latency_debate_id.sql` create a
`llm_spend` table, written by `SqliteLlmSpendStore` and read by the dashboard's spend tile
(`DashboardQueryStore.getLlmSpend`). `grep -rn llm_spend docs/specs/` returns **nothing**.

shared-sqlite-store-spec.md's "Module: Consolidated Schema" is the schema of record and names
23 tables; the store now has 24. dashboard-spec.md's `DashboardQueryStore` likewise predates
`getLlmSpend` and the `ProviderStatusPoller` (Alpaca balance + Polygon health tiles), neither
of which appears in the spec. A consolidated schema that has quietly stopped being
consolidated is how the next cross-spec pass starts missing collisions.

### F-10 — cost-model-backtest-spec.md still names pybroker as the eval executor

The spec's "Module: Validation Library" states the walk-forward/CPCV split generation and
eval-metric computation *"are executed via **pybroker**"*. There is no pybroker dependency and
no Python in the repo; `splits.ts`, `metrics.ts`, `overfitting.ts` and `eval-executor.ts` are
native TypeScript. The code documents the reinterpretation honestly (`metrics.ts:10`,
`eval-types.ts:3-27` — the deliverable is pybroker's *executor shape*, per ADR-0001's
TypeScript ruling), and `CostModel.fill` correctly remains the single fill authority. Only the
spec was never amended.

Two smaller items in the same spec: the Backtest Harness's "FL walk-forward replay" (the
harness reusing FL's daily-batch code path so weights evolve point-in-time) has no
implementation — no `runDailyCycle` reference anywhere in `src/cost-model-backtest/`. Given
F-2, nothing would read the resulting trajectory anyway.

### F-11 — Verdict story 14 (fills and no-gos posted to the trade channel) unimplemented

`NotifyingVerdict` (`src/verdict/notifying-verdict.ts`) has **zero callers** — no reference
outside its own file and test. `direct-bind.ts` wires `LoggingVerdict` only, and records why:
"#307 is the open ticket deciding whether one …". The operator gets no per-decision visibility
over Telegram; only the 15-minute heartbeat and the four escalations flow.

### F-12 — one test observed flaking, once

`production.test.ts > buildProductionOrchestrator > feedback cycle wiring for a paper soak
(#366) > says at startup that the other three kill-lines have no revalidation input` timed out
at vitest's 5s default during a full-suite run on the older base; the file then passed 55/55
in isolation, and the full suite passed clean on `7862e3a`. So this is a single observation,
not a reproducible failure — recorded only because a 5s default on a test that shares a run
with a 14s file is thin margin, and a non-deterministic suite is the wrong property for the
gate a soak launches from.

### F-13 — smaller items, verified but not worth their own section

- **Polygon has no proactive rate limiter.** `venue-pacing.ts:38` covers `alpaca | ccxt |
  ibkr`; `http-polygon-client.ts` has no token bucket. Polygon's free tier is 5 calls/min —
  ~40× tighter than Alpaca — and handling is reactive-429-backoff only. Matches
  `cross-verify-2026-07-31.md`'s open MEDIUM; still unaddressed.
- **`Fill.cost_breakdown` has no consumer.** It is correctly produced by the Simulated adapter
  and persisted (`sqlite-shared-store.ts:202`), but FL's live-vs-modeled cost divergence check
  (execution-spec.md:228, cross-spec §4 GAP-F) does not exist. FL's `divergence` is the
  unrelated live-vs-backtest *Sharpe* check.
- **`forming-candle-client.ts` has no caller.** Flagged as an instance of the pattern only;
  the point-in-time contract is enforced in `ingestion.ts`/`service.ts`, which are wired.

---

## No divergence found

Worth stating, because it is most of the system and the findings above would otherwise skew
the picture. **Two different confidence levels are mixed here, and the difference matters.**
Items marked ✓ were confirmed by reading the implementation or by a targeted reachability
check. Items marked ○ are ones where a matching implementation exists and its tests pass, and
that was taken as sufficient — the same inference this document's Method says is unreliable in
this repo. Treat ○ as "nothing surfaced", not as "audited".

- ✓ **Orchestrator** — `RotatingFileSink` is wired at `index.ts:129` (story 11, checked because
  a log sink with no caller is exactly this repo's failure mode); heartbeat cadence is #342's
  15 minutes with its own chat, read in `production.ts`. ○ scheduler / tick-runner /
  `current_tick` / audit-log shapes match the spec's interfaces.
- ✓ **Execution** — `reconcile`-before-`ingestFills` startup ordering is correct and awaited
  (`production.ts:1653`, `fill-sync.ts`); `Fill.cost_breakdown` is persisted
  (`sqlite-shared-store.ts:202`); the `exit` refusal is F-7. ○ two-layer dedup, write-ahead,
  state machine, partial-fill leg resizing, ADR-0005's epsilon tolerance, per-lot scale-in —
  spec-matching implementations with passing tests, not separately read.
- ✓ **Market Data Service** — `getSpreadEstimate` and `getADV` exist on the port
  (`types.ts:165,171`), closing OPEN-GAP-A. ○ the `close_time <= asOf` filter and
  backtest-marks-from-bars rule.
- ✓ **Debate Engine** — #388's `RateLimiter` is a *required positional argument* to
  `buildDebateStep` (`debate-adapter.ts:352-372`), which is the right structural fix for this
  repo's defect class, and #392 has since given the latency budget a live caller too.
  ○ conviction score, disagreement detection, round structure, debate logger, contributions,
  persona prompt-injection wrapping.
- ✓ **Transport layer** — `src/shared/http/` has `retry.ts`, `fetch-with-timeout.ts`,
  `token-bucket.ts`, `venue-pacing.ts`; the retired `sendApprovalRequest`/`requestApproval`
  dead code is gone; `AccountStateProvider` and `MarketDataVolatilityReadingProvider` are
  built and wired by default in `production.ts`. ○ per-client error taxonomies.
- ✓ **Backtest harness** — `backtest.ts` genuinely drives the orchestrator's `Scheduler` +
  `TickRunner` rather than reimplementing the chain, which is the "same code path" guarantee
  the spec exists to provide.
- ✓ **Stage 2** — `buildTrialGrid()` is exactly the specced 2 × 2 × 3 = 12 configs, and #396
  now computes MinBTL over the window the data actually supports rather than the one
  requested, which is what stage2 story 3 demands. ○ replay driver and trial execution.
- ○ **Dashboard** — read-only by construction, two GET routes, 405 on non-GET, `127.0.0.1`
  default. Code has outgrown the spec (F-9) rather than diverged from it.

---

## Shortest path

Ordered by what unblocks a *meaningful* soak, not by effort.

1. **Wire `retrieveCosinePrecedent` and `writeSetup` into `decide()`** (F-1). One call site
   each. This also silences the per-close `onTradeClose failed` error and restores
   `no_precedent` as a real Verdict flag. No design decision needed — the mechanism, the store
   and the tests already exist.
2. **Give `risk_thresholds` a reader** (F-2). `RiskManagerImpl` should resolve thresholds from
   `TuningStore` at `evaluate()` time rather than from a constructor-frozen `RiskConfig`.
   Until this lands, the kill-line auto-tighten is decoration. `strategy_params` can stay dead
   at both ends for now — say so in the spec.
3. **Decide the analyst-weights contradiction** (F-2, second half). Three specs disagree;
   pick one and edit the other two. This is David's call, not a code change: either
   debate-engine-spec.md promotes weighted debates out of Future Extensions, or analysts-spec
   and feedback-loop-spec drop the weights handoff.
4. **Decide what Market Intelligence is for the soak** (F-3). Either build one ingestion path
   so `fundamental`/`sentiment` have inputs, or make the empty-store case *loud* — an analyst
   returning a constant 0.05 should say so once at startup, not blend into the debate as if it
   had an opinion. Option two is small and makes the soak's output honest.
5. **Add the analyst retry + 2-consecutive-skip alert, and file the ticket** (F-4). The alert
   matters more than the retry for an unattended run.
6. **Before live money only:** wire the Telegram approval gateway (F-6), produce the risk
   critic (F-5), and settle `submitFlatten`/`cancel`/`getOpenPositions` (F-8) — the last of
   which is a kill-switch capability, not a nicety.
7. **Documentation sweep** (F-9, F-10): add `llm_spend` to the consolidated schema, amend the
   pybroker paragraph, and add phasing notes to risk-manager-spec (step 7), verdict-spec
   (HITL, story 14) and trader-spec (cosine) so the specs stop describing a system that does
   not exist.
