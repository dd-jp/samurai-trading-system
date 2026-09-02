# Does the open-low/close-high property persist across instruments?

**Ticket:** [#707](https://github.com/dd-jp/samurai-trading-system/issues/707) (R1), under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703).
**Generator:** [`57-open-low-close-high-persistence.py`](57-open-low-close-high-persistence.py) (fetch via [`18-fetch-bars.py`](18-fetch-bars.py), `TF=1Day`).
**Horizon:** ADR-0014 intraday, flat by close. **Bracket:** ADR-0018 D4, frozen — nothing here tunes it.
**Status:** PRE-REGISTRATION COMMITTED 2026-09-02 — out-of-sample arm not yet scored.

> Sections are in the order #707 requires: the statistic, the pass bar **stated before the
> result**, the declared trial count, the inherited split, the declared MDE, then the verdict.
> Sections 1–5 were written and committed against the in-sample stage output only, on this branch, **before the out-of-sample arm was scored** —
> the two-stage script (`is` / `oos`) exists to make that ordering checkable rather than
> asserted.

## 1. The question, and the statistic — not re-declared

David's funnel opens with: *"before trading starts at 9 AM UK, go over the last ten or twenty
years of historical data and find which instruments have opened low and closed high, or had a
big spike during the trading day."* #707 asks whether that is a real, persistent, tradeable
property of an instrument, or last decade's noise.

**The statistic needs no re-declaration and none is made here.** #707's body registered it in
2026-08-16 and it survived intact: [#813](https://github.com/dd-jp/samurai-trading-system/issues/813)
(PR #902) expanded `server/providers/universe-pool/lse-etp-pool.ts` from 7 to **26 distinct
`screening_instrument` values**, which restored the originally pre-registered monthly quintile
as computable at ~5 names a bucket. The N=7 fork — median split, per-instrument time series, or
record as unmeasurable — was **withdrawn as posed**, not chosen between. What this document runs
is the original registration, unchanged:

* **Score.** For name `i` and month `m`, the **strictly trailing 12-month mean** of the daily
  open-to-close return `(close − open) / open`, in percent. Strictly trailing means no bar from
  month `m` may enter the ranking that scores month `m`.
* **Cross-section.** Rank the available names each month, form quintiles, and take the
  **top-minus-bottom spread** of the realised month-`m` mean daily open-to-close return.
  Quintile members are equal-weighted; at `N` not a multiple of 5 each end takes `ceil(N/5)` names.
* **Entry rule** (resolved on the ticket 2026-08-27): **rank within the names available that
  month, with a minimum-names-per-month floor of 20.** Months below the floor are excluded
  rather than ranked on a too-thin cross-section.

Two mechanical readings were needed to make the declared rule executable, and both are stated
here as consequences rather than as choices — no alternative was computed for either:

1. A name is **available** in month `m` when its 12-month trailing window is fully populated
   (at least one bar in each of the 12 preceding months) *and* it has at least one bar in `m` to
   score. A "trailing 12-month mean" over a window with holes is a different statistic.
2. Quintile width is `ceil(N/5)` at both ends.

**Units throughout: percent per session** — the mean daily open-to-close return, the same unit
doc 52 reports `E_gross` in, so the two are directly comparable.

**Data.** Alpaca SIP daily bars, `adjustment=all`, **2016-01-04 → 2026-07-31**, for the 26
underlyings: AAPL AMD AMZN ARM BABA COIN EWY GOOG KWEB META MRNA MSFT MSTR NFLX NIO NVDA PLTR
PYPL QQQ RACE SPY TSLA UBER VT XLE XYZ. This ticket ranks **underlyings**, not ETP lines — two
3× SPY trackers are one name reachable by two routes, not two places in a cross-section.

## 2. The pass bar, stated before the result

Copied verbatim in substance from #707's "Outcomes, declared before the result":

* **PASS** — OOS spread > 0 **and** t ≥ 2.0 **and** top-group **absolute** expectancy > 0.
* **PARTIAL** — spread significant but top-group absolute expectancy ≤ 0. The screen ranks but
  does not rescue: admissible then only as a **hard eligibility gate on the pool**, never as a
  second ranked axis and never as an entry rule.
* **FAIL** — build nothing. C2's single ranked axis stands alone and the pre-session history
  screen is recorded as measured-and-rejected rather than left as folklore.
* **UNMEASURABLE** — the declared MDE exceeds any effect the pool could plausibly carry.

**The four outcomes do not partition the space, so the tie-break is declared here, before the
out-of-sample arm was scored.** A result with spread > 0, `t < 2.0` and positive top-group
expectancy is neither PASS nor PARTIAL as written. It resolves to **FAIL**, *unless* the MDE
argument fires — and deciding that after seeing the t-statistic is exactly the post-hoc move
this ticket exists to forbid. So:

> **UNMEASURABLE fires if and only if the declared MDE exceeds 0.757 %/session.** That number
> is the in-repo anchor for "any effect the pool could plausibly carry": doc 52's out-of-sample
> `E_gross` spread between the best and worst names it priced (AAPL +0.2899, MSTR −0.4672 %/session
> — a 0.757 pp gap). It is a deliberately **generous** bound, because it is what a perfect
> ex-post oracle picking single names would have captured; a quintile-averaged, ex-ante ranking
> can only deliver a fraction of it. If the MDE sits below that bound the design has power
> against the whole plausible range, and a non-significant result is a rejection.

## 3. Trial count: 2

Per #707, declared before the run:

1. The original monthly cross-sectional quintile statistic (registered 2026-08-16, unamended).
2. The rank-within-available-names entry rule with a 20-name floor (resolved 2026-08-27 —
   David's ruling was that a data-availability rule **does** spend a D4 trial).

**One lookback: 12 months.** No second window was computed. The "ten or twenty years" in the
original framing is about *sample length*, not a search over the lookback, and #707 instructs
that a request to try both and pick be refused. The bracket stays frozen per ADR-0018 D4.
Nothing in the result section is chosen after seeing a result.

## 4. The inherited out-of-sample split

**In sample ≤ 2022, out of sample ≥ 2023**, taken from `18-threshold-study.py` — the lines are
**272–273** in the file today, not the 169–170 #707's body cites; the content is what the ticket
describes and is unchanged. The split is inherited, not re-chosen.

Realised, after the 12-month trailing window and the 20-name floor:

| arm | months in arm | months scored | names/month |
| --- | --- | --- | --- |
| in sample (≤2022) | 84 | **72** (2017-01 → 2022-12) | 21–25 |
| out of sample (≥2023) | 43 | **43** (2023-01 → 2026-07) | reported in §6 |

The twelve dropped months are **2016 in its entirety**, dropped by the trailing window rather
than by the floor: no name has a full 12-month history before 2017-01. **No month from 2017-01
onward falls below the 20-name floor**, so the floor excludes nothing in either arm — it is
declared and applied to both arms identically, and it binds on neither. First scoreable month
2017-01, out-of-sample 43 months, both as #707's own arithmetic anticipated.

ARM is an out-of-sample-only name by construction (first bar 2023-09-14) and enters the
cross-section from 2024-10. Per doc 52 §3, per-name figures are never pooled across the unequal
windows and none are reported here.

**Data check, run before either arm was scored.** All 26 symbols returned bars over the declared
window; 21 carry the full 2,659 sessions, and the five that do not begin at their listing
(ARM 2023-09-14, COIN 2021-04-14, PLTR 2020-09-30, UBER 2019-05-10, MRNA 2018-12-07). **NIO,
which #707 lists among the post-2016 names, in fact serves the full 2,659 bars from
2016-01-04** — the ticket's count of six late names is five. **XYZ (Block, renamed from SQ) serves the full history under
the current ticker**, so the rename needed no handling and none was applied. Two daily
`|(c−o)/o| > 30%` values exist in the whole panel, both NIO and both genuine tape
(2018-09-13 +75.2% on the listing-year squeeze; 2019-10-02 +33.6% off a $1.19 open). No
split-adjustment corruption: `adjustment=all` is set and both legs of the ratio carry the same
factor.

## 5. The declared minimum detectable effect

Dispersion from the **in-sample** arm; sample size from the **out-of-sample** arm — using the
in-sample month count would report the power of a test that is not being run.

In-sample spread series, 72 months: mean **+0.0529 %/session**, sd **0.3282**, se 0.0387,
t = +1.367. (Recorded for the MDE only. The in-sample arm is not a result: it is the arm the
statistic was declared over, and it does not clear `t ≥ 2.0` either.)

```
MDE = (z_0.975 + z_0.80) × sd_IS / √M_OOS
    = (1.9600 + 0.8416) × 0.3282 / √43
    = 2.8016 × 0.3282 / 6.5574
    = 0.1402 %/session
```

**MDE = 0.1402 %/session** — the smallest true top-minus-bottom spread this design detects at
80% power, 5% two-sided, over the 43 out-of-sample months.

**Against the tie-break declared in §2: 0.1402 < 0.757, so UNMEASURABLE cannot fire.** The
design has power across the entire plausible effect range — it would detect an effect **5.4×
smaller** than the best-minus-worst single-name gross drift gap doc 52 measured on the same
pool over an overlapping window. Whatever the out-of-sample arm returns, it will be a result and
not an absence of one. (Doc 51's precedent runs the other way: there the MDE, 2.72 / 1.95 pp,
*exceeded* the 1.00 pp adopt bar, which is why *"cannot be settled here"* was the honest verdict
and is not the honest verdict here.)

## 6. Result

_Not yet computed. The out-of-sample arm is scored after this section's preceding
sections are committed._
