# Entry-time-conditional brackets, and the ladder priced under truncation

**R2 — [#708](https://github.com/dd-jp/samurai-trading-system/issues/708), under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703). Measured 2026-08-17.**

> **Numbering, flagged not hidden.** `README.md`'s scheme wants a unique number per live
> doc, and the `10`–`19` strategy band is **full**. This doc takes the `18-` prefix
> deliberately, joining the doc-18 / ADR-0018 evidence family it extends (which already
> shares the number across four `18-*.py` scripts) — but that collides with
> `18-intraday-instrument-physics.md`, which is a live doc, not a script. The ruling is
> David's: extend the band, or archive docs 10/12, which `CLAUDE.md` and the README
> already call superseded on horizon.

Extends Result 4 of [`18-intraday-instrument-physics.md`](18-intraday-instrument-physics.md), which closes with its own limitation:

> Reach rates are computed from the daily open. A strategy entering on an indicator later in the session faces a different — and probably worse — conditional distribution.

[ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md)'s neutral brackets assume **entry at the 09:30 ET open and a hold to the 16:00 ET close**. The system as designed does neither: [#706](https://github.com/dd-jp/samurai-trading-system/issues/706) arms entries **14:30–15:45 London** and flattens at **16:25 London**, the LSE close less [#657](https://github.com/dd-jp/samurai-trading-system/issues/657)'s five minutes. In ET that is entry between **09:30 and 10:45**, forced flat at **11:25** — the position lives inside a two-hour window, not a six-and-a-half-hour one.

So there are two unmeasured things, and this doc measures both in one run.

## Pre-registration — stated before the result

| | |
| --- | --- |
| **Rule** | The bracket rule is unchanged: **the stop at which take-profit and stop are equally likely to be hit first**. The take-profit stays at ADR-0018's declared level (+2.00% index, +6.00% single-stock); only the stop is re-solved. |
| **Cells** | 21 per subclass: `t0 ∈ {0, 15, 30, 45, 60, 90, 120}` minutes past the US open × realised-range terciles `{quiet, normal, busy}`. |
| **Split** | Inherited from `18-threshold-study.py:187-188` — in-sample ≤ 2022, out-of-sample ≥ 2023. Stops are solved **in-sample** and scored **out-of-sample**. |
| **Adopt if** | The out-of-sample required edge, **in the cells we actually enter in**, is below the bar: **4.33 pp** index / **3.35 pp** single-stock — the exact bars on the neutral single bracket. **Never against 4.60 pp**, which [#704](https://github.com/dd-jp/samurai-trading-system/issues/704) withdrew. |
| **If it comes out higher** | The conclusion is that mid-session entry is genuinely harder than open entry, and the response is to **enter as close to 14:30 as the signal allows** — *not* to widen the bracket until the number looks acceptable. |

Nothing is selected. Each cell re-solves the same declared condition on a different conditioning slice, and no cell is picked for its result. That is ADR-0018 D4's re-calibration, not re-selection — the selection accounting is reported anyway, at the end.

## Method

`docs/research/18-entry-time-brackets.py`, on the same tape ADR-0018 was computed from: Alpaca SIP, 2016-01-04 → 2026-07-31, regular hours, **SPY 5-minute (2,659 sessions)** and **TSLA 1-minute (2,657 sessions)**. Costs are ADR-0016's round trips, 0.18% index and 0.41% single-stock.

Three additions to `18-threshold-study.py`, all of which leave an unparameterised call unchanged:

1. **`t0`** — entry at the open of the first bar at or after 09:30 ET + `t0`.
2. **`flatten`** — a `date → ET minute` at which a position that has reached neither level is **closed at market, paying the full round trip**. This outcome is absent from ADR-0018's derivation and is precisely the one the ladder claims to improve.
3. **A tranche vector over a shared stop**, for the rider.

The flatten is held in **London wall-clock and converted per date**, not hardcoded as an ET minute. The UK and US switch daylight saving on different weekends, so for about three weeks a year the offset is four or six hours rather than five; a fixed ET minute would silently move the flatten inside the session on exactly those days.

**The conditioning variable.** Realised range from the open to the entry instant, over the trailing 20-session mean full-session range. Both legs are percentages of that session's open in underlying terms, so leverage cancels. The denominator uses **strictly prior sessions**, and the tercile boundaries are **frozen on the in-sample days and applied unchanged out-of-sample** — re-cutting them on the later sample would be a free parameter fitted on the data the result is judged against.

**The required edge.** Generalised from ADR-0018's `cost / width`, which is exact only where the bracket resolves every trade:

```
Δ = (cost − E_gross) / width
```

Under a signal that lifts P(take-profit first) by δ and drops P(stop first) by δ, expectancy moves by `δ · width`, so breakeven is at `Δ`. Where truncation makes `E_gross ≠ 0` — a close-out is now a realised outcome rather than a non-event — the `E_gross` term is what the width formula omits. At a bracket that resolves everything and is exactly neutral, `E_gross = 0` and this reduces to `cost / width` identically.

## The control — `t0 = 0` reproduces ADR-0018

Asserted in code, not eyeballed: passing `flatten=` forces the new filtering branch, so `t0 = 0` with a flatten past the close must return a series **element-wise identical** to an unparameterised call. It does, for both subclasses, including the outcome counts.

| | index (SPY 5Min) | single-stock (TSLA 1Min) |
| --- | --- | --- |
| sessions | 2,659 | 2,657 |
| series identical to unparameterised call | **PASS** | **PASS** |
| resolves | 48.7% (doc 18 records 48.8%) | 71.6% (records 71.6%) |
| P(tp first) / P(sl first) | 24.4% / 24.3% | 35.9% / 35.8% |
| expectancy | −0.1474%/trade | −0.4892%/trade |
| **required edge** | **4.33 pp** (records 4.33 pp) | **3.35 pp** (records 3.35 pp) |

Both reproduce. The one discrepancy is 0.1 pp on the index resolution rate (48.7 measured
against 48.8 recorded); the required-edge figures — the numbers ADR-0018 actually rests
on — match to the stated precision on both subclasses. The discrepancy is not caused by
anything in this change: the series is proven element-wise identical to the pre-change
function, so it predates #708 and is most likely the session-length filter that
`load_sessions` gained after doc 18 was written. Not chased further.

## The 21 cells — of which 18 are measurable

Out-of-sample only (897 sessions, ≥ 2023). Take-profit held at the declared level;
only the stop is re-solved, in-sample, per cell. `n` counts **trades, not days** —
past the flatten there is no entry at all. `SE` is the standard error of the required
edge, and it is a **lower bound**: it treats the stop as known, when in fact the stop
was solved on ~300 in-sample sessions and carries its own error into the width
denominator. "in win" is whether the entry instant falls inside #706's 14:30–15:45
London window.

**`t0 = 120` is not a tradeable configuration and is excluded from the verdict.**
Entry at 11:30 ET is past the 11:25 ET flatten on 2,476 of 2,659 sessions. The 183
sessions that do trade are the three weeks a year when the UK and US disagree about
daylight saving and the LSE close lands at 12:25 ET instead. Its per-tercile stops
could not even be solved (35–43 in-sample entries each). That is a **pre-registration
defect found by the measurement**: the declared grid was 21 cells per subclass, of
which 18 are estimable. `t0 = 90` is reported but also sits outside the window.

### 3× index ETP — bar to beat 4.33 pp

| t0 | tercile | n | stop | resolves | edge pp | ± SE | in win |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | POOLED | 897 | −2.31% | 19.4% | 4.11 | 0.97 | yes |
| 15 | quiet | 361 | −2.29% | 8.6% | 2.49 | 1.20 | yes |
| 15 | normal | 290 | −1.98% | 18.6% | 6.45 | 1.71 | yes |
| 15 | busy | 246 | −2.18% | 30.1% | 2.29 | 2.04 | yes |
| 15 | **POOLED** | 897 | −2.18% | 16.9% | **3.61** | 0.92 | yes |
| 30 | quiet | 348 | −2.52% | 6.3% | 4.95 | 1.14 | yes |
| 30 | normal | 277 | −2.55% | 8.3% | 4.22 | 1.38 | yes |
| 30 | busy | 272 | −2.15% | 23.9% | 3.05 | 1.84 | yes |
| 30 | **POOLED** | 897 | −2.37% | 12.2% | **4.22** | 0.83 | yes |
| 45 | quiet | 293 | −2.76% | 1.0% | 3.92 | 0.91 | yes |
| 45 | normal | 307 | −2.58% | 5.2% | 4.02 | 1.15 | yes |
| 45 | busy | 297 | −2.28% | 12.1% | 4.09 | 1.42 | yes |
| 45 | **POOLED** | 897 | −2.45% | 6.4% | **4.19** | 0.69 | yes |
| 60 | quiet | 290 | −2.26% | 1.7% | 4.28 | 0.92 | yes |
| 60 | normal | 305 | −2.67% | 3.0% | 4.24 | 0.99 | yes |
| 60 | busy | 302 | −2.28% | 7.9% | 4.06 | 1.27 | yes |
| 60 | **POOLED** | 897 | −2.40% | 4.7% | **4.24** | 0.62 | yes |
| 90 | quiet | 280 | −2.39% | 0.4% | 3.42 | 0.62 | no |
| 90 | normal | 321 | −1.84% | 1.9% | 5.13 | 0.76 | no |
| 90 | busy | 296 | −2.19% | 4.1% | 2.76 | 0.95 | no |
| 90 | POOLED | 897 | −2.22% | 1.7% | 3.64 | 0.44 | no |

### 3× single-stock ETP — bar to beat 3.35 pp

| t0 | tercile | n | stop | resolves | edge pp | ± SE | in win |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | POOLED | 897 | −6.52% | 59.5% | 3.77 | 1.36 | yes |
| 15 | quiet | 247 | −6.29% | 36.8% | 6.40 | 2.16 | yes |
| 15 | normal | 338 | −6.09% | 41.4% | 6.85 | 1.97 | yes |
| 15 | busy | 312 | −5.91% | 48.7% | 0.22 | 2.16 | yes |
| 15 | **POOLED** | 897 | −6.12% | 42.5% | **4.32** | 1.21 | yes |
| 30 | quiet | 256 | −6.39% | 23.8% | 8.62 | 1.84 | yes |
| 30 | normal | 347 | −6.22% | 32.3% | 2.28 | 1.78 | yes |
| 30 | busy | 294 | −6.64% | 35.4% | 1.03 | 1.99 | yes |
| 30 | **POOLED** | 897 | −6.41% | 30.8% | **3.65** | 1.09 | yes |
| 45 | quiet | 240 | −6.36% | 12.9% | 7.42 | 1.60 | yes |
| 45 | normal | 357 | −6.09% | 19.3% | 3.39 | 1.48 | yes |
| 45 | busy | 300 | −5.98% | 26.7% | 1.16 | 1.87 | yes |
| 45 | **POOLED** | 897 | −6.16% | 19.8% | **3.70** | 0.96 | yes |
| 60 | quiet | 256 | −6.20% | 10.2% | 2.75 | 1.47 | yes |
| 60 | normal | 332 | −7.36% | 6.6% | 4.20 | 1.21 | yes |
| 60 | busy | 309 | −6.00% | 17.5% | 1.84 | 1.60 | yes |
| 60 | **POOLED** | 897 | −6.49% | 11.5% | **3.07** | 0.83 | yes |
| 90 | quiet | 258 | −6.39% | 2.3% | 2.50 | 0.94 | no |
| 90 | normal | 333 | −8.35% | 1.5% | 2.16 | 0.76 | no |
| 90 | busy | 306 | −6.10% | 3.6% | 1.09 | 1.05 | no |
| 90 | POOLED | 897 | −6.63% | 2.2% | 1.97 | 0.54 | no |

### What the terciles do and do not show

**The tercile axis is not separable at this sample.** Read the index `t0 = 15` row
block: quiet 2.49, normal 6.45, busy 2.29, against standard errors of 1.2–2.0. The
quiet-to-normal gap is 3.96 pp. The terciles are disjoint sets of sessions, so the
difference is unpaired and its SE is `√(1.20² + 1.71²) ≈ 2.1` — under two
standard errors, and with no sign of an ordering that survives to the next offset,
where `t0 = 45` gives 3.92 / 4.02 / 4.09, three numbers inside a tenth of each other.
The single-stock block has the same character with larger errors: `t0 = 15` busy comes
out at 0.22 pp and `t0 = 30` quiet at 8.62 pp, a 8.4 pp spread that no mechanism
predicts and that the errors cannot exclude as sampling noise.

At ~300 trades a cell, a cell bar carries roughly ±1–2 pp, which is the same size as
the entire spread being interpreted. The pooled-by-`t0` marginals — ~900 trades, SE
0.6–1.2 — are the only estimable version of this study, and they are what the verdict
is stated against.

**Truncation is the dominant effect, and it is large.** Resolution collapses with the
holding window, monotonically and unambiguously: index 48.7% untruncated → 19.4% at
`t0 = 0` under the 16:25 flatten → 6.4% at `t0 = 45` → 4.7% at `t0 = 60`. Single-stock
71.6% → 59.5% → 19.8% → 11.5%. By `t0 = 45` the index bracket is decorative: nineteen
trades in twenty are closed at market having reached neither level, paying the full
round trip. This is the outcome ADR-0018's derivation omits entirely.

## The rider — the ladder priced under truncation

[#704](https://github.com/dd-jp/samurai-trading-system/issues/704) withdrew the 4.60 pp
figure but left an argument standing: that a **50/25/25 ladder at +1.00 / +2.00 / +3.00
over a shared −2.16% stop** should beat a single bracket precisely *because* of
truncation — the near tranche banks something on the many sessions that never reach
+2.00%. That argument had never been priced. Both arms below are run on the index
subclass, `t0 = 0`, **both truncated at 16:25 London**, over the same 897 out-of-sample
sessions.

| tranche | weight @ take-profit | E_gross | reached | stopped |
| --- | --- | --- | --- | --- |
| 1 | 50% @ +1.00% | +0.0033% | 37.0% | 10.5% |
| 2 | 25% @ +2.00% | +0.0055% | 9.3% | 11.9% |
| 3 | 25% @ +3.00% | +0.0014% | 2.5% | 11.9% |

| | E_gross | E_net | width | **required edge** |
| --- | --- | --- | --- | --- |
| ladder | +0.0034% | −0.1766% | 3.91% | **4.52 pp** |
| single bracket | +0.0055% | −0.1745% | 4.16% | **4.19 pp** |

Under truncation the single bracket resolves **21.2%** and closes out 78.8%.

**The two are statistically indistinguishable, and that is enough to settle it.** Paired
over the same sessions, the ladder is −0.0022%/trade against the single bracket, SE
0.0106, **t = −0.20** on n = 897. The point estimate runs against the ladder and the
required-edge bar is 0.33 pp higher for it, but at |t| = 0.20 the honest statement is
that the ladder does not beat the single bracket rather than that it loses to it.
Either way #704's own stated terms are met: a ladder that fails to beat the single
bracket means the single bracket stands, and here it adds three exit legs, three
fill assumptions and a partial-position accounting path for no measured gain.

**And it fails under the cost assumption most generous to it.** The model charges the
0.18% round trip once, on full notional, for what is physically three separate exits.
A ladder paying three partial round trips would be strictly worse than the figure
above. The objection that the ladder was under-costed therefore cannot rescue it.

**#654's dead stop does not hold at its claimed bound.** A +2.00 / −0.50 bracket,
measured on this tape under the same truncation, stops out on 62.7% of sessions and
needs **6.38 pp** of accuracy edge — against the **≥ 8.00 pp** lower bound
[#654](https://github.com/dd-jp/samurai-trading-system/issues/654) records. The
recorded figure is wrong in magnitude. The conclusion #654 drew from it survives
— 6.38 pp is still far above the 4.19 pp single bracket and the configuration is
still dead — but the number itself should not be cited as measured.

## Selection accounting

ADR-0018 D4 requires the trial count be declared and checked against MinBTL. Using the
same formula the codebase implements (`server/tools/backtest/overfitting.ts:185-254`,
López de Prado AFML ch. 8, target annual Sharpe 1):

| | |
| --- | --- |
| declared cells per subclass | 21 (7 offsets × 3 terciles) |
| subclasses | 2 |
| **total trials** | **42** |
| sample | 10.6 years |
| **MinBTL supports** | **986 independent trials** |
| verdict | **within budget** |

The count is reported because D4 requires it, but it is not the binding constraint here
and should not be read as clearance. The bracket rule is *declared*, not searched: every
cell re-solves the same neutrality condition on a different conditioning slice, and no
cell is chosen for its result. What actually kills the schedule is per-cell **power**,
not multiplicity — 986 trials of a 300-trade cell each carrying ±1–2 pp is still 986
cells nobody can read.

## Verdict

**REJECT the entry-time-conditional bracket schedule. ADR-0018's single declared
bracket stands unchanged, and no cell-conditional stop is adopted.**

Against the pre-registered adopt-if — *required edge, in the cells we actually enter
in, below 4.33 pp index / 3.35 pp single-stock*:

- **Index: passes on the point estimate, by less than its own error.** Every in-window
  pooled marginal is under the bar — 4.11, 3.61, 4.22, 4.19, 4.24 against 4.33 — but the
  largest margin is 0.72 pp against an SE of 0.92, and the SE is a lower bound. There is
  no offset at which the schedule is measurably better than the declared bracket.
- **Single-stock: fails.** Four of five in-window pooled marginals sit *above* 3.35
  (3.77, 4.32, 3.65, 3.70), with only `t0 = 60` below at 3.07 ± 0.83. Mid-session entry
  is if anything harder than open entry here.
- **The conditioning axis is not estimable at all** at ~300 trades a cell, per the cell
  section above. Adopting a 21-cell schedule whose cells cannot be told apart would be
  fitting noise with a pre-registration wrapped round it.

The pre-registration's stated response to a higher number is the one that applies:
**enter as close to 14:30 London as the signal allows** — do not widen the bracket until
the number looks acceptable. The measured basis for that is the resolution collapse, not
the required-edge levels: an index bracket that resolves 19.4% at `t0 = 0` and 4.7% at
`t0 = 60` stops being a bracket and becomes a hold-to-flatten, and the take-profit that
ADR-0018 sized against a full session is doing almost no work inside a two-hour one.

Three findings for the record, none of them the one the ticket anticipated:

1. **Truncation is the large effect and it is unfavourable.** Flat-by-close at 16:25
   London is not a detail on top of ADR-0018 — it removes most of the bracket's
   resolution. Any future sizing work on the intraday path should be computed under the
   flatten, not adjusted after the fact.
2. **The ladder does not beat the single bracket** under truncation (t = −0.20, paired,
   n = 897), even costed generously. #704's truncation argument is answered.
3. **#654's ≥ 8.00 pp bound is wrong in magnitude** — measured 6.38 pp. The conclusion
   it supported still holds; the figure should not be quoted.

### Not measured here

The required-edge bar is a property of the *instrument and the window*. Nothing in this
doc says the system can clear it — that is the open question ADR-0018 states and this
study does not touch. What it does establish is that the bar does not get easier by
conditioning entry on time-of-day or realised range, so that avenue is closed.

## Reproducing

```bash
SAMURAI_DATA_DIR=<dir> python3 docs/research/18-fetch-bars.py SPY  2016-01-04T00:00:00Z 2026-08-01T00:00:00Z 5Min
SAMURAI_DATA_DIR=<dir> python3 docs/research/18-fetch-bars.py TSLA 2016-01-04T00:00:00Z 2026-08-01T00:00:00Z 1Min
SAMURAI_DATA_DIR=<dir> python3 docs/research/18-entry-time-brackets.py
```
