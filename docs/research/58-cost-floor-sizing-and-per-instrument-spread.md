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

# The measurement, run after the criteria above were committed

Producer: [`58-spread-estimator.py`](58-spread-estimator.py). Raw logs:
[`archive/raw/2026-09-02-58-spread-estimator.txt`](archive/raw/2026-09-02-58-spread-estimator.txt) (the first run,
whose criterion failed as written) and
[`archive/raw/2026-09-02-58-spread-estimator-rerun.txt`](archive/raw/2026-09-02-58-spread-estimator-rerun.txt)
(the run reported below). Both are kept.

## F1 — realised fills do not exist, and the paper soak cannot ever produce the ones #882 needs

#882 says validating the floors "needs realised fills from the paper soak **or** the live equity leg". Checked
against `data/samurai-paper.sqlite` (2,174,976 B, mtime 2026-09-02T03:47Z, zero-byte WAL so nothing is
uncommitted):

| table | rows |
| --- | --- |
| `fills` | **2** |
| `broker_observed_fills` | 0 |
| `closed_trades` | 1 |
| `open_positions` | 5 (1 filled, **4 `order_state='rejected'`, `filled_size = 0.0`**) |
| `verdict_log` | 10 (5 `go`) |
| `debate_log` | 48 |

**Pipeline-generated fills: zero.** Both `fills` rows carry
`idempotency_key = 'soak-lifecycle-probe-2026-08-26'`, minted by `server/tools/place-soak-position.ts` — a
one-off manual probe, not a pipeline decision. `data/samurai.db` is **0 bytes**, so no live-leg store exists at
all. The 2026-08-25 archive DB holds 94 debates and 0 fills; the stale worktree copy holds 78 debates and 0 fills.

**The premise is not merely unmet, it is unmeetable on this venue.** Three independent reasons, any one of which
is sufficient:

1. **`fee = 0.0` on both fills.** Alpaca paper charges no commission, so the **1bp commission floor is
   structurally unvalidatable there at any sample size.**
2. **No quote is persisted anywhere in the schema.** `bars` is OHLCV only; `latest_mark` is one overwritten row
   per instrument; `fills` carries `price` and nothing else. There is no column that could hold a bid/ask at
   submit time, so **a realised half-spread cannot be computed from this store however long the soak runs** —
   that needs an instrumentation change, not more ticks. `fills.cost_breakdown_json` is NULL on both rows and its
   own schema comment scopes it to "Simulated-adapter fills only", so the modelled-vs-realised comparison field
   never populates on a real-broker path.
3. **Wrong venue, wrong instruments.** The one fill is SPY on Alpaca US paper. The live universe is GBP
   LSE-listed leveraged ETPs at Saxo (ADR-0016, ADR-0015). Thousands of Alpaca paper fills would not size either
   floor for that universe.

So #882's stated gate is **half wrong**: only the live Saxo leg can produce the fills that would validate these
floors, and the paper soak never can.

### F1b — a finding that outgrows this document, and is filed separately

All **four** rejected pipeline orders were `sell` while flat, i.e. **short entries**, and all four returned
`alpaca submitBracket failed (status 422)`:

| opened_at | instrument | side | requested_size |
| --- | --- | --- | --- |
| 2026-08-27T14:05:00.906Z | AAPL | sell | 16.0593553774751 |
| 2026-08-28T14:05:50.177Z | TSLA | sell | 14.2205031214004 |
| 2026-09-01T14:02:23.064Z | SPY | sell | **6.0** |
| 2026-09-01T14:03:20.555Z | QQQ | sell | **7.0** |

SPY 6.0 and QQQ 7.0 are **whole-share** and were rejected too, which narrows the standing "every fractional
bracket 422s" reading — fractional sizing is not the common cause. No response body is persisted, only
`"reason":"alpaca submitBracket failed (status 422)"`. Filed rather than chased here.

## F2 — the estimator validates on ordering, and the level is NOT transferable

Both estimators, run on the four US names where doc 53 G3 already knows the answer from real Alpaca SIP quotes,
under the amendment's data-quality screen (all four pass it: 500 usable pairs, zero flat days):

| ticker | CS bps (round trip) | AR bps (round trip) | CS neg% | AR neg% | doc 53 measured 1m half-spread |
| --- | --- | --- | --- | --- | --- |
| SPY | 37.98 | 49.49 | 41.4% | 48.2% | 0.347 bps |
| QQQ | 49.68 | 71.64 | 40.2% | 48.0% | 0.546 bps |
| AAPL | 75.67 | 97.04 | 40.6% | 51.4% | 0.740 bps |
| TSLA | 151.02 | 198.12 | 45.4% | 50.2% | 4.216 bps |

- **ORDERING BAR: PASS, both estimators.** Estimated `SPY < QQQ < AAPL < TSLA`, exactly the measured ordering.
- **DISPERSION BAR: PASS, both estimators.** TSLA/SPY = 3.98x (CS) and 4.00x (AR), inside the declared 3x-40x
  band against a measured 12.15x.

**The absolute level is off by a factor of roughly fifty and must never be quoted.** SPY's estimated round-trip
37.98 bps is a 19 bps half-spread against a measured 0.347 bps. The criterion forbade level comparison in advance
and this is why: these are daily proportional spreads from range data, not 1-minute half-spreads from quotes.
**Only same-estimator ratios are used below.** Nothing in this document converts an estimate into a bps figure
for the live universe, and no such conversion should be built on it.

The estimators also **compress** dispersion — 4x estimated against 12x measured — so they *understate* how
different two instruments are. That direction matters: a dispersion finding from this method is a lower bound.

## F2b — TWO PREMISE CORRECTIONS, both of which cut against what this document first assumed

Recorded here rather than edited into the criterion above, because the criterion is what it was.

**Correction 1 — the universe is THIRTY lines, not eleven.** The criterion says "the eleven `lse_ticker` rows in
`server/providers/universe-pool/lse-etp-pool.ts`". That number was inherited from doc 34 §3.2, which *probed*
eleven. `LSE_ETP_POOL` (`lse-etp-pool.ts:355`) holds **30 tradeable lines** — 8 `index_etp_3x` and 22
`single_stock_etp_3x`, across **26 distinct screening underlyings** (SPY, QQQ, NVDA and PLTR each carry two lines
from different issuers), from Leverage Shares (16), GraniteShares (12) and WisdomTree (2). Every row is 3x long;
there are no shorts and **no commodity ETCs at all**, though ADR-0016's universe is "LSE-listed leveraged index
ETPs **plus commodity ETCs**" — the ETC leg was never encoded. ADR-0016 itself names exactly one ticker, 3USL.
The run below covers all 30.

**Correction 2 — #881's stated blocker is FALSE. Free per-line LSE quotes exist.** The ticket says its answer
"needs LSE quote data that does not currently exist for free". The London Stock Exchange's own website is a
JavaScript app backed by an **unauthenticated** endpoint that returns bid and offer per TIDM:

```
https://api.londonstockexchange.com/api/gw/lse/instruments/alldata/<TIDM>
```

**30/30 coverage of the pool**, plus `marketsize` (Exchange Market Size — the size the quote is good for),
`segment`, `currency` and `sedol`. Producer: [`58-lse-quote-snapshot.py`](58-lse-quote-snapshot.py). This does
not touch open [#895](https://github.com/dd-jp/samurai-trading-system/issues/895) — doc 34 §5's licence and
freshness analysis still governs what may price the *live book*. It changes what **research** can measure, for £0.

### F2c — what a free published *static* spread source turns out not to be

Searched so nobody re-runs it. **There is no free published static expected- or average-spread statistic for this
universe.** Four separate findings:

1. **LSE market-maker maximum-spread obligations — published and free, but useless as a per-instrument term.**
   The [obligations PDF](https://docs.londonstockexchange.com/sites/default/files/documents/etf-&-etp-market-maker-obligations.pdf)
   states maximum spread "varies according to four percentage bands: 1.5%, 3%, 5% and 15%… determined by the
   sector in which each security is placed", that wider quotes "will be automatically rejected by the trading
   system", and that in stressed conditions the parameters **double**. But the instrument→sector mapping is not
   free and current: the API returns `segment` (ECE1/ECE2/ECE3) and no trading sector, and one segment spans
   1.5% to 15%. The authoritative mapping is behind credentialed Millennium Exchange reference data (MIT401). A
   free LSE securities XLS carries exactly the right columns but **the series stopped in September 2020** and
   covers 4 of our 30 ISINs — on which the obligated maximum is **5.0% for all four**, i.e. no discriminating
   power even if the current file were obtained.
2. **Issuer factsheets and KIDs — cover the tickers, wrong quantity.** No issuer publishes a typical or maximum
   bid-ask spread. The PRIIPs KID transaction-cost row is the *fund's own portfolio dealing cost* — and from
   1 January 2025 must use the **arrival-price** method — not the investor's spread on the LSE line.
3. **justETF, LSE instrument pages, LSE monthly ETP Analysis — verified negative.** No spread field of any kind;
   the monthly reports carry listings, trade counts and orderbook value only.
4. **MiFID II / FCA cost disclosure — structurally not a source.** Ex-ante costs-and-charges is a firm-to-client
   obligation producing a per-client quote at point of sale, not a published per-instrument dataset.

One partial lead is left open rather than chased: **Borsa Italiana** (sister LSEG venue) publishes free monthly
per-instrument bid-ask spread statistics at four notional sizes, archived to 2013, and several pool lines are
cross-listed there. It is the Milan tape, not London, and was not verified against our lines.

**So the realistic path is not to find a published statistic — it is to sample the free endpoint ourselves.**

## F3 — the LSE pool, and what #881 actually asked

Ten of thirty pool tickers pass the declared screen. Twenty do not, and **none of the twenty is screened out for
being tight** — they are screened out for having no usable data. The eleven doc 34 probed are shown first:

| ticker | ccy | bars | pairs | flat days | CS bps | AR bps | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3USL | USD | 505 | 504 | 1 | 80.62 | 149.85 | ok |
| LQQ3 | GBp | 504 | 503 | 1 | 124.52 | 213.90 | ok |
| NVD3 | USD | 505 | 504 | 1 | 307.48 | 465.55 | ok |
| 3LNV | USD | 505 | 504 | 1 | 351.92 | 461.12 | ok |
| MST3 | USD | 476 | 475 | 6 | 593.01 | 796.47 | ok |
| PLT3 | USD | 505 | 504 | 1 | 434.03 | 613.04 | ok |
| 3SPY | GBp | 504 | 503 | **78** | *28.29* | *170.49* | **UNMEASURED** — 15.5% flat days |
| 3QQQ | GBp | 504 | 503 | 21 | *119.28* | *221.93* | **UNMEASURED** — 4.2% flat days |
| 3LPA | USD | 505 | 504 | 24 | *261.43* | *599.44* | **UNMEASURED** — 4.8% flat days |
| 3LTS | USD | **1** | 0 | — | — | — | **UNMEASURED** — no usable day-pairs |
| 3AAP | GBp | **1** | 0 | — | — | — | **UNMEASURED** — no usable day-pairs |

The other nineteen lines, which doc 34 never probed (four more pass the screen; fifteen more do not):

| ticker | flat days | CS bps | AR bps | status |
| --- | --- | --- | --- | --- |
| LCO3 | 4 | 536.56 | 887.70 | ok |
| 3AMZ | 3 | 198.38 | 358.15 | ok |
| 3FB | 1 | 233.06 | 390.30 | ok |
| 3ARM | 7 | 348.07 | 692.08 | ok |
| 3LSQ | **218** | *0.00* | *442.80* | **UNMEASURED** — 43.2% flat days |
| 3RAC | **192** | *0.00* | *275.71* | **UNMEASURED** — 38.1% flat days |
| LAA3 | 87 | *118.84* | *516.24* | **UNMEASURED** — 17.3% flat days |
| 3LNP | 83 | *116.26* | *329.38* | **UNMEASURED** — 16.5% flat days |
| 3XLE | 80 | *75.58* | *312.93* | **UNMEASURED** — 15.9% flat days |
| LPP3 | 77 | *103.21* | *381.43* | **UNMEASURED** — 15.3% flat days |
| 3LMO | 65 | *271.72* | *820.48* | **UNMEASURED** — 12.9% flat days |
| 3KOR | 50 | *99.25* | *401.50* | **UNMEASURED** — 9.9% flat days |
| 3LIP | 47 | *444.51* | *730.62* | **UNMEASURED** — 9.3% flat days |
| 3UBR | 44 | *229.66* | *487.74* | **UNMEASURED** — 8.7% flat days |
| LAM3 | 67 | *191.20* | *582.13* | **UNMEASURED** — 13.3% flat days |
| 3LAL | 18 | *143.55* | *356.23* | **UNMEASURED** — 3.6% flat days |
| 3KWE | 13 | *143.42* | *387.03* | **UNMEASURED** — 2.6% flat days |
| 3VT | 24 | *0.00* | *113.59* | **UNMEASURED** — **101** usable pairs, 23.5% flat days |
| 3LME | — | — | — | **UNMEASURED** — no usable day-pairs |

**3LSQ and 3RAC print `0.00` under Corwin-Schultz on 218 and 192 flat days.** That is the truncate-to-zero
artefact in its purest form and the reason the criterion forbade it: two instruments that barely trade would
otherwise enter a cost table as **free**.

**Twenty of the thirty lines in the tradeable universe cannot be priced from free daily bars**, and three (3LTS,
3AAP, 3LME) return a single bar in two years. That is a fact about the *universe*, not about the estimator.

**3SPY is the artefact the criterion was written to catch, observed live.** Corwin-Schultz scores it at 28.29 bps
— *tighter than SPY's own 37.98* — on a line doc 34 §3.3 measured at **26 prints across five whole sessions with
50% of gaps over 15 minutes**, and which shows **78 flat days** here. It is not tight; it does not trade. Had the
first criterion's truncate-free rule not been in place, and had the flat-day screen not been declared, this line
would have entered a cost table as the cheapest instrument in the universe. It is excluded, and its number is
printed in italics above only so the artefact is visible.

**3LTS, 3AAP and 3LME return a single daily bar for the whole two-year window** — no usable price history at all.
Doc 34 §3.3 independently measured 3AAP at 27 prints in five sessions with 72.7% of gaps over 15 minutes, so this
is corroborated rather than a Yahoo artefact.

### What #881's own statistic says, and why the honest answer is not the one the ticket expected

#875's declared test was **p90 across symbols against the median**, which fired at 3.3x on the US four. Applied
to the ten screened LSE names:

| statistic | Corwin-Schultz | Abdi-Ranaldo |
| --- | --- | --- |
| median | 327.78 bps | 463.33 bps |
| range | 80.62 - 593.01 | 149.85 - 887.70 |
| **max / min** | **7.36x** | **5.92x** |
| **max / median** (#875's shape) | **1.81x** | **1.92x** |
| #875's 2x threshold | **does not fire** | **does not fire** |

**Read this together with F6, which contradicts it, and F6 wins.** On the estimator the threshold does not fire;
on real quotes it fires at 12.61x. The estimator's statistic is biased low for two reasons already established
above, both of which push the same way:

1. **The estimator compresses dispersion by construction** — F2 measured 4x estimated against 12x true on the US
   names, a 3x compression.
2. **The screen removes the wide names, not the tight ones.** Twenty of thirty are excluded for having no usable
   range data, and thinness and width are the same phenomenon. What survives is the *liquid tenth* of the pool.

So the estimator arm's dispersion statistic should be read as a **lower bound reported for completeness**, and
the direct quote measurement in F6 is the one to act on. What the estimator arm *does* establish, and F6 confirms
independently: **every one of the ten screened names estimates wider than SPY (2.1x to 15.6x), and eight of the ten
estimate wider than TSLA** — the name doc 53 measured at 4.216 bps, already **4.2x the 1bp floor**.

## F6 — the direct measurement: free LSE quotes across all thirty lines

Producer: [`58-lse-quote-snapshot.py`](58-lse-quote-snapshot.py). Raw log:
[`archive/raw/2026-09-02-58-lse-quotes-preopen.txt`](archive/raw/2026-09-02-58-lse-quotes-preopen.txt).

**PROVISIONAL, and the caveat is load-bearing.** Captured 2026-09-02 05:34 Europe/London, i.e. **before the
08:00 open**. Out of continuous trading the endpoint returns the *previous session's closing* quotes
(`tradingstatuscode: "N c"`, prior-session volume; re-running minutes later returns byte-identical values). LSE's
market-maker obligations bind quotes to "at least 90% of continuous trading during the mandatory period" and
explicitly **not** during the opening auction, so **these are not the spreads a fill would cross.** The script
prints `IN CONTINUOUS SESSION: False` on such a run and refuses to imply otherwise. **This must be re-sampled in
session before any number here is used to size anything**, and re-sampled repeatedly, because doc 53 G3 measured
a real intraday profile on the US names (TSLA's open median 2.7x its close median).

30/30 coverage. Round-trip spread in bps of mid, tightest first:

| tidm | bps | | tidm | bps |
| --- | --- | --- | --- | --- |
| PLT3 | **2.3** | | 3ARM | 81.6 |
| LQQ3 | 5.3 | | 3LTS | 94.6 |
| NVD3 | 6.5 | | 3SPY | 96.6 |
| 3AAP | 12.6 | | 3LAL | 97.2 |
| 3KOR | 13.3 | | LAM3 | 100.0 |
| 3USL | 15.6 | | 3LME | 105.7 |
| MST3 | 20.3 | | 3UBR | 111.7 |
| 3FB | 26.5 | | 3LNP | 138.9 |
| 3QQQ | 34.8 | | 3LPA | 163.0 |
| 3AMZ | 36.8 | | 3LSQ | 168.8 |
| 3KWE | 46.3 | | 3RAC | 173.9 |
| 3LNV | 51.6 | | LAA3 | 186.9 |
| 3VT | 68.4 | | 3LMO | 208.2 |
| 3XLE | 79.7 | | LPP3 | 221.4 |
| | | | 3LIP | 240.9 |
| | | | **LCO3** | **1111.1** |

| statistic | value |
| --- | --- |
| median round-trip | **88.1 bps** |
| range | 2.3 - 1111.1 bps |
| **max / min** | **480.5x** |
| **max / median** (#875's shape) | **12.61x** |
| **#875's 2x threshold** | **FIRES** |
| implied median **half**-spread | **44.1 bps** |
| lines whose half-spread exceeds the 1bp floor | **30 of 30** |

Three things fall out, and the third is the one nobody has been treating as a cost problem:

1. **#881's question is answered YES, decisively.** 12.61x against a declared 2x. Cost varies enormously within
   the tradeable universe — far more than the 3.3x that fired on the US four.
2. **ADR-0016's single observed quote is fine for 3USL and badly unrepresentative of the pool.** The ADR rests
   the entire leveraged-ETP case on "one observed 0.18% spread quote for 3USL"; 3USL measures **0.156%** here,
   close to it — while the pool median is **0.88%** and the worst line is **11.1%**.
3. **The widest lines are TICK-BOUND, not liquidity-bound.** LCO3 quotes 8.5p / 9.5p — a **one-penny** tick on a
   9p instrument is 11%. 3LSQ quotes $0.646 / $0.657. No spread *model* keyed off volatility can represent that;
   it is a minimum-tick-over-price floor, a different functional form from anything in `CostConfig` today.

## F4 — the floors are under-sized for the live venue, and this part needs no estimator at all

`server/tools/backtest/cost-model.ts` applies both floors **per component, per side**:

```ts
const rawSpread =
  marketState.spread ?? marketState.volatility * assetConfig.spreadVolatilityCoefficient;
const half_spread = Math.max(rawSpread / 2, marketState.mid * STRUCTURAL_MIN_HALF_SPREAD_RATE);

const notional = request.size * marketState.mid;
const commission = Math.max(
  assetConfig.commissionRate * notional,
  STRUCTURAL_MIN_COMMISSION_RATE * notional,
);
```

`slippage` and `market_impact` are unfloored. `fill()` is called once at entry and once at exit
(`replay-driver.ts:560`/`:609`, `simulated-adapter.ts:83`/`:232`), so a round trip charges both floors twice:
**~4 bps round trip**, exactly as #882 states.

**The commission floor is under-sized by 8x against the live venue, from a primary in-repo source and with no
estimation involved.** [ADR-0015](../adr/0015-live-venue-account-and-book-split.md):201 records Saxo's
**8 bps-per-side Classic tier with no per-order minimum**, i.e. **0.16% = 16 bps round trip** at both the £350 and
£250 position sizes. The model charges **2 bps round trip**. ADR-0015:207 already anticipated this document's
conclusion:

> `CostModelImpl`, which floors commission at a 1bp-of-notional *rate*, models Saxo's rate-based structure in kind
> (not in the exact 8bps figure) rather than IBKR's per-order floor — **a rate-calibration update to 8bps is an
> implementation follow-up, not a structural fix.**

**The half-spread floor is under-sized too, by the ordering argument of F2/F3** — eight of ten screened LSE names
estimate wider than TSLA, whose measured 1m half-spread is 4.2x the floor. Doc 53 §G4 already recorded the same
direction on separate grounds ("an LSE leveraged ETP's real spread is very likely **wider** than a US
mega-cap's"). This document does not put a number on it; it establishes the sign.

**Direction, which the criterion required be stated: the floors are FLATTERING for the live universe.** #882's
ticket says the guard "over-charges the tight names and under-charges the wide ones" — true of the US four, and
misleading about the live book, where **there are no tight names.** Against an edge ADR-0018 measures in
single-digit bps per session, a cost model charging ~4 bps round trip where the venue's *commission alone* is
16 bps is wrong in the one direction this repo has twice been burned by
([`13-stage2-proxy-verdict.md`](13-stage2-proxy-verdict.md)'s KILL was the cost fixture; #875's own
order-of-magnitude claim was withdrawn).

## F5 — should a floor that dominates be inert to calibration?

**No, and the fix is a floor table rather than a constant.** Findings:

- The floors are module-private `const` in `cost-model.ts`. **Not exported, no env var, no config field.**
  `CostConfig` has no floor fields, and the only cost env var (`SAMURAI_STAGE2_COST_CONFIG`) swaps whole configs
  and cannot reach them. Overriding them today requires editing the constants or substituting an entire
  `CostModel` — which is what `ZeroCostModel` in `cost-attribution.test.ts` does, existing solely to bypass an
  otherwise unreachable guard.
- **Principle 1 does not require a fixed magnitude.** `docs/wayfinder/cost-model-backtest-map.md:16` and
  `docs/specs/cost-model-backtest-spec.md:148` state it as *representability*: "the most optimistic config still
  applies a non-zero `half_spread + commission` floor. A frictionless fill is not representable." A per-venue or
  per-asset-class floor table satisfies that in full. **Nothing in Principle 1 says the floor must be 1bp**, and
  nothing anywhere states a measurement basis for that magnitude.
- **The seam already carries what a better floor needs.** `fill(request: FillRequest, marketState: MarketState)`
  has `request.instrument` (currently used only in an ADV error message) and `marketState.asset_class` in hand at
  the floor site. A `floorFor(...)` lookup drops in with the table hung off `CostConfig`. A per-**venue** floor is
  the one variant needing a new field — `MarketState`, `FillRequest` and `InstrumentListing` carry **no venue or
  exchange identity at all**, so LSE ETPs arrive as `'stocks'`, indistinguishable from Alpaca US equities.
- **A floor that dominates silently corrupts a tool already in the tree.**
  `run-stage2-cost-decomposition.ts:137-155` scales all four coefficients by `COST_SCALES = [1, 0.5, 0.25, 0.1,
  0.05]`; with stocks already at the floor, **the lower rungs of that ladder measure nothing.** Its own docstring
  says so. That is the concrete cost of leaving a dominating floor inert.

**No recorded result is invalidated by re-deciding this.** The floors are inert on the live path — the cost model
is only consumed by `SimulatedBrokerAdapter`; the Alpaca adapter never prices through it
(`paper-profile.ts:1751`: "Inert in paper (Simulated adapter only)"). What *is* affected is every Stage 2
backtest number, all of which were scored with a cost floor now shown to be under-sized for the live universe —
i.e. they are **optimistic by an unquantified amount**, and no Stage 2 verdict should be re-cited until the floor
is re-sized.

## The rulings

Both tickets asked for a decision. David's instruction on 2026-09-02 was to take the recommended approach rather
than hold the question open, so these are recorded as **rulings, made on his behalf and reversible by him** —
each states what would change it.

### #881 — YES, a per-instrument term is justified. But sample the free feed first, and narrow the universe.

The ticket asks "whether cost varies enough *within the tradeable universe* to justify a per-instrument term at
all", and states that answering it "needs LSE quote data that does not currently exist for free".

**Both halves of that framing are wrong, and in opposite directions.** The data exists and is free (F2b). And
once measured, the dispersion is not marginal — it is **12.61x max/median and 480x max/min** across the thirty
lines (F6), against a threshold of 2x. Cost varies *enormously* within the tradeable universe.

*An earlier draft of this document ruled the opposite way, on the estimator arm's 1.81x. That ruling was wrong
and is retracted here rather than quietly edited: the estimator compresses dispersion 3x by construction and its
screen removes exactly the wide names (F3). It is left in the document as a lower bound and a lesson —
**a screened proxy statistic disagreed with a direct measurement, and the direct measurement was right.***

The ruling, in order of what should actually be built:

1. **Do not hand-fit a per-symbol coefficient from a single snapshot.** F6 is one out-of-session capture. The
   first ship is the **sampler**: run `58-lse-quote-snapshot.py` on a cron through the session and accumulate the
   dataset. That is £0, needs no vendor, and produces both the per-instrument level and the session profile that
   doc 53 G3 showed matters (TSLA's open 2.7x its close).
2. **The per-instrument term is justified and the seam is ready** — F5 records that `fill()` already holds
   `request.instrument`. Build it *against sampled data*, not against this snapshot.
3. **The functional form has to change, not just the coefficient.** LCO3 at 8.5p/9.5p is **tick-bound**: a
   one-penny tick on a 9p line is 11%, and no `volatility × coefficient` term can represent that. A
   minimum-tick-over-price floor is a different shape from anything in `CostConfig`.
4. **Narrow the universe, and treat that as the larger finding.** Twenty of thirty lines cannot be priced from
   free daily bars; three return **one bar in two years**; 3LSQ and 3RAC are flat on 43% and 38% of sessions.
   ADR-0016's commodity-ETC leg was never encoded, and its whole leverage case rests on one 3USL quote that F6
   shows is the pool's 6th-tightest line out of thirty. An instrument whose spread is 11% cannot be traded
   profitably at any signal accuracy — that is a *universe* decision, not a cost-model parameter.

**What would reverse this:** in-session sampling showing the pre-open snapshot was unrepresentative and that
continuous-trading spreads are both tight and uniform. F6's caveat is real and this ruling is explicitly
provisional on it — which is exactly why the first ship is the sampler and not a coefficient.

### #882 — the floors are under-sized, and must stop being module constants

1. **Sized wrong, and flattering, on both floors.** Saxo charges **8 bps per side** (ADR-0015:201); the model
   floors commission at **1 bp per side** — an 8x under-charge on the live venue, from a primary source with no
   estimation. And **all 30 of 30** pool lines show a half-spread above the 1bp floor, at a median of **44 bps**
   (F6, provisional on its out-of-session caveat) — 44x the floor, corroborated in sign by F2/F3's ordering
   argument and independently by doc 53 §G4.

   Put together, at the £350/£250 position sizes ADR-0018 D5 resolves to: the model charges **~4 bps round
   trip**, while commission alone is **16 bps** and the median line's spread adds **~88 bps**. Against an edge
   ADR-0018 measures in single-digit bps per session, that is not a calibration nuance — it is the difference
   between a positive and a negative expectancy.
2. **A dominating floor must not be inert.** Principle 1 requires only that a frictionless fill be
   unrepresentable (`cost-model-backtest-spec.md:148`); it does not mandate 1 bp. The floors become a table on
   `CostConfig`, keyed by asset class today and by venue once a venue identity reaches the seam.
3. **The evidence gate in the ticket is wrong and is corrected here.** "Needs realised fills from the paper soak
   or the live equity leg" — the paper soak can never supply them (F1). Waiting on it would have waited forever.

**What would reverse this:** realised Saxo fills showing an effective all-in cost below the re-sized floor, or a
tier change in Saxo's schedule.

**What this does NOT authorise:** picking a final number for the half-spread floor from F6. That snapshot is
out-of-session and provisional, and F2 forbids converting an *estimate* into bps at all. The commission floor has
a sourced, actionable figure (8 bps per side); the half-spread floor has a **sign, an order of magnitude, and a
free way to measure it properly** — the sampler, not a guess.
