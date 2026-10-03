# Does the open-low/close-high property persist across instruments?

**Ticket:** [#707](https://github.com/dd-jp/samurai-trading-system/issues/707) (R1), under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703).
**Generator:** [`57-open-low-close-high-persistence.py`](57-open-low-close-high-persistence.py) (fetch via [`18-fetch-bars.py`](18-fetch-bars.py), `TF=1Day`).
**Horizon:** ADR-0014 intraday, flat by close. **Bracket:** ADR-0018 D4, frozen — nothing here tunes it.
**Status:** MEASURED 2026-09-02 — **FAIL.** The out-of-sample top-minus-bottom spread is **-0.0246 %/session, t = -0.44** — the wrong sign, and indistinguishable from zero — against a declared bar of spread > 0 with `t >= 2.0`. The test is **not** underpowered against the range the pool could plausibly carry (MDE 0.1427 %/session against the declared 0.757 %/session bound), so this is a rejection, not a "cannot be settled here". **Build nothing.**

> Sections are in the order #707 requires: the statistic, the pass bar **stated before the
> result**, the declared trial count, the inherited split, the declared MDE, then the verdict.
> Sections 1–5 were written and committed against the `data` and `is` stage output only, in
> commit **`b57a41f`** on this branch, **before the out-of-sample arm was scored** — the
> three-stage script (`data` / `is` / `oos`) exists to make that ordering checkable rather than
> asserted. One thing changed after that commit and before §6: the NIO ticker-reuse correction
> in §4, which moved the in-sample dispersion and therefore the MDE (0.1402 → **0.1427**) but
> **left the out-of-sample arm bit-identical**, since NIO is fully available across 2023–2026
> either way. The declared bar, the statistic, the split and the §2 tie-break are as committed.

## 1. The question, and the statistic — not re-declared

David's funnel opens with: *"before trading starts at 9 AM UK, go over the last ten or twenty
years of historical data and find which instruments have opened low and closed high, or had a
big spike during the trading day."* #707 asks whether that is a real, persistent, tradeable
property of an instrument, or last decade's noise.

**The statistic needs no re-declaration and none is made here.** #707's body registered it in
2026-08-16 and it survived intact: [#813](https://github.com/dd-jp/samurai-trading-system/issues/813)
(PR #902) expanded `server/providers/universe-pool/lse-etp-pool.ts` from 7 to **26 distinct <!-- cite-exempt: historical — deleted in v1 teardown wave 4 (#1748); preserved at tag v1-final -->
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

**The §2 UNMEASURABLE tie-break is not a third trial.** It alters neither the statistic nor
the cross-section nor the split; it makes an outcome boundary #707 left implicit executable, it
was fixed before the out-of-sample arm was scored, and it did not bind on the verdict — the
spread's *sign* decides this study, and would decide it identically at any tie-break value.

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
| in sample (≤2022) | 84 | **72** (2017-01 → 2022-12) | 20–25 |
| out of sample (≥2023) | 43 | **43** (2023-01 → 2026-07) | 25–26 |

The twelve dropped months are **2016 in its entirety**, dropped by the trailing window rather
than by the floor: no name has a full 12-month history before 2017-01. **No month from 2017-01
onward falls below the 20-name floor**, so the floor excludes nothing in either arm — it is
declared and applied to both arms identically, and it binds on neither. It comes closest in
2017–2019, where exactly 20 names are available and the floor is met on the boundary. First scoreable month
2017-01, out-of-sample 43 months, both as #707's own arithmetic anticipated.

ARM is an out-of-sample-only name by construction (first bar 2023-09-14) and enters the
cross-section from 2024-09, once its 12-month trailing window is populated. Per doc 52 §3,
per-name figures are never pooled across the unequal windows and none are reported here.

**Data check, run before either arm was scored.** All 26 symbols returned bars over the declared
window. Twenty carry the full 2,659 sessions; six begin at their listing, exactly the six
#707 names — ARM 2023-09-14, COIN 2021-04-14, PLTR 2020-09-30, UBER 2019-05-10, MRNA
2018-12-07, **NIO 2018-09-12**.

**NIO needed a data-provenance correction, and it is not a method change.** Alpaca serves
2,659 NIO bars back to 2016-01-04, but NIO listed on the NYSE on **2018-09-12**: the earlier
tape belongs to a previous holder of the ticker — real prices around \$14 with real volume
through 2016–2018, then four zero-volume flat 14.67 bars immediately before the IPO, then the
genuine listing session (open 6.05). Those bars are not the instrument being ranked, so they
are not its data; the script's `FIRST_ELIGIBLE` table and its zero-volume drop are what make
"the instrument's own tape" true, and the declared availability rule is then applied to that
tape unchanged. **Effect: the out-of-sample arm and the verdict are unaffected** (NIO is fully
available throughout 2023–2026 either way); the in-sample arm loses one name in 2017–2019, so
§5's dispersion and MDE are reported on the corrected panel. No other name in the pool needed
one: all twenty full-history names were trading under their current ticker on 2016-01-04, and
**XYZ (Block, renamed from SQ) back-maps correctly** — ~\$12 on real volume in January 2016,
which is where Square traded. Zero-volume bars: four in the whole panel, all NIO's pre-IPO run,
all already outside its eligible window.

Two daily `|(c−o)/o| > 30%` values exist in the whole panel, both NIO and both genuine tape
(2018-09-13 +75.2% on the listing-year squeeze; 2019-10-02 +33.6% off a $1.19 open). No
split-adjustment corruption: `adjustment=all` is set and both legs of the ratio carry the same
factor.

## 5. The declared minimum detectable effect

Dispersion from the **in-sample** arm; sample size from the **out-of-sample** arm — using the
in-sample month count would report the power of a test that is not being run.

In-sample spread series, 72 months: mean **+0.0364 %/session**, sd **0.3339**, se 0.0394,
t = +0.926. (Recorded for the MDE only. The in-sample arm is not a result: it is the arm the
statistic was declared over, and it does not clear `t ≥ 2.0` either.)

```
MDE = (z_0.975 + z_0.80) × sd_IS / √M_OOS
    = (1.9600 + 0.8416) × 0.3339 / √43
    = 2.8016 × 0.3339 / 6.5574
    = 0.1427 %/session
```

**MDE = 0.1427 %/session** — the smallest true top-minus-bottom spread this design detects at
80% power, 5% two-sided, over the 43 out-of-sample months. (The pre-registration commit recorded
0.1402 on the uncorrected panel; §4's NIO correction moved the in-sample sd from 0.3282 to
0.3339. The conclusion of this section is unchanged at either value, and the out-of-sample arm
is untouched by the correction.)

**Against the tie-break declared in §2: 0.1427 < 0.757, so UNMEASURABLE cannot fire.** The
design has power across the entire plausible effect range — it would detect an effect **5.3×
smaller** than the best-minus-worst single-name gross drift gap doc 52 measured on the same
pool over an overlapping window. Whatever the out-of-sample arm returns, it will be a result and
not an absence of one. (Doc 51's precedent runs the other way: there the MDE, 2.72 / 1.95 pp,
*exceeded* the 1.00 pp adopt bar, which is why *"cannot be settled here"* was the honest verdict
and is not the honest verdict here.)

## 6. Result

Out of sample, **43 months, 2023-01 → 2026-07**, 25–26 names a month, quintiles of 5 then 6
(ARM enters from 2024-09). All figures are percent per session, gross.

| quantity | mean (%/session) | sd | se | t |
| --- | --- | --- | --- | --- |
| **top-minus-bottom spread** | **−0.0246** | 0.3708 | 0.0565 | **−0.436** |
| top quintile, absolute | **+0.0550** | — | 0.0604 | +0.912 |
| bottom quintile, absolute | +0.0797 | — | 0.0513 | +1.552 |

**The spread is negative and indistinguishable from zero.** Its magnitude is **5.8× smaller than
the 0.1427 MDE** and it sits 0.44 standard errors below zero — the names the trailing 12-month
open-to-close mean ranked *highest* went on to return slightly *less*, open-to-close, than the
names it ranked lowest. Month by month the sign is a coin flip: **21 of 43 months positive, 22
negative.** The two largest monthly spreads are consecutive and opposite (2026-06 **+1.12**,
2026-07 **−1.02**), which is what a difference between two 6-name portfolios of noise looks like.

Both quintiles' absolute expectancies are positive and statistically alike (+0.0550 against
+0.0797, each inside one standard error of the other). The pool as a whole drifted up
open-to-close over 2023–2026 by roughly +0.07 %/session, and the ranking sorted essentially none
of that drift between the ends.

The in-sample arm did not carry the effect either: +0.0364 %/session at **t = +0.93** over 72
months (§5), nowhere near the declared bar on the arm the statistic was registered over. So
this is not an in-sample effect decaying out of sample. It is an effect that was never there,
and it changed sign when it crossed the split.

Realised out-of-sample sd is 0.3708 %/session against the 0.3339 the in-sample arm supplied to
the MDE, so the arm actually run was marginally *less* powered than the declaration assumed
(a like-for-like MDE on realised dispersion is 0.1584 %/session — still 4.8× below the 0.757
bound, so the §2 tie-break is unaffected either way).

**Ordering.** This section and those below are the only text written after the `oos` stage ran.
Sections 1–5 — including the MDE and the §2 tie-break — were committed against the `data` and
`is` stages alone, in the preceding commit on this branch.

## 7. Verdict — **FAIL**

Against the four outcomes exactly as declared in §2, in the order declared:

* **PASS** requires spread > 0 **and** t ≥ 2.0 **and** top-group absolute expectancy > 0. The
  **first two limbs fail**: the spread is **−0.0246**, i.e. negative, and `t = −0.44` against a
  `t ≥ 2.0` bar. (Top-group absolute expectancy is positive, +0.0550, but a PASS needs all
  three.) Not a PASS.
* **PARTIAL** requires the spread to be **significant** with top-group absolute expectancy ≤ 0.
  **Neither limb holds**: the spread is not significant at any conventional level, and the top
  group's absolute expectancy is positive. Not a PARTIAL — and therefore **no eligibility gate
  is proposed**, so nothing here has to compose with
  [#750](https://github.com/dd-jp/samurai-trading-system/issues/750)'s two-sided reach-rate
  band. Had this landed PARTIAL the write-up would have owed that composition rule; writing one
  against a rejected result would be building on it, so none is written.
* **UNMEASURABLE** was pre-bound in §2 to `MDE > 0.757 %/session`. **MDE = 0.1427.** The design
  detects an effect **5.3× smaller** than the best-minus-worst gross-drift gap doc 52 measured
  on this same pool over an overlapping window. Not UNMEASURABLE. Doc 51's *"cannot be settled
  here"* precedent does not apply here — there the MDE exceeded the adopt bar; here it is far
  below the plausibility bound.
* **FAIL.** The verdict is mechanical from the declared bar and needs no tie-break: the spread
  has the wrong sign, so it fails PASS on limb one, fails PARTIAL on significance, and the MDE
  forecloses UNMEASURABLE.

**So: build nothing.** Concretely, what this settles:

* **The pre-session open-low/close-high history screen is measured and rejected**, not left as
  folklore. That was the declared purpose of the FAIL branch and it is the outcome.
* **C2 keeps its single ranked axis.** #750's measured round-trip-cost ranking stands alone, and
  the screener continues to contribute **zero trials** to the PBO accounting — the property the
  PARTIAL branch's restriction existed to protect, preserved intact.
* **Adjacent evidence is confirmed, not contradicted.** #707 flagged in advance that ADR-0018 D2
  (the pooled all-day distribution beats event-conditioned levels) and doc 13's **PBO 0.85** both
  disfavoured this screen. A ranking signal over a small effect is exactly that regime, and this
  is what that regime produces.
* **Nothing here bears on whether the pool should be ranked at all**, or on
  `universe-selector-spec.md`'s under-25 branch. One candidate ranked axis is rejected; the
  selector question is separate and untouched.

## 8. Limitations — stated against the verdict

1. **The standard error is optimistic, and that strengthens the FAIL.** Quintile membership
   persists across adjacent months, so the 43 monthly spreads are not fully independent and
   `sd/√M` understates the true SE. **No Newey-West or clustering correction was applied, and
   none should be read in** — an undeclared SE adjustment that moved `t` across 2.0 is precisely
   the failure this pre-registration exists to prevent. The direction is safe: a larger SE moves
   `t = −0.44` further toward zero, never toward the bar.
2. **US underlyings stand in for LSE leveraged ETPs.** The pool file ranks the US underlying
   because [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) established there
   is no free LSE intraday history. A 3× ETP's open-to-close return is ~3× the underlying's
   before fees and path effects, and leverage scales the spread and its dispersion together, so
   the t-statistic is approximately invariant to it. The **absolute** expectancies are in
   underlying terms and are not ETP returns.
3. **Gross of cost.** No round-trip cost is charged, because the PASS bar is written against a
   gross spread. Doc 53's floors (~4 bps round trip at $10k notional) would push both quintiles'
   absolute expectancies down and leave the spread — a difference between two equally-traded
   legs — unchanged. A PASS would have owed a net restatement; a FAIL does not, since cost only
   makes it worse.
4. **One regime.** 2023–2026 was a broadly rising tape, visible in both quintiles being positive.
   A cross-sectional ranking could in principle work in a regime this window does not contain.
   The pre-registration bought one out-of-sample window and this is what it holds; re-running on
   a different window is a new trial and needs its own registration.
5. **Monthly, not daily, is what was tested.** The registered statistic scores each name once a
   month off a 12-month trailing mean. This rejects *that* persistence claim — the slow,
   instrument-level property David's framing describes. It is **not** evidence about same-session
   or few-day-ahead conditioning, which nothing in this design measures.
6. **Availability, not survivorship, is the panel's known bias.** Every name in the pool is a
   name the pool file selected in 2026, so the cross-section is conditioned on surviving to be
   listed as an ETP underlying. That biases the *absolute* expectancies upward; it has no clear
   directional effect on a top-minus-bottom spread within the panel, which is the tested
   statistic.

## What this closes

#707's "Done when": the statistic (not re-declared, and why — §1), the pass bar stated before
the result (§2), the trial count of 2 and what each trial is (§3), the inherited OOS split (§4),
the declared MDE with its arithmetic (§5), and the verdict against the four declared outcomes
backed by the computed numbers (§6–7). Reproducible end to end from the fetch loop and the three
stages documented in
[`57-open-low-close-high-persistence.py`](57-open-low-close-high-persistence.py)'s docstring;
the full out-of-sample per-month table is in
[`archive/raw/2026-09-02-57-oos-run.txt`](archive/raw/2026-09-02-57-oos-run.txt).
