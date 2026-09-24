# Committed market data for the momentum backtest

Committed under doc 70 ruling (k) (David, 2026-09-23): bars live in the repo so every verdict replays from the same bytes. The repo is private. `.gitignore`'s research cache exclusion (`docs/research/data/`) is unrelated to this directory.

## `alpaca/` — US daily bars

- Source: Alpaca Market Data `GET /v2/stocks/bars`, `timeframe=1Day`, `feed=sip`, pulled twice per symbol — `adjustment=all` for OHLCV and `adjustment=raw` for the `raw_close` column (whole-share sizing needs the price actually quoted that day).
- Window: 2016-01-04 to 2026-09-23 (`manifest.json` carries `start`, `end`, `fetched_at`, per-symbol first/last date and bar count, and the `missing` list).
- Universe: every ticker that was an S&P 500 member on or after 2016-01-04 per `sp500-constituents.csv` (745 names) plus `SPY` as the trading-calendar reference. 746/746 symbols returned bars; `missing` is empty. Tickers with a dot (`BRK.B`) are requested as written and then dot-stripped.
- Columns: `date,open,high,low,close,volume,raw_close`, prices to four decimals.
- Puller: `server/tools/backtest/momentum/pull-alpaca-bars.ts` (needs `ALPACA_API_KEY`/`ALPACA_API_SECRET` via `--env-file`).

## `alpaca-spreads.csv` — measured US half spreads

- Source: Alpaca `GET /v2/stocks/{symbol}/quotes`, `feed=sip`, first quote at or after 15:59:00 ET on each of the last ten sessions in the SPY calendar, for the current S&P 500 members.
- Columns: `symbol,sessions,median_half_spread_bps`. Names without a measurement (delisted, or no quote in the window) take the cross-sectional median at run time.
- Tool: `server/tools/backtest/momentum/measure-alpaca-spread.ts`.

## `sp500-constituents.csv` — point-in-time S&P 500 membership

- Source: [`fja05680/sp500`](https://github.com/fja05680/sp500), file `S&P 500 Historical Components & Changes (Updated).csv`, fetched 2026-09-23. Licence: **MIT**, Copyright (c) 2019-2020 Farrell J. Aultman. The full file (2,721 rows, 1996-01-02 to 2026-08-18) has sha256 `36326709d46d6cd25834de5df457b16f5f96fad3a06b9beac28f7b88aa0b0d54`; the committed copy keeps only the rows from 2016-01-04 onward (489 rows), format `date,tickers` unchanged.
- Membership on a decision date is the last row on or before it.

## `fx/gbpusd-boe-xudluss.csv` — USD per GBP

- Source: Bank of England IADB series `XUDLUSS` (spot, US dollars into sterling), daily from 2015-12-01 to 2026-09-22, fetched 2026-09-23 via `https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes&Datefrom=01/Dec/2015&Dateto=now&SeriesCodes=XUDLUSS&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`. Open Government Licence v3.0.
- Use: doc 70 ruling (j) — each calendar year converts at the last published rate on or before 1 January, so FX never enters the loss budget.

## `saxo/` — LSE daily bars (not yet present)

Ruling (a): the LSE lines need the Saxo sibling-Uic route first, EODHD one month as fallback. When bars land, put one `<TIDM>.csv` per line here with the header `date,open,high,low,close,volume` (or the seven-column Alpaca layout) and a `manifest.json` of the form

```json
{ "calendar_reference": "<TIDM of the reference line>", "symbols": { "<TIDM>": { "half_spread_bps": <measured> } } }
```

then run `npx tsx server/tools/backtest/momentum/run.ts --venue lse`.
