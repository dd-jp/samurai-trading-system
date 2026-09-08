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
variable name (`cause`, `recordError`, `attemptError`, `primaryError`, `readError`, …) finds **19
more** sites — `saxo-http-client.ts`, `alpaca-http-client.ts` ×2, `alpaca-session-calendar.ts` ×2,
`ohlcv-failover.ts`, `nous-chat.ts`, `nous-responses.ts`, `debate-adapter.ts`,
`stage2-verdict.ts`, `trial-execution.ts`, `telegram-bot-api-client.ts` ×2, `backfill-market-data.ts`,
`fill-sync.ts` ×2, `production.ts` ×2. Those are **not** swept here and the file is **not** clean of
the pattern; see "Left alone" below.

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

`describeThrown` itself is untouched: #1199 hardened it across all ~79 callers and re-opening that
ladder here would re-open that review.

## Classification criterion

Not "is it inside a `catch`" — the question is **what dies if this expression throws**:

- **DANGEROUS** — the throw escapes a handler whose job is to handle a failure, and either (a)
  aborts a loop or batch above it, losing units of work beyond the current one, (b) runs *before*
  the durable record that makes the failure recoverable (a store write, an alert, the log line
  itself), or (c) becomes an unhandled rejection in a process where `installFaultHandlers`
  (`server/apps/orchestrator/index.ts:811`) exits non-zero — turning a handled failure into a dead
  trading process.
- **SAFE** — genuinely contained: a top-level CLI/boot catch that exits non-zero either way, or a
  frame that was rethrowing anyway, and nothing batched or durable is lost.

Reachability (can a hostile value actually get here?) is recorded but is **not** the criterion on
its own. Where a site is safe *only* because of reachability, the row says so.

**Result: 43 dangerous (all guarded), 36 safe (all unchanged).**

## Dangerous — guarded (43 sites)

| File | Sites | What a throw costs |
|---|---|---|
| `server/pipeline/execution/residual-protection-sweep.ts` | 3 | **Worst offender.** The site in the per-lot catch inside the `for` loop over marked (naked) lots aborts the whole pass, leaving every *later* marked lot unswept and unprotected. The two inside `sweepOne` are contained by that same per-lot catch rather than independently loop-aborting, but are guarded in the same edit. |
| `server/pipeline/debate-engine/analyst-response-collector.ts` | 1 | Inside a `.then(_, onRejected)` handler: converts a recorded `RaceOutcome` into a fresh rejection that `Promise.all` propagates, losing every *other* analyst's settled view. Structural twin of #1199. |
| `server/pipeline/execution/execute.ts` | 3 | `:219` and `:824` run before the ambiguous-order-state result (`pending` / journal row left `submitting`) that `reconcile()` resolves against. `:805` is the strongest and the ticket did not name it: the reason is built **before** `markLotsUnprotected` and `resolveFlattenError`, so a throw leaves cancelled-but-naked lots with no #549 marker for the sweep to find. |
| `server/pipeline/execution/reconcile.ts` | 3 | See "#297 H1" below — the sites' own safety claim does not carry renderability, and a throw leaves the lot with no divergence at all. |
| `server/pipeline/risk-manager/critic.ts` | 1 (helper) + 5 call sites | A local `describeThrown` reimplementation (no `JSON.stringify` fallback) behind 5 catches that fail open to an `unavailable` verdict. **Deleted** in favour of the shared helper. |
| `server/apps/orchestrator/production.ts` | 4 | `:2876` is the tick loop's own catch, whose comment promises "an error should cost one tick, not the run" — the throw escapes into `void runOnce()` and inverts exactly that. `:3300` is a detached `.catch()`. `:3440` and `:3697` are a chain whose containment is illusory: `:3440`'s throw is caught at `:3697`, which renders the same value the same way and throws again, out of the timer callback. |
| `server/apps/orchestrator/index.ts` | 2 | `:831` is `installFaultHandlers`' `fatal()` — it renders **before** `logCaughtFailure`, so a hostile value loses the `orchestrator_fatal_fault` record and the fault handler itself faults. `:762` is the shutdown handler's `onRejected`: a throw skips `effects.exit(1)` and the process never exits. |
| `server/pipeline/verdict/notifications/telegram/telegram-bot-api-client.ts` | 7 | `:480` is `#runLoop`'s catch and the nominal containment for the other four in-loop sites — it renders the same value the same way, so a throw at any of them re-throws there and out of the un-awaited `this.#loop = this.#runLoop()`: the long-poll dies permanently and inbound approvals are silently never observed. `:759` runs before `#alertDeliveryLog.recordFailure`, destroying #1108's durable undelivered-alert row. |
| `server/apps/orchestrator/*-alert-channel.ts` (exit-valuation, calendar-fallback, threshold-clamp, arm-divergence, prompt-tier) | 5 | Each sits in a `void`ed `.catch()`: no caller can observe the throw, so it becomes an unhandled rejection and `installFaultHandlers` kills the live trading process over a failed alert. |
| `server/apps/orchestrator/heartbeat.ts` | 1 | Value comes from the injected `HeartbeatChannel` (Telegram HTTP); `start()` does `void this.emit(...)`, so the throw is fatal — i.e. it *causes* the crash the heartbeat exists to signal. Falsifies the method's own "Never throws". |
| `server/apps/orchestrator/control-arm.ts` | 1 | A measurement-arm failure escapes into `SequentialTickRunner` (deliberately un-caught), killing the **live** arm's pass. Falsifies "must never take down the arm that trades the book". |
| `server/apps/orchestrator/fill-sync.ts` | 1 | Broker-sourced values; the throw escapes `runOnce` into `void runOnce().then(schedule)` — fatal, with fill polling never re-armed. |
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

**Frames that were rethrowing anyway (5).** The expression builds the message of an error the
enclosing `catch { throw classify…(…) }` is about to throw. A render failure substitutes one throw
for another on the same path; nothing handled becomes unhandled, and no record is lost. The real
cost is a *lost retry classification*, which is a different (unfiled) defect, not this one.

- `server/pipeline/verdict/notifications/telegram/telegram-errors.ts:235`
- `server/pipeline/execution/adapters/alpaca-broker-errors.ts:226`
- `server/pipeline/execution/adapters/saxo-broker-errors.ts:303`
- `server/providers/market-data-service/sources/alpaca-data-errors.ts:163`
- `server/providers/market-data-service/sources/polygon-bars-errors.ts:90`
- `server/pipeline/debate-engine/llm/anthropic-client.ts:269`

**Top-level process or CLI handlers (7).** The process exits non-zero either way; only the message
text is lost.

- `server/apps/supervisor/index.ts:47`
- `server/apps/orchestrator/index.ts:988`
- `server/tools/data-cli.ts:72`
- `server/tools/backfill-market-data.ts:562`
- `server/apps/orchestrator/smoke-run.ts:3701`, `:4214`, `:6573`

**Contained by an outer guard that does not share the defect (5).**

- `server/apps/service-api/provider-status.ts:369` — a throw rejects `pollOnce`, which every caller
  guards with `.catch(swallow)`.
- `server/apps/orchestrator/production/direct-bind.ts:631` — the caller wraps it in an explicit
  `void postTraderDiagnosticAlert(...).catch(() => {})` written for this case.
- `server/providers/market-intelligence/mi-ingest-agent.ts:162`,
  `server/providers/market-intelligence/grok/grok-agent.ts:386`, `:490` — contained twice
  (`composeMarketIntelligence`'s swallowing catch and `MiRefreshQueue.#dispatch`'s
  `logCaughtFailure`), and the durable archive/store writes already landed.

**Only repo-authored or library `Error`s can reach the catch (18).** Every producer on the path
throws a spec-conforming `Error` with a string `message` — `better-sqlite3`, Node `fs`/stream, or
this repo's own constructors. The render cannot throw for those values. This is a *reachability*
argument, not a structural one: it stops holding the day a third-party client is wired into one of
these paths, which is why the row says which producer it rests on.

- `server/apps/orchestrator/rotating-file-sink.ts:327`, `server/apps/orchestrator/logger.ts:254`,
  `server/apps/orchestrator/log-retention.ts:759` — Node `fs`/stream errors only.
- `server/apps/orchestrator/production.ts:735`, `:807`, `:934` — `better-sqlite3` prune failures.
- `server/apps/orchestrator/production.ts:2488` — `AlpacaNewsClient`'s own construction throw.
- `server/apps/orchestrator/production.ts:3462` — reached only under
  `isThresholdBoundViolation(error)`, i.e. a repo-authored `Error`, and already inside its own
  try/catch.
- `server/apps/orchestrator/production.ts:4188` — `feedbackScheduleStore.lastBoundary()`
  (`better-sqlite3`).
- `server/apps/service-api/index.ts:185` — `AlpacaHttpBrokerClient`'s missing-credentials `Error`.
- `server/apps/orchestrator/production/us-equity-session-source.ts:137`, `:163` —
  construction/`fetch` errors.
- `server/apps/orchestrator/production/daily-equity-metrics-source.ts:265` — `computeMetrics`' own
  throw.
- `server/apps/orchestrator/production/on-trade-close-hookup.ts:161` — repo-authored
  `onTradeClose` failures, and `applyLotAdvance` already landed.
- `server/apps/orchestrator/production/data-failover.ts:165` — `resolvePolygonPacing`'s env-parse
  `Error`.
- `server/pipeline/debate-engine/llm/spend-sink.ts:268`, `:287`, `:302` — the first two land in the
  outer catch at `:288`; `:302` is the outermost `record()` catch, contained by
  `anthropic-client.ts`'s deliberately empty `catch {}`.

## Criterion 5 — the `reconcile.ts` #297 H1 claim

`server/pipeline/execution/reconcile.ts:416` cited #297 H1 as making the site safe. Traced, and the
claim as written is **narrower than the use it was put to**, so the three sites are dangerous and
the comment is corrected in this PR.

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

## Left alone

- **The 19 renamed-variable variants** listed under "Verified count" above. Same defect, same fix;
  out of this ticket's stated boundary. Several are dangerous by the criterion above
  (`server/apps/orchestrator/fill-sync.ts:320` and `:359` are the sibling catches of the site this
  PR guards at `:395`; `server/apps/orchestrator/production.ts:3473` and `:3665` are inner
  alert-failure handlers). Worth a follow-up ticket.
- **A hole in `sanitizeBrokerError` itself** (point 2 above): it dereferences properties of an
  untrusted thrown value inside a `catch` whose job is to convert it. A throwing getter defeats the
  adapter's whole error boundary. Not this ticket's pattern, and fixing it means touching the
  credential boundary, which deserves its own review.
- **`describeThrown`'s remaining behaviour.** Untouched, per #1199.
