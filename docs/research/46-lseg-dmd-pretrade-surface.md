# LSEG Delayed Market Data — does the free pre-trade surface reproduce per-instrument spread?

Answers [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035), successor to
[#999](https://github.com/dd-jp/samurai-trading-system/issues/999) (died at the terms gate) and
[#1034](https://github.com/dd-jp/samurai-trading-system/issues/1034) (CLOSED — DMD needs no
registration, only a click-through Terms & Conditions already accepted).

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
files (§ Method) spanning both available trading dates, **30 of the pool's 31 rows appear** with
two-sided quote activity in the large majority of session-time files each was sampled in (typically
present in 85-98 of 108 files; see the per-ticker table in § Coverage). **MST3 (ISIN
`XS2901882618`) appears in zero of the 108 sampled `LSE Pre-Trade Documents` files across both
dates.** It is also absent from the one most-recent file pulled from each of DMD's three `SI`
(systematic-internaliser) participant feeds (`NMTRIAIR`, `NMOPVOF`, `BARCIE2DSEC` — the parallel
`si/` document set discovered while reverse-engineering the API). That SI check is a single
snapshot per participant, not a session-spanning sample, so it narrows but does not close the
question; the precise, defensible claim is **"absent from every sample pulled in this
investigation," not "DMD does not cover MST3 anywhere."** A single instrument being unreachable is
the honest residual, not a blocking negative result — see § Acceptance criteria.

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
every one falls in the opening-auction window (07:00-07:01 UTC) or the closing-auction window
(15:30-15:31 UTC onward) of the two sampled dates, and several show a crossed/aggressor-looking
book (`offerMarketSize` populated with `offerLimitPrice` at or through the bid) consistent with an
auction-cross market-order fill rather than a resting two-sided quote. `bidYield`/`offerYield` are
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
carries a numeric `instrumentId` (`72057594038070487` for 3USL, `72057594038056292` for 3LUS in
this file) that DMD itself uses to distinguish the two currency lines sharing one ISIN — so the
ISIN collision the ticket might have worried about is already resolved by the file's own schema;
this doc disambiguates the same way, corroborated by price scale (3USL trades in the 13,000s = GBX
pence; 3LUS trades in the 160-190s = USD, no overlap observed across 1,111/1,115 sampled rows
each). This is *better* than a snapshot for this ticket's purposes — it gives many observations
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
  systematic-internaliser document set, used only for the MST3 residual check above.

**Sample:** 108 `XLON-pre-<date>T<HH>_<MM>.csv` files, both available trading dates
(2026-09-11, 2026-09-14), 15-minute cadence 04:00-16:30 UTC (covers pre-market through
post-close), densified to 5-minute cadence inside the open (07:00-07:59) and close (15:00-15:29)
windows to reduce per-instrument sample noise in those buckets. Every fetch is logged
(`fileKey`, request URL, request/fetch timestamps) to `/tmp/dmd_cache/fetch_log.jsonl` at pull
time — this is the reproducible sampling basis; the log itself is not committed (see below), but
`46-lseg-dmd-pretrade-surface.py fetch` reproduces the identical pull.

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
"pulled quotes stay outside the repo" rule) — only the aggregates below and in
[`46-lseg-dmd-pretrade-surface.py`](46-lseg-dmd-pretrade-surface.py) are committed. The script's
`fetch` subcommand reproduces the identical pull (same dates, same minute cadence) and `analyze`
reproduces every table below byte-for-byte from the cached files.

## Coverage

30/31 pool rows found (union across all 108 files); MST3 absent from all of them (§ Q1 above).
Per-row detail (`rows` = quote-update ticks matched; `files_present` = how many of 108 sampled
files carried at least one row for that ISIN):

```
ticker  rows  two-sided  files_present/108     ticker  rows  two-sided  files_present/108
3USL    1111       1111       94                3AAP    3037       3035       96
3LUS    1115       1110       98                MST3       0          0        0   <- the gap
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
files carried at least one row for that ISIN. `covered: 30/31 rows (29/30 distinct ISINs)`.
Reproduces via `python3 46-lseg-dmd-pretrade-surface.py analyze`.

## Per-instrument round-trip and half-spread, session profile (open vs. close, median bps)

30 rows; MST3 excluded (no data). `n_open`/`n_close` are quote-update ticks matched in that bucket
across both sampled dates — the sampling basis for every median below.

```
ticker  open_rt  open_hs  close_rt  close_hs  n_open  n_close
3USL      11.9      5.9      15.2      7.6      260      168
3LUS      11.6      5.8      14.2      7.1      258      160
LQQ3      15.5      7.8      21.6     10.8      519      321
NVD3      30.5     15.3      13.1      6.6      647      501
3LNV     127.5     63.7     111.8     55.9      538      426
3QQQ     107.6     53.8      92.4     46.2      147      267
3LPA     226.9    113.5     163.7     81.8      137      173
PLT3      44.0     22.0      19.2      9.6      477      459
3LME     110.1     55.1      76.0     38.0      379      477
3LNP     186.9     93.5     108.1     54.1      158      232
3AMZ      66.4     33.2      36.1     18.1      667      480
3FB       65.2     32.6      40.4     20.2      648      465
3KOR      39.3     19.7      16.9      8.5      328      487
3XLE     149.3     74.6      69.9     35.0      307      238
3SPY     102.2     51.1      99.6     49.8      127      178
3LTS     142.0     71.0     116.3     58.1      322      395
3AAP      59.5     29.8      28.8     14.4      680      496
LAM3     168.7     84.3     157.0     78.5      334      322
3LAL     234.4    117.2     113.2     56.6      174      301
LPP3     315.8    157.9     138.9     69.4      210       87
LCO3     487.8    243.9     571.4    285.7      356      249
LAA3     218.8    109.4     126.8     63.4      105      141
3LMO     282.2    141.1     276.2    138.1      208      218
3LIP     666.7    333.3     266.9    133.4      265      211
3LSQ     462.0    231.0     172.0     86.0      240      219
3UBR     264.3    132.2     134.8     67.4      371      297
3RAC     177.0     88.5     173.9     87.0      316      193
3ARM     171.7     85.8      86.2     43.1      147      198
3VT      206.2    103.1      61.3     30.7       94      133
3KWE     206.4    103.2     150.4     75.2      406      129
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

**The 4 rows that narrow into the close instead of widening are exactly the pool's tightest,
most-liquid names**: 3USL (0.78x), 3LUS (0.82x), LQQ3 (0.72x), LCO3 (0.85x) — the four smallest
open-bucket round-trip spreads in the whole table (11.6-15.5 bps, against a pool open-bucket median
around 150-200 bps). **This is the decision-relevant asymmetry for Samurai specifically**: the
names most likely to actually get traded are the ones whose spread is worst, relatively, right at
the close — which is exactly when ADR-0014's flat-by-close horizon forces every exit. Figures are
round-trip bps; add Saxo's measured 16 bps round-trip commission (ADR-0015) to size the total exit
cost on top.

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
investigation** — the retracted script and its raw pull no longer exist to compare against. The
widest instruments here (3LIP, LCO3, 3LSQ, LAM3, LAL — all in the 900-1200+ bps open-bucket
round-trip range) and the tightest (3LUS, 3USL, LQQ3, all single-digit-to-low-teens bps
half-spread) are the same tight/wide split as the session-profile table above.

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
python3 docs/research/46-lseg-dmd-pretrade-surface.py analyze  # regenerates every table above
```
