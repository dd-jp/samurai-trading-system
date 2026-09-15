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

> **Premise corrected 2026-09-15 by [#1434](https://github.com/dd-jp/samurai-trading-system/issues/1434).** This is a separate correction from the one above — the sign-error note above is about the economics table, not this sentence. "A flat-by-close strategy never holds one overnight" is empirically false: [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) measured 6 of 9 control-arm lots carrying overnight on 2026-09-08 with no flatten intent ever produced, on a flatten-window bug since fixed. The conclusion this sentence draws (decay does not need modelling) still stands, but for a different reason than "never holds one overnight" — see [`docs/research/60-leveraged-etp-ter-and-overnight-decay-exposure.md`](60-leveraged-etp-ter-and-overnight-decay-exposure.md) and [ADR-0016's 2026-09-15 amendment](../adr/0016-universe-leveraged-etps-ungated.md).

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

**This does not decide the session window.** It is an input to the LSE ETP spread measurement that would have been done directly rather than inferred from the underlying — [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) closed 2026-08-27 out of scope without delivering it; [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) now gates on it instead, and [#1053](https://github.com/dd-jp/samurai-trading-system/issues/1053) (open) owns delivering it.

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

Earnings-reaction sessions identified from the Benzinga wire via Alpaca's news API — a headline carrying the company name, a quarter token and a **reported figure** (`EPS $…`), clustered per event, then mapped to a session by release time (before 09:30 ET → same session, 09:30–16:00 → intraday and excluded from both arms, at/after 16:00 → next session). The reported-figure requirement is the load-bearing half: the subsection below shows the release-time rule never fires on this sample, while accepting a bare `EPS` token cost three spurious reaction days. **43 reaction days** for TSLA across 10.6 years, 28 in-sample and 15 out. (The headline format changed in 2023 from *"Tesla Reports Q4 Adj. EPS…"* to *"Tesla Q4 Adj. EPS … Beats … Estimate"*; matching only the first form silently loses every post-2022 event.)

> **Re-measured 2026-08-18 by [#685](https://github.com/dd-jp/samurai-trading-system/issues/685).** The table below replaces one that read **46 reaction days**, event-only **−1.3267%** at n = 18, **t = −4.19**, ordinary −0.4098% at n = 879, combination −0.4282%, and a difference of **−0.92%/trade at t = −2.66**. Those figures are superseded, not withdrawn as fabricated: they reproduce to the digit on the same data under the old labelling, which is what makes the correction attributable. Run record: [`archive/raw/2026-08-18-earnings-lookahead-rerun.txt`](archive/raw/2026-08-18-earnings-lookahead-rerun.txt), against a criterion committed before the run.

Out-of-sample, levels frozen from the in-sample fits:

| strategy | expectancy/trade | n | SE | t |
| --- | --- | --- | --- | --- |
| **Grid** — one pooled level pair, every session | **−0.4257%** | 897 | 0.137 | −3.10 |
| ordinary sessions only | −0.4055% | 882 | 0.138 | −2.93 |
| **Event-only** — trade earnings reactions alone | **−1.4433%** | 15 | 0.318 | **−4.54** |
| **Combination** — event levels on event days, pooled elsewhere | **−0.4229%** | 897 | 0.136 | −3.10 |

**Earnings days are significantly *worse*, not better**: −1.0378%/trade against ordinary sessions, SE 0.347, **t = −2.99**. The sign and the significance both survive the correction, and the gap widens slightly. Not a stop-width artefact — gross of cost and with stops widened to −6%, every event-day configuration is still negative. The mechanism is that an earnings reaction raises intraday volatility without supplying direction, so a fixed stop is reached far sooner while the take-profit is not.

**And the combination is arithmetically incapable of mattering.** Events are **43 of 2,657 sessions — 1.62%**. Even levels that were dramatically better on event days would move the blended expectancy by about 2%. Event-conditioned thresholds could only matter to an event-*only* strategy, which yields ~4 trades/yr/name and cannot meet ADR-0014's one-trade-per-day floor.

#### What #685 actually found — the named defect was inert, a third one was not

The ticket named two defects in the labelling, and both are real code defects, now fixed in `18-threshold-study.py`:

1. **Look-ahead.** Any release before 16:00 ET was called a *same-session* reaction, including releases *during* the session — so for an 11:00 release the study's 09:30 entry preceded the event the session was labelled for.
2. **One event counted as two days.** Headlines were not deduped per event.

**Neither moved a number, and that is the measurement, not an assumption.** All 43 genuine TSLA releases in 10.6 years land **post-close, between 16:01 and 17:14 ET**. No session is intraday-contaminated, so nothing is excluded; and the old code's per-headline markers were kept in a `(date, label)` set, which already collapsed multiple post-close headlines on one date.

**The whole 46 → 43 change is a third defect the ticket did not name: the matcher.** Requiring only `q[1-4]` and the letters `EPS` accepted commentary and previews, four of which marked reaction days of their own:

| headline | ET | what it actually is |
| --- | --- | --- |
| *"Tesla Analyst Predicts 6% Beat On Q2 EPS — But Tells Investors To Focus On 4 'More Important' T…"* | 2023-07-14 02:07 | preview, 5 days before the release |
| *"Tesla Q2 EPS Estimate Bumped Up, Rivian's Cold Shoulder To Union, Lucid's 70% Sales Jump And Mo…"* | 2024-07-13 11:16 | roundup, 10 days early — and a **Saturday**, so it marked no session |
| *"Tesla Q3 Earnings Preview: Troy Teslike, Gary Black Expects EPS To Fall Below Estimates But Dan…"* | 2024-10-22 08:52 | preview, the day *before* the real release |
| *"Tesla Among S&P's Big Losers: Q1 EPS Miss Puts TSLA In Bottom 10"* | 2025-06-09 14:10 | market commentary, no release |

Three of the four fell on trading days: **46 = 43 + 3**, and all three are out-of-sample, which is why the in-sample fits and every frozen level are unchanged and the entire out-of-sample delta is attributable to dropping those three sessions.

The 2024-10-22 preview is the one that shows why the matcher had to tighten rather than the dedupe alone: a naive earliest-headline-wins dedupe anchors the event to the *preview*, which then swallows the genuine 2024-10-23 16:04 print as a "recap" inside the same cluster and **loses the real reaction day entirely**. The release matcher now requires a reported figure — `EPS $…` — which is what separates the print from the talk about it. Under it the 43 events are exactly the quarterly sequence 2016 Q4 through 2026 Q2, with no gaps and no duplicates.

**What is still not measured.** The pre-open and intraday branches of the classifier are exercised only by a synthetic fixture in the run record, because TSLA never reports outside the post-close window — a name that reports pre-market would exercise them for real, and none was measured here. And the event-only figure remains a 6-cell grid selected in-sample on 28 days and scored on 15; that was true of the superseded number too, and it is the reason this row should not be read as a precise level in either direction.

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

> ### ⚠️ Both tables above are measured at the WRONG BRACKET — [#729](https://github.com/dd-jp/samurai-trading-system/issues/729), 2026-08-17
>
> `18-drawdown-envelope.py` (added by #729) is the generator these rows never had. It reproduces
> every published figure **exactly**, which identifies both the definition and the inputs — and the
> inputs are not the declared exit rule.
>
> **The definition** is max drawdown of a **drift-removed, fixed-fraction, simple-compounded** equity
> curve (`equity *= 1 + f·r`) over the bracketed per-trade series, 2,659 sessions. That is why neither
> linear nor log scaling re-derives the ladder: simple compounding scales as `f^0.854` (index) and
> `f^0.873` (single-stock) against the recorded `f^0.855` / `f^0.874`.
>
> **The inputs** are two brackets from the *pre-neutral* grid — the `SLS = {1.5, 3}` sweep — not the
> neutral brackets this document recommends and [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) D3 declares:
>
> | subclass | bracket the envelope was measured at | bracket the system will trade | sd measured / recorded |
> | --- | --- | --- | --- |
> | 3× index | **TP +3.0% / SL −1.50%** | TP +2.0% / SL −2.16% | 1.553% / 1.55% |
> | 3× single-stock | **TP +6.0% / SL −3.00%** | TP +6.0% / SL −6.25% | 4.006% / 4.01% |
>
> At those brackets the generator returns 55.6 / 31.6 / 23.1 / 17.0 and 88.0 / 50.0 / 35.8 / 26.2 —
> all eight rows to the last decimal. The identification is confirmed independently by ADR-0018 D5's
> own aside that a strict 25% tolerance needs *"roughly ~24%"* deployment: solved on the single-stock
> provenance series, the tolerance binds at **f = 0.237**.
>
> **Re-measured at the declared brackets, drift removed, same definition:**
>
> | deployed fraction | 3× index (TP +2.0 / SL −2.16) | 3× single-stock (TP +6.0 / SL −6.25) |
> | --- | --- | --- |
> | 100% | 61.9% *(recorded 55.6%)* | **97.8%** *(recorded 88.0%)* |
> | 50% | 35.9% *(31.6%)* | **71.7%** *(50.0%)* |
> | 35% | **26.2%** *(23.1%)* | 55.2% *(35.8%)* |
> | 25% | 19.2% *(17.0%)* | **41.8%** *(26.2%)* |
> | per-trade sd | 1.574% (ann. 25.0%) | **5.362%** (ann. 85.1%) |
>
> **The single-stock stop is the whole story.** #724 froze the neutral stop at **−6.25%**, which is
> 2.08× the −3.00% the envelope was measured at, and per-trade sd rises 4.01% → 5.36% with it. At the
> declared 25% deployment the drawdown envelope is **41.8%, not 26.2%** — an overshoot of ~17 pp
> against `CONTEXT.md`'s 20–25% band, where ADR-0018 D5 records and accepts an overshoot of 1.2 pp.
> The index row moves too, but only from inside the band to its edge: 23.1% → 26.2% at 35%.
>
> **Deployment that actually holds the tolerance at the declared brackets** (bisection, not
> interpolation between ladder rows):
>
> | subclass | ≤25% envelope | ≤20% envelope | currently declared |
> | --- | --- | --- | --- |
> | 3× index | f = **0.332** | f = 0.261 | 0.35 |
> | 3× single-stock | f = **0.142** | f = 0.112 | 0.25 |
>
> Two mitigations are real and neither closes the gap. ADR-0018's sizing amendment establishes that
> fixed-fractional sizing on *current* equity makes these upper bounds rather than estimates. And
> drift removal is deliberately pessimistic — the measured mean is −0.147%/trade (index) and
> −0.489%/trade (single-stock), so the traded series is *worse* than the drift-removed one, not
> better; removing drift flatters the envelope here rather than stressing it.
>
> Reproduce with:
>
> ```
> SAMURAI_DATA_DIR=<dir> python3 docs/research/18-fetch-bars.py SPY  2016-01-04T00:00:00Z 2026-08-01T00:00:00Z 5Min
> SAMURAI_DATA_DIR=<dir> python3 docs/research/18-fetch-bars.py TSLA 2016-01-04T00:00:00Z 2026-08-01T00:00:00Z 1Min
> SAMURAI_DATA_DIR=<dir> python3 docs/research/18-drawdown-envelope.py
> ```
>
> **Not resolved here:** whether to re-size to f = 0.142 / 0.332, re-open the single-stock stop, or
> accept a 41.8% envelope. That is an ADR-0018 D5 amendment and David's call.

### What the study actually produces

Not a profit estimate. **The bar the entry signal has to clear:**

| instrument class | round trip | signal must add ≥ |
| --- | --- | --- |
| 3× index ETP | 0.18% | **+0.135%/trade** |
| 3× single-stock ETP | 0.41% | **+0.463%/trade** |

This is the first quantity in the project that makes the debate layer's contribution falsifiable: it is exactly what the LLM path must deliver over a random open-entry before the leveraged-ETP universe returns anything. It also sharpens [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) — a system producing zero trades has never been tested against a bar this specific.

**Limitations, which cut both ways.** Entry at the open with no signal is deliberately naive and understates any real system — that is the point of a baseline, but it is not a claim the strategy loses money. Long-only. Underlying tape rather than ETP tape, so no tracking error, no ETP spread beyond the assumed round trip, and no GBP/USD leg. Same-bar ordering is resolved pessimistically throughout. Two instruments, not the full universe.

## Limitations

- Every figure uses **US instruments as proxies**. [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) established there is no free LSE intraday history at this depth, so these characterise the *underlying's* physics, not the LSE ETP's own tape.
- **The entire leveraged-ETP case rests on one observed 0.18% spread quote for 3USL.** [#666](https://github.com/dd-jp/samurai-trading-system/issues/666), which would have measured it, closed 2026-08-27 out of scope without delivering that measurement; [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) now gates on it instead, and [#1053](https://github.com/dd-jp/samurai-trading-system/issues/1053) (open) owns delivering it. Per [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md)'s Known weakness: if the real spread is materially wider than 0.18%, the expectancy uplift that justifies leverage still disappears.
- Reach rates are computed from the daily open. A strategy entering on an indicator later in the session faces a different — and probably worse — conditional distribution, since part of the day's range is already spent. See [`41-tick-latency-economics.md`](41-tick-latency-economics.md) Result 1 for the intraday drift structure.
