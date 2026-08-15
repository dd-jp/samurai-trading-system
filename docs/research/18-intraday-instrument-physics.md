# 18 — Intraday instrument physics: what an instrument must do to support a same-day take-profit

**Produced:** 2026-08-09, resolving [#635](https://github.com/dd-jp/samurai-trading-system/issues/635) and informing [#657](https://github.com/dd-jp/samurai-trading-system/issues/657), under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631).
**Feeds:** [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md).
**Supersedes on horizon:** doc 10's diversified-basket universe (see [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)).

The universe question had been argued from doc 10's *effective bets* framing since the beginning. Under an intraday take-profit it is answerable from data, and the answer inverts the framing.

## Result 1 — a broad tracker cannot reach an intraday take-profit

Two years of daily bars (2024-08-01 → 2026-08-01, Alpaca SIP). For a long entered at the open, how often does the instrument reach a given gain above that open, and how often does it drop −0.5% first?

| instrument | reaches +1% | drops −0.5% |
| --- | --- | --- |
| SPY | **9.8%** of days | 45.5% |
| FTSE tracker (EWU) | 8.4% | ~45% |
| gold (GLD) | 13.0% | ~45% |

**A broad index tracker reaches +1% on fewer than one day in ten while hitting the stop on nearly half.** No entry timing repairs that: it is the instrument's physics, not the signal's quality.

### The consequence for universe design

Doc 10's low-correlation basket maximises effective bets, which under a same-day take-profit is **the opposite of what is needed** — diversification suppresses precisely the volatility the strategy consumes. The objective is **movers**.

## Result 2 — leverage does not improve the odds, it improves the economics

This is the part most easily misread. Leverage scales gains and losses alike, so the **break-even win rate stays at ~47%**. What changes is the ratio of gain to a *fixed-percentage* cost:

| | base | 3× ETP |
| --- | --- | --- |
| expectancy per trade | +0.063% | **+0.195%** |
| annualised | 16.3% | **50.7%** |

3USL's observed 0.18% round trip against 3× the base range is what produces the lift. This matters specifically because trade count is capped near one per day — with unlimited trades you would prefer more trades to bigger ones.

**Daily-reset decay does not apply.** It punishes *holding* leveraged ETPs across sessions; a flat-by-close strategy never holds one overnight.

> **Superseded 2026-08-10 by Result 4.** The table above is wrong in sign at 3×. Its error is the phrase *"fixed-percentage cost"* — the cost is not fixed across the leverage step. Keep reading for the measurement that replaces it.

## Result 4 — the same test run properly: every threshold pair is negative on unconditional entry

Produced 2026-08-10 for [#653](https://github.com/dd-jp/samurai-trading-system/issues/653), which asked whether thresholds should be fitted per-instrument or pooled, and whether event-conditioned levels beat pooled ones. Answering it required simulating the exit rule rather than counting reach rates, and that inverted Result 2.

**Method.** Enter long at the session open, exit on the first of take-profit, stop, or the close. Underlying US tape scaled by the ETP leverage factor — intraday a 3× ETP tracks 3× the underlying's move from the daily reset, with no path dependency inside one session. Alpaca SIP, **2016-01-04 → 2026-07-31**, regular hours only: SPY 5-minute (2,659 sessions), TSLA **1-minute, 1.92M bars** (2,657 sessions). In-sample ≤2022, out-of-sample ≥2023. Where a single bar spans both levels the **stop is assumed to fill first**; at 5-minute resolution that convention alone moved TSLA by 0.43%/trade, which is why TSLA was refetched at 1 minute.

### The reach rates reproduce. The expectancy does not.

SPY at +1% / −0.5%: take-profit reached first **11.6%** of sessions, stop first **37.6%**, closed out **50.9%**. Result 1 measured 9.8% and 45.5% over two years counting touches without ordering — consistent.

| | Result 2 claimed | measured over 10.6y |
| --- | --- | --- |
| SPY 1×, +1/−0.5, cost 0.003% | +0.063%/trade | **+0.0119%** |
| 3× index ETP, +3/−1.5, cost 0.18% | **+0.195%/trade** | **−0.135%** |
| 3× single-stock ETP (TSLA), best of 6 configs, cost 0.41% | — | **−0.463%** |

**The error is one word.** Result 2 argued leverage "enlarges each win against a **fixed-percentage** cost". SPY's round trip is 0.003%; 3USL's observed round trip is 0.18% — **60× larger**. Leverage multiplies the gross move by 3 and the cost by 60. Gross expectancy at 1× is 0.0149%; at 3× it is 0.0447%, against a 0.18% cost. The sign follows from that and nothing else.

**Every cell is negative** — all six configurations, both instruments, in-sample and out. This is not "the best pair is thin"; **no take-profit/stop pair makes an unconditionally-entered position profitable.**

### Event-conditioned levels are worse, and cannot matter anyway

Earnings-reaction sessions identified from the Benzinga wire via Alpaca's news API — the release headline plus a next-session/same-session rule. **46 reaction days** for TSLA across 10.6 years, 28 in-sample and 18 out. (The headline format changed in 2023 from *"Tesla Reports Q4 Adj. EPS…"* to *"Tesla Q4 Adj. EPS … Beats … Estimate"*; matching only the first form silently loses every post-2022 event.)

Out-of-sample, levels frozen from the in-sample fits:

| strategy | expectancy/trade | n | SE | t |
| --- | --- | --- | --- | --- |
| **Grid** — one pooled level pair, every session | **−0.4257%** | 897 | 0.137 | −3.10 |
| ordinary sessions only | −0.4098% | 879 | 0.139 | −2.95 |
| **Event-only** — trade earnings reactions alone | **−1.3267%** | 18 | 0.316 | **−4.19** |
| **Combination** — event levels on event days, pooled elsewhere | **−0.4282%** | 897 | 0.137 | −3.12 |

**Earnings days are significantly *worse*, not better**: −0.92%/trade against ordinary sessions, SE 0.345, **t = −2.66**. Not a stop-width artefact — gross of cost and with stops widened to −6%, every event-day configuration is still negative. The mechanism is that an earnings reaction raises intraday volatility without supplying direction, so a fixed stop is reached far sooner while the take-profit is not.

**And the combination is arithmetically incapable of mattering.** Events are **46 of 2,657 sessions — 1.73%**. Even levels that were dramatically better on event days would move the blended expectancy by about 2%. Event-conditioned thresholds could only matter to an event-*only* strategy, which yields ~4 trades/yr/name and cannot meet ADR-0014's one-trade-per-day floor.

**This confirms the sample-size arithmetic #653 wrote down before any data was pulled** — ~40 events per name in 10 years, too few to resolve the effect being sought.

### The neutral bracket — the levels this produces

Take-profit and stop set so both are **equally likely to be hit first**. At that bracket the unconditional position is a fair coin, so the entry signal's only job is directional accuracy and the edge required is exactly the round-trip cost amortised over the bracket width.

| 3× index ETP (SPY, cost 0.18%) | neutral stop | resolves | closes out | accuracy edge needed |
| --- | --- | --- | --- | --- |
| TP +1.0% | −1.03% | 85.0% | 15.0% | +8.86 pp |
| TP +1.5% | −1.58% | 65.7% | 34.3% | +5.84 pp |
| **TP +2.0%** | **−2.16%** | 48.8% | 51.2% | **+4.33 pp** |
| TP +3.0% | −3.35% | 26.3% | 73.7% | +2.83 pp |
| TP +4.5% | −5.75% | 9.6% | 90.4% | +1.76 pp |

| 3× single-stock ETP (TSLA, cost 0.41%) | neutral stop | resolves | closes out | accuracy edge needed |
| --- | --- | --- | --- | --- |
| TP +2.0% | −2.10% | 99.7% | 0.3% | +9.99 pp |
| TP +4.0% | −4.14% | 91.4% | 8.6% | +5.04 pp |
| **TP +6.0%** | **−6.25%** | 71.6% | 28.4% | **+3.35 pp** |
| TP +9.0% | −9.38% | 44.4% | 55.6% | +2.23 pp |

The neutral bracket is close to symmetric — stop ≈ 1.03–1.12 × take-profit — which is itself a result: intraday the underlying is near driftless at these horizons, so the asymmetry is small and comes from the close-out bucket rather than from any trend.

**Narrow brackets make the ladder fire often but demand a large edge; wide brackets need almost none but degenerate into hold-to-close.** That trade-off, not leverage, is what governs the economics. **It is bracket width relative to a fixed cost that matters** — leverage only helps by making a wide ETP-percentage bracket reachable inside one session, and it inflates the spread at the same time. This is the correct form of the argument Result 2 got wrong.

The bracketed rows are the levels recorded by [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md): the widest that still resolve a meaningful share of trades, and both requiring less accuracy than the ~55% win rate ADR-0017 already assumes.

### The volatility envelope, and why it fixes position size

Drift removed, so this is shape with zero edge assumed:

| subclass | per-trade sd | annualised vol | max drawdown at full £750 |
| --- | --- | --- | --- |
| 3× index ETP | 1.55% | 24.6% | **55.6%** |
| 3× single-stock ETP | 4.01% | 63.6% | **88.0%** |

Against `CONTEXT.md`'s recorded 20–25% tolerance, full deployment is 2.2–3.5× too large **before any edge exists**. Sizing to hold the tolerance:

| fraction of the £750 leg | 3× index | 3× single-stock |
| --- | --- | --- |
| £750 (100%) | 55.6% | 88.0% |
| £375 (50%) | 31.6% | 50.0% |
| **£262 (35%)** | **23.1%** | 35.8% |
| **£188 (25%)** | 17.0% | **26.2%** |

### What the study actually produces

Not a profit estimate. **The bar the entry signal has to clear:**

| instrument class | round trip | signal must add ≥ |
| --- | --- | --- |
| 3× index ETP | 0.18% | **+0.135%/trade** |
| 3× single-stock ETP | 0.41% | **+0.463%/trade** |

This is the first quantity in the project that makes the debate layer's contribution falsifiable: it is exactly what the LLM path must deliver over a random open-entry before the leveraged-ETP universe returns anything. It also sharpens [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) — a system producing zero trades has never been tested against a bar this specific.

**Limitations, which cut both ways.** Entry at the open with no signal is deliberately naive and understates any real system — that is the point of a baseline, but it is not a claim the strategy loses money. Long-only. Underlying tape rather than ETP tape, so no tracking error, no ETP spread beyond the assumed round trip, and no GBP/USD leg. Same-bar ordering is resolved pessimistically throughout. Two instruments, not the full universe.

## Result 3 — the LSE/US overlap holds most of the day's range

Run to test whether a London-hours strategy on a US-underlying ETP gives up too much. SPY 5-minute bars, 125 sessions, 2026-02-01 → 2026-08-01:

| window | % of day's range realised | reached +0.5% |
| --- | --- | --- |
| 1st hour (LDN 14:30–15:30) | **51.1%** | 9.6% |
| **first 2h (LDN 14:30–16:30) — LSE overlap ends** | **72.4%** | 26.4% |
| 3h | 80.8% | 32.8% |
| 4.5h | 89.8% | 39.2% |
| full session | 100% | 44.8% |

**The overlap contains 72.4% of the day's movement in 23.5% of the LSE session**, and 59% of the full-session chance of reaching +0.5% survives inside it.

It is doubly favourable: 14:30–16:30 London is both where the range concentrates *and* the window in which LSE and US are simultaneously open, so LSE-side spreads on a US-underlying ETP are tightest exactly then. The London morning is the worst of both — thin LSE liquidity against a shut underlying, where an RSI reading is computed on a market-maker's guess rather than a live market.

**This does not decide the session window.** It is an input to [#666](https://github.com/dd-jp/samurai-trading-system/issues/666), which measures LSE ETP behaviour directly rather than inferring it from the underlying.

## Limitations

- Every figure uses **US instruments as proxies**. [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) established there is no free LSE intraday history at this depth, so these characterise the *underlying's* physics, not the LSE ETP's own tape.
- **The entire leveraged-ETP case rests on one observed 0.18% spread quote for 3USL.** #666 must measure it and may overturn ADR-0016.
- Reach rates are computed from the daily open. A strategy entering on an indicator later in the session faces a different — and probably worse — conditional distribution, since part of the day's range is already spent. See [`41-tick-latency-economics.md`](41-tick-latency-economics.md) Result 1 for the intraday drift structure.
