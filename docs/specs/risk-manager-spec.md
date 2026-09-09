# Risk Manager Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

**2026-08-16 — the horizon banner's remaining items are resolved here in the body, and the banner is deleted.** Its drawdown-breaker item was already closed by [#634](https://github.com/dd-jp/samurai-trading-system/issues/634) on 2026-08-15 (the 30%/20% hysteresis band, sited against ADR-0018's measured envelope — see the next block, which stands unchanged). The three items that were still live are settled below.

**1. The volatility halt stays binary, and the trigger to revisit it has now fired without changing the answer.** The old banner said *"Revisit when [#654](https://github.com/dd-jp/samurai-trading-system/issues/654) lands."* The ladder decision has now been taken (`trader-spec.md`, 2026-08-16), so this is that revisit, and the conclusion is **unchanged for a reason that outlived the trigger**:

- The contest is real and is not dismissed — doc 12 calls a binary halt *"the most extreme form of 'abandon under stress' available"*, and an intraday book is **more** exposed to one, not less, because a halt costs it whole sessions rather than a fraction of a rebalance.
- But the replacement is a **continuous de-lever**, which requires volatility-*targeted* per-trade sizing. ADR-0018 D5 ships a **fixed fraction chosen once per subclass** and names volatility-targeted sizing as *target state*, explicitly noting the Risk Manager has no such rule today. **That is still true after the ladder decision**, because the ladder settles the *exit geometry* and not the *sizing response*.
- So, once armed — once `subclass_of` classifies the instrument and #724 freezes `stop_distance` — the halt remains the **only volatility-responsive mechanism in the system**, and softening it would remove the response rather than smooth it. **Unarmed, it is not.** `subclass_of` is `{}` for `DEFAULT_UNIVERSE` and `SMOKE_TEST_UNIVERSE` today (`subclassOfUniverse`, `orchestrator/types.ts` — neither universe entry carries a `subclass`), so `resolveSubclassBracket` returns `null` for every instrument on those universes and `decide.ts`'s `bracket === null` branch runs instead: `stopDistance = config.atr_k * effectiveVol` floats with ATR, so `size = (equity * riskFraction) / stopDistance` still falls as volatility rises on that path. That pre-ADR-0018 ATR geometry is a live, continuous volatility response, not a frozen one — it just is not this one. The qualifier expires once `subclass_of` is populated ([#751](https://github.com/dd-jp/samurai-trading-system/issues/751)/[#1119](https://github.com/dd-jp/samurai-trading-system/issues/1119)); see `trader-spec.md`'s 2026-09-09 amendment for the mirrored correction on the sizing/exit-geometry side. (Found during #1170's review; spec correction is #1430.)

**The revisit condition is therefore restated in terms of what actually unblocks it**, so it cannot fire prematurely again: revisit when `stop_distance` floats with volatility, at which point `size = (equity × risk_fraction) / stop_distance` becomes volatility-targeted on its own and a continuous de-lever exists to replace the halt. Not when the ladder lands.

**2. The forced end-of-session flatten is specified — and it is not this stage's mechanism.** Flat-by-close is an invariant ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)), fixed at **close − 5 minutes resolved through the instrument's `TradingCalendar`** ([#657](https://github.com/dd-jp/samurai-trading-system/issues/657)). It fires from the Orchestrator's tick path, and it reaches this stage as an **exit**, which means the existing invariant already carries it: **exits skip all entry gates and always pass**. Two things follow, and both are the kind of thing that only shows up in production:

> **The routing this rests on, stated so the tick/decision split cannot quietly break it.** The claim above is not decorative — it is only true while the flatten's exit intent is actually routed through `Risk.evaluate`. Today it is: the flatten becomes an `intent_type: 'exit'` from `Trader.decide` (`server/pipeline/trader/decide.ts`), and the runner's chain is trader → risk → verdict → execution (`server/apps/orchestrator/tick-runner.ts`), so the exit passes through this stage and hits the early return that skips the entry gates (`server/pipeline/risk-manager/index.ts`).
>
> The orchestrator spec's tick-path shorthand — `mark → bracket → early-exit → flatten` — names the *work*, not the call chain, and reads as though the flatten never reaches Risk at all. **It must not become that.** If the built tick/decision split ever routes the flatten straight to Execution, this section's invariant is not violated, it is *vacuous*: the one exit that must never be blocked would be the one exit no gate ever sees, and the guarantee that "no breaker can block the flatten" would be true only by accident of a path nobody wrote down. **The constraint on the split is therefore: exits go through `Risk.evaluate` like everything else, and the protection comes from the exit branch inside it, not from bypassing the stage.** Bypassing would also lose the audit row for the single most consequential order the system places.

- **No breaker, cap, or halt in THIS STAGE may block the flatten.** A tripped breaker that suppressed the flatten would hold a position overnight *specifically because* the book was in trouble — the worst possible time. The `:15` invariant (breakers halt entries, never exits) is what prevents this, which is why it is reaffirmed rather than merely retained. Mechanically it holds because `evaluate()` returns at `intent_type === 'exit'` **before** the `ENTRY_CAP_GATES` loop is entered, so no gate in this stage — and no throw inside one — can reach a flatten.
  > **Stage-scoped, and deliberately so.** Read as a system-wide guarantee this bullet is false, and dangerously: it reads as licence to widen `VerdictImpl`'s `mandatory_flatten` exemption to the `breaker` gate (5), which is the change [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) explicitly refused. That ADR exempts the flatten from Verdict's **staleness gate only** — *"Gates 2–6 are untouched: dedup still stops a repeated flatten double-submitting, and the fire-time breaker re-check still applies."* *(That range is ADR-0014's own numbering, written into its 2026-08-19 amendment — four days AFTER [#641](https://github.com/dd-jp/samurai-trading-system/issues/641) shipped `2a` on 2026-08-15, so it is not a pre-#641 leftover but `server/pipeline/verdict/index.ts`'s own scheme, in which `2–6` runs `drift` through the HITL gate. It has no `2a` in it because an inclusive integer range does not itemize a sub-number, not because it predates one. `stale_feed` is likewise untouched for a **priced** mandatory flatten, and is skipped only under #826's separate `unpriced_exit` exemption.)* It rejects the wider bypass as its candidate (4) — "Make the flatten bypass Verdict entirely", an ADR-0014 candidate number, not a gate number — on the grounds that it *"discards the two protections that are still doing real work for this intent."* The `market_closed` gate (4) likewise still refuses a flatten that reaches Verdict after `sessionEnd`, which that ADR states and calls correct: a shut venue cannot fill. So a tripped breaker CAN stop a flatten one stage later, by design and on the record; what this stage guarantees is that Risk is not the thing that stops it.
- **The min-viable-size reject must not apply to it either.** A flatten of a small residual is still mandatory; rejecting it as dust would leave exactly the overnight position the invariant exists to prevent. Min-viable-size is an **entry-path** gate.

**3. Asset-class caps and buckets lose their second member.** Crypto is out of Samurai's scope ([ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) amendment, 2026-08-16), so `daily_loss_pct_by_class: { crypto, stocks }`, the per-asset-class exposure cap, and `volatility_halt:<class>` all now have one live class. **The tiering is not deleted** — a portfolio-level breaker and a class-level breaker still differ in blast radius — but the dimension that made it useful is now **`subclass`**, not `AssetClass`. See "Concentration, on a universe chosen for co-movement" below, which is where this actually bites.

**Re-keyed, not merely noted, for the volatility halt** *(#724, 2026-08-16)*. `volatility_halt:<class>` **keys on `subclass`**. This is the load-bearing case: at class level a 3× single-stock ETP volatility spike would halt 3× index ETPs along with it, and those two subclasses have measured per-trade sd differing by 2.6× (4.01% vs 1.55%) — the halt would fire on the wrong instruments for the wrong reason. **The halt also becomes the system's whole volatility response, once armed** — because #724 froze `stop_distance` at ADR-0018 D3's per-subclass percentage stop rather than floating it with ATR. Unarmed (`subclass_of` empty, as it is today for `DEFAULT_UNIVERSE`/`SMOKE_TEST_UNIVERSE`), `decide.ts` never reaches the frozen bracket and instead floats `stopDistance` off `atr_k`/ATR, so sizing itself stays volatility-responsive on that path — see the qualifier on item 1's bullet above and `trader-spec.md`'s 2026-09-09 amendment. That trade is accepted deliberately: sizing is flat until the halt fires and zero after, so the response is **discrete rather than continuous**, and the price is paid to keep each required-edge bar exact at its own neutral bracket. **That price has since been measured, and it is not measurable.** [`docs/research/52-exit-geometry-and-subclass-odds.md`](../research/52-exit-geometry-and-subclass-odds.md) prices an ATR-floating stop against the frozen one at **matched mean width** across seven underlyings out of sample: the median gap is ~0.15 pp against ~1.2 pp standard errors, five of seven names favour floating and two favour frozen, which reads as a coin rather than a direction. This does not say ATR is no better — it says the run cannot tell them apart, so the freeze is not being bought at a cost anyone has demonstrated. Uncontrolled for width the same comparison looks decisively pro-ATR, and that entire effect is the denominator; see `trader-spec.md`'s exit model. The revisit condition at line 15 is unchanged and now has a named owner — it fires when `stop_distance` floats, not when the ladder lands.

**Not superseded:** breakers halt entries and never exits (`:15`) — that invariant is horizon-independent, and item 2 above makes it load-bearing in a way it was not before.

> **[ADR-0013](../adr/0013-no-human-gate-anywhere.md) (2026-08-09) removed every remaining human gate, and [#634](https://github.com/dd-jp/samurai-trading-system/issues/634) (2026-08-15) supplied the condition and landed the code.** The hard drawdown breaker **auto-re-arms in every mode**, on one mechanical condition: **drawdown recovering back below `auto_rearm.recovery_drawdown_pct`**. The body below has been drained of the superseded `manual re-arm` language; only the two mode-independent facts survive — breakers halt entries and never exits, and clearing a halt no longer waits on a person.
>
> **The thresholds are a hysteresis band, not a line.** Trip at `max_drawdown_pct` (**0.44**), clear below `recovery_drawdown_pct` (**0.20**), hold in between. The trip sits **above** [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md)'s measured drawdown envelope (26.2% index ETPs / 41.8% single-stock at today's sizing, re-measured by [#729](https://github.com/dd-jp/samurai-trading-system/issues/729) and accepted by [#798](https://github.com/dd-jp/samurai-trading-system/issues/798) — this replaces the older 23.1%/26.2% pair) so the breaker cannot fire on the strategy working as designed; the re-arm edge sits at the top of CONTEXT.md's "~20-25%" design target, so the book resumes only once it is back inside the drawdown it was originally sized for. `CircuitBreakers` refuses a config where the band has zero or negative width. That constrains the band's *width*, not its *level* — it is a relative ordering check, so `max_drawdown_pct: 0.95` with `recovery_drawdown_pct: 0.90` passes it on its own. **GAP-6 / CV-15 (absolute in-code clamps) is closed as of 2026-08-17 ([#638](https://github.com/dd-jp/samurai-trading-system/issues/638)):** an absolute clamp now runs first and refuses that pair, along with any `recovery_drawdown_pct` above ADR-0018's measured envelope or `max_drawdown_pct` above 0.45 — at construction, on every live `risk_thresholds` read, and on every Feedback Loop write. Refused, not coerced. **The ceiling was re-sited from 0.35 to 0.45 on 2026-08-31, David's approval of [#925](https://github.com/dd-jp/samurai-trading-system/issues/925)**, after #798 accepted 41.8% as the operative single-stock tolerance — the old 0.35 ceiling sat below it and forbade siting a trip above the accepted envelope at all; the shipped trip moved from 0.30 (which sat *inside* the 41.8% tolerance, defeating the breaker's purpose) to 0.44. The clamp bounds the *level* from above only; siting the trip **above** the measured envelope stays this spec's obligation, for the reason [cross-spec-contracts.md §9](cross-spec-contracts.md) records under the declined floor. **`auto_rearm.max_days_tripped` remains backtest-only**: elapsed time is not recovery.
>
> **Still open:** ADR-0013 also calls for the **kill-switch** to auto-re-arm. #634 did not specify that half, because nothing in the runtime engages the kill-switch — it has no producer, so it cannot currently trip, and an auto-release condition for an unknown trigger would be invented rather than derived. Tracked separately; the kill-switch's `releaseKillSwitch()` is still the only way out of an engagement.

## Problem Statement

The Trader produces order intents sized on conviction, volatility, and precedent — but sized in isolation, one trade at a time, with no view of what the whole portfolio already holds or how much the account has drawn down. Left unchecked, a run of individually-reasonable orders can pile into correlated exposure, breach the account's risk tolerance, or keep trading straight through a drawdown that should have stopped it. This is where live money is lost.

The Risk Manager (Stage 4) is the gate between the Trader and the Verdict. It applies position-size caps, portfolio and asset-class exposure limits, concentration limits, and drawdown circuit breakers to every order intent — trimming what it can and hard-rejecting what it must — so that no single trade or accumulation of trades can push the account past its risk limits. It is the stage that must be trusted absolutely under stress, which is why it is fully mechanical and deterministic — `evaluate()` is a pure function of its inputs, and no LLM call is ever made inside it (see "Module: Risk Critic" for how an external verdict can enter without breaking that).

## Solution

The Risk Manager is a **deterministic, mechanical gate** (no LLM). It takes an `OrderIntent` from the Trader plus a synchronous view of portfolio state, and runs it through an ordered check pipeline that is **monotonic risk-reducing** — every step can only trim size / tighten a stop or hard-reject, never increase risk. It outputs a `RiskDecision`: approved (possibly modified) or rejected with a binding reason. Rejected intents terminate at Risk (logged); only approved decisions flow to Verdict. Exits always pass through verbatim. Tiered circuit breakers (per-asset-class and portfolio-level) halt new entries — never exits — on daily-loss, drawdown, or consecutive-loss triggers.

Key architectural decisions:
- **Modify-and-reject, monotonic risk-reducing** — trim to fit soft caps, hard-reject on breakers/limits; never add risk.
- **Fully mechanical, deterministic, no LLM** — reproducible and backtestable. This holds for the actual `evaluate()` seam regardless of any external, pre-built verdict threaded onto its input (e.g. `RiskInput.critic`, see "Module: Risk Critic") — the pipeline consumes such a verdict as data, the same way it consumes `cii` and `correlation`; it never constructs a prompt or calls a model itself.
- **Ordered check pipeline** — breakers first, then trims narrowest→broadest, then concentration, then a min-viable-size reject.
- **Circuit breakers halt entries, never exits; tiered; the hard breaker clears on a mechanical recovery condition, in every mode (#634).**
- **Reads a portfolio-accounting view over the shared store** — synchronous, off the Feedback Loop's async path.
- **Rejects terminate at Risk; only approved intents reach Verdict.**
- **CII soft signal is advisory only** — WorldMonitor's Country Instability Index (ADR-0002) rides as a `warnings` field on `RiskDecision`, never trimming, rejecting, or otherwise affecting the pipeline's outcome.

## User Stories

### Gate & Decision

1. As the Risk Manager, I want to consume the Trader's `OrderIntent` (bracket + sizing decomposition + metadata), so that I can evaluate it against portfolio risk.
2. As the Risk Manager, I want to either approve (optionally trimmed) or hard-reject each intent, so that I both fine-tune and veto as appropriate.
3. As the Risk Manager, I want every adjustment to only reduce risk (trim size, tighten stop) and never increase it, so that I am a safe monotonic gate.
4. As the Risk Manager, I want to reject an intent when trimming would push it below a minimum viable position, so that I never forward dust.
5. As the system, I want rejected intents to terminate at Risk with a logged reason, so that only tradeable proposals reach Verdict.
6. As the system, I want a `RiskDecision` recording status, modifications, binding constraint, reasons, and a risk snapshot, so that every decision is auditable.

### Checks & Limits

7. As the Risk Manager, I want to check circuit breakers first and fail fast, so that no new entry passes while a breaker is tripped.
8. As the Risk Manager, I want to trim to a per-trade size cap, so that no single position is oversized.
9. As the Risk Manager, I want to trim to per-asset and per-asset-class exposure caps, so that exposure to one instrument or market stays bounded.
10. As the Risk Manager, I want to trim to a portfolio gross exposure cap, so that total risk-on stays bounded.
11. As the Risk Manager, I want to apply a concentration check using static correlated-asset buckets (v1), so that I don't pile into things that move together.
12. As the Risk Manager, I want the checks applied in a fixed order (breakers → per-trade → per-asset → per-asset-class → portfolio → concentration → min-size), so that the outcome is deterministic and explainable.

### Circuit Breakers

13. As the Risk Manager, I want breakers to halt new entries and scale-ins but never block exits, so that I never trap the account in a losing position.
14. As the Risk Manager, I want tiered breakers (per-asset-class and portfolio-level), so that a problem in one market doesn't necessarily halt everything.
15. As the Risk Manager, I want soft breakers (daily loss, consecutive losses) to auto-reset (next session / after cool-off), so that transient bad runs pause rather than permanently stop trading.
16. As the Risk Manager, I want the hard max-drawdown breaker to stay tripped until the drawdown itself recovers below a lower threshold, so that resuming after a major loss requires evidence of recovery rather than the mere passage of time — and so that it resumes at all, since ADR-0013 leaves nobody to re-arm it by hand.

### State & Data

17. As the Risk Manager, I want to read exposure from the shared position store and equity/drawdown from a portfolio-accounting view, so that my checks reflect real current state.
18. As the Risk Manager, I want to read that state synchronously and independently of the Feedback Loop, so that a risk check never waits on a learning loop.

### Determinism & Kill-Switch

19. As the system, I want the Risk Manager to run the same code path live and in replay, so that backtests exercise real risk behavior.
20. As the system, I want point-in-time state via the injected clock, so that backtests have no lookahead.
21. As the system, I want a mode-flagged auto-re-arm policy for the hard breaker in backtest, so that a backtest doesn't halt forever on the first max-drawdown hit.
22. As the operator, I want a kill-switch (manual or dead-man's) that halts all new entries, so that I can stop new risk instantly; forced liquidation is handled elsewhere.

## Implementation Decisions

### Module: Risk Manager Core

**Responsibilities**
- Consume the Trader's `OrderIntent`; read portfolio state via the injected clock.
- Run the ordered check pipeline (trim or hard-reject at each step; exits skip entry gates).
- Emit a `RiskDecision`; terminate + log rejects; forward approved intents to Verdict.

**Key Interfaces**

```typescript
// Single test seam. Fully deterministic given its inputs — including
// `RiskInput.critic`, which enters as pre-built data (see "Module: Risk
// Critic"); evaluate() never calls an LLM itself.
interface RiskManager {
  evaluate(input: RiskInput): RiskDecision;
}

interface RiskInput {
  trace_id: string;              // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  intent: OrderIntent;           // from the Trader
  clock: Clock;                  // wall-clock live, simulated T in replay
  portfolio: PortfolioView;      // accounting view over the shared store (equity, drawdown, exposure)
  breakers: BreakerState;        // armed/tripped state + peaks, per tier
  next_breaker_state: PersistedBreakerState[];  // lossless sticky-breaker rows (#203) — evaluate() only echoes this, see below
  mode: 'live' | 'paper' | 'backtest';   // consumed by CircuitBreakers.evaluate, not this pipeline. No longer selects manual
                                          // vs auto re-arm for the hard breaker — since #634 the re-arm policy runs in every
                                          // mode (ADR-0013); it now selects only whether `auto_rearm.max_days_tripped`, the
                                          // elapsed-time arm, is honoured, which is backtest-only. Widened to three-way
                                          // 2026-08-17 (#644) to match `execution-spec.md:103` and the code (`RiskInput.mode`,
                                          // `BreakerEvalInput.mode`) — the store provisions one DB file per environment, and
                                          // a two-way union here lied about which environments the system runs in.
  critic?: RiskCriticVerdict;            // pre-built, external — check-pipeline step 7 (see "Module: Risk Critic"). Built and
                                          // wired 2026-09-01 by #957. Added to this interface block 2026-09-02: the field was
                                          // referenced pervasively in this spec's prose from the start but had never actually
                                          // been declared here — see docs/reviews/devils-advocate-spec-cross-verify-2026-09-02.md.
                                          // Since the 2026-09-03 invalidation fold (#994) it ALSO carries the evaluated
                                          // invalidation conditions — there is no separate `invalidation?` field. A previous
                                          // revision of this block declared `invalidation?: InvalidationResult` "ahead of the
                                          // implementation"; that seam never existed in `types.ts` and never will, because
                                          // #997 Q1 folded the conditions onto this verdict instead. See "Module: Risk Critic".
}

// Crash-restart-safe row shape for the two sticky breakers (hard drawdown, kill-switch),
// one row per tier — mirrors the `breaker_state` table (shared-sqlite-store-spec.md).
// Unlike BreakerState (a derived, no-timestamp view recomputed every evaluate() call),
// this is lossless: CircuitBreakers can be reconstructed from it exactly (#203).
interface PersistedBreakerState {
  tier: 'portfolio_drawdown' | 'kill_switch';
  tripped: boolean;
  tripped_at: Date | null;
  reset_at: Date | null;
  reason: string | null;
}

interface RiskDecision {
  status: 'approved' | 'rejected';
  order_intent: OrderIntent | null;   // possibly trimmed; present iff approved
  modifications: {
    original_size: number;
    final_size: number;
    stop_tightened: boolean;
  } | null;
  binding_constraint: string | null;  // e.g. 'per_asset_class_cap', 'circuit_breaker:portfolio_drawdown'
  reasons: string[];                   // machine tags + human text (audit)
  warnings: string[];                  // advisory only, e.g. 'macro_risk_flag:RU', 'correlation_warmup:ETH-USD' — never binding, never overrides status (see CII Soft Signal / Correlation Warm-up Visibility below)
  risk_snapshot: {
    exposure: Record<string, number>;  // per instrument / class / portfolio
    drawdown_pct: number;
    armed_breakers: string[];
  };
  next_breaker_state: PersistedBreakerState[];  // echo of RiskInput.next_breaker_state (#203) — caller persists this to `breaker_state` after every call
}

// Accounting view computed from the shared SQLite store (positions + fills written by
// Execution) PLUS current marks (last price) from the Market Data Service — mark-to-market
// of open positions requires current prices, which fills/entry prices do not provide.
interface PortfolioView {
  equity: number;                // cash + mark-to-market of open positions
  peak_equity: number;           // for peak-to-trough drawdown
  drawdown_pct: number;
  exposure_by_instrument: Record<string, number>;
  exposure_by_class: { crypto: number; stocks: number };
  gross_exposure: number;
  // Since session start, per class: UTC day for crypto, market day for stocks,
  // plus a UTC portfolio-level figure. Resolved GAP-8 / #332 — this replaces a
  // single `daily_pnl_pct: number` sourced from Alpaca's blended `last_equity`.
  //
  // `DailyPnl` is a tagged union, not `number | null`: the daily-loss breaker's
  // test is `pct <= -daily_loss_pct`, and a nullable number coerces there
  // (`null <= -0.05` evaluates `0 <= -0.05`), reading an unknown figure as a
  // flat day and leaving the breaker un-tripped through a real loss.
  //
  // The three figures are measured from DIFFERENT boundaries against DIFFERENT
  // denominators, so they do not sum to one another. No invariant relates them.
  daily_pnl: {
    crypto: DailyPnl;
    stocks: DailyPnl;
    portfolio: DailyPnl;
  };
  consecutive_losses: number;
}
```

### Module: Check Pipeline

Ordered; each step trims or hard-rejects; **exits skip all entry gates and always pass**:

1. **Circuit-breaker gate** — hard-reject new entries if any relevant breaker is tripped.
2. **Per-trade size cap** — trim to `max_position_size`.
3. **Per-asset exposure cap** — trim so total exposure to the instrument ≤ limit.
4. **Per-asset-class exposure cap** — trim so the crypto/stocks bucket ≤ limit.
5. **Portfolio gross exposure cap** — trim so total gross ≤ limit.
6. **Concentration check (dynamic correlation matrix)** — point-in-time pairwise Pearson correlation over trailing returns (`server/pipeline/risk-manager/correlation.ts`), trim to fit the correlated-risk cap. (Implemented per backlog ticket #50 — the "v1 static buckets" description in earlier drafts of this spec was stale; corrected 2026-07-26 during #186's grilling.) A pair with fewer than `min_bars` overlapping returns still cannot bind this cap — the warm-up fallback — but is now reported, see "Module: Correlation Warm-up Visibility" below.
7. **Risk critic (advisory-authority, external verdict)** — consumes an optional, pre-built verdict on `RiskInput.critic`, carrying **two things**: a narrative/qualitative *prose* verdict, and a list of **typed, deterministically-evaluated invalidation conditions** (the 2026-09-03 fold, #994/#997 — the scope statement here read "narrative/qualitative risk only" until then, and that boundary is false now that conditions ride the same verdict). When present, the prose half trims or hard-rejects with the same authority as the mechanical steps above; independently, a `breached` condition hard-rejects with its own `binding_constraint: 'risk_critic:invalidated'`, distinct from the prose `risk_critic:reject`. **The LLM pass this verdict comes from runs entirely outside `evaluate()`** (built by #957) — this step never constructs a prompt or calls a model itself, the same seam `cii` and `correlation` already use, and the conditions it now also carries were validated and evaluated deterministically upstream, never by a model. See "Module: Risk Critic" below for ADR-0003's shape and the producer #957 built for it (`risk-manager/critic.ts`, wired via `RiskStepDeps.critic`). (Added per [ADR-0003](../adr/0003-risk-manager-critic-layer.md).)
8. **Min-viable-size re-check** — if trimming pushed size below viable (respecting broker min order size), reject.

Monotonic: each step only reduces risk. `binding_constraint` records the step that trimmed/killed the intent.

### Concentration, on a universe deliberately chosen for co-movement *(2026-08-16)*

**This is the largest unaddressed risk consequence of the horizon change, and it is a gap this spec has been carrying silently.** [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md) states it plainly: *"Single-name concentration is now the norm… The Risk Manager's correlation and concentration limits were specced against a diversified basket and need re-reading against a universe deliberately chosen for co-movement."* Every check in the pipeline above was written for a book spreading risk across uncorrelated names. **The intraday book does the opposite on purpose** — it screens for names that move, and the movers on any given day tend to move together.

Four consequences, each a decision the implementation must take rather than inherit:

1. **The correlation cap will bind constantly, or it will be tuned until it never binds.** Both are failures. A pool of 3× leveraged ETPs over overlapping US indices has pairwise correlations near 1 by construction — 3USL and a 3× S&P tracker are the same bet at different weights. **The cap must be re-sited against the pool's own correlation distribution**, not against a general-purpose threshold, and the honest version of that number may be "concentration is accepted and bounded by the deployment envelope instead."
2. **The envelope, not the correlation matrix, is the real concentration control.** ADR-0018 D5's per-subclass fractions cap total deployment per subclass; since a subclass is largely one correlated cluster, that cap *is* a correlated-exposure cap with a measured drawdown behind it. The correlation check should be read as a **second-order refinement inside** the envelope, not as the primary defence — which is a reversal of how the pipeline above presents it.
3. **Leverage must not be double-counted — RESOLVED 2026-08-16 by [#721](https://github.com/dd-jp/samurai-trading-system/issues/721): caps bind on NOTIONAL.** This section previously recorded the unit as undecided and blocking. It is decided, and by arithmetic rather than preference: [`docs/research/18-intraday-instrument-physics.md`](../research/18-intraday-instrument-physics.md) scales the underlying US tape **by the ETP leverage factor**, so the 1.55% / 4.01% per-trade sd behind ADR-0018 D5's envelope is the **ETP's own move, with the 3× already inside it**. Every D5 figure is denominated in ETP notional, and leverage-adjusting a cap would count the 3× a second time, sizing every position to roughly a third of what was measured. **The shipped gate is therefore correct as-is and needs no change on this axis** — `intent.size * intent.entry` on one side of the subtraction and `position.filled_size * mark` on the other are both notional. The "~105% effective exposure to the underlying" reading above is a true description and *not* a second unit to cap against; it is what 35% of the leg in a 3× instrument means, and it is inside the measured envelope by construction.
4. **[#381](https://github.com/dd-jp/samurai-trading-system/issues/381)'s dial hazards go live the moment names rotate**, and `universe-selector-spec.md` flags the same surface: `flag_thresholds.size_over: 0` is unit-incommensurable across instruments, and **the correlation and volatility dials go from inert to live** on a rotating list. These were harmless against a fixed six-name universe. They are not harmless now, and they should be read together with this section rather than as separate tickets.

**Resolved 2026-08-17 by [#642](https://github.com/dd-jp/samurai-trading-system/issues/642), per David's ruling on the issue:** this spec's "no LLM"/"fully mechanical, deterministic" claims are the true ones and stand — `evaluate()` is a pure function that never constructs a prompt or calls a model, and a critic verdict can only ever enter as pre-built data on `RiskInput.critic`, the same seam `cii` and `correlation` already use. What was actually wrong was step 7's and "Module: Risk Critic"'s framing, which read as though the pipeline performs the LLM pass itself — both are re-specified below to state the seam explicitly, and "Module: Risk Critic" recorded that no producer for that verdict existed. **That last clause is now historical: [#957](https://github.com/dd-jp/samurai-trading-system/issues/957) built the producer (`risk-manager/critic.ts`) on 2026-09-01, per [#955](https://github.com/dd-jp/samurai-trading-system/issues/955) under map #513.** #642's resolution is unaffected and still binding — the producer runs OUTSIDE `evaluate()` and hands its verdict in as data, which is precisely the seam that ruling preserved.

### The deployment envelope is the concurrency rule *(2026-08-16)*

**There is no explicit position-count cap, and there should not be one.** Admission runs until the subclass envelope is reached: the Risk Manager admits an entry while `deployed + next_size <= subclass_cap`, and trims or refuses past it.

**`subclass_cap` is ADR-0018 D5's fraction of CURRENT EQUITY, netted across the subclass — 35% for `index_etp_3x`, 25% for `single_stock_etp_3x`, and `null` (no measured envelope) for crypto.** At ADR-0015's £750 leg that is ~£262.50 and ~£187.50 **at inception only**; the config carries the *fraction* and the gate resolves it against `portfolio.equity` — the equity read of the decision being evaluated — on every decision.

**Fixed cash was rejected, and the reason is directional** *(#721, 2026-08-16)*. A frozen £262 is 34.9% of a £750 book, 43.7% of £600 and 58.2% of £450 — exposure rises as a fraction of equity exactly as equity falls, so the drawdown bound stops bounding at the first loss. The fractional form is self-correcting, and it also makes D5's recorded envelope **conservative**: doc 18's ladder rows describe fixed-cash deployments, and since fractional sizing shrinks exposure after a loss, cumulative loss is strictly smaller. **26.2% / 41.8% are upper bounds for this rule, not estimates of it** (re-measured by [#729](https://github.com/dd-jp/samurai-trading-system/issues/729), accepted by [#798](https://github.com/dd-jp/samurai-trading-system/issues/798) — supersedes the older 23.1%/26.2% pair).

**A rename is not enough to land this.** A fraction and a cash amount are both `number`, so nothing in the type system distinguishes `0.35` from `262`. The test must assert the cap **moves with equity** — same intent, two different equity reads, two different `allowedAdditional` — because that is the only assertion a fixed-cash regression cannot also pass.

Stating the netting matters because the two readings of this section differ by a factor of two, and only one of them is what the gate computes: the fraction is the **total** deployed to the subclass, not a per-position allowance. `perSubclassDeploymentCap` sums exposure across every instrument in the subclass and offers the REMAINDER as `allowedAdditional`, precisely so that entry-at-35% followed by scale-in-at-35% cannot both be admitted.

~~Emergent concurrency is therefore ~2 index ETPs at ~35% each, or ~3 single-stock ETPs at ~25% each.~~ *(Corrected 2026-08-16 — "at ~35% each" contradicts the netting above and would deploy twice the measured envelope, voiding the index drawdown figure the fraction was measured to hold, now 26.2% post-[#729](https://github.com/dd-jp/samurai-trading-system/issues/729) — was 23.1% at the time of this correction.)* **Emergent concurrency is `subclass_cap / min_viable_size`, and the positions SHARE the envelope**: two index ETPs held at once are ~17.5% of the leg each, three are ~11.7% each. The count is therefore a consequence of the min-viable floor below, not a second dial — which is the whole point of not having a position-count cap. Monitoring a 5–10 name watchlist while holding 2–3 is the intended shape, and it falls out of the sizing rule rather than needing a second dial that could disagree with it.

Two things this makes newly load-bearing:

- **A minimum viable position size, below which the Risk Manager refuses rather than trims.** Step 8 already specifies a min-viable-size *re-check*, and story 4 already says "so that I never forward dust" — so this is an obligation the spec already carries, now with a sharper reason. Trimming a third simultaneous signal into the remaining envelope room can emit an uneconomic sliver, and a residual small enough still pays the full round trip, so its expectancy is **strictly negative regardless of signal quality**. The floor is **injected config, never a constant** — the cost figure it is derived from is still ADR-0018's single quote: [#666](https://github.com/dd-jp/samurai-trading-system/issues/666), which would have measured it, closed 2026-08-27 out of scope without delivering that measurement; [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) now gates on it instead, and [#1053](https://github.com/dd-jp/samurai-trading-system/issues/1053) (open) owns delivering it.
- **A refusal must be distinguishable from a rejection on conviction.** Record `below_minimum_size` as the `binding_constraint`, distinct in `risk_log` from a conviction reject. Otherwise a tick where the envelope was full reads identically to a healthy no-trade tick — **the exact signature that hid [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) (96 debates, 0 trades) and [#691](https://github.com/dd-jp/samurai-trading-system/issues/691)**. This system's recurring failure is not a crash; it is a silent no-op that looks fine.

### Module: Circuit Breakers

- **Metrics** (from `PortfolioView` + market data): daily-loss % (soft, per-session; portfolio + per-asset-class), peak-to-trough drawdown % (hard; trips at 44%, re-arms below 20% — #634, sited against ADR-0018's envelope (26.2% index / 41.8% single-stock, [#729](https://github.com/dd-jp/samurai-trading-system/issues/729)/[#798](https://github.com/dd-jp/samurai-trading-system/issues/798)); trip re-sited from 30% by David's 2026-08-31 approval of [#925](https://github.com/dd-jp/samurai-trading-system/issues/925), since 30% sat inside the accepted 41.8% single-stock tolerance. CONTEXT.md's "~20-25%" is that envelope's design target, which is why it is still the RE-ARM edge and not the halt line), max consecutive losses (soft, cool-off), and a **volatility halt** (soft, per-asset-class) — pause new entries when realized/implied volatility spikes abnormally above a baseline (research docs list "volatility halts" as a circuit breaker; complements the Trader's vol-floor *sizing* with a hard *entry halt* in extreme regimes). A **latency/error halt** (operational) is folded into the kill-switch path — repeated execution errors or stale data trip the same halt-new-entries state.
- **Effect:** halt new entries + scale-ins; **never block exits**.
- **Scope:** tiered — a per-asset-class breaker halts new entries for that class; a portfolio breaker halts all new entries.
- **Reset:** soft breakers auto-reset (next session / after cool-off); the hard drawdown breaker re-arms on the configured recovery threshold **in every mode** (#634, ADR-0013). `mode` no longer selects manual vs auto — it selects only whether `auto_rearm.max_days_tripped`, the elapsed-time arm, is honoured, and that is `backtest` only. An explicit `reArm()` remains as an operator override for a drawdown stuck inside the band (a bad `peak_equity` snapshot, say); it overrides the band's lower edge only, since the trip test runs first in every `evaluate()`.
- **Session boundary:** UTC day for crypto, market-day for stocks.
- **Two-tier daily loss (#333, decision 4 of [#329](https://github.com/dd-jp/samurai-trading-system/issues/329)):** `BreakerConfig.daily_loss_pct_by_class: { crypto, stocks }` sits beside the portfolio-level `daily_loss_pct`. A per-class breach sets `asset_class_tripped[class]` and halts that class only — joining `volatility_halt:<class>`, which is already this pattern — while a portfolio-level breach still sets `portfolio_tripped` and halts everything. Surgical halting is **added, not swapped in**: the account-wide floor survives. All three figures share one denominator (portfolio equity), so both thresholds sit on one scale and neither needs re-tuning against the other; the figures do *not* sum, because each is measured over its own session boundary. Both tiers are non-sticky, recomputed per `evaluate()`.
- **Unknown daily figure blocks (#333, decision 5):** `DailyPnl` is a `{ known: true, pct } | { known: false, reason }` union precisely so an absent figure cannot coerce to `0` and read as a flat day. A `known: false` figure **halts new entries** at its tier and arms `daily_pnl_unknown:<tier> (<reason>)`. This is safe to halt on because the tier is non-sticky: it clears at the next session boundary the process is up for. The mode gate decision 5 describes lives in `AccountStateProvider.midSessionBase`, not in the breaker: on the cold-start path `paper`/`backtest` report against a mid-session base and warn, and only `live` reports unknown. But that is not the only route to `known: false` — `nonPositiveBase` returns unknown in **every** mode, because a percentage against a zero or negative session-open equity has no meaning to gate on. A `paper` run can therefore present an unknown, and the breaker treats unknown uniformly rather than re-testing `mode` and handing that case a silent pass.
- Exact thresholds are config, tuned in paper trading — **within the in-code bounds** of [cross-spec-contracts.md §9](cross-spec-contracts.md) (#638). The drawdown, re-arm and daily-loss thresholds each carry a hard maximum enforced in code; a config beyond it is refused at construction and on every live read, never clamped down to fit.
- **Crash-restart persistence (#203):** the two sticky breakers (hard drawdown, kill-switch) are the only breaker state that must survive a process restart — losing it would silently re-arm a breaker that halted trading for a reason. `CircuitBreakers.evaluate()` stays a pure, synchronous function; it does not persist anything itself. `CircuitBreakers` instead exposes `getPersistedState(): PersistedBreakerState[]` (one row per tier) for the caller to write to the `breaker_state` table (shared-sqlite-store-spec.md) after every `evaluate()`/`reArm()`/`engageKillSwitch()`/`releaseKillSwitch()` call, and accepts the same rows as an optional constructor argument to reconstruct sticky state on startup instead of starting from `hardTripped = false`. The four stateless breakers (daily-loss, consecutive-loss, both volatility halts) need no persistence — they're recomputed fresh from `PortfolioView` every call.

### Module: CII Soft Signal

Adopted per [ADR-0002](../adr/0002-worldmonitor-mi-source.md) (WorldMonitor as a Market Intelligence source). WorldMonitor's Country Instability Index (CII, 0–100 per country) enters the Risk Manager as an **advisory warning, never a gate or a sizing input**. v1 scope, resolved in [CII soft-signal policy grilling — #174](https://github.com/dd-jp/samurai-trading-system/issues/174):

- **Warning-only, no position-size scaling in v1.** No CII-driven sizing formula is implemented yet — no historical CII series exists at any WorldMonitor tier to calibrate one against (see ADR-0002 §6). Deferred to v2, once [#182](https://github.com/dd-jp/samurai-trading-system/issues/182)'s post-launch CII snapshot capture yields real history. *(The concentration check itself is no longer part of this deferral — backlog #50 already shipped the dynamic correlation matrix described in Check Pipeline step 6 above.)*
- **Samurai owns a static instrument→country/region mapping** (e.g. Russian ADRs → RU, energy majors → Middle East), independent of and not trusting WorldMonitor's own tagging — this mapping is a fixed lookup table, unrelated to the concentration check, which is the dynamic pairwise-correlation matrix described in Check Pipeline step 6 above, not the "v1 static buckets" this section's earlier draft named.
- **Surfaces as the advisory `warnings` field on `RiskDecision`** (e.g. `macro_risk_flag:RU`) — travels with the exact decision it's context for, no separate side-channel event or new plumbing.
- **Fires on absolute CII level, not delta.** A sustained high-risk exposure warns every cycle it's evaluated, not just at the moment of a jump.
- **Threshold ("CII > N") is an unpinned config value**, tuned in paper trading — same convention as every other Risk Manager threshold.
- **Never overrides a circuit breaker or the check pipeline's approve/reject/trim outcome, no exceptions.** The CII check runs alongside the pipeline (informational), not as one of its ordered steps — it cannot trim, reject, or otherwise change `order_intent`.

### Module: Correlation Warm-up Visibility

Resolved 2026-08-05 via [#303](https://github.com/dd-jp/samurai-trading-system/issues/303) (raised as M11 in `code-review-2026-08-01.md` / L2 in `code-review-security-2026-08-01.md`). **Option (b) — surface it — was chosen.**

The gap: check-pipeline step 6 reads an instrument absent from `CorrelationEstimate.correlations` as not correlated. That is the intended warm-up fallback, established with the #50 implementation in `server/pipeline/risk-manager/correlation.ts` — the alternative is fabricating a correlation from too little data. But *absent* and *measured at ~0* were the same observation to every caller, so a portfolio with no overlapping history at all was byte-for-byte indistinguishable from a genuinely diversified one. That window — a newly listed instrument, or day 1 of a run — is exactly when the system opens its first positions with the concentration cap silently inert. It stops being hypothetical with [#381](https://github.com/dd-jp/samurai-trading-system/issues/381)'s widening to the six-instrument ADR-0001 universe, where on day 1 every one of the fifteen pairs is under `min_bars`.

> **Citation note.** `correlation.ts` and `index.ts` credited this fallback to "risk-manager-map.md AC3". That anchor never existed — `docs/wayfinder/risk-manager-map.md` predates #50, carries a "Decisions so far" bullet list rather than numbered acceptance criteria, and still describes the concentration check as v1 static buckets. The fallback is real; only the pointer was wrong. **Both source comments now point here instead** (corrected in #303, on review — the diff had already rewrapped the sentence carrying the dead anchor, so leaving it would have been the worst of both). The one remaining map reference in `correlation.ts`'s header is a general stage pointer, the same convention `breakers.ts` uses for "Breaker thresholds & definitions" — that section does exist and is not affected.

- **`CorrelationEstimate.insufficient_history: string[]`** carries the held instruments dropped for want of overlap, alongside `correlations`. Populated by `computeCorrelationEstimate`; present-but-empty means every pair was measurable. **Pair-scoped, not instrument-scoped:** overlap is `min(target, other)`, so the thin side may be the intent's own instrument — a brand-new listing sized against long-established holdings names every one of them. Read an entry as "correlation with X is unmeasurable", never "X is new". The tick runner's log line therefore carries the intent's instrument explicitly, so the pair is unambiguous on the page.
- **`evaluate()` emits one `correlation_warmup:<instrument>` tag per uncovered pair** on the advisory `warnings` field — the same field, and the same never-gates-never-sizes contract, as the CII soft signal above. It appears on every decision path including exits and breaker rejections.
- **No limit and no sizing behaviour changed.** An uncovered pair still cannot bind the concentration cap; the trim arithmetic is untouched. The change is purely one of visibility, which is what makes it verifiable and reversible.
- **Consumer:** `SequentialTickRunner` (`server/apps/orchestrator/tick-runner.ts`) raises a second, `warn`-level structured log line for the risk stage whenever a `RiskDecision` carries warnings. Before this, `RiskDecision.warnings` had **no production reader at all** — including the CII flag, live since #205 — it rode along inside the risk stage's `info` payload and nothing ever raised it. Deliberately warning-agnostic rather than correlation-specific: the CII flag had the same problem and the same fix serves both.
- **Reports transitions, not state, and marks itself `advisory: true`.** The line is emitted only when an instrument's warning set *changes*: `warn` while warnings stand, `info` when they clear, always with `payload.advisory: true` so a generic pipeline can exclude it by field. **An earlier revision of this section argued the opposite** — that a per-tick repeat was fine because the line does not go through `SAMURAI_ALERTS`. That reasoning was wrong and was rejected on review: a log pipeline paging on `level:warn` never sees `SAMURAI_ALERTS`. Costed against `DEFAULT_TICK_INTERVAL_MS` (60s), six instruments repeating every tick is ~8,640 `warn` lines a day — and since `min_bars: 20` on a `1d` timeframe needs 20 trading days, the condition does not clear inside a 14-day run (#238). *(The paper profile has since moved to `tickIntervalMs: 2 * 60_000` — 2 minutes, ADR-0014's tick/decision split; it passed through 15 min under [ADR-0008](../adr/0008-llm-spend-cap.md) and an earlier revision of this line froze it there. At 2 min six instruments repeating every tick is ~4,320 `warn` lines a day, not 576. The fix stands on its own — 576 identical repeats of a condition that cannot clear is still the whole log, and the 60s default is what any run not using the paper profile still gets.)* That is not a noisy log, it is the whole log, and an operator who scrolls past thousands of identical warns stops reading warns and then misses the stuck fill. #362 fixed this exact defect at startup.
- **Nothing is lost by the suppression.** The state is still logged every single tick: the tick runner's `record('risk', ...)` writes the whole `RiskDecision`, `warnings` included, into its `info` payload. The advisory line's only job is to raise a *change*; "what is true now" is answered by the per-tick record. This preserves the CII soft signal's "fires every cycle it's evaluated" property, which is a statement about `RiskDecision.warnings` — unchanged — not about log volume.
- **Clearing is announced once, at `info`.** If the warn simply stopped, an operator would have only an absence, indistinguishable from the reader having broken; a single transition line makes completed coverage a positive statement. `info` rather than `warn` because good news must never page.
- **Not a once-per-process latch.** `production.ts` uses that shape for its inert-divergence warn, but that describes a frozen config; this describes a transient state whose *contents* matter. Keying on the warning set per instrument means a peer gaining coverage while another has not is still surfaced.
- **Options rejected.** *(a) document only* — a stated blind spot is not adequate handling when it is about to become six-instrument-wide on day 1 of the #238 soak. *(c) assume a conservative rho for uncovered pairs* — changes sizing on a guessed number, and no source exists for the assumed asset-class average it would need. Revisit (c) only once #182-style history collection gives a calibratable series, alongside the same v2 upgrade the CII sizing formula waits on.

### Module: Risk Critic

Adopted per [ADR-0003](../adr/0003-risk-manager-critic-layer.md) (Risk Manager gains a single red-team critic), resolved via [#186](https://github.com/dd-jp/samurai-trading-system/issues/186) grilling. Answers the question `../research/16-risk-debate-finding.md` raised: the mechanical checks (including the now-dynamic correlation concentration check, step 6) cover quantitative risk well; this module was originally scoped to the narrative/qualitative risk they structurally cannot express, **and since the 2026-09-03 invalidation fold it carries a second, deterministic half as well** — see "The invalidation fold" below, which restates this scope boundary rather than leaving it as "narrative/qualitative only".

- **The LLM pass, if it exists, is never inside `evaluate()`.** This is the load-bearing fact for "Fully mechanical, deterministic, no LLM" in the Solution above: whatever produces a critic verdict — a prompt, a model call, its own retry/timeout handling — runs as a separate step *before* `RiskManager.evaluate()` is called, and hands its result in as plain data on `RiskInput.critic`. `evaluate()` reads `critic.verdict`/`critic.max_notional`/`critic.reasoning` exactly like it reads `cii` and `correlation` — it does not know, and cannot tell, whether the value came from a model, a replayed log row, or a test fixture.
- **Scope: single critic, not a 3-persona debate.** The Debate Engine (Stage 3) already spends the multi-persona-adversarial-tension budget; a second full debate in Stage 4 is redundant given how narrow the blind spot is. One LLM pass, framed as "argue why this trade should be trimmed or rejected."
- **Trigger: every gated `OrderIntent`, single-pass, no rebuttal round.** Runs regardless of whether the mechanical steps already trimmed the intent — a narrative-risk trade can pass every quantitative check clean, which is the scenario this module exists to catch. No second round arguing with itself.
- **Authority: trim or hard-reject**, inserted as check-pipeline step 7 — the same authority as every mechanical step, not a separate gate and not conviction-modulation (architecturally unreachable from Stage 4: conviction is consumed by the Trader in Stage 3, before Risk ever sees the intent). Per the pipeline's monotonic invariant, a hard-reject from the critic is the *safe* direction, no different in kind from a circuit breaker trip.
- **Determinism, as specified: replay-from-log, not a live call in backtest.** In `live`/paper mode, the critic is specified to make a real LLM call (outside `evaluate()`, per the seam above) and persist its verdict + reasoning keyed by `debate_id` (shared with `debate_log` and `cosine_setups`, per [#162](https://github.com/dd-jp/samurai-trading-system/issues/162)). In `backtest` mode, step 7 is specified to read the logged verdict instead of re-calling the LLM — preserving the same-code-path-live-and-replay invariant (Determinism & Kill-Switch module) and keeping Stage 2's PBO/DSR/MinBTL statistics valid.
- **Built and wired 2026-09-01 by [#957](https://github.com/dd-jp/samurai-trading-system/issues/957)**, per [#955](https://github.com/dd-jp/samurai-trading-system/issues/955)'s "build it" resolution under map [#513](https://github.com/dd-jp/samurai-trading-system/issues/513). The producer is `server/pipeline/risk-manager/critic.ts`: `LlmRiskCriticProducer` in `live`/`paper`, `ReplayRiskCriticProducer` in `backtest` (which holds NO LLM client, so "no live call in a replayed path" is structural rather than a runtime check), selected by `buildRiskCriticProducer` and wired onto `RiskStepDeps.critic` in `production.ts`. Verdicts persist to `risk_critic_log` (migration 0032, `SqliteRiskCriticStore`) keyed by `debate_id`. Spend meters into `llm_spend` under `stage: 'risk_critic'` through the same `LlmClient` and the same ADR-0008 `SpendCap` as the debate — **no critic-specific cap**, per #955 (~1-2 calls/day, ~$1/yr at the measured $0.0015/call).
- **Cadence, and how the caller knows step 7 was reached.** `buildRiskStep` evaluates ONCE with no verdict — pure, synchronous, no I/O — and consults the critic only if that pass pushed `RISK_CRITIC_SKIPPED_REASON`, which is exactly the marker of reaching step 7. It then re-evaluates with the verdict; only the second decision is logged and returned, so one intent still writes one `risk_log` row. This keeps `evaluate()` pure (#642) while firing on precisely the population #955 specifies: every viable entry that survived the exit bypass, the unvalued-book refusal, the breaker gate and the `min_viable_size` reject. Exits, breaker rejections and dust refusals cost nothing.
- **Fail-open, by record.** Every producer-side failure — provider error, spend-cap refusal, unreadable answer, the producer's own 10s budget expiring in front of the order, **or a failure to PERSIST a verdict the model did return** — yields NO verdict, so the decision keeps its explicit `risk_critic: skipped` reason and the mechanical steps remain the safety net (#640's precedent). Where the log is reachable a row is still written with `verdict: 'unavailable'` for the operator and so a later backtest replays the same "no verdict" input the live run had. A `debate_id` with no logged row replays the same way, never as a fresh call. **The persistence case is not an exception to that, it is an instance of it:** a verdict with no row is a verdict the replay cannot see, so acting on it live would put the live decision on a path no backtest can reproduce — the same-code-path-live-and-replay invariant below, broken silently and only for the trades taken while the store was down. The verdict is discarded and the write failure logged at `warn`; a store fault still never throws out of the risk stage.
- **Prompt/context contract (was "not yet decided").** One pass, framed "argue why this trade should be trimmed or rejected", told which risks the mechanical steps already cover and told that "pass" is a complete answer. It sees the intent (side, instrument, notional, bracket, conviction, convergence) and the book (equity, gross exposure, held instruments and their notionals) — the co-catalyst read §1 names as the blind spot. The reply is JSON, validated field by field: a `trim` needs a finite `max_notional` above zero (a non-finite one would pass `applyCritic`'s comparison and the later size guards as `NaN`), reasoning is bounded before it reaches `risk_log`, and anything unreadable is refused into the fail-open path rather than half-acted-on. Dashboard surfacing of verdicts remains out of scope (#957). Since the 2026-09-03 fold the same reply also carries the raw invalidation conditions — see "Module: Risk Critic — the invalidation fold" for the contract, and note that a malformed conditions half never voids the prose verdict.

### Module: Risk Critic — the invalidation fold *(2026-09-03)*

David ruled 2026-09-02 *"fold this to risk critic"*: no standalone `invalidation` stage ships, and the typed, falsifiable invalidation-condition mechanism designed in [`devils-advocate-spec.md`](devils-advocate-spec.md) (preserved verbatim as the declined-proposal record) becomes part of this module instead. The design questions the ruling left open were resolved by grilling ticket [#997](https://github.com/dd-jp/samurai-trading-system/issues/997) on 2026-09-02; **this section records those answers, it does not re-decide them.** Implementation is [#994](https://github.com/dd-jp/samurai-trading-system/issues/994).

The load-bearing rule is carried over unchanged from `devils-advocate-spec.md`: **the LLM names what to check; deterministic code does the checking, so a model cannot produce a breach — only propose a condition.**

#### Scope — what step 7 is now (#997 Q1: one LLM call, separate deterministic evaluator)

Neither "merge everything into `critic.ts`" nor "a second sibling producer". Only condition *emission* is LLM work; the validator and the tri-state evaluator are deterministic code, and they resolve differently:

- **`critic.ts`'s existing single LLM call emits prose *and* raw conditions.** No second pass and no second parser-fed call — that honours #513's argument that the step-7 seam must not accumulate LLM passes, and keeps the ~$1/yr envelope #955 accepted.
- **The validator and the tri-state evaluator live in their own module** (`server/pipeline/risk-manager/invalidation.ts`), not inside `critic.ts`. Deterministic evaluation stays unit-testable in isolation and out of the module this spec defines as the qualitative-judgement pass.
- **`RiskCriticVerdict` gains `conditions?: EvaluatedCondition[]` and `dropped_conditions?: DroppedCondition[]`.** `evaluate()` reads them as plain data, exactly as it reads `cii` and `correlation` — [ADR-0003](../adr/0003-risk-manager-critic-layer.md)'s "no LLM inside `evaluate()`" invariant is untouched. There is **no** `RiskInput.invalidation` field and no `InvalidationResult` transported into Risk; conditions ride the critic's verdict.

Consequence, stated plainly because it is a deliberate reversal: **step 7 is no longer "narrative/qualitative risk only".** That boundary was set deliberately in ADR-0003 and it is false under this answer — the check-pipeline entry and the Resolved Decisions list are amended to match.

#### The typed condition contract

```typescript
type InvalidationObservable =
  | { kind: 'indicator'; spec: IndicatorSpec }          // reuses IndicatorSpec verbatim (cross-spec-contracts §3)
  | { kind: 'mark' }
  | { kind: 'bars'; window: BarWindow; measure: 'volume_ratio' };

interface InvalidationCondition {
  id: string;
  observable: InvalidationObservable;
  comparator: '<' | '<=' | '>' | '>=';
  threshold: number;
  /** Why this falsifies the thesis. Free text, audit only — never machine-read. */
  rationale: string;
}

interface EvaluatedCondition {
  condition: InvalidationCondition;
  state: 'breached' | 'not_breached' | 'unevaluable';
  /** The measured value the state was derived from; null iff unevaluable. */
  observed: number | null;
}

interface DroppedCondition {
  /** The emitted `id` where one could be read, else null. */
  id: string | null;
  /** What the model said, bounded, for audit. */
  raw: string;
  reason: 'unparseable' | 'unknown_observable' | 'unknown_indicator' | 'lookback_too_large'
        | 'threshold_out_of_range' | 'direction_incoherent' | 'over_cap';
}
```

**The `mi_context` observable from `devils-advocate-spec.md` is NOT carried over.** The Risk step reads marks, bars and indicators off the Market Data Service it already holds (`correlation.ts`, `portfolio-view.ts`); it holds no Market Intelligence context store, and the fold explicitly adds no new data dependency. A condition naming an observable outside the three above is dropped `unknown_observable`.

**No severity, weight or confidence, and no `thesis_holds`** — carried over from `devils-advocate-spec.md` unchanged. Nothing model-assigned may flow into sizing or enforcement, and the derived answer is computed at the point of use. `state` is likewise **not** readable from the model's output: the raw-parse shape structurally has no `state` field, so a model emitting `"state":"breached"` changes nothing.

#### The 3-5 condition cap, and both of its bounds

The upper bound is enforced, the lower bound is not:

- **More than 5 surviving conditions:** the excess is dropped (in emission order, keeping the first 5) with reason `over_cap`. A checklist longer than 5 is not one a human reads.
- **More than 16 emitted elements:** only the first 16 are *inspected*. The accepted ceiling bounds what is enforced; it does not bound the audit trail, and every refusal becomes a `DroppedCondition`, a `risk_log` reason line and JSON in `risk_critic_log`. Validating the whole array would make the model's emission length the only limit on all three, so a looping or hostile emission of 1000 elements writes 1000 of each. Past the inspection bound the remainder is recorded as **one** summarising `over_cap` drop naming the uninspected count and the emitted total — the flood stays auditable without being amplified.
- **Fewer than 3:** **recorded, not dropped.** Discarding a valid 2-condition set would be the same safety regression as discarding the prose verdict — the system would enforce *less* than it does with the conditions present. The count is persisted and surfaced so a systematically thin prompt is visible — the producer emits a `warn` log line naming the accepted count and every drop reason at the moment of emission, and `evaluate()` records the same facts as `risk_log` reason lines. It never voids the conditions that did survive.

#### Validator drop rules

Deterministic, between parse and evaluation, and every drop is persisted with its reason (`devils-advocate-spec.md` user story 23):

1. **`unparseable`** — the emitted element is not a readable condition object (missing/blank `id`, non-numeric or non-finite `threshold`, unknown comparator, absent `rationale`). Malformed output is refused, never coerced.
2. **`unknown_observable`** — the `kind` is not one of `indicator` / `mark` / `bars`, i.e. it does not bind to a service the Risk Manager can already read deterministically at decision time.
3. **`unknown_indicator`** — the named indicator is not in the Market Data Service's `INDICATOR_KINDS` registry.
4. **`lookback_too_large`** (#994 review, PR #1067) — an indicator's `spec.lookback` or a bars observable's `window.lookback` exceeds `MAX_INVALIDATION_LOOKBACK` (1000 bars, chosen comfortably above `technical-analyst.ts`'s `RVOL_5M_LOOKBACK` = 936, the largest lookback any existing caller requests on this path). Refused at validation, before it can reach `observe()` and trigger an unbounded `getBars`/indicator read on the path an order is waiting on — `withinDeadline` races that read against the budget but does not cancel it.
5. **`threshold_out_of_range`** — the threshold falls outside the observable's declared valid range (an RSI condition thresholded at 140 can only ever be permanently breached or permanently not). Ranges are declared as a `Partial<Record<IndicatorKind, …>>`, so **an indicator kind with no declared range falls through un-dropped**; adding a kind to `INDICATOR_KINDS` must never become a trade-blocking event.
6. **`direction_incoherent`** — the condition would fire when the thesis is *working* rather than failing. Per-observable direction semantics, declared in code, **not** a naive side↔comparator mapping (`devils-advocate-spec.md` gives the counterexample):

   | Observable | Which direction means "thesis failing" |
   | --- | --- |
   | `mark`, price-like indicators (`sma`, `ema`) | Opposite the intent's side — `<`/`<=` for a `buy`, `>`/`>=` for a `sell`. |
   | Momentum indicators (`rsi`) | Opposite the intent's side. |
   | `bars` / `volume_ratio` | Always `<`/`<=` — conviction is falsified by *thinning* participation regardless of side. |
   | Any other indicator kind | Undeclared. **Not dropped by this rule**, falls through to the others. |

7. **`over_cap`** — see the cap above.

A dropped condition is **dropped, not breached**. If dropping empties the list, the result is reported exactly as a zero-condition emission (`no_conditions`); one code path for "nothing checkable came out", regardless of cause.

#### Evaluation — tri-state, mechanical

Each surviving condition is evaluated once, at `asOf` = the producer's decision time, against the same Market Data Service seams the rest of the Risk step reads. `unevaluable` is **derived mechanically, never judged**: the read threw, returned no value, or returned fewer bars than the measure needs. There is no discretionary path into it, and `observed` is `null` exactly when the state is `unevaluable`.

#### Failure matrix (#997 Q2a — partial-tolerant)

| What happened | Prose verdict | Conditions | Enforcement |
| --- | --- | --- | --- |
| Call returns, prose parses, conditions parse and survive | Stands, full trim/reject authority | `EvaluatedCondition[]` | Prose trims/rejects; a `breached` condition hard-rejects |
| Call returns, prose parses, conditions absent / unparseable / all dropped | **Stands, full trim/reject authority** | `no_conditions` (empty or absent list) | Prose only; conditions have **no** enforcement effect |
| Call returns, **prose** unreadable | Refused → `unavailable` → `undefined` | Discarded with it | Today's fail-open path, unchanged: `risk_critic: skipped` |
| Whole call fails (provider, timeout, spend cap, persistence) | `unavailable` → `undefined` | none | Today's fail-open path, unchanged |
| A surviving condition is `unevaluable` | Unaffected | Reported `unevaluable` | **No enforcement effect** — a data gap never blocks a trade |

The rationale for row 2 is the binding one: discarding a valid `reject` because the *advisory* half of the response was malformed would make the system strictly **less** safe than it is today. **Binding condition on that answer:** drop reasons and `no_conditions` are persisted and surfaced on `RiskDecision.reasons` (`devils-advocate-spec.md` user stories 23 and 52). Without that, a systematically malformed prompt degrades silently into "conditions never fire" and hides for a month.

#### Enforcement (#997 Q2b — `evaluate()` enforces, the producer reports facts)

A `breached` condition rejects **even when the prose verdict says `pass`**. The producer does **not** overwrite the verdict: it reports `verdict: 'pass'` alongside `conditions: [{ state: 'breached', … }]`, and `evaluate()` reads the array and rejects with its own distinct `binding_constraint`:

- **`risk_critic:invalidated`** — a breached condition, i.e. the thesis was falsified before the order was placed.
- **`risk_critic:reject`** — the prose verdict said reject. Unchanged.

Two reasons the producer must not pre-compute the rejection: the persisted row keeps what the LLM actually *said* (a pre-computed reject destroys that), and the two rejection causes stay separable in the logs, so "how often do prose and predicates disagree?" remains an answerable question. This is ADR-0003's seam exactly — producer supplies data, `evaluate()` holds authority — and `evaluate()` stays pure and deterministic given its inputs.

**Ordering inside step 7:** the condition summary (states, drops, `no_conditions`) is pushed onto `reasons` *before* the prose branch, so it is recorded on every path including a prose reject and a clean pass. The prose branch then runs first and the breach check second, which means `risk_critic:invalidated` names precisely the disagreement case — a prose verdict that did not itself reject, overruled by a measured predicate.

#### Two failure domains, one budget

The conditions step runs **outside** the LLM call's `try`. A throw anywhere after the prose parse — including from the reporting path itself — must not reach the catch that returns `unavailable`, because that catch would void a prose `reject` the model had already produced, the one outcome Q2a forbids. Logging is wrapped defensively for the same reason: a log sink that throws is not a reason to lose a verdict.

The producer's budget (`budgetMs`, default `DEFAULT_CRITIC_BUDGET_MS`) spans **both** halves. Its `AbortSignal` is handed to the evaluator, and a read still outstanding when the budget expires is a data gap like any other: `unevaluable`, no enforcement effect. Without this the market-data reads run unbounded in front of an order the tick is waiting on.

#### Persistence and replay (#997 Q3 — absent `conditions` = `no_conditions`)

`RiskCriticLog` persists the whole verdict (`risk_critic_log`, migration 0032). The fold adds two **nullable** columns for the evaluated conditions and the drops; the field is additive and optional, and **there is no backfill**.

- **A row written before the fold has no `conditions`, and neither does one whose persisted list is unreadable.** The store validates the SHAPE of every persisted element on read — observable kind, comparator, finite threshold, a `state` inside the tri-state union, `observed` null iff `unevaluable`. A cast would let `[{}]` throw inside `evaluate()` and let `[{"state":"breached"}]` hard-reject a trade with nothing measured behind it, which is the "a model cannot produce a breach" rule defeated by the storage layer. Either way it replays as an empty list reported `no_conditions` only when **no element survives** — the *same code path* a total failure produces regardless of cause; a row that is only partially corrupt replays with its surviving elements rather than collapsing whole (see the sub-bullets below). The prose verdict replays with the authority it always had, so **historical backtest results are unchanged by the fold**. Rejected alternatives: synthesising an `unevaluable` set fabricates a condition that never existed (forbidden by "derived mechanically, never judged", and worth nothing since `unevaluable` and `no_conditions` have identical zero enforcement effect); refusing to replay pre-fold rows breaks every backtest spanning the fold date with nothing truthful to backfill from.
  - **Tightened on read, 2026-09-03 (#1068).** Bot review on #1067 raised three times that the shape check above was more lenient than it looked: `readPersistedConditions` rejected only `unparseable` from the indicator-spec reader (so a persisted `lookback` above `MAX_INVALIDATION_LOOKBACK` still replayed, even though the validator has refused that same shape on *emission* since PR #1067), and the `bars` branch checked `measure` but never validated `window` at all. Both are now checked in full: a `bars` observable needs a well-formed `window` (`readBarWindow`, same rule the validator applies), and an indicator `lookback` over the cap is refused on read exactly as it is on emission.
  - **Per-element, not whole-list, since the tightening (#1068).** Before this date, ANY malformed element collapsed the whole persisted list to `no_conditions`, discarding well-formed siblings along with the corrupt one. `readPersistedConditions` now drops only the elements that fail the tightened shape check and keeps the surviving subset; the row reports `no_conditions` only when **nothing** survives. This is still never a hard reject and never a silent accept of a breach — a `DroppedCondition`-shaped element and a `[{"state":"breached"}]` element are both simply absent from the replayed list — it just no longer punishes a well-formed condition for a corrupt neighbour. `readPersistedDroppedConditions` (the `dropped_conditions` audit column) is audit-only with zero enforcement effect either way, so it keeps the all-or-nothing rule rather than being validated element-wise. Every way a `conditions_json` row can be malformed — unparseable JSON, a non-array payload, or a partially-corrupt array — logs one `warn` through the store's own logger seam, naming the debate id and a reason (or the emitted/survived/dropped counts for a partial drop), never the row's raw content; a `stored === null` column is not malformed and never logs. `readPersistedConditions` itself stays a pure function with no logger parameter, so this is the store (`critic-store.ts`) detecting each malformed case independently, not the reader reporting on itself.
  - **One deliberate leniency survives the tightening: registry drift on `kind`.** A persisted indicator `kind` that has since left `INDICATOR_KINDS` is still accepted when everything else about the element is well-formed, so a historical row replays to the decision it produced when the state was actually measured. This is NOT the same relaxation as before #1068 — the pre-tightening reader was lenient on `lookback_too_large` too, which is now rejected — it is a narrower, permanent exception: the registry is allowed to change under a historical row; the read-time safety caps are not.
  - **An emitted-but-empty list is not touched by the tightening.** `readPersistedConditions([])` returns `[]`, never `no_conditions` — `writeJsonList` (`critic-store.ts`) writes "nothing was ever emitted" as `NULL` and "everything was dropped at validation time" as `[]` specifically so the two stay distinguishable in the row, and the read side has to honour that distinction rather than collapsing an empty-but-well-formed array into the same bucket as an unreadable one.
  - **The shape check is shared with the live path, and the sharing is a no-op.** `isEvaluatedCondition` — the per-element predicate the tightening lives in — is the same function `breachedConditions` calls to gate `binding_constraint: 'risk_critic:invalidated'` on every mode, not only `backtest`. In practice the tightening changes nothing for a live-produced condition: `validateConditions` (emission side) has rejected an over-cap `lookback` and a malformed `bars` `window` since PR #1067, so no condition a live/paper run emits can fail the read-time check that #1068 adds. The smoke suite's measured-breach-rejects gate (`smoke-run.test.ts`) is the check that this stays true.
- **The `backtest` producer replays the persisted `EvaluatedCondition[]` and does not re-evaluate.** This is a **deliberate deviation** from `devils-advocate-spec.md`'s split-by-nondeterminism-source design (emission replayed, evaluation re-run), and it is recorded here rather than left to be discovered: under the fold the persisted unit is the *verdict*, ADR-0003 §2 makes the verdict replay-from-log, and re-running evaluation would require handing the backtest producer the Market Data Service it deliberately holds none of — the same structural property that makes "no live LLM call in a replayed path" true by construction rather than by a runtime check. It also gives the replay property #997 set as an acceptance criterion, stated precisely: a replayed decision is **identical in status, size and `binding_constraint`** to the one the live run reached. `reasons` is not byte-identical and is not meant to be — a pre-fold row gains exactly one line, the `no_conditions` marker, because a replayed row that enforces nothing must say so rather than read like a checked one. **Its cost, stated:** a validator or evaluator fix does **not** retroactively apply to already-logged post-fold rows; only newly-emitted conditions get the corrected behaviour.

#### Prompt safety

The conditions half inherits the pass's existing posture: all data blocks are wrapped by `wrapUntrusted` before interpolation, and an injected instruction is **structurally incapable of producing a false breach** — the model can only propose a condition, the validator can only drop it, and the state comes from a measured read. The worst an injection can do is degrade the checklist to `no_conditions`, which is persisted and surfaced rather than silent.

#### Deliberately out of scope for the fold

- **No new pipeline stage and no stage rename.** `PIPELINE_STAGES` stays six ([#998](https://github.com/dd-jp/samurai-trading-system/issues/998) retired the seventh slot on the strength of this same Q1 answer).
- **No dashboard rendering of conditions** beyond the existing critic surface. The dashboard drawer held a reserved section at the time; wiring it was follow-up work, not this fold — shipped since by [#1066](https://github.com/dd-jp/samurai-trading-system/issues/1066), and in the v3 client it lives in `client/src/components/TraceSections.tsx`'s gates section.
- **No `invalidation_log` table, no `(instrument, bar_timestamp)` content-addressed retrieval, no `BacktestReport` attestation, and no dedicated invalidation reject alert.** All four belong to the standalone stage that was declined; conditions ride `risk_critic_log`'s `debate_id` key with the verdict they were emitted beside.

### Module: State & Accounting

- A small **portfolio-accounting module** computes the `PortfolioView` from the shared SQLite store (positions + fills written by Execution) **plus current marks (last price) from the Market Data Service**: equity = cash + mark-to-market of open positions, drawdown = peak-to-trough of the equity curve, notional exposure = `OpenPosition.filled_size × current mark` (freeze §4 — always reads `filled_size`, **never requested size**, so partially-filled positions are marked at what was actually filled). The *realized* components (round-trip PnL, consecutive losses) come from fills alone; only the *unrealized* mark-to-market components need current prices.
- Risk reads this **synchronously**, independent of the Feedback Loop (which reads the same data for its slower tuning, but is never in Risk's hot path).
- **Dependency:** this makes the Risk Manager a consumer of the **Market Data Service** via **two calls** (freeze §3): `getMark(instrument, asOf)` for current/last price (mark-to-market of open positions) **and** `getIndicator(instrument, spec, asOf)` for the **volatility-halt baseline** (the realized/implied-volatility reference the volatility circuit breaker trips against). Alongside the Analysts (`getBars`/`getIndicator`) and Verdict (`getMark`). The Market Data Service is built (`server/providers/market-data-service/`); its scope covers serving current/last price for mark-to-market and indicators for the volatility baseline.
- **Also a consumer of Market Intelligence's WorldMonitor adapter** (via its `cii-consumer.ts`, ADR-0002) for the CII soft signal — a separate, lower-frequency read than the Market Data Service dependency above, feeding the CII Soft Signal module.

### Module: Upstream Read Failure

Resolved 2026-08-15 by [#640](https://github.com/dd-jp/samurai-trading-system/issues/640) (cross-verify CV-2), which had been carried unresolved across three verification passes. This stage bills itself as "the one that must be trusted absolutely under stress"; that claim was previously unbacked by any stated failure behaviour.

**Correcting the premise first, because it changes where the rule lives.** `evaluate()` performs **no upstream reads**. It is synchronous and pure, and receives `portfolio`, `breakers`, `correlation` and `cii` already computed. So "what does `evaluate()` do when `getMark` fails" has no answer because the question does not apply to it. The reads happen where `RiskInput` is assembled — `computePortfolioView`, `computeCorrelationEstimate`, and the account/volatility providers — and that is where the rule binds.

- **A read that FAILS already fails closed, and this is now stated rather than incidental.** A rejected promise from any of those reads propagates out of the risk step, aborts that instrument's pass, and places no order; the tick loop logs it and the next tick retries. Rejecting a good trade costs one opportunity, and the alternative — proceeding on a portfolio view we could not compute — could breach every cap at once.
- **A read that SUCCEEDS with a stale value was the real gap.** `getMark` answering is not evidence the feed is alive: in live it may serve from a TTL cache, and a halted or thin instrument keeps returning its last trade indefinitely. `computePortfolioView` previously read `mark.price` and discarded `mark.observed_at` entirely, so a frozen price silently froze **every** limit derived from it — gross and per-class exposure, drawdown, and daily PnL, which is to say the drawdown and daily-loss breakers stopped updating during exactly the conditions that trip them.
- **Rule:** `computePortfolioView` **throws `StaleMarkError`** when a held instrument's mark is older than `RiskConfig.max_mark_age[asset_class]`, or is observed *ahead* of the reading clock (a clock disagreement, not a fresh price). It refuses to produce a view at all rather than valuing the book partially — a partial view is not a conservative one.
- **The asset class comes from the POSITION, not from the returned `Mark.asset_class`**, so a mis-routed or mis-labelled mark cannot select a more permissive bound for itself.
- **Availability cost, accepted explicitly** (this is the part that needed a ruling, not a default): a genuinely flaky mark feed will stop the system trading, and under [ADR-0013](../adr/0013-no-human-gate-anywhere.md) nobody is watching when it does. That is the intended trade. The bound is therefore set to fire on "stopped", not on "thin" — ADR-0016's LSE leveraged ETPs go minutes between prints in normal sessions, and a gate that fires on ordinary illiquidity is one an operator learns to ignore.
- **Same bound, separate field from `VerdictConfig.max_mark_age`.** Declining one trade and refusing to compute the book's exposure are different-weight actions; see `cross-spec-contracts.md` §3.
- **AMENDED 2026-08-18 by [#841](https://github.com/dd-jp/samurai-trading-system/issues/841): the refusal above is the ENTRY path's, and only the entry path's.** Everything stated in this section holds when an order is being OPENED. On the EXIT path the same refusal was the un-conservative outcome: it suppressed the flatten, and because `computePortfolioView` enumerates every held instrument, ONE dark or stale name blocked the flatten of the entire book — including names whose marks were fresh — leaving a leveraged ETP ([ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md)) on overnight against [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)'s flat-by-close invariant. Sizing an entry needs the whole book priced; flattening a position already held does not, and `evaluate()` returns at `intent_type === 'exit'` before any gate reads `portfolio` at all. So an exit now takes `PortfolioAccountingInput.unvaluable_marks: 'exclude'`: the unvaluable positions are left out of every figure and named in `PortfolioView.unvalued_instruments`. Three guards keep that from widening anything: the composition root requests it for an exit intent only (`buildRiskStep`/`buildVerdictStep`, direct-bind.ts); `evaluate()` REJECTS any entry or scale-in whose view carries a non-empty `unvalued_instruments`, binding constraint `unvalued_book`; and the degraded path never calls `CircuitBreakers.evaluate()` or persists `breaker_state`, because a partial view understates equity and would trip — and stick — the hard drawdown breaker off a late mark. The degradation is never silent: both seams log at `error` and post `ExitValuationDegradedAlertChannel`, the fifteenth `ALERT_CHANNEL_FIELDS` member.
- **AMENDED 2026-08-27 by [#939](https://github.com/dd-jp/samurai-trading-system/issues/939): "observed *ahead* of the reading clock" above is not a bare `age < 0`.** `asOf` is the tick's START instant, and marks are read some milliseconds or seconds later in the same pass, so a live-stamped mark (e.g. `AlpacaDataSource`'s `observed_at: new Date(quote.t)`) legitimately lands after `asOf` on every busy tick — that is pipeline latency, not two clocks disagreeing. `isMarkStale` (`mark-freshness.ts`) now tolerates a mark up to `MARK_FORWARD_TOLERANCE_MS` (5s) ahead of the reading clock before treating it as a clock disagreement and refusing the pass; only beyond that bound does the original rule apply. The tolerance is a fixed constant shared by both `RiskConfig.max_mark_age` and `VerdictConfig.max_mark_age` callers, not a per-asset-class config. **Both symbols are superseded by the #1111 amendment directly below** (`isMarkStale` → `classifyMarkFreshness`, `MARK_FORWARD_TOLERANCE_MS` → `MARK_CLOCK_SKEW_TOLERANCE_MS`); neither exists in the codebase any more.
- **AMENDED 2026-09-05 by [#1111](https://github.com/dd-jp/samurai-trading-system/issues/1111): the forward tolerance above is no longer the mechanism, because the artifact it bounded is not a constant.** #939's 5000ms was calibrated against two observations of 149ms and 1083ms; the 2026-09-04 paper session produced 67 refusals between 5020ms and 144576ms ahead of `asOf`, none of them a mark past its own age bound, because the valuation's own mark batch was taking minutes. Freshness is now judged at the instant the marks were RECEIVED (`PortfolioAccountingInput.clock`, read once after the batch resolves — the instant the view actually values the book), not at the tick's `asOf`, which keeps its meaning unchanged as the point-in-time coordinate the reads are made against. `classifyMarkFreshness` replaces `isMarkStale` and returns `fresh` / `stale` / `ahead` rather than a boolean, so `StaleMarkError` reports the fault it actually found: `MARK_CLOCK_SKEW_TOLERANCE_MS` (still 5s) now bounds receipt-side slop only, and a mark ahead of the READ instant genuinely is a venue-vs-us clock disagreement at any pass duration. The change is stricter in the stale direction — `readAt` is never earlier than `asOf` — so #640's refusal is tightened, not weakened.

### Module: Determinism & Kill-Switch

- Same code path live vs replay; all state read point-in-time via the injected clock.
- `mode` flag selects only whether the hard breaker's elapsed-time re-arm applies (`backtest`); the recovery condition applies in all three (#634).
- **Kill-switch** (manual or dead-man's): global halt on new entries + scale-ins (like a portfolio hard breaker), released by `releaseKillSwitch()`. ADR-0013 asks for this half to auto-re-arm too and #634 did not supply the condition — see the banner. **Nothing engages it today**, so it cannot currently trip. **Forced liquidation is out of scope** — Risk stops new risk; a separate emergency module or Execution flattens positions if desired.

## Testing Decisions

### What Makes a Good Test

- Test at the `RiskManager.evaluate(input)` seam: given an intent + a mocked `PortfolioView`/`BreakerState` + mock clock, assert on the `RiskDecision`.
- No LLM to mock — assert deterministic outputs.
- Cover each pipeline step's trim and hard-reject paths, and the exit-always-passes path.
- Cover breaker trip/reset (soft auto-reset, hard manual vs auto re-arm by mode).
- Cover sticky-breaker persistence (#203): a fresh `CircuitBreakers` instance constructed from a persisted trip/kill-switch engagement reports the same tripped/engaged state as before the (simulated) restart.

### Modules to Test

**Check Pipeline** — each cap trims correctly; ordering is deterministic; `binding_constraint` names the right step; trimming below min-size → reject; exits bypass gates.

**Circuit Breakers** — each metric trips at threshold; halts entries not exits; tiered scope; soft auto-reset; the hard breaker's hysteresis band (trips at `max_drawdown_pct`, holds inside the band, clears below `recovery_drawdown_pct`) in every mode, and the elapsed-time arm in `backtest` only (#634).

**State & Determinism** — same input → same decision; point-in-time reads never see future fills.

**CII Soft Signal** — warning fires at absolute CII level above threshold, not on delta; warning never appears in `binding_constraint` or changes `status`/`order_intent`; instrument→country mapping resolves correctly for static test fixtures.

**Risk Critic** — backtest mode reads the logged `debate_id`-keyed verdict, never calls the LLM (assert no network/LLM-client call in a mock-clock backtest run); a trim/reject verdict updates `binding_constraint` to `risk_critic`; a pass verdict leaves the intent unchanged; runs on every gated intent regardless of prior pipeline trims.

### Prior Art

- No implementation yet. Injected-clock / mock-clock patterns mirror the Trader, Analysts, and Market Intelligence specs. Deterministic-output assertions (no LLM mock) mirror the Trader spec.

## Out of Scope

**Trader sizing (Stage 3)** — Risk only reduces; it never re-derives a size.

**Verdict & Execution** — the final go/no-go and order placement are downstream. Risk forwards approved intents; Verdict decides go/no-go.

**Forced liquidation** — Risk halts new risk on kill; flattening open positions is a separate emergency module / Execution concern.

**Feedback Loop (Stage 6)** — tuning of limits/thresholds. Risk reads current thresholds/state; it does not compute the tuning.

**Exact limit values** — the notional caps are config, tuned in paper trading; not fixed here. **The breaker thresholds are config *within a bound*:** `max_drawdown_pct`, `auto_rearm.recovery_drawdown_pct` and the three daily-loss tiers each have a hard maximum enforced in code, and a value beyond it is refused rather than coerced (#638). The bounds, their sources and what is deliberately *not* bounded are recorded once in [cross-spec-contracts.md §9](cross-spec-contracts.md).

**CII-driven position-size scaling** — v1 CII is warning-only; a `(1 - ciiDelta × k)`-style scaling formula is deferred pending real CII history from [#182](https://github.com/dd-jp/samurai-trading-system/issues/182).

**Risk critic dashboard surfacing** — the prompt/context contract and the fail-open behaviour were decided and shipped by [#957](https://github.com/dd-jp/samurai-trading-system/issues/957) (see "Module: Risk Critic"); surfacing its verdicts in the dashboard beyond the `risk_log` reasons and the `llm_spend` row is still deferred.

## Further Notes

### Integration with Pipeline

```
Trader → Risk Manager → Verdict → Execution
       (this spec)
Execution → shared store (positions/fills) → portfolio-accounting view → Risk (reads)
```

### Domain Glossary Alignment

Per CONTEXT.md:
- **Risk Manager**: "Gate between Trader and Verdict. Applies position-size caps, max drawdown circuit breakers, portfolio exposure limits. Can override Trader's recommendation with a hard 'no.'"
- **Circuit Breaker**: "Hard stop when a metric crosses a threshold… Must be testable without live market data." — satisfied by the mechanical, mock-clock-testable breakers.
- **Dead-Man's Switch**: silence triggers alert — the kill-switch path halts new entries.

### New Component: Portfolio-Accounting View

Risk introduces a small portfolio-accounting module (equity/drawdown/exposure over the shared store). It is shared infrastructure — the Feedback Loop reads the same numbers. Worth a CONTEXT.md glossary entry.

### Future Extensions

- Per-strategy risk budgeting once multiple strategies run concurrently.
- Volatility-scaled exposure caps (tighten caps in high-vol regimes).
- CII-driven position-size scaling, once [#182](https://github.com/dd-jp/samurai-trading-system/issues/182) yields real CII history to calibrate against.

## Resolved Decisions (Sources)

Wayfinder decisions for this stage live in [docs/wayfinder/risk-manager-map.md](../wayfinder/risk-manager-map.md) (charted locally). Decisions synthesized here:

- **Output & authority** — modify-and-reject, monotonic risk-reducing; rejects terminate at Risk, only approved reach Verdict; `RiskDecision` shape.
- **Architecture** — fully mechanical, deterministic, no LLM. Step 7 (added later per [ADR-0003](../adr/0003-risk-manager-critic-layer.md)) admits an external, pre-built critic verdict as data — the same seam as `cii`/`correlation` — never a model call inside `evaluate()`. The producer is wired since #957 — `risk-manager/critic.ts`, called by `buildRiskStep` between two `evaluate()` passes (see "Module: Risk Critic").
- **Check pipeline & precedence** — ordered breakers→per-trade→per-asset→per-asset-class→portfolio→concentration→risk critic→min-size; concentration uses the dynamic correlation matrix (#50, implemented; corrected from an earlier "static v1 buckets" description).
- **Circuit breakers** — halt entries not exits; tiered; three metrics (daily-loss, peak-to-trough drawdown, consecutive losses); soft auto-reset / hard recovery-threshold re-arm in every mode (#634); UTC-day vs market-day sessions.
- **State & data** — portfolio-accounting view over the shared store, read synchronously off the Feedback Loop path.
- **Backtest determinism** — same code path; point-in-time via injected clock; the only mode-flagged breaker behaviour left is the elapsed-time re-arm arm (#634).
- **Exit & kill-switch** — exits pass verbatim; kill halts new entries; forced liquidation out of scope.
- **CII soft signal** (resolved 2026-07-23, see [ADR-0002](../adr/0002-worldmonitor-mi-source.md) and [#174](https://github.com/dd-jp/samurai-trading-system/issues/174)) — WorldMonitor's Country Instability Index enters as an advisory `warnings` field on `RiskDecision`, warning-only in v1 (no sizing), Samurai-owned static instrument→country mapping, fires on absolute level not delta, unpinned threshold, never overrides breakers or the pipeline outcome.
- **Correlation warm-up visibility** (resolved 2026-08-05, see [#303](https://github.com/dd-jp/samurai-trading-system/issues/303)) — option (b): under-`min_bars` pairs are named in `CorrelationEstimate.insufficient_history` and surfaced as `correlation_warmup:<instrument>` advisory warnings, read by `SequentialTickRunner` as a `warn` log line. No limit or sizing behaviour changes; the warm-up fallback itself is unchanged. See "Module: Correlation Warm-up Visibility".
- **Risk critic** (resolved 2026-07-26, see [ADR-0003](../adr/0003-risk-manager-critic-layer.md) and [#186](https://github.com/dd-jp/samurai-trading-system/issues/186)) — a single red-team LLM pass added as check-pipeline step 7, trim/hard-reject authority, replay-from-log for backtest determinism, runs on every gated intent single-pass with no rebuttal round. Scoped to "narrative/qualitative risk only" until the 2026-09-03 fold below, which is why that phrase no longer appears here.
- **Invalidation fold** (resolved 2026-09-02 by David's *"fold this to risk critic"* ruling and grilling ticket [#997](https://github.com/dd-jp/samurai-trading-system/issues/997); implemented by [#994](https://github.com/dd-jp/samurai-trading-system/issues/994)) — no standalone `invalidation` stage; `devils-advocate-spec.md`'s typed invalidation-condition mechanism rides the critic's own verdict. One LLM call emits prose *and* raw conditions; a separate deterministic module validates and evaluates them tri-state; `evaluate()` hard-rejects a `breached` condition with `risk_critic:invalidated`, distinct from the prose `risk_critic:reject`; a malformed conditions half leaves the prose verdict's authority intact (`no_conditions`); an absent `conditions` field on a pre-fold row replays as `no_conditions`. See "Module: Risk Critic — the invalidation fold".

**Dependencies:** the portfolio-accounting view + shared position store (also used by the Trader, #48); the **Market Data Service** (built — current marks for mark-to-market, plus, since the #994 invalidation fold, marks/indicators/bars read by the *critic producer* outside `evaluate()`; a consumer alongside Analysts and Verdict); the Feedback Loop (Stage 6, not yet charted) which tunes limits; **Market Intelligence's WorldMonitor adapter** (CII soft signal, per ADR-0002); and the **shared SQLite store's `debate_id`-keyed log tables** (risk critic verdict persistence, per ADR-0003 and #162).
