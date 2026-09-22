# 71 — Debate audit: why bullish conviction capped at 0.473 (v2 Step 2)

**Date:** 2026-09-21 · **Ticket:** Refs #1743 (map #1706) · **Inputs:** doc 67 Step 2, doc 66 Q4/Q8/Q9/Q16, doc 65 §1
**Method:** offline replay of `debate_log` from the paper DB, opened read-only. No LLM calls, no paid data, no write to the DB.

## Verdict

**Not a formula defect.** The conviction formula is direction-symmetric, matches its spec, and reproduces every persisted score it can be checked against (76 of 76, exact). No production code is changed by this audit.

The 0.473 cap is an **input** fact, and it is narrower than "long setups are weak":

1. **Every one of the 16 bullish verdicts was issued on a desk that netted to zero** — technical bullish, fundamental bearish, sentiment absent. On that desk the formula cannot reach the floor in either era: at most 0.55 at perfect evidence before #683, at most 0.40 after. 0.4726 is `0.6 × 0.25 + 0.4 × 0.806`.
2. **On the 20 desks that did lean bullish, the mediator returned `neutral` 20 times out of 20.** Had it sided with the desk, 19 of those 20 would have scored 0.546–0.768 and cleared 0.55. On the 47 desks leaning bearish it sided with the desk 36 times. The gap holds at equal technical confidence (table below).
3. **The second voice on the desk is a bearish-skewed, low-confidence news-sentiment sign.** The fundamental analyst was bearish on 91 of 132 debates and opposed a bullish technical read on 52 of 72 desks, against 7 of 54 for a bearish one. Its mean confidence on captured rows is 0.13–0.22, but its vote counts the same as a 1.0-confidence technical vote.

So: the arithmetic is sound, and bullish *can* clear the floor whenever a bullish-leaning desk gets a bullish verdict. In v1's sample that combination never occurred. **STOP — David decides short-only vs veto-only** (doc 66 Q17). This audit does not take that decision; §7 lists what the evidence does and does not support.

## 1. The formula, traced

| Step | Where | What it does |
|---|---|---|
| Gate | `server/pipeline/trader/decide.ts:170` | `debate.confidence < config.conviction_floor` skips with `below_conviction_floor` (strict `<`) |
| Floor | `server/pipeline/trader/types.ts:41` | `conviction_floor: 0.55` |
| Score | `server/pipeline/debate-engine/conviction-score.ts:24` | `0.6 × directional + 0.4 × evidence`, clamped to [0, 1] (weights at `:5-6`) |
| Directional | `conviction-score.ts:41-61` | `abs(mean)` of analyst final positions on −1/0/+1, with the mediator verdict added as one more participant (`:57-60`) |
| #683 carve-out | `conviction-score.ts:53-55` | analysts' own mean exactly 0 ⇒ directional = 0, mediator excluded |
| Evidence | `conviction-score.ts:77-91` | over analysts not marked `NO DATA`: mean of `min(1, avg key points / 3)` and avg confidence |
| Stances never move | `server/apps/orchestrator/production/debate-adapter.ts:186-196` | each round's stance is `view.direction`, so "final position" is always the analyst's opening view (#625's "rounds moved conviction by zero") |
| Call site | `debate-adapter.ts:209` | `computeConvictionScore(context.views, accumulatedStances, response.stance)` |
| Analyst weights | `debate-adapter.ts:563-566`, `server/pipeline/debate-engine/weighted-conviction.ts:3-28` | persisted score is multiplied by weighted/unweighted agreement share; factor is 1 until the feedback loop first moved a weight on 2026-09-15 |
| Direction traded | `debate-adapter.ts:123`, `:231` | the mediator's `stance` — a neutral verdict is no trade whatever the score |

The spec (`docs/specs/debate-engine-spec.md`, "Conviction Score Algorithm") states the same rules, including NO-DATA analysts counting as neutral votes and the #683 carve-out. Code and spec agree. <!-- cite-exempt: historical — v1 record; the file was deleted per ruling G8 and is preserved at tag v1-final -->

`abs(mean)` has no sign dependence: a bullish desk and its mirror-image bearish desk score identically. With sentiment always absent (it was `NO DATA` on 132 of 132 debates), the best reachable directional term on either side is `(1 + 1 + 0 + 1) / 4 = 0.75`.

## 2. Replay

```
npx tsx server/tools/replay-debate-conviction.ts --db "file:/Users/ddjp/Documents/projects/samurai-trading-system/data/samurai-paper.sqlite?mode=ro"
```

(`npm run report:debate-conviction -- --db "<same URI>"` is the same command.) The script is `server/tools/replay-debate-conviction.ts`; it opens the store with `readonly: true, fileMustExist: true` and refuses any `file:` URI whose mode is not `ro`.

Two populations:

- **Exact (76 debates, 2026-09-03 onward).** `llm_call_log` captured the mediator prompt, whose context block carries the exact `AnalystView[]`. The script feeds those views to the production `computeConvictionScore`, applies the analyst weights in force at the debate's `created_at` (rebuilt from `dial_adjustments`), and compares with `debate_log.confidence` at 1e-9. **76 of 76 match.** Without the weight history 33 rows miss by the factors 0.9375–1.0313, which is how the weight step was found.
- **Implied (56 debates, before prompt capture).** Analyst confidences were not persisted, so the evidence term is backed out: `(confidence − 0.6 × directional) / 0.4`. All 56 land in [0, 1]. 10 of them do so only under the pre-#683 consensus — the zero-net desks with a directional verdict, all above the current formula's 0.40 ceiling. The last of those was written 2026-09-01T19:58Z, after the fix (e11ae6fe) merged at 11:03Z, so the soak process was still running the old build that day. No row is feasible under both eras with different values, so no implied evidence figure depends on guessing the era.

Output on the DB as of 2026-09-21 (267 rows, last debate 2026-09-18T19:58Z):

```
debate_log rows: 267
rows with no contributions (debate never ran; confidence 0): 135
debates that ran: 132
  bullish: n=16 mean=0.3851 max=0.4726 >= floor: 0
  bearish: n=42 mean=0.6698 max=0.7910 >= floor: 36
  neutral: n=74 mean=0.3749 max=0.6180 >= floor: 12

captured: 76 of 132
  persisted == current: 76
  persisted == pre-683-only: 0
  persisted == neither: 0
not captured: 56; implied evidence in [0,1] under current or pre-#683 consensus: 56; feasible only under pre-#683: 10; feasible under both with different values (evidence left unset): 0
```

Doc 67's "209 neutral" is 74 real neutral verdicts plus 135 rows where no debate ran (rate-limit, gate refusal or LLM failure: empty contributions, confidence 0).

| desk (final positions) | verdict | n | min | max | n ≥ 0.55 |
|---|---|---|---|---|---|
| technical=bearish fundamental=bearish | bearish | 29 | 0.6975 | 0.7910 | 29 |
| technical=bearish fundamental=bearish | neutral | 8 | 0.5325 | 0.5667 | 5 |
| technical=bearish fundamental=bullish | bearish | 6 | 0.2711 | 0.4663 | 0 |
| technical=bearish fundamental=bullish | neutral | 1 | 0.2428 | 0.2428 | 0 |
| technical=bearish fundamental=neutral | bearish | 7 | 0.5700 | 0.7000 | 7 |
| technical=bearish fundamental=neutral | neutral | 3 | 0.3834 | 0.4300 | 0 |
| **technical=bullish fundamental=bearish** | **bullish** | **16** | 0.2900 | **0.4726** | 0 |
| technical=bullish fundamental=bearish | neutral | 36 | 0.2252 | 0.3850 | 0 |
| **technical=bullish fundamental=bullish** | **neutral** | **11** | 0.5183 | 0.6180 | 6 |
| technical=bullish fundamental=neutral | neutral | 9 | 0.3960 | 0.5500 | 1 |
| technical=neutral, any | neutral | 6 | 0.2115 | 0.3910 | 0 |

(sentiment=neutral on every row; the script prints the full desk string.)

```
bullish verdicts: 16; on a desk netting to zero: 16
evidence strength on those rows: min 0.7053, max 0.8380
zero-net desk ceiling at evidence 1: pre-#683 0.5500, current 0.4000

technical=bullish, desk net bullish
desks: 20; mediator verdict bullish: 0; neutral: 20
conviction had the mediator sided with the desk: min 0.5460, max 0.7680, >= 0.55: 19 of 20

technical=bearish, desk net bearish
desks: 47; mediator verdict bearish: 36; neutral: 11
conviction had the mediator sided with the desk: min 0.5451, max 0.7910, >= 0.55: 46 of 47
```

| technical confidence | bullish-leaning desks | mediator sided | bearish-leaning desks | mediator sided |
|---|---|---|---|---|
| ≤ 0.40 | 13 | 0 | 20 | 10 |
| 0.40–0.75 | 4 | 0 | 13 | 12 |
| > 0.75 | 3 | 0 | 14 | 14 |

```
fundamental final position: bearish 91, bullish 21, neutral 20
technical=bullish desks: 72; fundamental agrees on 11, opposes on 52
technical=bearish desks: 54; fundamental agrees on 37, opposes on 7
bars debating more than one instrument: 34; fundamental headline line identical across every instrument on 15 of them
```

## 3. Reading the numbers

**The cap is one desk shape.** The bearish mean of 0.67 (doc 66 Q8's evidence) is the aligned desk plus an agreeing mediator: `0.6 × 0.75 + 0.4 × evidence`. The bullish 0.473 is the split desk. They are not the same measurement on two sides; they are two different desk shapes. The mirror-image rows exist: 6 bearish verdicts on a technical-bearish/fundamental-bullish desk scored 0.27–0.47, the same band as the 16 bullish rows.

**Where the asymmetry actually is.** (a) The fundamental analyst: `directionFrom` is the sign of mean item sentiment over a 24 h news window (`server/pipeline/analysts/intelligence-scoring.ts:4-16`, called from `fundamental-analyst.ts:24-36`). It came out bearish 69% of the time, and on 15 of 34 multi-instrument bars its headline line was identical across every instrument debated — a market-wide read, not a per-name one, on those bars. (b) The mediator: 0 of 20 against 36 of 47. The 13 captured bullish-leaning rows were checked against the raw `llm_call_log.response`: the model returned `"stance": "neutral"` each time, so this is model behaviour under the prompt at `server/pipeline/debate-engine/personas.ts:158-163`, not a parse fault. Its stated reasons on those rows are the low analyst confidences (technical capped at 0.4 by ADX, fundamental 0.13–0.19).

**What is *not* shown.** Nothing here measures whether long setups lose money. Zero bullish entries were taken, so there is no long P&L to judge. "The debate cannot go long" is established; "long setups are weak" is not.

**Design observations (not defects, not changed).** A 0.13-confidence fundamental vote cancels a 1.0-confidence technical vote exactly, and #683 then zeroes the consensus term. An absent sentiment analyst is excluded from evidence but still dilutes the consensus mean from a possible 1.0 to 0.75. Both are spec'd behaviour and symmetric in direction; either would be a new trial if changed.

## 4. Caveat — v1 conditions do not transfer to daily swing

The v1 debates ran on hourly decision bars (13:00/14:00/19:00Z) with the technical axes computed on **5-minute** bars, over US single stocks and index ETFs on Alpaca paper, flat by close, with a 24 h news-sentiment sign as "fundamental" and no sentiment input at all. v2's debate sleeve is one debate per name per day, pre-open, on daily bars, held days to weeks, with different debaters and a different judge (doc 66 Q9, Q16). A desk that cannot agree on a bullish 5-minute tape says little about a daily one. Any "long setups are weak" reading of this sample should not be carried into the daily swing design; the sample is also small (20 bullish-leaning desks, 3.5 weeks, one market regime).

## 5. Doc 65's scoreboard defects

Both figures are USD, not GBP — the book is Alpaca paper and the basis is `LIVE_BOOK_SIZING_USD` = 1,270.

**5a. The sign disagreement is a population difference, not an arithmetic error.** `SqliteArmComparisonSource.getClosedTradeWindowBetween` runs `oneSizingRegime` (`server/pipeline/control-arm/sqlite-arm-comparison-source.ts:117-139`), which drops every lot with a NULL `sizing_capital_ceiling` once any lot in the window declares one.

| control lots | n | sum `realized_pnl_net` | avg notional | closed |
|---|---|---|---|---|
| `sizing_capital_ceiling` NULL | 11 | **+1,038.17** | 5,278 | 09-03 → 09-04 |
| `sizing_capital_ceiling` = 1270 | 68 | **−239.09** | 839 | 09-08 → 09-18 |
| all (`closed_trades` sum) | 79 | +799.08 | | |

`−239.0936 / 1270 = −18.83%`, which is the stored `control_return_pct`. The 11 excluded lots were sized before the capital ceiling existed (#1112, migration 0045), off the raw ~$100k Alpaca paper equity, at ~$5,000 each — four times the declared book per position. MSTR (+518) and MARA (+351) alone are more than the whole +799. So `arm_comparison_samples` is the defensible number (one sizing regime, one basis); the `closed_trades` sum mixes two regimes 6× apart in notional and is dominated by two lots. The same filter explains the live arm: 4 lots, +10.42 in the sample against 7 lots, −112.49 in the table — the 3 dropped are the NULL-ceiling, `modelled_cost_charged = 0` lots.

**5b. Control-arm oversizing has three causes.**

1. *Before 2026-09-08:* no ceiling. `risk_log.equity` reads 99,877–123,476 and `per_trade_size_cap` (5% of equity, `server/apps/orchestrator/paper-profile.ts:181-183`) bound at ~$5,000.
2. *After:* the Trader sizes on the clamped $1,270 (`server/apps/orchestrator/production/direct-bind.ts:118-120`), purely by risk — `size = equity × riskFraction / stopDistance` (`server/pipeline/trader/build-bracket.ts:119`), with no notional cap. The Risk gate's notional caps still evaluate against raw account equity (`risk_log.equity` stays ~$100k; zero binding constraints from 09-08 on), and the D5 cash cap only arms for D5-classified instruments (`server/pipeline/risk-manager/index.ts:366-383`), which the US paper names are not. Nothing caps notional: 49 of 68 post-ceiling control lots exceed the $444.50 D5 index cap, and 14 exceed the entire $1,270 book (largest $2,826, QQQ on a 0.71% stop).
3. *The arms are not risk-matched.* Arm 2 passes the technical confidence as conviction and hard-codes `converged: true` (`server/pipeline/control-arm/axis-vote-decision.ts:25-30`). Joined to `trader_log`, control lots average conviction multiplier 0.853 with no haircut; live lots average 0.418 with the 0.5 non-converged haircut. The control risks ~4× the live arm per trade (average notional 839 vs 166). Return and drawdown comparisons between the arms are therefore sizing comparisons first.

The 50.2% control drawdown on the sample follows from (2) and (3).

## 6. Proposal — arm 2's entry rule for the daily swing horizon

Arm 2 exists to isolate one thing: what the LLM adds to the entry decision. Everything else must be identical to the debate arm.

- **Same candidates, same clock, same data cut.** For every name the screen hands the debate that morning, arm 2 decides at the same pre-open time from the same daily bars to the prior close.
- **Entry rule (deterministic, no LLM):** the existing axis vote (`assessAxes`: trend vs SMA, momentum RSI/MACD, participation, 20-bar Donchian structure, with the ADX/squeeze volatility gate) computed on **daily** bars. Enter at the next open in the vote's direction when net votes ≥ 3 of the available axes and the volatility gate has not capped confidence. One position per name.
- **Same exits as the debate arm:** the same broker-resting ATR stop and the same time stop (doc 66 Q9's ~10 days).
- **Same side rules:** whatever David rules for the debate sleeve (long/short, short-only, bounded shorts per Q8) binds arm 2 identically.
- **Identical fixed risk per trade.** Neither arm scales size by conviction or convergence; both use the same fixed fractional risk and the same notional cap, evaluated against the same sleeve book. This removes §5b cause 3 by construction.
- **Separate simulated book per arm, same starting capital** (Q14), one sizing regime per evaluation window.
- **Scoring:** paired by name-day; primary metric is the difference in mean R-multiple (P&L / initial risk), one-sided at 95% with the pre-declared minimum trade count (G1 proposes ≥ 100); return and max drawdown reported together as secondary. R-multiples keep a sizing fault from deciding the comparison again.
- **Pre-registered** before the first paper trade; any change to thresholds or axes is a new trial.

The thresholds (net ≥ 3, the ADX floor, the ATR multiple) are proposals for David's ruling, not decisions.

## 7. For David's decision

Doc 66 Q17 frames the no-defect branch as short-only vs veto-only. The evidence bearing on it:

- The formula does not block longs. A bullish-leaning desk with a bullish verdict clears the floor (19 of 20 counterfactually).
- In v1, no bullish-leaning desk ever got a bullish verdict, and the fundamental input opposed the technical read on 72% of bullish tapes. Both are properties of v1's inputs, prompt and model, all of which v2 replaces (Q9, Q16).
- No long trade was taken, so long-side profitability is unmeasured in either direction.
- The bearish side's 36 floor-clearing verdicts are real, but doc 65 already records that the resulting paper shorts are on a book the live product cannot trade.

Unverified by this audit: whether the mediator's neutrality on bullish desks would persist under Opus 5 as judge on daily bars. That needs LLM calls and is out of scope here.

## Reproduction notes

- Re-running after new debates land changes the counts; the DB's last debate at audit time was 2026-09-18T19:58:45Z (267 rows).
- §5's figures come from these read-only queries:
  `SELECT arm, sizing_capital_ceiling, COUNT(*), SUM(realized_pnl_net), AVG(entry*filled_size) FROM closed_trades GROUP BY 1,2;`
  `SELECT * FROM arm_comparison_samples ORDER BY computed_at DESC LIMIT 1;`
  `SELECT substr(created_at,1,10), binding_constraint, COUNT(*), MIN(equity), MAX(equity) FROM risk_log WHERE status='approved' GROUP BY 1,2;`
