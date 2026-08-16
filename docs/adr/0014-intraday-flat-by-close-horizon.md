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

## Amendment — 2026-08-16: the crypto trade per day is suspended, not withdrawn

- **Amends:** the Context clause at line 13 — *"at least one equity and one crypto trade per day"*
- **Earned by:** [#705](https://github.com/dd-jp/samurai-trading-system/issues/705), grilled and resolved 2026-08-16 under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703)
- **Decided by:** David — *"start with all equity first, and then we'll implement crypto, make crypto a placeholder for future"*
- **Companion amendment:** [ADR-0017](0017-validation-gates-paper-operational-thesis-expectancy.md)

**Crypto is removed from the tick loop in both production and paper.** The equity leg is built, soaked and taken live first.

### Why this needs an amendment at all

The one-crypto-trade-per-day clause is not a passing remark in this ADR — **it is the requirement that broke the three-thesis deadlock.** Thesis (a) was adopted over docs 10/11/12 because it was the only intraday-shaped thesis, and the intraday shape was defined with a crypto trade in it. Removing crypto silently would leave the running code contradicting the record that selected the thesis.

**The requirement is suspended, not withdrawn, and thesis (a)'s adoption rationale is unaffected.** (a) was selected for being intraday-shaped; the equity leg is still intraday-shaped. Suspension narrows the requirement's scope. It does not reopen the selection between theses, and this amendment must not be read as doing so.

### This goes further than ADR-0017 sequenced, deliberately

ADR-0017's ramp already puts equity live first — it says *"Crypto stays in paper until the full £750 can deploy at once."* What it does **not** do is stop crypto ticking in paper. This amendment does, and the excess is recorded rather than left to read as compliance. Three reasons, the first binding:

1. **Spend.** Post-[#617](https://github.com/dd-jp/samurai-trading-system/issues/617) the intraday shape is 48 crypto runs/day against 8 equity runs — **crypto is ~86% of the LLM bill.** Parking it in paper frees that budget for the equity soak, which is the leg actually being built.
2. **A crypto arm would contaminate the soak's primary output.** Gate 1's headline result is a **nonzero equity trade count**, still unproven. A soak in which 86% of debates are crypto reports a healthy-looking aggregate while the number that matters stays unmeasured.
3. **Crypto currently has no exit rule.** [#667](https://github.com/dd-jp/samurai-trading-system/issues/667) resolved that crypto has no time flatten — the rule cannot apply to a 24/7 venue, and the reason flat-by-close exists (a closed market cannot fill a stop) does not hold there. Crypto's exit is held instead by the venue-side stop and the profit ladder, and the ladder does not exist yet. Soaking crypto now would soak an incomplete strategy.

### The price, recorded rather than argued away

- **[ADR-0016](0016-universe-leveraged-etps-ungated.md)'s #1 measured lever is deliberately unpulled**: the crypto fee schedule, **£0 → £1,140–1,660/yr** — the largest item on the book's economics, ahead of #617 (£252 → £89/yr) and catalyst-gating (~£5/yr, likely net negative).
- [ADR-0015](0015-live-venue-account-and-book-split.md)'s **£750 crypto allocation is idle** for the duration.
- [#671](https://github.com/dd-jp/samurai-trading-system/issues/671)'s exchange/fee verdict and [#673](https://github.com/dd-jp/samurai-trading-system/issues/673)'s stake decision sit unexercised; #667's fee-tier day count does not accrue.
- **No crypto paper history accumulates while parked.** The day crypto unparks, that leg starts its soak from zero rather than resuming one. This was the strongest argument available against the decision and is recorded as its cost.

### The unpark gate

**Crypto must not be unparked until a working exit rule exists** — per #667, the venue-side stop plus the profit ladder. Unparked earlier, the crypto leg would run with the time flatten deliberately disabled and nothing put in its place.

The gate is satisfied by **a working exit rule, not specifically by the tranche form**: the neutral single bracket plus a venue-side stop meets #667's requirement. Stated explicitly so the gate is not misread as blocking on the ladder-vector measurement in [#708](https://github.com/dd-jp/samurai-trading-system/issues/708).

### What stays in the codebase, inert

`AssetClass`, `AlwaysOpenCalendar`, `sessionCalendars` and the crypto config keys **stay**. They cost nothing inert, and `AlwaysOpenCalendar`'s `sessionEnd → null` **is #667's ruling enforced by the type system** — deleting it would discard a resolved decision and invite a later session to re-derive it wrongly. `yarn smoke` keeps BTC-USD explicitly, so the smoke gate still exercises the crypto path and still distinguishes a closed session from a no-trade run.

## Stated open risk

The recorded thesis rests on a selector with **no observed win rate**. [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) measured 96 debates and 0 trades — the stocks conviction ceiling was 0.5478 against a 0.55 floor, and debate rounds moved conviction by zero. Adopting (a) does not make that evidence exist; it makes producing it the next blocking task.

Related: [#552](https://github.com/dd-jp/samurai-trading-system/issues/552) moves onto the critical path, because (a) makes news and sentiment *the edge* while the MI store currently ingests `[]` on every refresh.
