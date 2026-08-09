# ADR-0017 — The 14-day paper run is an operational gate, not a thesis gate

- **Status:** Accepted
- **Date:** 2026-08-09
- **Decided by:** David — *"will run paper for 14 days and then decide whether live"*, refined on [#661](https://github.com/dd-jp/samurai-trading-system/issues/661)
- **Related:** [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) (blocks the run), [#636](https://github.com/dd-jp/samurai-trading-system/issues/636) (the benchmark), [ADR-0014](0014-intraday-flat-by-close-horizon.md), [ADR-0015](0015-live-venue-account-and-book-split.md)

## Context

The plan was to paper trade for 14 days and then decide whether to go live. That is a reasonable operational plan and a **statistically empty thesis test**, and conflating the two is the failure mode this ADR exists to prevent.

## The arithmetic that forces the split

At roughly two trades per day, 14 days yields **~24 trades**. Against a strategy claiming a ~55% win rate:

- Statistical power to distinguish that from a coin flip: **~29%**.
- Probability of a *winning fortnight with zero real edge*: **~50%**.

A profitable 14-day paper run is therefore close to uninformative about the edge. It is very informative about whether the machinery works.

## Decision

**Two distinct gates, with different sample sizes and different questions.**

### Gate 1 — operational, 14 days

Does the system run unattended without breaking? Orders submit, fills ingest, brackets place, the flatten fires, the breaker behaves, spend stays inside the cap, alerts reach a phone. Pass/fail on **mechanics**, explicitly **not** on PnL.

### Gate 2 — thesis, ~126 trades (~3 months)

An **expectancy sign test** at ~126 trades. This is the gate that may conclude the edge is real, and nothing before it may be read that way.

### Then a staged live ramp

Equity leg only, **£100–200**, with paper running in parallel for comparison. Crypto stays in paper until the full £750 can deploy at once ([ADR-0015](0015-live-venue-account-and-book-split.md) — a partial crypto deployment is a different, worse strategy).

## What paper cannot confirm at any sample size

These do not improve with more paper days, so they must not be treated as pending:

1. **Maker fills.** Paper fills assume a queue position that was never earned. This matters directly — the crypto leg's economics turn on maker versus taker ([#671](https://github.com/dd-jp/samurai-trading-system/issues/671)).
2. **Stop slippage.** Simulated stops fill at the trigger; real ones fill through it, which is precisely the tail [`docs/research/41-tick-latency-economics.md`](../research/41-tick-latency-economics.md) measures.
3. **The fee-tier ramp.** Volume-based tiers cannot accrue on simulated volume.

**Therefore paper expectancy is an upper bound, not an estimate.** Any live projection built on it should be discounted, and the size of that discount is unknown until real fills exist.

## Consequences

**Blocked by [#625](https://github.com/dd-jp/samurai-trading-system/issues/625).** 96 debates produced 0 trades — the stocks conviction ceiling was 0.5478 against a 0.55 floor. A soak that trades nothing measures nothing, and neither gate can open until it trades.

**The benchmark is not optional.** Per [ADR-0014](0014-intraday-flat-by-close-horizon.md) and doc 12's **D4**, the primary control is the recorded thesis's **falsifier arm 2** — same names, same ladder, same stop, entry by indicator alone, no LLM. Return-only comparison against a risk-targeted stream is ruled out; outside benchmarks report return **and** drawdown together. Owned by [#636](https://github.com/dd-jp/samurai-trading-system/issues/636).

**Live capital is tuition money.** The ramp exists to surface the three unconfirmables above at the smallest size that still produces real fills.
