# Is realised range at the arming instant a usable session filter?

**Ticket:** [#787](https://github.com/dd-jp/samurai-trading-system/issues/787), split out of [#708](https://github.com/dd-jp/samurai-trading-system/issues/708).
**Generator:** [`51-realised-range-session-filter.py`](51-realised-range-session-filter.py) (extends `18-threshold-study.py` and `18-entry-time-brackets.py`; the simulation engine is theirs, unchanged).
**Horizon:** ADR-0014 intraday, flat by close. **Bracket:** ADR-0018 D4, frozen — nothing here tunes it.
**Status:** MEASURED 2026-08-17 — **REJECT on both subclasses**, and the central statistic is
**underpowered**: the minimum detectable effect (2.72 pp index, 1.95 pp single-stock) exceeds the
1.00 pp adopt bar this study declared. Read §6.2 and limitation 1 before citing any number here.
#708's published table **reproduces exactly**, and its unexplained `t0 = 60` collapse now has a
mechanism (§6.5) — but the pre-registered, look-ahead-free version of the same rule does not
survive.

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
so the on/off **delta** is invariant to the 0.18% / 0.41% spread assumptions. A real per-subclass
spread measurement — never delivered; [#666](https://github.com/dd-jp/samurai-trading-system/issues/666)
closed 2026-08-27 out of scope without doing so, and [#750](https://github.com/dd-jp/samurai-trading-system/issues/750)
now gates on it instead with no open ticket delivering it — would move the **absolute** bars in §6
but cannot move the verdict. (This is a method note, not a limitation.)

*Minimum detectable effect, computed from in-sample dispersion before the out-of-sample arm is
scored.* §6.2 reports the smallest bar reduction this design could detect at 80% power / 5%
two-sided, and the armed-vs-unarmed gross gap a 1.00 pp reduction would require. If the MDE
exceeds the adopt bar, a null result means **"not measured"**, not **"nothing there"**, and the
document says so rather than dressing an underpowered null as a finding.

## 6. Result

**REJECT on both subclasses.** Neither clears the four-condition bar of §5, and the one arm that
comes close does so at a `t` of **1.996** against a declared threshold of 2.0 while retaining only
a third of the trades.

### 6.0 Data actually fetched

Alpaca SIP, `adjustment=all`, `2016-01-01 → 2026-08-01`, cached to the gitignored
`docs/research/data/bars/` and never re-fetched. <!-- cite-exempt: untracked — the bars cache is gitignored by design, as this sentence says; it is not in the tree and must not be --> Regular hours (09:30–16:00 ET) are selected at
load time by `18-threshold-study.py`; the fetched files include extended hours, which is why the
row counts exceed the session counts × bars-per-session.

| Symbol | Subclass | Timeframe | Rows fetched | Sessions loaded | First → last |
|---|---|---|---|---|---|
| SPY | index | 5Min | 488,195 | 2,659 | 2016-01-04 → 2026-07-31 |
| QQQ | index | 5Min | 472,817 | 2,657 | 2016-01-04 → 2026-07-31 |
| AAPL | single-stock | 1Min | 1,901,921 | 2,657 | 2016-01-04 → 2026-07-31 |
| MSTR | single-stock | 1Min | 886,865 | **1,551** | 2016-01-08 → 2026-07-31 |
| NVDA | single-stock | 1Min | 1,818,000 | 2,657 | 2016-01-04 → 2026-07-31 |
| PLTR | single-stock | 1Min | 1,160,191 | 1,460 | 2020-10-01 → 2026-07-31 |
| TSLA | single-stock | 1Min | 1,915,076 | 2,657 | 2016-01-04 → 2026-07-31 |

Universe and subclass mapping read from `server/providers/universe-pool/lse-etp-pool.ts`
(`countRankableUnderlyings()` = 7 distinct `screening_instrument` values): **index** = SPY, QQQ;
**single-stock** = AAPL, MSTR, NVDA, PLTR, TSLA.

### 6.1 The frozen thresholds

| Subclass | q=1/3 | q=1/2 | q=2/3 | **Chosen in-sample** |
|---|---|---|---|---|
| 3× index ETP | 0.3150 | 0.3768 | 0.4560 | **0.4560** (IS bar 4.47 pp vs 4.58 unfiltered) |
| 3× single-stock ETP | 0.4360 | 0.5145 | 0.6103 | **0.6103** (IS bar 3.71 pp vs 4.03 unfiltered) |

Both subclasses selected the *tightest* candidate. Read the in-sample columns before treating
that as a signal: the three in-sample reductions were **−0.06 / −0.65 / +0.11 pp** (index) and
**+0.08 / −0.29 / +0.32 pp** (single-stock), against clustered SEs of 0.33–0.97. Two of six are
negative. The selection is picking the largest of six numbers that are all inside noise.

### 6.2 Minimum detectable effect — computed before the out-of-sample arm was scored

| Subclass | Gross gap needed for a 1.00 pp reduction | Clustered SE of the reduction (IS) | **MDE at 80% power / 5% two-sided** |
|---|---|---|---|
| 3× index ETP | 0.0624%/trade | 0.97 pp | **2.72 pp** |
| 3× single-stock ETP | 0.1838%/trade | 0.70 pp | **1.95 pp** |

**Both MDEs exceed the 1.00 pp adopt bar.** A filter that truly delivered exactly the adopt-bar
effect would fail to register here more often than not. This is the single most important number
in the document and it was computed from in-sample dispersion alone, before the out-of-sample arm
was touched.

### 6.3 Out of sample (≥ 2023), thresholds applied unchanged

| | **3× index ETP** | | **3× single-stock ETP** | |
|---|---|---|---|---|
| | filter OFF | filter ON | filter OFF | filter ON |
| Trades | 1,794 | **566** | 4,485 | **1,495** |
| Distinct sessions | 897 | 377 | 897 | 722 |
| Required edge | 3.99 pp | **3.39 pp** | 3.16 pp | **1.30 pp** |
| — clustered SE | 0.95 | 1.84 | 0.73 | 1.14 |
| — naive SE | 0.70 | 1.45 | 0.48 | 0.89 |
| Resolve rate | 22.9% | 35.5% | 31.8% | 37.7% |
| E_net /trade | −0.1660% | −0.1408% | −0.3874% | −0.1595% |
| Per-trade sd | 1.23% | 1.43% | 3.96% | 4.21% |
| Max drawdown (raw) | 150.9 pp | 70.0 pp | 365.1 pp | 217.6 pp |
| Max drawdown (drift-removed) | 23.8 pp | **29.9 pp** | 68.9 pp | **120.0 pp** |
| **Bar reduction** | **+0.60 pp** | | **+1.86 pp** | |
| — clustered SE / `t` | 1.44 / **+0.42** | | 0.932 / **+1.996** | |
| Armed fraction | 31.5% | | 33.3% | |
| E_gross armed / unarmed | +0.0392% / +0.0025% | | +0.2505% / −0.0914% | |

### 6.4 Verdict against the bar declared in §5

| Condition | Index | Single-stock |
|---|---|---|
| 1. reduction ≥ 1.00 pp | **FAIL** (+0.60) | PASS (+1.86) |
| 2. reduction ≥ 2× clustered SE | **FAIL** (t = +0.42) | **FAIL** (t = +1.996) |
| 3. max drawdown not worse (raw, as declared) | PASS | PASS |
| 4. retains ≥ 60% of trades | **FAIL** (31.5%) | **FAIL** (33.3%) |
| | **REJECT** | **REJECT** |

Condition 2 on single-stock misses by **0.0035 of a `t`**. That is stated plainly rather than
rounded to "t = 2.0, adopt": §5 declared before the result that a reduction under the SE bar is a
REJECT, and a threshold that can be crossed by rounding is not a threshold. It is also the
condition most exposed to the trial count — this is the largest of six in-sample candidates
carried forward, so its out-of-sample `t` is optimistically biased by selection even though the
selection happened in-sample.

**Three findings independent of the verdict.**

*The drift-removed drawdown moves the wrong way, in both subclasses.* Raw drawdown falls (150.9 →
70.0 index, 365.1 → 217.6 single-stock) but that is an artefact: unconditional entry at the
declared bracket has negative expectancy by construction, so raw drawdown is essentially
(trades × mean loss) and any filter that trades less wins it automatically. With each arm's own
drift removed the filter is **worse** — 23.8 → 29.9 pp (index) and 68.9 → **120.0 pp**
(single-stock), the latter nearly doubling on a third of the trades. The filter concentrates the
book into the most volatile sessions, which is what it was asked to do; that is a cost, and it is
invisible in a required-edge number. This is exactly the failure mode #787 and `CLAUDE.md`'s
control rule warned about.

*The effect is not stable across neighbouring arming instants.* Same rule, same quantile, 15
minutes either side (post-hoc, fenced):

| Subclass | t0 = 15 | **t0 = 30 (pre-registered)** | t0 = 60 |
|---|---|---|---|
| index | +0.07 pp (t +0.06) | **+0.60 pp (t +0.42)** | −0.63 pp (t −0.96) |
| single-stock | +0.21 pp (t +0.31) | **+1.86 pp (t +2.00)** | +0.21 pp (t +0.39) |

The single-stock effect is nine times larger at the pre-registered instant than 15 or 30 minutes
either side, with no mechanism that would make 10:00 ET special. A real effect driven by "the
session has already moved" should vary smoothly with the arming instant. This does not. It is the
strongest single piece of evidence in the document that the +1.86 pp is sampling noise, and it is
the reason the near-miss on condition 2 should not be re-litigated.

*Most trades never reach a level.* Resolve rates are 22.9–37.7%: between 62% and 77% of trades are
flattened at 16:25 London at whatever price is there. Entry at t0 = 30 leaves roughly 85 minutes
before the flatten, and a ±2% (index) or ±6% (single-stock) underlying move is rarely available in
that window. What is being measured is therefore closer to **85-minute drift conditional on
morning range** than to a bracket outcome. That does answer #787's question — it is the real
instrument at this horizon — but the bracket is barely operative and the document should not be
read as pricing one.

### 6.5 #708's table reproduces exactly — and its unexplained collapse now has a mechanism

Recomputing #708's published cells (TSLA only, declared +6.00/−6.25, in-sample-frozen terciles,
out-of-sample, truncated at 16:25) reproduces the published numbers **to the last digit**:

| t0 | published quiet / busy | recomputed quiet (n, resolves) / busy (n, resolves) |
|---|---|---|
| 15 | 6.42 / −0.09 | **6.42** (247, 37.2%) / **−0.09** (312, 46.5%) |
| 30 | 8.83 / 1.20 | **8.83** (256, 25.0%) / **1.20** (294, 37.8%) |
| 45 | 7.48 / 1.17 | **7.48** (240, 13.8%) / **1.17** (300, 25.7%) |
| 60 | 2.75 / 1.72 | **2.75** (256, 10.2%) / **1.72** (309, 16.8%) |

So the table is arithmetically sound; #787's objection was never that it was miscomputed, and that
objection is now retired. But two things follow that the table alone could not show.

**The `t0 = 60` collapse is not unexplained after all — it is the truncation closing.** The
resolve column, which #708 did not publish, falls monotonically with the arming instant:
37.2% → 25.0% → 13.8% → **10.2%** on the quiet cells. By `t0 = 60` nine of ten quiet trades never
reach a level and are marked out at the flatten, so the quiet cell's required edge converges on
the close-out drift and the quiet/busy gap collapses mechanically. That is a real mechanism, and
it removes the specific "this is what sampling noise looks like" reading of that one cell — while
leaving the broader noise concern fully intact, because the sensitivity table in §6.4 shows the
*pre-registered* rule failing to hold shape across the same axis.

**Reproducing the cells does not vindicate the conclusion drawn from them.** The 8.83-vs-1.20 gap
is a **tercile** contrast — a label assigned with knowledge of where the whole sample's
distribution sat — measured on **one name**, at ~250–300 sessions a cell. The pre-registered,
evaluable-at-the-arming-instant version of the same idea, over five names and 4,485
out-of-sample trades, is **+1.86 pp with a clustered SE of 0.93**. The gap did not survive the
translation from a look-ahead label to a tradeable rule. #787 was right to forbid acting on the
table.

### 6.6 Trial accounting

6 declared trials (3 thresholds × 2 subclasses). Sample 10.5 years; `minbtl_limit()` supports
**945** independent trials at a target annual Sharpe of 1, so the count is **inside the MinBTL
budget** — by a wide margin, and MinBTL is consequently not the binding constraint. The binding
constraint is condition 2, and both subclasses fail it. Doc 13's PBO/DSR machinery is not run
here: it computes over a set of alternative configurations selected among, and with 3 candidates
per subclass and a pre-declared criterion there is no meaningful configuration space to
bootstrap over. That is a deliberate consequence of keeping the grid small, not an omission.

## 7. Limitations

**Ranked. The first three can each independently overturn the numbers above.**

1. **This cannot be settled on 7 names, and the central statistic is underpowered.** Both MDEs
   (2.72 pp index, 1.95 pp single-stock) exceed the 1.00 pp adopt bar. The honest summary of this
   study is *"a filter of this kind cannot be shown to work, or shown not to work, at this
   sample size"* — not *"realised range carries no information"*. The armed-vs-unarmed gross gap
   on single-stock is large in absolute terms (+0.2505% armed vs −0.0914% unarmed) and would be
   economically decisive if real; the data cannot separate it from zero at the declared
   confidence. A REJECT here is a decision not to adopt, not a proof of absence.
2. **The index arm is effectively one series, not two.** SPY and QQQ are ~0.95 correlated and
   share both mechanism and constituents. Date-clustering handles the within-date correlation but
   cannot manufacture cross-sectional breadth that does not exist. **No claim about "index ETPs"
   as a class is licensed by this study** — only a claim about the S&P/Nasdaq complex. The
   single-stock arm is better placed: effective sample size there is driven by ~897 out-of-sample
   dates rather than by 5 names, so it is not blocked the way [#707](https://github.com/dd-jp/samurai-trading-system/issues/707)
   was at N=7 (that ticket needed a cross-sectional *ranking*, which 7 names cannot support; this
   one needs a pooled per-subclass mean, which they can). The verdict is therefore **split by
   subclass on strength of evidence**, not blanket-blocked.
3. **The in-sample name mix is not the out-of-sample name mix, and MSTR's early tape is largely
   missing.** `load_sessions()` drops any session with fewer than half a day of bars. On MSTR that
   removes **1,108 of 2,659 sessions, all of them pre-2023** (1,762 candidate in-sample dates →
   654 kept): MSTR was thinly traded before ~2020 and its 1-minute tape has gaps. PLTR contributes
   only 563 in-sample sessions (IPO 2020-09-30). So the in-sample fit is dominated by
   AAPL/NVDA/TSLA while the out-of-sample scoring is an equal five-name panel. The threshold was
   frozen on a different population from the one it was scored on. This was discovered by the
   measurement, is reported rather than patched, and is a live candidate explanation for why the
   chosen threshold generalised as poorly as it did.
4. **Drawdown here is not ADR-0018 D5's envelope and should not be compared to it.** It is a
   simple-sum, equal-weight, one-return-per-session series with no deployment fraction and no
   compounding; D5's figures are drift-removed fixed-fraction compounded curves. More importantly
   the raw form is close to vacuous on this tape (see §6.4) and its sampling error on a
   near-zero-expectancy series is very large, so **no conclusion in this document rests on a
   drawdown difference** — the drift-removed figures are reported as a warning flag, not as
   evidence.
5. **Bar resolution differs by subclass, so cross-subclass magnitude comparison is not licensed.**
   Index runs on 5-minute bars, single-stock on 1-minute, inherited from ADR-0018/doc 50. A
   5-minute bar spans both levels far more often than a 1-minute bar, and `simulate()` resolves a
   both-levels bar as the **stop**, so the index arm is biased pessimistic in absolute terms. The
   within-subclass filter-on/filter-off contrast is unaffected, because both arms share the
   resolution. Re-running the index arm at 1-minute is the cheap sensitivity nobody has run.
6. **Costs are per-subclass constants applied to names they were not measured on.** 0.18% and
   0.41% come from ADR-0018, quoted off SPY and TSLA, and are applied here to QQQ, MSTR, NVDA and
   PLTR. Per §5 this **cancels from the on/off delta** and cannot move the verdict; it does move
   every absolute bar in §6.3. The real spreads remain unmeasured: [#666](https://github.com/dd-jp/samurai-trading-system/issues/666),
   which would have measured them, closed 2026-08-27 out of scope without delivering that
   measurement; [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) now gates on it
   instead, and no open ticket currently delivers it. A single-stock spread materially above 0.41%
   would raise all four single-stock bars together.
7. **Underlying US tape, not the ETP tape that would actually be traded.** No tracking error, no
   ETP spread beyond the assumed round trip, and **no GBP/USD leg** — ADR-0015's equity book is
   GBP-settled on USD underlyings. Inherited from ADR-0018 and unchanged here, but it means every
   absolute figure is optimistic relative to the live instrument.
8. **One arming instant, one lookback, one bracket.** Nothing here speaks to arming instants
   outside `t0 = 30` beyond the fenced sensitivity, to lookbacks other than 20 sessions, or to any
   bracket other than the frozen pair. Widening any of those is a new pre-registration with a new
   trial count, not a re-read of this document.
9. **No signal.** This measures a filter over an unconditional entry. A real system arms on a
   debate verdict, and the filter could interact with that verdict in either direction — the
   debate may already be selecting the same sessions, in which case the filter is redundant, or it
   may be selecting orthogonal ones, in which case this study understates it. Unmeasurable until
   there is a signal with measured accuracy.

### What could not be measured at all

- **Whether the +1.86 pp single-stock effect is real.** The design lacks the power (MDE 1.95 pp)
  and the effect fails to hold shape across neighbouring arming instants. Settling it needs either
  more names — the pool would have to grow well past 7 — or a longer out-of-sample window, and
  no amount of re-analysis of this tape will do it.
- **Any per-name heterogeneity.** With 5 single-stock names, whether the filter works on some
  names and not others is not estimable; the pooled-per-subclass posture of ADR-0018 D2 is
  assumed, not tested.
- **Whether the same filter helps the crypto book.** Out of scope: "session" is undefined for
  crypto until the flatten rule is fixed, and this study's entire construction is session-relative.
- **The live instrument's behaviour.** See limitations 6 and 7 — no LSE ETP tape was touched, and
  per the standing `no-LSE-mark-source` finding none is currently available.
