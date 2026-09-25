# Committed market data for the momentum backtest

Committed under doc 70 ruling (k) (David, 2026-09-23): bars live in the repo so every verdict replays from the same bytes. The repo is private. `.gitignore` still excludes the research bar cache `docs/research/data/` <!-- cite-exempt: untracked — scratch cache, gitignored -->; that exclusion is unrelated to this directory.

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

- Source: Bank of England IADB series `XUDLUSS` (spot, US dollars into sterling), daily from 2010-01-04 to 2026-09-24, fetched 2026-09-25 via `https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/2010&Dateto=now&SeriesCodes=XUDLUSS&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N` (the endpoint redirects; fetch with `curl -L`). Open Government Licence v3.0. The 2026-09-23 pull from 2015-12-01 is a strict subset of this file.
- Use: doc 70 ruling (j) — each calendar year converts at the last published rate on or before 1 January, so FX never enters the loss budget. The sibling splice (`saxo-aux/`) converts each USD bar at the same-day fix or the last fix on or before it.

## `saxo/` — LSE daily bars

- Source: Saxo OpenAPI live gateway `GET /chart/v3/charts`, `Horizon=1440`, `Count=1200`, paged back with `Mode=UpTo&Time=<earliest>` until a short page; `ChartInfo.DelayedByMinutes` 15. Pulled 2026-09-25 with a read-only token.
- Prices in **GBP**: GBX-quoted lines are scaled by 0.01 once at ingest, checked against each instrument's `PriceToContractFactor` (0.01 GBX, 1 GBP); GBP-quoted lines (VMID, IGLT, INXG, SLXX, VUTY) are stored as quoted. Columns `date,open,high,low,close,volume,raw_close` with `raw_close` equal to `close` (no adjustment is applied — Saxo's closes are price-only, see `manifest.json` `checks.distribution_adjustment`: the ISF/CUKX ratio drifts −3.77%/yr, which is the dividend yield).
- Lines: 22 of the 24 in doc 70 §2.2. `manifest.json` carries `calendar_reference` (ISF), `window_start` (the latest first bar among included lines, 2016-06-21, binding line IITU), per-line `first`/`last`/`bars`/`density`/`half_spread_bps`/`is_complex`, and `excluded` for IHCU and CMFP, whose sibling splice failed the pre-declared 1 bp/day tolerance (doc 70 §10.3).
- Puller: `server/tools/backtest/momentum/pull-saxo-bars.ts` (`--token-file` points at the live token store, `--spreads`/`--fx` default to the files here). Lines are declared in `server/tools/backtest/momentum/lse-lines.ts`.

## `saxo-aux/` — series the run does not read

- `IHCU.csv`, `CMFP.csv`: the short GBX lines (2021-10-21 and 2019-02-20), GBP, same layout as `saxo/`.
- `IUHC.csv`, `COMF.csv`: their USD LSE siblings (same fund, Uics 4925944 and 46434), **in USD, unconverted**.
- `IHCU-spliced.csv`, `CMFP-spliced.csv`: the splice candidates — sibling bars before the GBX line's first bar converted at the BoE XUDLUSS fix, then the GBX line. Kept for the overlap statistics in `saxo/manifest.json` and for a re-run if David accepts the >1 bp/day overlap.
- `CUKX.csv`: ISF's accumulating class, pulled only for the distribution-adjustment check.

## `saxo-spreads.csv` — measured LSE half spreads

- Source: Saxo `GET /trade/v1/infoprices/list`, `FieldGroups=Quote` (15-minute delayed), one burst of 5 reads spaced 2 s at a single time point, 2026-09-25T11:14:26Z, market open.
- Columns: `symbol,uic,samples,p25_half_spread_bps,median_half_spread_bps,measured_at`. The run uses `p25`. One time point carries the doc 44 §5 noise caveat (a single snapshot of the universe median swings 1.68× across time points with no time-of-day content); it was measured once and not re-measured.
- Tool: `server/tools/backtest/momentum/measure-saxo-spread.ts`.
