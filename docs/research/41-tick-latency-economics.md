# 41 — Tick latency economics: what a minute of delay actually costs

**Produced:** 2026-08-09, resolving [#657](https://github.com/dd-jp/samurai-trading-system/issues/657) and [#670](https://github.com/dd-jp/samurai-trading-system/issues/670) under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631).
**Feeds:** [ADR-0008](../adr/0008-llm-spend-cap.md) §2 (amended), [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md).

Asked to justify a tick interval below 15 minutes. The measurement does not support one. This records why, and the formula to re-derive it when the inputs change.

## The objective

Tick interval τ trades two costs against each other:

```
T(τ)  =  C/τ  +  B·√τ
         ↑        ↑
      LLM spend   latency cost
```

**LLM term.** While [#617](https://github.com/dd-jp/samurai-trading-system/issues/617) is open the debate re-runs on every tick within a bar, so spend is strictly proportional to 1/τ. Anchored on measurement rather than estimate — **$0.878/day at τ = 15** — giving `C = 10.37 £·min/day` at 1.27 USD/GBP.

## Measuring the latency term

Latency costs money only if price **keeps moving adversely** after a signal fires. That is empirical, not a given: intraday equities are widely mean-reverting at short horizons, in which case waiting is free.

**Data.** SPY 1-minute SIP bars, 2024-08-01 → 2026-08-01 (195,188 in-session bars, regular US cash hours only) and BTC/USD 1-minute, 2025-08-01 → 2026-08-01 (486,209 bars), both from Alpaca's free tier.

**Conditioning event.** The state in which an indicator exit fires: a trailing 5-minute return of **−0.15% or worse**, which on a 3× ETP is −0.45%, approaching the −0.5% stop.

### Result 1 — the mean mean-reverts

SPY forward return after the trigger, n = 6,669:

| delay D | E[forward return] | t-stat |
| --- | --- | --- |
| 1 min | +0.0023% | 2.10 |
| 3 min | +0.0042% | 2.29 |
| 5 min | +0.0066% | 2.85 |
| 15 min | **+0.0210%** | **4.77** |

Positive and strongly significant. **Waiting produces a better exit price, not a worse one.**

It cuts both ways and cancels: for an **exit** latency is a small benefit, for a **dip entry** an equal-sized cost. At one entry and one exit per day the mean effect is ≈ 0.

> **On expected value there is no case for a faster tick at all.** A risk-neutral optimum is τ → ∞.

### Result 2 — the tail still diffuses

The mean reverts; the tail does not. Conditional overshoot (mean of the worst 5%), as % of position:

| D | 3× equity ETP | BTC |
| --- | --- | --- |
| 1 | −0.52% | −0.25% |
| 3 | −0.94% | −0.43% |
| 5 | −1.19% | −0.55% |
| 8 | −1.48% | −0.68% |
| 15 | −1.97% | −0.92% |

Both fit **g(D) = a·√D** to within **3.5%** across the whole range: `a = 0.525 %/√min` (3× equity), `0.243 %/√min` (BTC).

**This is the stop-fidelity number.** At τ = 15 a "−0.5% stop" actually delivers about **−2.4%** in the worst 5% of exits — roughly five times its intended size.

## Solving

With delay uniform on (0, τ), mean delay is τ/2, so tail cost per day for one leg is `N·K·λ·a·√(τ/2)` = `(N·K·λ·a/√2)·√τ`. The two legs carry **different** `a`, so B is their sum — at N = 1 exit per leg, K = £750 per leg, λ = 0.05:

| leg | `a` (%/√min) | `N·K·λ·(a/100)/√2` | £/√min |
| --- | --- | --- | --- |
| 3× equity ETP | 0.525 | 750 × 0.05 × 0.00525 / √2 | 0.139 |
| BTC | 0.243 | 750 × 0.05 × 0.00243 / √2 | 0.064 |
| | | **B** | **0.204** |

Both legs use the same λ = 0.05; only `a` differs between them. Re-derive B leg by leg when either `a`, K or λ changes.

```
dT/dτ = −C/τ² + B/(2√τ) = 0     ⇒     τ* = (2C/B)^(2/3)
```

**τ\* = (2 × 10.37 / 0.204)^(2/3) = 21.8 minutes.**

| τ (min) | LLM £/day | tail £/day | **total** | $/14d | % of cap |
| --- | --- | --- | --- | --- | --- |
| 1 | 10.37 | 0.20 | **10.57** | 184 | 369% |
| 2 | 5.19 | 0.29 | **5.47** | 92 | 184% |
| 4 | 2.59 | 0.41 | **3.00** | 46 | 92% |
| 5 | 2.07 | 0.46 | **2.53** | 37 | 74% |
| 10 | 1.04 | 0.64 | **1.68** | 18 | 37% |
| **15 (current)** | 0.69 | 0.79 | **1.48** | 12 | 25% |
| **21.8 (optimum)** | 0.47 | 0.95 | **1.43** | 8 | 17% |
| 30 | 0.35 | 1.12 | **1.46** | 6 | 12% |

Flat above 15, steep below. **τ = 2 nearly quadruples total cost; τ = 1 multiplies it by seven.**

**Robustness.** The optimum never falls below 15 under any tail definition, because `a` scales inversely with λ:

| tail used | τ\* |
| --- | --- |
| CVaR25 | 21.6 min |
| CVaR5 | 21.8 min |
| CVaR1 | 57.4 min |

**Independent hard floor.** Ignoring latency entirely, the ADR-0008 cap alone forbids **τ < 3.69 min** (`0.878 × 15 × 14 / 50`). Below that a fail-closed `SpendCap` halts debates part-way through the run.

## Conclusion

**While #617 is open, τ = 15 minutes stands and is already on the expensive side of optimal.** No arithmetic makes a faster tick pay: the mean favours waiting, the tail is cheap to insure against, and LLM cost is linear in 1/τ.

**After #617, `C` collapses to ≈ 0** — one run per bar, spend independent of τ — and `T(τ) = B·√τ` becomes monotonically increasing. The optimum then jumps to the **smallest τ the pass duration allows**: ~13s per run against `production.ts:986`'s dropped-tick guard means **τ = 1 minute**.

**The case for a fast tick is entirely a case for fixing #617.** Nothing else buys it.

## Limitations

- SPY is a **proxy for the underlying**, not for an LSE ETP's own tape — [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) established there is no free LSE intraday history. The 3× figures are SPY scaled by 3, which assumes perfect tracking and ignores the ETP's own spread.
- `a` is measured on unleveraged BTC; the crypto leg is unleveraged, so that one is direct.
- λ = 0.05 encodes a **risk-averse** objective. A risk-neutral reading of the same data says τ → ∞, which is why the choice of λ is stated rather than buried.
- The conditioning event is a proxy for "an indicator exit fires". A real indicator may select a different, more momentum-laden subset — this is the assumption most worth revisiting once the exit rule is specified ([#654](https://github.com/dd-jp/samurai-trading-system/issues/654)).
