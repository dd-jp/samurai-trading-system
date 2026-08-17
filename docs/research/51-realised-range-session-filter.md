# Realised range at entry as a session filter

**[#787](https://github.com/dd-jp/samurai-trading-system/issues/787), split out of [#708](https://github.com/dd-jp/samurai-trading-system/issues/708). Measured 2026-08-17.**

Second entry in the `50`–`59` **intraday horizon** band opened by [#786](https://github.com/dd-jp/samurai-trading-system/issues/786), after [`50-entry-time-conditional-brackets.md`](50-entry-time-conditional-brackets.md).

[#708](https://github.com/dd-jp/samurai-trading-system/issues/708) asked whether the **bracket** should be conditioned on entry time and realised range, and answered no: across 42 measured cells, re-solving the stop per cell beat the declared bracket by at most 0.56 pp with no consistent sign. #787 was split out rather than folded into that verdict because it is a different question with a different failure mode:

> Does declining to trade low-realised-range sessions **lower the accuracy bar the signal has to clear**, by enough to matter, out of sample?

The reason conditioning the bracket bought nothing is that the *sessions* already differ, and that difference survives on the declared bracket. Doc 50's `bar` column at `t0 = 15` single-stock reads quiet **6.42 pp** against busy **−0.09 pp**. That table is a by-product of a study designed for something else, and #787's own body says **do not act on it as it stands**. This document is the fresh pre-registration it asked for.

## Pre-registration — stated before the result

| | |
| --- | --- |
| **Statistic** | `ratio = (realised range from the session open to the arming instant) / (trailing 20-session mean full-session range)`. Both legs are percentages of that session's open, so leverage cancels. The denominator is **strictly prior sessions**, so the quantity is observable at the arming instant with no lookahead. Unchanged from doc 50's `range_ratios`. |
| **Rule** | **Trade iff `ratio ≥ θ`.** One threshold, in ratio units — *not* a tercile solved on the sample, which is what #787 rules out explicitly. |
| **θ grid** | Eleven points, `0.00` to `0.50` in steps of `0.05`. The range is fixed by the construction of the statistic — a 15-minute numerator over a 390-minute denominator lives well below 1 — not by inspecting it. |
| **θ selection** | Minimise the **in-sample** required edge on the frozen bracket, subject to retaining ≥ **40%** of in-sample sessions. The retention floor is declared, not tuned: without it the minimiser walks into the tail and wins on a handful of sessions. |
| **Bracket** | **Frozen**, not re-solved: ADR-0018's declared pair per subclass (+2.00 / −2.16 index, +6.00 / −6.25 single-stock), truncated at the 16:25 London flatten. #708 already rejected conditioning it; this study varies only *which sessions are traded*. |
| **Split** | Inherited, not re-chosen: in-sample ≤ 2022, out-of-sample ≥ 2023 (`18-threshold-study.py`). |
| **Decision offset** | `t0 = 15` minutes past the US open. #706 arms entries 14:30–15:45 London (0–75 minutes past the open) and doc 50's verdict is to enter as close to 14:30 as the signal allows; `t0 = 0` has no realised range by construction. `t0 ∈ {30, 45, 60}` are reported as **robustness only** and carry no part of the verdict. |
| **Comparator** | The **same frozen bracket on unfiltered sessions**, same offset, same out-of-sample period. Trade count and max drawdown are reported alongside the required edge, per CLAUDE.md's control rule — the filter changes the trade mix, not only the count. |

### Outcomes, declared before the result

- **PASS** — the out-of-sample required edge on kept sessions is **≥ 1.00 pp below** the unfiltered bar, **and** the kept-vs-dropped difference clears **2 SE**, **and** max drawdown is not worse. 1.00 pp is roughly a quarter of doc 50's truncated bars (4.19 pp index, 3.85 pp single-stock); below that the filter is not worth a rule that can be got wrong at the arming instant.
- **PARTIAL** — one of the first two conditions holds but not both.
- **FAIL** — neither. The pre-session range screen is recorded as measured-and-rejected rather than left as folklore.

## Method

`docs/research/18-range-filter-study.py`, on the same tape ADR-0018 and doc 50 were computed from: Alpaca SIP, 2016-01-04 → 2026-07-31, regular hours, **SPY 5-minute (2,659 sessions)** and **TSLA 1-minute**. Costs are ADR-0016's round trips, 0.18% index and 0.41% single-stock. The script imports `simulate`, `load_sessions`, `range_ratios` and `flatten_at` from the existing `18-*` family rather than reimplementing them, so the entry, truncation and cost conventions are identical to doc 50's by construction.

**The required edge is a linear function of the mean.** Since `E_gross = mean_net + cost`,

```
bar = (cost − E_gross) / width = −mean_net / width
```

so comparing bars between two session sets *is* comparing mean net returns, rescaled by a frozen width. This is worth stating because it collapses two things that look separate: "the filter lowers the bar" and "the filter raises expectancy" are the same claim, and neither can be true without the other.

**Two comparisons, and only one of them has an honest closed-form error.** KEPT is *nested* inside UNFILTERED, so the difference between their bars has no unpaired standard error; it is given a **bootstrap SE over sessions** (2,000 resamples, sessions as the resampled unit, seed fixed). KEPT and DROPPED are disjoint, so their difference carries the ordinary `√(se₁² + se₂²)`.

## The in-sample solve

Eleven thresholds, on the in-sample half only, at `t0 = 15`.

| θ | index: keeps | index: IS bar | single-stock: keeps | single-stock: IS bar |
| --- | --- | --- | --- | --- |
| 0.00 | 100.0% | 3.75 pp | 100.0% | 3.37 pp |
| 0.15 | 92.9% | 3.69 pp | 99.8% | 3.38 pp |
| 0.20 | 76.0% | **3.50 pp** | 98.0% | 3.38 pp |
| 0.25 | 57.0% | 3.80 pp | 91.8% | 3.32 pp |
| 0.30 | 39.7% *(below floor)* | 3.61 pp | 81.6% | 3.23 pp |
| 0.35 | 27.9% *(below floor)* | 4.99 pp | 68.7% | 3.06 pp |
| 0.40 | 18.4% *(below floor)* | 3.96 pp | 56.4% | 3.09 pp |
| 0.45 | 12.9% *(below floor)* | 3.60 pp | 44.1% | **2.55 pp** |
| 0.50 | 8.6% *(below floor)* | 1.99 pp | 34.4% *(below floor)* | 1.91 pp |

**Selected: θ = 0.20 index, θ = 0.45 single-stock.** The two subclasses land in different places, and the shape of the in-sample curve already says why. On the index it is flat and non-monotone — 3.75 / 3.69 / 3.50 / 3.80 — which is noise with a minimum in it. On single-stock it *descends* to the retention floor, 3.37 → 3.06 → 2.55, which is what a real conditional effect looks like. Both thresholds sit below the floor's edge, so neither is the floor's artefact.

## Out of sample — the index fails, and fails with the opposite sign

Frozen bracket +2.00 / −2.16, 897 out-of-sample sessions, `t0 = 15`.

| arm | trades | required edge | E_net / trade | resolves | maxDD/trade |
| --- | --- | --- | --- | --- | --- |
| **UNFILTERED** (control) | 897 | **3.60 pp** ± 0.92 | −0.1499% | 17.1% | 0.1592% |
| **KEPT** (ratio ≥ 0.20) | 607 | **4.27 pp** ± 1.20 | −0.1776% | 21.1% | 0.1927% |
| **DROPPED** (ratio < 0.20) | 290 | **2.21 pp** ± 1.33 | −0.0921% | 8.6% | 0.1206% |

- Gain against unfiltered: **−0.66 pp** ± 0.56 (bootstrap over sessions, t = −1.18).
- Kept versus dropped: **−2.06 pp** ± 1.79, t = −1.15.
- Drawdown per trade: **worse** (0.1927% against 0.1592%).

**FAIL, on every declared bar.** The filter does not merely fail to help on the index — the sessions it discards are the *cheaper* ones, by 2.06 pp. The in-sample minimum at θ = 0.20 did not survive contact with the out-of-sample half, which is the expected fate of a minimum found on a flat, non-monotone curve.

The three robustness offsets say the same thing more boringly: gains of +0.11, −0.04 and +0.04 pp at `t0` = 30, 45 and 60. On the index, the filter does nothing at all.

## Out of sample — single-stock is the right size and the wrong significance

Frozen bracket +6.00 / −6.25, 897 out-of-sample sessions, `t0 = 15`.

| arm | trades | required edge | E_net / trade | resolves | maxDD/trade |
| --- | --- | --- | --- | --- | --- |
| **UNFILTERED** (control) | 897 | **4.35 pp** ± 1.20 | −0.5330% | 41.8% | 0.5492% |
| **KEPT** (ratio ≥ 0.45) | 427 | **2.62 pp** ± 1.80 | −0.3209% | 45.9% | 0.3209% |
| **DROPPED** (ratio < 0.45) | 470 | **5.92 pp** ± 1.61 | −0.7257% | 38.1% | 0.7825% |

- Gain against unfiltered: **+1.73 pp** ± 1.26 (bootstrap over sessions, t = +1.37).
- Kept versus dropped: **+3.30 pp** ± 2.42, t = +1.37.
- Drawdown per trade: **better**, 0.3209% against 0.5492% — and sd-normalised, 1.45 against 3.73.
- Trades kept: **48%** of the unfiltered count.

**PARTIAL.** The effect is the right sign, is materially large — 1.73 pp against a 4.35 pp bar is a 40% reduction in what the signal must supply — and it survives the risk-adjustment CLAUDE.md requires: drawdown falls *per trade*, not merely in total. What it does not do is clear 2 SE. At t = 1.37 on both the nested and the disjoint comparison, this evidence cannot separate a real conditional effect from the noise of 897 sessions.

Robustness at the other armed offsets is consistent rather than confirmatory: gains of **+1.98**, **+0.93** and **+0.00** pp at `t0` = 30, 45, 60, decaying to nothing by the end of the entry window. Same sign at three of four offsets, and the decay is in the direction the mechanism predicts — by `t0 = 60` the filter keeps 84% of sessions and so is barely a filter.

### Why the raw drawdown number had to be normalised

A filter that trades half as often has half as long to lose money, so raw peak-to-trough flatters it mechanically. Both comparisons are therefore reported per trade, and the pre-registered condition is on the per-trade figure. This is not cosmetic: on the index, raw drawdown *improved* (117.00% against 142.78%) while per-trade drawdown got **worse** (0.1927% against 0.1592%). Read raw, the index looks like a partial win on risk. Read per trade, it is a loss on every axis. The single-stock result survives both readings.

### The two subclasses genuinely differ, and doc 50 predicted it

#787's body warned that "the index shows a much weaker version of the same pattern and may not survive at all." It does not survive; it inverts. The mechanism doc 50 identified is why. Truncation moves the index bar *down* (index `E_gross` under the flatten is **+0.0055%**) and the single-stock bar *up* (**−0.0619%**): flattening an index position at 16:25 interrupts a near-symmetric distribution and is close to free, while flattening a 3× single-stock position cuts a move off mid-flight. A filter that selects for sessions that travel can only pay for itself where being cut off mid-move is expensive — which is single-stock, and not the index.

## Selection accounting

**11 trials bear on the verdict per subclass** — the θ grid at the single decision offset. The three robustness offsets are reported, not selected on; counting them would be 44, and no verdict is taken from them. Both subclasses have 4.0 out-of-sample years, which supports **25** independent trials at MinBTL against a target annual Sharpe of 1 (`overfitting.ts:238`). At 11 spent, this study is within budget — and unlike doc 13's Stage 2 chain, the PARTIAL here is *not* a selection artefact by that accounting. It is an ordinary sample-size limit.

## Verdict

| subclass | θ | unfiltered bar | kept bar | gain | t | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 3× index ETP | 0.20 | 3.60 pp | 4.27 pp | **−0.66 pp** | −1.18 | **FAIL** |
| 3× single-stock ETP | 0.45 | 4.35 pp | 2.62 pp | **+1.73 pp** | +1.37 | **PARTIAL** |

**The answer to #787's question is: not on this evidence, and not on the index at all.**

1. **The index filter is rejected outright.** It is measured-and-rejected now, not folklore. Nothing should condition index entry on realised range, and the doc-50 table's index rows should not be read as a session-selection result.
2. **The single-stock filter is not adopted, and is not dead either.** It is the only thing measured on the intraday path so far that moves the required edge by more than a rounding error in the right direction while *lowering* per-trade drawdown. It fails the declared significance bar, and the declared bar stands — restating it after seeing t = 1.37 would be exactly the move this project's PBO 0.85 history exists to prevent.
3. **What would settle it.** Not more thresholds, and not another offset — both are trials against the same 897 sessions. It needs *independent sessions*: either more out-of-sample tape as time passes, or the same rule measured on other single-stock underlyings in the pool (`server/providers/universe-pool/lse-etp-pool.ts` carries PLTR, NVDA, MSTR, AAPL alongside TSLA). That is a cross-instrument replication, and it is the natural follow-on ticket.
4. **The bracket is untouched.** Nothing here re-solves or re-calibrates ADR-0018's brackets; #708's rejection of bracket conditioning stands, and this study deliberately froze the bracket so the two results cannot be confused.

### Not measured here

- **Any interaction with the signal.** The required edge is what the signal must supply on the sessions traded. Whether the *signal itself* is better or worse on high-range sessions is a different question, and a filter that improves the bar while degrading signal accuracy on the same sessions could net out anywhere.
- **Other single-stock names.** One underlying, TSLA, stands for the whole subclass here, exactly as it does in ADR-0018 and doc 50. Point 3 above is the fix.
- **The tracking-error and FX legs.** As in every study on this tape, the measurement is on the US underlying, not the LSE ETP that would actually be held (`lse-etp-pool.ts`, residual risks 1 and 2).
- **Cost sensitivity.** Round trips are ADR-0016's 0.18% / 0.41%, still resting on single quotes — [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) remains unmeasured and blocked on [#665](https://github.com/dd-jp/samurai-trading-system/issues/665). Since `bar = −mean_net / width`, a wrong cost shifts every arm equally and cancels out of the *differences* reported here, so the verdict is robust to it even though the levels are not.

## Reproducing

```bash
SAMURAI_DATA_DIR=/tmp/adr18 SAMURAI_ENV_FILE=.env.local \
  python3 docs/research/18-fetch-bars.py SPY  2016-01-04 2026-07-31 5Min
SAMURAI_DATA_DIR=/tmp/adr18 SAMURAI_ENV_FILE=.env.local \
  python3 docs/research/18-fetch-bars.py TSLA 2016-01-04 2026-07-31 1Min
SAMURAI_DATA_DIR=/tmp/adr18 python3 docs/research/18-range-filter-study.py
```

The TSLA 1-minute pull is ~1.9M bars and throttles badly as one request stream; fetching it a calendar year at a time in parallel and concatenating the files is materially faster and produces the identical tape. Session counts reproduce doc 50 exactly — **2,659 SPY sessions and 2,657 TSLA sessions** — which is the check that the tape is the same one ADR-0018 and doc 50 were computed from.

The script keeps the `18-` prefix rather than a `51-`: it belongs to the ADR-0018 evidence family and imports directly from `18-threshold-study.py` and `18-entry-time-brackets.py`. The `50`–`59` banding rule is scoped to `NN-slug.md`, per doc 50's own numbering note.
