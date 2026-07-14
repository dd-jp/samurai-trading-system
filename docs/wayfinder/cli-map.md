# Wayfinder Map: CLI (minimal read-only operator view)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/cli-spec.md](../specs/cli-spec.md).

## Destination

Design a **minimal, read-only terminal CLI** — the 12th component, closing OPEN-GAP-B (the vision's DoD #7: "dashboard or CLI: positions, pending debates, verdict history, per-analyst performance"). David explicitly chose the CLI option (not a full web dashboard) and chose to chart it now rather than defer to v2. Destination = docs/specs/cli-spec.md.

## Notes

- Pure presentation layer. **No new write path, no new backend logic** — everything it shows already exists in the shared SQLite store per the other 11 specs.
- Reads: `audit_log` (Orchestrator — trace_id-joined per-decision history across every stage), `OpenPosition`/`ClosedTrade` (Execution), `DebateLog` (Debate Engine), weight/attribution state (Feedback Loop), `VerdictDecision`/audit trail (Verdict).
- CONTEXT.md / vision DoD #7: "Dashboard or CLI: current positions, pending debates, verdict history, per-analyst performance."
- Runs on the same MacBook host as the Orchestrator (CLAUDE.md deployment target) — a local terminal process, not a hosted service.

## Decisions so far

- **Read model = direct SQLite queries via a thin `QueryStore`, not a subscription/streaming layer.** The CLI queries the same shared store every other component writes to. No new message bus, no push subscriptions — a `QueryStore` interface wraps a handful of read queries (positions, recent debates, verdict history, performance) that the CLI's render functions call. Simplest thing that works for a single-operator, single-host tool.

- **Refresh cadence = manual + polling hybrid.** Default: `watch`-style periodic re-query (configurable interval, e.g. 5s) for a live view, PLUS a one-shot mode (`samurai status`) for a single snapshot — matching how operators actually use CLIs (tmux pane left open vs. quick check). No real-time push; latency of a few seconds is fine for an operator dashboard, this is not a trading-decision path.

- **Four views, matching the DoD wording exactly:**
  1. **Positions** — from `OpenPosition`: instrument, side, filled_size, avg_entry, current bracket (stop/target), unrealized PnL (needs current mark — reads `MarketDataService.getMark`, the same call Risk/Verdict already make).
  2. **Debates** — from `DebateLog`: recent + any in-flight (in-flight debates are NOT persisted per the Debate Engine's ephemeral-operational-state decision (#10) — so "pending debates" in practice means "most recent completed debates," an honest scope reduction from the DoD's literal wording, flagged below).
  3. **Verdicts** — from Verdict's audit trail / `audit_log` filtered to `stage = 'verdict'`: go/no-go history with reasons (gate that fired, HITL override if any).
  4. **Performance** — from Feedback Loop state: current per-analyst weights + rolling attribution, plus the daily `MetricsSuite` (Sharpe/Sortino/etc.) it already computes.

- **Scope-reduction flagged, not silently dropped: "pending debates" is not literally observable.** The Debate Engine has no persisted view of an in-flight debate (only the completed `DebateLog`). Rather than adding new persistence to satisfy a literal read of "pending," the CLI shows the most recent N completed debates plus (if the Orchestrator is mid-tick) a coarse "tick in progress for {instrument}" status line sourced from the Orchestrator's own tick-runner state, not a live debate-round view.

- **No interactivity beyond viewing, v1.** No manual override, no kill-switch trigger, no config editing from the CLI. Read-only, matching "minimal." A future write-capable CLI (e.g. manual flatten, dial the automation level) is an explicit v2 direction, not designed here — keeps this component's blast radius zero (it can never place or block a trade).

- **Terminal UI: simple structured tables, not a full TUI framework.** Rendered as formatted tables/text (one call per view), not an interactive full-screen TUI (no ncurses-style panes/scrolling widgets) for v1 — lower build cost, and operators can pipe/grep the output. Library choice is a techstack.md implementation detail, not a wayfinder decision.

- **Single test seam per view, matching the one-seam-per-component convention.** `CLI.renderPositions(queryStore, asOf)`, `renderDebates(...)`, `renderVerdicts(...)`, `renderPerformance(...)` — each a pure function of `(QueryStore, asOf)` returning a formatted string, independently testable against a fake `QueryStore`.

## Frontier

All frontier decisions resolved. Map complete.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

1. **Depends on `audit_log` (Orchestrator), `OpenPosition`/`ClosedTrade` (Execution), `DebateLog` (Debate Engine), weights/attribution (Feedback Loop), verdict audit trail (Verdict), and `MarketDataService.getMark` (for unrealized PnL) — a read-only consumer of five existing components, no new writes anywhere.**
2. **"Pending debates" scope reduction** — the CLI cannot show a literal in-flight debate (no persistence of ephemeral round state, decision #10 unchanged); it shows completed `DebateLog` entries + a coarse in-progress status line from the Orchestrator's tick-runner. Note this against OPEN-GAP-B / the vision DoD #7 so the reduced scope is a recorded decision, not a silent gap.
3. **No new shared-store tables** — confirmed additive-only read access; nothing here changes the schema other specs already own.

## Out of scope

- **Any write path** — no manual trade actions, no kill-switch, no config editing. Strictly read-only.
- **A full web dashboard** — explicitly declined by David in favor of the CLI option.
- **Real-time push / streaming updates** — polling/manual-refresh is sufficient for an operator tool.
- **A true in-flight/live debate-round view** — the Debate Engine's ephemeral operational state is not persisted; only completed debates are observable.
- **Mobile / remote access** — local terminal on the same host, matching the single-MacBook deployment target.
