# Is realised range at the arming instant a usable session filter?

**Ticket:** [#787](https://github.com/dd-jp/samurai-trading-system/issues/787), split out of [#708](https://github.com/dd-jp/samurai-trading-system/issues/708).
**Generator:** [`51-realised-range-session-filter.py`](51-realised-range-session-filter.py) (extends `18-threshold-study.py` and `18-entry-time-brackets.py`; the simulation engine is theirs, unchanged).
**Horizon:** ADR-0014 intraday, flat by close. **Bracket:** ADR-0018 D4, frozen — nothing here tunes it.
**Status:** PENDING RUN.

> Sections are in the order #787 requires: the question, the pre-registered rule and its
> threshold candidates, the declared trial count, the in-/out-of-sample split, the
> adopt/reject bar **stated before the result**, then the result, then the limitations.
> Sections 1–5 were written and committed to before any out-of-sample number was computed.

## 1. The question

#708 rejected conditioning the **bracket** on entry time and realised range: re-solving the
stop per cell beat the declared bracket by at most 0.56 pp against standard errors of
0.44–2.16. That verdict stands and is not revisited here.

The question left over is about the **sessions**, not the bracket. Holding the bracket frozen
at ADR-0018's declared geometry, does **declining to arm at all** on sessions that have not
yet moved lower the accuracy bar the debate layer has to clear — out of sample, by enough to
matter, and without doing more damage through lost trades and a worse drawdown than it buys
in per-trade edge?

The quantity being moved is ADR-0018's **required edge**:

```
bar = (cost − E_gross) / (take_profit + |stop|) × 100      [percentage points of directional
                                                            accuracy over a coin flip]
```

**Why the #708 table is not the answer.** #708 published a quiet/busy split on 3× single-stock
that looks decisive (8.83 pp against 1.20 pp at `t0 = 30`). #787 forbids re-using it, and is
right to: it is a by-product of a study designed for a different question, with ~300 sessions a
cell, five entry offsets that are the same ~897 sessions shifted by 15 minutes (closer to one
observation than five), and a collapse at `t0 = 60` that no mechanism explains. Section 6.4
recomputes those exact cells as a **reproduction check**, and reports whether they reproduce —
either answer is a finding.

## 2. The pre-registered rule

**The rule, stated so it is evaluable at the arming instant.** At the arming instant, compute

```
R = (session high so far − session low so far) / session open × 100
    ─────────────────────────────────────────────────────────────
    mean full-session range of the previous 20 sessions, same units
```

and **arm only if `R ≥ θ`**. Both legs are percentages of the session open in underlying terms,
so the 3× leverage factor cancels and `R` is comparable across names and subclasses.

**Acid test for look-ahead, which this rule passes:** a reader sitting at the arming instant can
evaluate `R` from that session's bars so far plus the previous 20 completed sessions. Nothing in
it needs the rest of the session, the rest of the sample, or where this session lands in a
distribution that has not happened yet. This is what rules out #708's tercile framing: at 15:00
London you do not know whether today is a top-tercile day of 2016–2026.

The denominator is `range_ratios()` in `18-entry-time-brackets.py`, reused unchanged. Its
20-session history is appended to strictly **after** the norm is taken, so the norm never
contains the session it is normalising — verified by reading the function, not assumed.

**The arming instant is a single fixed offset: `t0 = 30` minutes past the 09:30 ET open.** This
is inherited, not searched: #706 arms in the 14:30–15:45 London window (`t0 ∈ [0, 75]`) and 30 is
its midpoint. One instant per session is the direct fix for #708's five-overlapping-offsets
problem — every session contributes exactly one observation per name. Other offsets appear in
§6.5 as fenced post-hoc sensitivity that cannot flip the verdict.

**Threshold candidates.** Three, per subclass, taken as quantiles of the **in-sample** `R`
distribution at 1/3, 1/2 and 2/3 — i.e. "arm on the top two-thirds / top half / top third of
sessions by realised range so far". The quantiles are converted to **absolute numbers** on the
in-sample data and those absolute numbers are what get applied out of sample.

*Disclosed in-sample use, not a limitation:* the candidate values are placed by looking at the
in-sample distribution of `R`, so that each candidate retains a meaningful share of sessions.
That uses in-sample data only and never touches the out-of-sample tape. The resulting absolute
thresholds are printed in §6.1.

**In-sample selection criterion, declared:** the candidate with the **lowest in-sample required
edge**. With the bracket frozen, width and cost are constants, so this is identical to "highest
in-sample gross expectancy". No other criterion is computed and none is consulted.

## 3. Declared trial count

**6 declared trials: 3 thresholds × 2 subclasses.**

Not trials, and why:

| Fixed thing | Where it comes from |
|---|---|
| Bracket geometry (+2.00/−2.16 index, +6.00/−6.25 single-stock; costs 0.18%/0.41%) | ADR-0018 D3/D4 — frozen, #787 forbids tuning it |
| Arming instant `t0 = 30` | #706's window midpoint |
| 20-session range lookback | `18-entry-time-brackets.py`, unchanged |
| IS/OOS split at 2022/2023 | `18-threshold-study.py`, unchanged |
| Selection criterion | Declared in §2 above |
| Flatten at 16:25 London | ADR-0014 / #657 |

The `t0` sensitivity rows in §6.5 are **post-hoc and excluded by construction** — they are
reported because #787 asks specifically about #708's unexplained `t0 = 60` collapse, and they
are labelled so that they cannot be read as additional searched configurations.

**Multiple-testing consequence.** Doc 13's chain is the standard this repo holds: PBO 0.85
against a 0.05 line with 3 of 24 configurations surviving out of sample is what an unaccounted
grid buys. 6 trials is deliberately small. The MinBTL budget for the sample length is computed
by the script (`minbtl_limit()`, mirroring `overfitting.ts`) and reported in §6.6; the run states
whether 6 is inside it rather than asserting that it is. Note that MinBTL is the weaker of the
two constraints here — §5's requirement that the effect exceed twice its **date-clustered**
standard error is what actually binds, because the trial count is small and the correlation
across names on the same date is not.

## 4. In-sample / out-of-sample split

Inherited from `18-threshold-study.py`, unchanged: **in-sample ≤ 2022, out-of-sample ≥ 2023**.
The threshold is chosen on in-sample data only and applied unchanged out of sample. In-sample and
out-of-sample results are reported separately and are never pooled.

Per-name session counts on both sides of the split are printed in §6.1, because the name mix is
not the same on both sides — PLTR did not list until September 2020.

## 5. The adopt/reject bar — declared before the result

**All four conditions must hold out of sample. Any one failing is a REJECT.**

1. **Required-edge reduction ≥ 1.00 pp.** Anchored to what the repo already knows: doc 50's
   truncated declared-bracket bars are 4.19 pp (index) and 3.85 pp (single-stock), and #708
   rejected bracket conditioning at ≤ 0.56 pp. A filter that removes a third of the trade count
   has to buy more than that to be worth the loss.
2. **Reduction ≥ 2× its date-clustered standard error.** Clustering is on the ET session date:
   five single-stock names on one date are one market shock, not five draws. The naive
   `sd/√n` is reported beside it so the inflation factor is visible.
3. **Out-of-sample max drawdown not worse than filter-off**, on the same calendar.
4. **The filter retains ≥ 60% of unfiltered trades.** #787 notes a filter of this kind cuts
   roughly a third; below 60% retention the filter is a different, much smaller strategy and its
   per-trade edge is not comparable.

**Stated explicitly:** a reduction that is positive but under condition 2 is a **REJECT** — it is
indistinguishable from noise, and reporting it as a win is exactly the error #708's table invites.

**Two things the design says before the result, so the null is interpretable.**

*The comparison is a subset comparison, and its standard error is exact arithmetic.* The
filter-on arm is a subset of filter-off, so differencing their standard errors would be wrong.
With `w` the armed fraction and `W` the bracket width,

```
bar_off − bar_on = (1 − w) × (E_armed − E_unarmed) / W × 100
```

which reduces the headline to a two-sample gross-expectancy gap between **disjoint** sets. The
script computes the reduction both ways and asserts they agree.

*Cost cancels from the headline.* `bar = (cost − E_gross)/W`, and both arms share `cost` and `W`,
so the on/off **delta** is invariant to the 0.18% / 0.41% spread assumptions. #666's open question
about real spreads moves the **absolute** bars in §6 but cannot move the verdict. (This is a
method note, not a limitation.)

*Minimum detectable effect, computed from in-sample dispersion before the out-of-sample arm is
scored.* §6.2 reports the smallest bar reduction this design could detect at 80% power / 5%
two-sided, and the armed-vs-unarmed gross gap a 1.00 pp reduction would require. If the MDE
exceeds the adopt bar, a null result means **"not measured"**, not **"nothing there"**, and the
document says so rather than dressing an underpowered null as a finding.

## 6. Result

PENDING RUN

## 7. Limitations

PENDING RUN
