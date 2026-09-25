# Debate sleeve — spec (v2, Step 3)

Written in the step that builds it (doc 67 §4, Step 3). Authority: `docs/research/66-v2-grill-decisions.md` (Q2, Q8, Q9, Q14, Q16, Q17 verdict, G1, G4, G5, G16, G18), then `docs/adr/0001-samurai-v2.md` §5 for what is still open. Evidence: `docs/research/71-debate-audit.md`. Map: [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706); Step 3 ticket [#1744](https://github.com/dd-jp/samurai-trading-system/issues/1744).

## 1. What the sleeve is

One debate per screened name per trading day, pre-open, on daily bars to the prior close plus news; a swing hold (days to weeks) closed by a broker-resting ATR stop or a time stop. The cycle's `tradingDate` is the entry session: every read uses bars strictly before it, and a name whose last bar is more than five calendar days old is dropped (the coverage invariant, postmortem §2); the macro gate (§6) is keyed on the entry session. Long and short are each a counted trial against arm 2 (Q17 verdict, 2026-09-22). Judged by G1: ≥ 100 closed paper trades and a one-sided 95% test vs arm 2 before its 30% leaves cash.

Composition root: `server/apps/v2/index.ts`. The sleeve is `server/apps/v2/debate-sleeve.ts` and registers with one line in `composeV2Root` (`registry.register(debateSleeve)`). The momentum sleeve is **not registered** (§8).

## 2. Universe (G4 + G18)

Pool: current S&P 500 constituents (`data/bars/sp500-constituents.csv`, last row on or before the decision date) for the Alpaca leg. The LSE ETF leg of the pool is empty until Session B's LSE line table lands (doc 70 §10); the Saxo paper adapter is built and wired behind `venueFor`, which maps every name to Alpaca until an LSE line exists, so today no order can reach it — adding lines is a data change plus the venue mapping, and the adapter's half-spread lookup reads the Alpaca spread file until an LSE spread file exists.

Per day, at most 20 names:

| Half | Rule | Status |
|---|---|---|
| Liquidity core (~10) | Top 10 by 20-day average dollar volume over the pool, from the same daily bars the debate reads. | Ruled (G4). Built. |
| Movers/news (~10) | "The exact movers/news rule is a pre-declared parameter counted as a trial" (G4); the sentiment score helps pick (G18 1a). | **Unset — Needs David.** `G4_MOVERS_SELECTION_RULE` in `server/apps/v2/parameters.ts` throws `UnsetParameterError`; the root journals the refusal to `v2_refusals` and the cycle runs on the liquidity half alone. |

Small caps (G18 2): long-only, half a large-cap trade's risk, capped at a fixed share of the sleeve, a counted trial vs a large-cap-only shadow. The liquidity, price and market-cap floors and the cap are **unset — Needs David** (`G18_SMALL_CAP_FLOORS`); until set the pool is large caps only and the `large-cap-only` shadow book is identical to the primary by construction.

## 3. Inputs

- Daily bars (committed `data/bars/alpaca/*.csv` for the dry run; the same reader serves the paper run once a forward puller lands).
- Technical read: close vs 200-day SMA, 20- and 63-day trailing return, 20-day ATR — one `AnalystView` per name.
- News: Alpaca News (Benzinga) keyed on the US symbol (doc 69 R6). Class-wide roundups (> 5 tagged symbols) are never scored per name (G18 3). Not wired in the dry run (no keys needed for the dry run); the input slot exists on `DebateInputs.news`.
- Sentiment and social (G18 1): each a counted trial. Social source is **unset — Needs David** (`G18_SOCIAL_SOURCE`). Sentiment reuses the v1 analyst once #961's duplication rule is ruled — **unset** (`G18_SENTIMENT_DEDUP_RULE`). Both are journalled to `v2_refusals` every cycle (scope `parameter`, with every other unset cycle-level parameter: `ARM2_ENTRY_THRESHOLDS`, `ALPACA_SHORT_EQUITY_FLOOR_USD`, `DEBATE_RISK_FRACTION`, `DEBATE_TARGET_ATR_MULTIPLE`); the `no-sentiment` and `no-social` shadow books are identical to the primary until set.
- No account data or key ever enters an LLM request: prompts carry analyst views only (`renderMessageContent` in the debate core wraps context as untrusted text).

## 4. Debaters and judge (Q16, doc 69 R10)

Pinned in `server/apps/v2/models.ts`; a change to any element of a pin is a new trial.

| Seat | Wire id | Priced as | Route |
|---|---|---|---|
| Debater | `claude-sonnet-5` | `anthropic/claude-sonnet-5` | Anthropic Messages API, `anthropic-version: 2023-06-01` |
| Debater | `openai/gpt-5.5` | `openai/gpt-5.5` | OpenRouter, `provider: { allow_fallbacks: false, data_collection: 'deny' }`. OpenRouter lists no dated GPT-5.5 slug (listing checked 2026-09-25, `created` 2026-04-24); the pin is slug + that listing date, and every response's upstream `model` is logged so a silent swap is visible |
| Debater | `deepseek/deepseek-v4-pro-0813` | `deepseek/deepseek-v4-pro` | OpenRouter, same routing, never DeepSeek first-party (R10). Dated slug listed 2026-09-25 (`created` 2026-08-12); priced at the undated v4-pro rate the pricing table carries |
| Judge | `claude-opus-5` | `anthropic/claude-opus-5` | Anthropic Messages API |

Dated OpenRouter slugs were read from `https://openrouter.ai/api/v1/models` (`canonical_slug`) on 2026-09-25; the raw listing is kept in the session scratch (`openrouter-models.json`).

Roles rotate daily (Q16): the three debater providers rotate through the debate core's two debater seats (bull, bear) by day index — each provider sits out every third day and the bull/bear assignment flips every three days, so a provider argues the same side at most twice in a row (`rotateSeats` in `server/apps/v2/llm-panel.ts`); the seat models for the day are part of the decision's `inputs_hash`. The core (`runDebate`) has two debater seats and one mediator; a third simultaneous seat is follow-on work, recorded here rather than bolted onto the core.

In-flight cap: one call at a time per provider account (`NousAccountInFlightGate({ maxInFlight: 1 })`, per the per-account queue finding). Spend: `SqliteMonthlySpendCap` over `llm_spend`, $30 per calendar month (UTC), checked before every debate (so the overshoot is bounded by one debate's three calls), fail-closed on a read fault — a breach stops LLM calls, never exits.

## 5. Decision and sizing

- Direction: the judge's verdict (`DebateResult.direction`). Neutral = no entry. The judge's JSON carries no confidence, so the journalled confidence is derived: 0.5 when neither debater agrees with the judge, 0.75 when one does, 1.0 when both do (`judgeConfidence` in `server/apps/v2/debate-sleeve.ts`).
- Shorts: allowed by Q17/Q8 but built behind `SHORTS_ENABLED = false` until the Alpaca $2,000 equity floor is resolved (`ALPACA_SHORT_EQUITY_FLOOR_USD` unset — Needs David). A bearish verdict is journalled as `skipped:shorts_disabled`; when the flag turns on, a short's stop is price + 2 × ATR and the easy-to-borrow check (Q8) is still to build.
- Exit parameters (ADR §5 item 9): 20-day ATR × 2 resting stop, pre-declared here. The pre-declared choice was no target, but `BrokerAdapter.submitBracket` cannot express an entry with a stop and no target, so the target multiple is **unset — Needs David** (`DEBATE_TARGET_ATR_MULTIPLE`: a multiple makes it a bracket trial; "no target" means a stop-only order path is built in doc 67 Step 4). Until set, sized decisions are journalled and no order is submitted, in any mode. The stop leg is `gtc`, never `day`. The time stop needs positions and fills, which Step 3 does not read — Step 4.
- Size: fixed fractional risk at the stop distance, the fraction **unset — Needs David** (`DEBATE_RISK_FRACTION`; G18 (2) fixes only the ratio, small caps at half a large-cap trade's risk); until set every entry sizes to 0 and is journalled that way. Whole shares (doc 69 R2), capped at 10% of book equity notional (`server/apps/v2/position-size.ts`); × loss-budget multiplier (G6/G10, `LossBudget`, entries blocked → 0); × 0.5 on a macro day (§6). US prices convert to GBP at the 1 January GBPUSD fix (ruling (j), `server/apps/v2/fx.ts`).
- **Whole-share finding (2026-09-23 dry run, with 0.5% as the trial value):** at £1,000 of equity the risk budget is £5 per trade; every name in the S&P liquidity core (NVDA, AAPL, MSFT, META, TSLA, AMD, AVGO, MU, INTC, SNDK) has a 2-ATR stop distance above £5 per share, so all ten size to 0 shares and no entry is attempted. 0.5% was a build choice, since withdrawn into the parameter above — Needs David: the per-trade risk fraction, or a price screen (doc 69 R3's `price ≤ C/(5N)`) for the debate universe, or fractional shares where a venue-resting stop allows it.
- Cost model: Saxo 0.08%/side + half spread + 0.12%/yr custody (`server/pipeline/momentum/costs.ts`) in the simulated Saxo adapter; the Alpaca leg is the real Alpaca paper account, which applies its own fills and fees, so `alpacaFillCost` is not called here.

## 6. Macro gate (G16, doc 69 R17)

New entries at half size on FOMC decision days, US CPI, US Employment Situation, BoE MPC announcement days and UK CPI days — G16's five, nothing else. Exits unaffected. Table `server/apps/v2/macro-calendar.ts`, sources read 2026-09-25: Fed (`fomccalendars.htm`, 2026), BLS CPI and Employment Situation schedules (2026), BoE MPC dates (2026–2027), ONS release calendar (UK CPI; the Jul–Sep 2026 releases were not read and are absent, which only affects replay of those past dates). Fail-closed: if the table does not cover the next 30 days from the entry date, every day is a macro day and the reason is journalled — with the 2026 Fed and BLS schedules this begins on 2026-12-02, so the 2027 schedules are a data ship before then. Measured against the `no-macro-gate` shadow.

## 7. Books (Q14, G5, G16, G18)

Each sleeve has its own paper book at £1,000 start capital with its own `LossBudget`, rebuilt from `v2_book_days` on every start so a halt and the 1 January reference equity (ruling (j)) survive the once-a-day process. Shadow books run the same decisions with one input removed:

| Book | Sleeve | Differs from primary by |
|---|---|---|
| `debate/primary` | debate | — (primary) |
| `debate/no-macro-gate` | debate | no half-size on macro days (G16) |
| `debate/no-sentiment` | debate | sentiment input off (G18) |
| `debate/no-social` | debate | social input off (G18) |
| `debate/large-cap-only` | debate | small caps excluded (G18) |
| `momentum/no-veto` | momentum | Opus veto off (G5) — declared, not instantiated while momentum is unregistered |

Book marking in Step 3 is flat: each cycle marks every book at its previous equity with zero invested notional, so the custody accrual and the loss-budget steps are wired but only move once fills are reconciled into the books (doc 67 Step 4, protection before any paper trade). Calendar days between marks are computed and stored now so that reconciliation changes nothing upstream.

Arm 2 (doc 71 §6): same names, same clock, same exits, fixed risk; entry by axis vote with **thresholds unset — Needs David** (`ARM2_ENTRY_THRESHOLDS`). Until set, arm 2 journals a refusal per cycle and takes no decision.

## 8. Not wired, and why

- **Momentum sleeve:** doc 70 §9 — the US sub-book fails all four passes; the LSE sub-book is pending (Session B, ruling (m) 2026-09-25: if LSE fails, v2 is debate-only pending ruling). Nothing calls `server/pipeline/momentum/` from the v2 root except `LossBudget` and the cost functions, which the debate books reuse.
- **Shorts:** flag off (§5).
- **Live venues:** the root composes paper only; `SAMURAI_MODE=live` is refused.

## 9. Journal and replay

`v2_decisions` (one row per name per book per day with the input hash, verdict, size, reason), `v2_orders` (every would-be and actual order, with `dry_run` flag and outcome), `v2_book_days` (equity, YTD loss, size multiplier, custody accrual), `v2_refusals` (every unset-parameter or fail-closed refusal). LLM calls go to `llm_spend` and, with text capture on, `llm_call_log` (prompt and completion per call) with the pin's priced id. Replay: the decision row carries `inputs_hash` over the 200 bars read, the technical view and the day's seat models; re-running a day with the same bars and the journalled completions reproduces the same rows. A replay harness that feeds `llm_call_log` back through a transport is not built here.

## 10. Dry run

`node dist/server/apps/v2/index.js --dry-run --date YYYY-MM-DD` (built by `npm run build`; no keys). It writes to its own store (`data/samurai-v2-dry-run.sqlite` <!-- cite-exempt: untracked — gitignored runtime database -->, never the paper store). All brokers are `DryRunBrokerAdapter`, which records and refuses every submission (`v2_orders.outcome = 'refused_dry_run'`); LLM transports are `ScriptedTransport` with `BULLISH_SCRIPT` (every debater and the judge answer bullish) and every scripted call still lands in `llm_spend`. With `DEBATE_RISK_FRACTION` and `DEBATE_TARGET_ATR_MULTIPLE` unset the dry run journals ten bullish decisions at size 0 and attempts no submission; the broker-refusal path is exercised by `server/apps/v2/cycle.test.ts` with both injected. The exit code is non-zero if any order was submitted. `npm run smoke` also runs `server/apps/v2/smoke.ts`: the same cycle as a probe plus assertions on zero submitted orders, the registry contents, the pins, the monthly cap, the macro halving, the unset parameters and the shadow-book set. Outside a dry run the root refuses `SAMURAI_MODE=live` and refuses to start without non-empty `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` — a scripted verdict never reaches a broker. A cycle refuses to run a date any book has already marked, before any LLM call.
