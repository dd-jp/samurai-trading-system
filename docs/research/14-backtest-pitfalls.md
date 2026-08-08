# Backtest and validation pitfalls — what the runs actually taught

**Status:** Consolidated 2026-08-08 from the 2026-08-05 pitfalls write-up ([archived](archive/2026-08-05-pitfalls-and-improvements.md), full detail and issue links there). Commissioned by David: *"capture what keeps going wrong, not just what went wrong once."*

These are recurring patterns, not incident reports. Each has cost the project at least one wrong verdict.

## The pitfalls

**P1 — A test fixture became the basis of a live verdict.** `PESSIMISTIC_COST_CONFIG` was written for unit tests, never calibrated against a real quote, and then drove a KILL. Measured against 36,617 Alpaca quotes it overstated spread by **27× for equities and 18× for crypto**. Test doubles must not be reachable from a production decision path.

**P2 — A "fallback" path that is actually the only path.** A branch labelled fallback carried every request, so nobody noticed its assumptions were never exercised against the primary.

**P3 — Errors surfacing many layers below their cause.** A bad config at the composition root produced a failure deep inside a client, where the message could not name the real problem.

**P4 — Entitlement caps that look like data gaps.** A vendor serving 2 years against a 5-year request looks like missing history. It was a paid entitlement boundary, confirmed only by probing for `NOT_AUTHORIZED`. Silence is not absence.

**P5 — Measuring at the wrong instant.** A closing-auction probe on SPY returned 752.40 / 799.00 — a 6% spread — because the measurement instant was wrong, not the market.

**P6 — Results that cannot be reproduced because the window moves.** A run against "the last 2 years" is not reproducible tomorrow. Pin windows explicitly.

**P7 — Seams designed without their consumer.** PBO and DSR were specified against a metrics interface that could not supply them: five anchored folds are not CSCV, and `MetricsSuite.sharpe` is Lo-annualized and non-invertible. The seam existed and was unusable. *(Resolved — #406.)*

**P8 — The trial budget was fixed before the sample size was known.** MinBTL was checked against an assumed 5-year window while the sample was 2 years, so a 12-config grid ran against a real limit of 7. *(Resolved — #405, grid now sized from the sample.)*

**P9 — Mechanisms that exist, are tested, and are never called.** This project's dominant defect class. Code with full unit coverage that no composition root wires up. Coverage proves the mechanism works, not that it runs.

**P10 — Artifacts silently discarded by tooling.** Output that a wrapper dropped without error, so a run appeared to produce nothing.

**P11 — Turnover is load-bearing but is not a gate.** Configs ran at turnover 115–556 with ~0.9 exposure. That multiplier sits in front of every cost term and nothing checks it.

**P12 — A guard rail silently became the dominant term.** A 1bp structural spread floor bound for 3 of 4 equities, which made the calibrated equity coefficient documented and inoperative. A floor that always fires is the model.

**P13 — A shared store used as a per-asset-class timeline.** Every run scored each asset class over the other's bars too, padding with zeros: 1,229 observations where the real counts were 500 and 729. It distorted every reported Sharpe by roughly 0.64× for stocks and 0.78× for crypto. *(Fixed — #420.)*

## Improvements, in priority order

1. **I1 — Size the grid from the sample, not from an assumption.** *(Done — #405.)*
2. **I2 — Build the PBO and DSR seams properly.** *(Done — #406.)*
3. **I3 — Feed real spread into `MarketState.spread`** and retire the fallback.
4. **I4 — Give every cost term explicit provenance** and make it ops config, not a constant.
5. **I5 — Add a turnover / cost-sensitivity gate** (P11).
6. **I6 — Fail loudly when a provider serves less than requested** (P4).
7. **I7 — Close the no-caller class with a composition-root test** (P9).
8. **I8 — Replace the slippage assumption with measurement.**
9. **I9 — Report when a floor or a fallback fired**, not just the resulting number (P12).
10. **I10 — Pin windows and archive raw output for every gate run** (P6) — the raw logs in [`archive/raw/`](archive/raw/) exist because of this.

## Corrected figures

The archived original quotes crypto PBO 0.35 and DSR 0.254; both predate the #420 fix. The corrected values are **PBO 0.30** and **DSR 0.255**. Neither changes a verdict — see [`13-stage2-proxy-verdict.md`](13-stage2-proxy-verdict.md) for the numbers that stand.
