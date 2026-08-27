# FOMC/CPI/NFP event-study: FOMC structurally void, CPI/NFP measured — a positive point estimate that doesn't clear significance

**Measured 2026-08-26 for [#915](https://github.com/dd-jp/samurai-trading-system/issues/915), the event-study [#655](https://github.com/dd-jp/samurai-trading-system/issues/655)'s resolution declared.** Scripts: [`55-fomc-cpi-nfp-event-study.py`](55-fomc-cpi-nfp-event-study.py) (FOMC arm, data pipeline), [`55b-cpi-nfp-run.py`](55b-cpi-nfp-run.py) (CPI/NFP arm, built on the first).

## Headline

**The declared family splits into one void member and one measured result that is directionally positive but not statistically significant once correctly adjusted for correlation.**

**FOMC** cannot be measured — not from lack of power, but because this system's exit rule structurally excludes it. The neutral bracket flattens at ~11:25–12:25 ET (the 16:25 London flatten, ADR-0018 D3); the FOMC statement releases at 14:00 ET. On **every one of the 84 scheduled FOMC decisions, 2016–2026**, the release lands after the position is already flat. `p_catalyst` for FOMC is undefined, not merely underpowered.

**CPI/NFP, pooled at the event-day level** (264 distinct release days, no same-day overlap between the two — a FRED key was provisioned 2026-08-26 via [#918](https://github.com/dd-jp/samurai-trading-system/issues/918), unblocking this arm): pooled SPY+QQQ win rate is **`p_catalyst` = 57.34%** (n=518) against **`p_all-day` = 52.51%** (n=5,336) — delta **+4.82pp**. Under a naive independent-N standard error this reads t=2.12 (nominally significant); under the correlation-adjusted SE this ticket's own detectability-floor requirement demands (ρ(SPY,QQQ) = 0.883, pooling two names buys only 1.062× the single-name N, not 2×), it drops to **t = 1.54 — not significant at conventional thresholds.** The point estimate is positive and, at the higher end of #886's disputed notional range, clears the accuracy bar that notional implies — but the measurement can't rule out that the +4.82pp is noise.

## What was measured

- **Data:** Alpaca SIP, 5-minute bars, SPY and QQQ (the pool's only two index-subclass underlyings — see "Correction to #915's declaration" below), 2016-01-04 through 2026-08-14. 490,111 SPY bars, 474,736 QQQ bars.
- **FOMC dates:** all 84 regularly scheduled meeting decision days, 2016–2026, from federalreserve.gov's own historical calendar pages (primary source, not blocked). The 2020 emergency actions (unscheduled cuts, notation votes) are excluded for consistency with every other year's "scheduled meeting" population.
- **Bracket:** ADR-0018 D3's frozen neutral single bracket, index subclass — TP +2.00% / SL −2.16%, 3× leverage, 0.18% round-trip cost, entry at 09:30 ET open, exit at the first of TP/SL/flatten.
- **Statistic:** win rate (TP hit before SL) as the accuracy proxy `p`, matching the `50% + bar` framing ADR-0016's 2026-08-18 amendment and doc 54 use for this bracket.

## The exposure-window check

Original earnings-study convention (`18-threshold-study.py`'s `classify()`/`reaction_dates()`) uses the full 09:30–16:00 session as the exposure window and treats an intraday release as contaminating that session, pushing "reaction" to the next day. That convention is wrong for this system: the actual exposure window is 09:30 to the London flatten, not 09:30 to close. Re-run with the correct window boundary:

| release timing vs. this system's exposure window | FOMC (84 events) |
| --- | --- |
| before open (`< 09:30 ET`) — full-session exposure | 0 |
| inside window (`09:30 ET` to flatten) — contaminates, excluded | 0 |
| **after flatten (`14:00 ET` > flatten)** — **no exposure at all** | **84** |

Every FOMC event falls in the third row, on both names, across all 10 years. `flatten_at()` sits between 11:25 and 12:25 ET depending on the week's London/NY DST alignment; FOMC's 14:00 ET release is never close.

**A placebo check, not the declared statistic:** treating the FOMC calendar day itself as a naive "catalyst day" label (ignoring that there's no true exposure), the pooled SPY+QQQ win rate on FOMC days is **40.7%** (n=167) against **52.5%** on all days (n=5,336) — delta −11.8pp, naive t = −3.05. This is a real, separately interesting finding (FOMC-morning sessions are more range-bound / less likely to hit a directional TP than an average morning, plausibly pre-announcement positioning caution), but it is **not** an answer to "does directional accuracy improve on catalyst days" — the bracket that measures it closes hours before the catalyst it's supposedly reacting to. Flag for a future ticket if pre-announcement morning behavior becomes its own question; it isn't this one.

## Detectability floor, recomputed as #915 required

#915's body correctly flagged that the Earnings study's ~0.63%-at-2-SE floor doesn't transfer to a market-wide family — FOMC/CPI/NFP move every index name on the same day, so the pooling unit is the event-day, not the name-event, and cross-sectional correlation has to be measured, not assumed away.

Measured: **ρ(SPY, QQQ same-session return) = 0.883** across 2,667 common sessions. Under equal-correlation pooling of two series, `Var(mean of 2) = (1+ρ)/2 × Var(single)`, so the effective independent-N multiplier from pooling SPY and QQQ is **2/(1+ρ) = 1.062×** — not the 2.0× a naive independent-N formula would assume. **Pooling the index subclass's two names buys almost no extra power over measuring one name alone.** This would have been the binding constraint on CPI/NFP power too, had those events been available to test.

## CPI/NFP arm, measured 2026-08-26

**Release dates:** FRED `release/dates`, release_id=10 (Consumer Price Index) and release_id=50 (Employment Situation, which publishes NFP/`PAYEMS`), 2016-01-01 through 2026-08-26. 134 CPI release dates (127 distinct months — 7 Februaries in the sample carry two CPI releases each, a real BLS schedule quirk, not a data defect), 130 NFP release dates (127 distinct months — three months carry two). **Zero same-day overlap** between CPI and NFP dates across the whole sample, so the pooled family event-day count is a clean union: 264 distinct release days, no double-counting risk.

**Exposure window:** both CPI and NFP release at 08:30 ET, before the 09:30 ET open — unlike FOMC, the market opens already knowing the print, so the *entire* session is inside this system's exposure window (09:30 to flatten). Every one of the 264 pooled event-days that falls on a trading day in the sample (259 of 264 — the rest are pre-2016-01-04 sample-start artifacts) lands in the `classify_release()` "same" bucket (full-session exposure), none excluded as intraday-contaminated, none falling after flatten.

| | SPY | QQQ | pooled |
| --- | --- | --- | --- |
| `p_all-day` | 52.38% (n=2,669) | 52.64% (n=2,667) | **52.51%** (n=5,336) |
| `p_catalyst` (CPI/NFP release-session) | 58.69% (n=259) | 55.98% (n=259) | **57.34%** (n=518) |
| delta | +6.31pp | +3.34pp | **+4.82pp** |

**Significance, with the detectability floor #915 required:** naive independent-N pooling gives SE=2.28pp, t=2.12. But ρ(SPY,QQQ same-session return) = 0.883 (same measurement as the FOMC arm above), so the effective pooling multiplier is 1.062×, not 2×. Scaling the naive-pooled variance to reflect the true effective N gives **SE=3.13pp, t=1.54** — below the ~1.96 conventional two-tailed 95% threshold. **The point estimate is positive; the measurement cannot distinguish it from noise at 95% confidence.** This is exactly the outcome #915's body flagged as possible ("Net power could land either side of 0.63% [floor]... 'Underpowered, cannot answer' is a legitimate result") — 264 pooled event-days across two highly-correlated names is a real but modest sample, and the correlation correction costs roughly a third of the naive significance.

**Break-even bar, swept across #886's disputed index notional (still open — no verdict picked):**

| notional | bill-cost | break-even accuracy | `p_catalyst` (57.34%) clears? |
| --- | --- | --- | --- |
| £50 (static 5% cap, what the system deploys today per #886) | 11.07pp | 64.03% | No |
| £100 | 5.53pp | 58.49% | No |
| £150 | 3.69pp | 56.65% | Yes (marginally) |
| £200 | 2.77pp | 55.73% | Yes |
| £250 (D5 single-stock fraction, for reference) | 2.21pp | 55.17% | Yes |
| £300 | 1.84pp | 54.80% | Yes |
| £350 (D5's intended index fraction) | 1.58pp | 54.54% | Yes |

At the low end of #886's dispute (the £50 the system actually deploys today under the unresolved cap bug), the point estimate doesn't clear break-even. At the high end (£350, D5's intended fraction), it does — by 2.8pp, comfortably inside one correlation-adjusted SE (3.13pp), so "clears" here means the point estimate is above the line, not that clearing is statistically established. **Given t=1.54, no notional in this range supports a confident pass/fail call from this measurement alone.**

## Correction to #915's declaration

#915's body describes pooling "across the pool's 7 distinct `screening_instrument` values" while also declaring "index only." Those two statements conflict. The 7-underlying figure is doc 52's original ADR-0018 study pool (SPY, QQQ index; TSLA, NVDA, AAPL, MSTR, PLTR single-stock) — of which only **SPY and QQQ are index subclass**. The 26-underlying figure in `lse-etp-pool.ts` is the current live-trading pool (post-#813), not the ADR-0018 study pool, and doesn't have a clean index/single-stock breakdown checked here. This run pools SPY+QQQ only, consistent with "index only." The ρ = 0.883 result above is exactly why this correction matters: an index-only trial has at most 2 names to pool in the study-pool frame, and they're nearly collinear.

## What this means for #658 and ADR-0016

1. **FOMC is not a usable member of the declared trial under the current exit rule.** This isn't a power problem a bigger sample fixes — it's structural, and it holds for as long as the flatten stays where D3 put it. If FOMC-reaction is something worth trading on, it requires either a later flatten (which ADR-0018 D3/#708's ladder rider already closed off — see ADR-0018's tranche-ladder withdrawal) or accepting FOMC is permanently out of reach for this system's intraday shape.
2. **CPI/NFP pooled shows a positive point estimate (+4.82pp) that does not clear conventional significance once correctly correlation-adjusted (t=1.54).** This is not a "fails" result and not a "clears" result — it's a measurement too weak to support either call at this sample size. A larger sample doesn't exist yet (264 event-days is the whole 2016–2026 population of CPI/NFP releases; this isn't a selection choice), so more power here means either widening the underlying pool beyond SPY/QQQ (which the "index only" declaration currently forbids) or waiting for more calendar years to accumulate — both slow.
3. **The declared trial (#655) delivered a real, if narrower, answer.** "FOMC/CPI/NFP pooled as one family statistic" turned out to be "CPI/NFP pooled, FOMC void" — a different, narrower trial than what David declared, but this ticket now has a complete result against that narrower scope rather than a partial one. That the narrowing itself is legitimate (rather than something this ticket should have escalated back to #655) is a call for #658's grilling to confirm, not this ticket to assume — flagged there.
4. **#886 stays open and this doesn't resolve it** — it decides which notional D5-classified instruments actually deploy at, and that number is exactly what determines whether the swept break-even table above reads as clearing or not.

## Limitations

- FOMC dates: primary-sourced, high confidence (federalreserve.gov, all 84 events, cross-checked year-by-year).
- CPI/NFP dates: FRED `release/dates`, release_id=10/50, primary-sourced, high confidence — 127 distinct months each (matching the ~10.6y monthly cadence), zero overlap days.
- The FOMC-arm placebo delta (−11.8pp) is reported for the record and future reference, not as a validated finding — it wasn't a hypothesis declared in advance, and no adversarial check was run on it.
- The CPI/NFP result is a **win-rate proxy for directional accuracy** (TP-hit-before-SL under the frozen ADR-0018 D3 bracket), matching the FOMC arm's convention and the `50%+bar` framing ADR-0016/doc 54 use — it is not a full return-weighted simulation. It also does not distinguish CPI's effect from NFP's; the family was declared and measured as one pooled statistic, per #655, not two.
- Full sample (2016–2026, not split in/out-of-sample) was used throughout, since the bracket is ADR-0018's frozen declared constant, not fit on this data — nothing here is selected on.
- The correlation-adjustment method (scaling naive-pooled variance by `2/effective_multiplier`) is a first-order correction, not a full joint model of SPY/QQQ returns on release days specifically (ρ=0.883 was measured on the full sample, not release days alone — release-day correlation could differ, plausibly higher given both react to the same macro print, which would push the true adjusted t even lower).
- Break-even bar sweep uses doc 54 §4's bill-cost formula (`Δp = bill × 10⁴ / (N × notional × width)`) and QQQ's 2.96pp geometry bar; it is index-subclass only, matching this ticket's "index only" declaration — the single-stock bar is not swept here.
