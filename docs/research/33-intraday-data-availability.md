# Intraday data availability — what the event study can actually be run on

**Date:** 2026-08-09 · **Ticket:** [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) · **Map:** [#631](https://github.com/dd-jp/samurai-trading-system/issues/631)

Written after [#632](https://github.com/dd-jp/samurai-trading-system/issues/632) moved the product to an **intraday** horizon and [#653](https://github.com/dd-jp/samurai-trading-system/issues/653) proposed deriving trading levels from a ~10-year event study. Neither is runnable without data the project may not have. **Every claim below marked VERIFIED was tested against a live API call with this project's own keys, not read from documentation** — the documentation was wrong on the single most important point.

## Verdict

| Need | Status | Depth |
|---|---|---|
| **US equity/ETF 1-minute bars** | **VERIFIED FREE** — Alpaca, full SIP consolidated tape | **2016-01-04 → now (~10.6y)** |
| **Crypto 1-minute bars** | **VERIFIED FREE** — Alpaca | **~2021-01-04 → now (~5.6y)** |
| **LSE 1-minute bars** — *the actual live tradeable universe* | **NOT AVAILABLE FREE at 10y** | best free option ~1y |
| **Dividend / corporate-action calendar** | **VERIFIED FREE** — Alpaca | 2020 tested, with `ex_date` |
| **Macro calendar (FOMC/CPI/NFP)** | **NOT RESEARCHED** — gap in this document | — |
| **Backtest harness intraday replay** | **NOT BUILT** — hard-wired to daily | — |

## 1. US equities and ETFs — free, full tape, 10.6 years

Documentation summaries claim the Basic plan is IEX-only, and that IEX is ~2–3% of consolidated volume. **That is wrong for historical bars.** Tested directly:

```
GET /v2/stocks/bars?symbols=SPY&timeframe=1Min&start=2020-06-01T13:30:00Z&feed=sip
-> {"c":303.12,"h":303.69,"l":303.06,"n":2586,"o":303.61,"v":593003,"vw":303.448621}

same window, feed=iex
-> {"bars":{}}
```

593,003 shares and 2,586 trades in one minute is the **consolidated tape**, not IEX. The free plan serves historical SIP bars; it is *real-time* SIP that is restricted.

**Depth, tested:** `2016-01-04` returns bars (SPY 200.49 open, 2.49m volume). `2015-06-01` returns `{"bars":{}}`. **2016-01-04 is the hard floor** — ~10.6 years to today, which satisfies #653's ten-year requirement exactly.

**Coverage tested beyond SPY:** `GLD` and `IWM` both return 1-minute bars from 2016. Commodity and small-cap ETFs are in scope.

**Rate limit:** 200 requests/min on Basic. Sufficient for a backfill run, not for live per-tick polling of a wide universe.

## 2. Crypto — free, but only 5.6 years

Tested: `2021-01-04` returns BTC/USD 1-minute bars; `2020-06-01` and `2018-06-01` return empty. So the crypto history is roughly **5.6 years**, not ten.

**Consequence for #653:** the crypto event study runs on about half the sample the equity study gets. Since #660 already showed the crypto leg is the more fragile one — 8x the costs, dependent on maker fills — the leg with the weaker evidence is also the leg with the thinner margin. Size the trial budget accordingly.

## 3. LSE — the gap, and it is the one that matters

[#659](https://github.com/dd-jp/samurai-trading-system/issues/659) established that the live equity universe is **GBP LSE-listed ETFs and ETCs**, because US stocks cost 0.30% round trip on Trading 212's FX fee and UK shares carry 0.5% stamp duty. So the tradeable instruments are exactly the ones with no free intraday history.

- **Alpaca: not available.** `VUSA,CSP1,SGLN` → `{"message":"invalid symbol: CSP1"}`. US venues only.
- **Yahoo / yfinance:** 1-minute data only for the **last 7 days**; any intraday interval only for the last 60. Not usable for an event study.
- **Twelve Data free tier:** 800 calls/day, 8/min, and 1-minute data only from **2020-02-10**; for LSE specifically the documented intraday range is "a few months to a year".
- **Paid:** EODHD, FirstRate Data, Kibot, LSEG. Not priced here.

**Ten years of LSE intraday is not obtainable at £0.**

### The HF Data Library trap

`hfdatalibrary.com` offers free 1-minute OHLCV for ~1,391 US stocks and ETFs from 2002, CC BY 4.0, with a REST API — superficially the best free option available. **Do not use it in preference to Alpaca.** Its data source changes at **March 2022**: pre-2022 is the full consolidated tape, post-2022 is **IEX only (~2–3% of volume)**.

A strategy backtested across that boundary sees a regime change in the *data*, not the market — volume-derived features break, and OHLC values shift because they are drawn from a different fraction of the tape. Alpaca's SIP feed is strictly better, is already provisioned, and has no such discontinuity.

## 4. Event calendars

**Dividends and corporate actions: free and working.** Tested:

```
GET /v1/corporate-actions?symbols=AAPL&types=cash_dividend&start=2020-01-01
-> {"ex_date":"2020-05-08","payable_date":"2020-05-14","record_date":"2020-05-11","rate":0.82, ...}
```

`ex_date` is a historical fact rather than a revised estimate, so this is point-in-time safe. Note that [#655](https://github.com/dd-jp/samurai-trading-system/issues/655) already **excluded dividends as a catalyst** — ex-dividend price movement is mechanical, and an event study will "find" it reliably while it remains untradeable. The endpoint is still useful for *excluding* ex-dividend days from other studies.

**Macro calendar (FOMC, CPI, NFP) and earnings dates: not researched.** This is an acknowledged gap in this document. It matters because #655's leading candidate — macro prints — is the one event family that moves equities *and* crypto, and therefore the only one that serves both legs of the daily-trade requirement. Point-in-time integrity is the concern: a calendar reconstructed from today leaks revisions.

## 5. The backtest harness cannot replay intraday

`REPLAY_TIMEFRAME = '1d'` is hard-coded in `server/tools/backtest/proxy-strategy.ts:53`. `free-stack-aggregates-client.ts:277` requests `'1Day'`, `replay-driver.ts:497` passes `'1d'`, and `stage2-historical-store.ts` persists a `timeframe` column that every current path writes as daily.

**Intraday replay is unbuilt.** Having ten years of minute bars available does not mean the harness can consume them. This is implementation work that must precede any intraday Stage 2 verdict, and it is not currently ticketed.

## 6. The finding that outranks the data question

**LSE trades 08:00–16:30 London. US cash markets trade 14:30–21:00 London. The overlap is two hours.**

A GBP LSE-listed S&P 500 tracker (VUSA, CSP1) therefore spends **6.5 of its 8.5 trading hours with its own underlying market closed**. During those hours its price is not discovered on the LSE at all — it is inferred from US index futures, and its spread widens accordingly.

Two consequences, both load-bearing:

1. **An event study on US-hours SPY minute bars does not transfer to London-hours VUSA minute bars.** They are different sessions with different price-discovery mechanisms. The plan of "study the US underlying, apply the levels to the LSE tracker" is only valid inside the 14:30–16:30 overlap.
2. **The equity leg's instrument choice needs revisiting.** Either trade only the two-hour overlap window — which conflicts with "at least one equity trade per day" only mildly, since one trade fits in two hours — or trade LSE instruments whose underlying *is* open during London hours (FTSE 100 trackers such as ISF, European index trackers, and physically-backed gold ETCs, which track a 24-hour spot market).

This belongs to [#635](https://github.com/dd-jp/samurai-trading-system/issues/635) (universe objective) and [#657](https://github.com/dd-jp/samurai-trading-system/issues/657) (cadence and session windows), and it should be resolved before #653's event study is designed — the study's session window is an input to it, not an output.

## Recommendations

1. **Run the event study on Alpaca's free SIP minute bars.** 10.6 years for equities, 5.6 for crypto, £0, already provisioned. This closes #656's primary question affirmatively.
2. **Do not treat US-underlying results as directly applicable to LSE trackers** outside the 14:30–16:30 overlap. Resolve the session-window question in #635/#657 first.
3. **Measure LSE ETF spreads live** rather than sourcing history. The cost model needs a current spread per instrument, not ten years of them, and Trading 212's demo API can supply quotes going forward. **SUPERSEDED on the T212 half by [`34-lse-mark-source-options.md`](34-lse-mark-source-options.md) §4** (2026-08-19): the T212 API exposes **no quote endpoint at all**, its one price field (`Position.currentPrice`) exists only for instruments already held and carries no timestamp, and its API Terms 7.1(b) say *"You will not receive real-time information on Market Data"* — so it cannot supply quotes, going forward or otherwise. The rest of this recommendation (measure live, not from history) stands. The existing calibration (`archive/2026-08-05-cost-model-calibration.md`, 36,617 Alpaca quotes) covers instruments that are no longer tradeable.
4. **Ticket the intraday replay work** on the backtest harness — it is a prerequisite for any intraday Stage 2 verdict and does not exist today.
5. **Close the macro-calendar gap** before #655 is grilled, since macro prints are its leading candidate.
