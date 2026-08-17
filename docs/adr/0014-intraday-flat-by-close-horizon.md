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
