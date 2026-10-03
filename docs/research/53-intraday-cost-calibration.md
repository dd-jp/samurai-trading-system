# Intraday cost calibration — the declared criterion, before measuring

**Ticket:** [#875](https://github.com/dd-jp/samurai-trading-system/issues/875). **Declared 2026-08-18, before the
calibration run.** Committed on its own so the ordering is verifiable in `git log` for this file, per the
convention [#757](https://github.com/dd-jp/samurai-trading-system/issues/757) established and
[#857](https://github.com/dd-jp/samurai-trading-system/issues/857) / [#685](https://github.com/dd-jp/samurai-trading-system/issues/685)
followed. The measurement is appended to this same file afterwards; nothing above the measurement heading is
edited once it is run.

## The defect as #875 states it

[#664](https://github.com/dd-jp/samurai-trading-system/issues/664) (PR
[#874](https://github.com/dd-jp/samurai-trading-system/pull/874)) made `ReplayDriver` replay intraday bars, so an
intraday Stage 2 run is reachable for the first time. The cost config it would be scored against —
`CALIBRATED_COST_CONFIG` in `server/tools/run-stage2.ts` — has a `spreadVolatilityCoefficient` fitted against <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at tag v1-final -->
**daily ATR14** (`server/tools/run-spread-calibration.ts`, 36,617 Alpaca quotes, 2026-08-05). `ReplayDriver` <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at tag v1-final -->
hardcodes `marketState.spread = null`, so `CostModelImpl` falls back to `spread = volatility ×
spreadVolatilityCoefficient` on **every** fill, with `volatility` the ATR of whatever bars the run replays. At
minute resolution that ATR is far smaller, so the modelled spread is far narrower — flattering, at exactly the
resolution the product now trades. #874 prints a WARNING saying so and that no intraday number is a verdict until
this is recalibrated.

## Premise correction, found before this criterion was written

Two probes were run to orient before declaring anything. Both are disclosed here rather than in the measurement
section, because they change what the criterion should gate, and hiding them would make the ordering convention
worthless.

**Probe A — which cost term actually carries the charge.** `CostModelImpl` floors the half-spread at
`STRUCTURAL_MIN_HALF_SPREAD_RATE = 0.0001` (1 bp of mid) and the commission at 1 bp of notional. Running the real
`CostModelImpl` with the real `CALIBRATED_COST_CONFIG` against real Alpaca SIP bars (SPY/QQQ/AAPL/TSLA; 1d over
2026-05-01..2026-08-05, 1m over 2026-08-03..2026-08-04) gives, per fill, in bps of mid:

| symbol | tf | ATR14 (bps of mid) | modelled raw half-spread | charged half-spread | slippage | impact |
|---|---|---|---|---|---|---|
| SPY | 1d | 124.9 | 0.2310 | **1.0000 (floor)** | 0.1155 | 0.0032 |
| SPY | 1m | 6.1 | 0.0113 | **1.0000 (floor)** | 0.0056 | 0.0014 |
| QQQ | 1d | 219.5 | 0.4062 | **1.0000 (floor)** | 0.2031 | 0.0063 |
| QQQ | 1m | 7.5 | 0.0138 | **1.0000 (floor)** | 0.0069 | 0.0024 |
| AAPL | 1d | 317.9 | 0.5881 | **1.0000 (floor)** | 0.2941 | 0.0121 |
| AAPL | 1m | 12.3 | 0.0228 | **1.0000 (floor)** | 0.0114 | 0.0033 |
| TSLA | 1d | 483.2 | 0.8940 | **1.0000 (floor)** | 0.4470 | 0.0210 |
| TSLA | 1m | 16.4 | 0.0303 | **1.0000 (floor)** | 0.0152 | 0.0083 |

The modelled raw half-spread is **below the structural floor in all eight rows — daily included**. So for
`stocks`, changing `spreadVolatilityCoefficient` moves the charged spread by exactly zero at either resolution.
The intraday runs are equities-only (`universeFor` in `run-stage2.ts`), so the `crypto` branch is unreachable on
the path this ticket concerns, and crypto left Samurai's scope on 2026-08-16 anyway (ADR-0015 amendment).

What *does* shrink with per-minute volatility is the **unfloored** `slippage` term (0.12–0.45 bps → 0.006–0.015 bps,
a 20–30x drop) and the negligible `impact` term. Total charged per fill therefore moves from ~2.1–2.5 bps (1d) to
~2.01 bps (1m) — an understatement of **~0.1–0.45 bps per fill**, not the order of magnitude the issue body
anticipated. #875's "roughly an order of magnitude too narrow" is true of the *raw spread term* and false of the
*charged cost*.

**Probe B — would a correctly fitted intraday coefficient bind?** By construction `fitted = spread / ATR_1m`, so
`fitted × ATR_1m / 2 = spread / 2`; the question is whether half the real quoted spread clears the 1 bp floor.
Median real Alpaca SIP quoted spread on 2026-08-04, three one-minute windows, half-spread in bps of mid:

| symbol | open+10m | midday | close−5m |
|---|---|---|---|
| SPY | 0.1307 | 0.0649 | 0.1296 |
| QQQ | 0.2097 | 0.0694 | 0.2763 |
| AAPL | 0.6538 | 0.3244 | 0.4844 |
| TSLA | **1.6984** | 0.7686 | **1.3748** |

So the floor absorbs a correctly-fitted coefficient for SPY, QQQ and AAPL — but **not for TSLA at the open and
into the close**, where the real half-spread is 1.4–1.7x the floor. The coefficient is therefore not uniformly
cosmetic, and a single per-asset-class number cannot represent both SPY and TSLA. That is a finding in its own
right and the criterion below must be able to express it.

**Probe C — data reach.** Alpaca serves SIP historical *quotes* for SPY on the keys already held at 2016-06-01,
2018, 2020, 2022, 2024 and 2026 (20 quotes returned per one-minute probe window at each). The calibration window
can therefore overlap `STAGE2_FREE_STACK_WINDOW` (2016-01-01 → 2026-08-05) in full, which is what the daily
calibration's own discipline demands: "the ratio being fit is a ratio of two quantities that must come from the
same period."

## What is UNCONDITIONAL, and is not gated on any measurement

**Making the cost config timeframe-keyed.** A ratio fitted against daily ATR14 and then applied to per-minute ATR14
is a category error whatever its magnitude, so a magnitude gate on this fix is a gate that cannot rationally fail.
The floor finding *strengthens* this rather than excusing it: the coefficient is currently non-binding for three of
four symbols only because a structural guard is absorbing it, and anyone who later lowers that guard — a live
reason to, once the universe moves to instruments with real spreads — silently inherits a 20–30x-flattering spread
term with no warning attached.

The keying follows `periodsPerYearFor(assetClass, timeframe)`, the existing precedent for a timeframe-keyed
constant, and #874's timeframe-scoped historical store. `costConfigFromEnv`'s `SAMURAI_STAGE2_COST_CONFIG=pessimistic`
escape hatch composes with it and is not removed.

**What is explicitly NOT touched.** `STRUCTURAL_MIN_HALF_SPREAD_RATE` and `STRUCTURAL_MIN_COMMISSION_RATE` are a
Principle-1 structural guard with their own stated basis; changing either would move every recorded daily Stage 2
result and is not what #875 asks for. The finding is reported and filed as a follow-up, not acted on here.
`impactK` carries forward unchanged for the same reason the daily config gives — its basis was an empirical
smallness claim (54 of 62,393 currency units), and the product shrinks further at minute resolution, so there is
no measurement basis to revise it and no benefit in loosening it.

## What the measurement DOES gate

Declared now, before the numbers exist.

**G1 — the disposition of the #874 WARNING.** Its current text makes a specific factual claim: that the config
"models a spread roughly an order of magnitude too narrow at minute resolution". Discriminator:

- **Drops entirely** only if, after the recalibration, the modelled per-fill charged cost at 1m is no lower than at
  1d for **every** stock symbol in the universe, AND no uncovered gap remains between the calibrated universe and
  the universe a verdict would be read against. Both conjuncts must hold.
- **Narrows** if the recalibration removes the stated defect (the daily-fitted ratio) but a *named, different*
  residual remains. The replacement text must state the residual, not a vaguer version of the old claim.
- **Stays as-is** if the recalibration fails to produce a measured intraday coefficient at all — e.g. quotes
  unobtainable over a window overlapping the replay window.

Probe A already makes "drops entirely" unlikely and Probe C already makes "stays as-is" unlikely, so **narrows**
is the anticipated outcome. It is written this way so that outcome is reachable on its merits rather than by
retreat.

**G2 — the magnitude claim, quantified.** Report the modelled per-fill charged cost, in bps of notional, at 1d and
at 1m, under (a) the daily config and (b) the intraday config, for all four stock symbols. **Bar declared now: if
swapping the daily config for the intraday-fitted one changes the charged per-fill cost by less than 0.25 bps of
notional for every symbol, the "order of magnitude" claim is withdrawn in the WARNING text as unsupported**, and
the timeframe keying is recorded as correctness-preserving rather than as a repricing. If it changes by 0.25 bps or
more for any symbol, the intraday config is a genuine repricing and the WARNING text is replaced by a statement of
the new charge.

**G3 — whether one per-asset-class coefficient is defensible intraday.** Report the fitted coefficient per symbol
and the median/p90 across symbols, and the per-bucket session profile (open / mid-session / close). If the p90
across symbols exceeds 2x the median, record explicitly that a single `stocks` coefficient under-charges the wide
names, and file it rather than inventing a per-symbol config here.

**G4 — the proxy gap, stated not closed.** The calibrated universe is US equities (SPY/QQQ/AAPL/TSLA); the live
tradeable universe is **GBP LSE-listed leveraged ETPs** (ADR-0016), and `docs/research/33-intraday-data-availability.md`
records that no free 10-year LSE quote source exists and that the existing calibration "covers instruments that are
no longer tradeable". This ticket does not close that gap and must not claim to. Every number produced here is
labelled a **US-equity proxy** wherever it appears, with the statement of what closing it would take.

## Method, declared before the run

- **Instruments:** `STOCK_SYMBOLS` (SPY, QQQ, AAPL, TSLA) — the Stage 2 universe. No crypto: intraday Stage 2 is
  equities-only and crypto is out of scope.
- **Window:** overlapping `STAGE2_FREE_STACK_WINDOW`, the window an intraday Stage 2 run replays.
- **Quantity fitted:** median over sampled minutes of (median quoted spread in that minute) ÷ (ATR14 computed on
  **1-minute** bars as of that minute), i.e. exactly the ratio `CostModelImpl` consumes, at the replay resolution.
  ATR14 comes from the repo's own `computeIndicator`, not a hand-rolled loop, so it is the same Wilder width the
  replay sees post-[#857](https://github.com/dd-jp/samurai-trading-system/issues/857).
- **Sampling:** minutes spread across the regular session in three buckets — open, mid-session, close — because
  fills land at every 1m bar close, and the intraday spread profile is U-shaped. Reported per bucket as well as
  pooled.
- **Exclusions:** the opening print at 13:30Z and the closing bell are both excluded, symmetrically. The daily
  calibration excludes the bell because a quote timestamped at the close is a closing-auction artifact, not a
  tradeable two-sided market; the opening auction is the same artifact, and at 1m resolution it would otherwise
  dominate the first bucket. Crossed/locked books are filtered by the existing `spreadOf`, unchanged — including
  them would drag the median toward zero, the exact direction this exercise must not err in.
- **Statistic:** median, not mean — spreads are right-skewed and a mean over a window containing a volatility spike
  is not the typical fill. p90 reported alongside, as the daily calibration does.
- **`slippageCoefficient`:** recomputed by the config's own declared rule, `spreadVolatilityCoefficient / 4`, and
  labelled the same **ASSUMPTION** the daily config labels it. No new derivation is invented.
- **Data handling:** pulled quotes stay outside the repo; only aggregates are printed or committed. No test makes a
  network call — the live pull is investigation, run by hand.

## Acceptance bar

1. This criterion committed before the measurement, verifiable in this file's `git log`.
2. A named test per behavioural change, each proved by removal (mutate, observe the named test fail, report it).
3. **Daily results reproduce identically** — asserted by a test that the daily branch deep-equals today's
   `CALIBRATED_COST_CONFIG`, not assumed.
4. An explicit statement of G1's outcome and why.
5. No intraday Stage 2 run is reported, cited, or treated as a verdict as part of this work.

---

# The measurement, run after the criterion above was committed

Everything above this line was committed before any of the numbers below existed
(`git log --follow docs/research/53-intraday-cost-calibration.md`). Nothing above it has been edited since.

**Every number here is a US-equity proxy** (SPY/QQQ/AAPL/TSLA, Alpaca SIP consolidated quotes). See G4.

## The calibration run

```
node --import tsx /tmp/i875/run-intraday.mts 24
  # -> runIntradaySpreadCalibration({ sampleDays: 24 })
  # -> server/tools/run-spread-calibration.ts --intraday
```

24 sampled dates x 3 session buckets across `STAGE2_FREE_STACK_WINDOW` (2016-01-01 .. 2026-08-05) at `1m`.
Roughly 8,000-9,200 real quotes per symbol per bucket (TSLA thinner in the early years: 5,781-7,704).

```
=== Measured spread vs ATR14 on 1m bars ===
SPY    n=57 median=0.347bps p90=0.489bps  spread/ATR median=0.0618 p90=0.2311
  open    n=19 quotes=9153 median=0.364bps spread/ATR median=0.0463 p90=0.1346
  midday  n=19 quotes=9002 median=0.348bps spread/ATR median=0.0764 p90=0.3065
  close   n=19 quotes=9040 median=0.342bps spread/ATR median=0.0488 p90=0.2311
QQQ    n=57 median=0.546bps p90=0.931bps  spread/ATR median=0.0614 p90=0.3061
  open    n=19 quotes=9090 median=0.596bps spread/ATR median=0.0561 p90=0.1621
  midday  n=19 quotes=9132 median=0.546bps spread/ATR median=0.1055 p90=0.3273
  close   n=19 quotes=9194 median=0.527bps spread/ATR median=0.0580 p90=0.3100
AAPL   n=57 median=0.740bps p90=1.607bps  spread/ATR median=0.0777 p90=0.1827
  open    n=19 quotes=9247 median=1.113bps spread/ATR median=0.0473 p90=0.0934
  midday  n=19 quotes=8984 median=0.699bps spread/ATR median=0.1148 p90=0.2545
  close   n=19 quotes=9114 median=0.667bps spread/ATR median=0.0774 p90=0.2092
TSLA   n=57 median=4.216bps p90=10.032bps spread/ATR median=0.2272 p90=0.5723
  open    n=19 quotes=7704 median=6.872bps spread/ATR median=0.2061 p90=0.3930
  midday  n=19 quotes=5781 median=4.216bps spread/ATR median=0.2814 p90=0.7123
  close   n=19 quotes=7459 median=2.528bps spread/ATR median=0.2093 p90=0.3136

=== Fitted intraday spreadVolatilityCoefficient (stocks, from medians) ===
  stocks: 0.0697   (p90 across symbols: 0.2272; daily-fitted: 0.0037)
```

**`CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient = 0.0697`**, with
`slippageCoefficient = 0.0697 / 4 = 0.017425` by the daily config's own declared rule. **18.8x the daily-fitted
0.0037** — the correction moves the model toward charging MORE than the daily-fitted config charges at 1m,
which is the safe direction. It does NOT lift a 1m run above what a 1d run charges: see G1, where the floor is
invariant while the slippage term still shrinks with per-minute ATR.

An independent 4-date trial run beforehand fitted 0.0858 on the same method — same order, same conclusion, and the
24-date figure is the one adopted.

## G2 — the magnitude claim: WITHDRAWN as unsupported

```
node --import tsx /tmp/i875/charged-cost.mts
```

Per-fill charged cost in bps of notional, median over 5 sessions spread across the replay window
(2017-03-15, 2019-09-18, 2021-06-16, 2023-11-15, 2026-05-13), at `DEFAULT_CAPITAL_PER_TRADE`:

| symbol | 1m bars, DAILY cfg | 1m bars, INTRADAY cfg | delta | 1d bars, DAILY cfg |
| --- | --- | --- | --- | --- |
| SPY | 2.0062 | 2.0750 | **+0.0688** | 2.0833 |
| QQQ | 2.0094 | 2.0780 | **+0.0686** | 2.1158 |
| AAPL | 2.0143 | 2.1174 | **+0.1031** | 2.1574 |
| TSLA | 2.0401 | 2.2238 | **+0.1837** | 2.3176 |

The declared bar was 0.25 bps for **any** symbol. The largest delta is **0.1837 bps (TSLA)**. Every symbol is
below the bar, so per the criterion committed before the run, **the "roughly an order of magnitude" claim is
withdrawn from the WARNING text as unsupported**, and the timeframe keying is recorded as correctness-preserving
rather than as a material repricing.

**Why, mechanically.** Component breakdown printed by the same script (2017-03-15 session, bps of notional):

| symbol | spread (daily cfg) | spread (intraday cfg) | slippage (daily cfg) | slippage (intraday cfg) | commission | impact |
| --- | --- | --- | --- | --- | --- | --- |
| SPY | 1.0000 | 1.0000 | 0.0039 | 0.0726 | 1.0000 | 0.0024 |
| QQQ | 1.0000 | 1.0000 | 0.0038 | 0.0724 | 1.0000 | 0.0056 |
| AAPL | 1.0000 | 1.0000 | 0.0058 | 0.1089 | 1.0000 | 0.0085 |
| TSLA | 1.0000 | 1.0000 | 0.0076 | 0.1430 | 1.0000 | 0.0325 |

The charged half-spread is pinned at exactly `STRUCTURAL_MIN_HALF_SPREAD_RATE` (1bp of mid) under **both** configs
at **both** resolutions, for every symbol. The raw modelled spread never reaches the floor — at 1m the intraday
coefficient gives roughly 0.24-0.72 bps half-spread, still under 1bp. So the entire repricing arrives through the
**unfloored slippage term**, and the charged spread does not move at all. This confirms the premise correction
recorded above the line, now with the intraday-fitted coefficient in hand rather than the daily one.

This is the substantive finding of the ticket: **at $10k notional in this universe, modelled cost is governed by
the two 1bp structural floors (~4 bps round trip), not by the spread calibration.** A coefficient error of 19x
moves the charged cost by 3-9%. Filing rather than acting on it — the floors are a Principle-1 guard and #875 does
not have a mandate to touch them, and the criterion above explicitly excludes them.

> **Amended 2026-09-14 by [#1218](https://github.com/dd-jp/samurai-trading-system/issues/1218): the commission
> floor no longer binds on the intraday path, and the paragraph immediately above is withdrawn as the level
> claim.** Every number in the two tables above was measured before the intraday grid stamped a venue.
> `run-stage2.ts` now stamps `venue: 'saxo'` on the stock universe whenever the timeframe is not daily, and
> `CALIBRATED_INTRADAY_COST_CONFIG` carries `venues.saxo.commissionRate = SAXO_COMMISSION_RATE = 0.0008`. Since
> `resolveAssetConfig` merges a venue override field-by-field, that override reaches **`commissionRate` and
> nothing else**. Restated in full below; the measurement that establishes it is
> [`archive/raw/2026-09-14-1218-saxo-venue-stamp-cost-restatement.md`](archive/raw/2026-09-14-1218-saxo-venue-stamp-cost-restatement.md).
>
> | symbol | commission was | commission now | per fill was | per fill now | round trip was | round trip now |
> | --- | --- | --- | --- | --- | --- | --- |
> | SPY | 1.0000 | **8.0000** | 2.0750 | **9.0750** | 4.1500 | **18.1500** |
> | QQQ | 1.0000 | **8.0000** | 2.0780 | **9.0780** | 4.1560 | **18.1560** |
> | AAPL | 1.0000 | **8.0000** | 2.1174 | **9.1174** | 4.2348 | **18.2348** |
> | TSLA | 1.0000 | **8.0000** | 2.2238 | **9.2238** | 4.4476 | **18.4476** |
>
> **The correct level statement is now the opposite of the withdrawn one: intraday cost is governed by a venue
> commission RATE, not by the floors.** Only the spread floor still binds. The commission floor is inert — 8 bps
> is 80x it — so a coefficient error in the spread fit moves the charged cost by well under 1% rather than the
> 3-9% recorded above.
>
> **Only the INTRADAY-cfg column moves.** `CALIBRATED_COST_CONFIG` declares no `venues` key at all, so the stamp
> is inert under it: the "1m bars, DAILY cfg" and "1d bars, DAILY cfg" columns are unchanged, and adding 7 bps to
> them would be wrong. The restatement log re-prices both configs to show this rather than asserting it.
>
> **G2's delta column therefore does NOT survive as printed — but its verdict does.** Because only one of the two
> configs declares a `venues` key, the stamp does not cancel across the comparison: the instrument is stamped in
> both arms, but only the intraday arm has an override to honour. As the code now runs it the deltas become
> **+7.0687 (SPY), +7.0686 (QQQ), +7.1031 (AAPL), +7.1354 (TSLA)** on the *2017-03-15 snapshot* basis, or
> **+7.0688 / +7.0686 / +7.1031 / +7.1837** on the *published five-session-median* basis of the table above —
> every symbol roughly 28x over the 0.25 bps bar either way. **Mind the basis**: the two differ only on TSLA, by
> the 0.0483 bps the restatement log records as doc 53's own snapshot-vs-median gap, and the flat +7.0000 carries
> through both identically. That is not a repricing of the spread calibration. It is the two timeframe-keyed
> configs now differing on **two axes rather than one**, so the delta no longer isolates what it was built to
> isolate. Hold `venues` equal across both arms and the published deltas come back on their own basis — the
> log's snapshot figures 0.0687 / 0.0686 / 0.1031 / 0.1354 against this table's 0.0688 / 0.0686 / 0.1031 /
> 0.1837, and the largest of the four, TSLA's 0.1837, is still under the 0.25 bps bar — so the coefficient
> comparison is intact, **"roughly an order of magnitude" stays withdrawn**, and G3 and G4 are untouched (for G1
> see its residual 1 below, amended by the same ticket). **Any future re-run of G2 must equalize `venues` across the two
> arms, or it measures the venue override instead of the calibration.** Part 4 of the restatement log prices both
> ways rather than arguing it.
>
> **16 bps is a FLOOR on the live charge, not an estimate of it.** Saxo's live GIA commission was measured
> 2026-09-14 at **0.08%/side flat with no per-order minimum** (ADR-0015's amendment, `1d155b7e`) — so the
> round-trip commission is 16 bps and the earlier SIM-tariff £8 minimum does not apply. Two costs sit on top and
> neither is modelled here. The **FX conversion margin** is a recorded deferral, not an oversight: #1220 (David's
> 2026-09-08 ruling) declined to model it and excluded non-sterling lines instead, which is sound for the live
> GBP LSE universe but *not* for this document — every symbol measured here is a **USD-quoted US equity**, exactly
> the case `CostConfig.venues`' docstring warns is "missing the FX leg entirely". And the LSE ETP spread remains
> unmeasured (G4 below, #1053). The restated figures are therefore a lower bound in both directions that matter.

## G3 — one `stocks` coefficient is NOT defensible: fires, and is filed

p90 across symbols 0.2272 (TSLA) against a median of 0.0697 is **3.3x**, above the declared 2x threshold. Recorded
explicitly: **a single `stocks` coefficient under-charges the wide names.** TSLA's real median 1m half-spread is
4.216 bps — over 4x the structural floor and 12x SPY's 0.347 bps — so TSLA is the one symbol in this universe
where the spread term would actually escape the floor under a per-symbol coefficient, and it is charged the floor
instead. Per the criterion this is filed, not fixed here; inventing a per-symbol config was ruled out in advance.

The session profile is also real: TSLA's open median (6.872 bps) is 2.7x its close median (2.528 bps), and AAPL's
open (1.113 bps) is 1.7x its close (0.667 bps). A single all-session coefficient under-charges the open. Same
disposition — recorded, not acted on.

## G1 — the WARNING NARROWS

The stated defect is gone: the ratio is now fitted at the resolution it is consumed at, and `costConfigFor` selects
it. "Drops entirely" required both conjuncts and neither holds — the 1m charged cost is still *below* the 1d
charged cost for every symbol (the floor is invariant while slippage still shrinks with per-minute ATR), and the
G4 proxy gap is uncovered. So the WARNING narrows, and its replacement states three named residuals:

1. charged half-spread is at the structural floor at both resolutions and under both configs, so the floor governs
   what a fill is charged, not this calibration; **amended 2026-09-14 by
   [#1218](https://github.com/dd-jp/samurai-trading-system/issues/1218) — the first clause stands, the second no
   longer does on the intraday path. The *spread* floor still binds, but what governs a fill's charge there is now
   `venues.saxo.commissionRate` (8 bps/side), which dwarfs both floors. See the amendment box in G2;**
2. one per-asset-class coefficient under-charges the wide names (G3, TSLA at 3.3x the median);
3. the fit is a **US-equity proxy**; the live universe is GBP LSE-listed leveraged ETPs (ADR-0016) with no free
   quote source.

The sentence claiming an order-of-magnitude understatement is deleted, and a test asserts it is absent.

## G4 — the proxy gap, stated and NOT closed

Every figure above is measured on US equities via Alpaca SIP. The live tradeable universe is GBP LSE-listed
leveraged ETPs (ADR-0016), and `docs/research/33-intraday-data-availability.md` records that no free LSE quote
source exists over a comparable window. Closing this would take a paid LSE level-1 quote feed with history (or an
accumulation of live Trading 212 fills once the equity leg trades), fitted the same way against LSE 1m bars.
Until then the intraday coefficient is a proxy, and an LSE leveraged ETP's real spread is very likely **wider**
than a US mega-cap's — so the proxy errs optimistic, which is the direction this repo has been wrong in before.

## What could not be measured

- **LSE leveraged-ETP spreads** — no free quote source (G4 above). Doc 58 §F2b found a free unauthenticated LSE
  endpoint returning bid/offer for all thirty pool lines, but **that endpoint's use, and doc 58's §F6 measurement
  of it (median 88.1 bps round trip against 3USL's 15.6 bps), are RETRACTED 2026-09-08 by
  [#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)** — LSE Terms §8 bars the programmatic
  access that collected it (#999). G4's conclusion that this document's figures are a US proxy stands unrevised;
  closing the gap now needs [#1035](https://github.com/dd-jp/samurai-trading-system/issues/1035)'s licensed path,
  not the deleted free-endpoint scrape.
- **Realised slippage** — needs live fills. Left as the daily config's declared `coefficient / 4` assumption,
  labelled as such, unchanged in kind. **Doc 58 F1 finds there are none: pipeline-generated fills are ZERO, and
  the paper soak can never supply them** — Alpaca paper books `fee = 0.0` and no bid/ask is persisted anywhere in
  the schema.
- **Whether the structural floors are correctly sized** — the floors dominate the charged cost, but validating
  them needs realised fills, and they are explicitly out of this ticket's scope. **ANSWERED 2026-09-02 by doc 58
  §F4: they are under-sized and flattering for the live universe, in sign if not in every cited magnitude.**
  Saxo charges 8 bps per side (ADR-0015:201) against a 1 bp commission floor — F4's argument is sign-only and
  needs no per-instrument spread measurement to hold. **Superseded in part 2026-09-14 by #1218: on the intraday
  path the commission floor no longer dominates anything, because the venue stamp replaced it with the 8 bps rate
  outright — see the G2 amendment. The remaining open question is the SPREAD floor alone, which still binds on
  every symbol here and is still validated only by fills nobody has.** The "all 30 of 30 pool lines show a half-spread above the
  1 bp spread floor" count is doc 58 §F6's, **RETRACTED 2026-09-08 by [#1036](https://github.com/dd-jp/samurai-trading-system/issues/1036)**
  (LSE Terms §8, #999) — it is not currently evidenced.
