# ADR-0014 — The horizon is intraday and flat by close

- **Status:** Accepted
- **Date:** 2026-08-09
- **Decided by:** David — *"i need intraday /day trading. align decisions to that. want max profit"*
- **Related:** [#632](https://github.com/dd-jp/samurai-trading-system/issues/632) (the grilling ticket that recorded it), [#657](https://github.com/dd-jp/samurai-trading-system/issues/657) (the flatten rule), map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631), [`CONTEXT.md`](../../CONTEXT.md) §"Samurai's Edge Thesis (Stage 0)"
- **Supersedes on horizon:** [`docs/research/10-edge-hypothesis.md`](../research/10-edge-hypothesis.md), [`docs/research/11-trend-signal-measurement.md`](../research/11-trend-signal-measurement.md), [`docs/research/12-edge-hypothesis-critique.md`](../research/12-edge-hypothesis-critique.md)

## Context

Three edge theses were live simultaneously and none was marked authoritative — `CONTEXT.md`'s debate-as-edge, doc 10's measured trend premium, and doc 12's critique of both. Doc 12 called this out as **gate 2**: validation spend could not be committed while the thing being validated was ambiguous.

The deadlock did not break on the merits. It broke on a requirement that made two of the three inapplicable: David needs **intraday day trading**, at least one equity and one crypto trade per day, flat by close.

## Decision

**The recorded Stage 0 thesis is (a) — `CONTEXT.md`'s debate-as-edge — at an intraday, flat-by-close horizon.**

Chosen because it is the only intraday-shaped thesis of the three, **not because it has more evidence**. This is stated plainly because the opposite reading is available and wrong: (a) is the least-measured of the three.

Recorded with two amendments:

1. **An explicit horizon** — single session, flat by market close, no overnight carry.
2. **Falsifier arm 2 restated.** The old control was a dual-SMA daily-bar proxy, which belongs to the superseded horizon. The control is now: *the same name selection, the same profit ladder, the same stop, with entry by technical indicator alone and no LLM in the path.*
   > **Read "the same profit ladder" as "the same exit rule as the live arm" (2026-08-17).** The clause's job is *sameness* — the control must not differ from the live arm in anything but the entry — and when it was written the declared exit was a tranche ladder. [#708](https://github.com/dd-jp/samurai-trading-system/issues/708) measured that ladder and rejected it, and [ADR-0018](0018-intraday-thresholds-sizing-and-the-signal-bar.md)'s amendment was withdrawn on 2026-08-17, so the exit both arms share is **D3's neutral single bracket, per subclass, flat by close**. A control built to the literal word here would differ from the live arm on the exit and stop measuring what it exists to measure.

### What this supersedes, and what it does not

Docs 10, 11 and 12 are superseded **on horizon, not on quality**. They measure a monthly-rebalance, 63-day-lookback strategy over ten years of daily bars (doc 11 lines 16, 18; doc 10 Box 3). That evidence is sound and does not transfer to intraday.

Specifically **do not spec or grill against** doc 10's commitments: 0.04%/day, the −23% pre-accepted drawdown, the always-long-same-basket benchmark, veto-only signal generation, or the 6→12-instrument widening to 4.60 effective bets.

What survives from doc 12 is its **method**, not its horizon — in particular **D4**, which rules out return-only comparison against a risk-targeted stream, and the requirement that any benchmark report return and drawdown together.

## Consequences

**The flatten becomes load-bearing, and it does not exist.** "Flat by close" is now an invariant rather than a preference. #657 fixed the rule as **close − 5 minutes, resolved through the instrument's `TradingCalendar`** — an offset rather than a wall-clock constant, deliberately, because the paper path runs Alpaca US equities (`UsEquityRegularHoursCalendar`, 16:00 ET) and the live path runs LSE (16:30 London). A constant would be wrong on one of them.

Neither half of that machinery exists today. Every `flatten` in `server/` is a trader-exit decision or the residual-exposure sweep; nothing fires on the clock, and there is no LSE calendar. Tracked in [#668](https://github.com/dd-jp/samurai-trading-system/issues/668).

**Crypto has no close.** The rule cannot apply literally to a 24/7 venue, and the reason flat-by-close exists — a closed market cannot fill a stop — does not hold there either. Deliberately left open rather than decided by inference, because it would amend this ADR's own invariant: [#667](https://github.com/dd-jp/samurai-trading-system/issues/667).

**`time_in_force.stocks = 'day'` flips from defect to feature.** Doc 10 dropped candidate E2 because it left the overnight lot without a stop. Under flat-by-close there is no overnight lot.

**Ten years of daily-bar evidence stops applying**, and the replacement does not exist: [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) found `REPLAY_TIMEFRAME = '1d'` hard-coded, so the backtest harness cannot replay intraday at all.

## Amendment — 2026-08-16: crypto leaves Samurai's scope entirely

- **Amends:** the Context clause at line 13 — *"at least one equity and one crypto trade per day"*
- **Earned by:** [#705](https://github.com/dd-jp/samurai-trading-system/issues/705), grilled and resolved 2026-08-16 under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703)
- **Decided by:** David — first *"start with all equity first… make crypto a placeholder for future"*, then, revising it the same day: ***"actually drop crypto. we'll create a new system one later for handling crypto trades."***
- **Companion amendment:** [ADR-0017](0017-validation-gates-paper-operational-thesis-expectancy.md)

**Samurai is an equities system. Crypto is out of scope — not parked, not staged, not pending an unpark gate. It moves to a separate system, to be designed later.**

An earlier version of this amendment, written the same day, recorded crypto as *"suspended, not withdrawn"* with an unpark gate on the exit rule. **That framing is superseded by this one** and is preserved only in git history. The distinction matters: a suspension implies this system will one day carry crypto again, and every design decision downstream would have had to keep that door open. It will not.

### Why this needs an amendment at all

The one-crypto-trade-per-day clause is not a passing remark in this ADR — **it is the requirement that broke the three-thesis deadlock.** Thesis (a) was adopted over docs 10/11/12 because it was the only intraday-shaped thesis, and the intraday shape was defined with a crypto trade in it. Dropping crypto silently would leave the running system contradicting the record that selected its own thesis.

**The requirement is withdrawn from this system's scope, and thesis (a)'s adoption rationale survives intact.** (a) was selected for being **intraday-shaped**, and the equity leg is still intraday-shaped: single session, flat by close, no overnight carry. The crypto clause established *that the product was intraday*; it was never load-bearing for *which* thesis won. Narrowing the scope to equities does not reopen the selection between theses, and this amendment must not be read as doing so.

### What this changes about the system's shape

Where the earlier parking framing left crypto machinery dormant-but-live, an out-of-scope ruling makes several things **simplifications rather than suspensions**:

- **There is one venue class.** Every instrument Samurai trades has a session, an open, and a close — so flat-by-close is now an invariant with **no exception case**, rather than an invariant plus a 24/7 carve-out.
- **[#667](https://github.com/dd-jp/samurai-trading-system/issues/667)'s ruling stops being live doctrine for this system.** It resolved that crypto has no time flatten and is held by the venue-side stop instead. That reasoning now belongs to the future crypto system and should be carried across as an input to its design, not retained here as a live rule.
- **The `asset_class` dimension loses its second member in practice.** Whether the *type* collapses is a separate engineering decision with real blast radius, deliberately not taken in this ADR — see "What happens to the code" below.

### The price, recorded rather than argued away

This is the part that belongs in the record rather than a chat log, and dropping is a larger price than parking was:

- **[ADR-0016](0016-universe-leveraged-etps-ungated.md)'s #1 measured lever leaves the book**: the crypto fee schedule, **£0 → £1,140–1,660/yr** — the largest single item in the book's measured economics, ahead of #617 (£252 → £89/yr) and catalyst-gating (~£5/yr, likely net negative). Samurai's economics are now materially smaller than ADR-0016 modelled, and any figure in that ADR carrying a crypto component must be read as no longer describing this system.
- **[ADR-0015](0015-live-venue-account-and-book-split.md)'s £750/£750 split collapses to a single equity book.** ADR-0015's reasoning for the split — that crypto is barred from a S&S ISA and therefore needs a separate `ccxt` account — is unaffected as *reasoning*, but the split it produced no longer describes Samurai's capital. Whether the equity leg now takes the full £1,500 is a **capital decision that is not taken here** and needs its own record.
- **[#671](https://github.com/dd-jp/samurai-trading-system/issues/671)** (Crypto.com Exchange, 5,000 CRO staked, +0.605%/trade) and **[#673](https://github.com/dd-jp/samurai-trading-system/issues/673)** (£178 / 180-day stake) are decided work that Samurai will never exercise. They are **not wasted** — they are inputs the future crypto system inherits — but they should be re-labelled as such rather than left reading as pending Samurai work.
- **The crypto brackets are never measured by this system.** ADR-0018's Consequences note that #660's 4%/2% crypto levels are unmeasured and blocked on #667. That measurement leaves this system's scope with the asset.

### What happens to the code — deliberately not decided here

`AssetClass`, `AlwaysOpenCalendar`, `sessionCalendars`, the crypto config keys and `SMOKE_TEST_UNIVERSE`'s BTC-USD entry are all still in the codebase. **Removing them is a separate, reversible engineering decision and is not taken by this ADR**, for two reasons:

1. **`AlwaysOpenCalendar`'s `sessionEnd → null` is #667's ruling enforced by the type system.** Deleting it discards a resolved decision that the future crypto system will need. It should be *migrated* to that system's record, not dropped on the floor.
2. **Collapsing `AssetClass` touches the wire contracts, the store schema and every stage.** That is a large mechanical change whose only benefit is tidiness, and this repo's dominant defect class is mechanisms nothing calls — a change of that size, made for tidiness, during a spec phase, is how that class gets fed.

**The operative rule until that decision is taken:** crypto is out of scope, so no spec, no gate, no measurement and no ticket may assume a crypto path exists. Inert code that no longer has a product behind it is technical debt to be retired deliberately, not a feature in waiting.

## Stated open risk

The recorded thesis rests on a selector with **no observed win rate**. [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) measured 96 debates and 0 trades — the stocks conviction ceiling was 0.5478 against a 0.55 floor, and debate rounds moved conviction by zero. Adopting (a) does not make that evidence exist; it makes producing it the next blocking task.

Related: [#552](https://github.com/dd-jp/samurai-trading-system/issues/552) moves onto the critical path, because (a) makes news and sentiment *the edge* while the MI store currently ingests `[]` on every refresh.

## Amendment — 2026-08-19: the mandatory flatten is exempt from Verdict's staleness gate

- **Status:** implemented by the PR that closes [#894](https://github.com/dd-jp/samurai-trading-system/issues/894); **pending David's ratification.** He has not been asked and has not approved it. Every other amendment on this page records an owner decision — this one records an engineering resolution to a defect, taken because the invariant this ADR declares was not holding in production and the fix could not wait on a review cycle. If David rules otherwise, the code changes with the ruling.
- **Amends:** the Consequences clause "the flatten becomes load-bearing" — it was load-bearing and it could not reach the broker.
- **Proposed by:** #894, found by the hostile review of PR [#891](https://github.com/dd-jp/samurai-trading-system/pull/891) (the #826 fix) and confirmed by driving the real `VerdictImpl.decide`.

### The defect

Verdict's gate 1 (`staleness`) `no_go`'d **every** flat-by-close flatten on equities, so the mandatory exit could not reach Execution at any tick, on a healthy feed or a degraded one.

The tick path stamps `decision_timestamp` to the **decision bar** — `floorToBar(clock.now(), DEBATE_BAR_TIMEFRAME_MS)`, a 1-hour grid — while the flatten window opens only `flatten_before_close_ms` (5 minutes) before the session close. The signal's measured age at the moment of the flatten is therefore structural, not incidental:

| venue | close | window opens | decision bar | signal age | vs `max_signal_age.stocks` (15 min) |
| --- | --- | --- | --- | --- | --- |
| US | 20:00Z | 19:55 | 19:00 | 55–56 min | `no_go` |
| LSE | 15:30Z (16:30 London) | 15:25 | 15:00 | 25–26 min | `no_go` |

Three consequences worth stating plainly: the flat-by-close invariant this ADR declares did not hold in the running system; #826/#891's degradation of a mark-read failure into an unpriced flatten was silently voided one stage later; and the failure presented as a `no_go`, which reads like caution rather than like a dropped exit.

### The resolution

**A mandatory flat-by-close flatten is exempt from gate 1.** The Trader marks the intent `metadata.mandatory_flatten` (set by `buildFlattenExit` exactly when `exit_reason === 'flatten'`), and `VerdictImpl` skips the staleness bound for a marked intent alone. Gates 2–6 are untouched: dedup still stops a repeated flatten double-submitting, and the fire-time breaker re-check still applies.

**Why the exemption is sound rather than convenient:** a flat-by-close exit is not acting on a stale *opinion*, it is acting on the clock. The position must be closed before the session ends whatever the debate that opened it now thinks, so the age of that debate is not a reason to leave leveraged exposure on overnight. Gate 1 bounds how old a *decision* is, and this decision was made by the calendar at the moment the gate ran.

This mirrors the precedent PR #891 (#826) set one branch below — the unpriced flatten skips the two price gates for the same structural reason — and it deliberately reuses that pattern (a typed, true-or-absent marker set at the single site an exit is constructed) rather than inventing a second mechanism.

### Why not the other three candidates

- **(2) Stamp the flatten with `clock.now()` instead of the bar floor.** Defensible in principle — the flatten is decided at the tick, not at the bar — but `decision_timestamp`'s bar-floored value is what makes the idempotency key stable within a bar (#616, #748). Moving it for one intent puts weight on the dedup gate, which is the mechanism keeping a repeated flatten from double-submitting during exactly the degraded conditions this exit runs in. A larger risk than the gate it removes.
- **(3) Raise `max_signal_age.stocks` above the bar timeframe.** Cheapest and worst: it slackens a live freshness bound for **every** intent — including entries — to fix one. The value is marked UNSOURCED in `paper-profile.ts`, whose own note says re-sizing a live gate "is a product decision, not a side effect", so this would also be re-deriving a number nobody derived, under time pressure, for the wrong reason.
- **(4) Make the flatten bypass Verdict entirely.** Largest blast radius, and it discards the two protections that are still doing real work for this intent — dedup and the fire-time breaker re-check — to avoid one gate that does not apply.

### What now holds by test

`server/apps/orchestrator/production/flat-by-close-to-execution.test.ts` drives a tick-decided flatten through the real Trader, Risk, Verdict and Execution bindings, at **both** the US and LSE closes, and asserts the flatten reaches the broker. `smoke-run.ts`'s exit-path harness no longer fabricates its own `go`: it decides one with the real `VerdictImpl`, so the offline run can no longer prove the exit mechanics while saying nothing about whether a flatten survives the stage above them. (That harness's own orders carry fresh `decision_timestamp`s, so it exercises the real gate stack but not this exemption — the exemption's proof is the dedicated test above.)

> **Superseded 2026-09-08 by the amendment below ([#1388](https://github.com/dd-jp/samurai-trading-system/issues/1388)).** The paragraph below's "pre-existing and correct" reading of gate 4 held for a flatten reaching Verdict hours late; it did not hold for one reaching Verdict *seconds* late, which is exactly what #1388 measured in production. Left in place, unedited, as the record of what this ADR said and believed on 2026-08-19.

**What this does NOT claim.** The flatten still passes gate 4: a tick that reaches Verdict after `sessionEnd` is refused as `market_closed`, so the exemption's benefit is bounded by tick latency inside the five-minute window. That is pre-existing and correct — a shut venue cannot fill — but it means this amendment makes the flatten survive *staleness*, not that flat-by-close is now unconditional.

## Amendment — 2026-09-09: gate 1 gets its own clock ([#1190](https://github.com/dd-jp/samurai-trading-system/issues/1190))

- **Amends:** the rejected candidate (2) above, and the flatten-age table under "The defect".

[#1190](https://github.com/dd-jp/samurai-trading-system/issues/1190) adopts the *spirit* of rejected candidate (2) — the flatten (and every other intent) is decided at the tick, not at the bar — but not the candidate itself. It adds a second field, `OrderIntent.decided_at` (`clock.now()` at Trader intent-build time, never floored), rather than moving `decision_timestamp`. Gate 1 now reads `decided_at`; `decision_timestamp` keeps the bar-floored value the idempotency key and `OpenPosition` persistence depend on, untouched. The risk candidate (2) was rejected for — weight shifting onto the dedup gate because a moved `decision_timestamp` would destabilize the key within a bar — does not apply to a field the key never reads.

The flatten-age table under "The defect" (55–56 min US, 25–26 min LSE) is now dead arithmetic: it computed the age of `decision_timestamp`, which gate 1 no longer reads. A flatten's `decided_at` is fresh at build time like any other intent's, so even without the `mandatory_flatten` exemption this section documents, that specific defect mechanism would not reproduce today. The exemption itself is unaffected and is kept — "Why the exemption is sound rather than convenient" above stands on its own, independent of which timestamp field gate 1 reads.

Rejected candidate (3) above — raising `max_signal_age.stocks` past the bar timeframe so a bar-floored coordinate could satisfy it — is #1190's rejected alternative too, for the same reason stated there (it slackens a live freshness bound for every intent to fix a measurement problem in one field) plus a new one: `decided_at` fixes the measurement itself, so there is no bound left to widen around it.

## Amendment — 2026-09-08: the mandatory flatten is ALSO exempt from Verdict's market-closed gate ([#1388](https://github.com/dd-jp/samurai-trading-system/issues/1388))

- **Status:** implemented by the PR that closes #1388; **pending David's ratification**, on the same terms as the 2026-08-19 amendment above — an engineering resolution to a defect found in production, not an owner decision. If David rules otherwise, the code changes with the ruling.
- **Amends:** the 2026-08-19 amendment's "What this does NOT claim" paragraph (quoted and marked superseded above).
- **Proposed by:** #1388, found on the live paper store — #894 fixed gate 1 and stopped one gate short.

### The defect

The 2026-08-19 amendment fixed gate 1 (`staleness`) and left gate 4 (`market_closed`) unconditional, reasoning that "a shut venue cannot fill" — true, but not a reason to refuse a flatten that reaches Verdict a few seconds after the bell, when pipeline latency alone (not a stale decision) put it on the wrong side of the clock. Observed on the live paper store, 2026-09-08 (US close 20:00:00Z):

```
trader_log   AMZN  exit  flatten                      19:59:56.454Z
risk_log     AMZN  approved
verdict_log  AMZN  no_go  market_closed               20:00:06.125Z
```

The flatten was **decided inside ADR-0014's window** (19:59:56.454Z, 19:55:00Z–20:00:00Z), approved by Risk, and refused by Verdict ten seconds later — after ordinary Trader→Risk→Verdict pipeline latency crossed the bell, not because the decision was stale. The lot was left open: the exact invariant this ADR declares, voided by ten seconds of I/O.

### The resolution

**A mandatory flat-by-close flatten is exempt from gate 4 too — unconditionally, mirroring gate 1's #894 exemption exactly: same marker (`metadata.mandatory_flatten`, set by `buildFlattenExit` only for `exit_reason: 'flatten'`), same producer, same shape** (`server/pipeline/verdict/index.ts`). Not bounded by a grace period, and deliberately so: gate 1 already exempts a `mandatory_flatten` intent from staleness unconditionally, so no bound on how late Verdict evaluates one exists today regardless of gate 4 — a second, time-based bound at gate 4 alone would not restore one, it would just relocate where an already-unbounded intent gets refused, on a calendar check standing in for a freshness check it is not built to make. The question gate 4 was actually trying to answer — will the venue accept this — is not one Verdict can answer by consulting a calendar; only the venue can, and the execution layer already resolves whatever it says generically (see the venue-behaviour finding below), so nothing downstream assumes acceptance either way. A genuinely stale replay (a crash-restart re-driving an old intent the next morning, say) is not merely caught downstream by dedup — it cannot reach `decide` at all: `mandatory_flatten` is set only inside `buildFlattenExit`, itself reachable only from the two `flattenWindow.within` branches in `server/pipeline/trader/decide.ts` (the `buildExitIntent(..., 'flatten')` call and the standalone flatten path), so the marker exists only on an intent built fresh, in-window, on the current tick. Every production caller of `VerdictImpl.decide` (`direct-bind.ts`'s live tick loop, `smoke-run.ts`) constructs its `VerdictInput` from that same tick's fresh `RiskDecision` — none re-drives a persisted `OrderIntent` from a store. Dedup (gate 3, ordered before gate 4) remains the backstop against a *duplicate submission* of the same intent, which is a different hazard and still runs unconditionally; it is not what is standing in for a time bound here, because there is nothing to stand in for. Scoped by the flag alone, matching gate 1 and #894's own reasoning for why: re-deriving it from `exit_reason` or `intent_type` would put the policy question inside the Trader's exit taxonomy, where a later change could widen a live gate's exemption without anyone editing Verdict. `buildFlattenExit` is still the single writer and never sets it on an entry, so the exemption cannot widen to one — verified directly in `verdict/index.test.ts`, and end to end through the real `VerdictImpl` and the real US/LSE calendars in `flat-by-close-to-execution.test.ts`.

### The gate this does not remove

Exempting gate 4 does not make a mandatory flatten unrefusable indefinitely. A **priced** flatten (no `unpriced_exit`) still runs gate 2a (`stale_feed`), which measures the mark's age against `max_mark_age.stocks` — **15 minutes** in both `RiskConfig` and `VerdictConfig` (`paper-profile.ts`). Once the post-close gap exceeds that, a priced flatten is refused `stale_feed`, not `market_closed` — the de facto bound on how late this exemption can still produce a `go` comes from the mark's age, not from a clause in this amendment. #1388's own production case (a ten-second gap) and this amendment's end-to-end test (`verdictDelayMs: 4 * 60_000 + 10_000`, ~4m10s) both sit comfortably inside that bound; it is not exercised at its edge by anything in the tree today.

### The venue-behaviour finding

The narrow question the previous amendment's "a shut venue cannot fill" reasoning raises is whether letting the order through means assuming it will be accepted. It does not, on the evidence in the tree:

- **Alpaca's flatten is `time_in_force: 'ioc'`** (`server/pipeline/execution/adapters/alpaca-adapter.ts`'s `submitFlatten`) — immediate-or-cancel; it never rests.
- **Saxo's flatten is a `DayOrder`** (`server/pipeline/execution/adapters/saxo-adapter.ts`'s `submitFlatten`, `OrderDuration: { DurationType: 'DayOrder' }`, hard-coded regardless of `order.time_in_force`) — a duration shape that CAN rest/queue, unlike Alpaca's.
- **The simulated adapter is not evidence about either.** `server/pipeline/execution/simulated-adapter.ts`'s `submitFlatten` fills unconditionally through the injected cost model, with no calendar consult at all — it cannot refuse, queue, or reject, so it says nothing about what a real venue does after the bell; it only proves the code path runs.
- **Neither native adapter's response handling assumes acceptance.** Whatever comes back — filled, rejected, cancelled, expired, or a resting/queued acknowledgement — is already mapped generically into `BrokerAck.order_state` (`alpaca-order-normalization.ts`'s `mapOrderState`, `saxo-adapter.ts`'s `activityState`/`DEAD_STATES`), and a `submitFlatten` call that throws outright leaves the durable `flatten_submissions` row unresolved for reconciliation to settle, rather than resolving it to a guessed success (`execution/execute.ts`'s `executeExit`, the `submitFlatten` try/catch). This machinery predates #1388 and needed no change for it.

**Not determinable from the tree, and not guessed at:** whether a real Alpaca or Saxo submission a few seconds after the regular session actually fills, queues, or bounces synchronously. No adapter test exercises this, and finding out would mean calling a real venue, which this work deliberately did not do. `docs/research/43-saxo-openapi-order-idempotency.md` and `44-saxo-data-surface.md` were checked for a recorded observation — doc 43's SIM probes were run "out of hours so nothing could fill" (a `Limit` order far from market, never a post-close `DayOrder` at market), and doc 44 §2.8 records `AllowedTradingSessions: "Regular"` (no extended hours) and MOC/LOC algo strategies existing, but neither documents what happens to an ordinary `DayOrder` submitted in the seconds after `AutomatedTrading` ends. Neither doc is evidence on this specific question. The exemption does not depend on the answer — the execution layer already handles all three outcomes generically — but the answer itself remains an open gap, worth closing with a recorded (not live) observation if the paper venue ever produces one.

### Why not the alternative

**Leave gate 4 unconditional and instead speed up the Trader→Risk→Verdict pipeline** so it never crosses the bell. Rejected: it treats a symptom (latency) as if it were the defect, and no latency budget is zero — the next slow tick (a GC pause, a slow store write) reproduces #1388 again. The exemption instead makes the gate's own question ("can the venue still fill this") answerable by the venue, for an intent the Trader has already bounded to the same 5-minute window gate 1 relies on.

### What now holds by test

`flat-by-close-to-execution.test.ts` extends the #894 harness's `verdictDelayMs` option (already built for #1190's stale-`decided_at` case) to push the Verdict/Execution clock PAST `sessionEnd` — reproducing #1388's own ten-second gap — and asserts the flatten still reaches Execution, at both the US and LSE closes, driven through the real `VerdictImpl` (`buildVerdictStep`) and the real calendars. The same file asserts an entry intent evaluated after the close, through the same production wiring, still produces `market_closed`. `verdict/index.test.ts` asserts the exemption directly (mandatory flatten: `go`) and its narrowing (a discretionary exit without the marker: still `market_closed`), with a synthetic calendar, since the real calendars' arithmetic is what the end-to-end file exists to exercise.
