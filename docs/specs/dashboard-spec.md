# Dashboard Specification

**Status:** Draft (v3 — the Rail; resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-09-04 (v3 rewrite; supersedes the 2026-08-07 mission-control spec, which superseded the 2026-07-21 two-tab spec, which superseded the 2026-07-14 CLI spec — see "Further Notes")
**Amended:** 2026-09-15 — arm selector (Live / Control, whole page), server-computed overall and today's P&L in GBP on the Europe/London day. Map [Wayfinder map: dashboard arm selector (Live / Control) with overall and today's P&L](https://github.com/dd-jp/samurai-trading-system/issues/1590); [ADR-0021](../adr/0021-dashboard-v3-rail-layout.md)'s 2026-09-15 amendment. Sections touched carry the date; see "Arm selector" under Layout.

## Problem Statement

Every other component in this system writes to the shared SQLite store — positions, fills, debates, verdicts, weights, the `audit_log` — but nothing lets an operator actually look at it. Right now, knowing what Samurai is doing means querying the database by hand. The vision's Definition of Done calls for exactly this: "Dashboard or CLI: current positions, pending debates, verdict history, per-analyst performance" — and it's the one MVP requirement none of the 11 backend components own.

**The Dashboard** is that missing operator view: a read-only web tool an operator opens in a browser on (or on the LAN of) the same MacBook the Orchestrator runs on, to see what the system holds, what it decided, and how it's performing — without touching anything.

**What v3 changes.** v2 (2026-08-07) put everything on one mission-control screen with a rooms grid as its hero and chips that walked between rooms on recorded transitions. David rejected it on 2026-09-04 on **layout and density** — nothing was first, the hero spent itself on a metaphor while the per-stage record hid in a drawer, and P&L weighed the same as a latency percentile. v3 is a from-scratch client rewrite to the **Rail** design locked that day ([ADR-0021](../adr/0021-dashboard-v3-rail-layout.md), map [#1090](https://github.com/dd-jp/samurai-trading-system/issues/1090)): three tabs (Glance, Live, Review) behind a persistent left rail, a lane matrix for the pipeline, a detail drawer, larger type, no motion — with **no change to what the backend computes**. Every datum v2 showed still appears (see "Information Inventory", re-homed); every honesty convention v1 and v2 established is unchanged.

**What v2 changed**, for the record: v1 read as a debug page — two tabs, four tables, a stage rail whose chips teleported — and v2 replaced it with the mission-control screen described above, reversing v1's no-framework and no-motion rules ([ADR-0010](../adr/0010-dashboard-vite-react-rewrite.md), [ADR-0011](../adr/0011-pipeline-theater-replay-motion.md)). ADR-0010 stands; ADR-0011 is superseded by ADR-0021.

## Solution

The Dashboard is a **thin, read-only presentation layer** with **zero new backend logic and zero new write path**. It queries the same shared SQLite store every other component already writes to, through the same `DashboardQueryStore` read interface, and serves one page: a **static Vite+React bundle** that polls a JSON snapshot endpoint every 3 seconds for positions, debates, verdicts, per-analyst performance, third-party provider status with LLM spend, and the pipeline. It can never place, block, or modify a trade — its blast radius is exactly "an operator reads something."

*One qualification on "zero new backend logic", carried from v1: the Alpaca/Polygon tiles are **live outbound probes** on their own 60s poller, not store reads. They are read-only `GET`s that cannot touch an order, so the blast-radius claim above is unaffected — but the dashboard is no longer purely a reader of SQLite, and a reviewer should know that before assuming it makes no network calls.*

*A second qualification, 2026-09-15 ([#1590](https://github.com/dd-jp/samurai-trading-system/issues/1590)): the snapshot now carries a per-arm **P&L headline** — all-time and Europe/London-today P&L in GBP with drawdown and trade count — aggregated by `buildSnapshot`. It is new read-side arithmetic over rows the store already holds, reusing the Feedback Loop's cumulative-P&L-and-drawdown FUNCTION rather than re-deriving it — but not the Feedback Loop's filtered POPULATION of rows, and the two can disagree for that reason ([#1616](https://github.com/dd-jp/samurai-trading-system/issues/1616); see "Glance" and "Live vs matched control" below). It adds no write path and no new source of truth.*

One process, one command (`npm run dashboard`), two `GET` surfaces: the static bundle (`/`, plus its hashed assets) and `/api/snapshot` (the JSON payload the page polls, still pipeable to `curl` for scripting). The bundle is built ahead of time by `vite build` and served from disk by the same `node:http` server — there is no second process, no dev server in production, and no request the page makes to any host other than its own origin.

Key architectural decisions:
- **Direct SQLite reads via `DashboardQueryStore`, no new message bus or subscription layer** — simplest thing that works for a single-operator, single-host tool.
- **Client-side polling refresh at 3s** — the page re-fetches `/api/snapshot` on an interval; no push, no SSE, no WebSocket. Explicitly re-affirmed for v2 ([map #533](https://github.com/dd-jp/samurai-trading-system/issues/533) decision 4): the animation runs off what two polls recorded, which needs no new transport.
- **One payload, one `as_of`** — everything the screen renders comes from a single `DashboardSnapshot`. A second endpoint would let panels disagree about what time it is.
- **A built React client, not a hand-rolled HTML string** — reverses v1's no-framework/no-build-step decision. See [ADR-0010](../adr/0010-dashboard-vite-react-rewrite.md). Runtime dependencies are unchanged: `react`/`vite`/`@fontsource` are **devDependencies** compiled to static assets, and `better-sqlite3` stays the only entry in `dependencies`.
- **No motion.** Nothing on the page animates; a poll repaints and the rail's clock says when. v2's replay motion ([ADR-0011](../adr/0011-pipeline-theater-replay-motion.md)) is superseded by [ADR-0021](../adr/0021-dashboard-v3-rail-layout.md) — see "Motion" below.
- **Three tabs behind one rail** — Glance, Live and Review are separate surfaces because they answer questions asked at different moments; the rail keeps health, mode, budgets and the clock in view on all three. Tab state lives in the URL hash so a bookmark opens the right tab.
- **"Pending debates" scope reduction, explicitly flagged** — the Debate Engine doesn't persist in-flight round state (decision #10, unchanged); the screen shows recent completed debates plus a coarse "tick in progress" line from the Orchestrator, not a live debate-round view.
- **No interactivity beyond viewing** — selection, drawers and keyboard navigation only. No manual overrides, no kill-switch, no config editing. `GET` is the only method the server implements.
- **LAN-only, and `HOST` alone no longer opts in** — binds `127.0.0.1` by default; reachability from another device on the operator's LAN needs a `HOST` outside the loopback allowlist **and** a configured (non-empty) `SAMURAI_DASHBOARD_TOKEN` — `HOST` alone now makes the server refuse to start ([ADR-0019](../adr/0019-dashboard-hosting-topology.md), [#887](https://github.com/dd-jp/samurai-trading-system/issues/887)). `GET /api/snapshot` additionally verifies that same token per request whenever configured, host-independent — the static bundle stays unauthenticated ([#1038](https://github.com/dd-jp/samurai-trading-system/issues/1038)). Still no HTTPS, no public exposure.
- **Test seams: `buildSnapshot` on the server, pure `lib/` modules on the client** — the ledger, the Glance open-risk figures and the trace joins are pure functions of snapshot rows; the per-arm P&L headline (all-time and Europe/London day, GBP) is a `buildSnapshot` test, including the BST day boundary and a control-arm row never reaching the live figure, unit-tested without a DOM.

### Visual source of truth

The **Rail design canvas** locked by David on 2026-09-04 (design session; three directions drawn, two further variations of the Rail, one comment fixed, then locked) is the reference for layout, the rail's contents, the lane matrix, the drawers, type sizes and the restrained motif. Its decisions are recorded in [ADR-0021](../adr/0021-dashboard-v3-rail-layout.md) and on map [#1090](https://github.com/dd-jp/samurai-trading-system/issues/1090). Two caveats for whoever implements against it:

- The canvas drew a **£30 daily-loss stop, a three-position cap, a flat-by-close countdown and GBP figures**. None of those are on `DashboardSnapshot`; the page renders only what the wire carries, in the wire's own denomination — USD throughout, the arm comparison's `basis` included and labelled `$` since [#1180](https://github.com/dd-jp/samurai-trading-system/issues/1180) converted it out of GBP into the account's currency, matching the `realized_pnl_net` beside it. **This spec's "Layout" section wins over the canvas wherever they differ.**
- `docs/prototypes/dashboard-v2-mission-control.html` is the **v2** record and is no longer a source of truth for anything on screen.

## Information Inventory

Every datum v1 rendered must survive each rewrite ([map #533](https://github.com/dd-jp/samurai-trading-system/issues/533) decision 1, re-affirmed for v3 on [#1090](https://github.com/dd-jp/samurai-trading-system/issues/1090)). This table is the checklist a reviewer walks to prove nothing was lost; it is the acceptance instrument for the component tickets.

| Datum | Wire source | v3 home |
| --- | --- | --- |
| Run mode (paper/live) | `mode` (see "Wire Shape") | Rail — mode pill |
| Snapshot clock | `generated_at` / `as_of` | Rail — snapshot clock (`as_of`), STALE's "last update" (`generated_at`) |
| Poll clock, staleness | **No wire field** — the client's own `lastSuccessAt` (`useSnapshot`), stamped when a poll succeeds; staleness is that hook's watchdog declaring `STALE_AFTER_MISSED_POLLS` missed since the last success, never a field the server sends ([#1166](https://github.com/dd-jp/samurai-trading-system/issues/1166)) | Rail — ALIVE/STALE word, ALIVE's "polled" note, and the visually-hidden last-successful-poll line |
| Tick in progress (instrument, stage, trace) | `tick_status` | Rail — live tick block |
| Alpaca cash / equity / buying power | `providers.alpaca.balance` (null unless `state === 'ok'`) | Rail — providers block (equity, cash and buying power as label/figure rows, "not sent" when Alpaca omits buying power); Glance uses equity as the denominator for "% of equity" and "deployed of" |
| Polygon reachability + detail | `providers.polygon.state` / `.detail` | Rail — providers block, as a coloured word |
| LLM spend vs the ADR-0008 cap | `llm_spend.all_time.cost_usd` against `llm_spend.cap_usd`, disambiguated by `llm_spend.cap_armed_at` ([#1196](https://github.com/dd-jp/samurai-trading-system/issues/1196)) | Rail — LLM cap bar |
| Open positions: instrument, side, filled size, avg entry, stop, target, mark, unrealized PnL, order state, opened at | `positions[]` | Glance → Open risk (one row per position with the stop→target track); Live drawer → Order and fills |
| Recent debates: direction, rounds, per-analyst final position, influence, per-round stance | `debates[]` | Live drawer → Debate (stance strips); Review drawer → Debate (joined by `debate_id`); Review table → "why taken" summary |
| Verdict history: status, gate/reason, HITL override, trace id, timestamp | `verdicts[]` | Glance → Verdicts this session; both drawers' gate line |
| Settled lanes that never reach Verdict (`stopped`, `quorum_skip`) | `pipeline.lanes[]` | Glance → Verdicts this session (see "Verdicts this session") |
| Analyst weights, rolling-R, window days | `analysts[]` | Review → Analysts card |
| Full `MetricsSuite` — Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure | `metrics` | Review → Metrics suite (reported together, never one number); max drawdown also drives the rail's drawdown bar |
| LLM spend 24h / 7d / all-time, `unpriced_calls`, `unattributed_calls` | `llm_spend` | Rail — LLM cap bar with the three windows and the unpriced-calls floor caveat |
| Per-instrument pipeline position | `pipeline.lanes[].cells[].state` | Live → lane matrix, one row per instrument, six cells |
| Per-stage record: state, duration, decision, attempts, recorded time | `pipeline.lanes[].cells[]` | Live drawer → stage timeline; Review drawer → stages (when the trace is still in the window) |
| Trace outcome, final stage, started at, total ms | `pipeline.lanes[]` | Lane's seal, outcome word and accessible name; drawer header |
| Live trace + when it entered its stage | `pipeline.live_trace_id` / `live_entered_at` | Rail — live tick block; the running lane's `live` cell |
| Closed trades: entry/exit, size, net P&L, fees, opened/closed, close reason | `closed_trades[]` | Review → closed-trade table; Review drawer → P&L breakdown (gross, fees, net) |
| Fills per order key | `fills[]` | Live drawer (open position) and Review drawer (closed trade) → Fills |
| Arm comparison and outside benchmarks | `arm_comparison[]` / `outside_benchmarks[]` | Review → Live vs matched control card; Outside benchmarks card (secondary) |
| Invalidation: conditions with evaluation states, validator-dropped conditions with reasons, `no_conditions` vs the critic verdict's `unavailable`, and the binding constraint the Risk decision was reached under | `risk_critics[]` (**built 2026-09-03, [#1066](https://github.com/dd-jp/samurai-trading-system/issues/1066)**) — projected from `risk_log` joined through `trader_log` to `risk_critic_log.conditions_json` / `dropped_conditions_json` (`RiskCriticVerdict.conditions` / `dropped_conditions`, migration 0040), which hold the data since [#994](https://github.com/dd-jp/samurai-trading-system/issues/994)'s fold; there is no `thesis_restated` (dropped, cross-spec-contracts.md §8) | Both drawers → Gates and conditions (Live keyed by `trace_id`+instrument, Review by `debate_id`) |

**Dropped from the screen in v3, deliberately:** per-debate cost p50/p95 and LLM latency p50/p95. They are still on the wire (`llm_spend.*.per_debate`) and reachable by `curl`; the rail's cap bar carries the figure that changes an operator's behaviour (cost against the cap, and whether it is a floor). Re-adding them is a card on Review, not a wire change.

**The invalidation section is required, not optional — and it is now built ([#1066](https://github.com/dd-jp/samurai-trading-system/issues/1066), 2026-09-03).** It arrives from [devils-advocate-spec.md](devils-advocate-spec.md) via [Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291) as a mandated dashboard surface. The standalone stage that spec designed it for was declined 2026-09-02; [#994](https://github.com/dd-jp/samurai-trading-system/issues/994) folded its mechanism into the Risk Critic, and #1066 wired that onto the dashboard wire and into the drawer's reserved slot — so the layout did not move when it landed, which is what reserving it was for. Stories 4a–4c below are acceptance criteria now, not a forward contract.

**What the section renders.** One row per measured condition: its id, the observable it measured (`mark`, `indicator:<kind>@<timeframe>`, `bars:volume_ratio@<timeframe>` — the same vocabulary the `RiskDecision.reasons` audit lines use), the comparator and threshold that falsify the thesis, the observed value, and a state chip reading `breached` / `not breached` / `unevaluable`. An `unevaluable` condition shows "not read" rather than a `0`, and is styled muted rather than alarmed: a failed read carries no enforcement effect. Above the rows sit two lines: the Risk decision's **binding constraint**, with `risk_critic:invalidated` (a measured breach) spelled out as a different fact from `risk_critic:reject` (the critic's prose) — the distinction [#997](https://github.com/dd-jp/samurai-trading-system/issues/997) Q2b exists to preserve, and the one that lets an operator see the prose and the predicates disagree — and the critic's own verdict, with `unavailable` named as "consulted and could not answer". `no_conditions` is one empty state for all four causes (none emitted, all dropped, an unreadable column, a row written before the fold), and validator-dropped conditions are listed with their drop reasons **independently of it**, since a fully-dropped emission and an empty one are otherwise indistinguishable (user story 23). A pre-fold row therefore renders as `no_conditions` and never errors. Two further empty states are distinct and named: no Risk decision for this trace in the snapshot's recent window, and a decision the critic never saw. (With no trace selected there is no drawer at all, so the section renders nothing — that empty state is the drawer's, not this section's.)

## User Stories

### Positions

1. As an operator, I want to see all open positions (instrument, side, filled size, avg entry, current stop/target, unrealized PnL), so that I know Samurai's current market exposure at a glance.
2. As an operator, I want unrealized PnL computed from the current mark, so that the position view reflects live exposure, not just entry state.
2a. As an operator, I want stop / entry / mark / target drawn as one **price rail** per position, so that "how close is this to its stop" is a spatial fact rather than four numbers I have to compare in my head.

### Debates

3. As an operator, I want to see the most recent completed debates (per-analyst contributions, direction, conviction), so that I can review why a recent trade idea was accepted or rejected.
4. As an operator, I want a coarse "tick in progress for {instrument}" status line when the Orchestrator is mid-pass, so that I have *some* visibility into an in-flight cycle, even though the Debate Engine's round-by-round state isn't persisted (decision #10).
4d. As an operator, I want each analyst's stance **during** the debate shown as a strip alongside where it ended up, so that an analyst that was talked around reads differently from one that never moved (#427). An absent `stance_during_debate` renders as an empty strip, never as a fabricated flat line.

#### Invalidation panel (surface widening, 2026-08-05; relocated to the drawer in v2)

Added by [Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291) as a **required** section of devils-advocate-spec.md. This is a deliberate widening of the frozen positions/debates/verdicts/performance surface, resolving three prior deferrals that had all pointed here (the validator's dropped conditions, the reject alerts, and the drop counts). In v2 it is a section of the **detail drawer** — the same content, reached by selecting an instrument rather than by switching tabs.

4a. As an operator, I want the invalidation conditions with evaluation states shown on the debate detail view, so that I can judge whether the pass understood the trade it was attacking. **Restated 2026-09-03: drop "the restated thesis" from this story** — `thesis_restated` did not survive #994's fold (cross-spec-contracts.md §8); the critic's verdict is already keyed by the `debate_id` it attacks, so there is no second, model-restated thesis to show alongside the conditions.
4b. As an operator, I want validator-**dropped** conditions listed with their drop reasons, so that prompt quality is inspectable rather than silently degrading.
4c. As an operator, I want `no_conditions` and `unavailable` rendered as **distinct** states, so that "the pass found nothing falsifiable" is never displayed as "the pass could not run".

**There is no `invalidation_log` and no `(instrument, bar_timestamp)` join — that belonged to the standalone stage declined 2026-09-02, whose mechanism [#994](https://github.com/dd-jp/samurai-trading-system/issues/994) folded into the Risk Critic instead.** What drives this section is `risk_critic_log`'s `conditions_json` / `dropped_conditions_json` (migration 0040) — the raw, tagged emission (`EvaluatedCondition[]` / `DroppedCondition[]`), not a post-validator-only list, for the same reason the old design gave: showing dropped conditions requires the raw emission.

**The wire row is keyed by `(trace_id, instrument)`, not by `debate_id` ([#1066](https://github.com/dd-jp/samurai-trading-system/issues/1066)).** `risk_critic_log` is keyed by `debate_id`, but the join is done SERVER-side, driven from `risk_log` (whose primary key is that pair) through `trader_log` (which carries the `debate_id` for the trace) to the critic row. Keying the wire by `debate_id` and joining in the browser would have mis-attributed: a retried tick mints a fresh `trace_id` while keeping its content-hashed `debate_id` (migration 0015), and the drawer resolves its debate by INSTRUMENT — so one trace's binding constraint could render beside another trace's conditions, silently, with both rows real. **Amended 2026-09-15, [#1594](https://github.com/dd-jp/samurai-trading-system/issues/1594):** falsifier arm 2's decisions are no longer excluded — `getRiskCritics` takes the selected arm and returns that arm's own Risk decisions, each with `critic: undefined` for the control arm, since the control arm calls no model and so consults no critic, but the decision itself happened and is not absent.

**Limitation that must be shown, not hidden:** the section reports what the pass *said*, what was measured about it, and the binding constraint `risk_log` recorded — not the whole `RiskDecision`, which is still only partly persisted ([#328](https://github.com/dd-jp/samurai-trading-system/issues/328)); and a decision that stopped before Verdict has no verdict row to show beside it. It must not imply a certainty beyond those rows: notably, a breached condition does not by itself mean Risk rejected on it, which is exactly why the binding constraint is rendered rather than inferred.

### Verdicts

5. As an operator, I want a chronological verdict history (go/no-go, the gate that fired, any HITL override), so that I can audit every decision the pipeline made, not just the ones that resulted in a trade.
5a. As an operator, I want each settled decision **stamped** into a ledger as it happens, so that the record of what the machine decided accumulates in front of me rather than being something I go and look up.

*`hitl_override` is a real column on `VerdictRow` and is still rendered — as a badge on the ledger row — but since [ADR-0007](../adr/0007-fully-automatic-execution.md) it is **always false in live data**: the automation dial is `auto` for both asset classes and `Verdict.decide` never reaches the approval path. Keep the field and the badge: it is the audit record that no human touched a trade, which is exactly the thing a fully automatic system should be able to prove. The badge is therefore expected never to fire; an unexpectedly `true` value would mean the dial moved, which `assertAutomationLevelSupported` now refuses at boot.*

### Performance

6. As an operator, I want current per-analyst weights and their rolling attribution, so that I can see which analysts are earning trust and which are being tuned down — with the weight shown **numerically as well as** as a bar, so the comparison does not depend on judging bar lengths.
7. As an operator, I want the Feedback Loop's daily `MetricsSuite` (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure), so that I see the full metrics picture the research constraints require, not a single vanity number.
7a. As an operator, I want the live arm shown **beside falsifier arm 2**, the matched control, so that I can see whether the debate layer is beating the same strategy without it — the question CONTEXT.md's Key Constraints make the primary one, and the one a live-arm-only page cannot answer. ([#971](https://github.com/dd-jp/samurai-trading-system/issues/971), surface 2 of [#913](https://github.com/dd-jp/samurai-trading-system/issues/913).)
7b. As an operator, I want **return and max drawdown together** for both arms, over the **same window**, so that I never read a lead that was bought with more risk as a lead.
7c. As an operator, I want the comparison as a **trend across the Feedback Loop's cycles**, not only today's row, so that one favourable window does not read as a verdict.

### Providers & LLM Spend

**This section documents shipped code that predated it** (retro-documented 2026-08-06). `providers` and `llm_spend` have been on `DashboardSnapshot` since [#326](https://github.com/dd-jp/samurai-trading-system/issues/326)/[#367](https://github.com/dd-jp/samurai-trading-system/issues/367) (`server/apps/service-api/provider-status.ts`, `server/apps/service-api/types.ts`) while this spec still described four views and no spend surface. Written down so the spec stops understating what the page shows — particularly with [ADR-0008](../adr/0008-llm-spend-cap.md)'s $50/14-day cap live, which makes the spend surface a budget instrument, not a curiosity.

17. As an operator, I want my live Alpaca account balance on the page, so that I can see the broker's own view of equity without opening Alpaca.
18. As an operator, I want to know whether Polygon is reachable, so that a dead market-data key is visible as itself rather than as an inexplicably quiet pipeline.
19. As an operator, I want locally-metered LLM spend over 24h/7d/all-time, so that I can see the ADR-0008 budget being consumed while there is still time to act on it.
19a. As an operator, I want all-time spend drawn as a **burn meter against the cap the enforcer applied**, carried on the wire rather than copied into the client ([#1140](https://github.com/dd-jp/samurai-trading-system/issues/1140)), so that "how much runway is left" is readable without arithmetic.
20. As an operator, I want per-*decision* cost and LLM latency at p50/p95, so that I can answer "what does one debate cost me, and is round 3 earning its latency?" rather than only "what did today cost". *(Amendment (#1178): dropped from the screen in v3, deliberately — see "Dropped from the screen in v3" below. Still on the wire (`llm_spend.*.per_debate`) and reachable by `curl`; this story is not implemented and re-adding it is a card on Review, not a wire change.)*

### Pipeline lanes (v3 Live tab — supersedes v2's rooms theater)

Charted in [Wayfinder map: dashboard v3 — Rail client rewrite](https://github.com/dd-jp/samurai-trading-system/issues/1090), which supersedes the rooms-theater portions of [#533](https://github.com/dd-jp/samurai-trading-system/issues/533) (which in turn superseded the pipeline-tab portions of [#411](https://github.com/dd-jp/samurai-trading-system/issues/411)/[#412](https://github.com/dd-jp/samurai-trading-system/issues/412)). The Review tab answers *what the system decided and how it is doing*; the Live tab answers *where each instrument is in the pipeline right now, and where the last one stopped*.

**Primitive: a lane matrix, not rooms.** One **row per instrument**, six **stage cells** across (Analysts → Debate → Trader → Risk → Verdict → Execution), a stage-name header row above the lanes, each cell carrying its state word and, where the stage recorded one, its decision word. Chosen by David on 2026-09-04 over the v2 rooms grid, because the rooms could show a pile-up but not a journey — and the drawer, not the hero, held the only per-stage record. The matrix reads both: a column of `stopped` cells under Risk is the pile-up; a single row read left to right is the journey.

12. As an operator, I want every instrument on its own row with the stage it reached visible in that row, so that a pile-up at one stage is a column I can see without reading a single drawer.
13. As an operator, I want a stage that was **skipped** to read differently from one that **stopped** the tick, so that routine traffic is never displayed as a halt. A skipped stage never terminates the tick, so "skipped" must never collapse into a halted read.
14. As an operator, I want a stage reached more than once in a trace to show its attempt count, so that a retry storm is visible rather than collapsed. (Attempts render in the drawer's timeline; the cell carries state and decision only.)
15. As an operator, I want a dormant instrument (market closed, no tick) to read as idle rather than vanish, so that absence of activity is distinguishable from absence of the instrument. An idle lane's six cells all read `idle`, and its accessible name says "no trace in the window".
16. As an operator, I want to open one instrument and see that trace's full stage timeline with durations and, for a completed debate, its per-analyst contributions — with the live case stating plainly that round-by-round state is not persisted (decision #10) rather than showing a spinner that will never resolve.

**What the lane cannot show, and where it went.** A cell is a word, not a record: durations, `recorded_at` clocks and attempt counts live in the drawer's **stage timeline**, which lists all six stages including the never-reached ones. A lane holds one trace — the instrument's most recent inside the 15-minute window — so an older trace opened from Glance's verdict list renders its drawer with the timeline replaced by "this trace has aged out of the 15-minute pipeline window" rather than with the current trace's cells.

**A mismatched selection is not an aged-out trace.** A `Selection` naming one instrument while pinning another instrument's `trace_id` — a stale link, most often — must not read as `aged_out`: the id is attested for the OTHER instrument, on a lane, a verdict, a risk-critic row, or the in-flight `tick_status` (the wire's four `(trace_id, instrument)` carriers), even once that attestation has itself left the 15-minute lane window and survives only in the 10-row verdict history or the 30-row risk-critic history — so this is not "the trace is still live", only "the trace is not this instrument's to begin with". This distinct silence reads "this trace belongs to another instrument — the selection is mismatched, not aged out", never the aged-out sentence's promise of a remaining verdict row and never a promise that the other instrument's *current* lane holds this trace (a verdict/risk-critic/tick_status-only attestation means no lane holds it at all); the drawer's trace id reads "no trace" rather than the foreign instrument's id ([#1267](https://github.com/dd-jp/samurai-trading-system/issues/1267)). The two states are recoverable differently in principle — a correct selection resolves one and can never resolve the other — so a caller must be able to tell them apart, not just render the same "no trace" line for both.

**Six stages, and stays six.** `analysts → debate → trader → risk → verdict → execution`. A standalone `invalidation` stage was specced between `trader` and `risk` on 2026-08-05 (devils-advocate-spec.md) but **declined 2026-09-02**; its typed invalidation-condition mechanism folds into the Risk Critic instead ([#994](https://github.com/dd-jp/samurai-trading-system/issues/994)). It never rendered a room here beyond a permanently lights-off placeholder at 04, which — along with the seven-wide `PIPELINE_STAGES` in `contracts/pipeline.ts` it was drawn from — was retired in the same change that closed this decision ([#998](https://github.com/dd-jp/samurai-trading-system/issues/998)). Room numbers 04–06 now name Risk, Verdict and Execution.

**Attribution — migration 0013.** This view is only possible because `audit_log` now carries `instrument`/`asset_class`. Before that, the sole trace_id → instrument links were `current_tick` (in-flight only, deleted at tick end) and `verdict_log` (only traces reaching Verdict), so **every short-circuited tick was attributable to no instrument at all** — an instrument that went quiet because Risk kept rejecting it looked identical to a closed market, and the Risk pile-up the theater exists to show would have been invisible. The writer already held both values; they were never persisted. `NULL` means "not attributable" (pre-migration rows, and the HITL callback path, which records under an existing trace_id with no `Signal` in scope) and must never be guessed onto an instrument.

**Bounded by a window, not a count.** Each instrument shows its most recent trace within a **15-minute lookback, capped at 24 lanes**. The window doubles as the staleness guard: a crash deliberately leaves `current_tick` behind (`tick-runner.ts` — a stale row must be visible, not tidied away), and without the window the screen would report a dead tick as running indefinitely. A lane whose trace ages out of the window becomes `idle`.

**Constraints carried unchanged from v1:** read-only, poll-only on the existing 3s `/api/snapshot`, one payload rather than a second endpoint, and **zero new *runtime* dependencies** — what changed is that there is now a build step producing static assets, not that the server grew a dependency.

### Operation

8. As an operator, I want to open one URL in a browser and see current state, so that I can check status without a terminal.
9. As an operator, I want the page to refresh itself on an interval, so that I can leave a browser tab open and watch state change.
10. As an operator, I want the Dashboard to be strictly read-only, so that running it — or a bug in it — can never place, cancel, or modify a trade.
11. As an operator, I want the server to stay off my network by default, so that a stray port isn't exposed unless I explicitly ask for it.
21. As an operator, I want the page to work with no internet connection, so that a dead link to a font CDN can never blank the screen I use to watch live money. **Zero external requests** — fonts are bundled, nothing is fetched from any host but the page's own origin.

## Layout — the Rail: three tabs behind one rail

Desktop, 1440px wide as the design width. A **240px left rail** on every tab; the tab panel fills the rest. Tab state is the URL hash (`#glance`, `#live`, `#review`); the rail's tab list is a real `tablist` with keyboard operation, and the panel is its `tabpanel`.

### 1. The rail (every tab)

Top to bottom: the brand mark (侍 SAMURAI), the three vertical tabs, then the always-on facts.

- **Bot health as a word: ALIVE / STALE / WAITING / MISMATCH** ([#1316](https://github.com/dd-jp/samurai-trading-system/issues/1316), 2026-09-14), with "polled HH:MM:SSZ" beneath the first three. **One vocabulary, two surfaces** ([#1520](https://github.com/dd-jp/samurai-trading-system/issues/1520), 2026-09-14, decided in [#1144](https://github.com/dd-jp/samurai-trading-system/issues/1144)): the rail shows ALIVE / STALE / MISMATCH, and WAITING is no longer a rail word at all — before the first snapshot there is no rail. The page renders **one cold-start state for the whole dashboard** instead, since a rail and three tabs full of empty cards is how "nothing has arrived yet" gets read as "the book is empty". The cold-start screen takes its word from the same `FeedStatus` the rail reads, so a first poll that comes back wire-version-skewed says **MISMATCH** there, not WAITING — the higher-ranked diagnosis is not swallowed by the gate. Once a snapshot has landed the client keeps one for the rest of the session, so the cold state never returns and every card is written against a snapshot that is present.

  **A stale feed is never a cold start.** Staleness is a snapshot that exists and is aging; the rail says so on top of the last-known numbers, which is precisely what an operator is reaching for when a feed drops. **Staleness is a label plus a border, not a disappearance.** Two consecutive missed polls put the rail into a stale state: "stale — last update HH:MM:SSZ" as a live-region status, an amber border on the rail, and `data-stale` on it. Numbers keep their last values and are *marked* stale rather than blanked, because a blank field reads as zero.

  **MISMATCH is a fourth word with a deliberately different rule, not a fourth flavour of staleness.** It fires when the served client bundle and the answering server disagree about the wire shape (`contract_version`, below) — a case ALIVE/STALE/WAITING's "keep the numbers, mark them stale" rule cannot safely cover, because the numbers themselves may not mean what this client thinks they mean. Rather than keeping or blanking the six health-derived tiles (Mode, Live tick, Alert channel, Providers, LLM cap, Drawdown), each is replaced with an explicit **"unknown — contract mismatch"** reading — never hidden, since an absent tile reading as a healthy zero (`AlertDeliveryBlock`'s pre-#1316 `?? 0`) is the exact bug this state exists to prevent. Outranks STALE and WAITING (a mismatched poll's staleness or silence is not the operative fact about it) — including on the cold-start screen, where a mismatch on the very first poll reads MISMATCH rather than WAITING; styled with `--vermilion` (not `--amber`), `rail-mismatch`/`data-contract-mismatch` on the rail, so it reads as visually distinct from ordinary staleness, not a shade of it.
- **Mode pill: PAPER / LIVE**, or "mode unknown" when the wire carries no recognised mode. Never defaulted.
- **Live tick**: instrument · stage from `tick_status`, "since HH:MM:SSZ" from `pipeline.live_entered_at` (`tick_status` carries no timestamp), and the trace id; "live — a trace is running" when only `pipeline.live_trace_id` says so; "idle — no tick in progress" otherwise.
- **Providers**: Alpaca and Polygon as **coloured words, never dots** (David's call, [map #533](https://github.com/dd-jp/samurai-trading-system/issues/533) decision 7, kept). `ok` / `unauthorized` / `forbidden` / `rate_limited` / `error` / `not_configured` (the contract's `ProviderState`) render as words, and a state the client does not recognise reads "state not recognised"; Alpaca's equity, cash and buying power sit beneath its word, and each probe's `detail` is printed on its own line whenever it is non-empty, never tucked into a tooltip. **The Alpaca balance is `null` unless `state === 'ok'`** and renders as unavailable with the probe's `detail`.
- **LLM cap bar**: `llm_spend.all_time.cost_usd` against `llm_spend.cap_usd` — the ADR-0008 ceiling the orchestrator's composition root armed, never a figure held in the client ([#1140](https://github.com/dd-jp/samurai-trading-system/issues/1140)) — with the three windows (24h · 7d · all) and the count of calls carrying no debate id beneath, and "floor — N unpriced calls" whenever `unpriced_calls > 0`. A `null` `cap_usd` is ambiguous on its own — "armed uncapped" (a deliberate operator choice) and "never armed" (no row was ever written) both read `null` — and `llm_spend.cap_armed_at` is the discriminator, but ONLY for a null `cap_usd` ([#1196](https://github.com/dd-jp/samurai-trading-system/issues/1196)). **A present, finite `cap_usd` is honoured on its own and is never gated on `cap_armed_at`**: a numeric cap is itself the enforced ceiling regardless of whether this particular wire happens to also carry the arming instant, and a payload missing `cap_armed_at` (a mixed client/server version, or a snapshot shape predating this field) must still draw the meter, not read as unarmed.

  Priority order, seven named states:
  1. "no spend figure on this snapshot — meter not drawable" — the summary is missing or malformed, including before the first poll lands, where the client knows nothing of the operator's budget at all.
  2. "LLM spend cap on this snapshot could not be read — meter not drawable" — `cap_usd` is anything other than a finite number or an explicit `null`: absent, the wrong type, non-finite, or a corrupt stored value (`SqliteLlmSpendCapStore.read()` nullifies a non-finite stored `budget_usd` while KEEPING `armed_at`, so an intact `cap_armed_at` reaches this state too — and so does a payload predating the field entirely, since "no wire value" and "an unparseable one" carry the same "we don't actually know" fact here). This outranks `cap_armed_at` entirely: consulting it here would still answer "deliberately uncapped" for a value this client just rejected as unreadable, manufacturing a claim about operator intent from noise ([#1196](https://github.com/dd-jp/samurai-trading-system/issues/1196) review round 3). Distinct from state 3: an unreadable `cap_usd` is not the same fact as an explicit `null` one, even when `cap_armed_at` is silent on both.
  3. "no trustworthy arming record on this snapshot — meter not drawable" — `cap_usd` is EXPLICITLY `null` and `cap_armed_at` is absent from the wire, or present but too malformed to trust — either way, not explicitly `null` — covering both a server predating this field and a value this client cannot trust. This state asserts NEITHER "armed" nor "unarmed": a pre-#1196 server did boot and did arm, it simply cannot say so on this field, and guessing either direction from silence is as false as fabricating a denominator.
  4. "LLM spend cap was never armed — meter not drawable" — `cap_usd` is `null` and `cap_armed_at` is explicitly `null` (a row was never written).
  5. "LLM spend is deliberately uncapped — meter not drawable" — `cap_usd` is `null` and `cap_armed_at` carries a real arming instant.
  6. "LLM spend cap is $X — meter not drawable" — `cap_usd` is a non-positive number (most commonly `$0`, the most restrictive cap there is — stated explicitly with its real figure, never as "unconfigured", and regardless of `cap_armed_at`), with "· already over" appended once recorded spend exceeds it.
  7. A drawn meter — `cap_usd` is a positive number. The only state that draws.

  None of states 1–6 substitutes a denominator. States 5 and 6 additionally footnote "· armed HH:MM:SSZ" from `cap_armed_at` when it is a real timestamp; state 7 (a drawn meter) does not repeat the arming instant in its footnote.
- **Drawdown bar**: `metrics.max_drawdown` against `CONTEXT.md`'s 26.2% index-bracket tolerance ([#798](https://github.com/dd-jp/samurai-trading-system/issues/798)), labelled as that tolerance. The single-stock bracket's 41.8% is not drawn: one bar, one stated reference. **Reaching the tolerance is stated in words, not left to the track's colour alone** ([#1201](https://github.com/dd-jp/samurai-trading-system/issues/1201)): the footnote's "over tolerance · " prefix — the LLM cap bar's own "over cap · " word, restated for a tolerance rather than a cap — carries the state the tone change also carries.

  `max_drawdown` is a required, finite fraction on the wire type (`contracts/metrics.ts`), so an absent report and a present-but-unreadable figure are different facts and must not share a sentence ([#1264](https://github.com/dd-jp/samurai-trading-system/issues/1264)):
  1. "no daily suite yet — meter not drawable" — `metrics` itself is `null`. `metrics` is required and non-nullable on the wire type (`contracts/snapshot.ts`), and `useSnapshot.ts`'s `hasWireShape` rejects any payload where it is not a non-null object — that rejection is total: `toWireSnapshot` returns `null` for a failing body, and the poll loop then leaves the last good snapshot in place rather than writing a broken one (`useSnapshot.ts`), so a stripped or nulled `metrics` field never reaches a live snapshot at all. So through this repo's own server, this state is reached only via `snapshot === null` — no successful poll yet, not "no suite has run" (the daily suite itself always computes on every snapshot build, `SqliteQueryStore.getDailyMetrics`). `Rail.tsx` still guards the call site with `snapshot?.metrics ?? null`, matching `WireSnapshot.metrics`'s non-optional type against `snapshot`'s own nullability — a type-level narrowing this component needs regardless, not a second live route into this state.
  2. "daily suite drawdown figure could not be read — meter not drawable" — `metrics` is non-`null` (a suite DID run) but `max_drawdown` is not a finite number (`NaN`, `Infinity`, `-Infinity`, or a wrong-typed value), or is finite but overflows against the tolerance on division (e.g. `1e308`) — an upstream defect, described as one, not as "nothing to show yet".
  3. A drawn meter — `max_drawdown` is a finite number whose quotient against the tolerance is itself finite. The only state that draws.
- **Snapshot clock** at the foot.

**Nothing else is drawn on the rail.** The canvas's daily-loss stop, position cap and flat-by-close clock are not on the wire and are not rendered.

### Arm selector (every tab) — added 2026-09-15, [#1590](https://github.com/dd-jp/samurai-trading-system/issues/1590)

- **Placement and state.** The rail carries a two-way selector, **Live arm / Control arm**. The arm lives in the URL hash beside the tab; it is not remembered across sessions; the page opens on **Live**.
- **Whole page, one arm.** Glance, Live and Review render the selected arm's rows only. No component shows a figure from the other arm, except the Review arm-comparison panel, which is both arms by rule in either view.
- **Control is unmistakable.** The control view carries a persistent banner, "CONTROL ARM — simulated fills, no money", and a distinct accent tint. The banner is the signal; the tint is redundant with it.
- **Absence is named per arm.** A figure the selected arm structurally cannot have renders an explicit N/A with its reason — "Control arm: no LLM debate — not applicable", "Control arm: simulated broker — no equity figure", "Control arm: tick status is not persisted" — never blank, zero, or the live arm's value.
- **System facts are not arm facts.** Providers, LLM spend and alert delivery render identically in both views, labelled as system.
- **Store reads name exactly one arm.** Reads that are live-only today (#753, #1318, #1319) take the arm as a parameter; no read returns both arms' rows together, which is the guarantee those issues made.

### 2. Glance

The tab the page opens on. Three cards, no table:

- **P&L — overall and today** *(amended 2026-09-15, #1590; this replaced a client-computed "P&L today" on the snapshot's UTC date)* — two headline figures (28–40px, signed), both for the **selected arm only** and both taken from the wire, never computed on the client: **overall** (all-time closed-trade net plus open unrealized) beside that arm's **max drawdown** and **trade count** — never a return without its drawdown (doc 12 D4) — and **today** over the **Europe/London calendar day** (BST-aware), with realized / unrealized / costs / trade counts beneath. Both in **GBP**, each with "% of the declared book" on the same basis for both arms — the book figure is `PnlHeadlineWire.book_gbp`, carried on the wire rather than a client literal ([#1620](https://github.com/dd-jp/samurai-trading-system/issues/1620)), the same reason the rate below travels with the figures rather than being assumed — and the conversion rate and its source stated beside them ("at $1.27/£, static sizing rate"). On the live arm, Alpaca equity stays as a separate labelled figure; on the control arm it is "Control arm: simulated broker — no equity figure", and the sparkline below is replaced by the same sentence. A sparkline of Alpaca equity as observed by this page's polls (live arm only), with its sample count in its accessible name and a named empty state until two observations exist (samples are deduped by observation time and value, so two polls at the same equity draw a flat line — that is a reading, not a gap).

  **`overall`'s `trade_count`/`net_gbp`/`max_drawdown_pct` are not the same population as the "Live vs matched control" panel's, nor the same window, nor computed at the same time** ([#1616](https://github.com/dd-jp/samurai-trading-system/issues/1616)). `overall` is every closed trade the arm has ever recorded, computed at render time; the comparison panel below is a stale-by-up-to-one-cycle Feedback Loop sample over its own configured window, already filtered through rows `oneSizingRegime` and `modelledCostCharged` exclude (see that section). On the population axis, only the cost filter is one-directional by ARM — `modelledCostCharged` drops rows on the live arm only, never the control arm — but the sign of the resulting figure difference is not established: a dropped row can be a loss, which reads worse for `overall`, not better; `oneSizingRegime` can drop pre-cutover rows from either arm. This is documented, not aligned: forcing `overall` through the same filters would let it read "£0.00 · 0 trades" on a live arm the cost filter has gutted, which is worse than the two figures disagreeing.
- **Open risk** — "$deployed of $equity", then one row per open position: side, size, notional, mark, stop with its distance ("X% away" or "X% through" when the mark has passed it), target, unrealized P&L, and a stop→target progress track with its percentage in the accessible name. Empty state: "No open position — nothing at risk".
- **Verdicts this session** — the v2 ledger, unchanged in rule: **fed from settled pipeline lanes, not from `verdicts[]` alone** (a `stopped` or `quorum_skip` lane never reaches `verdict_log`); **deduped by `trace_id`** for the session; **newest first, capped at 30**; seeded on first paint from the currently-settled lanes, stamped with their last non-null `recorded_at` rather than the wall clock; the **HITL badge** on any row with `hitl_override === true`; each row stamped with a **hanko seal** — 可 (go), 否 (no_go), 止 (stopped), 略 (quorum_skip). **A row opens the Live tab with that exact trace selected**, not the instrument's current one.

### 3. Live

Left: the **lane matrix** (see "Pipeline lanes"), a section named `Lanes` with the count of instruments in the 15-minute window and how many are running. Each lane is a focusable button whose accessible name is "{instrument}, {asset class}, {outcome word}, at {Stage}" or "…, idle, no trace in the window"; the running lane's `live` cell is the cyan accent; the selected lane is `aria-pressed`. **Colour is never the sole signal** — every outcome a colour encodes is also a word in the lane's name and in the drawer.

Right: the **460px trace drawer** (`Trace detail`), carrying the seal, instrument, outcome word and trace id, then four sections:

- **Stage timeline** — all six stages with state word, duration, decision, attempt count and recorded clock, including the never-reached ones.
- **Gates and conditions** — the verdict gate line (status, reason, HITL, clock) and the invalidation section (stories 4a–4c, [#1066](https://github.com/dd-jp/samurai-trading-system/issues/1066)) keyed by `trace_id` **and** instrument off `risk_critics[]`.
- **Debate** — the most recent completed debate for the instrument (not keyed to the trace: `DebateRow` carries no `trace_id`, and the drawer says so), per-analyst stance strips and influence, with the decision #10 caveat.
- **Order and fills** — the open position for the instrument with its fills, or "No open position for this instrument".

Every empty state **names its reason** — "No lane selected", "idle — no trace in the last 15 minutes", "this trace has aged out of the 15-minute pipeline window", "this trace belongs to another instrument — the selection is mismatched, not aged out", "Trader and Risk carry no decision word (#328)", "No completed debate recorded", "No fill recorded against this order key" — never a bare dash and never a spinner that cannot resolve.

### 4. Review

Three summary cards across the top, the closed-trade table as the spine, and a 460px trade drawer on the right.

- **Metrics suite** — the full `MetricsSuite` as tiles, **reported together**, plus the observation count. No single headline number; the research constraints exist because one metric in isolation misleads. A tile may carry a one-phrase note that restates the contract's own definition ("annualized, Lo-adjusted" for Sharpe, "0 = normal" for excess kurtosis, "per trade, net" for expectancy) — never an interpretation.

  **Profit factor is three named states, not a bare number** ([#1270](https://github.com/dd-jp/samurai-trading-system/issues/1270)), the same collapse class the drawdown meter's states above close: gross wins / gross losses is `Number.POSITIVE_INFINITY` for any window with wins and no losses — the best possible outcome, not an absence — and `JSON.stringify` has no representation for a non-finite number, so it used to reach the client as literal `null` and render as the same em dash `formatFixed` renders for "we have no idea" (`format.ts`'s `UNKNOWN`). The wire field is `ProfitFactorWire` (`contracts/metrics.ts`), a discriminated union, not a nullable `number`:
  1. "no losing trades" — `{ kind: 'no_losses' }`. Wins and no losses. Reads as the good state it is.
  2. A formatted ratio — `{ kind: 'ratio', value }`, rendered with the tile's usual fixed-precision formatting. `wins === 0 && losses === 0` (no closed trades in the window at all) is `value: 0`, a real finite zero — the pre-#1270 meaning, kept, and distinguishable from `no_losses` by `kind` alone.
  3. "could not be read" — `{ kind: 'unreadable' }`. `profit_factor` was non-finite but not `+Infinity` (`NaN`, `-Infinity`) — an upstream defect, named as one. `toProfitFactorWire` never emits this for today's `profitFactor()` (wins and losses are non-negative sums, so the only non-finite output is `+Infinity`); the state exists so a `ratio.value` can never itself be a non-finite number that would die in `JSON.stringify` the same way the bare field used to.

  A wholly absent metrics suite (`metrics === null` — no successful poll yet, see the drawdown meter's state 1 above) renders neither of these: the whole tile grid is replaced by "No metrics on this snapshot", which is a fourth, already-distinct state none of the three above can be confused with.

  None of the three states carries a colour — unlike the drawdown bar, this is a tile, not a meter — so the accessibility floor ("colour is never the sole carrier of a signal") holds trivially rather than by a colour/word pairing.
- **Live vs matched control** — the arm comparison (see below), with **Outside benchmarks** as a secondary card beneath it (see below).
- **Analysts** — weight track with the **numeric percentage** beside it and signed rolling-R with its window in days, with the note that neither is a hit rate: the wire carries no per-analyst accuracy.
- **Closed trades** — one row per `closed_trades[]` entry: instrument, side, when (clock on the snapshot's day, date otherwise), held duration, close reason **as a word** (stop hit / target hit / exit / flattened / signal decay / direction flip), a "why taken" summary from the joined debate (direction · rounds · lead analyst by influence), and signed net P&L. A row opens the drawer.
- **Trade drawer** (`Trade detail`) — why taken, the stage timeline when the trace is still inside the window (else the aged-out sentence), gates and conditions keyed by **`debate_id`** (the only key a closed trade carries; the drawer says when no trace id reaches the trade), the debate, a **P&L breakdown** (gross, fees, net, with entry and exit prices and the notional at entry as `filled_size × entry_price`), and the fills under the trade's order key. The drawer head carries the seal of the verdict reached through the trade's Risk row, and no seal when no verdict reaches it.

#### Arm comparison panel ([#971](https://github.com/dd-jp/samurai-trading-system/issues/971), under [#636](https://github.com/dd-jp/samurai-trading-system/issues/636)/[#913](https://github.com/dd-jp/samurai-trading-system/issues/913))

**Both arms or neither.** The panel renders the live arm and the control arm together, never one alone. A page that shows only the live arm's return is the buy-and-hold-comparison failure mode in a different costume: it invites the reader to score the system against nothing.

**No branch of this panel may render a return without its drawdown.** This is `docs/research/12-edge-hypothesis-critique.md` **D4** at the presentation layer, and it mirrors [#753](https://github.com/dd-jp/samurai-trading-system/issues/753)'s AC5 at spec level: **return and max drawdown are one unit of display**, for both arms, in every state — headline, trend row, and any future compact or summary rendering. The wire type enforces it (`ArmPerformanceWire.max_drawdown_pct` is required, not optional) so that a component *cannot* be given an arm without its drawdown; the spec-level rule is what that type exists to serve, and it binds any new branch added later.

**Matched windows, stated on the page.** Both arms are shown over the identical window the Feedback Loop measured them over (doc 12 gate 4 — one query, one window), and the window is displayed, not implied. Two arms over two windows is not a comparison, and a reader cannot tell the difference unless the page says.

**Trade counts beside the percentages.** A percentage over two trades and a percentage over two hundred look identical; the counts are what stop the panel from over-claiming.

**Empty state is honest, not zero.** Before the Feedback Loop has computed a sample the panel says so — it does not render 0.00% for both arms, which is a claim (the arms tied) rather than the truth (nothing has been measured).

**Divergence is shown, not just alerted.** When the Feedback Loop's most recent sample crossed the divergence line, the panel says so and carries the same reason sentence the trade-channel alert carried, so the page and the alert never disagree.

**A non-divergence must not be rendered as a passing result — and the wire now carries what it takes to tell the two apart ([#982](https://github.com/dd-jp/samurai-trading-system/issues/982)).** `diverged: false` covers two states: dominance was tested and not found, and — below FL's per-arm closed-trade floor — dominance was never tested at all. `ArmComparisonRow.min_trades_per_arm` carries the floor the verdict was actually evaluated against, stored per row rather than read live off the current policy constant (the same choice `basis` makes on this type, for the same reason: a row is a record of what FL tested at `computed_at`, and the trend list below renders many historical rows at once). The panel uses it to name which state a given row is in:

- **Below the floor on either arm** — dominance was never tested. The panel makes no claim about the control; it states the trade counts against the floor instead ("not enough closed trades yet for a verdict — the floor is *N* per arm (live *x*, control *y*)").
- **At or above the floor on both arms** — dominance WAS tested and the control did not win, so the panel states the claim directly ("did not diverge: the control is not ahead of the live arm on both return and drawdown together"), which is provably true here since this branch is only reachable once the floor is cleared.

The trend list (below the headline) renders many historical rows at once, and without marking each one this is exactly where a per-row floor earns its keep: a below-floor row there would otherwise be pixel-identical to a tested-and-did-not-diverge row — both show `diverged: false`. Each row is checked against its own `min_trades_per_arm`, and a below-floor row gets its own class (`arm-trend-below-floor`, styled neutral — never the diverged row's alert colour) plus the word "below floor" in the row itself, so colour is never the only carrier (this page's rule, "Colour" section below).

**The convergence asymmetry is stated on the panel.** The control arm always trades; the live arm can decline to when the debate does not converge. A trade-count gap therefore has an innocent explanation, and the panel says so rather than leaving the reader to infer a performance story from a participation difference.

**Refused passes are three states, not two (added 2026-09-10, [#1483](https://github.com/dd-jp/samurai-trading-system/issues/1483)).** `ArmPerformanceWire.refused_pass_count` counts passes over the window skipped by `control_arm_valuation_refused` ([#1099](https://github.com/dd-jp/samurai-trading-system/issues/1099)) — invisible to the trade count beside it, which only counts closed trades. A positive count is shown on the arm it belongs to; `0` renders nothing, because there is nothing to report. `null` — a row computed before migration 0057 persisted the count — is never folded into the `0` case: reading it as zero would assert "no refusals happened" for a window this row never actually measured, the exact silence #1483 exists to break. `null` is a property of the ROW, not of either arm alone (both columns are written together or not written at all, per migration 0057), so the panel states it once per row rather than once per arm.

**Read-only, and computed elsewhere.** The panel projects `arm_comparison_samples` rows the Feedback Loop wrote (`feedback-loop-spec.md`, "The matched-control comparison"). `buildSnapshot` must not compute or re-derive the comparison: the page shows what FL measured and alerted on, or it shows nothing. *(2026-09-15: the Glance P&L headline reuses FL's cumulative-P&L-and-drawdown FUNCTION per arm; it is a separate figure and is never shown as, or in place of, this comparison. This panel renders both arms in either arm view.* **It is also a different POPULATION over a different WINDOW, sampled at a different TIME, not just a different figure ([#1616](https://github.com/dd-jp/samurai-trading-system/issues/1616)): this panel is FL's own configured window, filtered through `oneSizingRegime` and `modelledCostCharged` — see `sqlite-arm-comparison-source.ts` — as of FL's last cycle; the Glance headline's `overall` is every closed trade the arm has ever recorded, unfiltered, computed fresh at render time. The two can report different `net_gbp`/`max_drawdown_pct`/`trade_count` for the same arm; that divergence is expected and not a defect in either reader. The cost filter's live-arm-only asymmetry is one-directional by which arm it touches, but the SIGN of the resulting figure gap is not established — a dropped row can be a loss, which would read worse for the headline, not better.)*

### Outside benchmarks panel — [#981](https://github.com/dd-jp/samurai-trading-system/issues/981), under [#636](https://github.com/dd-jp/samurai-trading-system/issues/636)

**Beside the arm-comparison panel, and visibly subordinate to it.** SPY and 60/40 (SPY/AGG) are secondary context — what the market did over the same window — and the page must not lay them out so they read as the thing to beat. It renders immediately *after* the arm-comparison panel in reading order, carries `panel-secondary`, and says its own status in words ("secondary context, not the control"; "falsifier arm 2 is the matched control") because colour and weight are never the sole carrier of a signal on this page.

**It has no verdict line and no alert styling, and cannot grow one.** The arm panel's loudest element is its divergence claim. This panel has no equivalent, because `OutsideBenchmarkRow` carries no `diverged` field: a "the benchmark won" banner would require a contract change first, which is the point.

**It never renders the arms.** A side-by-side of a benchmark's return and an arm's would invite exactly the comparison the denominators do not support, so the panel prints the caveat instead: a benchmark is fully invested through every night while the book is flat by close, so the two percentages share their units but not their denominator. The wire keeps the names apart too — `buy_and_hold_return_pct`, not `return_pct`.

**Return and drawdown together, on every branch.** D4 binds this panel exactly as hard as the arm panel. `OutsideBenchmarkRow.max_drawdown_pct` is required on the wire, and no branch prints a return without its drawdown beside it. Observation counts accompany both, for the reason trade counts accompany the arms.

**One cycle's rows only, and the window is stated.** The panel renders the rows sharing the newest `computed_at` and prints the window with the sentence that it is the same one the arm comparison used. Rows from two cycles listed together would present two periods as one reading.

**An unmeasured benchmark is named, never drawn as zero.** FL persists nothing for a benchmark whose series it could not fetch, so a cycle can legitimately carry SPY and not 60/40. The panel names the missing one ("Not measured this cycle: … Absent, not zero") rather than dropping it silently or rendering 0.00%, which would be a claim about the market instead of about the measurement. The empty state says the Feedback Loop has measured none yet, for the same reason.

**Read-only, and computed elsewhere.** The panel projects `outside_benchmark_samples` rows FL wrote (`feedback-loop-spec.md`, "The risk-adjusted outside benchmarks"). `buildSnapshot` must not compute a benchmark.

## Motion — none

**Nothing on the page animates.** A poll repaints the page in place; the rail's poll clock and snapshot clock say when. v2's replay motion — chips walking between rooms along recorded transitions, [ADR-0011](../adr/0011-pipeline-theater-replay-motion.md) — is superseded by [ADR-0021](../adr/0021-dashboard-v3-rail-layout.md): the lane matrix has no rooms to walk between, and a cell that reads `done` on the poll that recorded it is already what a repaint does. With no motion there is no `prefers-reduced-motion` branch, no `transitionend` chaining, no `requestAnimationFrame`, and no mid-walk poll to cancel. The stylesheet carries no `transition` or `animation` rule; a reviewer can grep for that.

Two rules survive from v1 and v2 because they are about honesty, not motion: **a poll must never change the page's geometry** (cards are drawn at full size from first paint, empty states included, and data fills reserved space), and **focus must survive a repaint** (story 20's keyboard operation depends on it).

## Design system

Tokens are defined once as CSS custom properties and consumed everywhere; nothing hard-codes a hex.

**Colour** — "Blade & Ink" (2026-08-26): warm lacquer-black ground, not the earlier cool blue-black. The four state colours are unchanged — same hexes, same CVD check, same meanings; only the chrome around them moved.

| Token | Value | Meaning |
| --- | --- | --- |
| `--bg` | `#0C0906` | Page ground (warm lacquer-black) |
| `--panel` | `rgba(255,238,214,.035)` + 1px `#40322A` border | Panel fill |
| `--cyan` | `#38E1FF` | Live / in-flight accent |
| `--go` | `#3DDC7D` | `go`, profit |
| `--amber` | `#FFB454` | `no_go`, `quorum_skip`, warning, staleness |
| `--vermilion` | `#FF4D5E` | `stopped`, loss, error |
| `--text` | `#F0E6D8` | Body text (warm off-white) |
| `--muted` | `#9E8C76` | Secondary text, labels |
| `--gold` | `#C9A25A` | Chrome only — the seal ring, the brand mark, the focus ring. Never a state signal; the six rows above own that job |
| `--lacquer` | `#982420` | Chrome only — section-header rules and the brand mark's accent. A separate token from `--vermilion` on purpose: that colour already means stopped/loss/error, and decorative chrome must never share a hue with a live risk signal. (v2 also spent it on corner-cut wedges and an ink-bleed wash; v3 does not) |

The palette was checked for common colour-vision deficiencies when it was chosen. That check is a floor, not a licence: **colour is never the sole carrier of a signal** anywhere on this page — every state that has a colour also has a word.

**Type** — Chakra Petch (display: stage names, tab names, uppercase labels), IBM Plex Sans (body), IBM Plex Mono (all numerics, so columns of figures align), Shippori Mincho (accent: the brand mark and card section headers only). **Sizes are a v3 decision** (David, 2026-09-04, density grilling): **body 14px, labels never below 11px, headline figures 28–40px**. v2's 9–11px display labels are gone. **Self-hosted via `@fontsource`** and bundled into the build. Zero external requests is a hard requirement (story 21), not a preference.

**Spacing** — an 8px baseline scale (`--space-1`…`--space-8`, 4–48px), applied at the outer layout level (rail, panel padding, card gaps, drawer sections). Component-internal spacing with its own documented reason stays off the scale.

**Motif — restrained.** Only two elements carry the theme: the **hanko seals** (可 否 止 略, `--gold` ink-ring) on verdict rows, lane heads and drawer heads, and the **brand mark** on the rail. No kanji watermarks, no blade-cut corners, no lacquer wedges, no ink-bleed wash, no rooms — David's ruling when the Rail was locked. Cards are plain panels with a 1px border.

## Wire Shape

The snapshot is **unchanged apart from five additive fields** (`recorded_at`, `mode`, #971's `arm_comparison`, #1066's `risk_critics`, and [#1316](https://github.com/dd-jp/samurai-trading-system/issues/1316)'s `contract_version`). No shape is renamed, no field is removed, and the server computes nothing new — `risk_critics` is a read and a join, not a computation.

`contract_version: string` is different in kind from the other four: it is not a fact about the trading system, but a stamp of `DashboardSnapshot`'s own top-level field-name list, hashed (FNV-1a) at build time from the interface itself. The client compares it against the same constant its own build computes, before trusting anything else on the snapshot — see `contracts/snapshot.ts`'s doc comment on the field for the full mechanism, and the MISMATCH state above for what happens when they disagree.

`risk_critics` carries `RiskCriticRow[]`, one per recent Risk decision (`contracts/snapshot.ts`): the `(trace_id, instrument)` pair, the `debate_id` the decision attacked, the `binding_constraint` `risk_log` recorded, the critic's verdict and reasoning, and its `conditions` / `dropped_conditions` — both **required and nullable**, since `JSON.stringify` drops an `undefined` field and "carries none" must not reach the browser as "was never projected". `null` and `[]` are the same `no_conditions` state, as [#997](https://github.com/dd-jp/samurai-trading-system/issues/997) Q3 requires, so a pre-fold row needs no branch of its own. Each condition is flattened to id, an observable **label**, comparator, threshold, state and observed value; the label is projected server-side rather than reconstructed in the browser, because `InvalidationObservable` nests `IndicatorSpec` and `BarWindow` and duplicating those onto the wire would put one vocabulary in two places.

```typescript
interface PipelineCell {
  stage: PipelineStage;
  state: PipelineCellState;   // done | live | stopped | skipped | not_reached
  duration_ms: number | null;
  decision: string | null;
  attempts: number;
  /**
   * ISO timestamp of this stage's last `audit_log` row (#535).
   * `null` for `not_reached`, `skipped`, and `live` cells — a live stage has
   * no completed row yet, and `PipelineView.live_entered_at` is its clock.
   *
   * This field is what makes replay motion honest: it is the recorded time of
   * a transition, so the client animates rows it can point at rather than
   * inventing a path between two observations. Last-write-wins on a retried
   * stage, matching the `attempts` rule.
   */
  recorded_at: string | null;
}

interface DashboardSnapshot {
  // ... generated_at, as_of, tick_status, positions, debates, verdicts,
  //     analysts, metrics, providers, llm_spend, pipeline — all unchanged.
  /**
   * The run the operator is looking at, resolved by the dashboard entry point
   * from the same `SAMURAI_MODE` variable `sharedStorePath()` already reads.
   * On the wire because the browser cannot see the server's environment, and
   * a mode word baked into the bundle would keep saying "paper" during a live
   * run — the one time being wrong matters.
   */
  mode: 'paper' | 'live';

  /**
   * The Feedback Loop's matched-control samples, newest first (#971). A
   * projection of `arm_comparison_samples` — `buildSnapshot` re-derives
   * nothing. Present and empty (never absent) before FL has computed one, so
   * the panel can tell "not measured yet" from "measured as a tie".
   */
  arm_comparison: ArmComparisonRow[];
}

interface ArmPerformanceWire {
  arm: 'live' | 'control';
  trade_count: number;
  realized_pnl_net: number;
  return_pct: number;
  /**
   * REQUIRED, deliberately — doc 12 D4 in the type system. An optional
   * drawdown would make a return-only arm a representable value, and the
   * panel's "no branch renders a return alone" rule would then be a
   * convention instead of a guarantee.
   */
  max_drawdown_pct: number;
  /**
   * Added 2026-09-10 (#1483). Passes over this window (#1099) skipped by
   * `control_arm_valuation_refused` — invisible to `trade_count`, which only
   * counts closed trades. `null` for a row computed before migration 0057
   * persisted the count, never a fabricated `0`: `0` asserts "no refusals
   * happened", which is not knowable for those rows. See "Arm comparison
   * panel" below for how the panel renders the three states.
   */
  refused_pass_count: number | null;
}

interface ArmComparisonRow {
  computed_at: string;        // ISO — no `Date` on the wire
  window_from: string;
  window_to: string;          // the ONE window both arms were measured over
  basis: number;
  live: ArmPerformanceWire;
  control: ArmPerformanceWire;
  diverged: boolean;
  divergence_reason: string | null;   // non-null exactly when `diverged`
  min_trades_per_arm: number; // #982 — the per-arm closed-trade floor THIS
                               // verdict was tested against, stored per row
                               // like `basis` (see the panel section above)
}
```

**If `mode` is absent from a payload, the strip renders "mode unknown".** It must never fall back to "paper": a missing field is ignorance, and displaying ignorance as the safe case is how an operator ends up watching live money on a page that says paper.

*Ownership note.* [Map #533](https://github.com/dd-jp/samurai-trading-system/issues/533) decision 2 named `recorded_at` as the single additive wire field; `mode` is a second one, surfaced by this spec because the v2 telemetry strip needs a mode word and **the browser has no other honest source for it** — the server resolves `SAMURAI_MODE`, the bundle cannot see it, and a value compiled into the bundle would keep claiming "paper" during a live run. It is the same class of change as `recorded_at` (one projected field, no new computation) and belongs with whichever ticket touches the server ([#539](https://github.com/dd-jp/samurai-trading-system/issues/539)). The "mode unknown" fallback exists so the client is correct whether or not it has landed.

## Implementation Decisions

### Module: Query Store

**Responsibilities**
- Wrap the shared SQLite store's read queries the snapshot needs.
- No writes, ever.

**Key Interfaces**

```typescript
// The single dependency buildSnapshot takes. Read-only by construction.
interface DashboardQueryStore {
  getOpenPositions(asOf: Date): OpenPosition[];               // Execution
  getRecentDebates(limit: number, asOf: Date): DebateLog[];    // Debate Engine
  getTickStatus(asOf: Date): TickStatus | null;                // Orchestrator (coarse, in-progress only)
  getVerdictHistory(limit: number, asOf: Date): VerdictAuditEntry[];  // Verdict / audit_log
  getRiskCritics(limit: number, asOf: Date): RiskCriticRecord[];      // risk_log + trader_log + risk_critic_log (#1066)
  getAnalystWeights(asOf: Date): Record<string, number>;       // Feedback Loop
  getAttribution(asOf: Date): Record<string, AttributionSummary>;    // Feedback Loop
  getDailyMetrics(asOf: Date): MetricsSuite;                   // Feedback Loop (cost-model-owned computation)
  getMark(instrument: string, asOf: Date): Mark;               // Market Data Service, for unrealized PnL
  getLlmSpend(asOf: Date): LlmSpendSummary;                    // llm_spend (0010) + llm_spend_cap (0047)
  getPipelineActivity(asOf: Date): PipelineActivity;           // audit_log + current_tick (migration 0013)
}

interface TickStatus {
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  stage: 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
  trace_id: string;
}

interface VerdictAuditEntry {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  reason: string;          // the gate that fired, or 'approved'
  hitl_override: boolean;
  timestamp: Date;
}

interface AttributionSummary {
  analyst_id: string;
  rolling_r: number;       // rolling realized-R contribution
  window_days: number;
}
```

- `OpenPosition`, `DebateLog`, `Mark`, `MetricsSuite` reuse the exact types already defined in execution-spec.md, debate-engine-spec.md, market-data-service-spec.md, and cost-model-backtest-spec.md respectively (via cross-spec-contracts.md) — the Dashboard defines no competing shapes.
- `TickStatus` is sourced from the Orchestrator's `current_tick` table (orchestrator-spec.md, Tick Runner module) — a small upserted-per-instrument row (`instrument`, `asset_class`, `stage`, `trace_id`, `updated_at`), deleted on tick completion. Disposable/best-effort by design — a crash mid-tick just leaves a stale row that gets overwritten or cleared next tick, not a data-integrity concern.

### Module: Snapshot (presentation seam)

**Responsibilities**
- One pure function that projects `DashboardQueryStore` reads into the JSON-serializable wire payload the page polls.

**Key Interfaces**

```typescript
// Primary server-side test seam — a pure function of (store, asOf),
// independently testable against a fake DashboardQueryStore.
function buildSnapshot(store: DashboardQueryStore, asOf: Date): DashboardSnapshot;
```

- Unrealized PnL computed the same way the CLI originally specified: `(mark − entry) × filled_size` for buys, `(entry − mark) × filled_size` for sells — always `filled_size`, never `requested_size`.
- All `Date` fields are serialized to ISO strings at this boundary — `buildSnapshot` is the single place that crosses the HTTP/JSON boundary; nothing downstream of the wire sees a `Date` object.
- Composes `getRecentDebates` (completed history) with `getTickStatus` (the coarse in-progress line) — see the "pending debates" scope-reduction decision.

### Module: Provider Status & LLM Spend

**Retro-documented from shipped code** (`server/apps/service-api/provider-status.ts`, `LlmSpendSummary`/`LlmSpendWindow`/`LlmPerDebateStats` in `server/apps/service-api/types.ts`).

**Three providers, three different shapes — because the facts differ, not for presentational convenience.**

- **Alpaca** — a real broker balance (`GET /v2/account`), polled live. `AlpacaTile.balance` is `null` unless `state === 'ok'`: a stale balance shown next to a failed probe reads as current, which is worse than showing nothing.
- **Polygon** — **reachability only.** Polygon sells a subscription and exposes no balance, credits, or quota endpoint, so the tile reports whether the key works and nothing more.
- **LLM spend** — **locally metered**, not an account balance and not an invoice. The provider publishes no credit-balance endpoint reachable with a plain API key, so this is what *this bot* spent, counted from the `usage` block on each response into the `llm_spend` table (migration `0010_llm_spend.sql`).

**Flattening these into one uniform "balance" field would require inventing two numbers that do not exist.** That is the reason the panel is three shapes.

**Where each lives, and why they are not on one interface.** `getLlmSpend` sits on `DashboardQueryStore` because `llm_spend` genuinely *is* a shared-store table written by another component (the debate engine's LLM client) — the same relationship this store has to `open_positions` or `verdict_log`. The Alpaca and Polygon tiles come from a separate injected `ProviderStatusReader`, because they are live third-party probes, not store reads. Its poller runs on its own `DEFAULT_POLL_INTERVAL_MS` (60s) rather than the page's 3s poll: both probes cost a real API call, and a balance only changes when a fill lands.

**Honest caveats travel with the numbers, always.** Both of the following must be rendered by the spend panel whenever their counts are non-zero — not one of them, and not in a tooltip.
- `unpriced_calls` — calls whose model is absent from the rate table contribute tokens but no dollars, so a non-zero count means `cost_usd` is a **floor, not a total**. This is the same failure ADR-0008's startup refusal of unpriced models exists to prevent, surfaced after the fact. It also means the burn meter is a **lower bound** on consumption of the cap, and must say so rather than implying precision.
- `unattributed_calls` — calls with no `debate_id` are in the window total but in **none** of the per-debate figures.
- Rows written before migration `0012` have a `NULL` `latency_ms` and are excluded from the latency sum rather than counted as zero, so an old row cannot drag a percentile toward zero.

**Rolling windows, not calendar days** (`last_24h` / `last_7d` / `all_time`). A UTC-day bucket would disagree with the operator's wall clock; this system already has one hard-won lesson (#332, `session_equity`) about blended reset boundaries nobody verified. "Last 24 hours" needs no boundary to be right about.

**p50/p95 across debates, never a mean.** LLM latency is long-tailed — a retried call adds a whole extra attempt — and a mean over that tail reports a duration no debate actually experienced. Note the field name is literal: `llm_latency_ms_*` is **time spent inside LLM calls**, not the debate's wall-clock elapsed time. The two differ whenever calls overlap or a call is retried; `llm_spend` has no debate start/end, so time-in-provider is the only figure it can honestly report.

**The `Anthropic` label dies with the old UI.** v1's rendered tile header read `Anthropic · spend 24h`, naming a provider this system no longer talks to since [ADR-0009](../adr/0009-single-provider-nous.md) moved all LLM traffic to **Nous** — a known, untracked follow-up that this spec sentence was the closest thing to a ticket for. The v2 spend panel is written from scratch and must not carry the word forward; the doc comments in `types.ts` that still say "Anthropic" remain a separate mechanical rename. The numbers were always correct; only the word was wrong.

### Module: Web client (`client/`)

**Responsibilities**
- Render the Rail — three tabs and the rail — from `DashboardSnapshot`, and nothing else. It holds no domain logic: every number it shows is computed server-side, with one stated presentation-level exception (open risk, `lib/glance.ts`), which is arithmetic over wire rows and is labelled on screen with what it is computed from. *(Until 2026-09-15 P&L today was a second exception; it is now a wire figure, #1590.)*

**Structure**
- **Vite + React**, output to `dist/client/` with a relative `base` so the bundle is servable from disk without a path prefix.
- `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, the `@fontsource` packages and the test tooling are **devDependencies**. `dependencies` remains exactly `better-sqlite3`. The build becomes `tsc && vite build`; `client/` falls outside `tsconfig.build.json`'s `include` (`server/` + `contracts/`) and owns its own tsconfig. It needs no `exclude` entry — being a sibling of `server/` rather than a directory inside it is what removed the need.
- **`client/src/lib/` is pure and React-free** — this is where the client's real logic lives and where it is tested:
  - `ledger.ts` — settle detection, `trace_id` dedupe, ordering, the 30-entry cap, and first-paint seeding (unchanged from v2).
  - `glance.ts` — open risk (notional, stop distance, stop→target progress) as pure functions of `positions[]` / `closed_trades[]`.
  - `trace.ts` — the joins the drawers make: lane by instrument or trace, verdict by trace, Risk critic by `trace_id`+instrument or by `debate_id`, latest debate by instrument, debate by id, fills by order key.
  - `vocabulary.ts` — every state, outcome, close reason, condition state and provider state as a **word**, and the seal glyphs. The one place a wire enum becomes screen text.
  - `format.ts` — durations, `HH:MM:SSZ` clocks, dates, held durations, signed money, percentages and R.
- **`components/`** — `Rail`, `Seal`, `StateWord` (every wire-state-to-tone mapping lives there), `Track` (the one horizontal meter), `StanceStrip`, the shared drawer sections (`TraceSections`: timeline, gates and conditions, debate, fills) and the three tabs under `components/tabs/`. All declarative; there is no DOM-imperative code in the app.
- **`hooks/useSnapshot.ts`** owns the 3s poll (`cache: 'no-store'`), the two-missed-polls staleness watchdog, and retention of the previous snapshot for the ledger's settle detection.
- **`hooks/useLedger.ts`** folds each polled snapshot into `lib/ledger.ts`'s transition, producing the session's verdict ledger.
- **`hooks/useEquitySamples.ts`** owns the equity-sampling rule the Glance sparkline draws from: dedupe on an unchanged poll, the non-finite-equity guard, and the front-eviction cap.
- **`App.tsx`** owns the tab (read from and written to `location.hash`), the Live and Review selections, and the Glance→Live jump that carries a `trace_id`.

**Untrusted strings.** `instrument` and `decision` reach the page from the database and are rendered as text, never as markup — React's default escaping is the mechanism, and a hostile instrument string is a test case, not an assumption.

### Module: HTTP Server

**Responsibilities**
- Serve the static bundle and the JSON snapshot; nothing else.

**Key Interfaces**

```typescript
interface DashboardServerOptions {
  port: number;
  host: string;              // defaults to 127.0.0.1
  store: DashboardQueryStore;
}

interface DashboardServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- Two `GET` surfaces: the static bundle in `dist/client/` (`/` → `index.html`, plus hashed JS/CSS/font assets) and `/api/snapshot` → `buildSnapshot(store, new Date())` as JSON. Everything else → `404`.
- The static handler is hand-rolled (~30 lines): resolve the request path against the bundle root and **reject anything that is not contained by it**, plus a small content-type map (`html`, `js`, `css`, `svg`, `woff2`, `map`). Serving files from disk is the one genuinely new attack surface v2 introduces, and the guard is a required test, not a nicety.
  - **Containment, not string prefix.** `resolved.startsWith(root)` is *not* the check: it accepts any sibling directory whose name merely begins with the root's, so a `dist/client-evil/` next to `dist/client/` escapes the bundle without using a single `..` segment. Use `!path.relative(root, resolved).startsWith('..')` — or a prefix check against `root + path.sep` — which asks about directory containment rather than about characters. See [ADR-0010](../adr/0010-dashboard-vite-react-rewrite.md).
- Any non-`GET` method to a known path → `405` (not a silent `404`), so a misuse is obvious in dev tools. No `POST`/`PUT`/`DELETE` handlers exist by construction — the write-path exclusion is structural, not a convention.
- Built on Node's built-in `http` module — **no new runtime dependency**; the bundle is bytes on disk, and the framework that produced it exists only at build time.
- `host` defaults to `127.0.0.1`, set via `HOST` env var; a `HOST` outside the loopback allowlist (`127.0.0.1`/`::1`) also requires `SAMURAI_DASHBOARD_TOKEN` to be configured (non-empty), or the server refuses to start ([ADR-0019](../adr/0019-dashboard-hosting-topology.md), [#887](https://github.com/dd-jp/samurai-trading-system/issues/887)). `port` defaults to `8787`, via `PORT` env var. Independently of that boot-time gate, `GET /api/snapshot` requires a matching `Authorization: Bearer` header on every request once `SAMURAI_DASHBOARD_TOKEN` is configured, regardless of `host` ([#1038](https://github.com/dd-jp/samurai-trading-system/issues/1038), `server/apps/service-api/request-auth.ts`); the static bundle route is not gated.

## Accessibility floor

Non-negotiable, and unchanged in spirit from v1 — the screen got more visual, so these get more important, not less.

- **Outcome words in accessible names.** Every lane's `aria-label` names its instrument, asset class, outcome and stage **in words** (`"BTC-USD, crypto, go, at Execution"`); every verdict row names instrument, outcome, any human override and the reason; every closed-trade row names instrument, side, close reason and signed P&L. Colour is decoration rather than data.
- **Colour is never the only signal** — states carry words, PnL carries an explicit sign, the live cell carries the word `live` as well as the accent, the stale rail carries a status sentence as well as a border.
- **Keyboard-operable.** Tabs, lanes, verdict rows, trade rows and both drawers are reachable and operable by keyboard, with a visible `:focus-visible` style. **Focus must survive repaints** — a 3-second poll that steals focus makes the page unusable with a keyboard.
- **Empty states name their reason.** Never a bare dash, never a spinner that cannot resolve. "Trader and Risk carry no decision word (#328)" is a legitimate empty state; a blank cell is not.
- **No motion, so nothing to reduce.** There is no `prefers-reduced-motion` branch because there is no animation for it to suppress (see "Motion").
- **No pulsing.** Beyond the design preference, a page whose status indicators pulse indefinitely is a page that is harder to read for anyone sensitive to motion.
- **Wide content scrolls inside its own container** (the lane matrix, the closed-trade table); the page body never scrolls sideways. On Live and Review the tab is pinned to the viewport: the main column and the drawer scroll vertically on their own, independently, and the page does not scroll (on Live the lane list scrolls beneath its pinned header row). Glance keeps ordinary page scrolling.

## Testing Decisions

- **Server seam: `buildSnapshot`.** Good tests assert on the *returned snapshot given fixed `DashboardQueryStore` data* (e.g., a fake store returning two open positions produces two `PositionRow`s with correct PnL), not on HTTP internals or real database state.
- **Client seam: `client/src/lib/`.** The ledger, the Glance figures and the trace joins are pure functions of snapshot rows and are tested without a DOM: ledger dedupe/cap/ordering/seeding; open risk for long and short, a mark through the stop, and a zero-width bracket; the Risk-critic join matching trace **and** instrument, never one alone; fills filtered by order key.
- **Component tests (RTL)** cover what a screenshot cannot: lane, verdict-row and trade-row accessible names; the ledger deduped across a re-poll; the HITL badge; a verdict row opening Live on **its** trace rather than the instrument's current one; the selected trace's conditions rather than an older row's; every named empty state on both drawers and all three tabs; the stale rail with its status sentence; "mode unknown"; the spend meter's floor caveat and not-drawable state; focus surviving a poll; and a hostile instrument string rendering inert.
- **End-to-end (Playwright) against the real fixture server** (`e2e/`): boot regions on all three tabs, the hash following the tab, every lane name from the fixture universe, the seeded verdict list with its HITL row, the Glance→Live jump, a closed trade's P&L breakdown and fills, keyboard reachability of tabs/lanes/rows, a settle between polls stamping exactly one row, and two missed polls marking the rail stale while the numbers stay. Every request the page makes is same-origin or the test fails.
- **Server tests** assert on HTTP status/body for each route (`GET /`, a bundle asset, `GET /api/snapshot`, unknown path, non-`GET` method) and on the **static containment guard** against an injected fake store — no real network dependency beyond binding to an ephemeral port (`port: 0`). Two escapes must both be covered: `..`/percent-encoded-`..` traversal, **and** a sibling directory whose name shares the bundle root's prefix (`dist/client-evil/`). The second is the one a naive `startsWith` passes the first test while remaining open to, so a suite that only tests `..` proves nothing about it. Request-time token verification (#1038) is covered the same way: a real HTTP round trip against a server constructed with a fixture credential, asserting 401 for a missing/wrong/malformed `Authorization` header and 200 for the exact token — including a case that proves an unauthorized request never reaches the store (`request-auth.test.ts`, `server.test.ts`).
- **`QueryStore` implementation** is tested against a real (test) SQLite instance seeded with rows matching the other components' own fixture patterns — reuses their existing test data shapes, no new schema.
- **Offline check is part of acceptance:** the built bundle contains no external URL. A grep for `https://` over `dist/client/` is the crude version; the network panel showing zero third-party requests is the real one.
- **Arm comparison panel:** the D4 rule is tested as a *type* obligation as well as a rendered one — a `@ts-expect-error` case proving an arm without `max_drawdown_pct` does not compile, alongside RTL assertions that both arms, both columns, the window and the trade counts are on screen, that the empty state says nothing has been measured rather than showing zeros, and that a diverged sample renders FL's own reason sentence. Both `min_trades_per_arm` (#982) branches are covered separately: below the floor, the panel names the trade counts against it and makes no dominance claim; at or above the floor, `diverged: false` renders the "control is not ahead … together" claim. The trend list's own marking is covered too: a below-floor historical row renders `arm-trend-below-floor` and the "below floor" word, not the diverged row's class or colour. `refused_pass_count`'s three states (added 2026-09-10, [#1483](https://github.com/dd-jp/samurai-trading-system/issues/1483)) are each covered: `0` on both arms renders no "refused" text at all; a positive count renders on the arm it belongs to and not the other; and `null` on both arms renders the "not tracked" note exactly once for the row, not once per arm — the case a naive per-arm rendering would double.
- No end-to-end trading test needed — this component cannot affect trading outcomes by construction (read-only).

## Out of Scope

- **Any write path** — no manual trade actions, kill-switch trigger, or config editing. Strictly read-only (decision, not an oversight).
- **A terminal CLI** — superseded by this dashboard; `src/cli/` was removed when v1 landed. <!-- cite-exempt: historical — a statement about a removed tree; the sentence is true precisely because the path does not resolve -->
- **Real-time push/streaming** — client-side polling only. Re-affirmed for v2 and v3: nothing on the page needs finer than the 3-second poll.
- **Any limit the wire does not carry** — the design canvas's daily-loss stop, position cap and flat-by-close countdown. They reach the rail when a component that enforces them puts them on `DashboardSnapshot`, never from a client constant ([ADR-0021](../adr/0021-dashboard-v3-rail-layout.md)).
- **Per-debate cost and LLM latency percentiles on screen** — still on the wire, not rendered (see the Information Inventory note).
- **A true in-flight/live debate-round view** — the Debate Engine's ephemeral operational round state isn't persisted (decision #10); only completed debates plus a coarse tick-status line are observable.
- **Remote/public access, HTTPS, a login UI** — LAN reachability needs a `HOST` outside the loopback allowlist plus a configured (non-empty) `SAMURAI_DASHBOARD_TOKEN` ([ADR-0019](../adr/0019-dashboard-hosting-topology.md), [#887](https://github.com/dd-jp/samurai-trading-system/issues/887)); that token is now also verified per request against `GET /api/snapshot` ([#1038](https://github.com/dd-jp/samurai-trading-system/issues/1038), shipped — see "Testing Decisions"), but nothing here adds HTTPS, a login form, or public reachability. Matches the single-MacBook deployment target — a hosted multi-user product is a different problem, not designed here.
- **Alerting** — the dead-man's-switch heartbeat and trade notifications are the Orchestrator's/Verdict's concern (already specced); the Dashboard is a pull, not a push, mechanism.
- **Trader/Risk drill-down in the STAGE STRIP** — `audit_log` holds only a digest per stage, so those two cells report that a stage ran and nothing about what it decided. Restated 2026-09-03: `trader_log` and `risk_log` do exist (migration 0016, [#328](https://github.com/dd-jp/samurai-trading-system/issues/328)) and [#1066](https://github.com/dd-jp/samurai-trading-system/issues/1066) now reads the Risk row's binding constraint, and the critic verdict joined from it, into the drawer's invalidation section. `risk_log.status` (approved/rejected/error) stays unread — nothing on the dashboard renders it yet. What is still out of scope here is the rest of the drill-down: the Trader's sizing chain and the full `RiskDecision` (gate-by-gate reasons, exposure snapshot, breaker state), which #328 owns and [#417](https://github.com/dd-jp/samurai-trading-system/issues/417) reserves a surface for. The strip shows an honest empty slot rather than inventing content.
- **Queryable pipeline history.** Glance's verdict list is a **bounded settle-log** — the last 30 decisions observed while the page has been open — not a searchable archive. A lane holds one trace, the most recent inside the 15-minute window. The chronological record of what the pipeline decided remains `verdict_log`, surfaced through `verdicts[]`; a second query path to the same facts is maintenance cost, not a feature.
- **Any change to what the backend computes.** v3, like v2, is a UI rewrite. The wire is unchanged by v3; the additive fields listed in "Wire Shape" each read or join rows another component already writes.

## Further Notes

**Current wayfinder map: [Wayfinder map: dashboard v3 — Rail client rewrite](https://github.com/dd-jp/samurai-trading-system/issues/1090)** (2026-09-04), which locked the decisions this v3 synthesizes and supersedes the layout, rooms-theater and motion portions of [Wayfinder: dashboard v2 — mission-control rewrite (Vite+React) + rooms pipeline theater](https://github.com/dd-jp/samurai-trading-system/issues/533) (2026-08-07). #533's data-inventory, honesty and hosting decisions carry forward unchanged; #533 in turn superseded the pipeline-tab portions of [Wayfinder: dashboard pipeline view](https://github.com/dd-jp/samurai-trading-system/issues/411)/[#412](https://github.com/dd-jp/samurai-trading-system/issues/412). The original dashboard decisions are in [docs/wayfinder/dashboard-map.md](../wayfinder/dashboard-map.md), kept as the historical record from before maps moved to GitHub issues — its "not a framework SPA" line is superseded by ADR-0010 and is not a live constraint.

Three architectural decisions ride with the rewrites and are recorded as ADRs rather than buried here:
- [ADR-0010 — Dashboard v2: a built Vite+React client](../adr/0010-dashboard-vite-react-rewrite.md) — stands.
- [ADR-0011 — Pipeline theater: motion as replay, not interpolation](../adr/0011-pipeline-theater-replay-motion.md) — **superseded** by ADR-0021.
- [ADR-0021 — Dashboard v3: the Rail layout, three tabs, no motion](../adr/0021-dashboard-v3-rail-layout.md) — the record of this rewrite.

This closes OPEN-GAP-B (docs/specs/cross-spec-contracts.md) — the Dashboard is the 12th and final charted/specced component. It has zero write-path risk by construction, so it can be implemented and iterated on independently of the trading-critical components without affecting their correctness.

**Supersedes the CLI spec (2026-07-14).** OPEN-GAP-B originally resolved to a terminal CLI, explicitly declining a web dashboard. That decision was reversed on 2026-07-21 after `src/dashboard/` (now `server/apps/service-api/`) was built ahead of any map or spec (discovered during a project health check) and grilled to a decision: the dashboard replaces the CLI rather than complementing it, since it subsumes every read the CLI provided with better ergonomics. `src/cli/` (render functions + types, tested, but with a placeholder entry point never wired to a runnable command) was removed in that change. This file was `cli-spec.md`, renamed and rewritten in place, then rewritten again here for v2. <!-- cite-exempt: historical — both cited paths on this line describe trees removed in the 2026-07-21 reversal -->

**WorldMonitor Deferred-Shell Contract (#177 resolution), now discharged.** The pattern — reserve a live-updating region's slot before its async data arrives, rather than reflowing the layout when it does — is exactly what the rail, the cards and the drawers do: each is drawn at full size from first paint, empty states and unavailable figures included, and data fills reserved space. A poll must never change the page's geometry.
