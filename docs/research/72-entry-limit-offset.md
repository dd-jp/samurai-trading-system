# 72 — Entry limit offset: evidence (#1815)

**Status 2026-09-27.** David ruled the paper entry a marketable limit with a capped offset (doc 66, #1815). He then set the offset and its reference price to "base it on actual data and evidence backed", with a paper test as well. This doc is that evidence.

**Overruled 2026-09-29.** David set the offset at 50 bps through the decision close (buy at close × 1.005, short at × 0.995), as a judgement rather than a measurement (#1815). The code is `ENTRY_LIMIT_OFFSET` in `server/apps/v2/risk/entry-limit.ts`. Sizing and the cash gate now price the entry at the limit, not at the decision price (§3 Sizing below). The evidence and the paper test are unchanged. The 0 bps result below is the measured optimum, not the running setting.

**Result:**
- **Reference price:** the decision close.
- **Offset:** 0 bps. The entry stays a limit at the prior close.
- **Paper test:** run by hand during paper (nothing schedules it), `npm run v2:entry-offsets` scores the debate's own journalled entries at 0, 50, 100 and 200 bps and at the open.
- **When to decide again:** once about 100 paper entries have a full 10-bar hold.

## 1. The question

The ruling's premise came from the #1797 kill-line run: a limit at yesterday's close fills only on days that trade back down to it, so a sleeve that buys strength is adversely selected. Two questions follow:

1. Measured over the universe, does a higher cap help?
2. Which reference price should the offset be measured from?

**Reference price.** The cycle runs once a day, after the close. The order goes out before the next open, so the decision close is the only price known when it is sent. An open-referenced limit would need a second, intraday cycle, which v2 does not have. The reference is therefore the decision close.

## 2. Data and method

**Data.** Alpaca SIP daily bars, all adjustments, from `data/bars/parquet/venue=alpaca` <!-- cite-exempt: untracked — local bar store, not committed -->: 745 symbols (every name on the S&P 500 list at any point since 2016, delisted ones included, each over its full history in the store rather than only while a member), 2016-01-04 to 2026-09-23. That gives 1,754,121 symbol-days in total, 422,796 of them since 2024-01-01.

**Setup.** Every symbol-day is a hypothetical entry at the close, c. Day-count filter: the next bar is at most 5 calendar days away.

- **Buy at offset x:** a limit at c × (1 + x/10⁴).
  - It fills if the next bar's low ≤ limit.
  - The fill price is min(next open, limit), the rule in `server/apps/v2/simulated-entry.ts`.
- **Short:** the mirror image of the buy.

**Hold.** 10 bars (`DEBATE_TIME_STOP_TRADING_DAYS`) to the close of the 10th bar. The stop and target are not modelled.

**Return measured.** The return in excess of the equal-weight universe return over the same open-to-exit window. This keeps market drift out: without it, a missed buy looks costly in a bull market and a missed short looks like a gain, which says nothing about selection.

**Counting.** A missed fill counts 0. Each offset is compared with a market-on-open entry (always filled at the next open).

**Confidence intervals.** 95%, from 1,000 bootstrap resamples of whole trading days, not rows. Signals on the same day are correlated, so the effective sample is about 2,700 days.

## 3. Results

Mean excess per signal, in bps, relative to market-on-open, with the 95% CI:

| Cut | 0 | 50 | 100 | 150 | 200 | 300 | 500 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Buy, all, 2016+ | **+6.69** [5.28, 8.03] | +2.85 | +1.30 | +0.81 | +0.59 | +0.30 | +0.14 |
| Buy, up days, 2016+ | **+8.55** [6.48, 10.68] | +4.44 | +2.79 | +2.18 | +1.79 | +1.05 | +0.65 |
| Short, all, 2016+ | **+5.75** [4.31, 7.27] | +4.18 | +2.94 | +2.28 | +2.01 | +1.17 | +0.92 |
| Short, down days, 2016+ | **+6.27** [3.79, 9.41] | +4.77 | +3.78 | +3.18 | +2.83 | +1.39 | +0.90 |
| Buy, all, 2024+ | **+4.19** [1.82, 6.65] | +1.09 | +0.11 | −0.13 | −0.05 | +0.07 | −0.08 |
| Buy, up days, 2024+ | **+5.02** [1.67, 8.29] | +1.80 | +1.21 | +0.83 | +0.61 | +0.78 | +0.20 |
| Short, all, 2024+ | **+6.38** [4.21, 8.70] | +4.29 | +2.58 | +1.69 | +1.34 | +0.67 | +0.04 |
| Short, down days, 2024+ | **+6.02** [2.78, 9.40] | +4.11 | +2.74 | +1.95 | +1.80 | +0.94 | +0.00 |

**Fill rates (2016+, all):**

| Side | 0 bps | 50 bps | 100 bps | 200 bps |
| --- | --- | --- | --- | --- |
| Buy | 84.4% | 93.9% | 97.2% | 99.0% |
| Short | 87.5% | 94.8% | 97.4% | 99.0% |

**Reading.**
- In every cut, the limit at the close does best, and its CI excludes zero.
- Wider offsets move the result toward market-on-open; past 200 bps the steps are within noise and not strictly ordered.
- The fills a limit misses are the names that gap through it. From the open, those names then underperform the market over the hold, so missing them helps.
- The "up days" and "down days" rows proxy a sleeve that buys strength or sells weakness. The effect there is the same or larger.
- On this data, the premise of the #1815 ruling does not hold.

**Bracket check.** An offset above 0 has a side effect: Alpaca refuses a bracket whose take-profit is not beyond the limit. With the target at 3 × ATR14, that happens on the share of days below:

| Offset | 2016+ | 2024+ |
| --- | --- | --- |
| 50 bps | 0.74% | 0.18% |
| 100 bps | 0.86% | 0.46% |
| 200 bps | 1.08% | 0.83% |

At an offset of 0 the target is always beyond the limit.

**Sizing.** A fill above the close widens the risk to the fixed stop, and Alpaca reserves buying power at the limit. Neither applies at 0. At the ruled 50 bps both do, so sizing and the cash gate price the entry at the limit (`server/apps/v2/risk/gate.ts`, #1815).

## 4. Limits of this evidence

- **Random entries, not the debate's picks.** A signal that predicts continuation from the close could make misses costly. The debate is forward-paper only (Q15), so its own entries can only be measured in paper, hence the report.
- **Close-to-close hold.** The 2 ATR stop and 3 ATR target are not modelled.
- **Venue.** US large caps only. The Saxo LSE leg is not measured and is not live (`venueFor` returns only `'alpaca'`). Its offset is decided when that leg is enabled.

## 5. The paper test

`npm run v2:entry-offsets [store] [bar root]` (`server/apps/v2/report-entry-offsets.ts`):
- Reads every Alpaca entry order in the v2 journal, one per date, instrument and side across books, whatever its outcome (submitted, rejected or dry run): the question is the price the signal asked for, not whether the order went out.
- Replays each against the bars at 0, 50, 100 and 200 bps and at the open.
- Scores the same 10-bar excess, over SPY rather than the universe mean.
- An entry without 10 bars yet, or whose SPY bars do not cover the same dates, is counted as awaiting. A row with an unreadable payload is skipped.

Once about 100 entries are scored, a 0-bps mean below the others by more than its noise reopens #1815. Changing the offset is a new trial (Q16).

## 6. Reproducing section 3

The core query, in DuckDB over the bar store. Here `h` is 10 and `x` is the offset in bps; `mkt` is the per-day mean of `nhc/nxo - 1`.

```sql
CREATE TABLE p AS
SELECT symbol, d, c, lag(c) OVER w pc, lead(o) OVER w nxo, lead(h) OVER w nh, lead(l) OVER w nl,
       lead(c, 10) OVER w nhc, lead(d) OVER w nd
FROM bars WINDOW w AS (PARTITION BY symbol ORDER BY d);
CREATE TABLE m AS SELECT d, avg(nhc/nxo - 1) mkt FROM p GROUP BY d;
-- per day, buy side:
SELECT d, avg((CASE WHEN nl <= c*(1+x/1e4) THEN nhc/least(nxo, c*(1+x/1e4)) - 1 - mkt ELSE 0 END)
              - (nhc/nxo - 1 - mkt)) * 1e4
FROM p JOIN m USING (d) GROUP BY d;
-- up days only: add WHERE c > pc; the short side mirrors with nh, greatest, 1-x/1e4, a negated
-- excess and, for down days, WHERE c < pc.
```

The bootstrap resamples those per-day values, with seed 1815 and 1,000 draws.
