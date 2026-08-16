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

## Amendment — 2026-08-16: crypto leaves paper too, for the duration of the equity build

- **Amends:** the ramp clause at line 35 — *"Crypto stays in paper until the full £750 can deploy at once"*
- **Earned by:** [#705](https://github.com/dd-jp/samurai-trading-system/issues/705), resolved 2026-08-16 under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703)
- **Companion amendment:** [ADR-0014](0014-intraday-flat-by-close-horizon.md), which carries the full rationale, the price and the unpark gate

**Crypto is removed from the tick loop in paper as well as production, for the duration of the equity build.** This ADR's ramp already sequenced equity live first; what it did not do is stop crypto ticking in paper. That is the change, and it is recorded here because this is the ADR the excess is measured against.

The binding reason is this ADR's own subject matter. **Gate 1's headline result is a nonzero equity trade count**, which #625 leaves unproven — and post-[#617](https://github.com/dd-jp/samurai-trading-system/issues/617) the intraday shape runs 48 crypto debates a day against 8 equity ones. A 14-day operational gate in which ~86% of the debates are crypto would report healthy aggregate mechanics while the equity trade count — the thing that decides whether either gate can open at all — stayed unmeasured. Parking crypto in paper is what makes Gate 1 a test of the leg being shipped.

**Consequences specific to this ADR:**

- **Gate 1 and Gate 2 both become equity-only measurements** while crypto is parked. Neither gate's arithmetic changes — ~24 trades at ~29% power for Gate 1, ~126 trades for Gate 2 — but the trade counts must now be reached on the equity leg alone, which is slower. At the recorded 14:30–15:45 entry window ([#706](https://github.com/dd-jp/samurai-trading-system/issues/706)) that is at most 2 entry decisions per name per session, so Gate 2's ~126 trades is the binding schedule constraint on the whole programme.
- **The three unconfirmables at lines 41–43 are unchanged, but item 1 is now deferred rather than pending.** Maker fills matter *"directly — the crypto leg's economics turn on maker versus taker"*, and with crypto parked that question cannot be exercised even in paper. It returns with the unpark; it does not get answered meanwhile.
- **The ramp clause itself stands** for what it decided: when crypto returns, it returns to paper first, and live crypto still waits until the full £750 can deploy at once per [ADR-0015](0015-live-venue-account-and-book-split.md). Suspension does not promote crypto's eventual live entry.

The unpark gate, the price (including ADR-0016's £1,140–1,660/yr lever left unpulled), and what stays inert in the codebase are all recorded in ADR-0014's companion amendment rather than duplicated here.

## Consequences

**Blocked by [#625](https://github.com/dd-jp/samurai-trading-system/issues/625).** 96 debates produced 0 trades — the stocks conviction ceiling was 0.5478 against a 0.55 floor. A soak that trades nothing measures nothing, and neither gate can open until it trades.

**The benchmark is not optional.** Per [ADR-0014](0014-intraday-flat-by-close-horizon.md) and doc 12's **D4**, the primary control is the recorded thesis's **falsifier arm 2** — same names, same ladder, same stop, entry by indicator alone, no LLM. Return-only comparison against a risk-targeted stream is ruled out; outside benchmarks report return **and** drawdown together. Owned by [#636](https://github.com/dd-jp/samurai-trading-system/issues/636).

**Live capital is tuition money.** The ramp exists to surface the three unconfirmables above at the smallest size that still produces real fills.
