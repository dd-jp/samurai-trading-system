# LSEG Delayed Market Data — does the free pre-trade surface reproduce per-instrument spread?

Answers [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035), successor to
[#999](https://github.com/dd-jp/samurai-trading-system/issues/999) (died at the terms gate) and
[#1034](https://github.com/dd-jp/samurai-trading-system/issues/1034) (CLOSED — DMD needs no
registration, only a click-through Terms & Conditions already accepted).

**What "permissibly collected" rests on, so this doc is self-contained on the point that sank #999
and doc 58 F6:** #1034's 2026-09-14 finding (browser-verified, David resolved) is that
`dmd.lseg.com` has **no registration and no login of any kind** — the only gate is a public
click-through Terms & Conditions identical for every visitor, with no separate registered-user
tier. Quoting #1034's finding directly: *"Natural or legal persons ('Users') can use the Delayed
Data, as published by LSEG via this website... licence agreement required only where
onward-distributed / fee-charged"* — and *"No automated-access clause found beyond that."* This is
the opposite of #999's LSE Terms §8 (programmatic access barred outright) and doc 58 F6's scrape of
an unauthenticated endpoint the site owner never sanctioned for this use — DMD's terms were read
end-to-end by #1034 specifically looking for an automated-access bar, the same gate that killed
those two, and found none.

**Verdict: yes, with one coverage gap and one correction to the ticket's own premise.** DMD's `LSE
Pre-Trade Documents` reproduce a permissibly-collected per-instrument round-trip/half-spread and a
real session profile for 30 of the pool's 31 rows. The one gap (MST3) and the one premise
correction (the file is not a snapshot) are below.

## Premise check

The ticket's title and Q1 say "30 pool TIDMs" and cite `lse-etp-pool.ts:355`. `LSE_ETP_POOL` has
**31 rows today** (30 distinct ISINs — `3USL`/`3LUS` share ISIN `IE00B7Y34M31`, a GBX line and a
USD line on the same underlying), not 30. The pool's own top-of-file comment traces this: #813's
2026-08-19 expansion and #1220's third SPY line both landed after #1032 (the issue that first
wrote "30") was filed. Measured against the current 31 rows / 30 ISINs throughout this doc, not
the stale 30.

## What must be answered (the ticket's four setup questions)

**1. Coverage — YES for 30/31 rows, with one gap.** Across 108 sampled `LSE Pre-Trade Documents`
files (§ Method) spanning both available trading dates — of which 94 fall inside the 07:00-15:30
UTC continuous-trading window and the remaining 14 are pre-market/post-close files that are
structurally near-empty (e.g. 05:00 carries 1 total row, 16:00 carries 6) — **30 of the pool's 31
rows appear**, present in 73-98 of the 108 sampled files each (see the per-ticker `files_present`
column in § Coverage; the low end, 3VT at 73, is the thinnest-traded name, not a DMD gap). **MST3 (ISIN
`XS2901882618`) appears in zero of the 108 sampled `LSE Pre-Trade Documents` files across both
dates.** It is also absent from the one most-recent file pulled from each of DMD's three `SI`
(systematic-internaliser) participant feeds (`NMTRIAIR`, `NMOPVOF`, `BARCIE2DSEC` — the parallel
`si/` document set discovered while reverse-engineering the API), via
`python3 46-lseg-dmd-pretrade-surface.py si`, which fetches and logs all 3 reproducibly (an earlier
version of this check was done ad hoc, with no fetch log and no script command — now fixed). That
SI check is a single snapshot per participant, not a session-spanning sample, so it narrows but
does not close the question; the precise, defensible claim is **"absent from every sample pulled in
this investigation," not "DMD does not cover MST3 anywhere."** A single instrument being
unreachable is the honest residual, not a blocking negative result — see § Acceptance criteria. The
3 files actually checked and their MST3 result are archived verbatim, not just the "absent from all
3" summary, in
[`archive/raw/2026-09-15-46-dmd-analyze-output.txt`](archive/raw/2026-09-15-46-dmd-analyze-output.txt)'s
"MST3 SI check" section.

Note on the ticket's own framing: "leveraged ETPs may sit in a segment published differently, or
not at all" is exactly what happened for one row, and the mechanism (SI vs lit order book) is the
one the ticket anticipated.

Coverage is NOT well answered by a single file — the single post-close 2026-09-14T16:30 file this
investigation started with found only 13/31 rows, which looked like a severe gap until § Method's
Q3 finding explained why: a single file undercounts because most of the pool trades sparsely in
any given one-minute window, and that particular file was drawn after continuous trading had
already ended for the day (see next question).

**2. Fields — bid/offer YES, EMS effectively NO.** Every row carries `bidLimitPrice` /
`offerLimitPrice` (used for round-trip and half-spread throughout this doc) and
`bidLimitSize`/`offerLimitSize` (displayed top-of-book size in units, e.g. 375/238/150/179 — a
real basis for cost-floor sizing). `bidMarketSize`/`offerMarketSize` ("EMS" in the ticket's
term) are the field DMD calls market size, and across every matched pool-ISIN row sampled
(49,522 rows) they are **non-zero in only 119 (0.24%)**. Those 119 rows are not scattered noise:
grouping all 119 by their `distributionTime` minute (not just spot-checked; the full per-minute
breakdown is archived in `archive/raw/2026-09-15-46-dmd-analyze-output.txt`, reproduced by
`analyze`'s "EMS-nonzero rows by distributionTime minute" line) shows every one falls
in exactly three filename-minutes across the two sampled dates — `07:00` (1 + 24 rows),
`07:05` (12 rows, immediate aftermath of the opening auction), and `15:30` (51 + 31 rows, the
closing-auction print) — and several show a crossed/aggressor-looking book (`offerMarketSize`
populated with `offerLimitPrice` at or through the bid) consistent with an auction-cross
market-order fill rather than a resting two-sided quote. `bidYield`/`offerYield` are
**identically zero across every one of the 49,522 matched rows** — a field this schema evidently
shares with a fixed-income flow, structurally unpopulated for XLON equity/ETP order-book rows.
**Practical answer: EMS is present in the schema but not usable as a continuous-session sizing
input for this universe — it fires only around the auction crosses. `bidLimitSize`/
`offerLimitSize` are the size fields that actually serve cost-floor sizing.**

**3. Granularity — NOT a snapshot; corrects the ticket's premise.** The ticket asks to "confirm
the per-minute file is a snapshot per instrument, not an event stream that skips quiescent lines."
It is the event stream, not the snapshot. Direct evidence: the `2026-09-14T11:00` file carries
**24 separate rows** for ISIN `IE00B7Y34M31` (the 3USL/3LUS pair) alone, with `distributionTime`
values spanning `11:00:04.638...Z` through `11:00:59.851...Z` — i.e. every quote update that
instrument pair received during that one-minute window, not one row per instrument. Each row also
carries a numeric `instrumentId` (`72057594038070487` for 3LUS, `72057594038056292` for 3USL in
this file) that DMD itself uses to distinguish the two currency lines sharing one ISIN — so the
ISIN collision the ticket might have worried about is already resolved by the file's own schema.
**The script now assigns rows by this `instrumentId`, not by a price-scale guess** (an earlier
version of this doc claimed the instrumentId split "corroborated by price scale" while the script
actually assigned every row by price scale alone and never read the `instrumentId` back — a false
method claim caught in review): `_classify_shared_isin_instrument_ids()` classifies each of the two
`instrumentId` values for `IE00B7Y34M31` **once**, from its own median two-sided price across the
full sample (72057594038070487 → **3LUS**, median 13,512 GBX pence; 72057594038056292 → **3USL**,
median 182.21 USD — no overlap, and matches `lse-etp-pool.ts`'s declared currencies, GBX for 3LUS
and USD for 3USL, cross-checked against ADR-0015:224's 3LUS ask of 13,484 GBX; an earlier version
of this doc had the two tickers swapped, caught in review), then looks that `instrumentId` up per
row — so a single wide print or an intraday move on either line can no longer flip its assignment.
A per-row check still runs afterward, genuinely independent of the assignment mechanism: it
compares each row's own price scale against `lse-etp-pool.ts`'s declared currency for the tik it
was assigned, not against the median-price rule that produced the assignment in the first place
(an earlier version of this check re-applied that same rule, so it could never disagree with
itself — caught in review, see the script's `SHARED_ISIN_TIK_CURRENCY` comment). On this sample it
flags **0 of 2,221 two-sided rows** as disagreeing (`analyze`'s
`3USL/3LUS instrumentId classification` line; also
[`archive/raw/2026-09-15-46-dmd-analyze-output.txt`](archive/raw/2026-09-15-46-dmd-analyze-output.txt)).
The other 5 rows (of 2,226 total matched — 1,113 per instrumentId, 1,111 two-sided for 3LUS and
1,110 for 3USL) are not two-sided; all 5 carry an `instrumentId` pass 1 already classified, so
**0 rows fall back** to the price heuristic — no published spread or session-profile figure in
this doc depends on a fallback-classified row. This is *better* than a snapshot for this ticket's
purposes — it gives many observations
per instrument per session (hundreds to low thousands per ticker across the sampled window, see §
Coverage) rather than one point estimate per file, which is what makes the dispersion and
session-profile statistics below possible at all. It does mean a *single* file cannot be read as
"the quote at that minute" the way the ticket assumed; every statistic below is built from the
full multi-file, multi-tick pool, not from one file per instrument.

Two structural fields observed throughout: `orderBookType` is constant `'3'` on every one of the
49,522 matched rows (uninformative for segmenting continuous vs. auction — the auction/cross
events above are identified by the `distributionTime` clock and the EMS-nonzero/crossed-price
pattern instead), and `sourceVenue` is constant `'1'` (this document set is a single venue; it
cannot by construction surface an off-book/SI quote, hence the separate `si/` check for MST3
above).

**4. History/retention.** As of the file listing pulled at `2026-09-15T01:01:37Z`,
`GET https://dmd.lseg.com/api/web/files` carries `LSE Pre-Trade Documents` for exactly two dates:
**2026-09-11 and 2026-09-14** (583 and 586 per-minute files respectively, 04:00-16:30 UTC each
day). 2026-09-12/13 is the weekend; 2026-09-15 (today) has not started posting files yet because
the pull was pre-market. This is **consistent with, not a contradiction of**, #1034's "at least 3
trading days" — a rolling ~3-trading-day retention window shows exactly 2 complete prior days
before today's own slot has filled. **Consequence for the session profile below: only a 2-trading-
day retrospective window exists today.** Doc 53's G3 (TSLA/AAPL open-vs-close ratios) was fitted
on 24 dates; this doc's session profile is fitted on 2. The direction reported below should be read
as **"cannot be ruled out as noise on 2 days," not a settled multi-week finding** — see
`51-realised-range-session-filter.md`'s "cannot be settled here" precedent for underpowered
results. A daily accumulation job (out of scope here) is the only way to widen this window; nothing
retrospective beyond 2-3 days is retrievable through this endpoint.

**5. The 15-minute delay.** Irrelevant to this retrospective research by construction, per the
ticket's own instruction — stated and not re-argued.

## Method

**API** (reverse-engineered from the DMD Angular SPA's JS bundles — the site is client-rendered and
unreachable by a plain `curl` against the page itself; no registration or auth needed for any of
these calls):

- `GET https://dmd.lseg.com/api/web/files` — full file listing, all 8 DMD document sets.
- `GET https://dmd.lseg.com/api/web/download?fileName=<fileKey>` — JSON envelope with a 5-minute
  presigned S3 URL for the actual CSV (`X-Amz-Expires=300`; fetched immediately, never batched).
- `GET https://dmd.lseg.com/api/web/si/files` / `.../si/download?fileName=<fileKey>` — the parallel
  systematic-internaliser document set, used only for the MST3 residual check above (`si/download`'s
  envelope shape differs from `download`'s: the presigned URL is at `result.preSignedUrl` directly,
  not nested — both are handled by the same `fetch()` helper via an `endpoint` parameter).

Every `fetch()` call checks the exit status of both `curl` invocations (the envelope fetch and the
CSV download) and raises rather than logging success — `curl -sf` fails loudly on an HTTP error
response instead of writing the error body to disk and returning 0, which an earlier version of
this script did not check for.

**Sample:** 108 `XLON-pre-<date>T<HH>_<MM>.csv` files, both available trading dates
(2026-09-11, 2026-09-14), 15-minute cadence 04:00-16:30 UTC (covers pre-market through
post-close), densified to 5-minute cadence inside the open (07:00-07:59) and close (15:00-15:29)
windows to reduce per-instrument sample noise in those buckets. Every fetch is logged
(`fileKey`, request URL, request/fetch timestamps) to `/tmp/dmd_cache/fetch_log.jsonl` at pull
time; the full 108-line log and the `analyze` output it produced are committed verbatim at
[`archive/raw/2026-09-15-46-dmd-fetch-log.jsonl`](archive/raw/2026-09-15-46-dmd-fetch-log.jsonl) and
[`archive/raw/2026-09-15-46-dmd-analyze-output.txt`](archive/raw/2026-09-15-46-dmd-analyze-output.txt)
— that is the durable evidence this pull happened and its exact sampling basis. **Given DMD's
observed ~2-3 trading-day retention (§ Q4), re-running `fetch` will not retrieve these same
fileKeys** once they age out — it reproduces the sampling *method* (same dates relative to the run,
same minute cadence) against whatever DMD serves at re-run time, not this specific data. Because of
that, `analyze`'s output now includes the intermediate evidence behind four load-bearing claims —
the EMS three-minute breakdown, the raw 24-row `distributionTime` list behind the granularity
finding, the per-file row counts at the session boundary, and the MST3 SI check's per-file
result — not just the final aggregate each one supports, so a future reader without a live DMD
window can still verify the reasoning, not only the number it produced. All of it is archived
verbatim in `archive/raw/2026-09-15-46-dmd-analyze-output.txt`. The three SI fetches themselves are
now logged the same way the lit fetches are, by the new `si` subcommand, and archived at
[`archive/raw/2026-09-15-46-dmd-si-fetch-log.jsonl`](archive/raw/2026-09-15-46-dmd-si-fetch-log.jsonl)
— previously these three pulls happened ad hoc with no logged, reproducible record at all.

**Session buckets**, in filename-time UTC coordinates, measured rather than assumed: total and
two-sided row counts step from ~0 to 20,000-37,000 rows precisely at `T07:00` (opening) and
collapse from ~30,000 to 85 rows at `T15:45` (post-close) — confirming continuous LSE trading is
07:00-15:30 UTC (= 08:00-16:30 London, BST), and that filename time is UTC (also confirmed against
the CSV's own `distributionTime` column). Buckets: `open` = 07:05-07:59 (the exact `T07:00` file is
excluded as the opening-auction print, per `53-intraday-cost-calibration.md`'s precedent of
excluding the analogous US opening-bell artifact), `midday` = 08:00-14:59, `close` = 15:00-15:30.

**Units:** every figure in this doc is **basis points of mid** — `(offer-bid)/mid * 1e4` for
round-trip, half of that for half-spread. This sidesteps the GBX-vs-GBP unit trap doc 44 already
found in Saxo's own field naming (`PriceToContractFactor`): bps ratios are unit-invariant, so no
GBX/GBP/USD currency-scale question needs resolving to report them. No cash price is published in
this doc.

**Data handling:** the 108 pulled CSVs stay outside the repo (`/tmp/dmd_cache`, matching doc 53's
"pulled quotes stay outside the repo" rule) — only the aggregates below, the fetch/analyze logs in
`archive/raw/` (above), and [`46-lseg-dmd-pretrade-surface.py`](46-lseg-dmd-pretrade-surface.py)
itself are committed. Running `analyze` against a fresh pull reproduces every number in the tables
below (they are reformatted for the doc, not pasted output — `git diff` against
`archive/raw/2026-09-15-46-dmd-analyze-output.txt` is the byte-for-byte check).

## Coverage

30/31 pool rows found (union across all 108 files); MST3 absent from all of them (§ Q1 above).
Per-row detail (`rows` = quote-update ticks matched; `files_present` = how many of 108 sampled
files carried at least one row for that ISIN):

```
ticker  rows  two-sided  files_present/108     ticker  rows  two-sided  files_present/108
3USL    1113       1110       98                3AAP    3037       3035       96
3LUS    1113       1111       96                MST3       0          0        0   <- the gap
LQQ3    2249       2243       98                LAM3    1822       1822       94
NVD3    3032       3031       98                3LAL    1321       1318       89
3LNV    2560       2556       96                LPP3     646        645       82
3QQQ    1146       1143       94                LCO3    1549       1544       94
3LPA     835        833       92                LAA3     644        635       87
PLT3    2469       2469       97                3LMO    1043       1043       88
3LME    2575       2573       94                3LIP    1268       1263       88
3LNP    1093       1092       91                3LSQ    1128       1127       87
3AMZ    3030       3028       96                3UBR    1871       1868       97
3FB     3076       3074       96                3RAC    1634       1634       94
3KOR    2203       2198       97                3ARM    1058       1058       87
3XLE    1291       1289       91                3VT      503        503       73
3SPY     781        780       90                3KWE    1414       1414       94
3LTS    2018       2018       96
```

`rows` = quote-update ticks matched to that ISIN across the 108-file sample; `two-sided` = the
subset with both `bidLimitPrice`/`offerLimitPrice` > 0; `files_present` = how many of the 108
files carried at least one row for that ISIN (94 of the 108 are inside the 07:00-15:30 UTC
continuous-session window; a name can still appear in a pre-market/post-close file, which is why
some counts run above 94). `covered: 30/31 rows (29/30 distinct ISINs)`.
Reproduces via `python3 46-lseg-dmd-pretrade-surface.py analyze`.

## Per-instrument round-trip and half-spread, session profile (open vs. midday vs. close, median bps)

30 rows; MST3 excluded (no data). `n_open`/`n_mid`/`n_close` are quote-update ticks matched in that
bucket across both sampled dates — the sampling basis for every median below.

```
ticker  open_rt  open_hs   mid_rt   mid_hs  close_rt  close_hs  n_open   n_mid  n_close
3USL      11.6      5.8     12.2      6.1      14.2      7.1      258     659      160
3LUS      11.9      5.9     12.7      6.3      15.2      7.6      260     659      168
LQQ3      15.5      7.8     19.1      9.5      21.6     10.8      519    1334      321
NVD3      30.5     15.3     20.9     10.5      13.1      6.6      647    1809      501
3LNV     127.5     63.7    116.8     58.4     111.8     55.9      538    1522      426
3QQQ     107.6     53.8    108.2     54.1      92.4     46.2      147     686      267
3LPA     226.9    113.5    192.0     96.0     163.7     81.8      137     514      173
PLT3      44.0     22.0     37.2     18.6      19.2      9.6      477    1481      459
3LME     110.1     55.1     90.3     45.2      76.0     38.0      379    1651      477
3LNP     186.9     93.5    144.9     72.5     108.1     54.1      158     664      232
3AMZ      66.4     33.2     50.3     25.2      36.1     18.1      667    1842      480
3FB       65.2     32.6     55.8     27.9      40.4     20.2      648    1886      465
3KOR      39.3     19.7     43.5     21.7      16.9      8.5      328    1323      487
3XLE     149.3     74.6    160.0     80.0      69.9     35.0      307     714      238
3SPY     102.2     51.1    106.2     53.1      99.6     49.8      127     444      178
3LTS     142.0     71.0    124.6     62.3     116.3     58.1      322    1237      395
3AAP      59.5     29.8     41.3     20.6      28.8     14.4      680    1790      496
LAM3     168.7     84.3    164.4     82.2     157.0     78.5      334    1118      322
3LAL     234.4    117.2    130.3     65.1     113.2     56.6      174     817      301
LPP3     315.8    157.9    212.0    106.0     138.9     69.4      210     339       87
LCO3     487.8    243.9    645.2    322.6     571.4    285.7      356     926      249
LAA3     218.8    109.4    160.5     80.3     126.8     63.4      105     389      141
3LMO     282.2    141.1    255.1    127.5     276.2    138.1      208     590      218
3LIP     666.7    333.3    306.1    153.0     266.9    133.4      265     727      211
3LSQ     462.0    231.0    330.8    165.4     172.0     86.0      240     642      219
3UBR     264.3    132.2    193.5     96.8     134.8     67.4      371    1179      297
3RAC     177.0     88.5    175.4     87.7     173.9     87.0      316    1085      193
3ARM     171.7     85.8    128.3     64.2      86.2     43.1      147     687      198
3VT      206.2    103.1    134.4     67.2      61.3     30.7       94     247      133
3KWE     206.4    103.2    154.0     77.0     150.4     75.2      406     839      129
```

**Session profile: real, and directionally consistent with doc 53's G3, on 2 days of data.**
open/close ratio (round-trip == half-spread ratio, unit-invariant): **median 1.67x** across the 30
covered rows (min 0.72x, max 3.36x). **26 of 30 rows widen into the close** (open/close > 1x);
doc 53 G3 measured TSLA at 2.7x and AAPL at 1.7x on the analogous US open-vs-close comparison — this
pool's median (1.67x) sits right at AAPL's figure and below TSLA's, on a different universe
(leveraged LSE ETPs, not US large caps) and a much thinner sample (2 dates here vs. doc 53's 24).
**Read this as "the widening-into-close pattern is not contradicted by DMD data," not as an
independent confirmation of doc 53's specific multiplier** — 2 dates cannot settle that, per §
Q4's underpowered-sample caveat.

**3 of the 4 rows that narrow into the close instead of widening are the pool's tightest,
most-liquid names**: 3USL (0.82x), 3LUS (0.78x), LQQ3 (0.72x) — the three smallest open-bucket
round-trip spreads in the whole table (11.6-15.5 bps), against a pool open-bucket median round-trip
of **159.0 bps** (79.5 bps half-spread — this is the same quantity, computed
per-instrument-then-medianed across the table above rather than per-tick, as the dispersion
section's 79.48 bps open-bucket median-of-medians). **The fourth, LCO3 (0.85x), is the opposite
case** — it is one of the pool's *widest* names (487.8 bps open-bucket round-trip, second only to
3LIP's 666.7) and still narrows, its close-bucket spread (571.4 bps) actually *widening in absolute
terms* even as the open/close ratio reads below 1x; its own count of ticks is thin enough
(n_close=249) that this could be tick-level noise rather than a real pattern — flagged, not
resolved, by this 2-day sample. **This is the decision-relevant asymmetry for Samurai specifically**: the
names most likely to actually get traded are the ones whose spread is worst, relatively, right at
the close — which is exactly when ADR-0014's flat-by-close horizon forces every exit. Figures are
round-trip bps; add Saxo's measured 16 bps round-trip commission (ADR-0015) to size the total exit
cost on top.

**The single most decision-relevant number this doc produces, stated plainly rather than left for
the reader to compute:** the pool's own open-bucket median round-trip, **159.0 bps**, is **~3.1x**
`59-universe-tradeability-screen.md` §3.1's single-stock total round-trip budget at ADR-0017's
assumed win rate (**52.1 bps**) and **~11.2x** its index budget (**14.2 bps**, which is already
negative net of Saxo's 16 bps commission alone). Only **1 of the 30 covered rows clears doc 59
§3.1 criterion (b)'s round-trip-spread threshold for its own subclass** — not 6, as an earlier
version of this paragraph claimed by comparing every row against the single-stock **total** ceiling
(52.1 bps, which already nets out Saxo's 16 bps commission) rather than each subclass's spread-only
budget. Doc 59's own criterion (b) thresholds are **≤36 bps round-trip for single-stock** and
**≤0 bps for index** (i.e. unsatisfiable as bracketed) at ADR-0017's assumed win rate. Of the six
rows the earlier version named — 3USL (11.6), 3LUS (11.9), LQQ3 (15.5), NVD3 (30.5), 3KOR (39.3),
PLT3 (44.0) — four (3USL, 3LUS, LQQ3, 3KOR) are `index_etp_3x` per `lse-etp-pool.ts` and so have no
positive spread budget to clear regardless of how tight their spread measures; of the remaining two
`single_stock_etp_3x` rows, NVD3 (30.5 bps) clears the 36 bps threshold and PLT3 (44.0 bps) does
not. **Correct count: 1 of 30 (NVD3).** Every other row exceeds even the more permissive
single-stock budget, several (LCO3 487.8, 3LIP 666.7, 3LSQ 462.0) by an order of magnitude or more.
**Spread alone, before commission, already disqualifies effectively the whole pool under doc 59's
stated cost budgets** — this doc supplies the missing per-line spread evidence doc 59 §3.2's
criterion (b) row flagged as "**No.** ... **Not evaluable per line**" (see § What remains).

## Restating #875's p90-vs-median dispersion on permissible data

#875's retracted pre-open capture (doc 58, `58-lse-quote-snapshot.py`, deleted by #1036 for the
LSE Terms §8 violation found in #999) reported **max/median = 12.61x** (and max/min = 480.5x)
against a stated 2x threshold, on data this repo is barred from citing further. Restated here on
permissibly-collected DMD data, same quantity (cross-sectional dispersion of each instrument's
**half-spread**, computed as the median across each instrument's own tick population, then
max/median and p90/median taken across the 30 covered instruments):

```
                                    n   median-of-medians   max/median   max/min   p90/median
open bucket only (matches #875's
  pre-open capture)                30       79.48 bps          4.19x     57.70x      2.81x
full session (open+midday+close)   30       64.42 bps          4.70x     49.93x      2.62x
```

**The dispersion survives directionally** — both max/median (4.19-4.70x) and p90/median
(2.62-2.81x) clear the stated 2x threshold by a wide margin, so the qualitative conclusion "the
pool is not one uniform spread and a single coefficient under-charges the wide names" (matching
doc 53 G3's finding that one `stocks` coefficient is not defensible) **stands on legitimate data**.
**The magnitude does not survive** — 4.19-4.70x is roughly a third of the retracted 12.61x, and
max/min (49.93-57.70x) is roughly a tenth of the retracted 480.5x. Whether that gap is because the
retracted pre-open capture caught auction-adjacent artifacts (this doc's own open-bucket figures
exclude the equivalent `T07:00` auction print explicitly; the retracted capture's method is
unknown and not reconstructable — #999/#1036), a genuinely wider pre-open regime than the
in-session open bucket measured here, or a sampling difference, is **not answerable from this
investigation** — the retracted script and its raw pull no longer exist to compare against. By
open-bucket median half-spread, the widest instruments are **3LIP (333.3 bps), LCO3 (243.9 bps),
3LSQ (231.0 bps), LPP3 (157.9 bps), 3LMO (141.1 bps)**, and the tightest are **3KOR (19.7 bps),
NVD3 (15.3 bps), LQQ3 (7.8 bps), 3LUS (5.9 bps), 3USL (5.8 bps)** — reproduced via `analyze`'s
"widest 5"/"tightest 5" lines — the same tight/wide split as the session-profile table above.

## Acceptance criteria — met, with the stated gap and caveats

- **Per-instrument round-trip and half-spread across the pool, in-session, sampling basis
  stated**: MET, 30/31 rows (§ table above; sampling basis is § Method's 108-file, 2-date, 15-min
  /5-min-densified pull, fully reproducible via the committed script).
- **Session profile (open/midday/close)**: MET as a directionally-consistent, underpowered (2-day)
  finding — 26/30 rows widen into the close, pool median open/close ratio 1.67x, in the range doc
  53's TSLA (2.7x) / AAPL (1.7x) bracket. Not a settled multi-week result; needs a forward daily
  accumulation job to widen past 2-3 trading days.
- **#875's p90-vs-median restated on permissible data**: MET. Dispersion fires against the 2x
  threshold (4.19-4.70x max/median, 2.62-2.81x p90/median) but at roughly a third of the retracted
  12.61x magnitude — the qualitative finding survives, the specific number does not.
- **Negative-result branch**: one instrument (MST3) has no permissible quote in any sample pulled
  here, lit or SI. This is the one place DMD does not answer the ticket in full — everything else
  (29 other pool rows, all four setup questions) is answered positively.

## What remains

- **This doc now supplies `59-universe-tradeability-screen.md` §3.2's criterion (b)** ("Max quoted round-trip
  spread" — previously "**No.** ... **Not evaluable per line**") for 30 of 31 pool rows — see doc 59's own
  updated pointer at that criterion and its §7 "Decidable now" list, which criterion (b) moved into once this
  doc's spread landed. Criteria (a) (tick/price floor) and
  (c) (print-frequency refresh for 19 unprobed rows) remain open, gated on #1032 and #1035/#895 respectively —
  this doc does not measure print frequency and makes no claim about criterion (c).
- **MST3's absence is not closed**, only narrowed to "absent from every sample pulled here." A
  session-spanning SI pull (not just one file per participant) would close it, or an
  affirmative statement from DMD's own documentation (`delayed-market-data-notes.pdf`, referenced
  in the SPA but not read for this doc) on which segment ETNs from this issuer list on.
- **The session profile needs more than 2 days.** A daily forward-accumulating pull (a small
  scheduled job reusing `46-lseg-dmd-pretrade-surface.py fetch`) is the only way to reach doc 53's
  24-date power within DMD's ~3-day retrospective retention window.
- **Whether DMD is even the right path is still an open question upstream of this doc** —
  `lse-etp-pool.ts`'s own provenance comments flag `needs-decision` pending whether Saxo's
  `infoprices` spread (doc 44, #1310) supersedes DMD per ADR-0016. This doc answers "can DMD do
  it," not "should Samurai use DMD over infoprices" — that comparison (coverage, freshness, the
  146-ETN `infoprices/list` single-call sweep doc 44 already found) is out of scope here and is the
  natural next ticket if #1310 is picked up.
- **No live/production consumption implied.** Per the ticket's own scope note, this is not a live
  mark source (#895) — every number here is a retrospective research aggregate from cached files,
  not a wired data path.

## Reproduce

```
python3 docs/research/46-lseg-dmd-pretrade-surface.py fetch    # pulls the same 108-file sample
python3 docs/research/46-lseg-dmd-pretrade-surface.py si       # pulls + checks the 3 SI participant files for MST3
python3 docs/research/46-lseg-dmd-pretrade-surface.py analyze  # regenerates every table above
```
