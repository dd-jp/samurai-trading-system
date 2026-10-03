# CGT disposal-matching recordkeeping (#1518)

> **This is not tax advice.** It is a recordkeeping aid that applies HMRC's
> published share-identification rules to Samurai's own execution records.
> Every figure it produces must be independently verified — against the
> operator's Saxo contract notes and account statements — before it is relied
> on for a Self Assessment return. Samurai has no way to know the operator's
> income band, other disposals held outside this system, or any relief that
> might apply, so it computes **gain only**, never tax owed.

## v2 tax log (#1947)

The v2 runtime keeps its own per-disposal GBP log for share and ETF fills at
both venues (the Saxo GIA and the Alpaca account). The sections after this one
describe the v1 report, whose matching rules it reuses.

- **Matching.** `server/apps/v2/share-matching.ts` ports v1's matcher in the
  same order (same day, then acquisitions in the next 30 days earliest first,
  then the section 104 pool), with the same citations. Dates are UK calendar
  dates. Matching runs over the full fill history; the tax year
  (`[6 Apr Y, 6 Apr Y+1)`) only filters what is shown.
- **What counts.** Only fills of orders that reached a broker. Shadow, control
  and dry-run books are simulated, so their fills are never disposals. CFD
  venues are left to their own log (#1867). Paper broker fills appear in a
  paper store's log, but paper disposals are not taxable.
- **Capture (migration 0085).** Each `v2_fills` row records `currency`,
  `price_native`, `fee_native`, `fx_quote_per_gbp`, `fx_source` and
  `fill_date`. The rate is quoted as native units per £1, so GBP = native ÷
  rate. It is the rate the row's `price_gbp` was booked at: the fixed
  1 January BoE rate for USD (U3, source `boe-xudluss:year-start:<year>@<fix
  date>`, naming the fix used, so a series that ends before 1 January shows
  as a stale fix) and
  1 for GBP (source `gbp`). `fill_date` is the London calendar date of the
  broker's fill time. A row with no fill time is dated by its trading date.
- **The day's rate.** Doc 66's carried constraint converts each US disposal at
  the day's rate, not the 1 January rate. `server/apps/v2/api/tax.ts` converts
  every USD fill, acquisitions included, at the BoE XUDLUSS fix for its date,
  or the last fix before it when BoE publishes none, within 7 days. It refuses
  a date the loaded series has not reached yet. Each disposal shows the rate
  and the fix date it used (`boe-xudluss:<fix date>`). David ruled the BoE
  XUDLUSS source on 2026-10-02 (doc 66). The fourth leg of the bar refresh
  (`server/apps/v2/fx-refresh.ts`, every non-dry run, #2000) re-reads the
  last 14 days from the BoE IADB and appends only the fixes after the file's
  last row; a refetched row that differs from the file, a missing overlap row,
  a response cut off mid-row, one that does not parse or no answer within
  30 s refuses the append, logs
  `v2_fx_refresh_failed` and keeps the file. Until a refresh reaches a fill's
  date the fill holds its instrument out. The dashboard's tax reader re-reads
  the file whenever it changes, so no restart is needed. The parser refuses a
  series that is not in strictly ascending date order.
- **Splits.** When the cycle rescales a held position it journals each split
  step in `v2_splits` (instrument, venue, the date of the first bar in the new
  units, ratio). A split held at two venues is journalled twice and counted
  once; two venues that disagree on its ratio hold the instrument out. The
  log matches in post-split units and shows each disposal
  in its own day's units. A split while nothing is held is not journalled. A
  sale before such a split and a buy back after it within 30 days would then
  match in mixed units.
- **Cash in lieu.** A `cash_in_lieu` fill left by a fractional split (#1989)
  is a disposal and is flagged. It is booked at the latest close. When
  Alpaca's own payment (its `CIL` account activity, #2001) is journalled in
  `v2_cash_in_lieu`, the log pairs it with the estimates of the same venue and
  name on the nearest estimate date within 30 days either side. Those
  estimates then give way to one disposal at their summed qty and the broker's
  amount, on the estimate's date and at that date's rate, and the row names
  the activity (`cash_in_lieu_activity`). The estimate rows are never changed,
  so the correction is the appended broker row. Each row carries the broker's
  status: an activity the broker reports canceled drops with all its rows, and
  a correction holds its instrument out, since Alpaca does not link it to the
  activity it corrects. A payment with no estimate in the window, in another
  currency, of the wrong sign, for a qty more than 1e-6 off the estimates',
  pairing a buy with a sell, or for a name with no fills holds its instrument
  out. Saxo's corporate-action
  booking is not read yet, so a Saxo disposal keeps the estimate.
- **Held out, never guessed.** An instrument is held out, with the reason and
  its fill count, when any of its fills predates migration 0085, has no day
  rate, or is in a second currency. It is also held out when the section 104
  pool cannot cover a disposal. That happens with a short sale not bought back
  inside 30 days, or with missing history. A held-out instrument is never
  converted or partly matched. It is listed in the year it has fills in, so
  the year never reads as having no disposals.
- **Provisional.** A section 104 match is provisional until 30 days after the
  disposal, as in v1.
- **Served.** `/api/v2/tax?year` serves the dashboard's tax panel (P13), and
  `&format=csv` downloads the same year with held-out instruments as
  `held_out` rows.

## What this covers

Samurai's live equity leg trades on a **Saxo Capital Markets UK General
Investment Account (GIA)**, not an ISA (David's 2026-08-26 ruling, ADR-0015's
2026-08-30 amendment). A GIA's disposals are Capital Gains Tax events. This
ticket is scoped to that leg only: the report excludes the simulated control
arm (never a real disposal) and any historical crypto row (a real CGT event
too, once, but out of this ticket's scope — crypto left Samurai's scope
entirely on 2026-08-16).

## Where the underlying data already lives

Every fill was already captured with acquisition/disposal date, price,
quantity, fee and (since migration 0054) fee currency at execution time —
`fills` since `0001_init.sql`, `server/pipeline/execution/ingest-fills.ts`.
**No new capture and no migration was needed for this ticket**: what was
missing was the matching/export layer, not the record. `instrument` is not a
column on `fills` itself; it is resolved by an exact join on
`idempotency_key` against whichever of `closed_trades` (a round-tripped lot)
or `open_positions` (a still-open one) carries the row — see
`server/pipeline/cgt/sqlite-cgt-fill-source.ts`'s header for why both tables
must be read.

One qualification to "already captured": `fills.fee` is not a broker-
reported charge. The Saxo activity feed carries no commission field, so
`saxo-adapter.ts`'s `toCashFill` MODELS it — the published 0.08% GBP-ETP
tariff applied to the fill's own cash amount, per ADR-0015 §"Saxo". This
report's allowable cost and proceeds therefore rest on a modelled charge, not
a contract-note one; verifying against the operator's actual contract notes
(the disclaimer above) is not optional polish for that figure specifically.

## How matching works

`server/pipeline/cgt/cgt-disposal-matching.ts` is a pure module implementing
HMRC's statutory share-identification order (TCGA92 ss105-106A, restated in
the CGT manual), applied in this order to every disposal:

1. **Same-day rule** ([CG51560](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51560))
   — acquisitions and disposals of the same instrument on the same day are
   matched with each other first, pooled at that day's average price.
2. **30-day "bed and breakfast" rule** ([CG51560](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51560)/[CG51570](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51570))
   — whatever a disposal has left over is matched against acquisitions of the
   same instrument in the FOLLOWING 30 days, earliest first. An acquisition
   before the disposal never qualifies here — only the Section 104 pool can
   price a disposal against an earlier holding.
3. **Section 104 pool** ([CG51575](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51575))
   — everything left over is priced at the running average cost of one pool
   per instrument, built from every acquisition the first two rules did not
   already claim.

Matching runs over the **full** fill history, not just the reported tax
year — the Section 104 pool and the 30-day rule both need acquisitions
outside the window to price a disposal inside it correctly. Tax-year
filtering happens only at the export step.

The UK tax year is 6 April to 5 April, treated as the half-open interval
`[6 Apr Y, 6 Apr Y+1)`. The Saxo GIA leg trades GBP LSE-listed instruments
only, whose session (08:00-16:30 London) never crosses the UTC/London date
boundary, so bucketing by UTC calendar date is equivalent to Europe/London
bucketing for this venue — see `cgt-disposal-matching.ts`'s `dayKey` doc. A
future non-LSE venue would need this re-derived.

### Disposals can be provisional for up to 30 days

The 30-day rule looks **forward** from a disposal. A disposal priced by the
Section 104 pool today can still be reclassified to a `30-day` match — with a
different rule, allowable cost and gain — if an acquisition of the same
instrument arrives before that disposal's 30-day window closes. The report
marks every such row `(provisional)` and states the run's own "generated"
timestamp so the reader knows which disposals that applies to; treat a
`(provisional)` row as final only once you re-run the report after its
window has closed. A `same-day` or `30-day` match is never provisional — it
was already matched against a specific acquisition that exists.

## Currency: GBP, pence sub-units, and everything else

`fills.fee_currency` also names the currency `fills.price` is denominated
in (both come off Saxo's `CurrencyCode` for the line — see
`sqlite-cgt-fill-source.ts`'s header). Classification reuses
`isPenceCurrency`/`BOOK_CURRENCY` (`server/shared/book-currency.ts`, #1465)
rather than a bespoke check, so the report handles three cases:

- **GBP** — the common case, used as-is.
- **Pence** (`GBX`/`gbx`/`GBp`/`p`) — normalised ÷100. Defensive rather than
  reachable today: the Saxo adapter's own `CurrencyCode` already resolves to
  GBP for a pence-quoted line before a fee is ever persisted
  (`saxo-price-unit.ts`), so no live fill is expected to carry a pence
  `fee_currency` — but one must not be summed as pounds if it ever appears.
- **Anything else** (USD on the pool lines the #1220 sterling gate excludes from
  `tradeableUniverse()` in `lse-etp-pool.ts` — occasionally EUR) — converts on
  `fills.fx_rate_to_gbp` (#1521, migration 0060) when the row carries a
  **strictly positive** rate: `grossAmount`/`charges` multiplied by the
  venue's own rate, applied verbatim, never re-derived or blended with an
  independent spot lookup. A zero or negative stored value is refused rather
  than multiplied by (round 1 review) — it would silently zero out or
  sign-flip a real disposal, and both are worse than treating the row as
  unconverted. **The multiply direction (`native amount × rate = GBP
  amount`, i.e. the rate is read as GBP per 1 unit of native currency) is
  asserted by this doc and by `sqlite-cgt-fill-source.ts`'s own comments —
  it has never been observed against a real Saxo payload**, because no
  reachable Saxo surface has ever populated this column for a real fill (see
  "#1521's field verification" below). If a future Saxo field turns out to
  use the inverse convention, `toCashFill` must divide, not multiply, when it
  starts populating this column, and this doc and that test must be
  corrected in the same change. A row with neither a book currency nor a
  usable stored rate still has **no transaction-date FX rate and this report
  still does not invent one** — it is excluded from every matched disposal
  and every total above, and listed separately, in its own native currency,
  under **UNCONVERTED — FX rate not captured at fill time**, alongside the
  specific reason (`fills.fx_rate_to_gbp_source`, or `no_rate_stored` /
  `invalid_stored_rate:<value>` when this module attaches the reason itself).
  Converting such a row to sterling by hand, from the operator's own contract
  notes, is required before it can be included in a return.

  **#1521's field verification (SIM, 2026-09-14).** `saxo-adapter.ts`'s
  `toCashFill` is the only place a Saxo fill is built, and its only data
  source is `GET /cs/v1/audit/orderactivities`. That endpoint was probed
  against 45 real activity rows on the SIM account (`FinalFill`/`Placed`/
  `Cancelled`/`Changed` all represented) and carries **no conversion-rate
  field of any kind** — the full field list observed: `AccountId`,
  `ActivityTime`, `Amount`, `AssetType`, `AveragePrice`, `BuySell`,
  `ClientId`, `CorrelationKey`, `Duration`, `ExecutionPrice`,
  `ExternalReference`, `FillAmount`, `FilledAmount`, `HandledBy`, `LogId`,
  `OrderId`, `OrderRelation`, `OrderType`, `PositionId`, `Price`,
  `RelatedOrders`, `Status`, `SubStatus`, `Uic`, `UserId`. `GET
  /port/v1/positions` and `GET /port/v1/closedpositions` (ClientKey-only and
  ClientKey+AccountKey) both returned zero rows for the probed account, so
  their schemas could not be checked against real data either; the four
  `PositionId`s the activity feed named each 404'd individually against
  `GET /port/v1/positions/{id}`. `GET /port/v1/activities` and `GET
  /cs/v1/reports/trades` both 404 outright (not reachable routes for this
  app key). Reference docs (developer.saxo, **not independently verified
  against real data**) describe a `ConversionRate` field on "Position
  Events" and boolean `ConversionRateInstrumentToBase{Opening,Closing}Settled`
  flags on `ClosedPosition` — neither matches the ticket's assumed
  `ConversionRateInstrumentToAccountCurrency` name, and neither was found on
  any endpoint this system actually reads.
  **Conclusion: no reachable Saxo surface currently supplies this rate**, so
  `toCashFill` never sets `fx_rate_to_gbp` for a live fill — it sets
  `fx_rate_to_gbp_source: 'not_reported_by_venue'` instead, and the fill
  still lands in the unconverted section above exactly as it did before this
  ticket. The column and the report-side conversion exist for a future Saxo
  surface, or a widened universe (#1310) that reintroduces non-sterling
  lines with a rate attached; migration `0060_fills_fx_rate_to_gbp.sql`'s
  header carries the same record.

  **Re-probed 2026-09-15 (this ticket, reopened): same conclusion, one new
  field noted.** `GET /port/v1/closedpositions` and `GET /port/v1/positions`
  (both `?ClientKey=...` and `?ClientKey=...&AccountKey=...`) again returned
  zero rows for the SIM account — a day of further paper trading did not
  produce a closed position to check `ConversionRateInstrumentToBase{Opening,Closing}Settled`
  against, so that candidate remains unverified. `GET /port/v1/accounts/me`
  (200, 1 row) carries a field not previously recorded here:
  `IsCurrencyConversionAtSettlementTime: true` on this account — a
  settlement-time-conversion flag, not a rate, and not on any fill/position
  payload this system reads; noted as a lead for whichever future ticket
  finally has a closed position to probe, not evidence a rate is reachable
  today. **Reported, not pasted** — this session's probe summarised the
  field rather than recording the raw redacted response body; the next
  probe should paste the payload alongside this claim. `IsTrialAccount: true`
  is unchanged from the prior probe. **AC3
  remains unmet**: it needs either a real closed position on this SIM (or
  live) account to check the candidate field against, or an owner decision
  to accept a different rate source — no code change in this repo can
  resolve it.

## Refusals, not silent mispricing

The matcher and its data source throw rather than produce a confidently wrong
number:

- A fill attributable to neither `closed_trades` nor `open_positions`.
- A `side = 'sell'` lot — short-sale CGT treatment differs from this
  long-only model and is not implemented.
- A disposal that exceeds every acquisition the Section 104 pool has ever
  recorded for that instrument — a data-integrity fault, not a zero.
- `--tax-year` before the tax year `ANNUAL_EXEMPT_AMOUNT_GBP` is sourced for
  (2024/25) — an earlier year used a different Annual Exempt Amount this
  report does not have on file, so it refuses rather than print the current
  figure under a year it may not apply to.
- `SAMURAI_MODE` is not `live` — a paper/backtest store's rows are not CGT
  events at all, and every other integrity fault here refuses rather than
  mis-report, so this one does too.
- The store the report would open is missing a table or column it needs
  (see "Running the report" below) — named explicitly rather than read
  against a schema this report was not written against.

A non-GBP, non-pence (i.e. not GBX/gbx/GBp/p) fee currency is **not** in this list any more (round 1
review, finding 1): earlier drafts refused the whole report on it, which
would have aborted on the majority of the tradeable pool's USD-denominated
lines. See "Currency" above.

## Running the report

```
npm run report:cgt                      # current UK tax year, against SAMURAI_MODE's store
npm run report:cgt -- --tax-year 2024-25
```

The report prints the store mode and path on every run, and refuses outright
if `SAMURAI_MODE` is not `live` — a paper-mode store's rows are not CGT
events at all, and misreading one as the live book would be the worst
failure this tool could produce silently.

It opens the store **read-only** (`openReadOnlyCgtStore`) and never runs
migrations against it — unlike most `server/tools/*.ts` reports, which open
the shared store read-write via `openSharedStore`. A live-money store must
never take a write handle from a reporting tool, and must never have
migrations run against it by a process that is not the orchestrator,
possibly while the orchestrator holds the same file open. If the store
predates a migration this report needs, it refuses and names the missing
table or column rather than reading a schema it was not written against.

## Known gap, deliberately not closed here

`fills` carries no ISIN/SEDOL — only the ticker Samurai trades under. An
accountant will usually want an ISIN. The operator maps ticker → ISIN from
the universe pool at filing time; building that mapping into the report is
future work, not part of this ticket.
