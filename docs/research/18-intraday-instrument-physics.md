# 18 — Intraday instrument physics: what an instrument must do to support a same-day take-profit

**Produced:** 2026-08-09, resolving [#635](https://github.com/dd-jp/samurai-trading-system/issues/635) and informing [#657](https://github.com/dd-jp/samurai-trading-system/issues/657), under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631).
**Feeds:** [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md).
**Supersedes on horizon:** doc 10's diversified-basket universe (see [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)).

The universe question had been argued from doc 10's *effective bets* framing since the beginning. Under an intraday take-profit it is answerable from data, and the answer inverts the framing.

## Result 1 — a broad tracker cannot reach an intraday take-profit

Two years of daily bars (2024-08-01 → 2026-08-01, Alpaca SIP). For a long entered at the open, how often does the instrument reach a given gain above that open, and how often does it drop −0.5% first?

| instrument | reaches +1% | drops −0.5% |
| --- | --- | --- |
| SPY | **9.8%** of days | 45.5% |
| FTSE tracker (EWU) | 8.4% | ~45% |
| gold (GLD) | 13.0% | ~45% |

**A broad index tracker reaches +1% on fewer than one day in ten while hitting the stop on nearly half.** No entry timing repairs that: it is the instrument's physics, not the signal's quality.

### The consequence for universe design

Doc 10's low-correlation basket maximises effective bets, which under a same-day take-profit is **the opposite of what is needed** — diversification suppresses precisely the volatility the strategy consumes. The objective is **movers**.

## Result 2 — leverage does not improve the odds, it improves the economics

This is the part most easily misread. Leverage scales gains and losses alike, so the **break-even win rate stays at ~47%**. What changes is the ratio of gain to a *fixed-percentage* cost:

| | base | 3× ETP |
| --- | --- | --- |
| expectancy per trade | +0.063% | **+0.195%** |
| annualised | 16.3% | **50.7%** |

3USL's observed 0.18% round trip against 3× the base range is what produces the lift. This matters specifically because trade count is capped near one per day — with unlimited trades you would prefer more trades to bigger ones.

**Daily-reset decay does not apply.** It punishes *holding* leveraged ETPs across sessions; a flat-by-close strategy never holds one overnight.

## Result 3 — the LSE/US overlap holds most of the day's range

Run to test whether a London-hours strategy on a US-underlying ETP gives up too much. SPY 5-minute bars, 125 sessions, 2026-02-01 → 2026-08-01:

| window | % of day's range realised | reached +0.5% |
| --- | --- | --- |
| 1st hour (LDN 14:30–15:30) | **51.1%** | 9.6% |
| **first 2h (LDN 14:30–16:30) — LSE overlap ends** | **72.4%** | 26.4% |
| 3h | 80.8% | 32.8% |
| 4.5h | 89.8% | 39.2% |
| full session | 100% | 44.8% |

**The overlap contains 72.4% of the day's movement in 23.5% of the LSE session**, and 59% of the full-session chance of reaching +0.5% survives inside it.

It is doubly favourable: 14:30–16:30 London is both where the range concentrates *and* the window in which LSE and US are simultaneously open, so LSE-side spreads on a US-underlying ETP are tightest exactly then. The London morning is the worst of both — thin LSE liquidity against a shut underlying, where an RSI reading is computed on a market-maker's guess rather than a live market.

**This does not decide the session window.** It is an input to [#666](https://github.com/dd-jp/samurai-trading-system/issues/666), which measures LSE ETP behaviour directly rather than inferring it from the underlying.

## Limitations

- Every figure uses **US instruments as proxies**. [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) established there is no free LSE intraday history at this depth, so these characterise the *underlying's* physics, not the LSE ETP's own tape.
- **The entire leveraged-ETP case rests on one observed 0.18% spread quote for 3USL.** #666 must measure it and may overturn ADR-0016.
- Reach rates are computed from the daily open. A strategy entering on an indicator later in the session faces a different — and probably worse — conditional distribution, since part of the day's range is already spent. See [`41-tick-latency-economics.md`](41-tick-latency-economics.md) Result 1 for the intraday drift structure.
