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

## RETRACTION — F2b's collection-method claim, F2c, and F6 (2026-09-08, [#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036))

[#999](https://github.com/dd-jp/samurai-trading-system/issues/999) read the London Stock Exchange's public-site
Terms §8: programmatic/scripted access is barred, retrieval is limited to personal use, storage "on any server or
other storage device connected to a network" is barred, and incorporation of the Information "in any work or
publication in any form" is barred. `58-lse-quote-snapshot.py` is exactly that access, and F6's table is exactly
that incorporation.

**What is retracted, and what is not.** The finding that a free, unauthenticated LSE quote endpoint exists is
**not** retracted — that observation stands on its own. What is retracted: (1) F2b's framing of that endpoint as
something this repo's research can use ("it changes what research can measure, for £0" — it cannot, permissibly);
(2) F2c's closing recommendation to sample the endpoint; and (3) **F6 in full** — every bid/offer and every
statistic derived from them (88.1 bps median, 480.5x max/min, 12.61x max/median, 44.1 bps implied half-spread
median). `58-lse-quote-snapshot.py` is deleted from the tree (git history retains it) so it cannot be rerun. The
raw capture at
[`archive/raw/2026-09-02-58-lse-quotes-preopen.txt`](archive/raw/2026-09-02-58-lse-quotes-preopen.txt) is kept
per this repo's never-delete rule, with its own retraction header.

**Reported 2026-09-15 — [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) (PR #1559)
produced `46-lseg-dmd-pretrade-surface.md`, which now supersedes the numbers this document retracted below**,
for 30 of 31 pool
rows (MST3 confirmed absent from LSEG's SI feed), permissibly collected from LSEG Delayed Market Data's free
delayed pre-trade files (doc 46's Method section quotes #1034's clearance). Headline: pool open-bucket median
round-trip **159.0 bps** (79.5 bps half-spread), cross-sectional dispersion **max/median 4.19x, max/min 57.70x**
open-bucket — narrower dispersion than F6's retracted 12.61x/480.5x, but still **~3.1x** doc 59 §3.1's
single-stock total round-trip cost budget (52.1 bps) and **~11.2x** its index budget (14.2 bps) at ADR-0017's
assumed win rate. Against doc 59 §3.1 criterion (b)'s per-subclass spread-only thresholds (≤36 bps
single-stock, ≤0 bps index — unsatisfiable as bracketed) rather than the single-stock total ceiling
applied to every row regardless of subclass, only **1 of 30 rows clears its subclass's threshold**
(NVD3, 30.5 bps); four of the six tightest-quoted rows (3USL, 3LUS, LQQ3, 3KOR) are `index_etp_3x`
and so have no positive spread budget to clear at all, however tight their spread measures. Every
place below that cited F2b's endpoint claim, F2c's recommendation, or an F6 figure remains marked retracted in place rather than
silently removed or rewritten, per this repo's never-delete rule — the reasoning that once rested on them stays
visible as what it was; doc 46 is the number to cite going forward, not any figure below this line.

This does not reopen the #881/#882 rulings below on their bottom line — David ruled on 2026-09-02 that a
per-instrument term is justified. It does replace what those rulings called for **next**: the original #881
ruling point 1 called for building the sampler against `58-lse-quote-snapshot.py`'s endpoint; that call is
retracted along with the script, not merely superseded, because the endpoint itself may not be used this way.
[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) is **not** the follow-up originally called
for — it is the licensed replacement path now required in its place.

**Why this retraction does not reach F2/F3's estimator arm.** #999 read LSE Terms §8 as barring programmatic
collection from *LSE's own site* and incorporation of *its* Information into a work — that is what F2b/F2c/F6
did. F2/F3's estimator arm collects daily OHLCV from Yahoo Finance, a distinct source under a distinct terms
regime, and doc 58's own method section already scoped that collection to research use only. So F2/F3 stand
unretracted here; whether a *stricter* reading of "research use" should also reach Yahoo-collected data is a
separate, already-open question (docs/reviews/universe-path-gap-sweep-2026-09-03.md F8, tracked by #1053/#1054),
not decided by this ticket.

## F1 — realised fills do not exist, and the paper soak cannot ever produce the ones #882 needs

#882 says validating the floors "needs realised fills from the paper soak **or** the live equity leg". Checked
against `data/samurai-paper.sqlite` <!-- cite-exempt: untracked — gitignored local file --> (2,174,976 B, mtime 2026-09-02T03:47Z, zero-byte WAL so nothing is
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
one-off manual probe, not a pipeline decision. `data/samurai.db` <!-- cite-exempt: untracked — gitignored local file --> is **0 bytes**, so no live-leg store exists at
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

**Correction 2 — RETRACTED IN SUBSTANCE, 2026-09-08 ([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)).**
The ticket says its answer "needs LSE quote data that does not currently exist for free". The London Stock
Exchange's own website is a JavaScript app backed by an **unauthenticated** endpoint that returns bid and offer
per TIDM — that narrow technical claim ("a free endpoint exists") stands. But [#999](https://github.com/dd-jp/samurai-trading-system/issues/999)
found this exact endpoint barred by LSE Terms §8 (no programmatic access, personal use only, no incorporation
into a work), so **#881's blocker is not resolved by it**: this repo cannot permissibly use the endpoint to
collect research data, and functionally the blocker stands. The endpoint is documented below for the audit
record, not as something to query — do not run this or an equivalent request against it:

```
https://api.londonstockexchange.com/api/gw/lse/instruments/alldata/<TIDM>
```

At the time of the now-retracted capture, this endpoint was found to cover all 30 pool lines, plus `marketsize`
(Exchange Market Size — the size the quote is good for), `segment`, `currency` and `sedol`. This does not touch
open [#895](https://github.com/dd-jp/samurai-trading-system/issues/895) — doc 34 §5's licence and freshness
analysis still governs what may price the *live book*.

The producer script, `58-lse-quote-snapshot.py`, is deleted from the tree. See the RETRACTION notice above.

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

**RETRACTED 2026-09-08 ([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)).** This section's
four static-source findings stand — none of them touches LSE's forbidden Information. Its conclusion does not:
"the realistic path is to sample the free endpoint ourselves" is exactly the collection [#999](https://github.com/dd-jp/samurai-trading-system/issues/999)
found barred by LSE Terms §8. [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) has since
reported a licensed substitute — see `46-lseg-dmd-pretrade-surface.md` and the RETRACTION notice above.

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

**This was originally read together with F6, which was said to contradict it and win.** F6 is **RETRACTED**
([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)) — its 12.61x figure must not be cited.
What remains is that the estimator's own statistic here (1.81x/1.92x, below #875's 2x threshold) is biased low
for two reasons already established above, both of which push the same way:

1. **The estimator compresses dispersion by construction** — F2 measured 4x estimated against 12x true on the US
   names, a 3x compression.
2. **The screen removes the wide names, not the tight ones.** Twenty of thirty are excluded for having no usable
   range data, and thinness and width are the same phenomenon. What survives is the *liquid tenth* of the pool.

So the estimator arm's dispersion statistic is a **lower bound, reported for completeness — and, with F6
retracted, the only quantification this document currently has standing.** **[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)
has since reported the permissibly-collected measurement that replaces it** — see
`46-lseg-dmd-pretrade-surface.md` (159.0 bps pool open-bucket median round-trip, 4.19x/57.70x max/median/max-min
dispersion). What the estimator arm *does* establish, on its own screened data with no dependency on F6:
**every one of the ten screened names estimates wider than SPY (2.1x to 15.6x), and eight of the ten estimate
wider than TSLA** — the name doc 53 measured at 4.216 bps, already **4.2x the 1bp floor**.

## F6 — RETRACTED: free LSE quotes across all thirty lines (impermissible collection)

**RETRACTED IN FULL, 2026-09-08 ([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)).** This
was collected by `58-lse-quote-snapshot.py`, an unauthenticated scrape of the London Stock Exchange website.
[#999](https://github.com/dd-jp/samurai-trading-system/issues/999) read LSE's Terms §8: programmatic access is
barred, retrieval is personal-use only, storage on any networked server is barred, and incorporation into a work
or publication is barred. This is a different defect from the pre-open timing caveat below — that caveat says
the numbers are pessimistic; this one says **the collection method itself disqualifies them regardless of
timing, and re-running at a better time of day does not fix it.** No number below this line — the table, the
median 88.1 bps, the 480.5x max/min, the 12.61x max/median, the 44.1 bps implied half-spread — may be cited or
relied on. The script is deleted from the tree (git history retains it); the raw log is kept, retracted, at
[`archive/raw/2026-09-02-58-lse-quotes-preopen.txt`](archive/raw/2026-09-02-58-lse-quotes-preopen.txt).
[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) has since reported the replacement — see
`46-lseg-dmd-pretrade-surface.md`. The table is kept below only as the audit record of what was collected and
why it doesn't count.

**The three paragraphs that follow are historical: what the document argued before the 2026-09-08 retraction
above, kept as audit record — not current guidance, and none of it reopens the retraction.** (The table and the
"three things fall out" list further below carry their own, still-current, retraction annotations.)

**PROVISIONAL, and the caveat was load-bearing, as originally written.** Captured 2026-09-02 05:34 Europe/London,
i.e. **before the 08:00 open**. Out of continuous trading the endpoint returned the *previous session's closing*
quotes (`tradingstatuscode: "N c"`, prior-session volume; re-running minutes later returned byte-identical
values). LSE's market-maker obligations bind quotes to "at least 90% of continuous trading during the mandatory
period" and explicitly **not** during the opening auction, so these were said not to be the spreads a fill would
cross.

**Direction of error, as originally argued: this capture was said to be most likely PESSIMISTIC — the opposite
of this repo's usual hazard.** The obligations that cap a market maker's quoted spread bind *during* continuous
trading and not outside it, so an out-of-session quote was argued to be unconstrained and plausibly wider than
the same line in session, with the wide names widening most — the direction that would have inflated the 12.61x
max/median, if that figure still had standing. It was asserted, not measured. (The original text used this
argument to justify an in-session re-sample as the next step; the ruling below has since been rewritten to say
the next step is #1035's licensed path instead, **not** a re-run of this script.) The counter-consideration
offered at the time: F3's flat-day evidence and doc 34 §3.3's print-frequency measurements are independent of
session state and point the same way.

The script printed `IN CONTINUOUS SESSION: False` on this run and refused to imply otherwise — it no longer
exists to print anything; it is deleted (see the retraction above). The original text said this had to be
re-sampled in session before any number here was used to size anything. **The retraction above supersedes that
instruction: no number here may be used at all, in session or out — use** `46-lseg-dmd-pretrade-surface.md`
**([#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035), reported 2026-09-15) instead** — doc
53 G3's measured intraday profile on the US names (TSLA's open median 2.7x its close median) is why session
timing matters at all, and doc 46 now measures the LSE pool's own open/close ratio directly (median 1.67x
across 30 rows), not a license to re-run the deleted collection method at a better hour.

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

Three things were said to fall out of this table; **all three are retracted along with it** — none is disproven,
each simply has no permissibly-collected evidence behind it any more:

1. ~~#881's question is answered YES, decisively.~~ 12.61x is a retracted figure and must not be cited as the
   answer to #881. F2/F3's estimator arm still independently shows cost varies within the universe (§"What #881's
   own statistic says" above), just not by this magnitude.
2. ~~ADR-0016's single observed quote is fine for 3USL and badly unrepresentative of the pool.~~ The 0.156%/0.88%/11.1%
   comparison came from F6 and is retracted with it.
3. ~~The widest lines are TICK-BOUND, not liquidity-bound.~~ LCO3's and 3LSQ's quoted prices came from F6 and are
   retracted with it — the tick-over-price *mechanism* (a small tick on a low-priced line) is a general fact about
   how prices and ticks interact, but the specific bps figures asserting it fired here are not usable.

Nothing above replaces these three; see the RETRACTION notice.

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

**The commission gap is 8x against the live venue — but it is a missing RATE, not an under-sized floor, and the
distinction decides what gets changed.** `commissionRate` is **0** in `CALIBRATED_COST_CONFIG.stocks`, which is
*correct*: Alpaca US equities are commission-free, and `run-stage2.ts:96-103` says so explicitly, leaving the
floor to stand in for the regulatory pass-through. So the floor binds **because the rate is zero** — that is the
guard doing exactly its specified job, not failing.

[ADR-0015](../adr/0015-live-venue-account-and-book-split.md):201 records Saxo's **8 bps-per-side Classic tier
with no per-order minimum**, i.e. **0.16% = 16 bps round trip** at both the £350 and £250 position sizes, against
a model charging **2 bps round trip**. Set `commissionRate = 0.0008` for the Saxo path and the floor never binds
at all. What is actually missing is therefore a **venue-keyed commission rate** — and F5 records that no venue
identity reaches this seam, so the config has nowhere to put one. **Raising `STRUCTURAL_MIN_COMMISSION_RATE` to
8 bps would be the wrong fix**: it would over-charge every Alpaca-paper backtest by 8x.

The 16-vs-2 bps arithmetic and the flattering direction are unaffected by this re-attribution. ADR-0015:207
already anticipated it:

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
  `docs/specs/cost-model-backtest-spec.md:148` state it as *representability*: "the most optimistic config still <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->
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

### #881 — YES, a per-instrument term is justified; the "sample the free feed" evidence is RETRACTED. Narrow the universe.

The ticket asks "whether cost varies enough *within the tradeable universe* to justify a per-instrument term at
all", and states that answering it "needs LSE quote data that does not currently exist for free".

**RETRACTED EVIDENCE, 2026-09-08 ([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)).** The
paragraph below cited F2b and F6 for the "data exists and is free" and "12.61x max/median and 480x max/min"
claims. F6 is retracted in full (impermissible collection, [#999](https://github.com/dd-jp/samurai-trading-system/issues/999));
F2b's premise correction that a free endpoint *exists* stands, but the endpoint may not be used to collect
research data. **Nothing quantified the live-universe dispersion until #1035 reported** — until then this
ruling's magnitude claim was unsupported, though the ruling itself (a per-instrument term is justified, ship
#1035's licensed sampler first — **not** the retracted free-endpoint one) was not re-opened here; see #1035's
own acceptance criteria, which already treated the #881 ruling as "provisional indefinitely" if no permissible
source was found. **[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) has since reported**
(`46-lseg-dmd-pretrade-surface.md`, 2026-09-15): 4.19x max/median and 57.70x max/min open-bucket dispersion
across the 30 covered rows — narrower than F6's retracted figures, but the per-instrument-term ruling is not
reopened by this; doc 46's own dispersion still clears the 2x threshold by a wide margin.

**Both halves of that framing were said to be wrong, and in opposite directions.** The data exists and is free
(F2b). And once measured, the dispersion was said not to be marginal — it was **12.61x max/median and 480x
max/min** across the thirty lines (F6, retracted), against a threshold of 2x. That specific magnitude is no
longer evidenced; whether cost varies *enormously* within the tradeable universe was open again pending #1035.
**[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) has since reported**
(`46-lseg-dmd-pretrade-surface.md`, 2026-09-15): the independently-measured dispersion is 4.19x max/median and
57.70x max/min open-bucket — smaller than F6's retracted claim, but still well past the 2x threshold, so the
question is answered yes on permissible evidence, though not at F6's specific magnitude.

*An earlier draft of this document ruled the opposite way, on the estimator arm's 1.81x. That ruling was wrong
and is retracted here rather than quietly edited: the estimator compresses dispersion 3x by construction and its
screen removes exactly the wide names (F3). It is left in the document as a lower bound and a lesson — a screened
proxy statistic disagreed with a direct measurement. Whether that direct measurement was right no longer has
standing to say: F6 is retracted along with it, and the estimator's own 1.81x/1.92x is, for now, the only
quantification this document has (see "What #881's own statistic says" above). The construction argument against
the estimator's low-ball reading stands independent of F6's retraction; the claim that F6 specifically was
correct does not.*

The ruling, in order of what should actually be built:

1. **Do not hand-fit a per-symbol coefficient from a single snapshot.** F6 was one out-of-session capture and is
   now retracted in full — **not** because it was out-of-session, but because `58-lse-quote-snapshot.py`
   scraped a source LSE's Terms §8 bars ([#999](https://github.com/dd-jp/samurai-trading-system/issues/999),
   [#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)); that script is deleted and must not be
   re-written against the same endpoint. The first ship is **not** that sampler; it was
   [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) (reported 2026-09-15, see
   `46-lseg-dmd-pretrade-surface.md`), which built the sampler against LSEG Delayed Market Data instead and
   produced both the per-instrument level (159.0 bps pool open-bucket median round-trip) and the session profile
   that doc 53 G3 showed matters (TSLA's open 2.7x its close; doc 46 measures this LSE pool's own median at
   1.67x on 2 days of data).
2. **The per-instrument term is justified and the seam is ready** — F5 records that `fill()` already holds
   `request.instrument`. Build it *against sampled data*, not against this snapshot.
3. **The functional form may have to change, not just the coefficient — but the evidence for it is retracted.**
   LCO3's quoted 8.5p/9.5p came from F6 and is retracted with it (the same figure retracted in the "three things
   fall out" list above), so "a one-penny tick on a 9p line is 11%" is not currently evidenced. The tick-over-price
   *mechanism* is general and independent of F6 — a low-priced line's spread can be dominated by the exchange's
   minimum tick rather than by liquidity — so a minimum-tick-over-price floor, a different shape from anything in
   `CostConfig`, remains worth building once #1035 supplies a permissible per-instrument price; it just cannot be
   sized from this snapshot. **[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) has since
   reported** (`46-lseg-dmd-pretrade-surface.md`, 2026-09-15): every covered row, LCO3 included, carries
   `bidLimitPrice`/`offerLimitPrice` per snapshot, so a permissible per-instrument price now exists to build and
   size the minimum-tick-over-price floor against — this line's blocker is cleared, though the floor itself is
   not yet built.
4. **Narrow the universe, and treat that as the larger finding.** Twenty of thirty lines cannot be priced from
   free daily bars; three return **one bar in two years**; 3LSQ and 3RAC are flat on 43% and 38% of sessions.
   ADR-0016's commodity-ETC leg was never encoded, and its whole leverage case rests on one 3USL quote that F6
   (retracted) placed as the pool's 6th-tightest line out of thirty — that ranking is not currently evidenced.
   Independent of F6, twenty of thirty lines cannot be priced from free daily bars at all (F3, unaffected by
   this retraction), which alone is a *universe* decision, not a cost-model parameter.

**What would reverse this:** permissibly-collected in-session sampling (#1035) showing continuous-trading
spreads are both tight and uniform. F6 is retracted rather than merely provisional, and this ruling's magnitude
claim was unsupported until #1035 reported — which is exactly why the first ship was a licensed sampler, not a
coefficient fit to a retracted snapshot. **[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)
has since reported** (`46-lseg-dmd-pretrade-surface.md`, 2026-09-15): the spreads are neither tight nor
uniform — 4.19x/57.70x dispersion, pool median 159.0 bps round-trip, ~3.1x the single-stock cost budget — so
this ruling is not reversed; it is confirmed on independent, permissibly-collected evidence.

### #882 — the modelled cost is under-sized, and the floors must stop being module constants

1. **Under-charged and flattering — but the two legs have different defects, and conflating them causes a bad
   fix.**
   - **Commission: the RATE is missing, and the floor is fine.** Saxo charges **8 bps per side**
     (ADR-0015:201) against a modelled **1 bp**. But `commissionRate` is **0** because Alpaca is
     commission-free, so the floor binds only as its specified backstop. The fix is a **venue-keyed
     `commissionRate = 0.0008`**, after which the floor never binds. **Raising
     `STRUCTURAL_MIN_COMMISSION_RATE` to 8 bps is the wrong fix** — it would over-charge every Alpaca-paper
     backtest by 8x and break `paper-profile.test.ts` for the wrong reason. Leave that floor at 1 bp.
   - **Half-spread: this is where the genuine floor question lives.** **All 30 of 30** pool lines were said to
     show a half-spread above the 1 bp floor, at a median of **44 bps** — that figure is F6, **retracted in
     full** ([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)), and must not be cited. What
     survives independent of F6: F2/F3's estimator arm still shows every screened LSE name estimating wider than
     SPY, and doc 53 §G4 independently argues the sign (an LSE leveraged ETP's real spread is very likely wider
     than a US mega-cap's) — so the *direction* (under-charged) still holds; the *magnitude* is now reported by
     [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) (`46-lseg-dmd-pretrade-surface.md`):
     **79.5 bps** half-spread at the pool open-bucket median (this line's retracted 44 bps figure above is not a
     valid comparison baseline — see F6's retraction). The model already prefers a
     supplied spread (`marketState.spread ?? volatility × coefficient`), so **feeding real sampled LSE spreads
     into `marketState` may be a better fix than raising this floor** — which is another reason a licensed
     sampler, not this retracted snapshot, ships first.

   Put together, at the £350/£250 position sizes ADR-0018 D5 resolves to: the model charges **~4 bps round
   trip**, while commission alone is **16 bps**. The median line's spread was said to add **~88 bps**; that
   number is retracted with F6. Against an edge ADR-0018 measures in single-digit bps per session, the
   commission gap alone is not a calibration nuance — it is a large fraction of the way to the difference
   between a positive and a negative expectancy, and the spread leg is real in sign but unquantified in
   magnitude pending #1035.
2. **A dominating floor must not be inert.** Principle 1 requires only that a frictionless fill be
   unrepresentable (`cost-model-backtest-spec.md:148`); it does not mandate 1 bp. The floors become a table on
   `CostConfig`, keyed by asset class today and by venue once a venue identity reaches the seam.
3. **The evidence gate in the ticket is wrong and is corrected here.** "Needs realised fills from the paper soak
   or the live equity leg" — the paper soak can never supply them (F1). Waiting on it would have waited forever.

**What would reverse this:** realised Saxo fills showing an effective all-in cost below the re-sized floor, or a
tier change in Saxo's schedule.

**What this does NOT authorise:** picking a final number for the half-spread floor from F6 — F6 is **retracted**
([#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)), not merely out-of-session, so it cannot
be cited even as a provisional order of magnitude any more; and F2 separately forbids converting an *estimate*
into bps at all. Commission has a sourced, actionable figure to set as a **rate** (8 bps per side); the
half-spread has a **sign** and now a permissible measurement —
[#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035) (`46-lseg-dmd-pretrade-surface.md`, reported
2026-09-15: 79.5 bps pool open-bucket median half-spread), not a guess and not a re-run of the deleted script.
It also does not authorise raising `STRUCTURAL_MIN_COMMISSION_RATE`, for the reason in point 1.
