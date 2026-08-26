# Dashboard Specification

**Status:** Draft (v2 — mission control; resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-08-07 (v2 rewrite; supersedes the 2026-07-21 two-tab spec, which superseded the 2026-07-14 CLI spec — see "Further Notes")

## Problem Statement

Every other component in this system writes to the shared SQLite store — positions, fills, debates, verdicts, weights, the `audit_log` — but nothing lets an operator actually look at it. Right now, knowing what Samurai is doing means querying the database by hand. The vision's Definition of Done calls for exactly this: "Dashboard or CLI: current positions, pending debates, verdict history, per-analyst performance" — and it's the one MVP requirement none of the 11 backend components own.

**The Dashboard** is that missing operator view: a read-only web tool an operator opens in a browser on (or on the LAN of) the same MacBook the Orchestrator runs on, to see what the system holds, what it decided, and how it's performing — without touching anything.

**What v2 changes.** v1 answered the question and read as a debug page: two tabs, four tables, and a stage rail whose chips teleported. The system it describes is a machine with seven rooms that instruments walk through, and the page should read that way at a glance from across the desk. v2 is a wholesale UI rewrite — one mission-control screen, a pipeline theater as its hero, a verdict ledger as its permanent record — with **no change to what the backend computes**. Every datum v1 showed still appears (see "Information Inventory"); the honesty conventions v1 established are unchanged and, in the motion rules, sharpened.

## Solution

The Dashboard is a **thin, read-only presentation layer** with **zero new backend logic and zero new write path**. It queries the same shared SQLite store every other component already writes to, through the same `DashboardQueryStore` read interface, and serves one page: a **static Vite+React bundle** that polls a JSON snapshot endpoint every 3 seconds for positions, debates, verdicts, per-analyst performance, third-party provider status with LLM spend, and the pipeline. It can never place, block, or modify a trade — its blast radius is exactly "an operator reads something."

*One qualification on "zero new backend logic", carried from v1: the Alpaca/Polygon tiles are **live outbound probes** on their own 60s poller, not store reads. They are read-only `GET`s that cannot touch an order, so the blast-radius claim above is unaffected — but the dashboard is no longer purely a reader of SQLite, and a reviewer should know that before assuming it makes no network calls.*

One process, one command (`yarn dashboard`), two `GET` surfaces: the static bundle (`/`, plus its hashed assets) and `/api/snapshot` (the JSON payload the page polls, still pipeable to `curl` for scripting). The bundle is built ahead of time by `vite build` and served from disk by the same `node:http` server — there is no second process, no dev server in production, and no request the page makes to any host other than its own origin.

Key architectural decisions:
- **Direct SQLite reads via `DashboardQueryStore`, no new message bus or subscription layer** — simplest thing that works for a single-operator, single-host tool.
- **Client-side polling refresh at 3s** — the page re-fetches `/api/snapshot` on an interval; no push, no SSE, no WebSocket. Explicitly re-affirmed for v2 ([map #533](https://github.com/dd-jp/samurai-trading-system/issues/533) decision 4): the animation runs off what two polls recorded, which needs no new transport.
- **One payload, one `as_of`** — everything the screen renders comes from a single `DashboardSnapshot`. A second endpoint would let panels disagree about what time it is.
- **A built React client, not a hand-rolled HTML string** — reverses v1's no-framework/no-build-step decision. See [ADR-0010](../adr/0010-dashboard-vite-react-rewrite.md). Runtime dependencies are unchanged: `react`/`vite`/`@fontsource` are **devDependencies** compiled to static assets, and `better-sqlite3` stays the only entry in `dependencies`.
- **Motion is replay, never interpolation** — a persona walks only along transitions the store actually recorded. Reverses v1's "no transit animation" rule. See [ADR-0011](../adr/0011-pipeline-theater-replay-motion.md) and "Motion" below.
- **"Pending debates" scope reduction, explicitly flagged** — the Debate Engine doesn't persist in-flight round state (decision #10, unchanged); the screen shows recent completed debates plus a coarse "tick in progress" line from the Orchestrator, not a live debate-round view.
- **No interactivity beyond viewing** — selection, drawers and keyboard navigation only. No manual overrides, no kill-switch, no config editing. `GET` is the only method the server implements.
- **LAN-only opt-in, no auth** — binds `127.0.0.1` by default; reachability from another device on the operator's LAN is an explicit `HOST` env var opt-in, not a default. No auth layer, no HTTPS, no public exposure.
- **Test seams: `buildSnapshot` on the server, pure `lib/` modules on the client** — the walk plan, room layout and ledger are pure functions of two snapshots, unit-tested without a DOM.

### Visual source of truth

`docs/prototypes/dashboard-v2-mission-control.html` is a self-contained, offline-openable prototype of this screen, chosen by David on 2026-08-07 over a "Gate Path" transit-row alternative. It is the reference for layout, spacing, palette in situ, room grid, sigil chips, hanko stamps and walk feel. Two caveats for whoever implements against it:

- The prototype's **"protobar"** (the floating layout/scenario toggles) is a prototyping affordance only and must not ship.
- The prototype runs on scripted fixtures, so its animation is unconstrained by recorded data. **This spec's Motion section wins over the prototype wherever they differ** — the prototype shows what a walk should look like, not when one is allowed.

## Information Inventory

Every datum v1 rendered must survive the rewrite ([map #533](https://github.com/dd-jp/samurai-trading-system/issues/533) decision 1). This table is the checklist a reviewer walks to prove nothing was lost; it is the acceptance instrument for the component tickets.

| Datum | Wire source | v2 home |
| --- | --- | --- |
| Run mode (paper/live) | `mode` (see "Wire Shape") | Telemetry strip |
| Snapshot clock, staleness | `generated_at` / `as_of` | Telemetry strip |
| Tick in progress (instrument, stage, trace) | `tick_status` | Telemetry strip live-tick readout |
| Alpaca cash / equity / buying power | `providers.alpaca.balance` (null unless `state === 'ok'`) | Telemetry strip |
| Polygon reachability + detail | `providers.polygon.state` / `.detail` | Telemetry strip, as a coloured word |
| LLM spend vs the ADR-0008 cap | `llm_spend.all_time.cost_usd` | Telemetry strip burn meter |
| Open positions: instrument, side, filled size, avg entry, stop, target, mark, unrealized PnL, order state, opened at | `positions[]` | Bento → Positions (price rail) |
| Recent debates: direction, rounds, per-analyst final position, influence, per-round stance | `debates[]` | Bento → Recent debates (stance strips); full detail in drawer |
| Verdict history: status, gate/reason, HITL override, trace id, timestamp | `verdicts[]` | Verdict ledger |
| Settled lanes that never reach Verdict (`stopped`, `quorum_skip`) | `pipeline.lanes[]` | Verdict ledger (see "Verdict ledger") |
| Analyst weights, rolling-R, window days | `analysts[]` | Bento → Analysts |
| Full `MetricsSuite` — Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure | `metrics` | Bento → Metrics suite (reported together, never one number) |
| LLM spend 24h / 7d / all-time, per-debate cost p50/p95, LLM latency p50/p95, `unpriced_calls`, `unattributed_calls` | `llm_spend` | Bento → LLM spend |
| Per-instrument pipeline position | `pipeline.lanes[].cells[].state` | Rooms hero — sigil chip placement |
| Per-stage record: state, duration, decision, attempts, recorded time | `pipeline.lanes[].cells[]` | Drawer → stage strip |
| Trace outcome, final stage, started at, total ms | `pipeline.lanes[]` | Chip outcome ring + drawer header |
| Live trace + when it entered its stage | `pipeline.live_trace_id` / `live_entered_at` | Telemetry strip + live-room glow |
| Invalidation: restated thesis, conditions with evaluation states, validator-dropped conditions with reasons, `no_conditions` vs `unavailable` | **not on the wire yet** — `invalidation_log` is specced and unbuilt (see below) | Drawer → invalidation section, reserved and reasoned |

**The invalidation section is required, not optional — and it is not yet buildable.** It arrives from [devils-advocate-spec.md](devils-advocate-spec.md) via [Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291) as a mandated dashboard surface. But `invalidation_log` does not exist in the codebase today: the stage is specced and not built, which is the same fact that leaves room 04 lights-off. So v2 **reserves the drawer section and names the reason** ("the invalidation stage is specced and not built — devils-advocate-spec.md") rather than either rendering nothing or inventing a field. Stories 4a–4c below describe what fills it the day the stage ships; they are a forward contract, not v2 acceptance criteria. Collapsing two tabs into one screen must not quietly drop the obligation — a reviewer should check the drawer for the reserved section specifically.

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

4a. As an operator, I want the restated thesis and its invalidation conditions with evaluation states shown on the debate detail view, so that I can judge whether the pass understood the trade it was attacking.
4b. As an operator, I want validator-**dropped** conditions listed with their drop reasons, so that prompt quality is inspectable rather than silently degrading.
4c. As an operator, I want `no_conditions` and `unavailable` rendered as **distinct** states, so that "the pass found nothing falsifiable" is never displayed as "the pass could not run".

Driven by `invalidation_log`, joined on `(instrument, bar_timestamp)`. Showing dropped conditions is the entire reason that table stores the raw emission rather than the post-validator list. **That table does not exist yet** — the invalidation stage is specced and not built, the same fact that leaves room 04 lights-off — so v2 ships the drawer section as a reserved slot that names this reason, and the stories above take effect when the stage does. Reserving the slot now is deliberate: it is the WorldMonitor deferred-shell rule, and it means the day the data arrives the layout does not move.

**Limitation that must be shown, not hidden:** the panel reports what the pass *said* and what was breached at emit. It cannot report that **Risk acted on it** — a Risk reject short-circuits before Verdict, so there is no verdict row, and nothing persists `RiskDecision` ([#328](https://github.com/dd-jp/samurai-trading-system/issues/328)). A reject is inferable from a non-empty breached list but is not recorded, and the panel must not imply a certainty it does not have.

### Verdicts

5. As an operator, I want a chronological verdict history (go/no-go, the gate that fired, any HITL override), so that I can audit every decision the pipeline made, not just the ones that resulted in a trade.
5a. As an operator, I want each settled decision **stamped** into a ledger as it happens, so that the record of what the machine decided accumulates in front of me rather than being something I go and look up.

*`hitl_override` is a real column on `VerdictRow` and is still rendered — as a badge on the ledger row — but since [ADR-0007](../adr/0007-fully-automatic-execution.md) it is **always false in live data**: the automation dial is `auto` for both asset classes and `Verdict.decide` never reaches the approval path. Keep the field and the badge: it is the audit record that no human touched a trade, which is exactly the thing a fully automatic system should be able to prove. The badge is therefore expected never to fire; an unexpectedly `true` value would mean the dial moved, which `assertAutomationLevelSupported` now refuses at boot.*

### Performance

6. As an operator, I want current per-analyst weights and their rolling attribution, so that I can see which analysts are earning trust and which are being tuned down — with the weight shown **numerically as well as** as a bar, so the comparison does not depend on judging bar lengths.
7. As an operator, I want the Feedback Loop's daily `MetricsSuite` (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure), so that I see the full metrics picture the research constraints require, not a single vanity number.

### Providers & LLM Spend

**This section documents shipped code that predated it** (retro-documented 2026-08-06). `providers` and `llm_spend` have been on `DashboardSnapshot` since [#326](https://github.com/dd-jp/samurai-trading-system/issues/326)/[#367](https://github.com/dd-jp/samurai-trading-system/issues/367) (`server/apps/service-api/provider-status.ts`, `server/apps/service-api/types.ts`) while this spec still described four views and no spend surface. Written down so the spec stops understating what the page shows — particularly with [ADR-0008](../adr/0008-llm-spend-cap.md)'s $50/14-day cap live, which makes the spend surface a budget instrument, not a curiosity.

17. As an operator, I want my live Alpaca account balance on the page, so that I can see the broker's own view of equity without opening Alpaca.
18. As an operator, I want to know whether Polygon is reachable, so that a dead market-data key is visible as itself rather than as an inexplicably quiet pipeline.
19. As an operator, I want locally-metered LLM spend over 24h/7d/all-time, so that I can see the ADR-0008 budget being consumed while there is still time to act on it.
19a. As an operator, I want all-time spend drawn as a **burn meter against the $50 cap**, so that "how much runway is left" is readable without arithmetic.
20. As an operator, I want per-*decision* cost and LLM latency at p50/p95, so that I can answer "what does one debate cost me, and is round 3 earning its latency?" rather than only "what did today cost".

### Pipeline theater (v2 hero — supersedes the v1 stage-rail tab)

Charted in [Wayfinder: dashboard v2 — mission-control rewrite (Vite+React) + rooms pipeline theater](https://github.com/dd-jp/samurai-trading-system/issues/533), which supersedes the pipeline-tab portions of [#411](https://github.com/dd-jp/samurai-trading-system/issues/411)/[#412](https://github.com/dd-jp/samurai-trading-system/issues/412). The tables answer *what the system holds and what it decided*; the theater answers *where each instrument is in the pipeline right now, and where the last one stopped* — and it is now the top of the screen rather than a second tab.

**Primitive: rooms, not a rail.** Seven numbered rooms (01–07) plus a Lobby, laid out as a **4×2 grid**, with one **sigil chip** per instrument standing in the room its trace last reached. Chosen over the v1 rail and over a "Gate Path" transit row (both prototyped; David chose Rooms on 2026-08-07). The rooms read as the system-as-machine: **where the load is, and where ticks are dying.** Four chips crowded into Risk is the diagnostic that makes the primitive worth choosing.

12. As an operator, I want to see every instrument standing in the room for the stage it last reached, so that a pile-up at one stage is visible without reading a single row.
13. As an operator, I want a stage that was **skipped** to read differently from one that **stopped** the tick, so that routine traffic is never displayed as a halt. `invalidation` runs only for `entry`/`scale_in` intents and never terminates a tick, so "skipped" is the common case there, not an anomaly.
14. As an operator, I want a stage reached more than once in a trace to show its attempt count, so that a retry storm is visible rather than collapsed.
15. As an operator, I want a dormant instrument (market closed, no tick) to read as idle rather than vanish, so that absence of activity is distinguishable from absence of the instrument. Idle chips stand in the **Lobby**, drawn with a dashed edge.
16. As an operator, I want to open one instrument and see that trace's full stage sequence and, for a completed debate, its per-analyst contributions — with the live case stating plainly that round-by-round state is not persisted (decision #10) rather than showing a spinner that will never resolve.

**The primitive's accepted cost, and where the detail went — unchanged from v1.** A sigil chip is a single point, exactly as a rail chip was, so one instrument's own journey is not readable across the rooms, and stories 13 and 14 are *not renderable in the hero at all*: a tick that skipped `invalidation` is not standing in the invalidation room, and a stage retried before the chip moved on has no room to badge. Both therefore live in the drawer's stage strip, which under this primitive stops being supplementary detail and becomes the **sole per-stage record**. The strip must keep listing all seven stages with state, duration, decision and attempt count, including the never-reached ones. Rooms does not fix this; it inherits it, and it was accepted when the primitive was chosen.

**Seven stages, not six.** `analysts → debate → trader → invalidation → risk → verdict → execution`. `invalidation` is specced and not yet built, so today no chip ever stands in room 04 — it is drawn **lights-off**, with its heading saying why. `audit_log.stage` is unconstrained TEXT, so the room fills in on its own the day the stage ships, and the caveat retires itself from the data rather than needing an edit.

**Attribution — migration 0013.** This view is only possible because `audit_log` now carries `instrument`/`asset_class`. Before that, the sole trace_id → instrument links were `current_tick` (in-flight only, deleted at tick end) and `verdict_log` (only traces reaching Verdict), so **every short-circuited tick was attributable to no instrument at all** — an instrument that went quiet because Risk kept rejecting it looked identical to a closed market, and the Risk pile-up the theater exists to show would have been invisible. The writer already held both values; they were never persisted. `NULL` means "not attributable" (pre-migration rows, and the HITL callback path, which records under an existing trace_id with no `Signal` in scope) and must never be guessed onto an instrument.

**Bounded by a window, not a count.** Each instrument shows its most recent trace within a **15-minute lookback, capped at 24 lanes**. The window doubles as the staleness guard: a crash deliberately leaves `current_tick` behind (`tick-runner.ts` — a stale row must be visible, not tidied away), and without the window the screen would report a dead tick as running indefinitely. A lane whose trace ages out of the window becomes `idle`.

**Constraints carried unchanged from v1:** read-only, poll-only on the existing 3s `/api/snapshot`, one payload rather than a second endpoint, and **zero new *runtime* dependencies** — what changed is that there is now a build step producing static assets, not that the server grew a dependency.

### Operation

8. As an operator, I want to open one URL in a browser and see current state, so that I can check status without a terminal.
9. As an operator, I want the page to refresh itself on an interval, so that I can leave a browser tab open and watch state change.
10. As an operator, I want the Dashboard to be strictly read-only, so that running it — or a bug in it — can never place, cancel, or modify a trade.
11. As an operator, I want the server to stay off my network by default, so that a stray port isn't exposed unless I explicitly ask for it.
21. As an operator, I want the page to work with no internet connection, so that a dead link to a font CDN can never blank the screen I use to watch live money. **Zero external requests** — fonts are bundled, nothing is fetched from any host but the page's own origin.

## Layout — one mission-control screen

**No tabs.** v1's two-tab split is gone; everything is one vertically-scrolling screen, ordered by how urgently an operator needs it.

### 1. Telemetry strip (top)

A single horizontal strip: run **mode**, the live-tick readout (instrument + stage, or "idle"), the **LLM burn meter** against the $50 ADR-0008 cap, the **Alpaca balance**, **Polygon reachability**, and the snapshot clock.

- **Status is a coloured word, never a dot.** No pulsing status indicators anywhere on the page (David's call, [map #533](https://github.com/dd-jp/samurai-trading-system/issues/533) decision 7). `ok` / `degraded` / `error` / `not_configured` are rendered as those words, coloured; the colour is redundant with the word, never the only carrier of the meaning.
- **Staleness is a label plus a border, not a disappearance.** Two consecutive missed polls put the whole strip into a stale state: an amber "stale — last update HH:MM:SSZ" label and an amber border. Numbers keep their last values and are *marked* stale rather than blanked, because a blank field reads as zero.
- **The Alpaca balance is `null` unless `state === 'ok'`** and renders as "unavailable" with the probe's `detail` — a stale balance shown next to a failed probe reads as current, which is worse than showing nothing.

### 2. Rooms hero

The 4×2 grid of rooms 01–07 + Lobby described under "Pipeline theater". Per room: number, stage name, a kanji watermark, and its occupants.

- **Room 04 (`invalidation`) is drawn lights-off** while the stage is unbuilt, and says so.
- **The Lobby is dashed**, holding idle lanes — instruments with no trace inside the window.
- **The live-occupied room carries a cyan edge glow.** One room at most; `pipeline.live_trace_id` decides it.
- **Sigil chip** per instrument: callsign (the instrument's short form), an asset-class glyph distinguishing crypto from stocks, and an **outcome ring** whose colour follows the lane outcome. The chip is a focusable control; selecting it opens that instrument's drawer.
- **Multi-occupancy** is the normal case and the whole point — chips stack within a room. **More than 3 chips in one room collapse to the first 3 plus a "+N" affordance**, so a pile-up is visible without the room overflowing its cell.
- **Colour is never the sole signal.** Every outcome that a ring colour encodes is also present as a word in the chip's accessible name and in the drawer.

### 3. Verdict ledger + detail drawer

A running ledger of settled decisions, each stamped with a **hanko seal**: 可 (go), 否 (no_go), 止 (stopped), 略 (quorum_skip).

- **Fed from settled pipeline lanes, not from `verdicts[]` alone.** A lane that ended at `stopped` or `quorum_skip` never reaches `verdict_log` and would be invisible in a verdict-table-only ledger — those are exactly the decisions an operator most wants to see accumulate. `verdicts[]` supplies the gate/reason wording and the `hitl_override` flag for the lanes that did reach Verdict.
- **Deduped by `trace_id`** against every entry ever seen this session, so a re-poll of an unchanged lane never re-stamps it.
- **Newest first, capped at 30 entries.** On first paint the ledger is seeded from the currently-settled lanes, stamped with their last non-null `recorded_at` rather than with the wall clock — a seeded entry must not claim to have just happened.
- **HITL badge** on any row with `hitl_override === true` (see story 5's note: expected never to fire).
- **A row click opens that trace's drawer**, the same drawer a chip opens.
- **The drawer** carries: the stage strip (all seven stages with state word, duration, decision, attempt count), the debate's per-analyst stances × influence, the reserved invalidation section (stories 4a–4c — a named empty state until the stage ships), and the trace id. Every empty state **names its reason** — "Trader and Risk persist no decision content (#328)", "round-by-round state is not persisted (decision #10)", "no trace in the last 15 minutes" — never a bare dash and never a spinner that cannot resolve.

### 4. Bento panels (bottom)

A grid of equal-citizen panels, none of which is a hero:

- **Positions** — one row per open position with the stop / entry / mark / target **price rail**, plus side, filled size and unrealized PnL. PnL sign is carried by an explicit `+`/`−` as well as by colour.
- **Metrics suite** — the full `MetricsSuite` as stat tiles, **reported together**. No single headline number; the research constraints exist because one metric in isolation misleads.
- **Analysts** — weight bar with the **numeric percentage** beside it, and signed rolling-R with its window in days.
- **LLM spend** — the three rolling windows, per-debate cost p50/p95 and LLM latency p50/p95, and **both** honest caveats (see below) whenever their counts are non-zero.
- **Recent debates** — direction, rounds, and per-analyst stance strips with a legend.

## Motion — replay only

**A persona walks only where the store recorded it walking.** This reverses v1's "no transit animation" rule; the reversal and its reasoning are recorded in [ADR-0011](../adr/0011-pipeline-theater-replay-motion.md). The rule, in full:

1. **Only recorded transitions animate.** A chip may walk from room A to room B only along stage transitions present in `audit_log` (via `pipeline.lanes[].cells[].recorded_at`) or `current_tick`. The client is replaying timestamped rows, not interpolating between two observations.
2. **Hop durations are proportional to the recorded gaps**, so a stage that genuinely took longer takes longer to walk — **clamped to 150–450 ms per hop**, and **≤1.2 s total per poll** across all hops. The clamp and the budget mean the replay is a time-compressed retelling, never a literal one, and it always finishes before the next 3-second poll.
3. **First paint places without walking.** There is no previous snapshot, so there is no recorded transition to replay; chips appear where they are.
4. **A hidden tab snaps on return.** `document.hidden` during a poll means the transitions were never observed by this client; on return the chips snap to the current state. No marathon replay of everything that happened while the tab was in the background.
5. **`prefers-reduced-motion` snaps, with a settle ring.** The change is still signalled — a ring on what moved — but no chip crosses the screen. Bob, shimmer, power-on and stamp-scale animations are all suppressed.
6. **Skipped stages are never walked through.** A cell with a `null` `recorded_at` was not visited; a walk from `trader` to `risk` past a skipped `invalidation` hops *over* room 04, it does not enter it.
7. **A rotated trace walks to Analysts first, then forward.** When a lane's `trace_id` changes, the old trace ended and a new one began at Analysts; the chip returns to room 01 and then replays the new trace's recorded stages. It never cuts diagonally from where the last trace died to where the new one is.
8. **Aging to idle snaps to the Lobby, as a non-event.** A trace falling out of the 15-minute window is the clock passing, not something the system did. The chip is placed in the Lobby without a walk and without a settle ring.
9. **A new poll mid-walk wins.** Outstanding hops are cancelled and the chip snaps to the observed state. The data is the authority; the animation is a retelling that yields to it.
10. **No `requestAnimationFrame` for critical rendering.** CSS keyframes and transitions only — driven by class and transform changes, chained on `transitionend` with a `setTimeout` fallback. (Prototyping finding: rAF never fired in the sandboxed artifact frame, and a page whose chips only appear if a frame callback runs is a page that can render empty.)

Everything that is *not* a recorded transition still follows v1's rule: a ring on whatever changed between two polls. Appearance and disappearance of a lane fade rather than travel. A tick shorter than the poll interval legitimately appears as a completed replay.

## Design system

Tokens are defined once as CSS custom properties and consumed everywhere; nothing hard-codes a hex.

**Colour**

| Token | Value | Meaning |
| --- | --- | --- |
| `--bg` | `#05070D` | Page ground (near-void indigo) |
| `--panel` | `rgba(255,255,255,.04)` + backdrop blur + 1px `#1E2A44` border | Glass panel |
| `--cyan` | `#38E1FF` | Live / in-flight accent |
| `--go` | `#3DDC7D` | `go`, profit |
| `--amber` | `#FFB454` | `no_go`, `quorum_skip`, warning, staleness |
| `--vermilion` | `#FF4D5E` | `stopped`, loss, error |
| `--text` | `#E8EDF7` | Body text |
| `--muted` | `#8A93A8` | Secondary text, labels |
| `--gold` | `#C9A25A` | Chrome only — the seal ring and the panel corner-bracket frame. Never a state signal; the six rows above own that job |

The palette was checked for common colour-vision deficiencies when it was chosen. That check is a floor, not a licence: **colour is never the sole carrier of a signal** anywhere on this page — every state that has a colour also has a word.

**Type** — Chakra Petch (display: room names, headings, callsigns), IBM Plex Sans (body), IBM Plex Mono (all numerics, so columns of figures align). **Self-hosted via `@fontsource`** and bundled into the build. Zero external requests is a hard requirement (story 21), not a preference.

**Spacing** — an 8px baseline scale (`--space-1`…`--space-8`, 4–48px), applied at the outer layout level (page shell, telemetry strip, panel padding, section gaps). Component-internal spacing with its own documented reason (e.g. the position rail's 13px label-row stride) stays off the scale.

**Signature element** — the hanko seal stamp on ledger entries, now ringed in `--gold`. The same corner-bracket language framing every panel (previously shown only on a selected pipeline room) extends that ceremony page-wide: a consistent HUD reticle-corner frame is the chrome every container shares.

## Wire Shape

The snapshot is **unchanged apart from two additive fields**. No shape is renamed, no field is removed, and the server computes nothing new.

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
  getAnalystWeights(asOf: Date): Record<string, number>;       // Feedback Loop
  getAttribution(asOf: Date): Record<string, AttributionSummary>;    // Feedback Loop
  getDailyMetrics(asOf: Date): MetricsSuite;                   // Feedback Loop (cost-model-owned computation)
  getMark(instrument: string, asOf: Date): Mark;               // Market Data Service, for unrealized PnL
  getLlmSpend(asOf: Date): LlmSpendSummary;                    // llm_spend (migration 0010)
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
- Render the mission-control screen from `DashboardSnapshot`, and nothing else. It holds no domain logic: every number it shows is computed server-side.

**Structure**
- **Vite + React**, output to `dist/client/` with a relative `base` so the bundle is servable from disk without a path prefix.
- `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, the `@fontsource` packages and the test tooling are **devDependencies**. `dependencies` remains exactly `better-sqlite3`. The build becomes `tsc && vite build`; `client/` falls outside `tsconfig.build.json`'s `include` (`server/` + `contracts/`) and owns its own tsconfig. It needs no `exclude` entry — being a sibling of `server/` rather than a directory inside it is what removed the need.
- **`client/src/lib/` is pure and React-free** — this is where the client's real logic lives and where it is tested:
  - `room-layout.ts` — which room a lane occupies (a `live` cell wins outright; otherwise the furthest `done`/`stopped` stage; otherwise the Lobby), stable slot assignment within a room across polls, and the `>3 → +N` collapse.
  - `walk-plan.ts` — `computeWalkPlan(prev, next, opts)` implementing the Motion rules as a pure function of two snapshots. Every rule in the Motion section is a test case here.
  - `ledger.ts` — settle detection, `trace_id` dedupe, ordering, the 30-entry cap, and first-paint seeding.
  - `format.ts` — durations, `HH:MM:SSZ` clocks, signed money and R.
- **`hooks/useWalkAnimation.ts` is the only DOM-imperative code** in the app, applying a `WalkPlan` to chip elements via transform transitions. Confining imperative work to one hook is what keeps the rest of the tree ordinary declarative React.
- **`hooks/useSnapshot.ts`** owns the 3s poll (`cache: 'no-store'`), the two-missed-polls staleness watchdog, and retention of the previous snapshot for the walk plan.

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
- `host` defaults to `127.0.0.1`; set via `HOST` env var to opt into LAN reachability. `port` defaults to `8787`, via `PORT` env var.

## Accessibility floor

Non-negotiable, and unchanged in spirit from v1 — the screen got more visual, so these get more important, not less.

- **Outcome words in accessible names.** Every sigil chip's `aria-label` names its instrument and its outcome **in words** (`"BTC-USD, stopped at risk"`), so the outcome ring's colour is decoration rather than data.
- **Colour is never the only signal** — states carry words, PnL carries an explicit sign, the live room carries a label as well as a glow.
- **Keyboard-operable.** Chips, ledger rows and the drawer are reachable and operable by keyboard, with a visible `:focus-visible` style. **Focus must survive repaints and walks** — a 3-second poll that steals focus makes the page unusable with a keyboard.
- **Empty states name their reason.** Never a bare dash, never a spinner that cannot resolve. "Trader and Risk persist no decision content (#328)" is a legitimate empty state; a blank cell is not.
- **`prefers-reduced-motion` is honoured everywhere**, per Motion rule 5.
- **No pulsing.** Beyond the design preference, a page whose status indicators pulse indefinitely is a page that is harder to read for anyone sensitive to motion.
- **The rooms grid scrolls inside its own container** on narrow viewports; the page body never scrolls sideways.

## Testing Decisions

- **Server seam: `buildSnapshot`.** Good tests assert on the *returned snapshot given fixed `DashboardQueryStore` data* (e.g., a fake store returning two open positions produces two `PositionRow`s with correct PnL), not on HTTP internals or real database state.
- **Client seam: `client/src/lib/`.** The walk plan, room layout and ledger are pure functions of two snapshots and are tested without a DOM: first-paint snap, single hop, multi-hop skipping an unrecorded stage, trace rotation via Analysts, appear/depart, duration clamps and the 1.2 s budget, ledger dedupe/cap/ordering/seeding, room precedence (live wins → furthest → Lobby), stable slots across polls, `+N` collapse.
- **Component tests (RTL)** cover what a screenshot cannot: chip `aria-label` wording, ledger dedupe as rendered, the HITL badge, drawer empty-state wording, the stale banner, and a hostile instrument string rendering inert.
- **Server tests** assert on HTTP status/body for each route (`GET /`, a bundle asset, `GET /api/snapshot`, unknown path, non-`GET` method) and on the **static containment guard** against an injected fake store — no real network dependency beyond binding to an ephemeral port (`port: 0`). Two escapes must both be covered: `..`/percent-encoded-`..` traversal, **and** a sibling directory whose name shares the bundle root's prefix (`dist/client-evil/`). The second is the one a naive `startsWith` passes the first test while remaining open to, so a suite that only tests `..` proves nothing about it.
- **`QueryStore` implementation** is tested against a real (test) SQLite instance seeded with rows matching the other components' own fixture patterns — reuses their existing test data shapes, no new schema.
- **Offline check is part of acceptance:** the built bundle contains no external URL. A grep for `https://` over `dist/client/` is the crude version; the network panel showing zero third-party requests is the real one.
- No end-to-end trading test needed — this component cannot affect trading outcomes by construction (read-only).

## Out of Scope

- **Any write path** — no manual trade actions, kill-switch trigger, or config editing. Strictly read-only (decision, not an oversight).
- **A terminal CLI** — superseded by this dashboard; `src/cli/` was removed when v1 landed. <!-- cite-exempt: historical — a statement about a removed tree; the sentence is true precisely because the path does not resolve -->
- **Real-time push/streaming** — client-side polling only. Re-affirmed for v2: the replay animation is driven by recorded timestamps, so it needs no new transport.
- **A true in-flight/live debate-round view** — the Debate Engine's ephemeral operational round state isn't persisted (decision #10); only completed debates plus a coarse tick-status line are observable.
- **Remote/public access, auth, HTTPS** — LAN-only opt-in via `HOST`, matching the single-MacBook deployment target. A hosted multi-user product is a different problem, not designed here.
- **Alerting** — the dead-man's-switch heartbeat and trade notifications are the Orchestrator's/Verdict's concern (already specced); the Dashboard is a pull, not a push, mechanism.
- **Trader/Risk drill-down in the drawer** — those two stages persist no decision content anywhere (no `trader_log`, no `risk_log`; `audit_log` holds only a digest), so their cells report that a stage ran and nothing about what it decided. What gets persisted is owned by [#328](https://github.com/dd-jp/samurai-trading-system/issues/328); where it surfaces is reserved in [#417](https://github.com/dd-jp/samurai-trading-system/issues/417). The drawer shows an honest empty slot rather than inventing content.
- **Queryable pipeline history.** The verdict ledger is a **bounded settle-log** — the last 30 decisions observed while the page has been open — not a searchable archive. A chip holds one trace, the most recent inside the 15-minute window. The chronological record of what the pipeline decided remains `verdict_log`, surfaced through `verdicts[]`; a second query path to the same facts is maintenance cost, not a feature.
- **Any change to what the backend computes.** v2 is a UI rewrite. The only wire changes are the two additive fields in "Wire Shape".

## Further Notes

**Current wayfinder map: [Wayfinder: dashboard v2 — mission-control rewrite (Vite+React) + rooms pipeline theater](https://github.com/dd-jp/samurai-trading-system/issues/533)** (2026-08-07), which locked the decisions this v2 synthesizes and supersedes the pipeline-tab portions of [Wayfinder: dashboard pipeline view](https://github.com/dd-jp/samurai-trading-system/issues/411)/[#412](https://github.com/dd-jp/samurai-trading-system/issues/412). The original dashboard decisions are in [docs/wayfinder/dashboard-map.md](../wayfinder/dashboard-map.md), kept as the historical record from before maps moved to GitHub issues — its "not a framework SPA" line is superseded by ADR-0010 and is not a live constraint.

Two architectural reversals ride with this rewrite and are recorded as ADRs rather than buried here:
- [ADR-0010 — Dashboard v2: a built Vite+React client](../adr/0010-dashboard-vite-react-rewrite.md)
- [ADR-0011 — Pipeline theater: motion as replay, not interpolation](../adr/0011-pipeline-theater-replay-motion.md)

This closes OPEN-GAP-B (docs/specs/cross-spec-contracts.md) — the Dashboard is the 12th and final charted/specced component. It has zero write-path risk by construction, so it can be implemented and iterated on independently of the trading-critical components without affecting their correctness.

**Supersedes the CLI spec (2026-07-14).** OPEN-GAP-B originally resolved to a terminal CLI, explicitly declining a web dashboard. That decision was reversed on 2026-07-21 after `src/dashboard/` (now `server/apps/service-api/`) was built ahead of any map or spec (discovered during a project health check) and grilled to a decision: the dashboard replaces the CLI rather than complementing it, since it subsumes every read the CLI provided with better ergonomics. `src/cli/` (render functions + types, tested, but with a placeholder entry point never wired to a runnable command) was removed in that change. This file was `cli-spec.md`, renamed and rewritten in place, then rewritten again here for v2. <!-- cite-exempt: historical — both cited paths on this line describe trees removed in the 2026-07-21 reversal -->

**WorldMonitor Deferred-Shell Contract (#177 resolution), now discharged.** The pattern — reserve a live-updating region's slot before its async data arrives, rather than reflowing the layout when it does — is exactly what the rooms grid, the telemetry strip and the bento panels do: the grid is drawn at full size from first paint, empty rooms and unavailable tiles included, and data fills reserved space. A poll must never change the page's geometry.
