# Where the intraday odds sit: exit geometry, bracket width, and the two live subclasses

**R3 — follow-up to [#814](https://github.com/dd-jp/samurai-trading-system/issues/814), measured 2026-08-17.** Script: [`52-exit-geometry-and-subclass-odds.py`](52-exit-geometry-and-subclass-odds.py).

> **This selects nothing.** ADR-0018 Decision 4 fixes a selection budget of two
> configurations, chosen once, and freezes *the rule* rather than the percentages.
> Everything here re-prices the declared rule on the live tape and reports what the
> tape says. **A lower bar at some other geometry is a fact about the tape, not a
> proposal**; adopting one would spend trials, which is why §7 counts them.

## 1. The question

Which of the exit-design choices, the bracket widths, and the live subclasses carries the
best intraday profit chances — and, underneath that, *is any of these levers where the
profit actually is?*

**One premise in the question was wrong and is corrected here.** There are **two** live
subclasses, not four. `InstrumentSubclass` is `index_etp_3x | single_stock_etp_3x |
crypto`, and crypto left Samurai's scope on 2026-08-16 (ADR-0015's amendment). The #749
LSE pool is **11 tickers over 7 underlyings** in those two subclasses.

## 2. The metric, and why it is not return

The primary column throughout is the **required accuracy edge**, in percentage points:

```
edge_pp = (cost - E_gross) / width * 100
```

the directional accuracy a signal must supply *above a coin* for the geometry to break
even. **Lower means an easier job for the signal.** It is reported instead of expectancy
or return because ADR-0018 D1 forbids a return number as a target and `CLAUDE.md` forbids
return-only comparison against a risk-targeted stream.

**Everything below is measured on unconditional long entry — there is no signal in it.**
`E_gross` is the *instrument's* drift over the holding pattern, not a strategy's edge. So
no figure here says the system is profitable or unprofitable; each says **how hard a given
geometry makes the signal's job.**

## 3. Regime, data, and the in-sample/out-of-sample split

- **Tape:** Alpaca **SIP**, 7 underlyings, index at 5-minute and single-stock at 1-minute —
  the same per-subclass granularity as docs 18 and 50, so the figures are comparable rather
  than merely similar. 7.8M bars.
- **Regime:** `t0 = 0` (US open), truncated at the **16:25 London flatten**, exactly doc
  50's rider regime. This is why SPY reproduces doc 50's comparator **to the digit**
  (see §4).
- **Split:** in sample `< 2023-01-01`, out of sample `>= 2023` (**n = 897 sessions per
  name**). **Every re-solved neutral stop is fitted in sample and scored out of sample.**
  Solving and scoring on the same slice would fit the stop to the sessions it is then
  graded on. The *declared* brackets need no split — they are ADR-0018 constants, fitted
  to neither slice.

| name | subclass | in sample | out of sample | first bar |
| --- | --- | --- | --- | --- |
| SPY | index | 1762 | 897 | 2016-01-04 |
| QQQ | index | 1760 | 897 | 2016-01-04 |
| TSLA | single | 1760 | 897 | 2016-01-04 |
| NVDA | single | 1760 | 897 | 2016-01-04 |
| AAPL | single | 1760 | 897 | 2016-01-04 |
| **MSTR** | single | **654** | 897 | 2016-01-08 |
| **PLTR** | single | **563** | 897 | 2020-10-01 |

MSTR and PLTR have materially thinner in-sample slices — PLTR because it listed
2020-09-30, MSTR because its pre-2020 1-minute tape is too sparse to clear the
half-session bar filter. Their in-sample-solved stops are correspondingly weaker, and
**per-name figures are never pooled across these unequal windows.**

## 4. Control: doc 50 reproduces exactly

SPY, declared bracket, same regime: **n = 897, E_gross +0.0055%, E_net −0.1745%, 9.3% tp /
11.9% sl / 78.8% close-out, bar 4.19 pp**. That is doc 50's single-bracket row to the
digit. The harness is measuring the same thing the existing comparators were measured on.

## 5. Result — the two subclasses and the seven names

Declared bracket per subclass (+2.00/−2.16 index at 0.18% round trip; +6.00/−6.25
single-stock at 0.41%), out of sample:

| name | subclass | E_gross | E_net | resolves | **bar (pp)** | ±SE |
| --- | --- | --- | --- | --- | --- | --- |
| AAPL | single | +0.2899 | −0.1201 | **9.5%** | *0.98* | 0.78 |
| **PLTR** | single | +0.2516 | −0.1584 | 67.6% | **1.29** | 1.43 |
| **NVDA** | single | +0.0622 | −0.3478 | 42.6% | **2.84** | 1.21 |
| **QQQ** | index | +0.0569 | −0.1231 | 51.7% | **2.96** | 1.30 |
| TSLA | single | −0.0619 | −0.4719 | 61.2% | 3.85 | 1.37 |
| SPY | index | +0.0055 | −0.1745 | 21.2% | 4.19 | 0.99 |
| **MSTR** | single | −0.4672 | −0.8772 | 83.1% | **7.16** | 1.55 |

**AAPL's 0.98 pp is degenerate, not good.** At ±6% the bracket resolves on 9.5% of
sessions — the other 90.5% close at market. That is time-exit-only wearing a bracket, and
the bar stops describing the job the signal is being asked to do (§6).

**On a bracket that actually fires, PLTR carries the easiest job (1.29 pp at a 67.6%
resolve rate), then NVDA and QQQ.** Between the two index names the gap is real in
mechanism, not just in the bar: **QQQ resolves 51.7% of sessions against SPY's 21.2%** at
the identical bracket, so the same geometry is a live bracket on one and mostly a time
exit on the other.

**MSTR is the worst by a wide margin and is the one unambiguous separation.** 7.16 pp,
and its `E_gross` is **−0.47%/session** — at 3× the tape bleeds before any bracket is
placed.

**Most of this ranking is not statistically separable.** SEs run 0.8–1.6 pp. PLTR's 1.29
against SPY's 4.19 is ~1.7 SE of the difference — suggestive, not established. Only the
extremes (MSTR against the AAPL/PLTR end) separate cleanly.

## 6. Result — the width curve is a trap, not a ranking

The bar falls monotonically as the bracket widens, on **every** name, because width is its
own denominator. On SPY: 8.07 pp at +1.0% → 4.11 → 2.70 → 1.85 → 1.13 → **0.99 pp at
+8.0%**. The resolve rate over the same sweep: **67.7% → 0.2%**.

**Read the resolve column before the bar column.** A 0.99 pp bar at a 0.2% resolve rate is
not a better configuration, it is a degenerate one — and this is ADR-0018 D3's own
recorded reason for not choosing the widest bracket ("wide brackets need almost none but
rarely fire, degenerating into hold-to-close").

**The trap is mostly index-side.** A 3× single-stock tape is volatile enough that resolve
rates stay high even at narrow brackets — TSLA, MSTR and PLTR resolve ~100% at +1.0%,
where SPY resolves 67.7% and collapses from there. **The degeneracy risk is a property of
the subclass, not of the width in the abstract**, which is a reason the two subclasses
need separate geometry that is independent of the reasons D3 already gives.

## 7. Result — the design axes, measured at matched width

Width is the bar's denominator, so *any* comparison that changes width is measuring width.
Both axes below are therefore width-controlled — a control the naive version of this run
did not have, and which reverses its answer in both cases.

### 7.1 Skew: not a lever

Total width held at the declared bracket's; only the **split** moves.

| name | best split | its bar | declared split's bar | spread across all splits |
| --- | --- | --- | --- | --- |
| SPY | 75/25 | 3.91 | 4.19 | 0.31 pp |
| QQQ | 50/50 | 2.80 | 2.96 | 1.62 pp |
| TSLA | neutral* | 3.60 | 3.85 | 0.45 pp |
| NVDA | declared | 2.84 | 2.84 | 0.81 pp |
| AAPL | declared | 0.98 | 0.98 | 0.92 pp |
| MSTR | 25/75 | 4.92 | 7.16 | 2.89 pp |
| PLTR | 25/75 | 0.98 | 1.29 | 0.57 pp |

**No split wins twice, and the declared split is never far from the best.** Five different
splits win across seven names, which is the signature of noise rather than a lever. Before
the width control, the same comparison said "a wide stop is clearly better" (2.81 pp
against neutral's 4.11 on SPY) — that entire effect was the denominator.

### 7.2 Frozen versus ATR-floating: freezing costs nothing measurable

`k` chosen per name so the floating stop has the **same mean width** as the frozen one.

| name | frozen | ATR width-matched | difference |
| --- | --- | --- | --- |
| SPY | 4.19 | 4.31 | frozen better by 0.12 |
| QQQ | 2.96 | 2.51 | ATR better by 0.45 |
| TSLA | 3.85 | 3.75 | ATR better by 0.10 |
| NVDA | 2.84 | 2.69 | ATR better by 0.15 |
| AAPL | 0.98 | 0.96 | ATR better by 0.02 |
| MSTR | 7.16 | 6.69 | ATR better by 0.47 |
| PLTR | 1.29 | 1.77 | frozen better by 0.48 |

Five of seven marginally favour floating, two favour frozen, **every difference is well
inside the ~1.2 pp standard errors**, and the median gap is ~0.15 pp. Uncontrolled, the
same comparison looked decisive for ATR (3.27 against frozen's 4.19 on SPY) — again purely
width.

**This cannot overturn D2 and is not offered as trying to.** D2 rejected per-instrument
fitting on a *structural* argument — the universe is scanned daily (#635), so there is no
fixed instrument list to fit per-instrument studies to. What this measures is the **cost**
of that structural choice, and the cost is not distinguishable from zero.

### 7.3 Bracket versus time-exit-only: the bracket buys variance, not expectancy

| name | bracket E_net | time-exit E_net | bracket sd | time-exit sd |
| --- | --- | --- | --- | --- |
| SPY | −0.1745 | **−0.1538** | **1.23** | 1.35 |
| QQQ | **−0.1231** | −0.1549 | **1.63** | 2.02 |
| TSLA | −0.4719 | **−0.3170** | **5.03** | 6.49 |
| NVDA | −0.3478 | −0.3508 | **4.43** | 5.23 |
| AAPL | −0.1201 | **−0.1090** | **2.86** | 3.25 |
| MSTR | −0.8772 | **−0.3843** | **5.67** | 9.71 |
| PLTR | −0.1584 | **−0.0283** | **5.24** | 7.83 |

**Expectancy is better *without* the bracket on five of seven names; dispersion is lower
*with* it on all seven.** The stop is buying variance control at a small expectancy cost,
which is what a stop is for — and it is exactly why `CLAUDE.md` forbids ranking these two
columns on return alone. MSTR is the extreme case in both directions: the bracket costs
0.49%/session of expectancy and removes 4.04 points of dispersion.

### 7.4 Single versus ladder: not re-run

#708 measured it at **t = −0.20 over n = 897** ([doc 50](50-entry-time-conditional-brackets.md)).
Cited, not repeated. ADR-0018's amendment declaring the ladder was withdrawn on 2026-08-17
(#814 / #817).

## 8. What this says about the original question

**None of the three levers asked about is where the profit is.** Skew is noise at matched
width; the stop's derivation is worth ~0.15 pp against ~1.2 pp of noise; and the width
"winner" is an artefact that dissolves the moment the resolve rate is read alongside it.
The bar sits around **1–4 pp for every non-degenerate configuration on every name except
MSTR**, and ADR-0018's declared brackets are already inside that band.

**Where the differences actually live is the instrument, not the geometry** — and even
there, only the extremes separate: MSTR at 7.16 pp with negative gross drift is a
different proposition from PLTR at 1.29 pp, and no amount of re-cutting the bracket closes
that gap.

## 9. Limitations

1. **No signal in any of it.** Unconditional long entry throughout. These are bars a
   signal must clear, not results a strategy achieved.
2. **The LSE leg is not what was measured.** The pool's tickers are LSE-listed and no
   specced DataSource serves the LSE, so the tape here is the US
   underlying scaled by the leverage factor — ADR-0018's own method and its own
   limitation. Real ETP tracking error, LSE-hours liquidity, and the ETPs' own spreads are
   absent.
3. **Per-name costs are subclass costs.** #666 owns the measured per-instrument spreads;
   they are not applied per name here. A per-name ranking therefore inherits its
   subclass's round trip, which is the main reason a per-name figure is weaker evidence
   than a per-subclass one.
4. **Underpowered for most pairwise claims.** SEs of 0.8–1.6 pp against differences often
   under 1 pp. §5's ordering should be read as "MSTR is clearly worst" plus a soft
   gradient, not as a ranking.
5. **MSTR and PLTR have thin in-sample slices** (654 and 563 sessions), so their re-solved
   neutral stops carry more fitting noise than the other five.
6. **`E_gross` is period-specific.** 2023–2026 was a strong tape for NVDA and PLTR and a
   poor one for MSTR; drift is not a stable property of a name.

## 10. Trial accounting

**126 configurations priced** by this run — 7 names × (1 declared + 6 widths + 5 splits +
4 stop derivations + 2 exit modes), plus the two subclass roll-ups.

**None is adopted, so ADR-0018 D4's budget of two-configurations-chosen-once is
untouched.** The count is recorded because any future amendment that reaches for a figure
in this document inherits these trials and must price the selection risk against them.
Doc 13's chain — PBO 0.85 against a 0.05 line, 3 of 24 surviving out of sample — is the
standing reminder of what a 126-configuration sweep can produce if a winner is read off it.
