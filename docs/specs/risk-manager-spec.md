# Risk Manager Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

> **PARTIALLY SUPERSEDED — the recorded Stage 0 thesis changed horizon on 2026-08-09 ([#632](https://github.com/dd-jp/samurai-trading-system/issues/632), map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631)).** `CONTEXT.md`'s debate-as-edge thesis is now recorded at an **intraday, flat-by-close** horizon. Read the following as pending re-derivation:
>
> - **The hard drawdown breaker — RESOLVED 2026-08-15 by [#634](https://github.com/dd-jp/samurai-trading-system/issues/634)**, see the next banner. The inherited ~20-25% figure came from `docs/research/10-edge-hypothesis.md`'s −23% pre-accepted drawdown on the **superseded weeks-to-months** horizon; it is replaced by a 30%/20% band sited against ADR-0018's *measured* intraday envelope. A full intraday drawdown *commitment* (what the book promises, as opposed to where it halts) is still [#653](https://github.com/dd-jp/samurai-trading-system/issues/653).
> - **The binary volatility halt (`:170`) stays binary for now — #634, 2026-08-15.** The contest is real (doc 12: "the most extreme form of 'abandon under stress' available"; an intraday book required to trade daily is *more* exposed to a binary halt, not less), and the answer is a continuous de-lever. But that answer is blocked, not merely unbuilt: [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) ships a fixed fraction chosen **once** per subclass from measured volatility, and names volatility-*targeted* per-trade sizing as target state with "The Risk Manager has no such rule today." Until that rule exists ([#654](https://github.com/dd-jp/samurai-trading-system/issues/654)'s ladder needs it), the halt is the **only** volatility-responsive mechanism in the system, and softening it would remove the response rather than smooth it. Revisit when #654 lands.
> - **A forced end-of-session flatten** is now required and is not specified here. See [#657](https://github.com/dd-jp/samurai-trading-system/issues/657).
>
> **Not superseded:** breakers halt entries and never exits (`:15`) — that invariant is horizon-independent and still holds.

> **[ADR-0013](../adr/0013-no-human-gate-anywhere.md) (2026-08-09) removed every remaining human gate, and [#634](https://github.com/dd-jp/samurai-trading-system/issues/634) (2026-08-15) supplied the condition and landed the code.** The hard drawdown breaker **auto-re-arms in every mode**, on one mechanical condition: **drawdown recovering back below `auto_rearm.recovery_drawdown_pct`**. The body below has been drained of the superseded `manual re-arm` language; only the two mode-independent facts survive — breakers halt entries and never exits, and clearing a halt no longer waits on a person.
>
> **The thresholds are a hysteresis band, not a line.** Trip at `max_drawdown_pct` (**0.30**), clear below `recovery_drawdown_pct` (**0.20**), hold in between. The trip sits **above** [ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md)'s measured drawdown envelope (23.1% index ETPs / 26.2% single-stock at today's sizing) so the breaker cannot fire on the strategy working as designed; the re-arm edge sits at the top of that envelope, so the book resumes only once it is back inside the drawdown it was sized for. `CircuitBreakers` refuses a config where the band has zero or negative width. That constrains the band's *width*, not its *level* — it is a relative ordering check, so `max_drawdown_pct: 0.95` with `recovery_drawdown_pct: 0.90` still passes. **GAP-6 (absolute in-code clamps on config values) stays open**, and matters more now that nothing is cleared by hand. **`auto_rearm.max_days_tripped` remains backtest-only**: elapsed time is not recovery.
>
> **Still open:** ADR-0013 also calls for the **kill-switch** to auto-re-arm. #634 did not specify that half, because nothing in the runtime engages the kill-switch — it has no producer, so it cannot currently trip, and an auto-release condition for an unknown trigger would be invented rather than derived. Tracked separately; the kill-switch's `releaseKillSwitch()` is still the only way out of an engagement.

## Problem Statement

The Trader produces order intents sized on conviction, volatility, and precedent — but sized in isolation, one trade at a time, with no view of what the whole portfolio already holds or how much the account has drawn down. Left unchecked, a run of individually-reasonable orders can pile into correlated exposure, breach the account's risk tolerance, or keep trading straight through a drawdown that should have stopped it. This is where live money is lost.

The Risk Manager (Stage 4) is the gate between the Trader and the Verdict. It applies position-size caps, portfolio and asset-class exposure limits, concentration limits, and drawdown circuit breakers to every order intent — trimming what it can and hard-rejecting what it must — so that no single trade or accumulation of trades can push the account past its risk limits. It is the stage that must be trusted absolutely under stress, which is why it is fully mechanical and deterministic.

## Solution

The Risk Manager is a **deterministic, mechanical gate** (no LLM). It takes an `OrderIntent` from the Trader plus a synchronous view of portfolio state, and runs it through an ordered check pipeline that is **monotonic risk-reducing** — every step can only trim size / tighten a stop or hard-reject, never increase risk. It outputs a `RiskDecision`: approved (possibly modified) or rejected with a binding reason. Rejected intents terminate at Risk (logged); only approved decisions flow to Verdict. Exits always pass through verbatim. Tiered circuit breakers (per-asset-class and portfolio-level) halt new entries — never exits — on daily-loss, drawdown, or consecutive-loss triggers.

Key architectural decisions:
- **Modify-and-reject, monotonic risk-reducing** — trim to fit soft caps, hard-reject on breakers/limits; never add risk.
- **Fully mechanical, deterministic, no LLM** — reproducible and backtestable.
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
// Single test seam. Fully deterministic given its inputs.
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
  mode: 'live' | 'backtest';     // selects manual vs auto re-arm for the hard breaker
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
7. **Risk critic (advisory-authority)** — a single red-team LLM pass over the intent, narrative/qualitative risk only; may trim or hard-reject, same authority as the mechanical steps above. See "Module: Risk Critic" below. (Added per [ADR-0003](../adr/0003-risk-manager-critic-layer.md).)
8. **Min-viable-size re-check** — if trimming pushed size below viable (respecting broker min order size), reject.

Monotonic: each step only reduces risk. `binding_constraint` records the step that trimmed/killed the intent.

### Module: Circuit Breakers

- **Metrics** (from `PortfolioView` + market data): daily-loss % (soft, per-session; portfolio + per-asset-class), peak-to-trough drawdown % (hard; trips at 30%, re-arms below 20% — #634, sited against ADR-0018's envelope. CONTEXT.md's "~20-25%" is that envelope's design target, which is why it is the RE-ARM edge and not the halt line), max consecutive losses (soft, cool-off), and a **volatility halt** (soft, per-asset-class) — pause new entries when realized/implied volatility spikes abnormally above a baseline (research docs list "volatility halts" as a circuit breaker; complements the Trader's vol-floor *sizing* with a hard *entry halt* in extreme regimes). A **latency/error halt** (operational) is folded into the kill-switch path — repeated execution errors or stale data trip the same halt-new-entries state.
- **Effect:** halt new entries + scale-ins; **never block exits**.
- **Scope:** tiered — a per-asset-class breaker halts new entries for that class; a portfolio breaker halts all new entries.
- **Reset:** soft breakers auto-reset (next session / after cool-off); the hard drawdown breaker re-arms on the configured recovery threshold **in every mode** (#634, ADR-0013). `mode` no longer selects manual vs auto — it selects only whether `auto_rearm.max_days_tripped`, the elapsed-time arm, is honoured, and that is `backtest` only. An explicit `reArm()` remains as an operator override for a drawdown stuck inside the band (a bad `peak_equity` snapshot, say); it overrides the band's lower edge only, since the trip test runs first in every `evaluate()`.
- **Session boundary:** UTC day for crypto, market-day for stocks.
- **Two-tier daily loss (#333, decision 4 of [#329](https://github.com/dd-jp/samurai-trading-system/issues/329)):** `BreakerConfig.daily_loss_pct_by_class: { crypto, stocks }` sits beside the portfolio-level `daily_loss_pct`. A per-class breach sets `asset_class_tripped[class]` and halts that class only — joining `volatility_halt:<class>`, which is already this pattern — while a portfolio-level breach still sets `portfolio_tripped` and halts everything. Surgical halting is **added, not swapped in**: the account-wide floor survives. All three figures share one denominator (portfolio equity), so both thresholds sit on one scale and neither needs re-tuning against the other; the figures do *not* sum, because each is measured over its own session boundary. Both tiers are non-sticky, recomputed per `evaluate()`.
- **Unknown daily figure blocks (#333, decision 5):** `DailyPnl` is a `{ known: true, pct } | { known: false, reason }` union precisely so an absent figure cannot coerce to `0` and read as a flat day. A `known: false` figure **halts new entries** at its tier and arms `daily_pnl_unknown:<tier> (<reason>)`. This is safe to halt on because the tier is non-sticky: it clears at the next session boundary the process is up for. The mode gate decision 5 describes lives in `AccountStateProvider.midSessionBase`, not in the breaker: on the cold-start path `paper`/`backtest` report against a mid-session base and warn, and only `live` reports unknown. But that is not the only route to `known: false` — `nonPositiveBase` returns unknown in **every** mode, because a percentage against a zero or negative session-open equity has no meaning to gate on. A `paper` run can therefore present an unknown, and the breaker treats unknown uniformly rather than re-testing `mode` and handing that case a silent pass.
- Exact thresholds are config, tuned in paper trading.
- **Crash-restart persistence (#203):** the two sticky breakers (hard drawdown, kill-switch) are the only breaker state that must survive a process restart — losing it would silently re-arm a breaker that halted trading for a reason. `CircuitBreakers.evaluate()` stays a pure, synchronous function; it does not persist anything itself. `CircuitBreakers` instead exposes `getPersistedState(): PersistedBreakerState[]` (one row per tier) for the caller to write to the `breaker_state` table (shared-sqlite-store-spec.md) after every `evaluate()`/`reArm()`/`engageKillSwitch()`/`releaseKillSwitch()` call, and accepts the same rows as an optional constructor argument to reconstruct sticky state on startup instead of starting from `hardTripped = false`. The four stateless breakers (daily-loss, consecutive-loss, both volatility halts) need no persistence — they're recomputed fresh from `PortfolioView` every call.

### Module: CII Soft Signal

Adopted per [ADR-0002](../adr/0002-worldmonitor-mi-source.md) (WorldMonitor as a Market Intelligence source). WorldMonitor's Country Instability Index (CII, 0–100 per country) enters the Risk Manager as an **advisory warning, never a gate or a sizing input**. v1 scope, resolved in [CII soft-signal policy grilling — #174](https://github.com/dd-jp/samurai-trading-system/issues/174):

- **Warning-only, no position-size scaling in v1.** No CII-driven sizing formula is implemented yet — no historical CII series exists at any WorldMonitor tier to calibrate one against (see ADR-0002 §6). Deferred to v2 alongside the correlation-matrix concentration upgrade (backlog #50), once [#182](https://github.com/dd-jp/samurai-trading-system/issues/182)'s post-launch CII snapshot capture yields real history.
- **Samurai owns a static instrument→country/region mapping** (e.g. Russian ADRs → RU, energy majors → Middle East), independent of and not trusting WorldMonitor's own tagging — lives alongside the v1 static concentration buckets (Check Pipeline step 6).
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
- **Reports transitions, not state, and marks itself `advisory: true`.** The line is emitted only when an instrument's warning set *changes*: `warn` while warnings stand, `info` when they clear, always with `payload.advisory: true` so a generic pipeline can exclude it by field. **An earlier revision of this section argued the opposite** — that a per-tick repeat was fine because the line does not go through `SAMURAI_ALERTS`. That reasoning was wrong and was rejected on review: a log pipeline paging on `level:warn` never sees `SAMURAI_ALERTS`. Costed against `DEFAULT_TICK_INTERVAL_MS` (60s), six instruments repeating every tick is ~8,640 `warn` lines a day — and since `min_bars: 20` on a `1d` timeframe needs 20 trading days, the condition does not clear inside a 14-day run (#238). *(The paper profile has since moved to `tickIntervalMs: 15 * 60_000` per [ADR-0008](../adr/0008-llm-spend-cap.md), which cuts that to ~576 lines a day. The fix stands on its own — 576 identical repeats of a condition that cannot clear is still the whole log, and the 60s default is what any run not using the paper profile still gets.)* That is not a noisy log, it is the whole log, and an operator who scrolls past thousands of identical warns stops reading warns and then misses the stuck fill. #362 fixed this exact defect at startup.
- **Nothing is lost by the suppression.** The state is still logged every single tick: the tick runner's `record('risk', ...)` writes the whole `RiskDecision`, `warnings` included, into its `info` payload. The advisory line's only job is to raise a *change*; "what is true now" is answered by the per-tick record. This preserves the CII soft signal's "fires every cycle it's evaluated" property, which is a statement about `RiskDecision.warnings` — unchanged — not about log volume.
- **Clearing is announced once, at `info`.** If the warn simply stopped, an operator would have only an absence, indistinguishable from the reader having broken; a single transition line makes completed coverage a positive statement. `info` rather than `warn` because good news must never page.
- **Not a once-per-process latch.** `production.ts` uses that shape for its inert-divergence warn, but that describes a frozen config; this describes a transient state whose *contents* matter. Keying on the warning set per instrument means a peer gaining coverage while another has not is still surfaced.
- **Options rejected.** *(a) document only* — a stated blind spot is not adequate handling when it is about to become six-instrument-wide on day 1 of the #238 soak. *(c) assume a conservative rho for uncovered pairs* — changes sizing on a guessed number, and no source exists for the assumed asset-class average it would need. Revisit (c) only once #182-style history collection gives a calibratable series, alongside the same v2 upgrade the CII sizing formula waits on.

### Module: Risk Critic

Adopted per [ADR-0003](../adr/0003-risk-manager-critic-layer.md) (Risk Manager gains a single red-team critic), resolved via [#186](https://github.com/dd-jp/samurai-trading-system/issues/186) grilling. Answers the question `../research/16-risk-debate-finding.md` raised: the mechanical checks (including the now-dynamic correlation concentration check, step 6) cover quantitative risk well; this module exists only for the narrative/qualitative risk they structurally cannot express.

- **Scope: single critic, not a 3-persona debate.** The Debate Engine (Stage 3) already spends the multi-persona-adversarial-tension budget; a second full debate in Stage 4 is redundant given how narrow the blind spot is. One LLM pass, framed as "argue why this trade should be trimmed or rejected."
- **Trigger: every gated `OrderIntent`, single-pass, no rebuttal round.** Runs regardless of whether the mechanical steps already trimmed the intent — a narrative-risk trade can pass every quantitative check clean, which is the scenario this module exists to catch. No second round arguing with itself.
- **Authority: trim or hard-reject**, inserted as check-pipeline step 7 — the same authority as every mechanical step, not a separate gate and not conviction-modulation (architecturally unreachable from Stage 4: conviction is consumed by the Trader in Stage 3, before Risk ever sees the intent). Per the pipeline's monotonic invariant, a hard-reject from the critic is the *safe* direction, no different in kind from a circuit breaker trip.
- **Determinism: replay-from-log, not a live call in backtest.** In `live`/paper mode, the critic makes a real LLM call and its verdict + reasoning is persisted keyed by `debate_id` (shared with `debate_log` and `cosine_setups`, per [#162](https://github.com/dd-jp/samurai-trading-system/issues/162)). In `backtest` mode, step 7 reads the logged verdict instead of re-calling the LLM — preserving the same-code-path-live-and-replay invariant (Determinism & Kill-Switch module) and keeping Stage 2's PBO/DSR/MinBTL statistics valid.
- **Not yet decided** (deferred to implementation tickets): exact prompt/context contract (what market-intelligence/portfolio context it receives), fail-open vs fail-closed behavior on a critic API failure (the mechanical steps remain the safety net regardless of this module's availability), and dashboard surfacing of its verdicts.

### Module: State & Accounting

- A small **portfolio-accounting module** computes the `PortfolioView` from the shared SQLite store (positions + fills written by Execution) **plus current marks (last price) from the Market Data Service**: equity = cash + mark-to-market of open positions, drawdown = peak-to-trough of the equity curve, notional exposure = `OpenPosition.filled_size × current mark` (freeze §4 — always reads `filled_size`, **never requested size**, so partially-filled positions are marked at what was actually filled). The *realized* components (round-trip PnL, consecutive losses) come from fills alone; only the *unrealized* mark-to-market components need current prices.
- Risk reads this **synchronously**, independent of the Feedback Loop (which reads the same data for its slower tuning, but is never in Risk's hot path).
- **Dependency:** this makes the Risk Manager a consumer of the **Market Data Service** via **two calls** (freeze §3): `getMark(instrument, asOf)` for current/last price (mark-to-market of open positions) **and** `getIndicator(instrument, spec, asOf)` for the **volatility-halt baseline** (the realized/implied-volatility reference the volatility circuit breaker trips against). Alongside the Analysts (`getBars`/`getIndicator`) and Verdict (`getMark`). The Market Data Service is still unbuilt and needs its own map; its scope must include serving current/last price for mark-to-market and indicators for the volatility baseline.
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

**Exact limit values** — all caps and breaker thresholds are config, tuned in paper trading; not fixed here.

**CII-driven position-size scaling** — v1 CII is warning-only; a `(1 - ciiDelta × k)`-style scaling formula is deferred pending real CII history from [#182](https://github.com/dd-jp/samurai-trading-system/issues/182).

**Risk critic prompt/context contract, fail-open/fail-closed behavior, dashboard surfacing** — deferred to implementation tickets under `/to-tickets` (ADR-0003).

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
- **Architecture** — fully mechanical, deterministic, no LLM.
- **Check pipeline & precedence** — ordered breakers→per-trade→per-asset→per-asset-class→portfolio→concentration→risk critic→min-size; concentration uses the dynamic correlation matrix (#50, implemented; corrected from an earlier "static v1 buckets" description).
- **Circuit breakers** — halt entries not exits; tiered; three metrics (daily-loss, peak-to-trough drawdown, consecutive losses); soft auto-reset / hard recovery-threshold re-arm in every mode (#634); UTC-day vs market-day sessions.
- **State & data** — portfolio-accounting view over the shared store, read synchronously off the Feedback Loop path.
- **Backtest determinism** — same code path; point-in-time via injected clock; the only mode-flagged breaker behaviour left is the elapsed-time re-arm arm (#634).
- **Exit & kill-switch** — exits pass verbatim; kill halts new entries; forced liquidation out of scope.
- **CII soft signal** (resolved 2026-07-23, see [ADR-0002](../adr/0002-worldmonitor-mi-source.md) and [#174](https://github.com/dd-jp/samurai-trading-system/issues/174)) — WorldMonitor's Country Instability Index enters as an advisory `warnings` field on `RiskDecision`, warning-only in v1 (no sizing), Samurai-owned static instrument→country mapping, fires on absolute level not delta, unpinned threshold, never overrides breakers or the pipeline outcome.
- **Correlation warm-up visibility** (resolved 2026-08-05, see [#303](https://github.com/dd-jp/samurai-trading-system/issues/303)) — option (b): under-`min_bars` pairs are named in `CorrelationEstimate.insufficient_history` and surfaced as `correlation_warmup:<instrument>` advisory warnings, read by `SequentialTickRunner` as a `warn` log line. No limit or sizing behaviour changes; the warm-up fallback itself is unchanged. See "Module: Correlation Warm-up Visibility".
- **Risk critic** (resolved 2026-07-26, see [ADR-0003](../adr/0003-risk-manager-critic-layer.md) and [#186](https://github.com/dd-jp/samurai-trading-system/issues/186)) — a single red-team LLM pass added as check-pipeline step 7, narrative/qualitative risk only, trim/hard-reject authority, replay-from-log for backtest determinism, runs on every gated intent single-pass with no rebuttal round.

**Dependencies:** the portfolio-accounting view + shared position store (also used by the Trader, #48); the **Market Data Service** (current marks for mark-to-market — a second consumer alongside Analysts; still unbuilt, needs its own map); the Feedback Loop (Stage 6, not yet charted) which tunes limits; **Market Intelligence's WorldMonitor adapter** (CII soft signal, per ADR-0002); and the **shared SQLite store's `debate_id`-keyed log tables** (risk critic verdict persistence, per ADR-0003 and #162).
