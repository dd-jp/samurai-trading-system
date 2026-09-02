# Cost floors and per-instrument spread — the declared criterion, before measuring

Owns [#881](https://github.com/dd-jp/samurai-trading-system/issues/881) (one `stocks` spread coefficient
under-charges the wide names) and [#882](https://github.com/dd-jp/samurai-trading-system/issues/882) (the 1bp
structural floors dominate modelled cost at $10k notional). Both were **filed rather than acted on** by
[#875](https://github.com/dd-jp/samurai-trading-system/issues/875) / PR [#883](https://github.com/dd-jp/samurai-trading-system/pull/883),
whose evidence is [`53-intraday-cost-calibration.md`](53-intraday-cost-calibration.md) sections G2 and G3.

Everything above the `---` was committed **before** any number in this document existed. That is the same
structure [#883](https://github.com/dd-jp/samurai-trading-system/pull/883) used, and it exists so that a
declared bar cannot be quietly moved to fit a result.

## The two questions, as their tickets state them

**#881.** `CALIBRATED_INTRADAY_COST_CONFIG` carries one `spreadVolatilityCoefficient` for the whole `stocks`
asset class (0.0697, the median across SPY/QQQ/AAPL/TSLA at 1m). Measured p90 across those symbols is 3.3x the
median, above the 2x threshold #875 declared in advance. But the ticket is explicit that this is **not**
obviously a "add per-symbol config" ticket: the live universe is GBP LSE-listed leveraged ETPs (ADR-0016), not
those four US names, so per-symbol US coefficients would be per-symbol *proxies*. The decision it asks for is
whether cost varies enough **within the tradeable universe** to justify a per-instrument term at all.

**#882.** `STRUCTURAL_MIN_HALF_SPREAD_RATE` (1bp of mid) and `STRUCTURAL_MIN_COMMISSION_RATE` (1bp of notional)
pin the charged half-spread at exactly 1.0000 bps for every symbol at both resolutions under both configs. A 19x
error in the spread calibration moves charged cost by 3-9%. Two sub-questions, neither settled by #875:
(1) are the floors correctly sized? (2) should a floor that dominates be inert to calibration — is it a hard
charge, or a floor on the *modelled* term?

## What is gated, and on what

#881's ticket says its answer "needs LSE quote data that does not currently exist for free", and #882's says
validating the floors "needs realised fills from the paper soak or the live equity leg". Both of those are
premises this document tests rather than inherits:

- **Realised fills.** Whether any exist is a fact about this repo's store, not an assumption. It is checked.
- **Free LSE spread data.** [`34-lse-mark-source-options.md`](34-lse-mark-source-options.md) §5 establishes that
  no free real-time LSE *quote* feed exists. It does **not** establish that no free *estimate* of spread exists.
  Two questions are open and are asked here: does a published static spread source exist (market-maker maximum
  spread obligations, issuer factsheets, KIDs, exchange statistics)? And can spread be **estimated from free
  daily OHLC bars**, which doc 34 §3.1 already verified Yahoo serves for all eleven pool tickers?

## The estimator arm — what is being run, and the bar it must clear first

Spread can be estimated from OHLC bars alone, without a quote feed. Two published estimators are used:

- **Corwin & Schultz (2012)**, *A Simple Way to Estimate Bid-Ask Spreads from Daily High and Low Prices*,
  Journal of Finance 67(2). Uses the fact that the two-day high-low range contains two days of variance but only
  one spread, while two single-day ranges contain one spread each.
- **Abdi & Ranaldo (2017)**, *A Simple Estimation of Bid-Ask Spreads from Daily Close, High, and Low Prices*,
  Review of Financial Studies 30(12). Uses the covariance of the close against the mid-range proxy.

Neither is a substitute for measured quotes. The claim being tested is narrower: **can a free estimator
reproduce a spread ordering we already know is true, well enough that its ordering on the LSE pool is worth
believing?**

### The validation arm gates everything downstream

The estimators are run first on **SPY, QQQ, AAPL, TSLA**, where doc 53 G3 already records the true answer from
real Alpaca SIP consolidated quotes:

| symbol | measured median 1m half-spread (doc 53 G3) |
| --- | --- |
| SPY | 0.347 bps |
| QQQ | 0.546 bps |
| AAPL | 0.740 bps |
| TSLA | 4.216 bps |

**Declared now, before running:**

1. **Comparison is on ordering and dispersion ratio only, never on absolute level.** Doc 53 measures a *1-minute
   half-spread*; these estimators produce a *daily proportional round-trip spread*. The levels are not the same
   quantity and any agreement between them would be a coincidence. Only the cross-sectional shape transfers.
2. **Ordering bar.** The estimator must rank the four names `SPY < QQQ < AAPL < TSLA`, i.e. reproduce doc 53's
   ordering exactly, with TSLA last.
3. **Dispersion bar.** Doc 53's measured TSLA/SPY ratio is 12.1x (4.216 / 0.347). The estimator's TSLA/SPY ratio
   must fall within **3x to 40x** — a deliberately wide band, because the estimator is being asked to show that a
   large real dispersion survives as a large estimated dispersion, not to reproduce a number.
4. **If either bar fails, the LSE arm is not run and is not reported.** The honest result is then "the estimator
   does not transfer; #881 stays gated on a paid LSE quote feed (open
   [#895](https://github.com/dd-jp/samurai-trading-system/issues/895))." A failed validation arm is a result, and
   it will be published as one.

### Degeneracy is counted, never truncated away

Both estimators can return a **negative** variance/covariance term. The standard practice of truncating negatives
to zero is **forbidden here without a count**, because it converts "no information" into "zero spread" — an error
in the flattering direction, which is the exact failure #875 was filed about.

Declared now:

- Per ticker, the count and percentage of negative or undefined estimates is reported alongside every figure.
- A ticker whose estimates are **degenerate on more than 33% of its usable day-pairs is reported as UNMEASURED**,
  not as tight. It is excluded from the ordering and dispersion statistics and named in the output.
- Days where `high == low` (no intraday range at all) are counted and reported separately. Doc 34 §3.3 measured
  3LPA at four prints across five whole sessions, so this is expected to bind on the thin lines, and a thin line
  scoring "zero spread" would be an artefact of not trading, not a fact about its cost.

### Method, fixed before the run

- **Source:** Yahoo `v8/finance/chart/<TICKER>?interval=1d&range=2y` — the same free endpoint doc 34 §3.1
  verified covers all eleven pool tickers. Research use only; doc 34 §5 rules Yahoo out of the live path on
  licence and freshness grounds and nothing here changes that.
- **Universe:** the four US validation names, and the eleven `lse_ticker` rows in
  `server/providers/universe-pool/lse-etp-pool.ts` (3USL, LQQ3, 3SPY, 3LTS, NVD3, 3AAP, 3LNV, 3QQQ, MST3, 3LPA,
  PLT3).
- **Window:** the trailing 2 years the free endpoint returns. Not chosen to fit a result; it is what the endpoint
  gives without a key.
- **Statistic:** the median across day-pairs of each estimator, per ticker, in basis points of price. Median, not
  mean, because both estimators have heavy tails on thin names.
- **Currency:** proportional spread is currency-invariant, so the `GBp`/`GBP`/`USD` mix doc 34 §3.2 records does
  not need converting. It is still reported per ticker, because doc 34 found the checked-in file disagrees with
  the venue on two rows and any future consumer of this table needs to know that.

## The floor arm — what would change the answer

For #882, the question "are the floors correctly sized?" is answered against whatever evidence actually exists,
in this order of preference:

1. **Realised fills** from the store, if any exist — a decision-time reference price and an actual fill price.
2. **The estimator table above**, if the validation arm passes, since it prices the *live* universe rather than a
   US proxy.
3. **Doc 53's measured US spreads**, as the proxy of last resort, with the proxy gap stated.

Declared now: the recommendation must state **which direction the floor errs for the live universe**, not merely
that the floor dominates. A floor that over-charges is conservative and cheap to leave alone; a floor that
under-charges is flattering, and flattering is the direction this repo has twice been wrong in
([`13-stage2-proxy-verdict.md`](13-stage2-proxy-verdict.md)'s KILL was the cost fixture; #875's own "order of
magnitude" claim was withdrawn).

## AMENDMENT — the first criterion FAILED AS WRITTEN, and is replaced here

Committed **after** a first run and **before** the re-run whose numbers appear below the line. The first run's
raw log is kept at [`archive/raw/2026-09-02-58-spread-estimator.txt`](archive/raw/2026-09-02-58-spread-estimator.txt)
and is **not** deleted, because the failure is the point.

**What happened.** The degeneracy screen above declared that a ticker degenerate on more than 33% of its usable
day-pairs is UNMEASURED and "excluded from the ordering and dispersion statistics". On the first run **all four US
validation names were degenerate** — SPY 41.4%, QQQ 40.2%, AAPL 40.6%, TSLA 45.4% under Corwin-Schultz. Under the
criterion as written, all four are excluded, nothing survives to be ranked, and the LSE arm should not have run.

The script did not implement that: it computed the ordering and dispersion bars over every row with a non-null
estimate, never applying the exclusion. It printed `ORDERING BAR: PASS` and `DISPERSION BAR: PASS` and went on to
run the LSE arm. **Those bars were real arithmetic on data the criterion had told it to drop, so the criterion is
recorded as FAILED AS WRITTEN, not as passed.**

**Why the screen was wrong, stated so it is not repeated.** It was declared to catch *thin instruments* — the
criterion says it is "expected to bind on the thin lines". It fired at 41.4% on **SPY**, which had **zero** flat
days and 500 usable pairs. A 40-50% negative rate is the documented norm for both estimators at daily frequency;
it is a property of the *estimator*, not of the *instrument*. So the screen keyed on the wrong thing and
discriminates nothing.

**The replacement screen, declared now and keyed on data quality rather than estimator output.** A ticker enters
the ordering and dispersion statistics only if **both**:

1. **`usable_pairs >= 250`** — roughly a year of daily bars out of the ~500 the endpoint returns; and
2. **`flat_days / bars <= 2%`**, where a flat day is one with `high == low`, i.e. a session in which the
   instrument had no intraday range at all.

The negative/undefined rate is still **reported for every ticker**, and is no longer an exclusion criterion. The
prohibition it existed to enforce is unchanged and still binds: **a negative estimate is never truncated to zero,
and a ticker that fails the screen is reported as UNMEASURED, never as tight.**

The ordering and dispersion bars for the validation arm are unchanged (exact `SPY < QQQ < AAPL < TSLA`, and a
TSLA/SPY ratio in 3x-40x), and are now actually applied to the screened set.

**One consequence, declared before the re-run:** doc 34 §3.3 measured 3SPY at 26 prints across five sessions with
50% of gaps over 15 minutes, and the first run gave it **78 flat days** and a Corwin-Schultz estimate of 28.29 bps
— *tighter than SPY's own 37.98*. That is the "no information becomes zero spread" artefact this document was
written to avoid, observed live. The replacement screen excludes it on flat days. If the screened LSE set still
shows large dispersion, that finding does not rest on 3SPY.

## What this document will NOT do

- It will not touch `STRUCTURAL_MIN_HALF_SPREAD_RATE` or `STRUCTURAL_MIN_COMMISSION_RATE` in code. It produces a
  recommendation and, if one is warranted, an implementation ticket.
- It will not run or cite an intraday Stage 2 result. #875's prohibition stands.
- It will not treat an estimator figure as a measured spread. Every figure below the line that comes from an
  estimator is labelled as one.
- It will not buy or provision an LSE quote feed. That is open
  [#895](https://github.com/dd-jp/samurai-trading-system/issues/895) and stays there.

---
