# Debate sleeve — spec (v2, Step 3)

Written in the step that builds it (doc 67 §4, Step 3). Authority: `docs/research/66-v2-grill-decisions.md` (Q2, Q8, Q9, Q14, Q16, Q17 verdict, G1, G4, G5, G16, G18), then `docs/adr/0001-samurai-v2.md` §5 for what is still open. Evidence: `docs/research/71-debate-audit.md`. Map: [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706); Step 3 ticket [#1744](https://github.com/dd-jp/samurai-trading-system/issues/1744).

## 1. What the sleeve is

One debate per screened name per trading day, pre-open, on daily bars to the prior close plus news; a swing hold (days to weeks) closed by a broker-resting ATR stop or a time stop. The cycle's `tradingDate` is the entry session: every read uses bars strictly before it, and a name whose last bar is more than five calendar days old is dropped (the coverage invariant, postmortem §2); the macro gate (§6) is keyed on the entry session. Long and short are each a counted trial against arm 2 (Q17 verdict, 2026-09-22). Judged by G1: ≥ 100 closed paper trades and a one-sided 95% test vs arm 2 before its 30% leaves cash.

Composition root: `server/apps/v2/index.ts`. The sleeve is `server/apps/v2/debate-sleeve.ts` and registers with one line in `composeV2Root` (`registry.register(debateSleeve)`). The momentum sleeve is **not registered** (§8). The cycle (`server/apps/v2/cycle.ts`) runs once per trading date: sweep fills → decide → per book cancel stale entries, exits, entries → sweep fills → mark every book.

## 2. Universe (G4 + G18)

Pool: current S&P 500 constituents (`data/bars/sp500-constituents.csv`, last row on or before the decision date), all on the Alpaca leg (`venueFor` maps every name to Alpaca). The LSE ETF/ETC leg is empty until the Saxo paper adapter is built over the 22 committed LSE lines (doc 70 §10.4; ruled 2026-09-25, doc 66, ADR §5 item 13); no Saxo adapter is built in this step (§7).

Per day, at most 20 names:

| Half | Rule | Status |
|---|---|---|
| Liquidity core (~10) | Top 10 by 20-day average dollar volume over the pool, from the same daily bars the debate reads; ties break alphabetically. | Ruled (G4). Built (`liquidityCore`). |
| Movers (~10) | **Pre-declared (trial T1, §5):** from the pool minus the liquidity core, the 10 names with the largest absolute prior-day close-to-close return, among names whose prior-day dollar volume (raw close × volume) is ≥ $50M (`MOVERS_MIN_DOLLAR_VOLUME_USD`); ties break alphabetically. Rationale: "movers" is the one reading of G4's wording that needs no input beyond the bars the debate already reads, so it is falsifiable today; the $50M floor is this sleeve's own choice, not borrowed from doc 70 (which sets no ADV floor): the largest order §5 produces is ~£100 of notional, so the floor is there only to keep anomalous thin prints (a halted or delisting name whose one-day return is an artefact) out of the top-10 ranking, not to protect fills. G18 1a's sentiment-assisted pick is a later trial once a sentiment writer exists (§3). | Built (`selectMovers`), counted as trial T1. |

Small caps (G18 2): long-only, half a large-cap trade's risk, capped at a fixed share of the sleeve, a counted trial vs a large-cap-only shadow. The liquidity, price and market-cap floors and the cap are **unset — Needs David** (`G18_SMALL_CAP_FLOORS`, #1753); until set the pool is large caps only, journalled every cycle as a `universe` refusal, and the `large-cap-only` shadow is not instantiated (§7).

## 3. Inputs

- Daily bars (committed `data/bars/alpaca/*.csv` for the dry run; the same reader serves the paper run once a forward puller lands).
- Technical read: close vs 200-day SMA, 20- and 63-day trailing return, 20-day ATR — one `AnalystView` per name.
- News: Alpaca News (Benzinga) keyed on the US symbol (doc 69 R6), wired in `server/apps/v2/news.ts` over the existing `AlpacaNewsClient` (`server/providers/market-intelligence/sources/alpaca-news-client.ts`, free on the Alpaca keys). Window: from 00:00Z of the calendar day before the entry session to now; articles tagged with more than 5 symbols are class-wide roundups and are dropped (G18 3); the last 10 headlines per name become one neutral `news` `AnalystView` (`newsView`) next to the technical view, so both debaters and the judge read them, and the headlines are part of the decision's `inputs_hash`. A news fetch failure skips the name (`news_error:…`) rather than debating on stale inputs. The dry run uses `NO_NEWS` (no keys); the paper run needs `ALPACA_API_KEY`/`ALPACA_API_SECRET`, which it already needs for the broker.
- Sentiment and social (G18 1): each a counted trial. Social source is **unset — Needs David** (`G18_SOCIAL_SOURCE`, #1753). Sentiment reuses the v1 analyst once #961's duplication rule is ruled — **unset** (`G18_SENTIMENT_DEDUP_RULE`). Both are journalled to `v2_refusals` every cycle (scope `parameter`, with the other unset cycle-level parameters `ARM2_ENTRY_THRESHOLDS` and `ALPACA_SHORT_EQUITY_FLOOR_USD`); the `no-sentiment` and `no-social` shadows are not instantiated until the input they remove exists (§7).
- No account data or key ever enters an LLM request: prompts carry analyst views only (`renderMessageContent` in the debate core wraps context as untrusted text).

## 4. Debaters and judge (Q16, doc 69 R10)

Pinned in `server/apps/v2/models.ts`; a change to any element of a pin is a new trial.

| Seat | Wire id | Priced as | Route |
|---|---|---|---|
| Debater | `claude-sonnet-5` | `claude-sonnet-5` ($2 / $10 per Mtok in/out, Anthropic list rate) | Anthropic Messages API, `anthropic-version: 2023-06-01` |
| Debater | `openai/gpt-5.5` | `openai/gpt-5.5` | OpenRouter, `provider: { allow_fallbacks: false, data_collection: 'deny' }`. OpenRouter lists no dated GPT-5.5 slug (listing checked 2026-09-25, `created` 2026-04-24); the pin is slug + that listing date, and every response's upstream `model` is logged so a silent swap is visible |
| Debater | `deepseek/deepseek-v4-pro-0813` | `deepseek/deepseek-v4-pro` | OpenRouter, same routing, never DeepSeek first-party (R10). Dated slug listed 2026-09-25 (`created` 2026-08-12); priced at the undated v4-pro rate the pricing table carries |
| Judge | `claude-opus-5` | `claude-opus-5` ($5 / $25 per Mtok, Anthropic list rate) | Anthropic Messages API |

Dated OpenRouter slugs were read from `https://openrouter.ai/api/v1/models` (`canonical_slug`) on 2026-09-25; the raw listing is kept in the session scratch (`openrouter-models.json`). Anthropic calls are first-party, so `server/shared/llm/pricing.ts` carries the bare ids at list rate (Opus 5 $5/$25, Sonnet 5 $2/$10 per Mtok, per the Claude API model-migration reference read 2026-09-25); the `anthropic/…` Nous-discounted rows stay for the v1 Nous path only. A response whose upstream `model` differs from the pin's wire id is refused (`LlmProviderError`, `raiseForUpstreamModel` in `server/apps/v2/llm-transport.ts`) and the debate for that name is journalled as `llm_error`, so a silent provider swap cannot produce a decision.

Roles rotate daily (Q16): the three debater providers rotate through the debate core's two debater seats (bull, bear) by day index — each provider sits out every third day and the bull/bear assignment flips every three days, so a provider argues the same side at most twice in a row (`rotateSeats` in `server/apps/v2/llm-panel.ts`); the seat models for the day are part of the decision's `inputs_hash`. The core (`runDebate`) has two debater seats and one mediator; a third simultaneous seat is follow-on work, recorded here rather than bolted onto the core.

In-flight cap: one call at a time per provider account (`NousAccountInFlightGate({ maxInFlight: 1 })`, per the per-account queue finding). Spend: `SqliteMonthlySpendCap` over `llm_spend`, $30 per calendar month (UTC), checked before every debate (so the overshoot is bounded by one debate's three calls), fail-closed on a read fault — a breach stops LLM calls, never exits.

## 5. Decision, sizing and the pre-declared trial register

- Direction: the judge's verdict (`DebateResult.direction`). Neutral = no entry. The judge's JSON carries no confidence, so the journalled confidence is a pre-declared mapping (trial T5): 0.5 when neither debater agrees with the judge, 0.75 when one does, 1.0 when both do (`JUDGE_CONFIDENCE_BY_AGREEING_DEBATERS` in `server/apps/v2/debate-sleeve.ts`). It is journalled, never used for sizing or entry, so a different mapping changes rows, not trades.
- Shorts: allowed by Q17/Q8 but built behind `SHORTS_ENABLED = false` until the Alpaca $2,000 equity floor is resolved (`ALPACA_SHORT_EQUITY_FLOOR_USD` unset — Needs David, doc 66 Q8). A bearish verdict is journalled as `skip:shorts_disabled`; when the flag turns on, a short's stop is price + 2 × ATR, its target price − 3 × ATR, and the easy-to-borrow check (Q8) is still to build.
- Exits (ADR §5 item 9), all pre-declared here and counted: a resting stop at 2 × ATR(20) (trial T2, `STOP_ATR_MULTIPLE`, the same stop doc 70 §2.9 pre-declared for momentum); a bracket target at 3 × ATR(20) (trial T3, `DEBATE_TARGET_ATR_MULTIPLE = 3`: 1.5R against the 2-ATR stop, so the trade pays at 40% accuracy before costs, and `submitBracket` cannot express a stop-only entry, so a target is the shape the venue path already supports); a time stop after 10 marked sessions (trial T4, `DEBATE_TIME_STOP_TRADING_DAYS = 10`, the "e.g. 10 days" doc 66 Q9 wrote down for the swing hold), submitted as a flatten through the book's broker at the 11th cycle. Every leg is `gtc`, never `day`.
- Size: fixed fractional risk at the stop distance, **pre-declared at 0.5% of book equity per trade (trial T0, `DEBATE_RISK_FRACTION = 0.005`).** Source: G6's £1,500/yr loss budget on £1,000 and its 1.0% daily cap (£10) — at 0.5% a day's two full stop-outs sit exactly on the daily cap, and the −£500 half-size step is 100 consecutive full stop-outs away, which is the loosest fraction that keeps one bad day inside G6; G18 (2) then fixes small caps at half of it (0.25%). Whole shares (doc 69 R2), capped at 10% of book equity notional (`server/apps/v2/position-size.ts`); × the loss-budget multiplier from the previous mark (G6/G10, `LossBudget`, entries blocked → 0); × 0.5 on a macro day (§6). US prices convert to GBP at the 1 January GBPUSD fix (ruling (j), `server/apps/v2/fx.ts`).
- **Whole-share finding — Needs David (stays his whatever the fraction).** Measured at the old £1,000 start capital; re-measure at £2,000 in #1771. At 0.5% and £1,000 the risk budget is £5 per trade and a 2-ATR stop distance above £5 per share sizes to 0. Measured 2026-09-25 over `data/bars/alpaca` with the 20-day ATR at the 2026-09-24 close, £1,000 equity, the 10% notional cap and GBPUSD 1.34: **211 of 503** S&P names size to ≥ 1 share at 0.5% (239 of 503 at 1%); every name in the liquidity core (NVDA, MU, SNDK, META, AAPL, TSLA, AMD, MSFT, INTC, AVGO) sizes to 0 at either. The 2026-09-24 dry run confirms it: 20 names debated, 1 (PAYX) sized to 1 share, 19 sized to 0. Options for David: a price screen on the debate universe (doc 69 R3's `price ≤ C/(5N)`), fractional shares where a venue-resting stop allows them, or accepting that the sleeve trades the cheaper half of the pool.
- Cost model: the Alpaca leg is the real Alpaca paper account, which applies its own fills and fees; simulated books (every shadow, and the primary in a dry run) fill at the decision price ± half the measured spread (`DryRunBrokerAdapter`, `data/bars/alpaca-spreads.csv`, default 5 bps). The Saxo tariff (0.08%/side, 0.12%/yr custody) stays in `server/pipeline/momentum/costs.ts`; `saxoCustodyAccrual` is charged on Saxo-venue invested notional at each mark, which is £0 until an LSE line exists.

### Trial register

Every value below is a counted trial from #1 (ADR §5 item 9). Changing any value is a new row, not an edit.

| # | Parameter | Value | Where | Source |
|---|---|---|---|---|
| T0 | `DEBATE_RISK_FRACTION` | 0.005 of book equity per trade | `server/apps/v2/parameters.ts` | G6 arithmetic above |
| T1 | Movers rule | top 10 by \|prior-day return\|, ADV ≥ $50M, pool minus liquidity core | `selectMovers`, `MOVERS_MIN_DOLLAR_VOLUME_USD` | G4; floor is the sleeve's own, doc 70 sets none |
| T2 | Stop | entry ∓ 2 × ATR(20) | `STOP_ATR_MULTIPLE` | doc 70 §2.9 stop design |
| T3 | `DEBATE_TARGET_ATR_MULTIPLE` | 3 × ATR(20) (1.5R) | `server/apps/v2/parameters.ts` | this spec |
| T4 | `DEBATE_TIME_STOP_TRADING_DAYS` | 10 marked sessions | `server/apps/v2/parameters.ts` | doc 66 Q9 |
| T5 | Judge confidence mapping | 0.5 / 0.75 / 1.0 by agreeing debaters | `JUDGE_CONFIDENCE_BY_AGREEING_DEBATERS` | this spec (journal only) |
| T6 | Macro gate | half size on G16's five release days | `MACRO_DAY_SIZE_FRACTION` | G16 |

## 6. Macro gate (G16, doc 69 R17)

New entries at half size on FOMC decision days, US CPI, US Employment Situation, BoE MPC announcement days and UK CPI days — G16's five, nothing else. Exits unaffected. Table `server/apps/v2/macro-calendar.ts`, sources read 2026-09-25: Fed (`fomccalendars.htm`, 2026), BLS CPI and Employment Situation schedules (2026), BoE MPC dates (2026–2027), ONS release calendar (UK CPI from 2026-10-21 on; the Jul–Sep 2026 releases could not be retrieved from the ONS calendar on 2026-09-25, so the table's UK CPI coverage is forward-only — a replay of July–September 2026 under-gates those three days and is not a valid macro-gate comparison). Fail-closed: if the table does not cover the next 30 days from the entry date, every day is a macro day and the reason is journalled — with the 2026 Fed and BLS schedules this begins on 2026-12-02, so the 2027 schedules are a data ship before then. Measured against the `no-macro-gate` shadow.

## 7. Books, fills and exits (Q14, G5, G16, G18)

Each instantiated book is a paper book at £1,000 start capital (ruled £2,000 on 2026-09-25, doc 66; code change #1771) with its own cash (`v2_books.cash_gbp`), positions (`v2_positions`) and `LossBudget`, rebuilt from `v2_book_days` on every start so a halt and the 1 January reference equity (ruling (j)) survive the once-a-day process. A shadow book runs the same decisions with one input removed; a shadow that would be a byte-identical copy of the primary is **not instantiated**, because it would burn LLM spend and prove nothing:

| Book | Sleeve | Differs from primary by | Status |
|---|---|---|---|
| `debate/primary` | debate | — | instantiated |
| `debate/no-macro-gate` | debate | no half-size on macro days (G16) | instantiated |
| `debate/no-sentiment` | debate | sentiment input off (G18) | declared, not instantiated: there is no sentiment input to remove until `G18_SENTIMENT_DEDUP_RULE` is set (#961) |
| `debate/no-social` | debate | social input off (G18) | declared, not instantiated: no social input until `G18_SOCIAL_SOURCE` is set (#1753) |
| `debate/large-cap-only` | debate | small caps excluded (G18) | declared, not instantiated: the pool is large-cap only until `G18_SMALL_CAP_FLOORS` is set (#1753) |
| `momentum/no-veto` | momentum | Opus veto off (G5) | declared, not instantiated; momentum dropped (§8), row to be removed |

`BOOK_SPECS` in `server/apps/v2/books.ts` carries all six with an `instantiated` flag; flipping a flag is the whole change once the input exists.

**Brokers per book.** The primary submits to the real Alpaca paper account (`AlpacaBrokerAdapter` over `AlpacaHttpBrokerClient`, bracket state in `broker_brackets` via `SqliteBrokerStateStore` so a resting bracket is rehydrated by the next day's process). Every shadow, and the primary in a dry run, submits to one shared `DryRunBrokerAdapter`, which refuses the submission (so nothing rests anywhere) and queues a simulated fill at the decision price ± half the measured spread, returned by `fetchNewFills` in the same cycle. Fills are routed to books by their deterministic client order id (`v2-<book>-<date>-<instrument>[-exit]`), journalled to `v2_fills` (idempotent on the broker fill id) and applied to cash and positions; so both a real fill and a simulated one move a book the same way, and the loss budget, the daily cap and the custody accrual move with them (tested: a losing fill sequence steps the primary to half size at −£500, quarter at −£1,000, halt at −£1,500).

**Marks.** Each cycle marks every book at the last daily bar strictly before the entry session (or at the entry price if no bar), after the day's submissions, so a crash between submit and mark leaves the date unmarked and the retry idempotent (an entry whose order id is already journalled, or whose name is already held, is not resubmitted). A date any book has already marked is skipped with a `cycle` refusal row, not re-run.

**Exits.** Real broker (primary in paper mode): the stop and target rest at Alpaca as bracket legs, their fills arrive through `fetchNewFills` on later cycles; the time stop submits a flatten (`submitFlatten`) once a position has been marked `DEBATE_TIME_STOP_TRADING_DAYS` times, the pending exit id is stored on the position and `resumeFlatten` is called each cycle until its fill arrives. Simulated books: the bracket is evaluated on the prior daily bar each cycle — stop first (conservative: a bar touching both legs is a stop-out), then target — filled at the leg price; the time stop flattens at the mark ± half spread. An entry submitted to Alpaca that has not filled by the next cycle is cancelled and journalled `cancelled`. Nothing in Step 3 sits above an exit: refusals gate entries only.

**Deferred to doc 67 Step 4** (exactly): (1) comparability — the primary's Alpaca fills are intraday limit/stop fills while shadows fill on daily bars, so primary-vs-shadow differences carry an execution term the shadow cannot see; a same-bar simulated twin of the primary is Step 4's fix; (2) partial fills — `qty_is_cumulative` fills are applied as-is, which is right for a single fill and wrong for a multi-fill leg; (3) a position whose Alpaca bracket legs were cancelled outside the system (the adapter's rearm path exists but is not called from the cycle); (4) the Saxo paper adapter — built in the step that first routes an LSE order, with the tariff constants already in `server/pipeline/momentum/costs.ts`.

Arm 2 (doc 71 §6): same names, same clock, same exits, fixed risk; entry by axis vote with **thresholds unset** (`ARM2_ENTRY_THRESHOLDS`): a session proposes a pre-declared rule and David approves it (doc 66, 2026-09-25; #1773). Until set, arm 2 journals a refusal per cycle and takes no decision.

## 8. Not wired, and why

- **Momentum sleeve:** doc 70 §9 — the US sub-book fails all four passes; the LSE sub-book fails too (doc 70 §10); David dropped momentum on 2026-09-25 (doc 66, Session B (n)), so v2 is debate-only. From `server/pipeline/momentum/` the root imports only `LossBudget`, `saxoCustodyAccrual`, `wholeShares`, `averageTrueRange`, `trailingReturn`, `assertSortedUniqueDates` and the bar types.
- **Shorts:** flag off (§5).
- **Saxo:** no adapter (§7).
- **Live venues:** the root composes paper only; `SAMURAI_MODE=live` is refused.

What the root imports from v1: `runDebate` and the three personas plus `AnthropicLlmClient`/`SqliteLlmSpendStore` from `server/pipeline/debate-engine/`; `AlpacaBrokerAdapter`, `AlpacaHttpBrokerClient`, `SqliteBrokerStateStore` from `server/pipeline/execution/`; `AlpacaNewsClient` from `server/providers/market-intelligence/sources/`; `NousAccountInFlightGate` and the pricing table from `server/shared/llm/`; `openSharedStore`/`guardedStore` from `server/shared/store/`. Nothing else.

## 9. Journal and replay

`v2_decisions` (one row per name per book per day with the input hash, verdict, size, stop, reason), `v2_orders` (every order — entry or exit, real, simulated, refused, rejected or cancelled — with its book, leg, side, `dry_run` flag, outcome and payload), `v2_fills` (every fill, real or simulated, keyed by venue and broker fill id), `v2_positions` (open positions per book with stop, target, pending exit id and marks held), `v2_book_days` (equity, cash, invested, YTD loss, size multiplier, custody accrual, recorded-at), `v2_refusals` (every unset-parameter, fail-closed or skipped-date refusal). The `v2` store handle is the sole writer of these seven tables (`server/shared/store/write-guard.ts`). LLM calls go to `llm_spend` and, with text capture on, `llm_call_log` (prompt and completion per call) with the pin's priced id. Replay: the decision row carries `inputs_hash` over the 200 bars read, the technical and news views and the day's seat models; re-running a day with the same bars, headlines and the journalled completions reproduces the same rows. A replay harness that feeds `llm_call_log` back through a transport is not built here.

## 10. Dry run

`node dist/server/apps/v2/index.js --dry-run --date YYYY-MM-DD` (built by `npm run build`; no keys). It writes to its own store (`data/samurai-v2-dry-run.sqlite` <!-- cite-exempt: untracked — gitignored runtime database -->, never the paper store). Every book submits to the `DryRunBrokerAdapter`, which refuses every submission (`v2_orders.outcome = 'refused_dry_run'` for the primary, `'simulated'` for the shadow) and simulates the fill; LLM transports are `ScriptedTransport` with `BULLISH_SCRIPT` (every debater and the judge answer bullish) and every scripted call still lands in `llm_spend` and `llm_call_log`; news is `NO_NEWS`. **2026-09-24 run (this build):** 20 decisions, 2 entries (PAYX, 1 share, in each book), 1 dry-run refusal, 1 simulated order, 0 submitted, 2 fills, 60 LLM calls journalled, 5 needs-David refusals, both books marked at £999.99 with one position each. The exit code is non-zero if any order was submitted. `npm run smoke` also runs `server/apps/v2/smoke.ts`: the same cycle as a probe plus assertions on zero submitted orders, entries reaching the dry-run broker, simulated fills reaching the books, the registry contents, the pins, the monthly cap, the macro halving, the unset parameters, the declared-not-instantiated shadows, and that a keyless paper run is refused with the `without ANTHROPIC_API_KEY` error. Outside a dry run the root refuses `SAMURAI_MODE=live` and refuses to start without non-empty `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` before opening any store — a scripted verdict never reaches a broker. A date any book has already marked is skipped with a journal line before any LLM call.

## 11. Known gaps (eval 2026-09-25, not fixed here)

- Arm 2 (doc 71 §6) has no runner: `ARM2_ENTRY_THRESHOLDS` is journalled unset each cycle and nothing reads it beyond that.
- The v2 root reads committed daily bars; no forward puller runs before the cycle, so a paper day needs `data/bars/alpaca` refreshed by hand (or the doc 70 puller) first.
- Shadow comparability (§7 deferred item 1): the primary's real fills and the shadows' daily-bar fills are not like-for-like.
- The debate core has two debater seats; the third provider sits out each day by rotation (§4) rather than arguing.
- The easy-to-borrow check for shorts (Q8) is unbuilt behind the off flag.
- `llm_call_log` replay harness (§9) is not built.
- The Alpaca leg's bracket rearm path (`rearmProtectiveLegs`) is not called from the cycle.
- The universe's `MOVERS_MIN_DOLLAR_VOLUME_USD` is a single prior-day dollar volume, not a 20-day average like the liquidity core.
