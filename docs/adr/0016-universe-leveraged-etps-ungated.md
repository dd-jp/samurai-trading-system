# ADR-0016 — Universe: LSE leveraged ETPs selected as movers, and the debate is not catalyst-gated

- **Status:** Accepted
- **Date:** 2026-08-09
- **Decided by:** David — universe objective on [#635](https://github.com/dd-jp/samurai-trading-system/issues/635), gating on [#658](https://github.com/dd-jp/samurai-trading-system/issues/658)
- **Related:** [#655](https://github.com/dd-jp/samurai-trading-system/issues/655) (holds the falsifiable bar for revisiting gating), [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) (can overturn the instrument choice), [`docs/research/18-intraday-instrument-physics.md`](../research/18-intraday-instrument-physics.md)
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

Verified tradeable inside the T212 ISA behind an FCA complex-products appropriateness questionnaire.

**Leverage does not improve the odds** — this is the part that is easy to get wrong. Break-even win rate stays at ~47% because leverage scales gains and losses alike. What it does is **enlarge each win against a fixed-percentage cost**, which is decisive when trade count is capped near one per day: 3USL's observed 0.18% round trip against 3× the base range lifts equity-leg expectancy from **+0.063% to +0.195%/trade** (16.3%/yr to 50.7%/yr).

**Daily-reset decay does not apply.** It punishes *holding* leveraged ETPs across sessions; a flat-by-close strategy never holds one overnight ([ADR-0014](0014-intraday-flat-by-close-horizon.md)).

## Decision 2 — the debate is **not catalyst-gated**

Gating was proposed to fix a cost problem. Measurement shows the problem does not exist, and that gating would not fix it if it did.

**The cost premise was a 3.4× overestimate.** #658 built on ADR-0008's *estimated* $3.0/day. The soak's actual `llm_spend` measures **$0.878/day = £252/yr**, falling to **£89/yr** once [#617](https://github.com/dd-jp/samurai-trading-system/issues/617) lands. Corrected, the book is **+£139/yr** with crypto at base fees and **+£729/yr** with the fee lever pulled — not the −£237/yr the ticket claimed.

**Gating aims at the wrong 14%.** Post-#617 the intraday shape is **48 crypto runs/day against 8 equity runs — crypto is 86% of the bill**, runs 24/7, and has no dividend or earnings calendar to gate against. The equity leg is the other 14% — **~£12/yr of the £89 bill in total** — and gating it to 3-of-5 days removes only two fifths of that, so it saves ~**£5/yr**.

**And gating is not free.** It removes trading days, so it removes gross edge with them. Cutting 252 equity trades to 156 costs ~**£141/yr of gross** to save ~£5/yr of spend — a 28:1 loss.

### The bar for revisiting

Gating is an **expectancy** question, not a cost question. It pays only if catalyst days are genuinely better:

```
156·e_c·750 − 85  ≥  369 − 89     ⇒     e_c ≥ 0.312%
```

**Catalyst days must deliver ≥ 0.312%/trade against the 0.195% all-day average — a 60% expectancy uplift.** Held by [#655](https://github.com/dd-jp/samurai-trading-system/issues/655). If the event study clears it, gate and reopen #658; if not, the universe trades every day the selector finds a setup.

## Consequences

**Ranked levers on the book's economics, by measured value:**

1. **The crypto fee tier** — £0 → £590/yr ([#671](https://github.com/dd-jp/samurai-trading-system/issues/671))
2. **#617** — £252 → £89/yr
3. **Catalyst-gating** — ~£5/yr, and likely net negative

Anything proposing to improve the economics should be checked against this ordering first.

**Single-name concentration is now the norm, not a risk to be diversified away.** The Risk Manager's correlation and concentration limits were specced against a diversified basket and need re-reading against a universe deliberately chosen for co-movement.

## Known weakness

**The entire leveraged-ETP case rests on one observed 0.18% spread quote for 3USL.** [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) must measure it on the T212 demo API and is explicitly permitted to overturn this ADR. If the real spread is materially wider, the expectancy uplift that justifies leverage disappears.

**No free LSE intraday history exists** ([#656](https://github.com/dd-jp/samurai-trading-system/issues/656)), so the measurements above use US instruments as proxies for the underlying. They characterise the *underlying's* physics, not the LSE ETP's own tape.
