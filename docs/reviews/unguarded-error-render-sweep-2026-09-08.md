# Unguarded error-render sweep — 2026-09-08

**Subject:** every non-test occurrence of the hand-rolled thrown-value render
`` `error instanceof Error ? error.message : String(error)` ``, classified as *dangerous* or
*safe*, with the reason recorded per site.

**Ticket:** [#1262](https://github.com/dd-jp/samurai-trading-system/issues/1262). Reference
implementation: [#1199](https://github.com/dd-jp/samurai-trading-system/issues/1199), which fixed one
instance of this pattern and hardened `describeThrown` itself.

**Tree:** `542537e` (`origin/main`, 2026-09-08). Every line number in this report is relative to that
commit *plus this sweep's own changes*, i.e. the tree the accompanying PR produces. Line numbers in
the ticket body are relative to an older tree and have drifted by up to ~180 lines
(`production.ts`'s tick-loop catch: ticket `:2693`, here `:2876`).

**Addendum tree (#1351, "Left alone" section below):** `73deaa8` (`origin/main`, 2026-09-08 — the
43-site PR above, merged) *plus #1351's own changes*. Line numbers in the "Left alone" section are
relative to that combined tree, not to `542537e`. Two separate consequences, which an earlier draft
of this paragraph conflated:

- **Overlap with the 79-site population.** #1351's guards touch two files this report also cites for
  the original census (`telegram-bot-api-client.ts`, `production.ts`), and one of *those* citations
  shifted — `production.ts`'s `feedbackScheduleStore.lastBoundary()` render moved from `:4188` to
  `:4187`, noted inline where it is cited below.
- **Shifts inside the 20 sites themselves.** #1351's own edits move six of the 20 relative to
  `73deaa8`: `production.ts:3665`→`:3664`, `debate-adapter.ts:1070`→`:1071`,
  `volatility-reading-provider.ts:227`→`:226`, `ohlcv-failover.ts:80`→`:81`, and — from this
  review round's guard on the calendar client — `alpaca-session-calendar.ts:202`→`:207` and
  `:228`→`:233`. Every one is annotated `(:NNN after #1351's PR)` at each citation below.

The addendum's numbers carry the same "frozen, not CI-checked" posture as the paragraph above:
re-derive by hand against a later tree rather than trusting them.

Those line numbers are **frozen to that tree on purpose and are not CI-checked**.
`yarn check:citations` lists `docs/reviews/` in `IMMUTABLE_RECORD_DIRS`
(`server/tools/check-path-citations.ts:101-106`) alongside `docs/adr/` and
`docs/research/archive/`, because a dated report is a snapshot of the tree it was written
against, not a living document — rewriting its citations to match a later tree would falsify the
record. So a reader chasing a citation on a much later `main` should expect drift and read the
commit above as the coordinate system, exactly as for an ADR.

## Why this exists as a document

Acceptance criterion 1 covers all sites, most of which are **not** being changed. A classification
that lives only in a PR body or in per-site comments gets redone: the PR body is not greppable from
the tree, and 36 "this one is fine, because…" comments would be exactly the churn on
safety-critical files the ticket asks to avoid. So the reasoning lives here, once, and the code
carries a comment only where the reason is load-bearing and non-obvious at the site
(`reconcile.ts`'s #297 H1 correction, and the sweep loop's abort hazard).

## Verified count: 79, not 78

```
grep -rn "error instanceof Error ? error.message : String(error)" server client contracts \
  --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

returns **79** on `542537e`. The ticket says 78; main has moved since it was filed. `client/` and
`contracts/` contribute zero. `production.ts` has **10** sites, not the 9 the ticket implies.

**The sweep's boundary is that exact string.** A relaxed grep for the same shape under a different
name finds more:

```
grep -rnE "[A-Za-z_$][A-Za-z0-9_$.]* instanceof Error \? [A-Za-z_$][A-Za-z0-9_$.]*\.message : String\([A-Za-z_$][A-Za-z0-9_$.]*\)" \
  server client contracts --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v "error instanceof Error ? error.message : String(error)"
```

returns **20**. **19** of those rename a plain identifier — nine distinct names, all of them:
`cause` (11 sites), `recordError`, `attemptError`, `alertError`, `primaryError`, `readError`,
`reconcileError`, `sweepError`, `escalationError`; the 20th renders a
**member expression** (`result.reason`) and so is missed by an identifier-only pattern — which is
how it went unlisted here in the first place. Enumerated in full, so no reader has to trust a
total:

- `server/pipeline/execution/adapters/saxo-http-client.ts:337`, `:349`
- `server/pipeline/execution/adapters/alpaca-http-client.ts:581` and
  `server/providers/market-data-service/sources/alpaca-http-client.ts:561` — two **different** files
  of the same basename, one per broker/data leg
- `server/providers/market-data-service/alpaca-session-calendar.ts:202` (`:207` after #1351's PR),
  `:228` (`:233` after)
- `server/providers/market-data-service/sources/ohlcv-failover.ts:80` (`:81` after #1351's PR,
  which collapsed the two-line expression this render was the second line of)
- `server/shared/llm/nous-chat.ts:163`
- `server/shared/llm/nous-responses.ts:350`
- `server/apps/orchestrator/production/debate-adapter.ts:1070` (`:1071` after #1351's PR adds one
  import line above it)
- `server/tools/backtest/stage2-verdict.ts:247`
- `server/tools/backtest/trial-execution.ts:441`
- `server/pipeline/verdict/notifications/telegram/telegram-bot-api-client.ts:781`, `:822`
- `server/tools/backfill-market-data.ts:294`
- `server/apps/orchestrator/fill-sync.ts:320`, `:359`
- `server/apps/orchestrator/production.ts:3473`, `:3665` (`:3664` after #1351's PR — see below)
- `server/apps/orchestrator/production/volatility-reading-provider.ts:227` (`:226` after #1351's PR)
  — the member-expression one

Those were **not** swept here and the files were **not** clean of the pattern; see "Left alone"
below, which now classifies all 20 — resolved by [#1351](https://github.com/dd-jp/samurai-trading-system/issues/1351).

**Both greps end in `String(…)`, and that tail is itself a boundary.** The same defect written with a
**string literal** as the fallback — `err instanceof Error ? err.message : 'snapshot failed'` — is
outside #1262's exact string and outside #1351's relaxed pattern alike, so neither census counted it
and this document should not be read as certifying the rest of the tree. Two such sites are known:
`server/apps/service-api/server.ts:303` and `:315`, both inside HTTP error responders, filed as
[#1355](https://github.com/dd-jp/samurai-trading-system/issues/1355). They are genuinely out of both
tickets' stated boundaries and are not classified here; #1355 carries the mechanism (`:303` sends
headers then never calls `.end()`, hanging the request; `:315` throws inside a `.catch()` callback,
which `installFaultHandlers` treats as fatal).

## The fix shape

`server/shared/safe-log.ts` gains `describeThrownSafely` — `describeThrown` inside a try/catch
falling back to `'[unrenderable error]'`, the placeholder `logCaughtFailure` and #1199 already use.
No third spelling: `'[unrenderable]'` stays `renderErrorDetail`'s per-field spelling in
`server/pipeline/analysts/orchestrator.ts`, which renders one field rather than a whole error.

It is a shared helper rather than #1199's hand-written five-line try/catch repeated 43 times,
because the ticket asks for reviewable diffs on safety-critical files and 43 copies of a guard is
the opposite. Its doc comment states what it does **not** do: it does not sanitize (call sites keep
whatever `sanitizeLogText` posture they already had — every swap here is inside the existing
wrapper, never replacing it), and it does not make the surrounding handler safe.

`describeThrown` itself is untouched: #1199 hardened that one function, and re-opening its ladder
here would re-open that review. It has **19** non-test callers of its own on `542537e` — not ~79.
The arithmetic, because an earlier draft of this paragraph said 18 and 23 and neither reproduced:
`git grep -n 'describeThrown(' 542537e -- server | grep -v '\.test\.ts' | wc -l` returns **26**;
minus the two declarations (`server/shared/safe-log.ts:54` and `critic.ts:177`) that is **24** call
sites; minus `critic.ts`'s five calls to its own local reimplementation (`:308`, `:460`, `:462`,
`:507`, `:618`), a different function this PR deletes, that is **19**. The 18 came from also
excluding `safe-log.ts:121` — `logCaughtFailure`'s own use — which is a caller like any other. The ~79 counted above are the
hand-rolled inline conditionals, which is the reason #1262 exists; #1199 never reached them.

**The swap is not a pure guard — it changes the rendered string for a non-`Error` throw at all 43
sites.** The replaced code ended in `String(error)`; `describeThrownSafely` routes through
`describeThrown`'s ladder (`server/shared/safe-log.ts:55-64`), which tries `JSON.stringify` first.
A thrown `{a: 1}` now renders `'{"a":1}'` where it rendered `'[object Object]'`; a thrown `[1, 2]`
renders `'[1,2]'` where it rendered `'1,2'`. That is *more* content, and it lands on the durable,
deliberately-unsanitized surfaces this document enumerates elsewhere — `ExecutionResult.reason`,
divergence rows, `risk_critic_log` reasoning, `debate_log`. `Error` values are unaffected: the
ladder reads `.message` for those and never stringifies.

Traced before accepting the widening, because "more content reaches an unsanitized durable slot" is
how a credential surface opens:

- The only runtime dependency is `better-sqlite3` (`package.json`); there is no HTTP client
  library, so nothing rejects with a structured request/response object carrying headers. Every
  wire call goes through `fetch`, which rejects with a `TypeError`.
- Non-test `server/` contains **zero** `throw {…}` / `throw '…'` literals — the same grep
  `describeThrown`'s own doc records. The hostile non-`Error` throws live only in `.test.ts` files,
  which construct them deliberately to exercise this function.
- Every `AbortSignal` reason on these paths is an `Error`: `latency-budget.ts:193` aborts with a
  `DebateBudgetExceededError`, `anthropic-client.ts:474` with an `LlmTimeoutError`,
  `fetch-with-timeout.ts:27` with a `DOMException` (which *is* `instanceof Error` on Node 22), and
  `critic.ts:402` / `telegram-bot-api-client.ts:439` / `gdelt-ingest-agent.ts:222` pass no argument
  at all, giving the default `AbortError` `DOMException`. So neither of
  `server/shared/http/token-bucket.ts`'s two `signal.reason` hand-offs — `:236`'s
  already-aborted `Promise.reject(signal.reason)` and `:240`'s `reject(signal.reason)` inside
  `onAbort` — can deliver a bare object here. They read the same `signal.reason`, so the
  enumeration above covers both; an earlier draft cited only `:236`.

The residual, stated rather than hidden: the day a third-party client that rejects with a plain
structured object is wired into one of these paths, its fields will be stringified into those slots
where they previously collapsed to `'[object Object]'`. That is a reachability argument, like the
18-site group below, and it stops holding on the same kind of change.

## Classification criterion

Not "is it inside a `catch`" — the question is **what dies if this expression throws**:

- **DANGEROUS** — the throw escapes a handler whose job is to handle a failure, and either (a)
  aborts a loop or batch above it, losing units of work beyond the current one, (b) runs *before*
  the durable record that makes the failure recoverable (a store write, an alert, the log line
  itself), or (c) becomes an unhandled rejection in a process where `installFaultHandlers`
  (`server/apps/orchestrator/index.ts:811`) exits non-zero — turning a handled failure into a dead
  trading process.
- **SAFE** — genuinely contained: a top-level CLI/boot catch that exits non-zero either way, a
  frame that was rethrowing anyway, or a frame where the throw *does* change the outcome but only
  in the fail-safe direction (the smoke harness's mid-scenario catches below) — and nothing batched
  or durable is lost.

Reachability (can a hostile value actually get here?) is recorded but is **not** the criterion on
its own. Where a site is safe *only* because of reachability, the row says so.

**Result: 43 dangerous (all guarded), 36 safe (all unchanged).**

## Dangerous — guarded (43 sites)

| File | Sites | What a throw costs |
|---|---|---|
| `server/pipeline/execution/residual-protection-sweep.ts` | 3 | **Worst offender.** The site in the per-lot catch inside the `for` loop over marked (naked) lots aborts the whole pass, leaving every *later* marked lot unswept and unprotected. The two inside `sweepOne` are contained by that same per-lot catch rather than independently loop-aborting, but are guarded in the same edit. |
| `server/pipeline/debate-engine/analyst-response-collector.ts` | 1 | Inside a `.then(_, onRejected)` handler: converts a recorded `RaceOutcome` into a fresh rejection that `Promise.all` propagates, losing every *other* analyst's settled view. Structural twin of #1199. |
| `server/pipeline/execution/execute.ts` | 3 | `:219` and `:824` run before the ambiguous-order-state result (`pending` / journal row left `submitting`) that `reconcile()` resolves against. `:805` is the strongest and the ticket did not name it: the reason is built **before** `markLotsUnprotected` and `resolveFlattenError`, so a throw leaves cancelled-but-naked lots with no #549 marker for the sweep to find. |
| `server/pipeline/execution/reconcile.ts` | 3 | Three sites with three different costs, not one story. `:431` (`reconcileLot`'s `getOrder` catch) is the only one that ever carried the #297 H1 claim — see "#297 H1" below; a throw there leaves the lot with no divergence at all. `:197` is `reconcileFlatten`'s `resumeFlatten` catch and renders **before** `postFlattenReconcileAlert` at `:198`, so a throw also swallows #519's paging-worthy unresolved-flatten alert. `:365` is `getOpenPositions`' catch, whose whole output is the one row telling an operator that this pass could not see venue-held positions at all. |
| `server/pipeline/risk-manager/critic.ts` | 1 (helper) + 5 call sites | A local `describeThrown` reimplementation (no `JSON.stringify` fallback) behind 5 catches that fail open to an `unavailable` verdict. **Deleted** in favour of the shared helper. |
| `server/apps/orchestrator/production.ts` | 4 | `:2876` is the tick loop's own catch, whose comment promises "an error should cost one tick, not the run" — the throw escapes into `void runOnce()` and inverts exactly that. `:3300` is a detached `.catch()`. `:3440` and `:3697` are a chain whose containment is illusory: `:3440`'s throw is caught at `:3697`, which renders the same value the same way and throws again, out of the timer callback. |
| `server/apps/orchestrator/index.ts` | 2 | `:831` is `installFaultHandlers`' `fatal()` — it renders **before** `logCaughtFailure`, so a hostile value loses the `orchestrator_fatal_fault` record and the fault handler itself faults. `:762` is the shutdown handler's `onRejected`: a throw skips `effects.exit(1)` and the process never exits. |
| `server/pipeline/verdict/notifications/telegram/telegram-bot-api-client.ts` | 7 | `:480` is `#runLoop`'s catch and the nominal containment for the other four in-loop sites — it renders the same value the same way, so a throw at any of them re-throws there and out of the un-awaited `this.#loop = this.#runLoop()`: the long-poll dies permanently and inbound approvals are silently never observed. `:759` runs before `#alertDeliveryLog.recordFailure`, destroying #1108's durable undelivered-alert row. |
| `server/apps/orchestrator/*-alert-channel.ts` (exit-valuation, calendar-fallback, threshold-clamp, arm-divergence, prompt-tier) | 5 | Each sits in a `void`ed `.catch()`: no caller can observe the throw, so it becomes an unhandled rejection and `installFaultHandlers` kills the live trading process over a failed alert. |
| `server/apps/orchestrator/heartbeat.ts` | 1 | Value comes from the injected `HeartbeatChannel` (Telegram HTTP); `start()` does `void this.emit(...)`, so the throw is fatal — i.e. it *causes* the crash the heartbeat exists to signal. Falsifies the method's own "Never throws". |
| `server/apps/orchestrator/control-arm.ts` | 1 | A measurement-arm failure escapes into `SequentialTickRunner` (deliberately un-caught), killing the **live** arm's pass. Falsifies "must never take down the arm that trades the book". |
| `server/apps/orchestrator/fill-sync.ts` | 1 | `:395`. Broker-sourced values; the throw escapes `runOnce` into `void runOnce().then(schedule)` — fatal, with fill polling never re-armed. |
| `server/apps/orchestrator/orphan-verdict-scan.ts` | 1 | Inside the per-orphan loop: drops every remaining orphan alert and the restart-reconciliation report. |
| `server/apps/orchestrator/production/mi-coverage.ts` | 1 | Alert-transport value escapes into the analysts step and aborts that instrument's whole tick pass. |
| `server/apps/orchestrator/production/analysts-adapter.ts` | 1 | `postSkipAlert` is awaited inside the analysts step: does precisely what the function's doc forbids — turns "the analysts skipped" into "the orchestrator threw". |
| `server/apps/orchestrator/production/tick-skip-alert.ts` | 1 | Awaited from `runOnce` **before** the `ready.length === 0` early return and before `runTickPlan`, so a throw aborts the entire tick plan for every instrument, then re-throws out of `runOnce`'s catch. |
| `server/apps/orchestrator/production/data-failover.ts` | 1 | Detached `.catch()` on an alert send — fatal exit of the trading process. |
| `server/pipeline/debate-engine/llm/spend-cap.ts` | 2 | `:176` is the fail-closed budget read: a throw destroys the "REFUSING new debates" operator line and converts the designed refusal into a raw throw at every `check()` caller. `:259` discards an already-decided refusal while leaving the announce latch set — the exact "must not become an unhandled rejection inside the tick" its own doc promises. |
| `server/pipeline/trader/decide.ts` | 1 | Runs **before** `input.onUnpricedFlatten?.(...)`: a throw both aborts the mandatory clock-driven flatten (ADR-0014 — deferring *is* the harm) and skips the operator page. |
| `server/pipeline/feedback-loop/outside-benchmark-cycle.ts` | 1 | Inside the `for (const benchmark of OUTSIDE_BENCHMARKS)` loop: aborts the loop and the assembled result, losing every remaining benchmark. |
| `server/tools/backfill-market-data.ts` | 2 | `:274` aborts the remaining instrument×window loop, contradicting the comment directly above it ("never rethrown, so this catch cannot itself throw out of the loop"). `:399` is a detached `.catch()` in a CLI with no rejection handler. |

## Safe — unchanged (36 sites)

Grouped by *why*. Line numbers are current and unchanged by this sweep.

**Frames that were rethrowing anyway (6).** The expression builds the message of an error the
enclosing `catch { throw classify…(…) }` is about to throw. A render failure substitutes one throw
for another on the same path; nothing handled becomes unhandled, and no record is lost. The real
cost is a *lost retry classification*, which is a different (unfiled) defect, not this one.

- `server/pipeline/verdict/notifications/telegram/telegram-errors.ts:235`
- `server/pipeline/execution/adapters/alpaca-broker-errors.ts:226`
- `server/pipeline/execution/adapters/saxo-broker-errors.ts:303`
- `server/providers/market-data-service/sources/alpaca-data-errors.ts:163`
- `server/providers/market-data-service/sources/polygon-bars-errors.ts:90`
- `server/pipeline/debate-engine/llm/anthropic-client.ts:269`

**Top-level process or CLI handlers (5).** The process exits non-zero either way; only the message
text is lost.

- `server/apps/supervisor/index.ts:47`
- `server/apps/orchestrator/index.ts:988`
- `server/tools/data-cli.ts:72`
- `server/tools/backfill-market-data.ts:562`
- `server/apps/orchestrator/smoke-run.ts:6573`

**Mid-scenario in the offline smoke harness, failing safe (2).** `smoke-run.ts:3701` and `:4214` are
**not** top-level, and an earlier draft of this document grouped them as if they were, with the
wrong mechanism attached ("the process exits non-zero either way"). Both sit in mid-scenario
catches assigning a local (`readError` at `:3693-3702`, `stepError` at `:4204-4215`); absent a
throw the scenario continues and can still pass, so a throw there *does* change the outcome. It
changes it in the safe direction: the throw aborts the scenario, `runSmoke()` rejects, and the
top-level catch at `:6573` exits 1 — the gate fails rather than passing on an unexamined
assertion. Safe for that reason, not for the one first written down.

**Contained by an outer guard that does not share the defect (5).**

- `server/apps/service-api/provider-status.ts:369` — a throw rejects `pollOnce`, which every caller
  guards with `.catch(swallow)`.
- `server/apps/orchestrator/production/direct-bind.ts:631` — the caller wraps it in an explicit
  `void postTraderDiagnosticAlert(...).catch(() => {})` written for this case.
- `server/providers/market-intelligence/mi-ingest-agent.ts:162`,
  `server/providers/market-intelligence/grok/grok-agent.ts:386`, `:490` — contained twice
  (`composeMarketIntelligence`'s swallowing catch and `MiRefreshQueue.#dispatch`'s
  `logCaughtFailure`). The containment is the whole reason; "the durable archive/store writes
  already landed" is **not** a second one, and an earlier draft offered it as though it were.
  `grok-agent.ts:386`'s catch spans the entire refresh try, which begins at
  `client.fetchSentiment` and covers `spendSink.record` (`:316`) as well as `#archive` and
  `store.ingest` — so on the failure paths that actually reach it most often, nothing has landed.

**Only repo-authored or library `Error`s can reach the catch (16).** Every producer on the path
throws a spec-conforming `Error` with a string `message` — `better-sqlite3`, Node `fs`/stream, or
this repo's own constructors. The render cannot throw for those values. This is a *reachability*
argument, not a structural one: it stops holding the day a third-party client is wired into one of
these paths, which is why the row says which producer it rests on.

- `server/apps/orchestrator/rotating-file-sink.ts:327`, `server/apps/orchestrator/logger.ts:254` —
  Node `fs`/stream errors only.
- `server/apps/orchestrator/production.ts:735`, `:807`, `:934` — `better-sqlite3` prune failures.
- `server/apps/orchestrator/production.ts:2488` — `AlpacaNewsClient`'s own construction throw.
- `server/apps/orchestrator/production.ts:3462` — reached only under
  `isThresholdBoundViolation(error)`, i.e. a repo-authored `Error`, and already inside its own
  try/catch.
- `server/apps/orchestrator/production.ts:4187` (`:4188` before #1351's PR removed a line earlier in
  the file, at `:3665`'s old position) — `feedbackScheduleStore.lastBoundary()` (`better-sqlite3`).
- `server/apps/service-api/index.ts:185` — `AlpacaHttpBrokerClient`'s missing-credentials `Error`.
- `server/apps/orchestrator/production/us-equity-session-source.ts:163` — `fetch` errors and this
  function's own `zero calendar rows` throw.
- `server/apps/orchestrator/production/daily-equity-metrics-source.ts:265` — `computeMetrics`' own
  throw.
- `server/apps/orchestrator/production/on-trade-close-hookup.ts:161` — repo-authored
  `onTradeClose` failures, and `applyLotAdvance` already landed.
- `server/apps/orchestrator/production/data-failover.ts:165` — `resolvePolygonPacing`'s env-parse
  `Error`.
- `server/pipeline/debate-engine/llm/spend-sink.ts:268`, `:287`, `:302` — the first two land in the
  outer catch at `:288`. `:302` is the outermost `record()` catch, and an earlier draft named
  `anthropic-client.ts`'s deliberately empty `catch {}` as its containment. That is only one of two
  callers: `server/providers/market-intelligence/grok/grok-agent.ts:316` calls
  `spendSink.record(...)` with no such wrapper. Containment still holds there, by the same two
  guards the `grok-agent.ts` rows above rest on — `composeMarketIntelligence`'s per-agent swallow
  (`server/apps/orchestrator/production/analysts-adapter.ts:204-228`) and `MiRefreshQueue.#dispatch`'s
  `logCaughtFailure` (`server/apps/orchestrator/production/mi-refresh-queue.ts:277-312`) — but not
  for the reason first written down.

**Documented as belt-and-braces, and classified SAFE on reachability anyway (2).** Called out
separately because the tension is real and a future edit should see it, though the two sites make
different claims and only one of them is an argument against enumerating producers.

`sweepStaleLogsWithLog` (`server/apps/orchestrator/log-retention.ts:710-763`) does decline the
enumeration outright: "never throwing past this point… this wrapper's own try/catch covers anything
unanticipated". Classifying its `:759` render SAFE on the enumerable set of Node `fs`/stream
producers is exactly the anticipation that comment refuses to assume, so this is the weakest
classification in the document and the first to revisit if that path gains a producer.

`us-equity-session-source.ts:130-137` makes the narrower claim, and the earlier draft of this
paragraph overstated it. Its comment *names* the case it handles — "reaching this catch means the
pair passed that gate but this client's own construction still failed (e.g. a caller-injected empty
override) — treat it exactly like a fetch failure rather than letting it escape uncaught" — so it
is deliberate handling of an enumerated cause, not a blanket claim to cover the unanticipated.
`new AlpacaHttpCalendarClient()`'s own missing-credentials throw is the only producer, and it is a
spec-conforming `Error`; SAFE here rests on the same enumeration the comment itself performs.

The boot-abort cost holds for both, and the citation is per site rather than the single one an
earlier draft offered. Both call sites sit inside the same entrypoint try (`:923-990`) whose catch
ends in `process.exit(1)`, so a throw at either render escapes to kill startup:
`runEntrypointLogRetention` is *called* at `server/apps/orchestrator/index.ts:947` (`:895-917` is
only its definition, which proves nothing about the frame), and
`resolveUsEquitySessionCalendar` — the function holding `us-equity-session-source.ts:137` — at
`:976`, behind a `mode === 'paper'` gate, so that half of the cost is paper-only.

- `server/apps/orchestrator/log-retention.ts:759`
- `server/apps/orchestrator/production/us-equity-session-source.ts:137`

## Criterion 5 — the `reconcile.ts` #297 H1 claim

`server/pipeline/execution/reconcile.ts:431` (`:416` before this PR widened the comment) cited #297
H1 as making the site safe. It is the only one of the file's three sites that made the claim.
Traced, and the claim as written is **narrower than the use it was put to**, so that site is
dangerous; `:197` and `:365` are dangerous for the separate reasons in the table above, and all
three are guarded. The comment is corrected in this PR.

What H1 actually gives: `AlpacaBrokerAdapter.call` / `SaxoBrokerAdapter.call`
(`server/pipeline/execution/adapters/alpaca-adapter.ts:334`,
`server/pipeline/execution/adapters/saxo-adapter.ts:197`) wrap each client call in
`try { … } catch (cause) { throw sanitizeBrokerError(venue, operation, cause) }`, and
`sanitizeBrokerError` (`server/pipeline/execution/broker-error.ts:100`) builds a `BrokerError` from
curated fields only, discarding the original. That is a **credential** guarantee, and it holds.

What it does **not** give, and what the comment was read as giving — "only curated `BrokerError`s
reach this catch":

1. **The adapter does real work outside `call`.** `AlpacaBrokerAdapter.getOrder`
   (`server/pipeline/execution/adapters/alpaca-adapter.ts:629`) calls `this.call(...)` and then, on
   the returned value, runs `this.emulation.owns(...)`, `mapOrderState`,
   `this.state.recordBracketOrderIds(...)` (an injected `BrokerStateStore`) and `normalizeOrder`.
   None of those throws passes through `sanitizeBrokerError` at all.
2. **`sanitizeBrokerError` reads properties off the raw thrown value.** `readStatusCode`,
   `readVenueCode` and `readVenueMessage` dereference `status` / `statusCode` / `response.status` /
   `code` / `venueMessage` on the client's error. A value with a throwing getter on any of those
   throws from *inside* `call`'s own catch, and whatever the getter threw travels onward — which
   may be an arbitrary, unrenderable value.

So the three `reconcile.ts` renders are guarded rather than trusted. No credential-leak claim is
made here: none was traced, and (2) is a hole in the *renderability* argument, not the H1 one.

**Found and left alone:** `logCaughtFailure`'s own doc comment in `server/shared/safe-log.ts:142`
repeats the same H1 inference ("the same precedent `reconcileLot`'s own `getOrder` catch cites").
That doc is describing why `sanitizeLogText` is belt-and-braces rather than resting a guarantee on
H1, and `logCaughtFailure` guards its render regardless — so the inference is decorative there, not
load-bearing. Correcting it would mean a third edit to `safe-log.ts` in as many PRs; noted here
instead.

## The lint-rule question

**Recommendation: do not add a syntax rule now.** Two reasons, in order of weight.

1. **It cannot catch the mistake that actually recurs.** The recurring error is calling
   `describeThrown` — or hand-rolling it — *without a surrounding guard, at a site where a throw
   escapes a handler*. Whether a throw escapes is a dataflow-and-intent question about the
   enclosing frame. A `no-restricted-syntax` matcher on the conditional's shape answers a different
   question, and would have flagged all 79 sites identically, including the 36 where the answer is
   "this is fine".
2. **A ban would need 36 inline suppressions**, most of them on `production.ts`, `smoke-run.ts` and
   the `*-errors.ts` classifiers — i.e. exactly the "comment noise on safety-critical files" the
   ticket asks to avoid, in exchange for a signal this document already carries in one place.

What *would* prevent the 79th, and is cheap: `describeThrownSafely` now exists and is exported from
the `server/shared` barrel, so the correct thing is a one-line call rather than a five-line guard.
A rule worth revisiting later is a narrower one — ban the hand-rolled conditional **only** when it
is syntactically inside a `CatchClause` — which would have flagged most of the 43 and few of the
36. Biome's `noRestrictedSyntax` takes GritQL patterns, so this is expressible; it is not built
here because it still needs the 36 safe sites triaged against it first, and that is a separate
change from this one.

## Left alone, then closed by #1351

- **The 20 renamed variants** enumerated under "Verified count" above. Same defect, same fix; out of
  this ticket's (#1262) stated exact-string boundary, which is why they were not swept here.
  **[#1351](https://github.com/dd-jp/samurai-trading-system/issues/1351) resolves all 20**: **8 are
  dangerous by this document's own criterion and are now guarded** with `describeThrownSafely`, the
  same mechanism as the 43 above — no second placeholder spelling. The other **12 are safe**, three
  different ways. Line numbers below are the addendum tree (`73deaa8` plus #1351's own changes — see
  "Addendum tree" at the top of this report), and six of the 20 shifted under #1351's own edits,
  noted per-site below.

  An earlier draft of this section audited eight of the twenty (six dangerous, two safe) and left
  the remaining twelve unexamined; that draft's mechanism for the two `fill-sync.ts`-adjacent safe
  sites was also corrected once already (copied from the `:395` row where it is correct and was
  wrong for them). All fixed-point corrections from that draft are preserved below; this revision
  completes the audit rather than re-litigating it.

  All eight dangerous sites lose their own diagnostic record, so losing a diagnostic record does not
  discriminate. The question that does, given each site's outer guard: **does something durable that
  would otherwise have landed fail to land?** That is why (a)/(b)/(c) are dispositive at seven of the
  eight below and not at the twelve safe ones — those seven have no outer frame that renders a
  substitute, or lose more than a log line (a whole map's worth of readings, a poll's
  ingest-and-sweep pass, a day's tuning cycle, the original `cause`'s identity). The eighth,
  `alpaca-session-calendar.ts`, answers the same question through a mechanism none of (a)/(b)/(c)
  names — what fails to land is a **retry**, because the render sits upstream of the constructor
  whose flag the retry predicate reads. The twelve safe ones either escape into a guarded catch that
  logs the failure and re-arms, are structurally rethrowing regardless of whether the render itself
  succeeds, or cannot receive a hostile value at all given their producer's closed shape.

  ### Dangerous — guarded (8)

  - `server/pipeline/verdict/notifications/telegram/telegram-bot-api-client.ts:822`
    (`escalationError`) — criterion (c). Inside a detached `.catch()` on
    `#call('sendMessage', …)`; nothing awaits or re-catches it, so a throw is an unhandled
    rejection, `installFaultHandlers` fires and the trading process exits non-zero over a failed
    escalation notice. This is the sharpest one: it is in the **same method** whose sibling render
    at `:759` #1262 already guards, and it was passed over only because the variable is spelled
    differently. Mutation-proved:
    `telegram-bot-api-client.test.ts`'s "an unrenderable escalationError does not become an
    unhandled rejection, and logs the placeholder" asserts `process.on('unhandledRejection')` fires
    zero times and the log line carries `[unrenderable error]`; reverting the guard makes the
    rejection reach the process (`Error { message: "render boom" }` observed on the handler) and
    fails the assertion.
  - `server/pipeline/verdict/notifications/telegram/telegram-bot-api-client.ts:781`
    (`recordError`) — criterion (b), same method again. It renders inside the catch around
    `#alertDeliveryLog.recordFailure` and **before** the `telegram_delivery_failed` `#log` below
    it, so a throw destroys the log line that is the only remaining trace once the durable row has
    already failed to write. `#recordDeliveryFailure` is called from `:358` (inside `sendMessage`)
    and `:416` (inside `sendApprovalButtons`) — there is no `#send` in this file. Every non-test
    caller of those two methods either `await`s or attaches `.catch()`, so the throw does not
    become an unhandled rejection here — it aborts the delivery-failure reporting instead, and (per
    the fix) replaces `sendMessage`'s own rejection reason with the render failure. Mutation-proved:
    the test asserts BOTH that `telegram_delivery_failed` still logs and that
    `sendMessage(...).rejects.toThrow(/fetch failed/)` — the ORIGINAL failure, not a render failure;
    reverting the guard changes the rejection reason to `Error: render boom` and drops the
    `telegram_delivery_failed` entry.
  - `server/apps/orchestrator/production/volatility-reading-provider.ts:226` (`:227` before #1351's
    PR) — criterion (a). Inside the `open.map(...)` over `settleWithConcurrency` results, so a throw
    aborts the whole (synchronous) map and rejects `getVolatilityReading`: **every** instrument's
    reading is lost, not the one that failed, and the rejection lands in the per-instrument Risk
    stage (`production/direct-bind.ts:726`). Mutation-proved: the test asserts a FULL
    `VolatilityReading` (`crypto: Infinity`, `stocks: 15` untouched) still comes back when one
    instrument's rejection reason is hostile; reverting the guard makes
    `provider.getVolatilityReading(NOW)` reject outright (`Error: render boom`), losing the `stocks`
    class's reading along with the crypto one.
  - `server/providers/market-data-service/sources/ohlcv-failover.ts:80` (`primaryError`) —
    criterion (b), and the most self-defeating of the eight. It renders at the *top* of the catch,
    before `safeAlert` and before the fallback source is attempted, so a throw defeats the failover
    the function exists to perform — no alert, no fallback bars. Nothing in `withOhlcvFailover`
    catches it either: the throw rejects the `BarFetcher` promise the wrapper returned, so no
    substitute record fires anywhere in the frame. Mutation-proved: the test asserts the fallback's
    bars are still returned AND `alert` still fires with `primaryError: '[unrenderable error]'`;
    reverting the guard makes the fetcher reject outright and `alert` is never called.
  - `server/apps/orchestrator/fill-sync.ts:320` (`reconcileError`) — criterion (a). **Not (c).**
    Both this site and `:359` are in `runPoll` (`:274-365`), not in `runOnce` (`:366-400`) as an
    earlier draft said. `runOnce` does `inFlight = runPoll(); await inFlight;` inside its own `try`,
    catches at `:383`, renders through the now-guarded `describeThrownSafely` at `:395`, and
    `.then(schedule)` at `:405` re-arms — so there is no unhandled rejection, no
    `installFaultHandlers` exit, and fill polling **is** re-armed. That (c) mechanism belongs to the
    `:395` row in the dangerous table, where it is correct, and was copied here in error. What
    makes `:320` dangerous is narrower and structural: it is in the *first* of `runPoll`'s two
    blocks, so a throw skips `deps.execution.ingestFills()` and the residual-protection sweep in
    that block's `finally` — the sweep whose own comment (`:268-272`) says it runs "even when the
    poll itself failed, and ESPECIALLY then". The pass's ingest and #549 sweep are lost, not just a
    log line. Mutation-proved: the test asserts BOTH `ingestFills` and `sweepResidualProtection`
    were still called once, with the `periodic reconcile failed` line carrying
    `[unrenderable error]`; reverting the guard drops both calls to zero.
  - `server/apps/orchestrator/production.ts:3664` (`:3665` before #1351's PR removed a line in this
    same catch) (`attemptError`) — criterion (a). A throw here escapes the `recordAttempt` catch and
    skips `runFeedbackCycle(feedback)` at `:3668` (`:3669` before) and
    `feedbackScheduleStore.recordBoundary` at `:3671` (`:3672` before), so the whole daily tuning
    cycle — analyst weight updates, the `arm_comparison_samples` row, the outside benchmarks — never
    runs for that boundary. The interval is 24h (`DEFAULT_FEEDBACK_INTERVAL_MS`,
    `server/apps/orchestrator/production/defaults.ts:139`), so the `finally` re-arms for *tomorrow*:
    absent a restart the day's cycle is gone, not delayed. It also falsifies the catch's own
    comment, which promises "a failure here must not block the cycle from running (that guarantee
    predates this attempt marker)". Mutation-proved: the test sabotages
    `SqliteFeedbackCycleScheduleStore.prototype.recordAttempt` to throw hostile once, then asserts a
    sample row (`arm_comparison_samples`) was still produced for the boot boundary and
    `feedbackScheduleLastBoundary()` is set; reverting the guard drops the sample count to zero for
    that boundary — the cycle silently skips a day.
  - `server/apps/orchestrator/production/debate-adapter.ts:1071` (`:1070` before #1351's PR adds one
    import line above it) (`cause`, inside the standalone `logDebateFailure`) — criterion (b).
    `logDebateFailure` has no internal try/catch, so a throw here happens **before**
    `logger.log(...)` runs at all — the `debate_unresolved` diagnostic line, which the function's own
    doc comment says exists to "make the no-row case visible rather than silent", never lands. Worse
    than the other six: the caller (`buildDebateStep`'s catch, `:990-992`; `:989-991` before #1351's PR) does
    `logDebateFailure({...}); throw cause;` — a throw from inside `logDebateFailure` REPLACES the
    caller's intended `throw cause;` with the render failure, losing the original `cause`'s identity
    (and type) for anything upstream that branches on it. This document's own precedent for
    `analyst-response-collector.ts` (guarded in the 43 despite "every AbortSignal reason on these
    paths is an Error today") is that a debate/LLM-call-path site is guarded regardless of today's
    reachability, because `enforceLatencyBudget`/`runDebate` sit in front of LLM clients — a
    third-party-adjacent boundary this report's own residual note (below) says the "zero throw
    literals" argument stops holding "the day a third-party client is wired into one of these
    paths." Guarded on the same reasoning, not on reachability. Mutation-proved: the test asserts
    the rejection `buildDebateStep(...)` produces is `.toBe(hostile)` — the ORIGINAL object, by
    reference — and that `debate_unresolved` still logs with `[unrenderable error]`; reverting the
    guard makes the rejection a fresh `Error: render boom` (failing the identity check) and drops
    the `debate_unresolved` entry.

  - `server/providers/market-data-service/alpaca-session-calendar.ts:207` (`:202` before #1351's
    PR) (`cause`) — a **new** criterion, and the one site in the addendum whose danger is neither
    (a), (b) nor (c): what fails to land is a **retry**. This is the `fetchWithTimeout` catch —
    transport, DNS, timeout — not the JSON-parse catch 26 lines below it, and it is the only one of
    the eight sites sharing that rethrowing shape (this one plus the seven left unguarded below)
    that builds a **retryable** error
    (`new AlpacaCalendarFetchError(msg, true)`). `withRetry`'s predicate (`:241`) is
    `error instanceof AlpacaCalendarFetchError && error.retryable`. A throw from the render escapes
    before that constructor runs, the predicate sees a plain `Error` and refuses it, and the
    3-attempt `DEFAULT_RETRY_CONFIG` budget (`:87`) is spent as **one** — a transient blip becomes a
    terminal calendar failure. That matters because this table is what tells the flatten when the
    US session actually ends: this module's own header calls a missing early close "the DANGEROUS
    direction," and a failed fetch drops the composition root
    (`production/us-equity-session-source.ts`) back to the hand-entered `US_HOLIDAYS` table whose
    coverage stops at 2027. Guarded on the same precedent as `debate-adapter.ts` above —
    "regardless of today's reachability" for a client sitting at a third-party boundary — rather
    than on reachability, which is genuinely closed here and is recorded honestly as such:
    `fetchWithTimeout` (`shared/http/fetch-with-timeout.ts:20-38`) rejects with global `fetch`'s
    `TypeError` or its own `DOMException`, both well-formed. The closure is thinner than it looks,
    though: `fetchWithTimeout` will forward a **caller-supplied** `init.signal` through
    `AbortSignal.any`, and `controller.abort(x)` takes any `x` at all — so the closure holds only
    because *this* call site passes no `signal`, one edit away from not holding. Mutation-proved:
    the test asserts `fetchCalendar` **resolves with both calendar days** after a first transport
    attempt whose rejection renders hostile, and that `fetch` was called **twice** — the retry
    actually happening, not merely the absence of a throw; reverting the guard makes
    `fetchCalendar` reject with `Error: render boom` from inside `withRetry`'s first attempt.

  ### Safe — contained by an outer guard (2)

  - `server/apps/orchestrator/fill-sync.ts:359` (`sweepError`) — **safe**. Nothing in `runPoll`
    follows it, and the throw lands in `runOnce`'s catch, which renders with
    `describeThrownSafely`, logs `fill_poll_failed`, and re-arms. What is lost is the
    `fill_sync_sweep_failed` line's own detail (and, if `ingestFills` was already failing, that
    error's identity, since this render is inside the `finally`) — strictly less than
    `direct-bind.ts:631`, which this document files SAFE though its containment is a silent
    `void postTraderDiagnosticAlert(...).catch(() => {})` that produces no substitute line at all.
    Re-verified against the addendum tree: `runOnce`'s catch and re-arm are unchanged by #1351.
  - `server/apps/orchestrator/production.ts:3473` (`alertError`) — **safe**, same containment group.
    It is the inner catch around `postThresholdClampAlert`, itself inside `runFeedbackCycle`'s outer
    catch; a throw escapes to the scheduler catch at `:3673` (`:3674` before #1351's PR), whose
    render at `:3696` (`:3697` before) #1262 already guards, and whose `finally` at `:3698-3707`
    (`:3699-3708` before) re-arms the timer unconditionally. The failure that matters was already
    recorded before this point — `:3440`'s `feedback_cycle_failed` line (unshifted — it is physically
    earlier in the file than #1351's edit) landed with the threshold-bound violation in it — so what
    dies is the `threshold_clamp_alert_failed` line plus that boundary's completion stamp, and the
    stamp self-heals because `recordAttempt` did land, sending a restart down the "already attempted"
    branch that retries only the stamp. Re-verified against the addendum tree: this catch is
    unchanged by #1351 (the shift is entirely downstream, from `:3665`'s edit).

  ### Safe — reachability-closed (3)

  These three are safe by the narrower of the document's two SAFE arguments — the producer set
  feeding the render is provably closed to anything but a well-formed `Error`, so the value being
  rendered can never actually be hostile, not merely "isn't today by convention." Recorded with the
  producer named, matching this document's own precedent for the 16-site reachability-closed group
  in the exact-string SAFE section (e.g. `production.ts:4187`'s `feedbackScheduleStore.lastBoundary()`
  above).

  - `server/tools/backfill-market-data.ts:294` (`readError`) — inside a nested catch around
    `deps.store.readBars(...)`, itself inside the outer `catch (error) { fetchError =
    describeThrownSafely(error); ... }` block the surrounding comment says exists so a store-read
    failure "does not... abort every remaining pair." `deps.store.readBars` resolves to
    `SqliteMarketDataStore.readBars` (`sqlite-market-data-store.ts`), which only calls
    `better-sqlite3`'s `.prepare().all()` and `fromStoredTimestamp`/`toStoredTimestamp`
    (`shared/store/sqlite-utils.ts`) — both throw only well-formed `Error`/`RangeError`, the same
    two producers this document's reachability-closed group already relies on elsewhere. Not guarded:
    the render cannot receive a hostile value from this producer. One asymmetry recorded rather than
    left for a reader to notice: the sibling render 20 lines up (`:274`) *is* in the guarded 43, for
    exactly the criterion `:294` also meets — the outer catch's own comment (`:280-284`) says the
    inner guard exists so a failed store read does not abort "every remaining pair." `:294` is out
    of the guarded set only because it fell outside #1262's exact-string boundary and inside this
    addendum's reachability-closed argument. And, as with `trial-execution.ts`'s
    `deps.makeEvaluator` below, `deps.store` is an injectable seam typed `MarketDataStore` (`:219`),
    so the producer closure is a statement about today's only non-test binding, not about the type.
    It is filed SAFE and not guarded — unlike `debate-adapter.ts` above, which is guarded
    "regardless of today's reachability" — because a backfill tool is not a third-party-adjacent
    boundary in the sense that precedent turns on.
  - `server/tools/backtest/stage2-verdict.ts:247` (`cause`) — inside `computeDsr`'s
    `for (const asset_class of assetClassesOf(results))` loop, around a call to `deflatedSharpe()`
    (`server/tools/backtest/overfitting.ts`). Grepped: every throw in `overfitting.ts` is a
    repo-authored `throw new Error(...)` literal, none of it wraps a third-party client. Not guarded.
  - `server/tools/backtest/trial-execution.ts:441` (`cause`) — inside the CSCV-only inner catch of
    `runTrialGrid`'s grid loop (`evaluator.evaluate({..., scheme: 'cscv'})`), deliberately soft per
    the adjacent comment ("Refuse rather than throw... Scoped tightly... so it cannot swallow a
    walk-forward or replay failure"). Producer is `EvalExecutorImpl.evaluate` (`eval-executor.ts`)
    plus `metrics.ts`, both grepped as `throw new Error(...)` only. One caveat kept rather than
    silently dropped: `deps.makeEvaluator` is an injectable seam, and its only non-test binding today
    is the default `EvalExecutorImpl` — a future custom evaluator plugged in through that seam would
    need re-checking against this same producer-closure argument. Not guarded.

  ### Safe — rethrowing anyway (7)

  Same shape as this document's own established "nothing handled becomes unhandled" pattern
  (see `alpaca-http-client.ts`'s already-covered sites in the SAFE section above): each of these
  renders `cause` while building the message of a **new** error the **same** catch immediately
  throws (`throw new SomeApiError(...)`). If the render itself throws, a DIFFERENT throw (the render
  failure) replaces the intended one — but the frame still throws either way, and the caller sees a
  rejection regardless.

  **"The frame throws either way" is only half an argument, and an earlier draft of this section
  over-claimed it.** Substituting a plain `Error` for the intended typed one is free *only* where
  nothing downstream branches on the type. Every one of these sits under a retry decision that reads
  the typed error — `withRetry`'s predicate on the five HTTP clients, `isRetryable` on the two LLM
  ones — so it has to be checked per site rather than asserted for the group, and at one site it did
  not hold, which is why
  `alpaca-session-calendar.ts:202` (`:207` after #1351's PR) is now in the dangerous group above
  rather than here. Checked, one by one, for the seven that remain:

  - `saxo-http-client.ts:337`, `:349` → `isRetryableSaxoBrokerError`
    (`saxo-broker-errors.ts:186-197`). Both construct a bare `SaxoBrokerProviderError` with no
    `status` and `retryableTransportFailure` false, so the predicate returns false; a plain `Error`
    matches no branch and also returns false. Identical.
  - `alpaca-http-client.ts:581` (execution leg) → `isRetryableAlpacaBrokerError`
    (`alpaca-broker-errors.ts:176-184`): `isServerErrorStatus(undefined)` is false, and a plain
    `Error` falls through to the same `return false`. Identical.
  - `sources/alpaca-http-client.ts:561` (data leg) → `isRetryableAlpacaDataError`
    (`alpaca-data-errors.ts:131-139`), same arithmetic. Identical.
  - `alpaca-session-calendar.ts:228` (`:233` after #1351's PR) → constructs with `retryable: false`
    explicitly, and the predicate (`:241` after) demands `AlpacaCalendarFetchError && retryable`.
    Both a false-flagged typed error and a plain `Error` are refused. Identical.
  - `nous-chat.ts:163`, `nous-responses.ts:350` → these are 2xx-with-unparseable-body catches (both
    sit after an `if (!response.ok) throw await buildApiError(response)`), so the `NousApiError` they
    build carries a 2xx `.status` — the contract `nous-wire.ts:39-58` spells out.
    `classifyProviderError` (`debate-engine/llm/anthropic-client.ts:255-278`) duck-types that field:
    only 429 and 408/504 become `LlmRateLimitError`/`LlmTimeoutError`, so a 200 falls through to
    `LlmProviderError`, which `isRetryable` (`:39-45`) rejects — and a plain `Error`, carrying no
    `.status` at all, falls through to the same `LlmProviderError`. Identical.

  Two further corrections to what this section used to say about the group. It is **not** true that
  all of them are JSON-parse catches: `saxo-http-client.ts:337` is the `response.text()` body-**read**
  catch, one block above the `JSON.parse` catch at `:349`. And the reachability leg is a separate,
  independently sufficient argument for the seven: each is one level under a `withRetry`/`fetch`
  boundary — never a producer of a structured non-`Error` throw per this document's server-wide grep
  (see "Traced before accepting the widening" above, re-run for #1351: still zero
  `throw {…}`/`throw '…'`/`` throw `…` `` literals in non-test `server/`). For these seven, and
  only these seven, both legs hold. Not guarded.

  The seven, by full path:

  - `server/pipeline/execution/adapters/alpaca-http-client.ts:581`
  - `server/pipeline/execution/adapters/saxo-http-client.ts:337`, `:349`
  - `server/providers/market-data-service/alpaca-session-calendar.ts:228` (`:233` after #1351's PR)
  - `server/providers/market-data-service/sources/alpaca-http-client.ts:561`
  - `server/shared/llm/nous-chat.ts:163`
  - `server/shared/llm/nous-responses.ts:350`

  ### Credential-widening check, re-run for these eight (not inherited from #1262)

  Same conclusion as the 43 above, re-derived rather than assumed: `describeThrown`'s
  `JSON.stringify` ladder only changes rendered output for a non-`Error` value, and each of the eight
  guarded producers is either (a) an HTTP/LLM client behind `fetch` — no structured
  request/response-shaped rejection, since the only non-`fetch` transport dependency is
  `better-sqlite3` — or (b) `better-sqlite3` itself (`production.ts`'s `recordAttempt`). The
  eighth, `alpaca-session-calendar.ts`, is case (a) — global `fetch` behind `fetchWithTimeout`. The
  server-wide re-grep above (zero throw-literal sites) covers all eight. Every guarded site keeps its
  existing sanitizer wrapper exactly where it was — `sanitizeLogText(describeThrownSafely(x))` at the
  two `telegram-bot-api-client.ts` sites and at `debate-adapter.ts`,
  `sanitizeErrorMessage(describeThrownSafely(x))` at `volatility-reading-provider.ts` — never
  `describeThrownSafely(sanitize(x))`, which would sanitize before the placeholder could apply and
  is not what any of these three sites do. `ohlcv-failover.ts`, `fill-sync.ts`, `production.ts`'s
  `attemptError` site and `alpaca-session-calendar.ts` carry no sanitizer before or after, matching
  their pre-#1351 posture exactly.

  The two safe-by-containment verdicts, the three reachability-closed verdicts, and the seven
  rethrowing-anyway verdicts all stay in this block and do **not** join the 36-site SAFE section
  above: that section is the exact-string population, and 43 + 36 = 79 is a census of that
  population alone. These 20 are a different population and are counted separately throughout —
  **8 guarded, 12 safe, 20 total**, closing the "floor, not a total" count this section used to
  carry.
- **A hole in `sanitizeBrokerError` itself** (point 2 above): it dereferences properties of an
  untrusted thrown value inside a `catch` whose job is to convert it. A throwing getter defeats the
  adapter's whole error boundary. Not this ticket's pattern, and fixing it means touching the
  credential boundary, which deserves its own review.
- **`describeThrown`'s remaining behaviour.** Untouched, per #1199.
