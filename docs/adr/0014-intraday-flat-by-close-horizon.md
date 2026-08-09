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

## Stated open risk

The recorded thesis rests on a selector with **no observed win rate**. [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) measured 96 debates and 0 trades — the stocks conviction ceiling was 0.5478 against a 0.55 floor, and debate rounds moved conviction by zero. Adopting (a) does not make that evidence exist; it makes producing it the next blocking task.

Related: [#552](https://github.com/dd-jp/samurai-trading-system/issues/552) moves onto the critical path, because (a) makes news and sentiment *the edge* while the MI store currently ingests `[]` on every refresh.
