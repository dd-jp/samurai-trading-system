# Samurai v2 — grilling decisions (2026-09-19)

Running record of David's rulings in the v2 brainstorm/grill session. Inputs: docs 61–65,
`docs/samurai-postmortem.md`, `docs/samurai-vision-v2.md`, and the paper-DB findings in doc 65 §1/§5b.
David's framing: ignore prior decisions/specs, correct the mistakes, open the universe, make profit
even if tiny, one step at a time, long-term (1-year) profit accepting day-level losses.

These rulings answer vision-v2's open questions and supersede its 0.5–2%/day target. They are not
yet a spec; a wayfinder map and ADRs still follow.

| # | Question | Ruling |
|---|---|---|
| Q1 | Return target | **No daily % target.** Objective = positive net-of-cost return beating the matched benchmark (buy-and-hold of the same universe, risk-matched), under the £1,500 hard loss constraint. 0.5–2%/day rejected: incompatible with the replication prior (Sharpe 0.4–0.8 ≈ 6–12%/yr) and with the loss limit. |
| — | £1,500 | **Hard kill-switch** (David earlier: "accept as loss before stopping"). |
| Q2 | Universe | **Saxo for LSE 1× ETFs/ETCs** (regional/sector equity, gilts, gold, commodities); **Alpaca (live account, GBP wired once, trade USD) for US large caps**, plus US ETFs if UK-resident access is confirmed (PRIIPs/KID — unverified). 3× ETPs out. UK single stocks out (0.5% stamp duty). |
| Q3 | Venue order | **Both venues from day one, paper first.** Alpaca paper = native. Saxo paper = a throwaway simulated adapter filling at Saxo bid/ask with the live tariff (0.08%/side, no minimum) — the SIM env has a 24h manual token and a trial tariff. |
| Q4 | Entry mechanism | **Two sleeves in parallel:** (1) rules-based momentum with LLM veto only; (2) LLM debate as entry. **Debate is fixed first** (D1 offline replay of `debate_log` → fix) and only runs once bullish conviction can clear its floor on replay. Debate sleeve judged vs matched no-LLM control (arm 2); momentum vs buy-and-hold. Fixed, pre-declared sleeve weights. |
| Q5 | Self-improving | **Offline, gated.** Research loop learns from the trade journal/error log, proposes rule/param changes, walk-forward tests them with a global trial counter (DSR-deflated), promotes via gate → paper fidelity → live. Live frozen between promotions, except pre-declared, backtested adaptation rules (vol-scaling, trend filter, sleeve demotion) and risk that only tightens. |
| Q6 | Loss accounting | **Net loss from start capital, both venues, GBP, marked-to-market.** −£500 → half size; −£1,000 → quarter size; −£1,500 → halt for the year. Daily loss cap ≈ 1% of capital blocks new entries (exits still run). Profits do not extend the limit. |
| Q7 | Go-live rule | **Pre-declared:** (1) backtest beats benchmark after a 40% Sharpe haircut, DSR-deflated, 10y+; (2) 8–12 weeks paper inside the backtest's predicted band on costs/fills/returns; (3) 4 consecutive weeks with zero plumbing faults (missed stop, reconcile mismatch, stuck order); (4) David signs off. Start at the capital floor; ramp only while live stays in band. Capital ceiling = £1,500 / (backtest max DD × 1.5). |
| Q8 | Shorts | **Momentum sleeve long/flat. Debate sleeve may short, bounded:** Alpaca easy-to-borrow large caps sized so a +30% gap costs ≤ ~£150; Saxo side via 1× inverse ETFs only, no CFDs. Evidence: debate conviction is only high when bearish (mean 0.67 vs bullish max 0.473). Unverified: Alpaca margin for non-US residents, borrow fees. |
| Q9 | Debate cadence | **Swing.** One debate per screened name per day, pre-open, on daily bars + news; hold days–weeks; broker-resting stop + time stop (e.g. 10 days). Intraday dropped as a sleeve. |

## Carried constraints (not re-grilled)

- Every mandatory protective action is venue-resting or watchdog-backed, never tick-dependent (postmortem §3).
- Windowed data reads carry tested coverage invariants (postmortem §2).
- Tax: per-disposal GBP conversion at the day's rate for US trades; W-8BEN.
- Paper profit is not evidence of edge; paper gates on fidelity to the backtest.

## Rulings Q10–Q13

| # | Question | Ruling |
|---|---|---|
| Q10 | Where v2 is built | **New slim v2 composition root in this repo**, reusing broker adapters (Alpaca, Saxo), providers, stores, and the debate core behind a real module interface. v1 orchestrator frozen; v1 paper soak stopped. |
| Q11 | v1 teardown timing | **After the v2 root runs end-to-end.** Steps: tag `v1-final` + archive paper DB → v2 root → reachability via **fallow** (not knip) + graphify → review list → delete in per-area waves with CI green. Known-dead: flatten subsystem, 15-min tick cadence + tick/bar dedup, 3× ETP universe/gating, D5 £350/£250 sizing + intraday brackets, crypto remnants, T212 refs, v1 paper arms. ADR-0014–0018 superseded by new ADRs, never deleted; specs archived. |
| — | Tooling | **All existing oxlint, biome, crap and fallow rules stay intact and bind v2 from its first commit.** |
| — | Language | **TypeScript; no Python rewrite.** Everything that trades (live, paper, gate backtest) is TS so one strategy implementation runs everywhere. No LangGraph/CrewAI/LangSmith: debate substrate is already TS; tracing = prompt version + inputs + output + cost per LLM call joined to the resulting trade, in our own store. *Proposed, not yet ruled:* optional offline Python research sidecar (ML, replication code) crossing only via files (parquet / ONNX / strategy spec), with a TS parity test before anything reaches paper. |
| Q12 | Host | **MacBook** + external dead-man's switch (e.g. healthchecks.io) + Saxo token-refresh/wake job; broker-resting stops. Move to a cloud VM if paper records any downtime fault. |
| Q13 | Promotion authority | **Auto:** research proposals, backtests, gate-passing promotion to paper, risk tightening. **David sign-off:** anything reaching live (new sleeve, changed rule, capital increase), via a one-page summary (change, haircut backtest, paper fidelity, worst case vs £1,500). **Never:** loosening the £1,500 or daily cap mid-year. |
