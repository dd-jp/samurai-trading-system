# 62 — Rewrite Samurai as a safer profitable autonomous bot (ADRs ignored)

**Status:** COUNTERFACTUAL RESEARCH (2026-09-17) — **measures nothing, implements nothing.** Parent: [`~/Documents/Obsidian/research/samurai-rewrite-safer-bot-2026-09-17-report.md`](/Users/ddjp/Documents/Obsidian/research/samurai-rewrite-safer-bot-2026-09-17-report.md). Builds on [`61-five-topics-safest-max-profit.md`](61-five-topics-safest-max-profit.md).

**User instruction:** ignore Samurai spec and ADRs. From the five-topic research, rewrite the bot: safer + profitable + autonomous. Which strategies, what to modify, what to remove.

**This is a product fork, not a patch.** It contradicts ADR-0014 (flat-by-close), ADR-0016 (3× ETPs), ADR-0018 (intraday brackets), and the debate-as-edge thesis. Standing wayfinder rule still forbids `/implement` until David adopts it. Einstein does not write code.

**Label convention.** **[verified]** repo or fetched this week. **[inferred]** reading. **[assumed]** design choice.

---

## 1. Core idea

Current Samurai needs **53–59% same-session accuracy** on **3×** names after **16 bps/day**. Five-topic evidence says that shape is the *unsafe* one: Mesfin 2026 **0/14** OHLCV intraday-momentum families survived friction on MNQ **[verified: arXiv:2605.04004v3]**; documented momentum is **3–12 month** formation **[verified: Wikipedia Momentum investing]**; LLM debate has no demonstrated Sharpe **[inferred from doc 15 + #625]**.

**Rewrite:** weekly **time-series momentum, long or flat**, **1× liquid ETFs**, **vol-targeted size**, **hard DD kill**, **LLM veto/shadow only**. Overnight is *required* (that is where the premium lives). 3× same-day debate is deleted as the product.

Honest return band if it works: **Sharpe ~0.5–0.8 net**, not Medallion.

---

## 2. Strategies used (from the five)

| Research topic | In the rewrite |
|---|---|
| **Momentum** | **The edge.** Frozen lookback, `sign(excess return) > 0` → long, else flat. No quintile, no short. Weekly/monthly rebalance. |
| **Swing** | **Hold period of that trade** (days–weeks). Not a candle/swing-chart method. |
| **Medallion** | **Metaphor:** few independent *mechanical* sleeves; computer executes; no HFT clone. |
| **Vector DB** | **Keep SQLite cosine** as size haircut on labelled momentum setups. No Qdrant/Chroma/Pinecone. |
| **Candles** | **Unused.** |

**Three mechanical sleeves (Medallion-shape, retail N):**

1. TSMOM sign (return)
2. Vol target (risk)
3. Crash-brake: flatten/cut after violent 1-month drop + high vol (Daniel–Moskowitz crash, **[assumed]** rule, must be pre-declared)

LLM may **skip or haircut**, never originate, never add size.

---

## 3. Authority inversion

Today: Debate generates, Trader translates.

Rewrite: **sleeves generate → Trader sizes → Risk caps → Verdict/Exec.** Debate is optional veto. If Nous is down, **trade the sleeves**.

Cadence: **act weekly**; tick loop only **watches** breakers.

Universe: **8–15 liquid 1× ETFs**. No 3× wrappers.

---

## 4. Modify (existing)

| Existing | Modification |
|---|---|
| `server/pipeline/trader/` | Drive off sleeve outputs, not debate conviction. Vol-target size × cosine 0.5–1.5×. Multi-day stop, not ±2%/±6% same-session TP engine. |
| Orchestrator tick | Weekly act / daily watch. Kill 15-min debate-as-clock. |
| Technical analyst | Features for cosine + crash-brake. Stop treating RSI/MA vote as edge. |
| Debate engine | Veto/shadow. Fail-open to sleeves. |
| Risk manager | Recalibrate DD to unlevered ~20–25% kill. Deterministic crash-brake. Critic LLM veto-only or off. |
| `cosine_setups` | Re-feature: mom sign, vol regime, 1m market, spread. Label R of the *held* trade. k/θ **declared**. |
| Feedback loop | Labels only. **Forbidden** to search lookback/vol/crash on PnL. |
| Control arm | Always-long same basket + same vol-target (attribution); SPY 1× (capital). LLM-off vs LLM-veto shadow. |
| Universe pool | 1× liquid ETFs; spread/ADV screen. |
| Cost model | Weekly 1× tickets. |
| Flatten-by-close | Remove as strategy. Keep crash-restart tracking of overnight lots (ops). |
| Dashboard | Sleeve signs, vol, DD vs kill — not debate theatre. |

---

## 5. Remove

- Flat-by-close **as the product**
- 3× LSE ETP live universe
- Debate-as-edge / conviction-scaled **entries**
- Candle bull/bear cookbook
- Semantic vector-DB product
- 15-min LLM spend as trading clock
- Intraday frozen TP/SL as profit engine
- Tranche/scale-in theatre
- Crypto as live
- 7th invalidation stage (already declined — do not restore)
- Medallion/HFT/market-neutral clone

---

## 6. Keep (chassis)

Six-stage wiring, broker adapter, simulated broker, idempotency, reconcile, SQLite, injected clock, PBO/DSR/MinBTL **tools**, breakers, cosine *mechanism*, Nous client + spend cap (veto), UI, audit, dead-man, paper→tiny live, tax lots.

---

## 7. Safety stack

1× names · long/flat · vol target · declared crash-brake · hard DD kill (~−20%, human reset) · LLM cannot increase size · frozen lookbacks · matched control always on (return **and** DD).

---

## 8. What an implementing agent must not do

- Do not silently “amend” ADR-0014 in place. This is a **new product**; if adopted, it needs a new ADR and a wayfinder map.
- Do not fit N, vol-target, or crash threshold on the same sample used to ship.
- Do not add a vector-DB dependency.
- Do not keep 3× names “for more profit.”

**Access / license:** TSMOM is public-domain factor construction, not Medallion IP. Cosine code already in `server/pipeline/trader/`. Mesfin paper is a falsification of the *old* horizon, not a strategy to copy.

**Algorithm to reimplement:** binary TSMOM sign, long-only, weekly, vol-scaled. Strip rank/weight/short as doc 56 already said — but **drop the intraday bar**; that bar was the old product.

**Risks:** factor decay (McLean–Pontiff); 2022-style duration/trend drawdowns if bonds sneak in (they should not); GIA CGT on weekly turns; Saxo 16 bps may still be fat for 1× weekly — venue re-score needed; overnight gap on 1× is real, just not 3×.

**Source verification:** five-topic report + docs 11/15/56 + arXiv:2605.04004 + Wikipedia momentum/swing + trader cosine module. No new live measurement.

Trial count this doc adds: **0**. A future Stage 2 on this fork would pre-register lookback(s) and the crash-brake as **declared**, not searched.

---

## 9. Knowledge gaps before ship

1. Pre-registered weekly TSMOM on the **1×** universe, net UK costs, vs always-long and vs SPY. Doc 11 is closest, not this test.
2. Venue cost at weekly 1×.
3. Wrapper: GIA CGT vs any ISA-legal slow strategy (prior venue survey may flip if we are no longer day-trading).
4. PBO on the sleeve set.
