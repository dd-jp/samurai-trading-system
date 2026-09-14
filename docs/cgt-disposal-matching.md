# CGT disposal-matching recordkeeping (#1518)

> **This is not tax advice.** It is a recordkeeping aid that applies HMRC's
> published share-identification rules to Samurai's own execution records.
> Every figure it produces must be independently verified — against the
> operator's Saxo contract notes and account statements — before it is relied
> on for a Self Assessment return. Samurai has no way to know the operator's
> income band, other disposals held outside this system, or any relief that
> might apply, so it computes **gain only**, never tax owed.

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

## Refusals, not silent mispricing

The matcher and its data source throw rather than produce a confidently wrong
number:

- A fill attributable to neither `closed_trades` nor `open_positions`.
- A `side = 'sell'` lot — short-sale CGT treatment differs from this
  long-only model and is not implemented.
- A fee reported in a currency other than GBP (`fills.fee_currency`) — this
  report sums charges as GBP and has no FX model to convert one.
- A disposal that exceeds every acquisition the Section 104 pool has ever
  recorded for that instrument — a data-integrity fault, not a zero.

## Running the report

```
yarn report:cgt                      # current UK tax year, against SAMURAI_MODE's store
yarn report:cgt -- --tax-year 2024-25
```

The report prints the store mode and path on every run — a paper-mode
store's rows are not CGT events at all, and misreading one as the live book
would be the worst failure this tool could produce silently.

## Known gap, deliberately not closed here

`fills` carries no ISIN/SEDOL — only the ticker Samurai trades under. An
accountant will usually want an ISIN. The operator maps ticker → ISIN from
the universe pool at filing time; building that mapping into the report is
future work, not part of this ticket.
