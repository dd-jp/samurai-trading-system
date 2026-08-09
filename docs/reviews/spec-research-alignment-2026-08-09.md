# Spec-vs-research alignment — 2026-08-09

**Scope.** Every document in `docs/specs/` (21 files — 18 specs, `cross-spec-contracts.md`, and three dated `cross-verify-*.md` run records) and `CONTEXT.md`, read against the research corpus as consolidated on 2026-08-08 — specifically the Stage 0 layer that did not exist when the specs were written: [`10-edge-hypothesis.md`](../research/10-edge-hypothesis.md) (2026-08-07), [`11-trend-signal-measurement.md`](../research/11-trend-signal-measurement.md), [`12-edge-hypothesis-critique.md`](../research/12-edge-hypothesis-critique.md) (2026-08-08), [`13-stage2-proxy-verdict.md`](../research/13-stage2-proxy-verdict.md), [`15-crypto-premia-and-llm-layer.md`](../research/15-crypto-premia-and-llm-layer.md).

Two further 10s-band docs were read and produced no finding — recorded so the exclusion is deliberate rather than silent. [`16-risk-debate-finding.md`](../research/16-risk-debate-finding.md) feeds the Risk Manager wayfinder and predates this question. [`17-universe-manipulation-guardrails.md`](../research/17-universe-manipulation-guardrails.md) is already consumed by `universe-selector-spec.md:89`, which cites it by name; it constrains *which* names are eligible, an axis orthogonal to F7's question of what the universe is selected **for**.

**What this is not.** This is not a spec-vs-spec contract sweep — that register lives in [`../specs/cross-spec-contracts.md`](../specs/cross-spec-contracts.md) and its findings are not re-filed here. Note only that its "Confirmed clean — all spot-checked research-constraint compliance" line was issued **2026-07-14 against docs 00/01/02 only**. Docs 10–15 postdate it by three weeks and change the Stage 0 claim itself. The clean bill was correct when written and does not cover this axis.

**Headline.** The specs describe pipeline *machinery* in detail and never state a strategy. The strategy is implicit in the machinery — **the LLM debate generates the signal** — and that is precisely the claim docs 10 and 12 overturn. Doc 12's central finding ("the measured strategy has no implementation in `src/`") extends one layer up: **no spec would produce it either.** Every finding below is downstream of that one.

**Most findings here are decisions, not defects.** Per Standing Pipeline Rules 1 and 7 specs are synthesized from resolved wayfinder maps, so this review does not rewrite them. Doc 12 already names the correct instrument, and this review adopts its wording rather than inventing its own:

> **Gate 2 — Architecture ADR — is the measured strategy the thing we build?** Wayfinder map → ADR, per Standing Pipeline Rule 7. **Upstream of all validation spend.**

So: **yes, grilling tickets are needed.** Seven were opened on 2026-08-09 with one question each — the parent map [#631](../../issues/631), grilling tickets [#632](../../issues/632)–[#636](../../issues/636), and implementation ticket [#637](../../issues/637). [#633](../../issues/633) is contingent on [#631](../../issues/631) and should not be worked before it.

---

## Findings, ranked

### F1 — CRITICAL. `CONTEXT.md` carries an edge thesis that contradicts doc 10 on every axis, and still says the question is open

`CONTEXT.md:44–53` (line numbers here and throughout are as of this change) holds **"Samurai's Edge Thesis (Stage 0)"**, marked *"Status: PROPOSED, awaiting David's affirmation … treat as open until confirmed."* Doc 10 is that affirmation — recorded 2026-08-07, declaring Stage 0's exit condition **met**. `CONTEXT.md` was never updated, and the two theses are not variants of each other:

| Axis | `CONTEXT.md:49–50` | `10-edge-hypothesis.md` |
|---|---|---|
| Category | structural / information-processing — **explicitly "not risk-premium"** | **"the risk premium paid for bearing drawdown"** (Box 1) |
| Mechanism | parallel signal lenses through an adversarial Debate Engine | vol-targeted multi-asset premium harvest with a trend overlay |
| Role of the debate | **is** the edge | **"The multi-agent debate is not the edge"** (Consequence 1) |
| Status | open, awaiting affirmation | recorded, exit condition met |

This matters more than any single spec because `CONTEXT.md` is the invariants register CLAUDE.md sends every session to first, and specs cite it as the authority for sizing, drawdown and overfitting discipline.

**The fix is not to paste doc 10 over it.** Doc 12 contests doc 10's own framing — "we hold what others abandon under stress" is false of this machinery, since vol targeting de-levers *as* vol rises and trend exits *after* prices fall; the correct characterisation is Fung-Hsieh / Kaminski-Lo long-gamma, earning by *avoiding* drawdown rather than enduring it. So there are **three** live positions, not two. Choosing among them is a wayfinder decision.

**Direct edit applied:** `CONTEXT.md`'s thesis section now carries a pointer to docs 10 and 12 recording that a different thesis exists and the two are unreconciled. The thesis text itself is untouched.

---

### F2 — HIGH. No spec encodes the doc-10 strategy, and the pipeline's implicit one is the opposite

`trader-spec.md` is the nearest thing the repo has to a trading-algorithm spec, and its input is `DebateResult`: size scales with LLM conviction above a floor (stories 5–8), modulated by cosine retrieval and a convergence haircut. **The LLM generates; the mechanics translate.** Doc 10 Consequence 2 inverts this:

> **Veto-only is the design that makes the experiment cheap.** Trend generates, the LLM may only refuse.

**Stated precisely — the loose version is false.** The specs are not innocent of volatility or trend: `trader-spec.md:176` sizes as `size = (equity × risk_fraction) / (k × max(ATR, vol_floor))`, which scales position inversely with volatility, and `stage2-validation-execution-spec.md:28` specs a dual-SMA trend rule. What is absent across all of them is the three things doc 10's strategy is actually made of:

1. **Portfolio-level volatility targeting** — scaling total gross exposure to hit a target portfolio vol. Per-trade ATR sizing is not this; it never sees the portfolio.
2. **A trend signal that generates** — the dual-SMA rule exists only inside the Stage 2 proxy harness, never on the live path, where `DebateResult` is what reaches the Trader.
3. **Cross-asset inverse-volatility weighting** — the allocation across instruments that produces doc 10's effective-bets count. No spec allocates across instruments at all.

Doc 12 is precise where a looser reading would not be: "There is no vol targeting, no trend signal, and no inverse-vol weighting anywhere in the codebase." The same holds one layer up, in those three specific senses. The measured strategy has no spec, exactly as doc 12 found it has no code.

**Empirical corroboration already exists.** Open issue [#625](../../issues/625) measured 96 debates producing 0 trades — the stocks conviction ceiling is 0.5478 against a 0.55 floor, and debate rounds move conviction by zero. The generate-side of the LLM is not merely unproven as an edge; it is measurably not generating. A veto-only design would make that observation irrelevant rather than fatal.

This is doc 12's gate 2 and it is **upstream of all validation spend** — including any re-run of Stage 2.

---

### F3 — HIGH. MinBTL's trial headroom assumes a Sharpe of 1.0; at the only Sharpe the corpus has ever measured, it collapses 17×

`overfitting.ts:50` hardcodes `MINBTL_TARGET_ANNUAL_SHARPE = 1`, and MinBTL divides by that term **squared** (`:247`). Every trial-budget number the project has quoted inherits it. Doc 10's committed configuration measures **0.71**. Re-running the same function at that value:

| E[SR] | cap @ 1.99y | cap @ 5y | cap @ 10.2y |
|---|---|---|---|
| **1.00** (hardcoded) | 7 | 45 | **807** |
| **0.71** (doc 10, measured) | 3 | 10 | **48** |

The E[SR] = 1.0 row reproduces every published number exactly — the 7 that #405 sized the grid to, the spec's "~45 / 5 yr", and doc 13's 812-at-10.2y within window rounding. So the arithmetic is confirmed, and the substitution is the only thing changing.

**What this undermines.** Doc 13 closes with *"The harness is now good. MinBTL headroom is 812 configs against a fixed 12-config grid… whatever strategy is validated next, the machinery is no longer the limit."* At 0.71 the headroom is 48, not 812 — still comfortably above a 12-config grid, so the *proxy* verdict is unaffected, but "no longer the limit" is a 17× overstatement and would not survive a realistic grid for the doc-10 strategy. The gap is widest exactly where the next Stage 2 run will be planned.

**Why 1.0 is a defensible default and still worth revisiting.** MinBTL's E[SR] is the Sharpe you are *searching for* — the level at which you want the sample to distinguish skill from noise. Setting it to a strategy's realized Sharpe is not automatically correct. But a hardcoded constant chosen before any strategy was measured, whose only measured counterpart is 29% lower, should be a stated assumption rather than a private constant. `stage2-validation-execution-spec.md:169` is the only place it surfaces at all ("~45 at the reference 1.0 annual Sharpe target"), and `CONTEXT.md` never mentions it.

**This replaces an earlier F3 that was wrong**, recorded because the check that killed it is the reusable part. The claim was that `CONTEXT.md:59`'s "Sharpe ~1.5 live target" is the desire-driven target doc 10 forbids. Nothing in `src/` consumes it: both specs carrying it use it as one term in a *credible fingerprint* — "Sharpe ~1.5, maxDD ~20%, PF ~1.8, Calmar ~1.2 as reference; Sharpe > 3 non-HFT = red flag" (`feedback-loop-spec.md:234`, `cost-model-backtest-spec.md:366`) — which is an overfitting **detector**, not a search target, and `backtest_reference_sharpe` is fed from the frozen selected config at runtime (`stage2-selection.ts`). One residue: three Sharpe reference values coexist — 1.5 (fingerprint), 1.0 (MinBTL), 0.71 (measured) — and no document relates them.

Separately, doc 10 commits to a return target of **0.04%/day (~10%/yr)**. No spec states a return target at all, so there is nothing to contradict — but nothing to enforce either.

---

### F4 — HIGH. Stage 2 returned a terminal KILL and its own spec neither records it nor fired its escalation clause

`stage2-validation-execution-spec.md` is still **Status: Draft, Date: 2026-07-28**. Its story 14 asks for the verdict to be recorded. Line 171 says what happens on a kill:

> kill/rework → back to Stage 2 per the staged-deployment plan, and the in-flight Production Composition Root work **should be flagged, not silently continued past a failed gate**.

Doc 13 records the verdict: **KILL, terminal**, seven runs, 2026-07-29 to 2026-08-07, ending at PBO 0.35/0.40 against a 0.05 line and OOS 3/24 on a 10.2-year sample. The spec carries none of it, and the paper soak continued.

Two halves, deliberately separated:

- **Recording the verdict is a fact, not a decision** — applied as a direct edit below.
- **Whether the clause should now fire** — i.e. whether the soak is running past a failed gate — is a judgement call, and it is complicated by doc 13's own scope note: *"Do not cite this KILL as evidence against the hypothesis. It is evidence about a moving-average cross."* `CONTEXT.md:53` says the same thing and has said it since before the kill. **The two agree, and this is a confirmed-clean point, not a contradiction.** But it leaves Stage 2's gate genuinely unproduced for the strategy Samurai claims — which is F2's ticket, not a separate one.

---

### F5 — MEDIUM. The hard drawdown breaker trips inside the drawdown the strategy pre-accepts, and then needs a human

`CONTEXT.md:62` and `risk-manager-spec.md:170` both set the hard peak-to-trough breaker at **~20–25%**. Doc 10 commits to **−23% accepted in advance**, plus "multi-year stretches where nothing works."

A strategy whose *expected* path includes −23% trips a 20–25% breaker on a normal path, not an exceptional one. And `risk-manager-spec.md:51` makes resumption manual:

> As the Risk Manager, I want the hard max-drawdown breaker to require **manual re-arm**, so that resuming after a major loss is a deliberate human decision.

That collides with two things at once: **ADR-0007**'s fully-automatic posture (no human gate, paper or live), and doc 10's stated purpose for the machinery — "the machinery that makes holding through a −23% drawdown **automatic rather than a decision won against oneself at the worst moment**."

**Stated precisely, because the stronger version is wrong:** breakers **halt new entries, never exits** (`risk-manager-spec.md:15`). Nothing liquidates at the bottom. The cost is subtler — a premium harvest that de-levers into a drawdown depends on levering back in as vol falls, and a breaker that blocks new entries until a human re-arms it suppresses exactly that recovery leg. The threshold is a risk decision and the number lives in `CONTEXT.md`, so that is where a change would land.

---

### F6 — MEDIUM. The volatility halt is the specific mechanism doc 12 names as contradicting the thesis

Doc 12, on the surviving mechanism critique:

> It applies *a fortiori* to the live system, whose `breakers.ts` runs a **binary volatility halt** — the most extreme form of "abandon under stress" available.

`risk-manager-spec.md:170` specs it: a volatility halt, soft and per-asset-class, pausing new entries when realized/implied vol spikes above a baseline — complementing the Trader's vol-floor *sizing* with a hard *entry halt*. Under either doc 10's thesis (bear the drawdown) or doc 12's correction (long-gamma, avoid the drawdown) a **binary** halt is the wrong shape: the first wants no halt, the second wants a continuous de-lever, and vol targeting already provides one. Kept separate from F5 because it is a different mechanism with a different fix.

---

### F7 — MEDIUM. The universe work is specced for opportunity screening; doc 10 wants diversification

`universe-selector-spec.md` ranks a candidate pool to shortlist "names more likely to move" (`:182`). Doc 10 commits to something else:

> Universe widening from the current 6 symbols (**2.58 effective bets**) to the 12-instrument set (**4.60**). Universe selection moved the headline Sharpe by more than 2× — more than any signal decision tested.

Doc 10's basket is equity indices, bonds, gold, commodities and crypto-as-diversifier — chosen for low correlation, i.e. *effective bets*. A mover-screener maximises a different quantity and would not produce that basket. Both specs are internally coherent; they are solving different problems, and doc 10 says this axis mattered more than any signal decision tested.

---

### F8 — MEDIUM. No spec defines a benchmark, and doc 10 makes the benchmark choice load-bearing

The string `benchmark` appears **zero times** anywhere in `docs/specs/` — including `feedback-loop-spec.md` and `cost-model-backtest-spec.md`, the two that own the metrics suite. Doc 10:

> **The benchmark is always-long-the-same-basket at the same vol target, not SPY.** Nothing has beaten it in pre-registered trial accounting.

Doc 12's gate 4 adds outside benchmarks (SPY, 60/40) **risk-adjusted**, reporting return *and* drawdown together, keeping the matched control for attribution — and its D4 correction exists because return-only comparisons against a risk-targeted stream void with probability near 1. Meanwhile CLAUDE.md's Key Constraints say "win rate vs buy-and-hold," which is the return-only comparison D4 rules out. The metrics suite computes absolute metrics with nothing to beat.

---

### F9 — LOW. Three dated audit records sit in `docs/specs/`, which CLAUDE.md reserves for specs

`cross-verify-2026-07-26.md`, `-07-28.md` and `-07-31.md` (228 lines) are run records of Standing Pipeline Rule 7's cross-spec verification step. CLAUDE.md's Docs Convention table gives `docs/specs/` to "Synthesized specs (PRDs) per stage, `<stage>-spec.md`" and gives dated audit reports to `docs/reviews/` — which is exactly what these are. They are also the same shape the research corpus had before its 2026-08-08 consolidation: dated run-records shelved beside a living register (`cross-spec-contracts.md`). **Keep them** — four documents cite them, and they are the audit trail for GAP-1/2/3 — but the same treatment applies: move to `docs/reviews/`, or an `archive/` beside the register. Not done here; out of this change's scope, and it would move files four other documents link to.

---

### F10 — LOW. A live issue title carries a research moniker the renumbering changed

Open issue [#552](../../issues/552) is titled *"Wayfinder: MI rework — deterministic news ingestion, decoupled from LLM scoring **(doc 14)**"*. Under the 2026-08-08 scheme "doc 14" is [`14-backtest-pitfalls.md`](../research/14-backtest-pitfalls.md); the MI-alternatives document it means is now [`21-mi-ingestion-architecture.md`](../research/21-mi-ingestion-architecture.md). Issue titles are outward-facing and were not edited.

---

## Confirmed clean

- **MinBTL's per-window computation.** `cost-model-backtest-spec.md:71,267` cites "~45 / 5 yr" while doc 13 reports 812-config headroom at 10.2y, which looks like a stale constant. It isn't: `sizeTrialGridToSample` calls `minbtl(window)`, which inverts the López de Prado formula numerically per window (`trial-execution.ts:167–171`; `overfitting.ts:188–200`, whose docblock ends "The spec's calibration falls straight out: 5 years of data supports ~45 trials"). The spec's number is a derived illustration and 812 is the same function evaluated on a longer window. **No defect here** — F3 concerns the *E[SR] denominator* inside that function, which is a separate question and does not make the spec's constant wrong.
- **Proxy-kill scoping.** `CONTEXT.md:53` says the dual-SMA proxy's results "must never be read as evidence for or against this edge claim"; doc 13 says "Do not cite this KILL as evidence against the hypothesis." Written seven weeks apart, in agreement.
- **Drawdown magnitude.** `CONTEXT.md:62`'s 20–25% and doc 10's −23% are the same order and were derived independently. Only the breaker *behaviour* at that level is at issue (F5).
- **PBO 0.05.** Consistent everywhere — `CONTEXT.md:56`, `cost-model-backtest-spec.md:266`, `02-staged-deployment-plan.md`, doc 13's chain table. The pre-existing note that it is exposed as tunable config is already filed in `cross-spec-contracts.md:109` and is not re-filed.
- **Trader has no LLM.** `trader-spec.md`'s "mechanical backbone, NO Trader-side LLM" is unaffected by any of this — it is the Trader's *input* that F2 is about, not its determinism.

---

## Direct edits applied in this change

All are recordings of established fact, not decisions:

1. **`CONTEXT.md`** — the Stage 0 Edge Thesis section gains a status note that docs 10 and 12 record a different thesis, that the two are unreconciled, and that F1 here is the open item. The thesis text is unchanged.
2. **`stage2-validation-execution-spec.md`** — the terminal KILL is recorded against story 14, citing doc 13, with its scope note carried across so the verdict is not misread as a verdict on the Stage 0 hypothesis, and the MinBTL-812 figure carries F3's caveat inline. The header's Status/Date now say the spec was executed rather than still reading Draft 2026-07-28.
3. **`16-risk-debate-finding.md` and `17-universe-manipulation-guardrails.md`** — H1 titles still opened "# 05 —" and "# 07 —", their pre-consolidation numbers, missed by the 2026-08-08 rename sweep. Numbers dropped; slugs and content untouched.

## Tickets — opened 2026-08-09

One question each, per Standing Pipeline Rule 1. **[#631](../../issues/631) is the parent map and doc 12 places it upstream of all validation spend**; the rest are downstream of its answer.

| # | Ticket | The one question |
|---|---|---|
| **[#631](../../issues/631)** | **Wayfinder map: is the measured premium harvest the thing we build?** (doc 12 gate 2 — an architecture ADR) | Does the doc-10 strategy **replace** the LLM pipeline, **wrap** it (veto-only), or remain a research artifact while the pipeline stays the product? |
| [#632](../../issues/632) | Reconcile the Stage 0 edge thesis in `CONTEXT.md` | Of the three live framings — `CONTEXT.md`'s debate-as-edge, doc 10's bear-the-drawdown premium, doc 12's long-gamma avoid-the-drawdown correction — which one is the recorded thesis? |
| [#633](../../issues/633) | Signal generation: veto-only vs conviction-scaled — **contingent on [#631](../../issues/631)**, its parent | Does trend generate and the LLM only refuse (doc 10 Consequence 2), or does `DebateResult` stay the Trader's input (`trader-spec.md` stories 5–8)? If T1 answers "wrap (veto-only)", this is answered with it |
| [#634](../../issues/634) | Drawdown breaker threshold and re-arm | If −23% is pre-accepted, what should the hard breaker's level be, and may it re-arm without a human under ADR-0007? |
| [#635](../../issues/635) | Universe objective: effective bets vs movers | Does the Universe Selector target doc 10's 12-instrument diversified basket (4.60 effective bets), screen for movers, or both on separate paths? |
| [#636](../../issues/636) | Benchmark definition for the metrics suite | What does the system have to beat — always-long-same-basket at the same vol target, SPY/60-40 risk-adjusted, or both — and which spec owns computing it? |
| [#637](../../issues/637) | MinBTL's E[SR] denominator (F3) — an **implementation** ticket, not a grilling one, but the value is a judgement | Should `MINBTL_TARGET_ANNUAL_SHARPE` stay at 1.0, and either way should it become a stated, surfaced assumption rather than a private constant? |

Two rulings already recorded as OPEN in [`../research/README.md`](../research/README.md) — **tick cadence** (doc 10's daily vs ADR-0008's 15 minutes) and **"is Samurai commercial"** — are referenced, not re-litigated here. Cadence touches T1: doc 10 Consequence 3 argues a weeks-to-months harvest needs only a daily tick, which would cut LLM spend rather than raise it.
