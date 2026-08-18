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
`CALIBRATED_COST_CONFIG` in `server/tools/run-stage2.ts` — has a `spreadVolatilityCoefficient` fitted against
**daily ATR14** (`server/tools/run-spread-calibration.ts`, 36,617 Alpaca quotes, 2026-08-05). `ReplayDriver`
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
