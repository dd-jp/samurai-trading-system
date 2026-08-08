# Stage 0 — the edge hypothesis, recorded 2026-08-07

Closes the first gate of [`02-staged-deployment-plan.md`](02-staged-deployment-plan.md), open and unrecorded since the plan was written. Stage 0's own warning is the reason it matters: *"If you can't name it, you don't have a strategy — you have a curve fit."*

## Box 1 — the economic reason

> **Samurai's edge is the risk premium paid for bearing drawdown: we hold a diversified basket that other participants abandon under stress, and every mechanism in the system — volatility targeting, the trend overlay, the circuit breakers — exists to keep that position survivable rather than to predict prices.**

## Box 2 — the expectancy identity

`E[trade] = (P_win × Avg_win) − (P_loss × Avg_loss) − Costs`, accepted as the north star. Nothing to decide; recorded as acknowledged.

## Box 3 — market, horizon, strategy family

| | |
|---|---|
| Market | Diversified multi-asset basket — equity indices, bonds, gold, commodities, crypto as a diversifier |
| Horizon | Weeks to months |
| Family | Risk-premium harvest with a volatility-targeted trend overlay |
| Why the family applies | The premium is compensation for bearing drawdown; these markets pay long-run drift in exchange for periodic large drawdowns, which is precisely the risk being warehoused |

## Exit condition

*"You can explain your strategy's expected edge to someone else in under a minute, without referencing 'the bot runs all the time.'"* — met. The hypothesis never invokes continuous operation; cadence is an implementation detail, which is why the tick can fall to daily and cut LLM spend rather than being load-bearing.

## Why this hypothesis and not the others considered

Four candidates were drafted and three were dropped on evidence, not preference:

| Candidate | Outcome |
|---|---|
| **C1** — crypto liquidity provision into forced deleveraging | Dropped. 0.5% round-trip cost against an hours-horizon move requires capturing ~40% of the daily range per trade. Crypto is retained inside the basket as a diversifier instead. |
| **C2** — perpetual funding carry | Dropped. Needs a derivatives venue (ADR-0001 routes the MVP through Alpaca spot), and the FCA prohibits crypto derivatives to UK retail. |
| **E2** — overnight gap premium | Dropped. `time_in_force.stocks = 'day'` (`DEFAULT_TRADER_CONFIG` in `src/trader/types.ts`) leaves the overnight lot unprotected, and the premium itself is contested. |
| **E1** — conditional equity risk premium | **Adopted**, with its rationale rewritten — see below. |

An earlier candidate — that an LLM debate extracts signal from indicator conjunctions a fixed rule cannot — was not adopted because nothing in the system measures it. That remains untested rather than rejected; see "Consequences" below.

## Why E1's rationale changed

E1 was originally justified as *avoiding being timed out of the premium*. [Measurement](13-trend-signal-measurement-2026-08-07.md) killed that justification: over 10 years the trend overlay beats an always-long control by 0.17 Sharpe with a paired **t of 0.15**. The timing does not add return.

What survived is different and better evidenced. Under an executable gross cap of 1.5, trend beats the control on **both** return and drawdown — 10.20%/yr at Sharpe 0.71 and −23.2% max drawdown, against 6.18% at 0.41 and −34.0% — because it goes flat in bad regimes and stays off the cap while the control pins against it. The overlay is not a return generator; it is what lets a financed, capped account carry the premium at size instead of abandoning it at the bottom. That is what the recorded sentence says.

## What this commits to, and what it forbids

**Commits to:**
- **Target 0.04%/day (~10%/yr)** with a **−23% drawdown** accepted in advance, and multi-year stretches where nothing works.
- **The benchmark is always-long-the-same-basket at the same vol target**, not SPY. Nothing has beaten it in pre-registered trial accounting — the gross-cap-1.5 win above was found post-hoc, see "Status of the evidence".
- Universe widening from the current 6 symbols (2.58 effective bets) to the 12-instrument set (4.60). Universe selection moved the headline Sharpe by more than 2x — more than any signal decision tested.

**Forbids:**
- Any return target set from desire rather than measurement. A target manufactures the overfit; PBO 0.85 is what that looked like here.
- Treating a profitable period as confirmation. The hypothesis predicts *where* returns come from, and that is what gets checked.

## Consequences

1. **The multi-agent debate is not the edge.** This hypothesis does not require it. The system's justification is now either operational — the machinery that makes holding through a −23% drawdown automatic rather than a decision won against oneself at the worst moment — or experimental, as a measured test of whether LLM judgment adds anything against the control. Both are legitimate; neither is "the debate generates alpha."
2. **Veto-only is the design that makes the experiment cheap.** Trend generates, the LLM may only refuse. It bounds the damage, keeps the signal backtestable, supplies the trend-vs-debate counterfactual that does not exist today, and only bills a debate when trend has fired.
3. **Cadence is not load-bearing.** A weeks-to-months premium harvest needs a daily tick. That reduces LLM spend against ADR-0008's cap rather than raising it.
4. **Stage 2 becomes meaningful.** The proxy strategy should become this premium harvest rather than a moving-average cross, so a KILL says something about the thing actually intended for live capital.

## Status of the evidence

The measurement behind this is [13-trend-signal-measurement-2026-08-07.md](13-trend-signal-measurement-2026-08-07.md): 16 pre-registered configurations, MinBTL 3.2 years against a 10.0-year sample. **PBO is not computed and this is not a Stage 2 pass.** The leverage and gross-cap settings that produced the headline configuration were explored post-hoc and are explicitly outside the trial accounting. Stage 0 requires a *stated, falsifiable* hypothesis, not a validated one — that is Stage 2's job, and it is still open.
