# Stage 2 — the proxy strategy verdict chain

**Status:** Consolidated 2026-08-08 from seven run records (see the chain table). **Verdict: KILL, terminal.**
**Scope note that matters more than the verdict:** the strategy killed here is a **proxy** — a moving-average cross with ATR brackets — not the strategy Samurai intends to trade. It says nothing about the Stage 0 hypothesis in [`10-edge-hypothesis.md`](10-edge-hypothesis.md).

## The verdict in one paragraph

The proxy was measured seven times between 2026-07-29 and 2026-08-07. **Every single run returned KILL.** What changed across the chain was never the verdict — only the reason it was reached. First the inputs did not exist; then the cost model turned out to be a test fixture charging crypto 210.9 bps a round trip; then the trial budget was exceeded; then, once costs were calibrated and the grid sized to the sample, the strategy failed on selection accounting — PBO 0.85/0.55 against a 0.05 line. The last escape hatch was sample length: every run to that point had only 1.99 years of history. Serving 10.2 years off the free stack closed it. On ten years the PBO halves and still rejects at 7× the line, and OOS pass rate *falls* to 3 of 24. **The failure is a property of the strategy, not of the sample.**

## The chain

| # | Run | Date | Sample | PBO (S/C) | DSR (S/C) | OOS pass | What moved |
|---|---|---|---|---|---|---|---|
| 1 | [overfitting verdict](archive/2026-07-29-stage2-overfitting-verdict.md) | 07-29 | — | — | — | — | **No verdict renderable** — PBO/DSR inputs did not exist |
| 2 | [first real run](archive/2026-08-05-stage2-verdict-first-real-run.md) | 08-05 | 1.99y | — | — | 2/24 net | First live Polygon data; 22 of 24 negative; MinBTL exceeded (12 vs 7) |
| 3 | [cost decomposition](archive/2026-08-05-stage2-cost-decomposition.md) | 08-05 | 1.99y | — | — | 2/24 net, 16/24 gross | Kill attributed to the cost fixture, not the signal |
| 4 | [cost-model calibration](archive/2026-08-05-cost-model-calibration.md) | 08-05 | 1.99y | — | — | 12/24 (14 corrected) | Fixture overstated spread 27× equities / 18× crypto, over 36,617 real quotes |
| 5 | [PBO/DSR first computation](archive/2026-08-05-stage2-pbo-dsr-first-computation.md) | 08-05 | 1.99y | 0.65 / 0.30 | 0.255 / 0.519 | 14/24 | Both computed for the first time; **both reject**. Found the #420 merged-timeline defect |
| 6 | [post-#405 re-run](archive/2026-08-06-stage2-verdict-post-405.md) | 08-06 | 1.99y | 0.85 / 0.55 | 0.356 / 0.395 | 9/14 | Grid sized to sample — **MinBTL finally passes** (7 vs 7), and PBO gets *worse* |
| 7 | [free-stack re-run](archive/2026-08-07-stage2-verdict-free-stack.md) | 08-07 | **10.2y** | **0.35 / 0.40** | **0.153 / 0.805** | **3/24** | Sample length pulled at £0. **KILL is terminal** |

Kill line, from [`02-staged-deployment-plan.md`](02-staged-deployment-plan.md): OOS Sharpe < 0.5, PBO > 0.05, DSR insignificant.

## What the chain actually taught

- **The early kills were the cost model, not the signal.** Run 3 showed 16 of 24 configs profitable gross against 2 net. The `PESSIMISTIC_COST_CONFIG` driving that gap came from a test fixture, never calibrated against a real quote — it charged crypto 0.45 ATR per fill. Calibration (run 4) moved the pass count from 2/24 to 12/24. This is the single most expensive mistake in the chain and is recorded as pitfall P1 in [`14-backtest-pitfalls.md`](14-backtest-pitfalls.md).
- **Calibration did not save it.** Better costs raised the pass count and changed nothing about the verdict, because the binding constraint moved to selection accounting.
- **PBO is the gate that bites.** It was uncomputable for the first two months of the project's life, and the moment it was computed it rejected — and kept rejecting through every subsequent fix. A 12-config grid that produces a 0.774 best OOS Sharpe still has a 35% probability that the selected config is below-median out of sample.
- **More history made the result worse, not better.** OOS pass went 14/24 → 3/24 when the sample went from 2 years to 10. Two years of a bull tape flattered the strategy.
- **The harness is now good.** MinBTL headroom is 812 configs against a fixed 12-config grid, on 10.2 years of bars at £0. Whatever strategy is validated next, the machinery is no longer the limit.

Fixes that landed along the way, each of which changed reported numbers: **#405** (grid sized from sample, fixing MinBTL), **#420** (per-asset-class timelines — every prior run had scored each asset class over the other's bars too, distorting Sharpe by ~0.64× for stocks and ~0.78× for crypto), **#375/#384** (selection frozen to a store).

## Why this is not the end of the strategy question

The proxy exists because a backtest cannot host an LLM debate (ADR-0001). It was always a stand-in for the mechanical layer, chosen for being cheap to sweep — not for being what we believe in. The strategy Samurai actually claims is a vol-targeted multi-asset premium harvest with a trend overlay, recorded in [`10-edge-hypothesis.md`](10-edge-hypothesis.md) and measured in [`11-trend-signal-measurement.md`](11-trend-signal-measurement.md). **That strategy has never been through Stage 2.** Running it is open item 2 in [`12-edge-hypothesis-critique.md`](12-edge-hypothesis-critique.md).

Do not cite this KILL as evidence against the hypothesis. It is evidence about a moving-average cross.

## Provenance

Terminal run at commit `211f425`, full suite 2795 passing, 10.2-year window served from the free stack (Alpaca SIP equities, Coinbase crypto — see [`31-free-ohlcv-evidence.md`](31-free-ohlcv-evidence.md)). Raw run logs for the 2026-08-05 runs are in [`archive/raw/`](archive/raw/). Each row of the chain table links to the full record; those docs are preserved verbatim and are the authoritative audit trail for any number quoted here.
