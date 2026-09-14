# Analysts Specification

**Status:** Draft (resolved wayfinder tickets synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

Samurai needs to turn raw market data into structured trading views before any debate, trade, or risk decision can happen. Different lenses on the market — price/indicator momentum, company fundamentals, crowd sentiment — each catch signal the others miss, and each is blind in ways the others are not. Feeding a single monolithic "analysis" into the pipeline would bury that diversity and lose the disagreement that the Debate Engine exists to mediate.

The Analysts layer (Stage 1) is where each lens produces its own independent view. It sits between the data services (Market Intelligence for news/sentiment, the Market Data Service for price/indicators) and the Debate Engine. Its job is to run the right analysts for a given asset, in parallel, resiliently, and hand a clean set of `AnalystView` objects downstream — without the caller ever knowing whether it is a live tick or a backtest replay.

## Solution

For each trading signal, the Analysts layer runs a set of role-specific analyst personas (technical, fundamental, sentiment) in parallel, filtered by what applies to the asset class. Each analyst pulls its primary data plus a fixed context frame from the data services, **reasons over it deterministically** — *amended 2026-08-16 from "with an LLM tiered to its latency budget"; see "Where the LLM belongs" below* — and emits a fixed-shape `AnalystView` (direction + confidence + free-text key points). The layer enforces a role-dependent quorum, handles individual analyst failures without stalling the pipeline, and produces exactly the `AnalystView[]` the Debate Engine's upstream contract expects.

Key architectural decisions:
- **Stateless analysts** — each analyst is a pure function of its inputs (data + weight); it holds no memory across ticks, so crash-restart is trivial and backtest replay reuses the live code path unchanged.
- **Primary + context input model** — every analyst has a primary data scope plus a fixed context frame (all roles always see contemporaneous price/volume), to prevent blind spots while keeping clear primary ownership.
- **Fixed `AnalystView` output** — no per-role typed fields; role-specific detail lives in free-text `key_points`, keeping the Debate Engine role-agnostic.
- **Parallel-with-applicability-filtering execution** — ~~crypto runs Technical + Sentiment (no Fundamental — no earnings/SEC data exists for crypto); stocks run all three.~~ *(Amended 2026-08-16 — crypto is out of Samurai's scope per [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)'s amendment, so there is one path and it runs all three. See "Asset-Class Analyst Counts" below, which this bullet contradicted.)* **The applicability MECHANISM stays** — `applies_to(asset_class)` is still how an analyst declines a name — but **no analyst declines anything on the path Samurai runs today, and nothing here anticipates one that will.** The interface is retained because a mandatory/optional quorum needs some way to express "not applicable", not as a seam held open for crypto: per CV-25 no spec, gate, measurement or ticket may assume a crypto path exists, and this bullet does not. Analysts are independent lenses with no sequencing between them.
- **Role-dependent quorum** — Technical and Fundamental are mandatory; Sentiment is optional. A mandatory analyst failing (after one retry) skips the whole tick; an optional analyst failing just shrinks the set.
- ~~**Tiered LLM usage** — cheap/fast models for Technical and Sentiment (tight crypto latency), a stronger/slower reasoning model for Fundamental (stocks-only, looser budget).~~
  > **Superseded 2026-08-16 — the LLM commitment moves from the analyst layer to the debate layer.** See "Where the LLM belongs" below. Note that this decision costs nothing to reverse in code: the tiering was **never built** (`server/pipeline/analysts/` is deterministic rule-based logic today), so this amendment ratifies what the code already does rather than asking for a rewrite.
- **Injected clock for replay** — no-lookahead is enforced at the data-service layer via an injected clock; the analyst is clock-blind and behaves identically live vs. replay.
- **Weight-blind views** — analysts emit raw views; analyst weights live in a shared SQLite store owned by the Feedback Loop and are applied downstream in the Debate Engine, not inside the analyst.

## User Stories

### Input & Data Access

1. As an Analyst, I want to pull my primary data scope from the data services, so that I can reason over the signal I specialize in.
2. As a Technical analyst, I want price and indicators as my primary data plus last-N-candles and volume as a fixed context frame, so that my reading is grounded in recent price action.
3. As a Fundamental analyst, I want earnings/SEC filings/news as my primary data plus the contemporaneous price reaction as context, so that I do not analyze an earnings surprise blind to how price already moved.
4. As a Sentiment analyst, I want social signals as my primary data plus contemporaneous price/volume as context, so that I can normalize crowd sentiment against actual market movement.
5. As an Analyst, I want my rolling/windowed features (moving averages, RSI, sentiment baselines) supplied by the upstream data services, so that I stay stateless and never compute or cache them myself.
6. As the Analysts layer, I want to read price/indicator data from the Market Data Service and news/sentiment data from Market Intelligence, so that each analyst gets the right source for its lens.

### Execution & Applicability

7. As the Analysts layer, I want to run all applicable analysts for a signal in parallel, so that total latency is bounded by the slowest analyst, not their sum.
8. ~~As the Analysts layer, I want to run Technical + Sentiment for crypto signals and skip Fundamental, so that I do not invoke an analyst for which no data (earnings/SEC filings) exists.~~ **Withdrawn 2026-08-16** — crypto is out of Samurai's scope per [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)'s amendment. The `applies_to` mechanism it motivated stays (see "Parallel-with-applicability-filtering execution" above), but no analyst declines a name on the path Samurai runs.
9. As the Analysts layer, I want to run Technical + Fundamental + Sentiment for stock signals, so that stocks get the full analytical panel.
10. As the Analysts layer, I want analysts to be independent with no sequencing or dependency between them, so that each is a clean independent lens on the same signal.
11. As the Analysts layer, I want to report the actual analyst count per signal so that a caller inspecting `AnalystRunResult` can see the desk size a tick actually ran with. *(Amended 2026-08-16 — this read "(2 for crypto, 3 for stocks)". The full desk is now always 3; the count varies by dropout and MI coverage, not by asset class. Amended again 2026-08-27, [#899](../../issues/899) — this previously said the count feeds "the Debate Engine's quorum math"; no such math runs in production. See "Relationship to the Debate Engine's ≥50% quorum" below.)*

### Reasoning & Output

12. ~~As an Analyst, I want to reason over my inputs with an LLM tiered to my latency budget, so that fast paths stay fast and nuanced paths get deeper reasoning.~~ **Replaced 2026-08-16:** as an Analyst, I want to reason over my inputs **deterministically**, so that the same inputs always produce the same view and the debate is the only place judgment enters. See "Where the LLM belongs".
13. ~~As a Technical or Sentiment analyst, I want to use a cheap/fast model, so that I fit the crypto path's tight per-analyst latency budget (~2s).~~ **Withdrawn 2026-08-16 with story 12** — analysts reason deterministically and make no LLM call, so there is no tier to pick. Doubly moot: the budget it cites is the crypto path's, and crypto is out of scope per [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)'s amendment.
14. ~~As a Fundamental analyst, I want to use a stronger/slower reasoning model, so that I can do deeper earnings analysis within the stocks path's looser budget (~5s per analyst).~~ **Withdrawn 2026-08-16 with story 12**, same reason. These two survived the first pass of the amendment unstruck, which left the spec requiring per-analyst model tiers three lines after withdrawing them.
15. As an Analyst, I want to emit the fixed `AnalystView` shape (direction, confidence, key_points, timestamp), so that the Debate Engine stays role-agnostic.
16. As an Analyst, I want to put role-specific detail in free-text `key_points`, so that I convey evidence without forcing typed per-role fields onto downstream consumers.
17. As an Analyst, I want to emit a raw, weight-blind view, so that weighting stays a downstream (Debate Engine) concern and the Feedback Loop can retune weights without touching me.

### Failure Handling & Resilience

18. As the Analysts layer, I want to enforce a role-dependent quorum (Technical + Fundamental mandatory, Sentiment optional) by skipping the tick when a mandatory lens is missing, so that I only emit views when the essential lenses are present.
19. As the Analysts layer, I want to retry a failing analyst exactly once with a short timeout before giving up, so that transient blips are absorbed without retry storms. (The timeout is 30,000ms since 2026-09-14, [#1080](https://github.com/dd-jp/samurai-trading-system/issues/1080); since the same change the retry joins the first attempt's in-flight bar fetch rather than re-issuing it, so it absorbs a transient fault and not a transient queue — see "Module: Failure Handling".)
20. As the Analysts layer, I want to treat malformed/unparseable analyst output identically to a timeout or error, so that I maintain one failure path (differing only in the logged reason).
21. As the Analysts layer, I want to skip the entire tick when a mandatory analyst fails even after retry, so that I never feed the Debate Engine a stale or missing essential lens.
22. As the Analysts layer, I want to proceed with the reduced set when an optional analyst fails, so that a flaky sentiment feed never blocks a trade.
23. As the Analysts layer, I want to never fall back to a stale view for a mandatory analyst, so that I avoid a confidently-wrong signal (a worse failure than a missed cycle).
24. As the operator, I want every analyst failure logged, so that I have visibility into input quality.
25. As the operator, I want an active alert only after 2 consecutive skipped ticks, so that isolated blips stay quiet but systemic breakage (bad API key, upstream outage) reaches me.

### State & Restart

26. As an Analyst, I want to hold no state between ticks, so that crash-restart requires no recovery — I just resume on the next tick with fresh data.
27. As the Analysts orchestrator, I want to read analyst weights from a shared SQLite store at tick start and pass them through to the Debate Engine, so that the Feedback Loop can adjust them, they survive a crash-restart, and analysts stay weight-blind.

### Backtesting & Replay

28. As the Analysts layer, I want backtest replay to reuse the exact same analyst code path as live, so that backtests exercise real code with no behavioral drift.
29. As an Analyst, I want to be clock-blind, so that I cannot tell a live tick from a replayed one — the only difference is the data source.
30. As the system, I want no-lookahead enforced by an injected clock at the data-service layer, so that during replay the services only return data timestamped at or before the simulated time T.
31. As the system, I want re-running a historical window (param sweeps, debugging) to cost **nothing extra and produce byte-identical views**, so that a re-run is a re-computation rather than a second bill. *(Replaced 2026-08-16 with story 12. This read "a response cache keyed by (analyst, input-snapshot hash) ... instead of paying for LLM calls again". A deterministic analyst has no call to pay for and no nondeterminism to cache around: the cache existed only to buy back reproducibility from a model, and it is the model that left. The Debate Engine, where the LLM now exclusively lives, still needs this — as a debate-engine concern.)*
32. As the system, I want backtest iteration to be **free at this layer**, so that bulk parameter sweeps are bounded by CPU rather than by spend. *(Replaced 2026-08-16 with story 12. This read "a cheap model tier for bulk iteration and a premium tier for final validation". With no analyst LLM there is no tier to pick, and — importantly — no "cheap tier for iteration, premium for validation" gap in which a swept configuration and its validation run could disagree because they were reasoned about by different models.)*
33. As the system, I want replay to be reproducible **by construction**, so that PBO/overfitting metrics remain meaningful. *(Replaced 2026-08-16 with story 12. This read "force LLM temperature 0 (or fixed seed)". Temperature 0 is not determinism — it is a lower-variance sampler over a model that can still be re-versioned underneath a run. An arithmetic rule over a pinned bar window is determinism, and it is what `docs/research/13-stage2-proxy-verdict.md`'s selection accounting requires of the inputs it scores.)*

## Implementation Decisions

### Module: Analyst Orchestrator

**Responsibilities**
- Accept a trading signal, resolve the applicable analyst set by asset class, and run those analysts in parallel.
- Provide each analyst its clock, data-service handles, and current weight at invocation.
- Enforce the single-retry policy and role-dependent quorum.
- Decide skip-the-tick (mandatory failure) vs. proceed-with-reduced-set (optional failure).
- Track consecutive skipped ticks and fire the alert on 2 in a row.
- Return the `AnalystView[]` payload for the Debate Engine, annotated with the actual analyst count.

**Key Interfaces**

```typescript
// Output contract (consumed by the Debate Engine — fixed AnalystView shape,
// already defined by the Debate Engine's upstream contract)
interface AnalystView {
  trace_id: string;          // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  analyst_id: string;
  analyst_type: string;      // "technical" | "fundamental" | "sentiment"
  direction: Direction;      // bullish | bearish | neutral
  confidence: number;        // 0.0 - 1.0
  key_points: string[];      // role-specific evidence, free-text
  timestamp: Date;
}

// A single analyst persona: a pure function of its inputs.
interface Analyst {
  analyst_type: string;
  applies_to(asset_class: AssetClass): boolean;   // crypto | stocks
  role: "mandatory" | "optional";
  run(input: AnalystInput): Promise<AnalystView>;
}

// What the orchestrator assembles for each analyst per tick. Note: no weight
// here — the analyst is weight-blind (weights are applied downstream in the
// Debate Engine, not inside the analyst).
interface AnalystInput {
  trace_id: string;         // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  signal: Signal;            // asset, asset_class, etc.
  clock: Clock;             // wall-clock live, simulated T in replay
  // Data-service handles resolve "now" from the injected clock and filter
  // to timestamp <= clock.now(), enforcing no-lookahead below the analyst.
  market_intelligence: MarketIntelligence;   // news/sentiment (getContext)
  market_data: MarketDataService;            // OHLCV + technical indicators
}

// Orchestrator entry point (the single test seam).
interface AnalystOrchestrator {
  runAnalysts(signal: Signal): Promise<AnalystRunResult>;
}

interface AnalystRunResult {
  views: AnalystView[];        // one per successful applicable analyst
  weights: Record<string, number>; // analyst_id -> weight, read from the shared
                                    // store at tick start, passed through for the
                                    // Debate Engine to apply (analysts never see it)
  analyst_count: number;       // 3 on the equities path (before failures/mutes)
  skipped: boolean;            // true if a mandatory analyst failed the tick
  failures: AnalystFailure[];  // logged failures this tick (reason-tagged)
}
```

### Module: Analyst Roles & Input Model

**Primary + context per role** (from #23). Each analyst owns a primary data scope and always receives a fixed context frame:

- **Technical** — primary: price/indicators (from Market Data Service); context: last-N-candles + volume (always). Mandatory. ~~Cheap/fast LLM tier.~~ **Deterministic (2026-08-16).**
- **Fundamental** — primary: earnings/SEC filings/news (from Market Intelligence); context: contemporaneous price reaction (always). Mandatory. ~~Stronger/slower LLM tier.~~ **Deterministic (2026-08-16).** Stocks-only.
- **Sentiment** — primary: social signals (from Market Intelligence); context: contemporaneous price/volume, to normalize (always). Optional. ~~Cheap/fast LLM tier.~~ **Deterministic (2026-08-16).**

### Where the LLM belongs — the debate layer, not the analyst layer *(2026-08-16)*

**Decided by David: indicators feed the debate; the debate decides.** Analysts compute and present evidence deterministically; the LLM's judgment is spent at the Debate Engine, weighing conflicting evidence.

**The argument is about what an LLM is good for, not about cost.** Deciding whether RSI 72 is overbought is arithmetic against a threshold. Putting a nondeterministic, per-call-billed, unauditable model in front of that arithmetic buys nothing and costs three things this system cannot spare:

1. **Reproducibility**, which is the one property a strategy under selection-bias scrutiny cannot give up. `docs/research/13-stage2-proxy-verdict.md` and the PBO/DSR accounting only mean something if the same inputs produce the same views. The old spec tried to buy this back with temperature-0 replay and an input-hash response cache — machinery that exists *only* because the analyst was nondeterministic, and which disappears with the analyst LLM.
2. **Auditability.** "Why was this position opened" has to be answerable from a log. A threshold comparison answers it; a model's prose about a threshold comparison does not.
3. **Failure surface.** Each analyst LLM call is a latency tail, a spend line, and a quorum risk on a mandatory analyst.

**What is *not* claimed:** that LLMs add nothing. The recorded thesis is that they add value **as the generator, weighing conflicting evidence under uncertainty** — which is the debate's job and remains untouched. This amendment moves the model to where it earns its cost, and it does not weaken the thesis; if anything it sharpens the falsifier, because the control arm ([#636](https://github.com/dd-jp/samurai-trading-system/issues/636)'s falsifier arm 2 — same names, same exit rule, same stop, entry by indicator alone, no LLM) becomes **the analyst layer's own output thresholded**, with no separate implementation to write and no risk of the control differing from the live arm by accident.

**Consequences to carry, not discover:**

- **The response cache, the cheap/premium backtest tiers, and temperature-0 replay lose their purpose at this layer.** Deterministic analysts are free to replay and reproduce by construction. Those decisions still apply to the **debate** stage, where the LLM now exclusively lives; they should be read as debate-engine concerns and not re-created here.
- **The prompt-injection requirement gets *stronger*, not weaker.** Analysts still consume free text from Market Intelligence, and they still render it into `key_points` that reach the debate's prompt. `debate-engine/personas.ts` wraps analyst views in an untrusted block — which means **any interpretation legend must be computed inside the analyst**, not written into the prompt: a decoder legend in the prompt would be trusted while the numbers it decodes are not.
- **`NOUS_ROLES` needs no new analyst entries.** ADR-0009 routes all LLM traffic through Nous, and the tiering above would have required new roles and priced models. With the tiers withdrawn, `['debate', 'sentiment']` remains adequate.
- **Untouched:** `:267-269`'s allowance that an analyst's reasoning internals are out of scope. How each analyst turns indicators into a direction and a confidence is still its own business; this amendment fixes only that it does so deterministically.

> **Status against code, and what ADR-0009 constrains.** The LLM tiering above is **withdrawn, not merely unbuilt** *(corrected 2026-08-16 — this note still framed the tiering as future work in the same document that withdrew it, which is the opposite of what the amendment decided)*. `server/pipeline/analysts/` is pure rule-based logic today, makes no LLM call (see "Prompt Injection Mitigation" below), and under this amendment that is the specified end state rather than a waypoint. The paragraph below is retained because it constrains **any** future LLM entering this layer — a re-opened tiering, or something new — not because a tier is expected: it does not get to pick a provider, since [ADR-0009](../adr/0009-single-provider-nous.md) routes **all** LLM traffic through Nous, so a tier here becomes a new entry in `NOUS_ROLES` and `DEFAULT_NOUS_MODELS` (`server/shared/llm/nous-config.ts`), resolved via `NOUS_<ROLE>_MODEL` → `NOUS_MODEL`, with the model priced in `MODEL_RATES` — an unpriced model is refused at startup because its calls record a null cost and [ADR-0008](../adr/0008-llm-spend-cap.md)'s cap sums nulls as zero. `NOUS_ROLES` is `['debate', 'sentiment']` today; neither is an analyst role. Note also that the cheap-tier assumption is not free: the ADR-0009 bake-off found the cheap tiers are cheap partly because they are queued, and tail latency, not median, is what a per-analyst budget has to survive.

The context frames deliberately overlap (all three see price/volume). Overlap is allowed and expected — no de-duplication in Stage 1. Conflicting-but-overlapping conclusions are exactly what the Debate Engine's semantic disagreement detection exists to mediate.

**Prompt Injection Mitigation — forward-looking convention** (#208)

Today, `server/pipeline/analysts/` (`fundamental-analyst.ts`, `sentiment-analyst.ts`, `technical-analyst.ts`) is pure mechanical/rule-based logic — none of it makes an LLM call or constructs an LLM prompt from ingested free text (news, filings, social signals). There is no prompt-construction code here to retrofit as of this ticket.

Fundamental and Sentiment analysts consume free text sourced from Market Intelligence (news, social signals) that could carry the same kind of injected content described in issue #208 (e.g. a headline engineered to look like an instruction). Any future code in this component that constructs an LLM prompt from that ingested free text MUST delimit it using the same tagged-untrusted-block convention implemented in the Debate Engine's `server/pipeline/debate-engine/personas.ts` (see debate-engine-spec.md "Prompt Injection Mitigation"): wrap ingested text in a tagged block (e.g. `<untrusted_analyst_data>...</untrusted_analyst_data>`) preceded by an explicit "treat as data, not instructions" preamble, with the real output-format instruction kept outside and separate from that block. This requirement gates shipping any such prompt-construction code, not a later cleanup pass.

### Module: Execution & Applicability

- ~~**Crypto**: Technical + Sentiment run in parallel; Fundamental is skipped (no earnings/SEC data exists for crypto). Analyst count = 2.~~ **Withdrawn 2026-08-16** — crypto is out of Samurai's scope per [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)'s amendment, so there is no second path to count.
- **Equities — the only path**: Technical + Fundamental + Sentiment run in parallel. Analyst count = **3**.
- Analysts are independent — no sequencing or dependency between them within a signal.
- The orchestrator reports `analyst_count` — the desk narrowing to 2 when optional Sentiment drops, or when an MI coverage hole mutes an analyst. It is no longer a per-asset-class constant. *(Amended 2026-08-27, [#899](../../issues/899) — this previously said the count feeds "the Debate Engine's ≥50% quorum math"; no code computes that ratio in production. See "Relationship to the Debate Engine's ≥50% quorum" below.)*

### Module: Failure Handling

**Failure modes** (all treated identically, differing only in logged reason): timeout, error, malformed/unparseable output (schema-validation failure).

**Policy** (from #41):
1. Uniform single bounded retry with a short timeout for any failing analyst, regardless of role.
2. After the retry is exhausted:
   - **Mandatory analyst** (Technical, Fundamental) → hard-block: **skip the entire tick**. No stale-view fallback, no partial debate.
   - **Optional analyst** (Sentiment) → proceed with the reduced set; the debate runs without it.
3. Every failure is logged with its reason. An active alert fires only after **2 consecutive skipped ticks**; a single isolated skip is log-only.

**The "short timeout", as a number — amended 2026-09-14 ([#1080](https://github.com/dd-jp/samurai-trading-system/issues/1080))**

`DEFAULT_ANALYST_TIMEOUT_MS` is **30,000ms** (was 10,000ms). It is not a guess at how long an HTTP fetch takes; it is the queue that fetch waits in.

The mandatory `technical` analyst issues no LLM call — it fetches bars and computes indicators locally. Those fetches take `acquireBackground()` on the Alpaca token bucket shared with the order path (`server/shared/http/venue-pacing.ts`), which holds `capacity - reserveForPriority` = 20 tokens above the order path's reserve and refills at 2.0/s. One sweep of the 20-instrument universe reaches the venue for up to four distinct bar windows per instrument, so the sweep's drain is `(20 × 4 − 20) / 2.0` = **30 seconds**. Measured over 38 fetch bursts in the 2026-09-04, 2026-09-08 and 2026-09-10 soak logs, restarts included: no instrument reached the venue for more than four windows in a burst. Five shapes appear across the universe in a single burst — `5m/260` and `1h/57` (technical indicators and context), `5m/112` (MACD warm-up), `1h/20` (the trader's signal bar) and `1d/30` (`correlationConfig.window`) — but no single instrument asks for all five, and `adv_window` (`1d/20`) is an Execution-stage read that appears in no measured burst. A `getBars` call served from the store takes no token and is silent in the log, which is why this count is smaller than the eight windows a technical analyst asks for per tick. A fetch that cannot get a token has not started, so at a 10s deadline the instruments at the back of every sweep timed out by construction.

That is #1080's instance 2, measured rather than inferred: in the 2026-09-10 19:56 burst, 91 of 133 `market_data_fetch` lines exceeded 10,000ms with a median of 21,338ms, and the ticket reports 57% of main-arm runs missing quorum on `technical did not answer within 10000ms` with no fault logged anywhere — because there was none.

The other half of the fix is upstream of this deadline: concurrent callers asking for the SAME window no longer each spend a venue token (`MarketDataServiceImpl` single-flight coalescing), which removed 74% of the measured burst (133 fetches over 34 distinct windows, one window fetched seven times in one tick, every line logged `cache: "miss"` because the cache writes on completion and could not see a request still in flight). This deadline covers what remains.

**What story 19's retry means given that coalescing — decided, not incidental.** `ATTEMPTS_PER_PERSONA` runs the second attempt through `withTimeout(persona.run(...))` with no `AbortSignal`, so a timed-out attempt's bar fetch stays in flight. The single-flight key includes `barIndex = floor(asOf / timeframe)`, which does not change across a 30-second gap at 5m or 1h, so attempt 2 JOINS attempt 1's fetch rather than re-asking the venue. That is the intended behaviour: the join only happens while the first fetch is unsettled, which is exactly the queued-behind-a-token case this deadline exists for, and re-issuing would put a second request behind the same queue and lengthen the drain for everyone. Liveness is bounded independently of the retry — the venue call is `fetchWithTimeout(10,000ms)` inside a bounded `withRetry` — so the joined promise always settles. Stated plainly: **story 19's retry absorbs a transient FAULT, not a transient QUEUE.** Against a queue it is a second 30,000ms wait on the same fetch, and the 60,000ms per-persona wall clock below is what that costs.

**Cold store is outside this bound, and its successor is named.** The four-windows-per-instrument count above is a WARM-STORE measurement. A first-ever tick against an empty store has no stored history to serve the wider specs from and asks the eight windows `MarketDataServiceImpl` documents, so the drain is `(20 × 8 − 20) / 2.0` = **70 seconds** against this 30,000ms deadline: the back of that first sweep misses quorum and the tick records a no-trade it never measured. It self-heals from the sweep's own fetches as they land, and it surfaces as a streak on `consecutive_misses` plus the quorum-skip alert if it does not. Raising the deadline is not the available fix — two attempts at 70,000ms is 140 seconds of analyst wall clock against a 120,000ms tick. Nothing REFUSES that overrun: `paper-profile.ts`'s pass-duration tripwire is a HUMAN re-read trigger, not a gate, and no downstream check measures a pass's wall clock ([#1104](https://github.com/dd-jp/samurai-trading-system/issues/1104)). The overrun would simply happen, group by group, unannounced — which is the reason not to reach for it. The fix is warming the store OFF the tick path, and no boot-time bar prefetch exists in the orchestrator today. **Declined for #1080** and left as the named successor, because the starvation #1080 measured is steady-state, not boot-time. Note also that single-flight coalescing changed `consecutive_misses` from per-caller to per-fetch-group: smaller and truer, counting ticks that missed rather than callers that joined one miss, so a cold store reads as a streak across ticks rather than one fan-out-inflated spike.

The derivation is pinned from the pacing side by `server/apps/orchestrator/production/rate-limit-wiring.test.ts`, where the bucket's constants live. `ATTEMPTS_PER_PERSONA` is 2, so one persona's wall clock is up to 60,000ms, named as `ANALYST_STAGE_WALL_CLOCK_MS` ([#1104](https://github.com/dd-jp/samurai-trading-system/issues/1104)) — the stage settles when the slowest persona does, and `runAnalysts` fans the personas out under one `Promise.all`, so that product is the stage's worst case exactly, not an upper bound.

**That 60,000ms is not divided out of an enclosing budget, and #1104 resolved deliberately not to invent one.** The debate arm's per-attempt timeout IS a division (`maxAttempts × (timeoutMs + maxDelayMs) ≤ LATENCY_BUDGET_MS`); this one is not, because nothing downstream measures the analyst stage's wall clock. Specifically not the two Verdict freshness gates a previous version of `paper-profile.ts`'s tripwire comment named: gate 1 measures `now − orderIntent.decided_at`, and `decided_at` is a `clock.now()` read inside that instrument's OWN Trader step, while gate 2 measures `Mark.observed_at` on a mark `getMark(instrument, now)` re-reads inside the gate behind a 5,000ms TTL. Both are within-pass, per-instrument intervals; an instrument's position in the `ceil(universe / width)` walk enters neither. So a full pass overruns the 120,000ms tick cadence by design (#1080) with nothing to catch it, the deadline is sized against the DATA SOURCE alone, and `ANALYST_STAGE_WALL_CLOCK_MS` is an OUTPUT of that sizing rather than a ceiling imposed on it. `paper-profile.ts`'s `maxConcurrentInstruments` comment is the human tripwire that remains, and `paper-profile.test.ts` pins the resulting figures (172,000ms per group, 688,000ms per pass) so a change to either sub-budget has to be re-read rather than absorbed.

**Legibility is unchanged and already sufficient**: a quorum miss caused by this deadline writes `quorum_skip_timeout` (not `quorum_skip`) to `audit_log.decision` and lifts the tick line to `warn`, so a budget-starved no-trade stays distinguishable from a genuine no-signal (#1103).

**Rationale** — a stale mandatory view risks a confidently-wrong technical/fundamental read, a worse failure than missing one cycle; this matches the project's safety-over-uptime posture for live money.

**Relationship to the Debate Engine's ≥50% quorum — corrected 2026-08-27, see [#899](../../issues/899).** There is **one** quorum-relevant guarantee in production, and it lives here, in the Analysts layer: the role-dependent skip. If a mandatory analyst (Technical, Fundamental) fails, `mandatoryFailed` goes true and `AnalystOrchestrator.runAnalysts` returns `views: []` regardless of how many other personas succeeded (`server/pipeline/analysts/orchestrator.ts:257-263`) — the tick is skipped and the Debate Engine is never invoked.

This section previously claimed a **second**, independent gate: a ≥50%-of-3 count check inside the Debate Engine, "complementary, not duplicated" with the role gate above. That check exists as code — `collectAnalystViews` in `server/pipeline/debate-engine/analyst-response-collector.ts:136` (quorum arithmetic at `:178`) — but it has **no production caller**. A grep of non-test `server/` and `client/` for `collectAnalystViews` returns exactly its own definition and a re-export at `debate-engine/index.ts:23`; the module's own comment at `:102` says as much ("`collectAnalystViews` has no production consumer as of #347; the Analyst stage is out of scope per debate-engine-spec.md"). It is unbuilt-into-production, not a live downstream backstop, and this doc should not have described it as one. It is left in place (not deleted) as intentionally-dormant code per its own `:102` comment — [#899](../../issues/899) decided against deleting it, since it may still serve the still-open ticket #25/#37 chain if the Debate Engine ever grows an Analyst-stage consumer.

**Is the single-live-analyst (n=1-of-3, 33%) state actually reachable, given the role gate is the only enforcement?** No — but only because of the *current* mandatory/optional split, not as a general property of "role gate implies quorum." With Technical and Fundamental `mandatory` and Sentiment the lone `optional` slot: any mandatory failure zeroes `views` to `[]` outright (skip), and the only persona that can fail *without* zeroing the desk is the one optional slot. So the sole nonzero partial state the role gate ever lets through is **2-of-3 (67%)** — comfortably above 50% — and 1-of-3 is unreachable with a nonzero, un-skipped result. This is pinned by four tests in `server/pipeline/analysts/orchestrator.test.ts`, describe block `"quorum guarantee (#899): the role gate is the only production enforcement"`:
- a desk where a mandatory persona fails alongside the optional one is rejected outright (`skipped: true`, `views: []`) — the "single live analyst must not trade" case this section used to attribute to the Debate Engine;
- the only reachable partial desk is the 2-of-3 optional dropout, at 67%;
- a **hypothetical** demotion of Fundamental to `optional` (not current production config) lets a genuine 1-of-3 (33%) desk survive the role gate — `skipped: false` with a below-quorum view count — because two optional slots can fail together while the sole remaining mandatory persona succeeds. **The guarantee is contingent on there being exactly one optional slot out of three; it is not automatic.** If Fundamental were ever demoted, or a fourth persona were added as optional, this backstop would silently stop covering quorum, and — because `collectAnalystViews` has no caller — nothing else would catch it;
- conversely, a **hypothetical** promotion of Sentiment to `mandatory` stays safe: with every persona mandatory, any single failure zeroes the desk, so the only reachable nonzero state is 3-of-3. Promoting a persona to `mandatory` only makes the role gate stricter; only *demoting* one below `mandatory` while more than one non-mandatory slot exists can reopen the gap.

The orchestrator still reports `analyst_count` so a caller inspecting `AnalystRunResult` can see the desk size a tick actually ran with, but no code today computes a ≥50% ratio from it in production.

### Module: State Management

**Decision: analysts are stateless per tick** (from #42). Each analyst is a pure function: `(data + weight) -> view`. It holds no memory across ticks.

- **Rolling/windowed features** (moving averages, RSI, sentiment baselines) are supplied by upstream data services, never computed or held inside the analyst. Market Intelligence serves news/sentiment; the Market Data Service serves OHLCV + technical indicators.
- **Crash-restart is trivial** — analysts persist nothing and simply resume on the next tick. (The crash-restart invariant in CLAUDE.md concerns open positions, satisfied here by holding no state.)
- **Analyst weights** live in a shared persistent SQLite store, owned by the Feedback Loop (Stage 6). The **orchestrator** reads the weights map at tick start and passes it through in `AnalystRunResult.weights` for the Debate Engine to apply. Analysts themselves never receive or see weight — they stay stateless and weight-blind.
- **Weights are applied downstream** in the Debate Engine — the analyst emits a raw, weight-blind view, consistent with CONTEXT.md ("produces a view, not a recommendation").

### Module: Backtesting Replay

**Decision: same code path, clock-driven, cached** (from #43).

- Replay reuses the exact live analyst code path. The analyst is clock-blind; the only difference between live and replay is the data source (live feed vs. historical store).
- **No-lookahead** is enforced by an **injected clock at the data-service layer**. Both Market Intelligence and the Market Data Service read "now" from the injected clock and filter `timestamp <= clock.now()`. In replay the clock is the simulated time T.
- **The historical data store is out of scope for the Analysts layer** — it is owned by the data services (the Market Data Service persists OHLCV natively; Market Intelligence's historical store is the still-open ticket #21). Stage 1 depends on replayable data services but does not build the store.
- **LLM replay cost at this layer is zero**, because there is no LLM at this layer *(2026-08-16, with story 12)*. The response cache and the cheap/premium backtest tiers this bullet used to specify were machinery for a nondeterministic analyst; both are withdrawn here and neither is re-created. They remain live decisions for the **Debate Engine**, which is where the model now is.
- **Reproducibility is structural, not configured** *(2026-08-16)*. Identical inputs produce byte-identical views because the reasoning is arithmetic over a pinned bar window — no temperature to set, no seed to fix, no cache-warm/cache-cold distinction to reconcile. That is a stronger guarantee than the temperature-0 one it replaces: temperature 0 still rides a model that can be re-versioned under a run, and a re-versioned model would silently invalidate every PBO/DSR figure computed against the old one.

## Testing Decisions

### What Makes a Good Test

- Test external behavior at the orchestrator seam (`runAnalysts(signal) -> AnalystRunResult`), not internal implementation.
- Mock the two data services (Market Intelligence, Market Data Service) — the orchestration logic (applicability, parallelism, retry, quorum, skip/alert) is what's under test. *(Amended 2026-08-16: this also said "and the LLM". There is no LLM at this layer to mock, and a test that mocks one would be describing a seam that must not exist — `server/pipeline/analysts/analyst-prompt-cost.test.ts` asserts its absence by scanning this package's imports.)*
- Test failure modes explicitly: mandatory analyst fails → tick skipped; optional analyst fails → reduced set proceeds; malformed output treated as failure.
- Test the alert threshold: one skip is silent, two consecutive skips fire an alert.
- Use an injected mock clock to test no-lookahead: replayed data-service reads never return data timestamped after `clock.now()`.
- Test determinism directly: the same `(Signal, asOf)` over the same fixture bars produces an identical `AnalystView`, asserted by equality. *(Amended 2026-08-16: this read "temperature-0 replay with a warm cache reproduces a cold-cache run's views" — a test of caching machinery that no longer exists. `technical-analyst.test.ts` runs the analyst twice and compares the whole view.)*

### Modules to Test

**Analyst Orchestrator**
- Applicability filtering (equities → all three; `analyst_count` correct). *(Amended 2026-08-16 — the crypto → Technical + Sentiment case is withdrawn with story 8.)*
- Parallel execution (total latency bounded by slowest analyst, not the sum).
- Single-retry policy (fails once, retries once, then gives up).
- Role-dependent quorum (mandatory failure skips tick; optional failure proceeds).
- No stale fallback for mandatory analysts.
- Consecutive-skip tracking and the 2-in-a-row alert.

**Analyst Roles & Input Model**
- Correct primary + context frame assembled per role.
- Output conforms to the fixed `AnalystView` shape (types, confidence in 0–1, role-specific detail only in `key_points`).
- Views are weight-blind (weight input does not alter the emitted view shape/content path).

**Backtesting Replay**
- Same code path exercised live and in replay (no divergence).
- No-lookahead via injected clock (data services filter `timestamp <= clock.now()`).
- Byte-identical views from identical inputs, with no cache and no LLM call to avoid *(2026-08-16)*.

### Prior Art

- No test infrastructure exists yet — this is pre-implementation.
- LLM mock patterns are a **Debate Engine** concern only *(2026-08-16)*. This layer's tests need no LLM double; `MockLlmClient` appears in an analyst test exactly once, to measure the debate prompt this layer's output is rendered into, never to stand in for analyst reasoning.
- Time-based testing uses a mock clock (already anticipated by the Market Intelligence spec) to simulate time windows and replay without real delays.

## Out of Scope

**Signal Production (out of scope, flagged dependency)**

This spec consumes `Signal{asset, asset_class}` via `runAnalysts(signal)` but does not produce it. Market scanning / universe selection / scheduling — the "idea generation" half of Stage 1 (per CONTEXT.md and the vision's DoD #1: "Analyst scan runs on schedule, produces ideas for configurable universe") — is NOT part of this spec. **Ownership resolved 2026-08-07:** universe selection is owned by the **Universe Selector** ([universe-selector-spec.md](universe-selector-spec.md), wayfinder map [#397](../../issues/397)) — an out-of-session job that ranks a candidate pool and writes a watchlist; scheduling and per-tick `Signal` emission stay with the Orchestrator. *The rest of this note records the pre-2026-08-07 state, when the owner was unknown; it is kept because the dependency it names is unchanged.* It most likely belongs to the uncharted **Orchestrator** (see docs/specs/cross-spec-contracts.md OPEN-GAP-D), which would run a scheduled scan over the configured universe (default SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD per ADR-0001) and emit one `Signal` per instrument per tick, invoking `runAnalysts(signal)` for each. This spec deliberately does not design the scanner itself — this note exists only to name the dependency and its likely home so it isn't silently lost.

**Data Service Implementation**

How Market Intelligence and the Market Data Service fetch, normalize, and store data is out of scope. The Analysts layer consumes their interfaces (`getContext`, OHLCV/indicator queries) but does not build them. The Market Data Service itself is a new Stage 0-level component surfaced during #42 and needs its own wayfinder map before implementation.

**Historical Data Storage for Replay**

The historical store that feeds replayed data is owned by the data services, not analysts. Market Intelligence's backtesting replay store is specced in market-intelligence-spec.md (**Module: Backtesting Replay Store**) — a standalone replay service that captures live MI outputs (raw + normalized IntelligenceItems) via push sidecar writes to SQLite, and serves them through a `ReplayContext` that implements the same `getContext()` contract the Analysts layer already consumes. The Orchestrator swaps the live MI backing for a `ReplayContext` when `mode='backtest'`; analysts are unaware of the swap (story 29: clock-blind, same code path).

**Debate Engine**

How views are mediated, how disagreements are detected, and how analyst weights are applied is the Debate Engine's concern (see debate-engine-spec.md). This spec produces the `AnalystView[]` input; it does not consume it.

**Feedback Loop Weight Adjustment**

The Analysts layer reads weights from the shared store; how the Feedback Loop computes and writes them post-execution is out of scope.

**Self-Learning / Online Model Training**

Analysts are static (rule-driven; deterministic as of 2026-08-16 — no LLM reasoning at this layer); they do not self-retrain. The only adaptation in the system is Feedback-Loop weight tuning, which is bounded and does not change the underlying market model (per CONTEXT.md). Autonomous model retraining / RL is deliberately excluded — it would undermine the "economically explainable edge" and PBO-discipline invariants.

**Conviction Score & Confidence Calibration**

How an analyst arrives at its `confidence` value is an implementation detail. This spec fixes the output shape, not the reasoning internals — which is the allowance the technical analyst's axis vote (#745: one vote per axis, `confidence = |net| / availableAxes`, capped when the volatility gate says the tape is not trending) sits inside. *(Amended 2026-08-16: "calibration, prompt engineering" — there is no prompt at this layer to engineer.)*

**Prompt Engineering At This Layer**

There is none, and that is the specified state rather than an unfilled gap *(2026-08-16, replacing "LLM Selection & Prompt Engineering: which exact models fill the cheap/fast and stronger/slower tiers, prompt design, and the per-call cost ceiling")*. No model is selected, so there is no per-call cost ceiling to defer either. What IS in scope, and is a hard requirement rather than an implementation detail, is the direction of the interpretation: an analyst's `key_points` are rendered into the debate prompt inside `wrapUntrusted`'s block, so any band, legend or decoder that explains those numbers must be computed in the analyst and travel INSIDE that block. Writing it into the prompt instead would make trusted text explain untrusted numbers.

## Further Notes

### Integration with Pipeline

The Analysts layer sits between the data services and the Debate Engine:

```
Market Intelligence  ┐
                     ├─→ Analysts → Debate Engine → Trader → Risk Manager → Verdict → Execution
Market Data Service  ┘   (this spec)
```

The Feedback Loop closes the loop by writing analyst weights (read at tick start) back into the shared SQLite store.

### Domain Glossary Alignment

Per CONTEXT.md:
- **Analyst**: "An agent persona that examines market data through a specific lens. Multiple analysts run in parallel. Each produces a view, not a recommendation. Stateless per tick — holds no memory across ticks. A pure function of its inputs."
- **Market Data Service**: "A dedicated Stage 0-level data layer, parallel to Market Intelligence, that serves price OHLCV plus precomputed technical indicators to analysts."
- **Debate Engine**: "Mediates between conflicting analyst views before the Trader consolidates."

### Asset-Class Analyst Counts

~~The variable analyst count (2 for crypto, 3 for stocks) is not incidental — it drives the Debate Engine's quorum threshold. Crypto's ≥50% quorum of 2 means both analysts effectively matter; stocks' ≥50% of 3 tolerates one optional (Sentiment) dropout. This is why Fundamental is mandatory on the stocks path but simply absent (not "failed") on the crypto path.~~

> **Superseded 2026-08-16, corrected 2026-08-27 ([#899](../../issues/899)).** Crypto is out of Samurai's scope, so there is one path and the count is **3**, with Sentiment the one optional dropout. **The quorum reasoning itself survives and matters more than it did**: with only one path, ≥50% of 3 is the sole quorum rule, and [`market-intelligence-spec.md`](market-intelligence-spec.md)'s exclude-mute-analysts behaviour means an MI coverage hole narrows the desk to 2 rather than dragging the evidence average — the fix for [#625](https://github.com/dd-jp/samurai-trading-system/issues/625)'s 0.5478 conviction ceiling. A desk narrowed to a single live analyst is below quorum and must not trade — **that case is now a test**, against the component that actually enforces it (the Analyst orchestrator's role gate, not a Debate Engine count check — see "Relationship to the Debate Engine's ≥50% quorum" above): `server/pipeline/analysts/orchestrator.test.ts`, describe block `"quorum guarantee (#899): the role gate is the only production enforcement"`.

### ~~Latency Tiering Rationale~~ — withdrawn 2026-08-16

~~LLM tiering is driven by the latency budget, not just task complexity. Technical and Sentiment run on the crypto path's tight ~2s/analyst budget, so both use cheap/fast models. Fundamental runs only on the stocks path (looser ~5s/analyst budget), so it can afford a stronger reasoning model for nuanced earnings analysis.~~

> **Withdrawn with the tiering itself.** Analysts make no LLM call, so there is no tier to choose and no per-analyst latency budget to choose it against. What replaces it is not a smaller version of the same thing: the analyst layer's latency is now **compute-bounded and deterministic**, which is what lets it run on the cheap tick path at τ=2min. The two premises this section rested on are both gone — the crypto path, and the per-analyst model call.

### Backtest Cost Model — **relocated, not deleted**

~~A long replay window makes thousands of analyst invocations. Without mitigation that is thousands of LLM calls. The input-hash response cache makes re-runs (param sweeps, debugging) near-free, and the cheap model tier keeps first-pass bulk iteration affordable; premium models are reserved for the final validation run. Temperature-0 replay makes all of this reproducible.~~

> **Amended 2026-08-16.** A replay no longer makes *any* LLM call at this layer, so the cost this section prices is zero here. **The three mechanisms are still needed — one stage later.** The input-hash response cache, the cheap/premium split for bulk-vs-validation runs, and temperature-0 replay all belong to the **Debate Engine**, which is where the model calls now are and where a long replay's cost is now concentrated. Do not read this withdrawal as "backtest replay became free": it became free *at the analyst layer*, and the same arithmetic reappears against debate rounds. See [`debate-engine-spec.md`](debate-engine-spec.md).

### Future Extensions

Potential enhancements (not in this spec):
- Additional analyst lenses (macro, options flow, on-chain) added to the applicability matrix.
- Per-analyst confidence calibration tuned from Feedback-Loop outcome data.
- Adaptive analyst set selection (turn a lens off when it has shown no edge for an asset class).

## Resolved Issues (Sources)

Wayfinder decisions for this stage live in [docs/wayfinder/analysts-map.md](../wayfinder/analysts-map.md) (migrated from GitHub issue #22). Decisions synthesized here:

- **Analyst role definitions and contracts** — primary+context input model, fixed `AnalystView` output, parallel-with-applicability-filtering execution, deterministic reasoning *(2026-08-16, replacing "latency-tiered LLM usage" — see "Where the LLM belongs")*, overlap allowed (defer to Debate Engine).
- **Analyst failure handling** — role-dependent quorum (Technical + Fundamental mandatory, Sentiment optional), uniform single-retry, skip-the-tick on mandatory hard-block (no stale fallback), alert after 2 consecutive skips.
- **Analyst state management** — stateless analysts (pure function of data + weight), upstream data services supply rolling features, trivial crash-restart, weights in shared SQLite owned by the Feedback Loop and applied downstream.
- **Backtesting replay** — same code path live vs. replay, no-lookahead via injected clock at the data-service layer, historical store owned by data services, reproducibility by construction *(2026-08-16, replacing "input-hash response cache + cheap tier for bulk, temperature-0" — those move to the Debate Engine with the model)*.

Dependencies on other stages:
- **Market Data Service** — new Stage 0-level component (OHLCV + technical indicators) surfaced during state-management grilling; needs its own wayfinder map. The Analysts layer depends on it but does not build it.
- **Market Intelligence backtesting store** — still-open frontier item on the Market Intelligence map; owns the historical news/sentiment store the analysts' replay depends on.
- **Signal production (scanning/scheduling)** — unowned; see Out of Scope note above and cross-spec-contracts.md OPEN-GAP-D. Likely Orchestrator territory, not yet charted.

All Stage 1 map frontiers resolved. Map is complete.
