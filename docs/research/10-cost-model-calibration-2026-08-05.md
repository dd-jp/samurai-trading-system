# Cost Model Calibration — Measured, Not Assumed (2026-08-05)

**Status:** Recorded 2026-08-05. Follows
[09-stage2-cost-decomposition-2026-08-05.md](09-stage2-cost-decomposition-2026-08-05.md), whose
first recommendation was "calibrate the cost model before buying history". Commissioned by David:
*"caliberate cost and based on runs so far identify pitfalls and improvements"*. The pitfalls half
is [11-pitfalls-and-improvements-2026-08-05.md](11-pitfalls-and-improvements-2026-08-05.md).

Raw output: [spread-calibration-2026-08-05.txt](spread-calibration-2026-08-05.txt),
[stage2-calibrated-run-2026-08-05.txt](stage2-calibrated-run-2026-08-05.txt).
Code: `src/scripts/run-spread-calibration.ts`, `CALIBRATED_COST_CONFIG` in `src/scripts/run-stage2.ts`.

## Headline

> **Calibrated, the grid goes from 2 of 24 to 12 of 24 pairs clearing the 0.5 OOS Sharpe line — and
> the Stage 2 gate STILL returns `KILL/INCOMPLETE`.**
>
> Both halves matter. The cost fixture really was the thing killing the configs: measured against
> 36,617 real Alpaca quotes, it overstated the spread by **27× for equities and 18× for crypto**.
> But MinBTL is untouched by any of it — 12 trials against a cap of 7 — and PBO/DSR remain
> structurally uncomputable. **Nothing here is a pass, and none of it graduates anything.**

## What was measured

`run-spread-calibration.ts` sampled real Alpaca bid/ask quotes across 24 dates spanning the same
2-year window the grid replays, in the five minutes before each bar's close:

| | days | quotes | median spread | p90 | median spread/ATR14 |
|---|---|---|---|---|---|
| SPY | 17 | 8,046 | **0.30 bps** | 0.51 | 0.0022 |
| QQQ | 17 | 8,162 | 0.39 bps | 0.69 | 0.0022 |
| AAPL | 17 | 8,221 | 1.49 bps | 2.57 | 0.0051 |
| TSLA | 17 | 8,453 | 3.24 bps | 4.97 | 0.0063 |
| BTC-USD | 23 | 2,705 | **11.72 bps** | 14.70 | 0.0340 |
| ETH-USD | 22 | 1,030 | 13.34 bps | 15.14 | 0.0220 |

Median and p90 are reported together because spreads are right-skewed and a mean over a window
containing a volatility spike is not the typical fill. They track closely here (p90 is under ~2× the
median everywhere, and much tighter than that for crypto), so a single coefficient per asset class
is a defensible summary — that was not guaranteed and is worth having checked.

### Point-in-time discipline

The replay fills at the bar close, so the spread that matters is the spread *at* the close. Two
traps were avoided deliberately, and both are real:

- **Not midday.** SPY quotes ~0.18–0.26bps mid-session and wider into the close. Sampling the
  convenient hour would have flattered the calibration.
- **Not spanning the bell.** A live probe on 2026-08-05 at 20:00:00.008Z returned SPY at
  **752.40 / 799.00** — a 6% spread, and AAPL at 293.64/324.64. Those are closing-auction
  artifacts, not tradeable two-sided markets. The sample window stops before the bell.

DST is derived per-date via `Intl` rather than assumed, since the window spans several transitions
and an EST date sampled at 20:00Z would measure an hour *before* the close.

## The calibrated config, term by term

| term | stocks | crypto | basis |
|---|---|---|---|
| `spreadVolatilityCoefficient` | **0.0037** (was 0.1) | **0.028** (was 0.5) | **Measured** — medians above |
| `commissionRate` | **0** (was 0.0005) | **0.0025** (was 0.001) | **Published** fee schedules |
| `slippageCoefficient` | **0.000925** (was 0.05) | **0.007** (was 0.2) | **Assumption**, derived from measured spread |
| `impactK` | 0.05 (unchanged) | 0.1 (unchanged) | No basis to revise; negligible in practice |

**Commission is the one term the old fixture set too LOW.** Alpaca's base-tier crypto *taker* fee is
0.25% (`docs.alpaca.markets/docs/crypto-fees`, retrieved 2026-08-05) — taker, not maker, because
`ReplayDriver` issues market orders. The fixture had 0.001. So calibration moves crypto's terms in
*opposite* directions: spread down 18×, commission up 2.5×. This is exactly why the uniform
sensitivity ladder in the previous write-up was labelled a diagnostic and not a forecast.

US equities are commission-free at Alpaca, with only SEC / FINRA-TAF / CAT regulatory fees passed
through on sells. Rather than invent a rate for those, `commissionRate` is set to **0** and
`CostModelImpl`'s structural 1bp floor is left to do the job — which is already more than the real
pass-through, so the model stays conservative without a fabricated number in it.

### The structural floors, not the measurement, now price equities

`CostModelImpl` floors the half-spread at 1bp of mid and commission at 1bp of notional, so that no
config can construct a frictionless fill. Against the measured spreads, that floor **binds for three
of the four equities**:

| | measured full spread | implied half-spread | 1bp floor binds? |
|---|---|---|---|
| SPY | 0.30 bps | 0.15 bps | **yes** (~6×) |
| QQQ | 0.39 bps | 0.20 bps | **yes** (~5×) |
| AAPL | 1.49 bps | 0.75 bps | **yes** |
| TSLA | 3.24 bps | 1.62 bps | no |
| BTC / ETH | 11.72 / 13.34 bps | ~6 bps | no |

Confirmed empirically rather than inferred: re-running the sensitivity ladder under the calibrated
config, the realized **stock** charge is 2.3bps at ×1 and still **2.0bps at ×0.05** — scaling every
equity coefficient down twentyfold barely moves it. Crypto over the same rungs falls 34.5 → 2.4bps,
exactly as a measured, unfloored term should. In a representative stock row the components are
`spread=348, commission=340` — near-identical, which is the signature of both sitting on the same
floor rather than on any market data.

**So the equity `spreadVolatilityCoefficient` is effectively inoperative.** Fills would be identical
at 0.0037, 0.001, or 0. Equities pay roughly 1bp half-spread + 1bp commission per leg ≈ **2.3bps of
round-trip notional**, against a measured reality nearer 0.5bps — still ~4–5× conservative, and
none of that conservatism is measurement. It is the guard rail.

This is not an error in the run: 12/24 is a real result from the real cost model with its floors
applied, and erring conservative is the right direction. But the equity spread number should be read
as *documented and inoperative*, not as *driving the result*. Only crypto's calibration actually
changes what gets charged — which is also why crypto moved 0/12 → 6/12 while stocks moved only
2/12 → 6/12. That asymmetry is the floors, not the market.

**After calibration, crypto cost is dominated by the published fee, not the spread.** In a
representative crypto row: `commission=6203` of `total=8544` — **73%**. The exercise has inverted
which term matters, and the remaining crypto cost is the one number here that is externally
verifiable from a fee schedule.

**Slippage is an assumption, and is labelled as one in the config.** It cannot be measured without
live fills, and inventing a coefficient is the precise defect this exercise exists to remove. It is
therefore *derived*: `spreadVolatilityCoefficient / 4`, i.e. half of the half-spread, as a
conservative buffer on top of the modeled crossing cost. The fraction is a judgement call. The paper
soak (#238) will produce live fills to replace it with, which is also the modeled-vs-realized
divergence check the Feedback Loop already wants (cross-spec GAP-F).

Note the "half of the half-spread" relationship holds only *before* the floor. Slippage has no
floor, so wherever the half-spread is floored up to 1bp — three of four equities — slippage is
nearer a tenth of the effective half-spread than a half. Visible in the stock row above:
`spread=348, slippage=84`.

### Two sampling caveats

- **Quote pages are truncated at 500.** Alpaca returns ascending, so for the high-volume equities
  (all four hit the cap) the sample is the *first* ~500 quotes of the five-minute window — around
  four and a half minutes before the bell rather than the final seconds. Immaterial wherever the
  floor binds anyway, but a small optimistic bias for TSLA, the one equity the floor does not catch.
  Crypto (~118 quotes/day) is not truncated.
- **24 dates is a modest sample.** Enough for a median with a tight median/p90 gap; not enough to
  characterise a regime change.

## The calibrated verdict

| | pessimistic fixture | calibrated |
|---|---|---|
| Pairs clearing 0.5 OOS Sharpe | **2 / 24** | **12 / 24** (6 stocks, 6 crypto) |
| Best profit factor | 1.14 | **1.77** |
| MinBTL | 12 trials vs cap 7, `exceeded: true` | **identical** |
| PBO / DSR | not computable | **not computable** |
| **Verdict** | **KILL/INCOMPLETE** | **KILL/INCOMPLETE** |

Run over the **effective window 2024-08-06 .. 2026-08-05**, from a requested window pinned to the
millisecond (`STAGE2_PINNED_WINDOW`) rather than `defaultFiveYearWindow()`'s `new Date()`-relative
range — otherwise the fold boundaries, and so the pass count, would shift on every re-run. That is
pitfall P6 in the companion document, and the first calibrated run was made before it was applied;
the entrypoint now passes the pinned window.

12/24 sits between the frictionless bound (16/24) and the uniform ×0.25 rung (11/24) — consistent
with both, and a useful sanity check that the calibration did not overshoot into fantasy.

**The gate still fails, for reasons calibration cannot touch:**

1. **MinBTL is unchanged.** The cap is a function of sample length and trial count. 12 > 7, still.
   With twelve configs now passing rather than two, "pick the best" is a live risk in a way it was
   not when almost everything failed — which makes fixing the trial budget more urgent, not less.
2. **PBO and DSR remain structurally uncomputable** — 5 anchored walk-forward folds are not a CSCV
   partition; `MetricsSuite` exposes no per-period Sharpe.
3. **Turnover is unchanged at 115–556.** Calibration lowered the cost *rate*; it did not make the
   strategy trade less. At that churn the result stays acutely sensitive to a cost model that is now
   accurate for *Alpaca at $10k a trade* and would need redoing for any other venue or size.
4. **One term is still an assumption.** Slippage is derived, not measured.

## What to do next

1. **Fix the trial budget** — cut the grid to ≤ 7 configs, or buy the Polygon history that lifts the
   cap toward ~45. This is now the binding constraint, and it is the cheapest remaining move.
2. **Build the PBO/DSR seams** — needed regardless, and still what blocks #384 and #375.
3. **Replace the slippage assumption from live fills** once the soak has run.
4. **Do not treat 12/24 as a green light.** It is the same evidence as before, scored with a
   defensible cost model instead of an indefensible one.
