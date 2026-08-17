# Entry-time-conditional brackets, and the ladder priced under truncation

**R2 — [#708](https://github.com/dd-jp/samurai-trading-system/issues/708), under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703). Measured 2026-08-17.**

> **Numbering, flagged not hidden.** `README.md`'s scheme wants a unique number per live
> doc, and the `10`–`19` strategy band is **full**. This doc takes the `18-` prefix
> deliberately, joining the doc-18 / ADR-0018 evidence family it extends (which already
> shares the number across four `18-*.py` scripts) — but that collides with
> `18-intraday-instrument-physics.md`, which is a live doc, not a script. The ruling is
> David's: extend the band, or archive docs 10/12, which `CLAUDE.md` and the README
> already call superseded on horizon. Tracked as
> [#786](https://github.com/dd-jp/samurai-trading-system/issues/786).

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

> **The adopt-if's bar was itself wrong, and the measurement found it.** Both figures
> named above are ADR-0018's, computed on an untruncated full session, so comparing a
> truncated out-of-sample cell against them moves three things at once. The table is
> preserved as declared; the verdict is stated against a per-cell comparator built
> during the run and explained under "The 21 cells". Two further pre-registration
> defects surfaced the same way — `t0 = 0` and `t0 = 120` are not measurable cells —
> and are recorded there rather than quietly dropped.

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

**The required-edge row is algebra, not a test.** `cost / (TP + |stop|)` over three
declared constants cannot disagree with the ADR that declared them; it is shown for
completeness and carries no evidential weight. The row that *is* a test is `resolves`,
which is measured off the tape, and it reproduces: the one discrepancy is 0.1 pp on the
index (48.7 measured against 48.8 recorded). The discrepancy is not caused by
anything in this change: the series is proven element-wise identical to the pre-change
function, so it predates #708 and is most likely the session-length filter that
`load_sessions` gained after doc 18 was written. Not chased further.

## The 21 cells — of which 15 are measurable

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
could not even be solved (35–43 in-sample entries each). That is one of **two
pre-registration defects found by the measurement**. The other is at the opposite end:
at `t0 = 0` no bars have elapsed, so realised range is identically zero and the tercile
is undefined **by construction, not by sample** — those three cells were never
measurable either. The declared grid was 21 cells per subclass, of which **15 are
estimable**: 6 per subclass (two offsets × three terciles) are unmeasurable, leaving
30 of the 42 declared cells across both subclasses. `t0 = 90` is reported but also sits
outside the window.

Each cell also carries its own **`bar`** — the *declared* bracket, priced on **that
cell's own sessions at that cell's own offset**. `vs bar` is `edge − bar`, negative
where re-solving the stop helped. This column is what the study turns on, and it is
worth being explicit about why it exists. A cell can look cheap for two quite different
reasons: because conditioning bought a genuinely better bracket, or because its
sessions simply travel further and so lose less to the flatten. A single pooled
comparator cannot tell those apart — busy sessions resolve more often, so they would
look cheap under the second reason alone, which is only
[#635](https://github.com/dd-jp/samurai-trading-system/issues/635)'s
low-range-days-don't-travel result in new clothes. Holding the slice and the offset
fixed and varying **only the bracket** isolates the part the conditioning actually
bought, which is the thing #708 proposed.

### 3× index ETP

| t0 | tercile | n | stop | resolves | edge pp | ± SE | bar | vs bar | in win |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | POOLED | 897 | −2.31% | 19.4% | 4.11 | 0.97 | 4.19 | −0.09 | yes |
| 15 | quiet | 361 | −2.29% | 8.6% | 2.49 | 1.20 | 2.50 | −0.01 | yes |
| 15 | normal | 290 | −1.98% | 18.6% | 6.45 | 1.71 | 6.14 | +0.31 | yes |
| 15 | busy | 246 | −2.18% | 30.1% | 2.29 | 2.04 | 2.22 | +0.06 | yes |
| 15 | **POOLED** | 897 | −2.18% | 16.9% | **3.61** | 0.92 | 3.60 | +0.01 | yes |
| 30 | quiet | 348 | −2.52% | 6.3% | 4.95 | 1.14 | 5.18 | −0.22 | yes |
| 30 | normal | 277 | −2.55% | 8.3% | 4.22 | 1.38 | 4.35 | −0.13 | yes |
| 30 | busy | 272 | −2.15% | 23.9% | 3.05 | 1.84 | 3.07 | −0.03 | yes |
| 30 | **POOLED** | 897 | −2.37% | 12.2% | **4.22** | 0.83 | 4.28 | −0.07 | yes |
| 45 | quiet | 293 | −2.76% | 1.0% | 3.92 | 0.91 | 4.48 | −0.56 | yes |
| 45 | normal | 307 | −2.58% | 5.2% | 4.02 | 1.15 | 4.41 | −0.39 | yes |
| 45 | busy | 297 | −2.28% | 12.1% | 4.09 | 1.42 | 4.04 | +0.05 | yes |
| 45 | **POOLED** | 897 | −2.45% | 6.4% | **4.19** | 0.69 | 4.31 | −0.12 | yes |
| 60 | quiet | 290 | −2.26% | 1.7% | 4.28 | 0.92 | 4.35 | −0.07 | yes |
| 60 | normal | 305 | −2.67% | 3.0% | 4.24 | 0.99 | 4.76 | −0.52 | yes |
| 60 | busy | 302 | −2.28% | 7.9% | 4.06 | 1.27 | 4.10 | −0.04 | yes |
| 60 | **POOLED** | 897 | −2.40% | 4.7% | **4.24** | 0.62 | 4.41 | −0.17 | yes |
| 90 | quiet | 280 | −2.39% | 0.4% | 3.42 | 0.62 | 3.67 | −0.25 | no |
| 90 | normal | 321 | −1.84% | 1.9% | 5.13 | 0.76 | 4.60 | +0.52 | no |
| 90 | busy | 296 | −2.19% | 4.1% | 2.76 | 0.95 | 2.78 | −0.02 | no |
| 90 | POOLED | 897 | −2.22% | 1.7% | 3.64 | 0.44 | 3.71 | −0.07 | no |

### 3× single-stock ETP

| t0 | tercile | n | stop | resolves | edge pp | ± SE | bar | vs bar | in win |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | POOLED | 897 | −6.52% | 59.5% | 3.77 | 1.36 | 3.85 | −0.08 | yes |
| 15 | quiet | 247 | −6.29% | 36.8% | 6.40 | 2.16 | 6.42 | −0.02 | yes |
| 15 | normal | 338 | −6.09% | 41.4% | 6.85 | 1.97 | 6.94 | −0.09 | yes |
| 15 | busy | 312 | −5.91% | 48.7% | 0.22 | 2.16 | −0.09 | +0.31 | yes |
| 15 | **POOLED** | 897 | −6.12% | 42.5% | **4.32** | 1.21 | 4.35 | −0.03 | yes |
| 30 | quiet | 256 | −6.39% | 23.8% | 8.62 | 1.84 | 8.83 | −0.22 | yes |
| 30 | normal | 347 | −6.22% | 32.3% | 2.28 | 1.78 | 2.14 | +0.14 | yes |
| 30 | busy | 294 | −6.64% | 35.4% | 1.03 | 1.99 | 1.20 | −0.17 | yes |
| 30 | **POOLED** | 897 | −6.41% | 30.8% | **3.65** | 1.09 | 3.74 | −0.09 | yes |
| 45 | quiet | 240 | −6.36% | 12.9% | 7.42 | 1.60 | 7.48 | −0.06 | yes |
| 45 | normal | 357 | −6.09% | 19.3% | 3.39 | 1.48 | 3.17 | +0.22 | yes |
| 45 | busy | 300 | −5.98% | 26.7% | 1.16 | 1.87 | 1.17 | −0.00 | yes |
| 45 | **POOLED** | 897 | −6.16% | 19.8% | **3.70** | 0.96 | 3.65 | +0.04 | yes |
| 60 | quiet | 256 | −6.20% | 10.2% | 2.75 | 1.47 | 2.75 | −0.01 | yes |
| 60 | normal | 332 | −7.36% | 6.6% | 4.20 | 1.21 | 4.70 | −0.49 | yes |
| 60 | busy | 309 | −6.00% | 17.5% | 1.84 | 1.60 | 1.72 | +0.12 | yes |
| 60 | **POOLED** | 897 | −6.49% | 11.5% | **3.07** | 0.83 | 3.12 | −0.05 | yes |
| 90 | quiet | 258 | −6.39% | 2.3% | 2.50 | 0.94 | 2.52 | −0.02 | no |
| 90 | normal | 333 | −8.35% | 1.5% | 2.16 | 0.76 | 2.48 | −0.32 | no |
| 90 | busy | 306 | −6.10% | 3.6% | 1.09 | 1.05 | 1.08 | +0.01 | no |
| 90 | POOLED | 897 | −6.63% | 2.2% | 1.97 | 0.54 | 2.01 | −0.05 | no |

The pooled comparators, for reference, are **4.19 pp** index and **3.85 pp**
single-stock — the declared bracket at `t0 = 0` over the whole out-of-sample, truncated
at 16:25. Note the two subclasses move in **opposite directions** under truncation:
the index bar *falls* from ADR-0018's 4.33 pp, the single-stock bar *rises* from
3.35 pp. Section "Why the two subclasses move opposite ways" below explains why, and
neither figure should be used to judge an individual cell — that is what the per-cell
`bar` column is for.

### What the terciles do and do not show

**Conditioning the bracket buys nothing. This is the study's result, and it is not a
close call.** Read the `vs bar` column down both tables. Across all 42 rows the
re-solved bracket beats the declared one by at most **0.56 pp** (index `t0 = 45`
quiet), the median improvement is under 0.1 pp, and eight cells come out *worse*. Set
that against the standard errors in the neighbouring column — 0.44 to 2.16 pp. The
entire effect #708 proposed to harvest is an order of magnitude smaller than the noise
on measuring it, at every offset, in every tercile, on both subclasses.

**The large tercile spread is real, and it is not the brackets.** The spread is
genuinely striking — single-stock `t0 = 15` runs quiet 6.40, normal 6.85, busy 0.22;
`t0 = 30` quiet needs 8.62 pp against busy's 1.03. Read as cell edges alone, that looks
like a strong conditional signal, and an earlier draft of this document read it that
way. But the `bar` column tracks it almost exactly: 6.42 / 6.94 / −0.09 at `t0 = 15`,
8.83 against 1.20 at `t0 = 30`. **The declared bracket is just as cheap on those
sessions.** Busy sessions need less accuracy edge because they travel further and so
lose less to the flatten — they resolve 48.7% against quiet's 36.8% at `t0 = 15` — and
that is [#635](https://github.com/dd-jp/samurai-trading-system/issues/635)'s result,
already known, not a bracket schedule. Re-solving the stop on top of it adds nothing.

This is why the per-cell comparator had to be built. Judged against a single pooled
bar, the single-stock busy cells (0.22 / 1.03 / 1.16 / 1.84 pp against a 3.85 pp pooled
bar) look like a 2–3 sigma conditional edge and the honest verdict would have been
*not proven*. Holding the sessions fixed and varying only the bracket collapses that to
+0.31 / −0.17 / −0.00 / +0.12. The apparent effect was the comparator, not the market.

**The tercile axis would not have been separable anyway.** Even taking the cell edges
at face value, the terciles are disjoint session sets, so a quiet-to-busy difference is
unpaired with SE `√(1.20² + 1.71²) ≈ 2.1` at index `t0 = 15`; the ordering does not
survive to the next offset, where `t0 = 45` gives 3.92 / 4.02 / 4.09, three numbers
inside a tenth of each other. And the five offsets are **not five tests** — same 897
sessions, entry shifted fifteen minutes — so the effective number of independent
observations here is nearer one than five. At ~300 trades a cell, a cell bar carries
roughly ±1–2 pp, the same size as the whole spread being interpreted.

**Truncation is the dominant effect, and it is large.** Resolution collapses with the
holding window, monotonically and unambiguously. Holding the bracket fixed at the
declared level so the comparison is like-for-like: index **48.7% untruncated → 21.2%**
once the 16:25 flatten binds, single-stock **71.6% → 61.2%**. Pushing the entry later
compounds it — the index cells resolve 6.4% at `t0 = 45` and 4.7% at `t0 = 60`,
single-stock 19.8% and 11.5%. By `t0 = 45` the index bracket is decorative: nineteen
trades in twenty are closed at market having reached neither level, paying the full
round trip. This is the outcome ADR-0018's derivation omits entirely.

### Why the two subclasses move opposite ways

Truncation moves the index bar **down** (4.33 → 4.19 pp) and the single-stock bar
**up** (3.35 → 3.85 pp). The sign is carried entirely by gross expectancy under the
flatten: index `E_gross` is **+0.0055%**, single-stock **−0.0619%**. Required edge is
`(cost − E_gross) / width`, so a negative `E_gross` *adds* to what the signal must
supply. Flattening an index position at 16:25 is close to free — the distribution it
interrupts is near-symmetric. Flattening a 3× single-stock position is not: those
sessions are cut off mid-move often enough, and asymmetrically enough, that the forced
exit itself costs about 6 bp a trade before any spread is paid.

This asymmetry is the most durable thing the study found, and it was invisible before
the comparator was truncated — both ADR-0018 figures are computed on a full session.
It matters beyond #708: any decision that prices the single-stock subclass off an
untruncated bracket is understating what the signal has to deliver, by roughly half a
percentage point of directional accuracy.

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

**#654's dead stop, measured.** A +2.00 / −0.50 bracket on this tape, under the same
truncation, stops out on 62.7% of sessions and needs **6.38 pp** of accuracy edge.

Two things this is *not*. It is not a new withdrawal of #654's ≥ 8.00 pp figure —
**ADR-0018 §D5 already withdrew that on 2026-08-16** (line 147), along with the
≥ 18.2 pp single-stock companion, because both were computed by running a *ladder*
width through `cost / (TP + |stop|)`. That withdrawal stands and is not re-litigated
here. Nor does 6.38 pp contradict the **> 12 pp** floor the ADR derived in its place:
that floor is stated for the **neutral** bracket carrying a −0.5% stop, whose
take-profit partner is strictly below +1.0% and whose width is therefore under 1.5%.
The configuration measured here is #654's literal asymmetric +2.00 / −0.50, width
2.5%, which is a different object and necessarily a lower bar. Both are correct about
their own bracket.

What this measurement adds is only that the configuration is dead **on the tape as
well as in the algebra** — 6.38 pp sits far above the 4.19 pp the declared single
bracket needs on the same sessions.

## Selection accounting

ADR-0018 D4 requires the trial count be declared and checked against MinBTL. Using the
same formula the codebase implements (`server/tools/backtest/overfitting.ts:185-254`,
López de Prado AFML ch. 8, target annual Sharpe 1):

| | |
| --- | --- |
| declared cells per subclass | 21 (7 offsets × 3 terciles) |
| of which measurable | 15 (`t0 = 0` terciles undefined; `t0 = 120` past the flatten) |
| subclasses | 2 |
| **total trials declared** | **42** (30 measurable) |
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

The pre-registered adopt-if named **4.33 pp** index / **3.35 pp** single-stock. Both
are ADR-0018 figures computed **untruncated and full-sample**, so judging a truncated
out-of-sample cell against either moves truncation, sample period and conditioning at
once. The pre-registration is reported as declared, but the verdict is stated against
the **per-cell** comparator described above — the declared bracket on each cell's own
sessions at its own offset — which is both the fairer test and, on the single-stock
subclass, the harsher one.

- **Both subclasses: the conditioning buys nothing.** `vs bar` never exceeds 0.56 pp
  in either direction across all 42 rows, against standard errors of 0.44–2.16, and
  eight cells are actively worse. The sharpest single measurement is the index
  `t0 = 0` pooled cell, which re-solves the stop to −2.31% and **buys 0.08 pp** (4.11
  against 4.19) on an SE of roughly 0.7. Nothing in the grid does better. This
  conclusion does not depend on cell size: it holds at the ~900-trade pooled marginals
  as firmly as at the ~300-trade cells.
- **The tercile spread that looked like a signal is session selection, not bracketing.**
  Single-stock busy cells need 0.22 / 1.03 / 1.16 / 1.84 pp, which against a pooled
  3.85 pp bar reads as a 2–3 sigma conditional edge. On their own sessions the
  *declared* bracket needs −0.09 / 1.20 / 1.17 / 1.72. The cheapness belongs to the
  days, not to the stop, and #635 already established that busy days travel.
- **The conditioning axis would not be estimable in any case** at ~300 trades a cell,
  and the five offsets are one overlapping observation rather than five independent
  ones. Adopting a 21-cell schedule whose cells cannot be told apart would be fitting
  noise with a pre-registration wrapped round it.
- **Entering later does not help either.** Single-stock in-window pooled marginals run
  3.77 / 4.32 / 3.65 / 3.70 / 3.07 against per-cell bars of 3.85 / 4.35 / 3.74 / 3.65 /
  3.12 — flat. Mid-session entry is neither cheaper nor dearer than open entry once the
  comparator moves with it.

The pre-registration's stated response to a higher number is the one that applies:
**enter as close to 14:30 London as the signal allows** — do not widen the bracket until
the number looks acceptable. The measured basis for that is the resolution collapse, not
the required-edge levels: an index bracket that resolves 21.2% at `t0 = 0` and 4.7% at
`t0 = 60` stops being a bracket and becomes a hold-to-flatten, and the take-profit that
ADR-0018 sized against a full session is doing almost no work inside a two-hour one.

Four findings for the record, none of them the one the ticket anticipated:

1. **Truncation is the large effect and it is unfavourable.** Flat-by-close at 16:25
   London is not a detail on top of ADR-0018 — it removes most of the bracket's
   resolution. Any future sizing work on the intraday path should be computed under the
   flatten, not adjusted after the fact.
2. **The two subclasses respond to truncation with opposite sign** — index `E_gross`
   +0.0055% against single-stock −0.0619%, moving the bars to 4.19 pp and 3.85 pp from
   ADR-0018's 4.33 and 3.35. The forced exit is roughly free on an index and costs about
   6 bp a trade on a 3× single stock. This is the most durable result here and it
   generalises past #708: pricing the single-stock leg off an untruncated bracket
   understates the bar by about half a percentage point of accuracy.
3. **The ladder does not beat the single bracket** under truncation (t = −0.20, paired,
   n = 897), even costed generously. #704's truncation argument is answered.
4. **#654's literal +2.00 / −0.50 measures 6.38 pp** on this tape. That is consistent
   with — not a correction to — ADR-0018 §D5's derived **> 12 pp** floor, which is
   stated for the *neutral* −0.5%-stop bracket, a narrower and therefore dearer object.
   §D5 already withdrew the old ≥ 8.00 pp figure on 2026-08-16; this document does not
   re-withdraw it.

### Not measured here

The required-edge bar is a property of the *instrument and the window*. Nothing in this
doc says the system can clear it — that is the open question ADR-0018 states and this
study does not touch. What it does establish is that the bar does not get easier by
conditioning the **bracket** on time-of-day or realised range, so that avenue is closed.

One avenue this study deliberately does **not** close: conditioning the **entry
decision** rather than the bracket. The tercile column shows single-stock busy sessions
needing 0.22–1.84 pp where quiet sessions need 6.40–8.62, and that gap survives on the
declared bracket — it is a property of which days you trade, not which stop you set.
Whether trading only high-realised-range sessions is a usable filter is a separate
question with its own selection problem (the gap is measured on ~300-session cells over
five overlapping offsets), and it belongs to a separate ticket. Nothing here supports
acting on it as it stands.

## Reproducing

```bash
SAMURAI_DATA_DIR=<dir> python3 docs/research/18-fetch-bars.py SPY  2016-01-04T00:00:00Z 2026-08-01T00:00:00Z 5Min
SAMURAI_DATA_DIR=<dir> python3 docs/research/18-fetch-bars.py TSLA 2016-01-04T00:00:00Z 2026-08-01T00:00:00Z 1Min
SAMURAI_DATA_DIR=<dir> python3 docs/research/18-entry-time-brackets.py
```
