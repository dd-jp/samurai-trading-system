# Samurai postmortem — pitfalls to carry into the next system

**Status:** Written 2026-09-19, at David's instruction, reframing Samurai as a closed
experiment: *"samurai was a experiment to identify pitfalls and build a better system from
its learnings."* This document is the deliverable of that reframe — everything Samurai's
build actually taught, pulled from its own ADRs, issues and review reports, independent of
whether the next system keeps any of Samurai's design choices.

This is not a decision to stop running Samurai or to discard the code. It is the record of
what the experiment found, so the next system doesn't have to re-discover it the same way.

See `docs/v2-vision.md` for what gets built next.

---

## 1. The core mechanism was never validated before the system was built out around it

Samurai's entire architecture — Analysts → Debate → Trader → Risk → Verdict → Execution, six
stages, ~2900 tests — was built and iterated on for months on the premise that adversarial
LLM debate produces a usable trading signal. [#625](https://github.com/dd-jp/samurai-trading-system/issues/625)
(2026-08-09) measured it directly, late: **96 debates, 0 trades.** The stocks conviction
ceiling was 0.5478 against a 0.55 floor, and debate rounds moved conviction by exactly zero —
the mediator's own tie-break logic authorised a directional lean the debate itself never
produced ([#683](https://github.com/dd-jp/samurai-trading-system/issues/683)).

**Lesson:** build the smallest possible harness to test whether the core mechanism fires at
all — before the six-stage pipeline, the risk manager, the dashboard, the alerting, the
comment-standards passes. A system that cannot be shown to trade is not ready to have its
execution path hardened.

## 2. Silent time-window assumptions rot without anyone noticing

Two separate, structurally identical bugs, both in market-data windowing:

- **The Alpaca session calendar's fetch window** covers 30 days back from boot. A `1d`
  lookback asking for 30 in-session bars gets at most ~21 (weekends/holidays absorb the rest).
  The failover to Polygon shares the same calendar, so it inherits the same ceiling, and its
  own request-budget policy (`single-widest-retry`) can silently short-serve past that — no
  throw, `getADV()`'s denominator moves with a volume-skewed vendor's numbers sitting in the
  window, unflagged. Diagnosed 2026-09-16/17, not yet fixed as of this document.
- **[#362](https://github.com/dd-jp/samurai-trading-system/issues/362)** (2026-08-05): cold-start
  off-by-one — first tick fetches `lookback` bars, drops the in-progress one, fails the
  underfetch guard. Same species of bug, found and fixed six weeks earlier.

**Lesson:** every component that reasons about "N bars/days back" needs an explicit,
tested coverage invariant — not an assumption that a fetched table or a raw payload covers
what a caller asks for. This class of bug is cheap to introduce and expensive to notice,
because it degrades (short window, wrong denominator) rather than crashes.

## 3. The single most important invariant (flat-by-close) depended on uptime the system couldn't guarantee

ADR-0014 declared flat-by-close "an invariant with no exception case." It was implemented as
a tick-evaluated rule with no independent session-end job — meaning if the process isn't
running when the window opens, nothing flattens, and nothing else in the system notices
until a lot is found still open, hours later.

- [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) (2026-09-08): **7 control
  lots** carried overnight on a 3× leveraged ETP — the single worst outcome the intraday
  thesis names — because the flatten window was forward-only and a tick landing one instant
  past the bell missed it entirely, with no flatten intent ever produced.
- The 2026-09-16/17 NFLX incident (this session's own triage) repeated the shape after the
  post-close grace fix (#1389's remedy) had already shipped: the reporting alert exists now,
  but the underlying condition — "no tick running = no flatten, full stop" — is unchanged,
  and the timing evidence points at the process being down across the whole close-plus-grace
  window.
- [#921](https://github.com/dd-jp/samurai-trading-system/issues/921): a flatten that
  *executed at the venue* was lost by the system's own bookkeeping — the store stayed long
  and the dedup gate blocked every retry. A second, independent way to end up carrying a lot
  the venue itself had already closed.

**Lesson:** an invariant that depends on a process being alive at a specific instant is not
an invariant, it's a hope. If a future system has any time-triggered mandatory action
(flatten, stop-renewal, margin check), it needs either a scheduler that survives process
death (external cron / watchdog) or the invariant needs restating as something the venue
itself enforces (a resting order), not something a live process must remember to send.

## 4. Decisions kept re-opening after being "decided"

The same handful of parameters were amended repeatedly, each time through a full grilling
cycle: the capital split (£750/£750 → dropped-crypto → £1,000 rebased — ADR-0015, three
amendments), the venue (Trading 212 → disqualified → Saxo — ADR-0015 again), the drawdown
tolerance (~20-25% band → corrected to 26.2%/41.8%, twice, #729 then #798), the exit
geometry (tranche ladder → measured and rejected, #708). None of these were wrong to revisit
— each amendment was a real correction — but the *pattern* (six ADR amendments across two
core ADRs in five weeks) says the initial commitments were made on less information than the
decision actually needed.

**Lesson:** for a small number of genuinely load-bearing parameters (capital, venue,
universe, risk tolerance), spend more grilling time up front, or explicitly flag them as
provisional-pending-a-named-follow-up rather than "Accepted."

## 5. Process debt accumulated quietly and eventually needed its own dedicated cleanup passes

Multiple commits in September 2026 exist solely to strip narration comments that had
accumulated across many sessions — 62 lines from one CI file alone (`effde735`), then three
more "trim overstated comments" waves across 100+ files. Separately, a September 2026 design
review (`docs/reviews/codebase-design-2026-09-15.md`) found the composition root had grown to
4,383 lines constructing the same store types two and three times, and the Debate stage —
arguably the one component the entire edge thesis rests on — had no module interface and one
adapter living in the orchestrator.

**Lesson:** the parts of the system closest to the stated edge thesis (Debate, in Samurai's
case) deserve module-boundary discipline *earliest*, not latest — they're the part most
likely to be rewritten if the thesis needs revising, and the least affordable place to carry
architectural debt.

## 6. The validation math was honest, and that made the timeline the real constraint

ADR-0017 is worth crediting rather than filing as a pitfall: it caught its own trap before
shipping it. A profitable 14-day paper run against a ~55% win-rate claim has ~29% power to
distinguish real edge from a coin flip, and a ~50% chance of looking profitable with zero
real edge. Splitting Gate 1 (mechanics, 14 days) from Gate 2 (expectancy, ~126 trades, ~3
months) was correct. What it exposed: at ≤2 entry decisions per name per session,
equities-only, ~126 trades is a multi-month commitment before the core question can be
answered at all — and #625 (zero trades in 96 debates) meant that clock hadn't even started
by the time crypto was dropped and the book was re-based.

**Lesson:** state the sample-size arithmetic for "how would we know this worked" *before*
committing to an instrument universe and entry-window policy that determines how many trades
per month are even possible. The next system's validation clock should start running as
early as possible, not be gated behind five ADR amendments and a conviction-floor bug.

---

## Summary table

| # | Pitfall | Evidence | Carries to system 2 as |
|---|---|---|---|
| 1 | Core mechanism unvalidated before full build-out | #625 (0/96 trades) | Validate the signal-generation mechanism standalone, first |
| 2 | Silent time-window / coverage assumptions | UBER calendar bug (2026-09-16), #362 | Explicit, tested coverage invariants on every windowed read |
| 3 | Time-triggered invariant depends on process uptime | #1389 (7 lots), NFLX (2026-09-16/17), #921 | Venue-enforced or watchdog-backed, not tick-dependent |
| 4 | Core parameters repeatedly re-decided | 3× ADR-0015 amendments, 2× drawdown correction | Front-load grilling on capital/venue/universe/risk before Accepted |
| 5 | Architectural debt concentrated on the edge-thesis component | codebase-design-2026-09-15.md (Debate: no interface) | Module-boundary discipline earliest on the highest-conviction component |
| 6 | Validation sample-size math arrives late relative to universe/window decisions | ADR-0017 (~126 trades, ~3 months) | State the "how would we know" arithmetic before locking instrument/window scope |
