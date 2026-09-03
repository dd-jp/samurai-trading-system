# ADR-0016 — Universe: LSE leveraged ETPs selected as movers, and the debate is not catalyst-gated

- **Status:** Accepted
- **Date:** 2026-08-09
- **Decided by:** David — universe objective on [#635](https://github.com/dd-jp/samurai-trading-system/issues/635), gating on [#658](https://github.com/dd-jp/samurai-trading-system/issues/658)
- **Related:** [#915](https://github.com/dd-jp/samurai-trading-system/issues/915) (holds the falsifiable bar for revisiting gating — #655 closed 2026-08-26 on a *declared* trial, not a measured answer; #915 runs the measurement), [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) (measured per-instrument round-trip cost gates this; [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) would have delivered it but closed 2026-08-27 out of scope without doing so), [`docs/research/18-intraday-instrument-physics.md`](../research/18-intraday-instrument-physics.md)
- **Builds on:** [ADR-0014](0014-intraday-flat-by-close-horizon.md), [ADR-0015](0015-live-venue-account-and-book-split.md)

## Context

Two open questions had been carried since doc 10: what the universe is *for*, and whether the debate should run only on catalyst days to control cost. Both were argued from assumptions. Both are now measured.

## Decision 1 — the universe objective is **movers**, on measured physics

Doc 10's diversified low-correlation basket maximises *effective bets*. Under an intraday take-profit that is the **opposite** of what the strategy needs: diversification suppresses exactly the volatility the strategy consumes.

Measured over two years of daily bars — the frequency with which each instrument reaches a given gain above its own open:

| instrument | reaches +1% | drops −0.5% |
| --- | --- | --- |
| SPY | **9.8%** of days | 45.5% |
| FTSE tracker | 8.4% | ~45% |
| gold | 13.0% | ~45% |

**A broad index tracker cannot support an intraday +1% take-profit at all.** It reaches the target on fewer than one day in ten while hitting the stop on nearly half.

### So the equity universe is **LSE-listed leveraged index ETPs plus commodity ETCs**

Tradeable via Saxo Capital Markets UK, a GIA (not an ISA), which confirms electronic (not desk-only) tradeability over its OpenAPI for all three named instruments (3USL, 3UKL, an oil ETC) — [ADR-0015](0015-live-venue-account-and-book-split.md)'s 2026-08-30 amendment.

> **Updated 2026-09-02 — venue re-framed for Saxo/GIA (docs subset of [#946](https://github.com/dd-jp/samurai-trading-system/issues/946)).** This line previously read "Verified tradeable inside the T212 ISA behind an FCA complex-products appropriateness questionnaire" — T212 was ruled out as the venue (#896, #912) and Saxo/GIA adopted instead, map [#905](https://github.com/dd-jp/samurai-trading-system/issues/905). The FCA complex-products appropriateness questionnaire was a T212-specific detail; neither ADR-0015 nor map #905 records whether an equivalent gate applies under Saxo, so it is dropped rather than mechanically swapped to "Saxo."

**Leverage does not improve the odds** — this is the part that is easy to get wrong. Break-even win rate stays at ~47% because leverage scales gains and losses alike. What it does is **enlarge each win against a fixed-percentage cost**, which is decisive when trade count is capped near one per day: 3USL's observed 0.18% round trip against 3× the base range lifts equity-leg expectancy from **+0.063% to +0.195%/trade** (16.3%/yr to 50.7%/yr).

> **Corrected 2026-08-10 — the paragraph above is wrong in sign.** See the amendment at the foot of this ADR. The cost is **not** fixed across the leverage step: SPY's round trip is 0.003% against 3USL's 0.18%, so leverage multiplies the gross move by 3 and the cost by 60. Measured over 10.6 years the 3× figure is **−0.135%/trade**, not +0.195%. **The universe decision stands; the profitability claim does not.**

**Daily-reset decay does not apply.** It punishes *holding* leveraged ETPs across sessions; a flat-by-close strategy never holds one overnight ([ADR-0014](0014-intraday-flat-by-close-horizon.md)).

## Decision 2 — the debate is **not catalyst-gated**

Gating was proposed to fix a cost problem. Measurement shows the problem does not exist, and that gating would not fix it if it did.

**The cost premise was a 3.4× overestimate.** #658 built on ADR-0008's *estimated* $3.0/day. The soak's actual `llm_spend` measures **$0.878/day = £252/yr**, falling to **£89/yr** once [#617](https://github.com/dd-jp/samurai-trading-system/issues/617) lands. Corrected, the book is **+£139/yr** with crypto at base fees and **+£729/yr** with the fee lever pulled — not the −£237/yr the ticket claimed.

**Gating aims at the wrong 14%.** Post-#617 the intraday shape is **48 crypto runs/day against 8 equity runs — crypto is 86% of the bill**, runs 24/7, and has no dividend or earnings calendar to gate against. The equity leg is the other 14% — **~£12/yr of the £89 bill in total** — and gating it to 3-of-5 days removes only two fifths of that, so it saves ~**£5/yr**.

**And gating is not free.** It removes trading days, so it removes gross edge with them. Cutting 252 equity trades to 156 costs ~**£141/yr of gross** to save ~£5/yr of spend — a 28:1 loss.

> **Superseded 2026-08-18 — every cost figure in the three paragraphs above is withdrawn.** See the amendment at the foot of this ADR. The `£252`/`£89` bill, the `+£139`/`+£729` book, the `~£12`/`~£5` equity-leg pair and the `~£141`-of-gross-against-£5 comparison behind the **28:1** loss are each a 15-minute-cadence, crypto-in-scope number, and crypto left Samurai's scope on 2026-08-16 ([ADR-0015](0015-live-venue-account-and-book-split.md)'s amendment); the `£141` term is additionally `96 × +0.195%/trade`, voided above. Rebuilt equities-only the bill is **~£58/yr** (`docs/research/54-capital-economics-vs-signal-accuracy.md`), and post-[#617](https://github.com/dd-jp/samurai-trading-system/issues/617) debate spend is **per debate run**, so a gate scales the trading term and the bill together and the 28:1 comparison has no fixed terms left. **Kept for provenance, not for use. Decision 2 itself is unchanged** and now rests on the #685 event-day measurement recorded below.

### The bar for revisiting

Gating is an **expectancy** question, not a cost question. It pays only if catalyst days are genuinely better:

```
156·e_c·750 − 85  ≥  369 − 89     ⇒     e_c ≥ 0.312%
```

**Catalyst days must deliver ≥ 0.312%/trade against the 0.195% all-day average — a 60% expectancy uplift.** Held by [#655](https://github.com/dd-jp/samurai-trading-system/issues/655). **Withdrawn 2026-08-18 — see the amendment at the foot of this ADR; the replacement bar is an accuracy threshold, not an uplift.** If the event study clears it, gate and reopen #658; if not, the universe trades every day the selector finds a setup.

> **Restated 2026-08-10.** The 0.312% bar and the £369 term in it both derive from the 0.195%/trade figure the amendment below voids, so **the arithmetic in this block no longer computes** — it is kept for provenance, not for use. **The decision it supports is unchanged and now rests on direct measurement instead**: earnings-reaction sessions are 1.0378%/trade *worse* than ordinary ones (t = −2.99) and are 1.62% of sessions (re-measured 2026-08-18 by [#685](https://github.com/dd-jp/samurai-trading-system/issues/685); previously 0.92%/trade, t = −2.66, 1.73%). The bar #655 must clear is now stated relative to whatever the entry signal delivers, not to a fixed all-day constant. **Sharpened 2026-08-18: because that anchor is *negative* at the declared brackets, the bar is not a relative uplift at all — it is an absolute accuracy threshold, and the gating question is a comparison of two accuracies. See the amendment at the foot of this ADR.**

## Consequences

**Ranked levers on the book's economics, by measured value:**

1. **The crypto fee schedule** — £0 → **£1,140–1,660/yr** ([#671](https://github.com/dd-jp/samurai-trading-system/issues/671), measured; the range is the crypto calendar, [#667](https://github.com/dd-jp/samurai-trading-system/issues/667)). The earlier £590 figure used 130 trades/yr, below ADR-0014's recorded floor of one crypto trade per day. **The ordering is unchanged and the gap widens.**
2. **#617** — £252 → £89/yr
3. **Catalyst-gating** — ~£5/yr, and likely net negative

Anything proposing to improve the economics should be checked against this ordering first.

> **Superseded 2026-08-18 — the whole ranking is crypto-era and its figures are withdrawn.** Lever 1 is a
> **crypto** fee schedule and crypto left Samurai's scope on 2026-08-16 ([ADR-0015](0015-live-venue-account-and-book-split.md)'s
> amendment), so the largest lever no longer exists for this system; levers 2 and 3 (`£252 → £89/yr`, `~£5/yr`)
> are 15-minute-cadence, crypto-in-scope numbers. The equities-only bill is **~£58/yr** in total
> (`docs/research/54-capital-economics-vs-signal-accuracy.md`), which is worth **~0.55 pp** of accuracy at
> £1,000 of position notional — but **1.58 pp on the index bracket at the £350 position notional D5 resolves
> to** out of the £1,000 book, over half QQQ's 2.96 pp geometry bar, so it is second-order only at the larger
> illustrative notional. **On the equities-only book the
> economics are governed by the entry signal's accuracy, not by any lever in this list.** Kept for provenance.

**Single-name concentration is now the norm, not a risk to be diversified away.** The Risk Manager's correlation and concentration limits were specced against a diversified basket and need re-reading against a universe deliberately chosen for co-movement.

## Known weakness

**The entire leveraged-ETP case rests on one observed 0.18% spread quote for 3USL.** [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) was closed 2026-08-27 as out of scope, following the T212-to-Saxo venue pivot, without ever delivering this spread measurement — it named the T212 demo API as the measurement source, and that venue no longer runs this strategy. [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) (measured round-trip cost, ascending, per pool line) now gates on this measurement rather than performing it — no open ticket currently delivers a per-instrument spread on any live venue. If the real spread is materially wider than 0.18%, the expectancy uplift that justifies leverage still disappears; that question remains open, not answered.

**No free LSE intraday history exists** ([#656](https://github.com/dd-jp/samurai-trading-system/issues/656)), so the measurements above use US instruments as proxies for the underlying. They characterise the *underlying's* physics, not the LSE ETP's own tape.

## Amendment, 2026-08-10 — the leverage economics, measured ([#653](https://github.com/dd-jp/samurai-trading-system/issues/653))

Decision 1's reach rates were measured; its **expectancy** was inferred from them rather than simulated. Simulating the exit rule inverts the sign. Working and method in [`docs/research/18-intraday-instrument-physics.md`](../research/18-intraday-instrument-physics.md) Result 4, script `18-threshold-study.py`.

**Reach rates reproduce over 10.6 years.** SPY at +1%/−0.5%: take-profit first 11.6%, stop first 37.6%, closed out 50.9%, against the 9.8%/45.5% measured here over 2 years.

**Expectancy does not.**

| | this ADR claimed | measured, 2016-01-04 → 2026-07-31 |
| --- | --- | --- |
| SPY 1×, +1/−0.5, cost 0.003% | +0.063%/trade | **+0.0119%** |
| 3× index ETP, +3/−1.5, cost 0.18% | **+0.195%/trade** | **−0.135%** |
| 3× single-stock ETP (TSLA), best of 6, cost 0.41% | — | **−0.463%** |

**Every threshold pair tested is negative** — six configurations, two instruments, in-sample and out. No take-profit/stop pair rescues an unconditionally-entered position.

### What survives, and what does not

**Survives — Decision 1's universe choice.** A broad tracker still cannot reach an intraday take-profit; leveraged ETPs still can. The universe is unchanged.

**Survives — Decision 2, and it is now better supported.** Event-conditioned levels were tested directly: earnings-reaction sessions are **−1.0378%/trade worse** than ordinary sessions (t = −2.99), and they are **1.62% of sessions**, so conditioning on them cannot move the blended result regardless of sign. (Re-measured 2026-08-18 by [#685](https://github.com/dd-jp/samurai-trading-system/issues/685) — previously −0.92%/trade at t = −2.66 over 1.73% of sessions; sign and significance both survived, and the smaller share makes the structural argument stronger.) Catalyst gating remains rejected, now on measurement rather than cost arithmetic. The 0.312%/trade bar held by [#655](https://github.com/dd-jp/samurai-trading-system/issues/655) stands, and this evidence makes it harder to clear, not easier. *(Superseded 2026-08-18 — the 0.312% figure is withdrawn with the rest of the +0.195% family; #655 now holds an accuracy-threshold bar instead. This sentence's substantive claim — that the event-day measurement makes gating harder to justify — is unaffected. See the amendment below.)*

**Does not survive — "the equity leg returns 50.7%/yr".** Any figure downstream of +0.195%/trade is void. That includes the £/yr equity numbers this ADR and [#658](https://github.com/dd-jp/samurai-trading-system/issues/658) used to rank levers. The **ordering** of the levers is unaffected — the crypto fee schedule was and remains the largest — but the equity leg's contribution is not a positive constant.

### The consequence that matters

The measurement replaces a profit claim with **a bar the entry signal must clear**:

| instrument class | round trip | signal must add over a random open-entry |
| --- | --- | --- |
| 3× index ETP | 0.18% | **≥ +0.135%/trade** |
| 3× single-stock ETP | 0.41% | **≥ +0.463%/trade** |

This is the first falsifiable statement of what the debate layer has to be worth. It is also why [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) is now the critical path: a system that has produced zero trades has never been measured against it.

**Not overturned by this amendment:** the universe, the no-gating decision, and the venue/account constraints of [ADR-0015](0015-live-venue-account-and-book-split.md) (now Saxo GIA, not T212 ISA — see the 2026-08-30 amendment). **Still open:** real LSE ETP spreads per subclass have not been measured on any live venue — the 0.18% and 0.41% figures are each a single quote, and both bars move directly with them. [#666](https://github.com/dd-jp/samurai-trading-system/issues/666), which would have measured this on the T212 demo API, closed 2026-08-27 out of scope without delivering it; [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) now gates on this measurement rather than performing it — no open ticket currently delivers it.

## Amendment, 2026-08-18 — the revisit bar is rehomed, and it changes shape ([#840](https://github.com/dd-jp/samurai-trading-system/issues/840))

**Decision 1 and Decision 2 both stand. What is withdrawn is the *form* of the bar for revisiting Decision 2**, which this ADR twice records #655 as holding.

`docs/research/54-capital-economics-vs-signal-accuracy.md` restates #658's capital arithmetic against [`52-exit-geometry-and-subclass-odds.md`](../research/52-exit-geometry-and-subclass-odds.md)'s simulated per-trade expectancy, in place of the `+0.195%/trade` the 2026-08-10 amendment voided. Three consequences for this ADR:

1. **The `≥ 0.312%/trade` bar is withdrawn, not merely uncomputable.** Both of its terms — the `0.195%` all-day anchor and the `£369`/`£89`/`£85` cost terms — are gone: the first with the +0.195% family, the second because every one of those cost figures is a 15-minute-cadence, crypto-in-scope number and crypto left scope on 2026-08-16 ([ADR-0015](0015-live-venue-account-and-book-split.md)'s amendment). Rebuilt equities-only from the measured `$0.0060`/debate run at the 1h debate bar, the bill is **~£58/yr**. *(2026-09-03, [#969](https://github.com/dd-jp/samurai-trading-system/issues/969): that £58 is the **debate leg only**. With `SAMURAI_SENTIMENT_RETRIEVAL=on` the market-intelligence leg adds roughly **£111/yr** on the 7-underlying live pool at 3 search results (4 session-derived two-hour buckets x 252 sessions), because a retrieving `x_search` call carries its results in the prompt — so the total bill roughly **triples**, to ~£169/yr. (On the 20-name *paper* universe the same leg is ~$16 per soak and outweighs the debate leg outright; see ADR-0008 §2.) Doc 54 §3's amendment and [ADR-0008](0008-llm-spend-cap.md) §2's carry the arithmetic; the accuracy thresholds in point 2 below are computed against the £58 bill and must be recomputed before being quoted for a universe running retrieval.)*

2. **The replacement is an accuracy threshold, because the anchor is negative.** At the declared brackets, out of sample, per-trade `E_net` is negative on all seven measured underlyings, so there is no positive average for a percentage uplift to be taken over. Break-even is `50% + bar`: **51.29% (PLTR) to 57.16% (MSTR)**, ~53.51% on QQQ at £1,000 of position notional. The revisit condition is correspondingly a **comparison of two accuracies** — is directional accuracy higher on catalyst days than on all days? — rather than a cost trade.

3. **Decision 2's cost arithmetic is superseded; Decision 2 is not.** The "28:1", the "gating aims at the wrong 14%", and the £141-against-£5 comparison are all void — post-[#617](https://github.com/dd-jp/samurai-trading-system/issues/617) debate spend is per debate run, so a gate scales the trading term and the bill together and the comparison has no fixed terms left. **Decision 2 rests on the #685 event-day measurement instead**, which is independent of cost and is recorded above.

**#655 continues to hold the revisit bar** in its new form, so the citations at the head of this ADR and in Decision 2 remain live. Doc 52's 126 trials are inherited by any figure above; nothing here is selected or adopted.

## Amendment, 2026-08-26 — the revisit bar moves from #655 to #915 ([#655](https://github.com/dd-jp/samurai-trading-system/issues/655))

**#655 is closed.** It resolved by *declaring* the trial this ADR's revisit bar tests — David named FOMC/CPI/NFP, pooled as one family statistic, index subclass only — rather than by measuring an answer. The declaration is final; the measurement is not, and #655 does not run it.

**[#915](https://github.com/dd-jp/samurai-trading-system/issues/915) now holds the revisit bar.** It carries the declared trial's full constraints (family, population, subclass, statistic, bracket, pooling unit) and runs the FOMC/CPI/NFP event-study against them. The citations at the head of this ADR and in Decision 2 that name #655 as the live holder are superseded by this amendment; read them as pointing at #915.

## Amendment, 2026-08-26 — the revisit bar was run; it does not clear ([#915](https://github.com/dd-jp/samurai-trading-system/issues/915))

**Decision 2 stands, on a completed measurement rather than a declared bar.** Full result: [`docs/research/55-fomc-cpi-nfp-event-study.md`](../research/55-fomc-cpi-nfp-event-study.md).

- **FOMC is structurally excluded, not measured.** Every one of the 84 scheduled FOMC decisions, 2016–2026, releases at 14:00 ET — after ADR-0018 D3's bracket has already flattened. There is no session in this system's exposure window where an FOMC decision lands, so `p_catalyst` for FOMC does not exist. This holds for as long as the flatten stays where D3 put it, independent of sample size.
- **CPI/NFP, pooled (SPY+QQQ, 264 event-days, 2016–2026): a positive point estimate that does not clear.** `p_catalyst` = 57.34% vs `p_all-day` = 52.51%, delta +4.82pp. Correlation-adjusted for ρ(SPY,QQQ) = 0.883 (the naive independent-N estimate overstates power by ~2×), t = 1.54 — below the conventional 95% threshold. The measurement cannot distinguish this delta from noise.
- **The declared family narrowed under measurement**, from "FOMC/CPI/NFP pooled as one statistic" to "CPI/NFP pooled, FOMC void" — confirmed by David on [#658](https://github.com/dd-jp/samurai-trading-system/issues/658) ("withdraw (a), let #915 decide") as the legitimate reading of his #655 declaration.

**Catalyst gating remains rejected.** The universe trades every day the selector finds a setup, per this ADR's original fallback. Nothing here rules out a future revisit if the sample grows (264 event-days is the full 2016–2026 population, not a selection) or if the exit rule's flatten timing changes.
