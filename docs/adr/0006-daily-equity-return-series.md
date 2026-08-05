# ADR-0006 — The daily equity return series: GAP-8's second half

- **Status:** Accepted
- **Date:** 2026-08-05
- **Ticket:** [#345](https://github.com/dd-jp/samurai-trading-system/issues/345) (split from [#327](https://github.com/dd-jp/samurai-trading-system/issues/327) / PR #343)
- **Supersedes nothing. Completes:** [#332](https://github.com/dd-jp/samurai-trading-system/issues/332) (`session_equity`, migration 0009), [#331](https://github.com/dd-jp/samurai-trading-system/issues/331) (`TradingCalendar.sessionStart`)

## Context

`computeMetrics(returns, trades)` — the four kill-lines' input — needs a
`ReturnSeries`: evenly spaced periodic **equity** returns. Nothing in this repo
could produce one, so `DailyMetricsSource` shipped in #343 as a port the
operator had to fill by hand, with a `warn` at startup admitting it.

The gap has a name. Migration `0006_account_state.sql` reserved
`daily_open_equity` / `daily_pnl_pct` as an open decision called **GAP-8**, and
#332 resolved *half* of it: `session_equity` gives the daily-loss breaker a
locally-owned session boundary and denominator, replacing Alpaca's blended
`last_equity` on a reset boundary nobody had verified. That closed the
percentage question. It did not close the series question, because
`session_equity` is keyed `asset_class PRIMARY KEY` and upserts `DO UPDATE` —
three rows, each boundary destroying the previous session's open.

Two things made getting this right load-bearing rather than tidy:

1. **A breach is not a report.** `autoTighten` *writes* every risk threshold
   toward its extreme and appends to the `AdjustmentLog`. A wrong series does
   not produce a wrong number on a dashboard; it moves real risk configuration.
2. **A return series cannot be backfilled.** Equity that was never sampled on
   the day is gone. Whatever we decided had to start capturing immediately.

## Decision

### 1. GAP-8's remaining half resolves as an append-only series on the portfolio boundary

A new table, `daily_equity` (migration `0011`), holds one immutable row per
**portfolio session** — one per UTC day:

```sql
CREATE TABLE daily_equity (
  session_start        TEXT PRIMARY KEY,
  equity               REAL NOT NULL,
  recorded_at          TEXT NOT NULL,
  observed_at_boundary INTEGER NOT NULL CHECK(observed_at_boundary IN (0, 1))
);
```

Not columns on `account_state` (whose `NOT NULL peak_equity` single-row keying
0006 already explains), and **not a widening of `session_equity`**. That last
one is the real choice: a composite key there would have worked mechanically,
but it would change what `SqliteSessionEquityStore.get(key)` *means*. Today it
answers "the session in force"; with history in the table it would have to
answer "which row did you want", and every daily-loss breaker read would learn
to pick one. The breaker is the single path where a wrong answer trades real
money, so the series samples that table's boundary rather than mutating the
table.

### 2. The boundary is reused, not reinvented — UTC day, from `TradingCalendar.sessionStart`

The sampler lives inside `AlpacaAccountStateProvider.sessionBasisFor`, on the
same call to `TradingCalendar.sessionStart` (#331) the snapshot already makes.
No second timer, no second definition of "a day" — the series and the breaker
cannot drift onto different calendars because there is only one call.

It samples the **`portfolio`** key only, and that is what makes the result a
legal `ReturnSeries`:

- **`portfolio`** rides `AlwaysOpenCalendar` — 00:00 UTC — because #332
  specifies the portfolio-level figure as the UTC one (the account holds crypto
  that never stops trading). Consecutive UTC midnights are **exactly 86,400,000
  ms apart, every day of the year**, so `periodsPerYear` is 365 with no
  approximation.
- **`stocks`** rides the prior 16:00 ET close, which skips weekends and
  holidays. A Friday→Monday step is three days wide. Annualizing those as single
  periods is wrong by construction, so the stock boundary is deliberately not
  the anchor.
- **`crypto`** shares the portfolio's UTC midnight exactly (`calendarFor`), so
  sampling it too would duplicate every row.

### 3. Equity returns, not realized-PnL returns

`(E_t − E_{t−1}) / E_{t−1}`, simple (not log) fractions per `ReturnSeries`.

The available alternative — each day's realized `ClosedTrade` PnL over deployed
capital, which `toReturnSeries` already does for backtests — is wrong here for
the reasons #345 gives: wrong denominator, and unevenly spaced. It also books an
open position's entire move on whichever day someone happens to close it. Equity
includes unrealized marks, so a drawdown appears while it is happening rather
than only once traded out of.

### 4. First write wins; evenness is checked, never assumed

`ON CONFLICT(session_start) DO NOTHING`. Equity is sampled on the first tick
after the boundary, so the first observation of a session is the closest to the
true open; later ticks must not drag it forward all day. This is also the
restart behaviour: a returning process finds the row and leaves it alone.

A process that is **down across a midnight** still leaves a hole, and the rows
either side are 48h apart while looking adjacent. Treating that as one period
would book two days of PnL as one daily return — inflating the mean, understating
the variance, flattering the Sharpe on precisely the days the system was broken.
So `session_start` is the primary key and the reader walks the trailing run
backwards, stopping at the first step that is not exactly one day (and at any
non-positive equity, which would make the next return `Infinity`/`NaN` — and
`NaN` compares false against every kill threshold, so the lines would silently
stop firing rather than fail).

Rows flagged `observed_at_boundary = 0` are **kept**, not dropped: their spacing
is still exactly one day, and dropping them would punch exactly the hole
described above. The flag stays queryable so a suspicious return can be traced
to a late sample rather than to the market.

### 5. Capture from day one; evaluate only above 60 returns

`SqliteDailyEquityMetricsSource` refuses to compute a suite below
`MIN_RETURN_OBSERVATIONS = 60` returns, returning the port's existing
first-class `undefined` and logging the reason once per feedback cycle.

The statistics, stated honestly. For an IID sample (Lo 2002 eq. 8; Jobson &
Korkie 1981), `SE(Ŝ_period) ≈ sqrt((1 + Ŝ²/2)/n)`. The suite reports an
*annualized* Sharpe, `S_ann = S_period·√P`, so with `T = n/P` years:

```
SE(S_ann) ≈ sqrt(1 + S_ann²/(2P)) / √T   ≈  1/√T  for small S_ann
```

**Precision is governed by the number of years, not observations.** Sampling
more often buys nothing. At `P = 365`:

| n | T (yr) | SE(S_ann) |
|---|---|---|
| 10 | 0.027 | ≈ 6.0 |
| 30 | 0.082 | ≈ 3.5 |
| 60 | 0.164 | ≈ 2.5 |
| 120 | 0.329 | ≈ 1.7 |
| 365 | 1.0 | ≈ 1.0 |

A 14-day soak yields ~10 observations. Its 95% interval on the annualized Sharpe
is roughly ±12 — a true Sharpe of +2 and one of −2 are indistinguishable. This is
not a weak measurement; it is no measurement. The project's own fixture makes the
point concretely: a near-flat sawtooth account over 9 returns reports an
**annualized Sharpe of 20.9**.

60 is chosen as a floor for three reasons, none of which is "60 is enough":

1. It is the smallest n at which the asymptotic-normal SE above is even a fair
   approximation — below ~30 the estimator's small-sample bias and the
   t-correction are material, and the gate would be reasoning with a formula
   outside its own validity.
2. It puts a full calendar quarter between the start of a run and the first time
   a kill-line can move anything, which is longer than any planned soak. So
   `autoTighten` cannot fire during the soak this system is about to run — the
   specific outcome #345 asks for.
3. `computeMetrics` applies Lo's autocorrelation correction with lags up to
   `min(P−1, n−1)`. At n = 60 the highest lags are estimated from a handful of
   pairs; below 60 the correction does no real work at all.

**This is a floor of meaninglessness, not a precision guarantee.** At n = 60 the
annualized Sharpe still carries SE ≈ 2.5. `minReturnObservations` may therefore
be **raised** (toward 365, where the estimate becomes arguably decision-grade)
but is **refused if lowered** — the floor is a safety property of a path that
writes risk thresholds, not a preference a config may switch off.

### 6. `backtest_reference_sharpe` stays inert — [#375](https://github.com/dd-jp/samurai-trading-system/issues/375)

Out of scope here and deliberately unfixed. This ADR sources the *live* half of
the divergence comparison; the baseline has no persisted source, because there
has been no backtest of anything this system trades
(`stage2-validation-execution-spec.md`: "the machinery has never been run
against a real strategy"). Supplying a plausible number would arm `autoTighten`
against a reference nobody measured. Documented at the config site, tracked in
#375.

## Consequences

**Good.**

- A soak now captures the series from its first tick, unconditionally and
  without configuration. That is the irreversible half, and it no longer depends
  on anyone remembering.
- The kill-lines' input exists in-repo for the first time; `DailyMetricsSource`
  is a real implementation rather than a port with an apology attached.
- The series and the daily-loss breaker share one boundary by construction.
- The soak's `autoTighten` cannot fire on noise — twice over, since the gate and
  the inert `backtest_reference_sharpe` are independent.

**Costs, accepted.**

- **The kill-lines stay unevaluated for ~2 months of running.** This is the
  point, not a regression: they were unevaluated before too, just silently.
  Now the reason is logged daily with the observation count.
- **`AlpacaAccountStateProviderInput.dailyEquity` is required, not optional.** It
  breaks any out-of-tree construction of the provider. Chosen for that: an
  optional writer makes "we captured nothing for six weeks" a silent condition,
  and there is no recovery from it.
- **A gappy run degrades to its trailing contiguous stretch.** A process that
  restarts across midnights repeatedly may never accumulate 60 consecutive days.
  That is the honest reading of the data, and the fix is uptime, not
  interpolation.
- **Only the portfolio-level series exists.** Per-asset-class Sharpes would need
  either per-class equity (which the broker does not decompose) or the uneven
  stock boundary. Neither is worth inventing before anything consumes it.
