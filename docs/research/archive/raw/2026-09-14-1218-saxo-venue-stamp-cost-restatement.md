# #1218 — the Saxo venue stamp against doc 53's published intraday cost decomposition

Run 2026-09-14 on branch `issue-1218-stage2-saxo-restate`, base `fa681525`.

**No intraday Stage 2 grid was re-run, and the issue's request for one cannot be met offline.**
`STAGE2_TIMEFRAME=1m STAGE2_SOURCE=free-stack` is the only intraday-capable path, and it would pull
~10 years of 1-minute bars for SPY/QQQ/AAPL/TSLA live from Alpaca: there is no
`data/stage2-bars.sqlite` in this worktree or in the main checkout, so nothing is cached.
`run-stage2-cost-decomposition.ts`, the one tool that decomposes charged cost directly, is
Polygon-bound and hard-pinned to `DEFAULT_STAGE2_TIMEFRAME` (daily), so it cannot answer an
intraday question at all. Per the standing instruction to stop rather than hammer a vendor, the
restatement below is done hermetically instead — which is sufficient, because it is exact.

**Why exact.** `CostModelImpl.resolveAssetConfig` merges a `CostConfig.venues` override into the
asset-class base **field by field**, and `CALIBRATED_INTRADAY_COST_CONFIG.venues.saxo` declares
exactly one field, `commissionRate: SAXO_COMMISSION_RATE = 0.0008`. Commission is
`max(rate × notional, floor × notional)`, so in bps of notional the charged commission **is** the
rate: 1 bp on the floor, 8 bps with the stamp, on every bar, independent of volatility, spread,
ADV, price and timeframe. Nothing else in the breakdown can move. That is a claim about the model's
arithmetic, not about any particular tape, so it is provable without bars — and the check below
proves it while also reconstructing doc 53's published table from the published figures themselves.

Producer: [`2026-09-14-1218-saxo-venue-check.mts`](2026-09-14-1218-saxo-venue-check.mts), run as
`npx tsx <file>`. Output: [`2026-09-14-1218-out.txt`](2026-09-14-1218-out.txt), reproduced verbatim
below.

```
#1218 — the venue stamp against doc 53's published intraday cost decomposition
notional per fill: $10000. All figures are bps.
config: CALIBRATED_INTRADAY_COST_CONFIG
  stocks: spreadVolatilityCoefficient=0.0697 commissionRate=0 slippageCoefficient=0.017425 impactK=0.05
  venues.saxo.commissionRate=0.0008

=== PART 1: reconstruction of doc 53's published G2 component table ===

symbol       spread commission   slippage     impact  2017-03-15   charged
SPY        1.0000     1.0000     0.0726     0.0024     2.0750     2.0750
QQQ        1.0000     1.0000     0.0724     0.0056     2.0780     2.0780
AAPL       1.0000     1.0000     0.1089     0.0085     2.1174     2.1174
TSLA       1.0000     1.0000     0.1430     0.0325     2.1755     2.2238

Every component reconstructs exactly. The last two columns are DIFFERENT quantities:
  '2017-03-15' is the component breakdown's single bar; 'charged' is doc 53's
  run-level charged cost. They coincide for SPY/QQQ/AAPL because those three sit
  on the spread floor on every bar, so the snapshot IS the run. TSLA is the one
  name whose 1m volatility moves it off the floor, so its run figure exceeds its
  2017-03-15 snapshot by 0.0483 bps. That gap is doc 53's, not this check's,
  and it is unaffected by the venue stamp: commission is a flat RATE on notional,
  identical on every bar, so the restatement below is +7.0000 bps on either basis.

=== PART 2: the same states, stamped venue=saxo ===

symbol       spread commission   slippage     impact      total      delta
SPY        1.0000     8.0000     0.0726     0.0024     9.0750     7.0000
QQQ        1.0000     8.0000     0.0724     0.0056     9.0780     7.0000
AAPL       1.0000     8.0000     0.1089     0.0085     9.1174     7.0000
TSLA       1.0000     8.0000     0.1430     0.0325     9.1755     7.0000

=== Doc 53's charged-cost column, restated (published + 7.0000 per fill) ===

symbol   was/fill  now/fill  was round trip  now round trip
SPY        2.0750     9.0750     4.1500    18.1500
QQQ        2.0780     9.0780     4.1560    18.1560
AAPL       2.1174     9.1174     4.2348    18.2348
TSLA       2.2238     9.2238     4.4476    18.4476

=== PART 3: the daily config carries no `venues` key, so the stamp is inert ===

symbol   unstamped     stamped
SPY        2.0063     2.0063
QQQ        2.0094     2.0094
AAPL       2.0143     2.0143
TSLA       2.0401     2.0401

CALIBRATED_COST_CONFIG.venues = undefined

=== PART 4: G2's delta column, as the code now runs it vs with `venues` equalized ===

symbol  daily cfg  intraday    delta |  daily+saxo  intraday    delta
SPY        2.0063     9.0750     7.0687 |     9.0063     9.0750     0.0687
QQQ        2.0094     9.0780     7.0686 |     9.0094     9.0780     0.0686
AAPL       2.0143     9.1174     7.1031 |     9.0143     9.1174     0.1031
TSLA       2.0401     9.1755     7.1354 |     9.0401     9.1755     0.1354

The left block is what G2's comparison now measures: the two timeframe-keyed configs
  differ on TWO axes, not one, because only the intraday config declares `venues`.
  The right block holds `venues` equal across both arms and recovers the published
  calibration deltas. Any future re-run of G2 must equalize `venues` or it measures
  the venue override instead of the spread/slippage/impact calibration.

ALL ASSERTIONS PASSED
```

## Reading it

**Part 1 is the control, and it is stronger than it looks.** The reconstruction pins `volatility`
from doc 53's published slippage and `adv` from its published impact, then lets the real
`CostModelImpl` produce all four components. Recovering two inputs and reproducing four outputs is
not circular — spread and commission are recovered by nothing and still land on 1.0000 exactly, and
**Part 3 reprices the same states under `CALIBRATED_COST_CONFIG` and independently reproduces doc
53's "1m bars, DAILY cfg" column — exactly on three symbols and within 0.0001 bps on SPY
(2.0063/2.0094/2.0143/2.0401 against a published 2.0062/2.0094/2.0143/2.0401)** — a column the
reconstruction never targeted.

**TSLA's 0.0483 bps gap is doc 53's own, and it is expected.** Doc 53's component table is one
session (2017-03-15) and its charged-cost column is a median over five. SPY, QQQ and AAPL sit on
the 1 bp spread floor on every bar, so for them the snapshot and the run are the same number; TSLA
is the one name whose 1m volatility lifts it off the floor, so its run median is above its snapshot.
This is orthogonal to the restatement: the stamp adds a flat +7.0000 bps on either basis.

**Part 2 is the finding.** Commission 1 → 8 bps; spread, slippage and impact bit-identical. The
restatement is therefore `+7.0000 bps/fill`, `+14.0000 bps round trip`, for every symbol, on every
bar — and doc 53's "cost is governed by the two 1bp structural floors (~4 bps round trip)" becomes
false on the intraday path. Only the spread floor still binds. The commission floor is inert at 80x
below the rate that replaced it.

**Part 3 is the guard against over-applying it.** `CALIBRATED_COST_CONFIG` declares no `venues` key,
so the stamp is inert under it and doc 53's two daily-config columns must not be restated.

**Part 4 is the correction to the obvious wrong reading.** The stamp does *not* add the same
constant to both arms of G2's comparison — precisely because Part 3 holds. Stamping is driven by the
instrument's venue, so both arms are stamped, but only the intraday config declares an override to
honour. G2's delta column as the code now runs it is therefore ~+7.07 bps, not the published
≤0.1837: **SPY +7.0687, QQQ +7.0686, AAPL +7.1031, TSLA +7.1354** on the 2017-03-15 snapshot basis
(+7.1837 for TSLA on its charged-cost basis). Every symbol is ~28x over the 0.25 bps bar. What that
means is not that the calibration moved but that **the two timeframe-keyed configs now differ on two
axes rather than one, so G2's delta no longer isolates what it was built to isolate.** Equalize
`venues` across both arms — the right-hand block — and the published deltas come straight back
(0.0687/0.0686/0.1031/0.1354, all under the bar), which is why the coefficient comparison itself is
intact and "roughly an order of magnitude" stays withdrawn: the 7 bps is commission, and nothing
about the spread/slippage/impact calibration changed.

## What this does NOT establish

- **It does not overturn G2's verdict, but it does change what a re-run of G2 has to do.** The
  comparison still passes on its real basis — with `venues` held equal the deltas are the published
  ones, under the 0.25 bps bar, so "roughly an order of magnitude" stays withdrawn — but any future
  re-run must equalize `venues` across the two arms or it measures the venue override rather than
  the calibration. G1, G3 and G4 are untouched.
- **16 bps is a floor on the live charge, not an estimate of it.** Saxo's live GIA commission was
  measured 2026-09-14 at 0.08%/side flat with no per-order minimum (ADR-0015 amendment `1d155b7e`).
  On top of it sit two unmodelled costs. The **FX conversion margin** is a recorded deferral, not an
  oversight — #1220 (2026-09-08) declined to model it and excluded non-sterling lines instead, which
  is sound for the live GBP LSE universe but not for doc 53, every symbol of which is a USD-quoted
  US equity: exactly the case `CostConfig.venues`' own docstring calls "missing the FX leg
  entirely". And the **LSE ETP spread** is still one unmeasured 3USL quote (#1053).
- **It is not a Stage 2 verdict and must not be cited as one.** Doc 53's acceptance bar item 5
  ("No intraday Stage 2 run is reported, cited, or treated as a verdict as part of this work")
  still binds, and no intraday grid result exists in this repo to restate.
