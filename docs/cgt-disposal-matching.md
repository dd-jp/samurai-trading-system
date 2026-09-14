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
- **Anything else** (USD on most of the tradeable pool's lines, per
  `lse-etp-pool.ts` — occasionally EUR) — this report has no transaction-date
  FX rate and **does not invent one**. These fills are excluded from every
  matched disposal and every total above, and are listed separately, in
  their own native currency, under **UNCONVERTED — FX rate not captured at
  fill time** on every report. Converting them to sterling by hand, from the
  operator's own contract notes, is required before they can be included in
  a return. Capturing the transaction-date FX rate at fill time (so this
  section becomes unnecessary) is a follow-up, tracked separately from
  #1518 — no `saxo-adapter.ts` or execution-path change was made for this.

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
yarn report:cgt                      # current UK tax year, against SAMURAI_MODE's store
yarn report:cgt -- --tax-year 2024-25
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
