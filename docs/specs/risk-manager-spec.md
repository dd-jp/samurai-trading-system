# Risk Manager Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

The Trader produces order intents sized on conviction, volatility, and precedent — but sized in isolation, one trade at a time, with no view of what the whole portfolio already holds or how much the account has drawn down. Left unchecked, a run of individually-reasonable orders can pile into correlated exposure, breach the account's risk tolerance, or keep trading straight through a drawdown that should have stopped it. This is where live money is lost.

The Risk Manager (Stage 4) is the gate between the Trader and the Verdict. It applies position-size caps, portfolio and asset-class exposure limits, concentration limits, and drawdown circuit breakers to every order intent — trimming what it can and hard-rejecting what it must — so that no single trade or accumulation of trades can push the account past its risk limits. It is the stage that must be trusted absolutely under stress, which is why it is fully mechanical and deterministic.

## Solution

The Risk Manager is a **deterministic, mechanical gate** (no LLM). It takes an `OrderIntent` from the Trader plus a synchronous view of portfolio state, and runs it through an ordered check pipeline that is **monotonic risk-reducing** — every step can only trim size / tighten a stop or hard-reject, never increase risk. It outputs a `RiskDecision`: approved (possibly modified) or rejected with a binding reason. Rejected intents terminate at Risk (logged); only approved decisions flow to Verdict. Exits always pass through verbatim. Tiered circuit breakers (per-asset-class and portfolio-level) halt new entries — never exits — on daily-loss, drawdown, or consecutive-loss triggers.

Key architectural decisions:
- **Modify-and-reject, monotonic risk-reducing** — trim to fit soft caps, hard-reject on breakers/limits; never add risk.
- **Fully mechanical, deterministic, no LLM** — reproducible and backtestable.
- **Ordered check pipeline** — breakers first, then trims narrowest→broadest, then concentration, then a min-viable-size reject.
- **Circuit breakers halt entries, never exits; tiered; hard breaker needs manual re-arm.**
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
16. As the Risk Manager, I want the hard max-drawdown breaker to require manual re-arm, so that resuming after a major loss is a deliberate human decision.

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
  mode: 'live' | 'backtest';     // selects manual vs auto re-arm for the hard breaker
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
  warnings: string[];                  // advisory only, e.g. 'macro_risk_flag:RU' — never binding, never overrides status (see CII Soft Signal below)
  risk_snapshot: {
    exposure: Record<string, number>;  // per instrument / class / portfolio
    drawdown_pct: number;
    armed_breakers: string[];
  };
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
  daily_pnl_pct: number;         // since session start (UTC day crypto / market-day stocks)
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
6. **Concentration check (dynamic correlation matrix)** — point-in-time pairwise Pearson correlation over trailing returns (`src/risk-manager/correlation.ts`), trim to fit the correlated-risk cap. (Implemented per backlog ticket #50 — the "v1 static buckets" description in earlier drafts of this spec was stale; corrected 2026-07-26 during #186's grilling.)
7. **Risk critic (advisory-authority)** — a single red-team LLM pass over the intent, narrative/qualitative risk only; may trim or hard-reject, same authority as the mechanical steps above. See "Module: Risk Critic" below. (Added per [ADR-0003](../adr/0003-risk-manager-critic-layer.md).)
8. **Min-viable-size re-check** — if trimming pushed size below viable (respecting broker min order size), reject.

Monotonic: each step only reduces risk. `binding_constraint` records the step that trimmed/killed the intent.

### Module: Circuit Breakers

- **Metrics** (from `PortfolioView` + market data): daily-loss % (soft, per-session; portfolio + per-asset-class), peak-to-trough drawdown % (hard; ~20–25% target per CONTEXT.md), max consecutive losses (soft, cool-off), and a **volatility halt** (soft, per-asset-class) — pause new entries when realized/implied volatility spikes abnormally above a baseline (research docs list "volatility halts" as a circuit breaker; complements the Trader's vol-floor *sizing* with a hard *entry halt* in extreme regimes). A **latency/error halt** (operational) is folded into the kill-switch path — repeated execution errors or stale data trip the same halt-new-entries state.
- **Effect:** halt new entries + scale-ins; **never block exits**.
- **Scope:** tiered — a per-asset-class breaker halts new entries for that class; a portfolio breaker halts all new entries.
- **Reset:** soft breakers auto-reset (next session / after cool-off); the hard drawdown breaker requires manual re-arm in `live` mode, or a configurable auto-re-arm policy in `backtest` mode.
- **Session boundary:** UTC day for crypto, market-day for stocks.
- Exact thresholds are config, tuned in paper trading.

### Module: CII Soft Signal

Adopted per [ADR-0002](../adr/0002-worldmonitor-mi-source.md) (WorldMonitor as a Market Intelligence source). WorldMonitor's Country Instability Index (CII, 0–100 per country) enters the Risk Manager as an **advisory warning, never a gate or a sizing input**. v1 scope, resolved in [CII soft-signal policy grilling — #174](https://github.com/dd-jp/samurai-trading-system/issues/174):

- **Warning-only, no position-size scaling in v1.** No CII-driven sizing formula is implemented yet — no historical CII series exists at any WorldMonitor tier to calibrate one against (see ADR-0002 §6). Deferred to v2 alongside the correlation-matrix concentration upgrade (backlog #50), once [#182](https://github.com/dd-jp/samurai-trading-system/issues/182)'s post-launch CII snapshot capture yields real history.
- **Samurai owns a static instrument→country/region mapping** (e.g. Russian ADRs → RU, energy majors → Middle East), independent of and not trusting WorldMonitor's own tagging — lives alongside the v1 static concentration buckets (Check Pipeline step 6).
- **Surfaces as the advisory `warnings` field on `RiskDecision`** (e.g. `macro_risk_flag:RU`) — travels with the exact decision it's context for, no separate side-channel event or new plumbing.
- **Fires on absolute CII level, not delta.** A sustained high-risk exposure warns every cycle it's evaluated, not just at the moment of a jump.
- **Threshold ("CII > N") is an unpinned config value**, tuned in paper trading — same convention as every other Risk Manager threshold.
- **Never overrides a circuit breaker or the check pipeline's approve/reject/trim outcome, no exceptions.** The CII check runs alongside the pipeline (informational), not as one of its ordered steps — it cannot trim, reject, or otherwise change `order_intent`.

### Module: Risk Critic

Adopted per [ADR-0003](../adr/0003-risk-manager-critic-layer.md) (Risk Manager gains a single red-team critic), resolved via [#186](https://github.com/dd-jp/samurai-trading-system/issues/186) grilling. Answers the question `05-tradingagents-risk-debate-finding.md` raised: the mechanical checks (including the now-dynamic correlation concentration check, step 6) cover quantitative risk well; this module exists only for the narrative/qualitative risk they structurally cannot express.

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

### Module: Determinism & Kill-Switch

- Same code path live vs replay; all state read point-in-time via the injected clock.
- `mode` flag selects hard-breaker re-arm behavior (manual live / auto-policy backtest).
- **Kill-switch** (manual or dead-man's): global halt on new entries + scale-ins (like a portfolio hard breaker), manual re-arm. **Forced liquidation is out of scope** — Risk stops new risk; a separate emergency module or Execution flattens positions if desired.

## Testing Decisions

### What Makes a Good Test

- Test at the `RiskManager.evaluate(input)` seam: given an intent + a mocked `PortfolioView`/`BreakerState` + mock clock, assert on the `RiskDecision`.
- No LLM to mock — assert deterministic outputs.
- Cover each pipeline step's trim and hard-reject paths, and the exit-always-passes path.
- Cover breaker trip/reset (soft auto-reset, hard manual vs auto re-arm by mode).

### Modules to Test

**Check Pipeline** — each cap trims correctly; ordering is deterministic; `binding_constraint` names the right step; trimming below min-size → reject; exits bypass gates.

**Circuit Breakers** — each metric trips at threshold; halts entries not exits; tiered scope; soft auto-reset; hard manual re-arm (live) vs auto-re-arm (backtest).

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
- **Circuit breakers** — halt entries not exits; tiered; three metrics (daily-loss, peak-to-trough drawdown, consecutive losses); soft auto-reset / hard manual re-arm; UTC-day vs market-day sessions.
- **State & data** — portfolio-accounting view over the shared store, read synchronously off the Feedback Loop path.
- **Backtest determinism** — same code path; point-in-time via injected clock; mode-flagged auto-re-arm.
- **Exit & kill-switch** — exits pass verbatim; kill halts new entries; forced liquidation out of scope.
- **CII soft signal** (resolved 2026-07-23, see [ADR-0002](../adr/0002-worldmonitor-mi-source.md) and [#174](https://github.com/dd-jp/samurai-trading-system/issues/174)) — WorldMonitor's Country Instability Index enters as an advisory `warnings` field on `RiskDecision`, warning-only in v1 (no sizing), Samurai-owned static instrument→country mapping, fires on absolute level not delta, unpinned threshold, never overrides breakers or the pipeline outcome.
- **Risk critic** (resolved 2026-07-26, see [ADR-0003](../adr/0003-risk-manager-critic-layer.md) and [#186](https://github.com/dd-jp/samurai-trading-system/issues/186)) — a single red-team LLM pass added as check-pipeline step 7, narrative/qualitative risk only, trim/hard-reject authority, replay-from-log for backtest determinism, runs on every gated intent single-pass with no rebuttal round.

**Dependencies:** the portfolio-accounting view + shared position store (also used by the Trader, #48); the **Market Data Service** (current marks for mark-to-market — a second consumer alongside Analysts; still unbuilt, needs its own map); the Feedback Loop (Stage 6, not yet charted) which tunes limits; **Market Intelligence's WorldMonitor adapter** (CII soft signal, per ADR-0002); and the **shared SQLite store's `debate_id`-keyed log tables** (risk critic verdict persistence, per ADR-0003 and #162).
