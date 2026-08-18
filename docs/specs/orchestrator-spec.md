# Orchestrator Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-07-14 (Production Composition Root section added 2026-07-28, wayfinder map [#224](../../issues/224), [ADR-0004](../adr/0004-production-composition-root.md))

**2026-08-16 — the tick model is re-specified, not annotated.** Map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703) closed with the intraday horizon's selection and entry-timing decisions, and two of them change this spec's own definitions rather than its parameters: **a tick is no longer one pass through the full pipeline** (Scheduler and Tick Runner modules below), and **crypto is out of Samurai's scope entirely** ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) amendment), which withdraws story 1 and the always-included rule. Superseded text is struck in place with its replacement adjacent — deliberately, so a reader cannot follow a stale rule that merely has a banner over it.

## Problem Statement

Ten specs now exist — six pipeline stages plus Market Intelligence, Market Data Service, Execution, and the cost-model/backtest harness — and every one of them was written assuming something else fires the first event, holds the clock, and ties a trace together. Nothing produces the `Signal` the Analysts consume. Nothing schedules a tick, decides that a stock instrument shouldn't fire outside market hours, or bounds how many instruments run concurrently against a shared LLM rate limit. The cost-model/backtest harness explicitly depends on replaying "the exact live pipeline... via an injected clock" — but the live pipeline's tick loop, the thing the harness's simulated clock gets injected into, doesn't exist as a spec. And nobody owns trace IDs, structured log formatting, or the audit trail's storage technology, even though the vision's Definition of Done requires both.

The **Orchestrator** is that missing piece: the single-process, single-host program that actually runs Samurai on the MacBook — schedules ticks, iterates the universe, wires one instrument's pass through Analysts → Debate → Trader → Risk → Verdict → Execution, injects the clock every stage reads, and owns the cross-cutting concerns (trace IDs, structured logs, the audit spine, the dead-man's-switch heartbeat) that no single stage should own for itself.

## Solution

The Orchestrator is a **single TypeScript process** (ADR-0001: TS core, no LangGraph dependency) running one **scheduler** and one **tick loop**, with no LLM logic of its own — it is pure wiring, scheduling, and cross-cutting infrastructure.

- **Scheduler** fires ticks on a fixed interval, gated per instrument by a market-hours/trading-calendar check **and by a policy window** (below), applied identically regardless of `asset_class` — there is no always-open exception for any instrument. Crypto is **out of Samurai's scope** — not parked, not staged, not pending an unpark gate ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)/[ADR-0017](../adr/0017-validation-gates-paper-operational-thesis-expectancy.md) amendments, 2026-08-16). Per CV-25, no spec, gate, measurement or ticket may assume a crypto path exists. **Crypto no longer ticks in production, as of [#738](https://github.com/dd-jp/samurai-trading-system/issues/738) (2026-08-17):** the scheduler's `asset_class === 'crypto'` bypass is deleted, not merely unreachable, and `DEFAULT_UNIVERSE` no longer declares a crypto row (`SPY`/`QQQ`/`AAPL`/`TSLA` only) — so the production path resolves no crypto instrument under any clock time. `SMOKE_TEST_UNIVERSE` (BTC-USD) is the one deliberate exception, kept specifically so the offline gate still exercises a crypto-shaped instrument; `smoke-run.ts` gates it on an explicitly-injected `AlwaysOpenCalendar` now, the same calendar/window mechanism every instrument uses, rather than a scheduler-level bypass. This is "suspended, not withdrawn" as code: `AssetClass`, `AlwaysOpenCalendar`, `sessionCalendars`, and every crypto config key remain in place and compile — only the SCHEDULE stopped carrying crypto. Do not read this paragraph as licence to delete those instruments — `AlwaysOpenCalendar`'s `sessionEnd → null` is [#667](https://github.com/dd-jp/samurai-trading-system/issues/667)'s ruling enforced by the type system, and it migrates to the future crypto system's record rather than being discarded.
- **Tick ≠ decision.** A tick fires on the **tick interval** (`τ`, default 2 minutes) and runs only the cheap, position-facing work. A **decision** fires once per **debate bar** and runs the full stage chain. See "Module: Tick Runner" for the split and why it exists.

```
every tick (τ = 2 min):   flatten check (the Trader's exit-only entry: positions, mark, window)
every new debate bar:     Signal → Analysts.run → DebateEngine.run → Trader.decide
                          → [Invalidation] → Risk.evaluate → Verdict.decide
                          → (on go) Execution.execute
```

*(`[Invalidation]` is bracketed: **specced and not built**. See "The tick/decision split" below, which carries the full status note — this diagram and that one are the same chain and must not drift apart.)*
- A **trace ID**, generated at Signal emission, threads through every stage call in that pass and appears on every structured log line.
- The Orchestrator injects the **`Clock`** every stage reads (wall-clock live; the cost-model/backtest harness's simulated clock in replay — same tick-loop code, different injected clock/adapters, mirroring Execution's live/paper/backtest discipline).
- It writes to a new `audit_log` table in the shared SQLite store (one row per stage-decision per trace_id) and emits a dead-man's-switch heartbeat over the trade channel Verdict already provisions.

Key architectural decisions:
- **Single process, single host** — matches the MacBook always-on deployment target; no message broker, no distributed scheduler.
- ~~**Fixed universe iteration, not a scanner (v1)** — Signal production is a configurable instrument list, not an opportunity-ranking engine.~~ **Reversed 2026-08-07** by [universe-selector-spec.md](universe-selector-spec.md) (wayfinder map [#397](../../issues/397)). The Orchestrator still does not *rank* anything — ranking is an out-of-session job — but its active list is now supplied by an `ActiveUniverseProvider` at each session boundary rather than being a static config value. Instrument iteration within a tick is unchanged.
- **Bounded concurrency across instruments** — protects the shared LLM rate limit (Analysts/Debate), independent of any single instrument's own latency budget.
- **Trace ID as a cross-cutting envelope field** — not business data, threaded through every stage call and every log line.
- **Audit spine = a table in the existing shared SQLite store** — not a separate JSONB/Supabase system; mines the JSONB *pattern* (rich per-decision snapshots), not the storage technology.
- **Stateless-restart crash recovery** — the Orchestrator holds no unrecoverable state across a tick; each stage's own persistence (Execution's reconciliation, the shared store) carries the real state.

## User Stories

### Scheduling & Universe

1. ~~As the Orchestrator, I want to fire a tick for crypto instruments on a fixed interval 24/7, so that crypto's always-open market is continuously covered.~~ **WITHDRAWN 2026-08-16** — crypto left Samurai's scope entirely ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) amendment). Every instrument this system trades has a session, an open and a close, so there is no always-open case to cover.
2. As the Orchestrator, I want to gate instrument ticks on a market-hours/trading-calendar check, so that a tick never fires into a closed market.
2b. As the Orchestrator, I want to gate ticks additionally on an injected **policy window**, so that entries are armed only inside the recorded 14:30–15:45 London window ([#706](https://github.com/dd-jp/samurai-trading-system/issues/706)) without narrowing the venue calendar, which is separately load-bearing for `sessionEnd`.
3. As the Orchestrator, I want to iterate the active instrument list each tick, so that the covered universe changes at session boundaries without a code change.
4. As the Orchestrator, I want to emit one `Signal{asset, asset_class}` per instrument **per decision**, so that the Analysts stage has a producer for the input it was already specced to consume (closes GAP-I).
4b. As the Orchestrator, I want most ticks to run **only** the position-facing work — the Trader's exit-only entry point (positions, mark, flatten window; bracket exits rest at the venue) — so that a 2-minute exit cadence does not force a 2-minute cost for the analyst and debate stages, whose inputs change once per debate bar.
5. As the Orchestrator, I want to run instruments within a tick concurrently up to a configured cap, so that one instrument's slow debate doesn't stall the rest, while the LLM-facing stages stay within their rate limit.

### Wiring the Pipeline

6. As the Orchestrator, I want to drive one instrument's pass through Analysts → Debate → Trader → Risk → Verdict → Execution in sequence, so that each stage's own contract (already specced) is satisfied without reimplementing stage logic here.
7. As the Orchestrator, I want to only call Execution when Verdict returns `go`, so that the gate-vs-actor separation (verdict-spec / execution-spec) holds.
8. As the Orchestrator, I want to inject a `Clock` into every stage that needs one, so that live and replay share the exact same tick-loop code path (the guarantee cost-model-backtest-spec's harness depends on).

### Trace IDs & Structured Logging

9. As the Orchestrator, I want to generate one trace ID at Signal emission and thread it through every stage call in that instrument's pass, so that a single trade's full journey is reconstructable from logs (DoD #8).
10. As any stage, I want to log through a shared structured-logging interface the Orchestrator configures (JSON: timestamp, trace_id, stage, level, message, payload), so that log format is consistent without each stage reinventing it.
11. As the Orchestrator, I want to own the log sink (stdout + rotated file), so that log retention/rotation is configured once, not per stage.

### Audit Spine

12. As the Orchestrator, I want an `audit_log` table in the shared SQLite store (one row per stage-decision per trace_id: stage, decision, input digest, output digest, timestamp), so that the full per-trade decision history is queryable (DoD #5) without a separate audit database.
13. As the Dashboard (dashboard-spec.md, closes OPEN-GAP-B), I want the `audit_log` table to already contain everything a positions/debates/verdicts/per-analyst-performance view would need, so that building that surface is a read-only consumer, not a new write path.
13b. As the Dashboard, I want a `current_tick` row per in-progress instrument (instrument, stage, trace_id), so that a separate process can show "tick in progress for {instrument}" without reading the Orchestrator's memory.

### Reliability

14. As the Orchestrator, I want to emit a heartbeat over the trade channel Verdict already provisions (Telegram/Discord) on a fixed interval, so that an external watchdog can alert on silence (dead-man's-switch), not on the Orchestrator polling itself.
15. As the Orchestrator, I want to hold no unrecoverable in-memory state across a tick, so that a crash-restart just resumes the schedule while Execution's own reconciliation (already specced) recovers in-flight orders. (`current_tick` is the one exception: disposable, best-effort progress state, not a system-of-record — losing it on crash costs nothing but a stale progress indicator.)

### Production Composition Root

16. As David, I want a single composition-root module that binds every real stage instance into the tick chain, so that `SequentialTickRunner` runs against the actual pipeline instead of test doubles, without any stage learning about wiring concerns.
17. As the composition root, I want to adapt `AnalystOrchestrator.runAnalysts` and `runDebate`'s native signatures onto the exact `TickSteps.analysts`/`TickSteps.debate` shape, so that the tick runner's short-circuit logic (empty-view quorum skip) keeps working unchanged.
18. As David, I want the first paper run to target a narrow smoke-test universe (1-2 instruments) rather than the full default universe, so that a wiring defect surfaces against the smallest possible blast radius before the universe widens to ADR-0001's SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD default. *(Satisfied, then widened — #381. The narrow set is now what `yarn smoke` runs as the pre-soak gate; the soak itself runs the full six.)*
19. As David, I want "wiring validated" (one clean automated tick end-to-end against real Alpaca paper) to be a distinct, earlier bar than "paper trading achieved" (a sustained 14-day unattended run), so that the composition root ships without waiting on an operational-stability soak test it doesn't own.

## Implementation Decisions

### Module: Scheduler

**Responsibilities**
- Fire ticks on a fixed interval `τ`, gated by a market-hours/trading-calendar source (open/closed, holidays) **and** by an optional policy window.
- Own per-tick instrument iteration over the active list.

**`τ` — the tick interval.** **2 minutes on the paper profile** (`paperStartingProfile.tickIntervalMs`, per [ADR-0008](../adr/0008-llm-spend-cap.md) §2 as amended 2026-08-16). *Not* the library default: `DEFAULT_TICK_INTERVAL_MS` is **60s** and is what any run not using the paper profile still gets. This is the *exit* cadence, and after the tick/decision split (below) it no longer sets LLM spend — spend is keyed to the debate bar. It is not the heartbeat interval, which is a separate mechanism at a separate cadence (see Module: Heartbeat).

**Key Interfaces**

```typescript
// The primary test seam: given a clock and a universe, decide what fires this tick.
interface Scheduler {
  nextTick(clock: Clock): TickPlan;
}

interface TickPlan {
  instruments: { asset: string; asset_class: 'crypto' | 'stocks' }[];
  tick_time: Date;   // = clock.now()
}

interface SchedulerConfig {
  // ... existing fields
  /**
   * Policy window. Venue truth stays in the calendar; this is strategy.
   *
   * At THIS layer the predicate gates the whole tick — an excluded instrument
   * gets no pass, so no Trader, so no flatten. What the composition root
   * injects here is therefore the entry window UNION the flatten tail, never a
   * bare entry window; `ProductionConfig.stocksTradingWindow` takes the entry
   * policy and `withFlattenTail` composes it before it reaches this field.
   * Same name, two layers, and reading them as one field is what switched
   * flat-by-close off once already.
   */
  stocksTradingWindow?: (instant: Date) => boolean;
}
```

- An instrument is included only if the trading-calendar source reports its market open at `tick_time` **and** the policy window admits `tick_time`. Both are read **once per tick**, for the same reason `isOpen` already is.
- ~~Crypto instruments always included.~~ **WITHDRAWN 2026-08-16** — crypto is out of scope ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) amendment). `asset_class` retains its `'crypto'` member for now because collapsing the type touches the wire contracts and every stage; **no scheduler behaviour may depend on that member.**
- Trading-calendar source is a small injected dependency (holiday/session table), not designed in depth here — flagged as a light dependency, not a new component (OPEN-GAP: trading-calendar — ~~LOW severity~~, noted in cross-spec-contracts.md). **This gap is no longer LOW.** *(The strike is the point: cross-spec-contracts.md still carries the original LOW listing in its historical register and records the upgrade separately, so citing it without striking the severity pointed a reader at a grade that document itself has withdrawn.)* With a policy window layered on top and a daily out-of-session screener keyed to the *next trading day*, a wrong calendar now produces a wrong watchlist as well as a wrong tick — and [#696](https://github.com/dd-jp/samurai-trading-system/issues/696) reports the US equity calendar as weekend-only, trading through Thanksgiving. **One calendar, injected, never re-derived by a second consumer.**

#### The window is policy; the calendar is venue

These go in different places and the distinction is load-bearing, not stylistic.

`LseRegularHoursCalendar`'s 08:00–16:30 span is **venue truth**, and the *same object* resolves `sessionEnd` for the flatten rule ([#657](https://github.com/dd-jp/samurai-trading-system/issues/657): close − 5 minutes, resolved through the instrument's `TradingCalendar`). Narrowing the calendar to express a strategy window therefore moves the flatten instant as a side effect.

**The failure this prevents has already been shipped once.** The predicate gates `TickPlan.instruments`, and the tick runner runs a pass only for instruments in the plan — so an excluded instrument gets no Trader, and `withinFlattenWindow` is evaluated on a tick and nowhere else. There is no session-end job. A window closing at 15:45 therefore deleted every tick that could ever land in `[sessionEnd − flatten_before_close_ms, sessionEnd)`, and on the paper venue that put the last tick **5h10m** before the flatten needed one. Every position would have carried overnight against ADR-0014, with the log reading exactly like a session with nothing to flatten.

**Required composition:** the tick window is the entry window **∪ the flatten tail**. The union cannot open a position — the entry path consults the same window and returns `skip('session_closing')` — and the gap between the two spans needs no tick, because equity brackets rest at the venue, marks are fetched per call, and fills ingest independently.

**Resolve the tail through the mode-selected calendar, not a pinned venue.** `sessionEnd` differs by venue (LSE live, US paper), and the composition root and the Trader build their calendars from the same pure factory over the same config — which is *why* they agree. A test that pins one venue cannot see a hard-coded tail; the assertion must run unpinned.

### Module: Tick Runner (pipeline wiring)

**Responsibilities**
- For each instrument in a `TickPlan`, run the **tick path** — except on a new debate bar, where the **decision path** runs instead (its Trader routing evaluates the flatten first, so the flatten is still checked on every pass; see "One Trader entry point per pass" below).
- Generate a trace ID and emit a `Signal` per decision.
- Bound concurrency across instruments.
- Only call Execution on a Verdict `go`.

#### The tick/decision split (2026-08-16)

**This replaces the previous definition of a tick as one pass through the full pipeline.** That definition was written when one tick *was* one decision. Under an intraday horizon they are different cadences, and collapsing them forces a choice between an expensive entry loop and a slow exit — where the exit is the side holding open risk.

```
every tick (τ = 2 min):   flatten check (the Trader's exit-only entry: positions, mark, window)
every new debate bar:     Signal → Analysts → Debate → Trader → [Invalidation] → Risk → Verdict → Execution
```

*(`[Invalidation]` is bracketed because it is **specced and not built** — the 2026-08-05 amendment below adds it between Trader and Risk, `devils-advocate-spec.md` owns it, and the runtime chain is six stages going Trader → Risk today. It appears here because omitting it entirely, as this line first did, reads as a competing decision about the pipeline's shape rather than a statement about what is wired. Nothing about the tick/decision split changes its position or its status: it is a decision-path stage, so it runs at most once per debate bar, and an `exit` intent skips it — the system can never block its own way out of a position.)*

**The waste this removes is structural, not incidental.** The runner previously called the analyst step unconditionally, before any branch. At τ = 2 minutes against a 60-minute debate bar that is **30 analyst runs per debate**, each rebuilding the same read from bars that have not changed. Most of those ticks exist only for the exit, and an exit needs a mark, an ATR and a bracket — not a full structural read.

**Four constraints, each a defect this system has already shipped once:**

1. **Flat-by-close runs on the TICK path, never behind the decision gate.** `withinFlattenWindow` is evaluated on a tick and nowhere else; there is no session-end job. A flatten check behind a debate-bar gate stops running on most ticks, which is the failure described under Scheduler above. **The cheap path is the one that must be able to flatten.**
2. **One notion of "the bar", passed down — not re-derived.** [CV-21 / #687](https://github.com/dd-jp/samurai-trading-system/issues/687) records that the Trader re-derives its decision bar from its own `clock.now()` rather than inheriting the debate's, so a debate straddling a boundary keys its intent into bar N+1 while `debate_id` says N, and bar N+1's real decision is then suppressed. The gate makes that seam **structural rather than incidental**, and its failure mode is a *suppressed entry* — which presents as a healthy no-trade tick. **The gate is the single source of the bar and passes it down;** #687 is a direct dependency, not a footnote.
3. **Do not reintroduce duplicate debates.** [#617](https://github.com/dd-jp/samurai-trading-system/issues/617) measured 4 runs per bar with 3 discarded. The gate must dedupe on the **same key that fix uses**, not a second notion of "new bar".
4. **Exits must not read analyst output.** If any exit branch consults views or debate results, the split is unsafe until that dependency is cut. Verify at the call site; do not assume.

**Verification is by mutation, both directions:** force the gate permanently closed and assert the flatten still fires; force it permanently open and assert the debate count per bar stays at one.

**Spend consequence.** LLM spend is keyed to the decision path, so `τ` no longer prices it. Shortening the debate bar does — and that is the dial to reach for if more decisions per session are wanted, subject to constraint 2 above, since more boundaries make the straddle worse.

**2026-08-05 — the pipeline is SEVEN stages.** [Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291) added `invalidation` between `trader` and `risk` (devils-advocate-spec.md):

- `TickSteps` gains a seventh function, `invalidation`, returning an outcome union or `null`. **`null` means skipped, not failed** — the stage runs only when the Trader returned an `entry` or `scale_in` intent, reusing the Trader's own actionability gate. An `exit` intent skips it, so the system can never block its own way out of a position.
- `TickStage` and `current_tick.stage` gain `'invalidation'`. The latter carries a hard SQL `CHECK` over the six existing names and needs a **table-rebuild migration**; `audit_log.stage` is unconstrained and needs none.
- The stage's result is threaded onto `RiskInput.invalidation?` — pre-built data, the same seam ADR-0003 uses for the red-team critic. **The stage never terminates the tick itself**: `final_stage: 'invalidation'` covers only the skip and fail-open paths, never a reject. Every trade-killing decision goes through Risk's ordered pipeline so that causes are not misattributed.
- **The thesis-invalidated alert fires from the runner, not from Risk.** `RiskManager.evaluate()` is pure and synchronous and stays that way. The runner already reports `RiskDecision.warnings` through an advisory channel after the risk step; this alert is that function's sibling, reading `binding_constraint` for a `thesis_invalidated:*` prefix and posting to an `InvalidationRejectAlertChannel` gated by the existing `AlertsMode` config. Unbreached advisory conditions never alert.
- Composition-root note: the stage needs a **second, metered** client (`anthropic/claude-sonnet-5` via Nous per [ADR-0009](../adr/0009-single-provider-nous.md); was bare `claude-sonnet-5`, `effort: 'medium'`, `max_tokens: 4096`) built alongside the default one — not a `ProductionConfig.llmClient` override, which omits the spend sink and would zero the dashboard's spend tile for this stage.

**Key Interfaces**

```typescript
// Primary seam. One call per instrument per tick.
// Runs the decision path when ctx.decision_bar is set — i.e. when the gate has
// determined a new debate bar has opened — and the tick path otherwise. One
// path, and one Trader entry point, per pass.
interface TickRunner {
  runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome>;
}

interface TickContext {
  clock: Clock;              // wall-clock live; simulated in replay
  trace_id: string;          // generated at Signal emission
  logger: Logger;            // shared structured-logging interface
  auditLog: AuditLog;        // shared_store.audit_log writer
  // Set only when this tick opens a new debate bar. THE single source of the
  // bar for this pass: the decision path and every stage under it use this
  // value rather than re-deriving one from clock.now() (CV-21 / #687).
  // Absent => tick path only.
  decision_bar?: { id: string; open_time: Date; timeframe_ms: number };
  // stage dependencies (marketData, store, broker, costModel, etc.)
  // are each stage's own concern per its spec; the Orchestrator wires
  // the concrete instances into each stage call, it does not redefine them.
}

interface TickOutcome {
  trace_id: string;
  // 'position_check' is the terminal stage of a tick-path-only pass: the
  // exit check ran, no exit was due, and no decision was due. It is a
  // NORMAL outcome and the most common one — roughly 29 of every 30 passes at
  // tau=2min against a 60-minute bar. It must be distinguishable in the logs
  // from a decision pass that declined to trade, or a healthy exit-only tick
  // reads as a no-trade decision and the trade count looks wrong.
  //
  // No `'invalidation'` member, deliberately, even though the decision-path
  // diagram above carries `[Invalidation]`. The diagram states the pipeline's
  // shape; this enum is the set of stages a pass can actually terminate in, and
  // an unbuilt stage can terminate nothing. Adding the member now would put a
  // value in the type that no code can ever emit and that every exhaustive
  // switch would have to handle with a dead branch — the no-caller shape this
  // codebase keeps shipping. It is added in the same change that wires the
  // stage, not before.
  final_stage: 'position_check' | 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
  verdict_status?: 'go' | 'no_go';
  execution_result?: ExecutionResult;   // from execution-spec, only if go
  // true when a TICK-PATH pass's exit check produced an exit intent. Never set
  // on a decision pass — there the Trader's own routing carries the flatten
  // and the intent's `intent_type: 'exit'` is the record. Present so a flatten
  // whose Verdict said no_go is still visible as a flatten that FIRED
  // (`flatten_fired: true, final_stage: 'verdict'`), rather than a
  // healthy-looking no-trade tick.
  flatten_fired?: boolean;
  // true when a TICK-PATH pass's exit check released a position because its
  // momentum signal decayed (#748). Mutually exclusive with `flatten_fired` —
  // the flatten window is checked first and returns before the decay read, so
  // a tick inside the window is a flatten and never an early exit. Set even
  // when Verdict rejects the release, for the same reason `flatten_fired` is.
  //
  // This is a separate flag rather than a reuse of `flatten_fired` because the
  // two answer different questions of a soak: "did the session end" and "did
  // the thesis die". Until #748 the flatten was the only in-process exit the
  // tick path could fire (bracket exits rest at the venue); it no longer is.
  early_exit_fired?: boolean;
}

interface Logger {
  log(entry: { trace_id: string; stage: string; level: 'info'|'warn'|'error'; message: string; payload?: unknown }): void;
}

interface AuditLog {
  record(entry: { trace_id: string; stage: string; decision: string; input_digest: string; output_digest: string; timestamp: Date }): void;
}
```

- `runInstrument` runs exactly one of the two paths per pass, selected by `ctx.decision_bar`: absent — the **tick path** (the exit-only Trader entry point, then Risk → Verdict → Execution if it produced an intent); present — the **decision path**, a straight-line sequential call chain through the already-specced stage interfaces (`Analysts.run`, `DebateEngine.run`, `Trader.decide`, `Risk.evaluate`, `Verdict.decide`, `Execution.execute`). The Orchestrator does not reimplement any stage's decision logic on either path.
- **One Trader entry point per pass, and the flatten is still evaluated on every pass.** A decision pass does not also run the tick path's exit check, because `Trader.decide`'s own routing evaluates the flatten window FIRST on its holding branch (#668) — running both would emit the same-keyed exit twice and write two audit rows per tail stage under one trace. The one pass this can cost a flatten on is a decision pass that short-circuits before the Trader (a quorum skip), and the next tick — one tick interval later, a tick pass — fires it; a quorum skip lost the flatten for exactly one tick interval before the split too, so this is not a new exposure.
- **The tick path calls the Trader too, but on its exit-only entry point.** Mark, early exit and the time flatten are all Trader concerns, not Orchestrator ones — the split is about *which* Trader entry point runs on which cadence, not about relocating exit logic into the runner. Bracket exits rest at the venue (line 51/136 above) — the Trader does not evaluate them. The exit path must be reachable without an `AnalystView[]`, which is constraint 4 above stated as an interface requirement.
- Concurrency across instruments is bounded by a configured cap (`max_concurrent_instruments`), primarily to respect the LLM rate limit on Analysts/Debate (CLAUDE.md HARD STOP governs LLM usage, not broker calls).
- Every stage call passes `trace_id` through its input envelope; every stage's structured log line carries it (propagation note below).
- **`current_tick` row — the one piece of persisted-but-transient state (cross-spec fix, resolves the CLI's tick-status dependency).** Before calling each stage, `runInstrument` upserts a single-row-per-instrument `current_tick` record (`instrument`, `asset_class`, `stage`, `trace_id`, `updated_at`) into the shared store; on tick completion (any terminal outcome — `execution` done, or an earlier no-go) the row is deleted.

  **Amended 2026-08-16 for the tick/decision split.** This lifecycle was written assuming every tick calls every stage, which is no longer true — on a tick-path-only pass no stage in the `stage` enum runs at all. The rule becomes: **upsert on entry to the tick path with `stage: 'position_check'`, upsert per stage on the decision path, delete on any terminal outcome of either path.** `stage` gains `'position_check'`, which means the existing hard SQL `CHECK` constraint needs a **table-rebuild migration**, exactly as adding `'invalidation'` did. Without this, a 2-minute exit cadence either leaves no progress row at all (the dashboard shows a dead system that is working) or leaves a stale one from the last decision (it shows a stage that finished an hour ago). This does NOT contradict the "no unrecoverable in-memory state" decision below: `current_tick` is disposable, best-effort, coarse-grained status — losing it on crash loses nothing but a stale progress indicator (the row is simply re-upserted next tick), unlike `OpenPosition`/`Fill`/`audit_log` which are the actual system-of-record. It exists solely so a separate process (the CLI) can observe "tick in progress for {instrument}" without reading another process's memory.
  ```typescript
  interface CurrentTick {
    instrument: string;
    asset_class: 'crypto' | 'stocks';
    stage: 'position_check' | 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
    trace_id: string;
    updated_at: Date;
  }
  ```

### Module: Structured Logging & Audit Spine

**Responsibilities**
- Provide the shared `Logger` interface every stage logs through.
- Own log-sink configuration (stdout + rotated file).
- Own the `audit_log` table schema in the shared SQLite store.

**Key Interfaces**

```typescript
interface AuditLogEntry {
  trace_id: string;
  stage: string;              // 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution'
  decision: string;            // stage-specific summary, e.g. 'go' | 'no_go' | 'reject' | 'modify'
  input_digest: string;        // hash or compact serialization of the stage input
  output_digest: string;       // hash or compact serialization of the stage output
  timestamp: Date;
}
```

- One `audit_log` row per stage per trace_id — the full per-trade journey is `SELECT * FROM audit_log WHERE trace_id = ? ORDER BY timestamp`.
- Mines the JSONB pattern from sentient-trader (rich per-decision snapshots) for the row shape; storage stays the project's existing shared SQLite (ADR-0001), not a separate database.
- This table is additive to the shared store schema already accumulated by other specs (`bars`/`latest_mark` — MDS; `OpenPosition`/`Fill`/`ClosedTrade` — Execution; `config_trials` — cost-model; weights/params/thresholds — Feedback Loop), alongside the `current_tick` row this spec also adds (Tick Runner module, above) — both are Orchestrator-owned additions to the same shared store.

### Module: Heartbeat

**Responsibilities**
- Emit a periodic liveness signal over the existing trade channel.

**Key Interfaces**

```typescript
interface Heartbeat {
  emit(clock: Clock): void;   // posts a lightweight message to the trade channel on a fixed interval
}
```

- Reuses Verdict's already-provisioned Telegram/Discord transport (verdict-spec story 14) — a different message type over the same client, not a new integration.
- **Not the same destination, though (#342).** The heartbeat posts to its own chat (`TELEGRAM_HEARTBEAT_CHAT_ID`), never the escalation chat (`TELEGRAM_CHAT_ID`) that carries orphaned `go` verdicts, stuck unpriced fills and kill-threshold breaches; startup refuses the two being equal. A liveness ping repeating forever in the escalation chat is what drives an operator to mute it, and a muted escalation chat is the failure the escalations exist to prevent. The property the composition root guarantees: **muting or losing the heartbeat stream cannot silence an escalation.**
- Cadence defaults to **15 minutes** (`DEFAULT_HEARTBEAT_INTERVAL_MS`), sized as the external watchdog's staleness threshold rather than as a tick — not the 60s originally shipped, which put ~20,000 messages into the alert chat over a 14-day soak.
- The alert signal is **silence**, not content: an external watchdog (a separate cron/monitor, out of scope here) checks last-heartbeat-age and alerts if it grows stale. The Orchestrator does not monitor itself — an in-process watchdog cannot detect its own process's death, which is why inverting the heartbeat to alert only on absence (the shape a dead-man's switch ultimately wants, and zero steady-state volume) needs a process this repo does not ship.

### Module: Determinism & Backtest

- The Orchestrator's tick loop runs unchanged in backtest — only the injected `Clock`, `BrokerAdapter`/`DataSource` implementations, and `MarketDataService`/`MarketIntelligence` sources differ (Simulated adapter, historical data, simulated clock advancing deterministically). This is the seam cost-model-backtest-spec.md's "same code path" guarantee depends on (resolves cross-spec-contracts.md OPEN-GAP-D).
- Concurrency cap is disabled or set to run sequentially in backtest for determinism (config-driven), since walk-forward replay needs deterministic ordering, not throughput.

### Module: Production Composition Root

**Resolved by [ADR-0004](../adr/0004-production-composition-root.md) (wayfinder map [#224](../../issues/224)).**

**Responsibilities**
- Bind the real stage instances into a `TickSteps` and construct a `SequentialTickRunner` from it — the one place real dependencies get closed over test-double-free.
- Own the small adapter shims where a stage's native call signature doesn't already match `TickSteps` 1:1.
- Wire Feedback Loop's event-driven and daily-batch entry points at the same composition point, without folding them into `TickSteps` — they are not part of the per-instrument tick chain.
- Construct the persistence/reliability instances the tick chain and its surrounding process need: `SqliteAuditLog`, `SqliteCurrentTickStore`, `OrphanVerdictScanner`, `UniverseScheduler`, `Heartbeat`.

**Key Interfaces**

```typescript
// New file: server/apps/orchestrator/production.ts, re-exported from index.ts.
function buildProductionTickRunner(config: ProductionConfig): {
  tickRunner: SequentialTickRunner;
  scheduler: UniverseScheduler;
  heartbeat: Heartbeat;
  orphanScanner: OrphanVerdictScanner;
};
```

- **Seven `TickSteps` bindings.** `trader` (`decideWithReason`) and `exitCheck` (`checkExitsWithReason`, the Trader's exit-only entry point — bound from the SAME construction so the two share one diagnostic throttle, or the #698/#710 consecutive-tick counting under-counts), `risk` (`RiskManagerImpl.evaluate`), `verdict` (`VerdictImpl.decide`), and `execution` (`ExecutionImpl.execute`) bind directly — each already matches its `TickSteps` method once its own config/dependencies are closed over at construction time. `analysts` and `debate` need a thin adapter: `AnalystOrchestrator.runAnalysts(trace_id, signal, clock)` returns `AnalystRunResult` (`{ views, analyst_count, skipped }`), narrowed to the bare `AnalystView[]` `TickSteps.analysts` expects; `runDebate(input: DebateInput, personas: DebatePersonas)` takes two arguments, closed over the bull/bear/mediator persona set (each backed by the LLM client) to present `TickSteps.debate`'s one-argument shape — a shape that carries the gate's `bar`, which the adapter keys `debate_id` on rather than flooring a clock read of its own.
- **Not part of `TickSteps`:** Feedback Loop's `onTradeClose` (hooks off an `ExecutionResult` fill, called from the same composition point as a side-effect of a completed tick, not a `TickSteps` step) and `runDailyCycle` (its own daily-interval schedule, independent of the per-instrument tick chain).
- **Universe is a config value, not a code path.** `UniverseScheduler`'s `SchedulerConfig.universe` already accepts an arbitrary instrument list; the first paper run passed a narrow smoke-test universe (1-2 instruments) rather than `DEFAULT_UNIVERSE`, widened only after a clean first tick. **That widening has happened ([#381](https://github.com/dd-jp/samurai-trading-system/issues/381)):** `paperStartingProfile` now supplies `DEFAULT_UNIVERSE`, and `yarn smoke` keeps `SMOKE_TEST_UNIVERSE` by passing it explicitly — so the narrow set remains the pre-soak gate rather than the soak. `ProductionConfig.universe` still defaults to `SMOKE_TEST_UNIVERSE`, so no programmatic caller inherits six live instruments by omission.

  **Amended 2026-08-16 — the default stays, and an assertion is added above it.** The default guards a real failure (a caller inheriting live instruments by omission) but leaves a second one open: `SMOKE_TEST_UNIVERSE` was BTC-USD alone *because* crypto bypassed the calendar gate, and with crypto out of scope an equities-only fallback on a closed session yields an **empty tick plan indistinguishable from a healthy no-trade run** — the same signature #691 and #625 both presented with. These two failures do not trade off against each other, so both are guarded: **the library default is unchanged, and the production composition root asserts an explicitly-configured universe and refuses to start without one.** `yarn smoke` passes its universe explicitly and is unaffected.

  **Amended 2026-08-07 ([universe-selector-spec.md](universe-selector-spec.md), map [#397](../../issues/397)) — the statement above now applies to the *candidate pool*, not to what the tick loop iterates.** The two are separate: the **pool** stays a config value, is what `AssetClassRoutingDataSource` builds its map over, and changes only on restart; the **active list** is supplied per session by an `ActiveUniverseProvider` (watchlist + pinned open positions ~~+ crypto~~ — *the crypto term is withdrawn 2026-08-16 with the rest of the asset class; the provider composes two sources, not three*) and swaps at session boundaries. `SchedulerConfig.universe` accepting an arbitrary list is what makes the provider possible rather than something the provider replaces — but the universe must be resolved **once and shared** between the routing map and the scheduler, which today are two independent `config.universe ?? SMOKE_TEST_UNIVERSE` resolutions, or the two can disagree about what the universe is.
- **No new persistence or safety code here.** `SqliteAuditLog`/`SqliteCurrentTickStore` (#201), the HITL approval channel (#207), prompt-injection mitigations (#208), and `OrphanVerdictScanner` (#209) are already-closed implementations this module constructs and wires — it does not implement any of them.

## Testing Decisions

- **Primary seam:** `TickRunner.runInstrument(signal, ctx)` — given a signal and a context (real or fake stage dependencies), assert the correct sequential call order, correct short-circuiting on a Risk reject or Verdict no-go (Execution never called), and correct trace_id propagation through every log/audit entry produced.
- **Tick/decision split — assert by mutation, in both directions.** These are the tests that would have caught the defects listed under Tick Runner, and each has a stated discriminator:
  - **Gate forced permanently closed** → the flatten still fires inside the flatten window, and `final_stage` is `'position_check'`. Discriminator: a flatten check placed behind the decision gate fails this and passes everything else.
  - **Gate forced permanently open** → debates per bar stays at **one**. Discriminator: a gate keyed on a second notion of "new bar" reintroduces #617's duplicates and fails only here.
  - **Analyst call count** → at `τ` = 2 min over one 60-minute bar, `Analysts.run` is called **once**, not 30 times. This is the whole point of the split and should fail loudly if the unconditional call returns.
  - **Bar identity** → the bar the Trader acts on is the one in `ctx.decision_bar`, asserted with a clock positioned so a re-derived bar would differ (CV-21 / #687). A test that does not straddle a boundary cannot see this.
  - **Exit independence** → the tick path completes with the analyst step stubbed to throw. If it does not, an exit is reading analyst output and the split is unsafe.
- **Scheduler seam:** `Scheduler.nextTick(clock)` — given a clock and a trading-calendar fake, assert instruments included/excluded correctly around market open/close boundaries and holidays, **and** around the policy window's edges.
  - **The window's flatten tail needs its own assertion, unpinned.** Assert a tick fires inside `[sessionEnd − flatten_before_close_ms, sessionEnd)` even though it is outside the entry window. **Run it with the calendar unpinned** so it resolves through the mode-selected venue: a test that pins one venue passes against a hard-coded tail and proves nothing. Discriminator: replacing the composed tail with a literal single-venue calendar fails this assertion and leaves the entry-window assertions green.
  - ~~assert crypto always included~~ — withdrawn with crypto's scope removal; assert instead that **no instrument ticks into a closed market**, with no always-open exception.
- Good tests here assert *wiring and sequencing*, not stage decision logic — each stage's own spec/tests own its decision correctness. Prior art: the same seam-testing discipline as every other stage spec (one high-level function, fakes for dependencies, assert on outputs/side-effects not internals).
- Determinism test: same seed + injected simulated clock + fixed universe → byte-identical `TickOutcome` sequence and `audit_log` rows across two runs (mirrors cost-model-backtest-spec's determinism story).
- **Composition root seam:** `buildProductionTickRunner(config)` — given fake/stub adapters for each closed-over dependency (broker, market data, approval channel, etc.), assert the returned `TickSteps` callables produce the same call shape the existing `SequentialTickRunner` unit tests already fake (i.e. the adapter shims for `analysts`/`debate` are covered directly, not just through an end-to-end run). A single real, non-mocked run against Alpaca paper (+ the narrow smoke universe) is the manual/CI-gated E2E check, not a unit test — it's the "wiring validated" done-bar (ADR-0004), run once per environment, not on every commit.

## Out of Scope

- **Any stage's internal decision logic** — Analysts/Debate/Trader/Risk/Verdict/Execution each own their own domain logic per their specs; the Orchestrator only sequences calls.
- **The opportunity-scanner / instrument-ranking engine** — ~~v1 Signal production is a fixed configurable universe list; a smarter scanner that ranks/filters a larger universe is a v2 direction, explicitly deferred.~~ **No longer deferred, and still out of scope *here*:** the scanner is now specified as its own component in [universe-selector-spec.md](universe-selector-spec.md), an out-of-session job that writes a watchlist the Orchestrator reads at the next session boundary. What stays out of *this* spec is the ranking itself; what changes in this spec is that the active list comes from a provider rather than a config constant.
- **The dashboard/CLI** (OPEN-GAP-B) — the Orchestrator produces the `audit_log` data a dashboard would read; building the dashboard itself is separate and unspecced.
- **Multi-host / distributed deployment** — single-process, single-host only, matching the MacBook deployment target.
- **The backtest harness's replay/validation logic** — the Orchestrator's tick loop is what the harness drives via the injected simulated clock; walk-forward/CPCV splitting and metrics computation stay in cost-model-backtest-spec.
- **The trading-calendar/holiday data source itself** — treated as a small injected dependency, not designed here.
- **The external heartbeat watchdog** — the Orchestrator emits the heartbeat; a separate, unspecced monitor consumes its absence.

## Further Notes

Wayfinder decisions for this component live in [docs/wayfinder/orchestrator-map.md](../wayfinder/orchestrator-map.md). This is the last of the 11 components (6 pipeline stages + Market Intelligence + Market Data Service + Execution + cost-model/backtest + Orchestrator) to be charted and specced. With this spec in place, all cross-spec dependencies flagged across the design phase (GAP-I's Signal producer, OPEN-GAP-C's trace-IDs/logging/audit-spine, OPEN-GAP-D's tick-loop seam) resolve to a concrete owner. Remaining before `/to-tickets`: OPEN-GAP-B (dashboard/CLI) can be ticketed as a deferred v2 item without further charting; the trading-calendar dependency can be ticketed as a small infra task.

**2026-07-28 addendum — Production Composition Root.** Wayfinder map [#224](../../issues/224) charted the final gap: this spec described the tick chain's shape but nothing wired real stage instances into it for an actual paper run. Resolved in [ADR-0004](../adr/0004-production-composition-root.md): a new `server/apps/orchestrator/production.ts` binds every real stage into `TickSteps`, targets a narrow smoke-test universe for the first run, and treats "wiring validated" (one clean E2E tick) and "paper trading achieved" (a 14-day unattended soak) as two distinct, separately-ticketed bars. At the time this addendum was written, #74 (Trader position-aware branching) was the only related open ticket and was explicitly not a blocker for the first paper run. **#74 has since shipped and closed (2026-08-06)** — `decide.ts` routes `entry`/`scale_in`/`exit`/hold today, not entry/hold-only, and this spec's own "seventh function" line above already assumes it (invalidation runs "only when the Trader returned an `entry` or `scale_in` intent"). Enter/hold-only was never a target this spec's other sections describe; it was only ever the first-run scope this addendum names. Ready for `/to-tickets`: the `production.ts` implementation ticket and the 14-day-soak follow-on ticket.
