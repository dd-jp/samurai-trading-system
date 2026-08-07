# Orchestrator + Dashboard Architecture Review — 2026-08-07

**Question:** Is the current code architecture good enough for the orchestrator and the dashboard to live in? Should it change, and to what?

## TL;DR — Verdict: (b) good bones, needs targeted refactors. No re-architecture.

The shipped topology — one orchestrator process and one read-only dashboard process sharing a single WAL-mode SQLite file, optionally co-supervised by `yarn serve` — is sound, matches every governing spec/ADR, and already supports the dashboard v2 rewrite: ADR-0010 explicitly confines v2 to presentation ("The backend does not move", ADR-0010 §Decision pt 2), and the one hard data precondition, `PipelineCell.recorded_at` (#535/#543), is verified wired (`src/dashboard/pipeline-query.ts:288`). The module boundary between the two consumers is real: the dashboard touches orchestrator state only through `DashboardQueryStore` (plain `SELECT`s, `src/dashboard/sqlite-query-store.ts:7-10`), never through orchestrator internals. What needs fixing is a short list of shared-store hygiene items (dashboard opens the DB write-capable; the migration runner has a measured check-then-act race; the busy timeout is only a library default, never pinned) and one honesty defect (the dashboard serves zeroed metrics that the orchestrator now computes for real). None of them changes the architecture.

## Current state (as built, not as docs claim)

**Process model.** Two entrypoints plus a supervisor:

- `yarn orchestrator` → `dist/orchestrator/index.js` — the money path (`package.json:21`). Entrypoint guard + `startFromEnvironment` (`src/orchestrator/index.ts:613-641`, `:466-558`) fails fast on missing credentials/config, opens the store, and calls `buildProductionOrchestrator`.
- `yarn dashboard` → `dist/dashboard/index.js` (`package.json:23`) — a separate read-only HTTP process (`src/dashboard/index.ts`), GET-only by construction (`src/dashboard/server.ts:59-87`: `/`, `/api/snapshot`, 405 on non-GET).
- `yarn serve` → supervises both as children of one foreground process, migrating the store once before spawning either, forwarding signals, and taking both down if either dies (`src/serve/index.ts:1-12`, `src/serve/supervisor.ts:34-44`, `:150-255`).

This matches orchestrator-spec.md exactly: "a **single TypeScript process** … one scheduler and one tick loop" (orchestrator-spec.md:15), "Single process, single host — matches the MacBook always-on deployment target; no message broker" (:24), with `current_tick` existing "solely so a separate process … can observe 'tick in progress'" (:149, story 13b at :57).

**Composition root.** `buildProductionOrchestrator` (`src/orchestrator/production.ts:956` per ADR-0004) binds all six built stages into one `SequentialTickRunner`, constructs every SQLite-backed store, and its `start()` actually wires the lifecycle mechanisms: heartbeat `setInterval` (`production.ts:1255-1257`), fill sync (`:1259-1264`), the self-scheduling tick loop with in-flight guard (`:1266-1274`, `:863-947`), the feedback daily cycle with loud `warn`s for every unwired degradation (`:1276-1411`), and a drain-then-exit `stop()` (`:1416-1441`). Checked specifically against the repo's known "tested mechanisms nothing calls" defect pattern: the composition root now has callers for fill ingestion, `onTradeClose`, `computeMetrics`, and weight seeding, with the file header documenting each closure (`production.ts:56-111`). The pattern is contained here.

**Scheduling/cadence.** `UniverseScheduler` gates stocks on a trading calendar, crypto always fires (`src/orchestrator/scheduler.ts:38-55`). Interval: `DEFAULT_TICK_INTERVAL_MS = 60_000` (`src/orchestrator/production/defaults.ts:30`), overridden by the paper profile to `15 * 60_000` (`src/orchestrator/paper-profile.ts:1319`) per ADR-0008 §"Cadence: 15 minutes for the paper soak". Concurrency is bounded per tick, per-instrument crashes are contained and audit-logged as `decision: 'crashed'` (`src/orchestrator/tick-loop.ts:122-215`).

**Persistence.** One better-sqlite3 file per trading mode, `data/samurai-{mode}.sqlite`, WAL + `synchronous=FULL` + FK on, migrations run at open (`src/shared/store/open-shared-store.ts:102-106`, `:192-201`), both entrypoints resolving the path through the same `resolveStoreMode` (`:68-81`; `src/dashboard/index.ts:33`) — the crash-restart invariant per shared-sqlite-store-spec.md:23/:52.

**Dashboard data needs (v2 spec).** Everything v2 needs is on the existing snapshot except one additive field: `recorded_at` is live on the wire (`pipeline-query.ts:288`, `pipeline-types.ts:88`), while `mode` is specced (dashboard-spec.md "Wire Shape", ticket #539) and **not yet in the code** — `mode` appears nowhere in `src/dashboard/snapshot.ts` or `src/dashboard/types.ts` (grep, 2026-08-07). The spec's "mode unknown" client fallback covers the gap. There is no `src/dashboard-web/` yet; v2 is spec-only. ADR-0011 explicitly rejected SSE/WebSocket ("a new liveness transport is a new failure mode … bought to solve a problem that timestamps already in the database solve for free", ADR-0011 §Alternatives), so the 3s poll over `/api/snapshot` remains the event seam, with `audit_log` as the append-only spine the dashboard tails ("Append-only. Powers the dashboard read-only", shared-sqlite-store-spec.md:400).

## Findings, ranked

### F1 (HIGH) — The dashboard serves fabricated-zero metrics that the system now computes for real

`SqliteQueryStore.getDailyMetrics` returns `ZERO_METRICS` for 8 of 10 `MetricsSuite` fields — `sharpe`, `sortino`, `calmar`, `max_drawdown`, `skew`, `kurtosis`, `turnover`, `exposure` all hardcoded `0` (`src/dashboard/sqlite-query-store.ts:189-201`, `:311-323`). The file header's justification — "there is no equity-curve or account-capital history anywhere in shared-sqlite-store-spec.md's sixteen tables … a follow-on ticket adding an equity-curve table is the honest fix" (`:17-28`) — is **stale**: `daily_equity` exists (migration `0011_daily_equity.sql`, ADR-0006), is sampled every tick by the orchestrator, and `SqliteDailyEquityMetricsSource` already derives a real `MetricsSuite` from it for the feedback loop's kill-line detector (`src/orchestrator/production.ts:80-89`). So the operator surface shows Sharpe 0 / max drawdown 0 while the same process computes true values nightly — on the exact panel dashboard-spec.md story 7 mandates as "the full metrics picture the research constraints require". This is the "spec banners hide stale bodies" failure mode applied to a code comment.

**Fix (small, contained):** have `SqliteQueryStore.getDailyMetrics` read `daily_equity` — ideally by reusing the same computation `SqliteDailyEquityMetricsSource` uses, honoring its minimum-observation gate and rendering "insufficient observations (N/60)" rather than zeros below it. This is a query-store change only; it does not violate ADR-0010's "backend does not move" (that constraint freezes the wire *shape*, and `metrics` is already on it). No prior review filed this (grep over `docs/reviews/`, 2026-08-07).

### F2 (HIGH) — Dashboard opens the store write-capable, and the migration runner has a measured two-process race

Two related facts:

1. The dashboard's entrypoint calls `openSharedStore(sharedStorePath())` (`src/dashboard/index.ts:33`), which is a **read-write** open that **runs migrations** (`open-shared-store.ts:192-199`). The "read-only" guarantee is convention in `SqliteQueryStore` ("never writes", `sqlite-query-store.ts:7-10`), not construction — the process holds a handle that can write and *does* write schema on a version skew. A dashboard binary newer than a running orchestrator would migrate the schema under it.
2. `runMigrations` reads `schema_migrations` outside any transaction and applies each file in its own transaction (`src/shared/store/migrate.ts:42-60`) — a check-then-act race. The `serve` supervisor documents the measurement: at exactly the two-process width, **48 of 50 trials failed** on a fresh DB, and it works around it by migrating once before spawning either child (`src/serve/supervisor.ts:58-85`). The supervisor's own comment concedes "Fixing the check-then-act in `migrate.ts` is the deeper fix and belongs to the shared store" (`supervisor.ts:78-80`). An operator hand-starting `yarn orchestrator` and `yarn dashboard` near-simultaneously on a fresh or just-upgraded DB remains exposed — nothing but the supervisor closes it.

**Fix, two parts:** (a) open the dashboard's handle with better-sqlite3's `{ readonly: true, fileMustExist: true }` and skip migrations there (refusing to start on a missing/behind-schema file is the correct posture for a reader — same refuse-don't-guess line `resolveStoreMode` already takes, `open-shared-store.ts:72-79`); (b) make `runMigrations` take the schema decision atomically (e.g. `BEGIN IMMEDIATE` around the read-and-apply, or re-check inside each migration's transaction). Part (a) also makes the read-only claim structural, matching the server's own "no write path by construction" standard (`server.ts:11-15`).

### F3 (LOW, downgraded from MEDIUM on verification) — `busy_timeout` protection is real but implicit

`grep -rn busy_timeout src/` returns nothing; `openSharedStore` sets WAL/`synchronous`/`foreign_keys` only (`open-shared-store.ts:195-198`). Verified against the pinned v13.0.1: the constructor's `timeout` option defaults to 5000 ms (`node_modules/better-sqlite3/lib/database.js:33`), so every connection ALREADY waits up to 5 s on contention before surfacing `SQLITE_BUSY` — the substantive protection this finding originally asked for exists, and adding `db.pragma('busy_timeout = 5000')` would be a no-op. What remains is hygiene, not a gap: the money path's contention behavior rests on an undocumented-in-repo library default that has shifted meaning across better-sqlite3 major versions, and nothing in `openSharedStore` states the chosen value or that one was chosen at all. Pin it explicitly (constructor `timeout` or the pragma, with a comment picking the value deliberately — a longer wait than 5 s is defensible for the orchestrator's writer during checkpoint recovery) so an upgrade or a reader of `open-shared-store.ts` can't silently lose or misread it. Becomes near-moot for the reader once F2(a) lands (a WAL reader never blocks on a writer).

### F4 (MEDIUM, prior finding — referenced, not re-filed) — Runner and dashboard disagree on the stage count

Runtime `TickStage` is six stages (`src/orchestrator/types.ts:77`); the dashboard renders seven including the specced-unbuilt `invalidation` (`src/dashboard/pipeline-types.ts:34-42`). Filed as finding 5 / D5 in [codebase-review-2026-08-06.md](codebase-review-2026-08-06.md); D5 records it as David's deliberate placeholder. It is *not* an architecture blocker — `audit_log.stage` is unconstrained TEXT, so the room fills in when the stage ships with no read-path change (`pipeline-types.ts:27-33`) — but the v2 "rooms" hero makes the placeholder permanently visible (room 04 "lights-off", dashboard-spec.md §"Seven stages, not six"), so the pressure to build #291's stage rises with v2.

### F5 (LOW) — `mode` wire field not yet implemented

Required by dashboard-spec.md "Wire Shape" (owned by #539); absent from `snapshot.ts`/`types.ts` today. Tracked work, not a defect — noted so the v2 client is built with the spec's "mode unknown" fallback from day one, and so nobody assumes #543's landing means both additive fields landed. Only `recorded_at` did.

### F6 (LOW, accepted by design — recorded for visibility) — Under `yarn serve`, a dashboard crash halts trading

The supervisor deliberately takes both children down when either dies, with a non-zero exit (`supervisor.ts:34-38`, `:204-227`). Its own header states the mitigation: "`yarn orchestrator` remains the money-path entrypoint" (`supervisor.ts:38`) — an unattended soak should run the orchestrator alone (or under `yarn serve || alert`, which the exit-code floor at `supervisor.ts:216-221` exists for). The design is accepted, but a header comment is weak mitigation for a live-money path: recommend one startup `warn` when the supervisor links the two lifecycles, so an unattended `yarn serve` run states the coupling in its own log rather than relying on the operator having read `supervisor.ts` (see table row 6).

## Fitness assessment — why (b) and not (c)

- **Module boundaries hold.** The dashboard's only contract with the rest of the system is (1) the `DashboardQueryStore` port over tables other components own (`sqlite-query-store.ts:7-10`; dashboard-spec.md §"Module: Query Store") and (2) two deliberately-persisted orchestrator artifacts built *for* an external reader: `audit_log` (append-only, with instrument attribution since migration 0013 — dashboard-spec.md §"Attribution") and `current_tick` (orchestrator-spec.md:149). No import from `src/dashboard/` into orchestrator internals exists beyond the exported types barrel (`sqlite-query-store.ts:35`). The schema *is* shareable by a second consumer today — that is F1's silver lining: the data the dashboard fails to show is already in the file it already reads.
- **The event seam is adequate and was re-litigated 24h ago.** ADR-0011 rejected SSE/WebSocket with the argument that recorded timestamps in `audit_log` make a push transport unnecessary for v2's replay animation; dashboard-spec.md:25 re-affirms 3s polling. A single-operator loopback page polling a WAL reader at 3s is well inside SQLite's envelope; nothing observed contradicts the decision.
- **Crash-restart is designed in, at every layer:** WAL+FULL (shared-sqlite-store-spec.md:52), orphan-verdict scan at startup before the loop writes (`production.ts:950-955`), `current_tick` deliberately left stale on crash so the dashboard's 15-min window can show a dead tick as dead (dashboard-spec.md §"Bounded by a window"), drain-on-signal with second-signal guard (`src/orchestrator/index.ts:583-608`), and mode-keyed store paths that refuse rather than guess (`index.ts:424-440`, `open-shared-store.ts:142-168`).
- **ADR fit:** ADR-0001's dependency-light TS core is intact (`dependencies` = exactly `better-sqlite3`, `package.json:36-38`; ADR-0010 pt 1 keeps it so through v2). ADR-0007 needs nothing from the dashboard but the `hitl_override` badge that never fires (dashboard-spec.md story 5 note). ADR-0008's budget instrument (burn meter over `llm_spend`) reads a table the debate engine already writes. The MacBook single-host constraint is what makes shared-file SQLite the *right* call and an orchestrator-hosted HTTP API the wrong one: serving the dashboard from the trading process would put a page render on the money path's event loop and violate the blast-radius argument the spec leads with (dashboard-spec.md:17).

**What would justify (c), and doesn't exist:** a second host, a second operator, a write path from the UI, or a push-latency requirement. All four are explicitly out of scope (dashboard-spec.md §Out of Scope; orchestrator-spec.md:249).

## Recommended work, ranked by risk-adjusted priority

| # | Change | Effort | Risk if skipped |
|---|--------|--------|-----------------|
| 1 | F2(a): dashboard opens store `{readonly: true, fileMustExist: true}`, no migrations | S | Schema written by a reader; version-skew migration under a live orchestrator |
| 2 | F1: `getDailyMetrics` reads `daily_equity` (reuse `SqliteDailyEquityMetricsSource` computation + its observation gate) | M | Operator watches zeros labelled as the metrics suite through the entire soak |
| 3 | F2(b): make `runMigrations` atomic (`BEGIN IMMEDIATE` around check+apply) | S | 96% failure rate on any future two-process fresh-DB start outside `yarn serve` |
| 4 | F3: pin the busy timeout explicitly in `openSharedStore` (value chosen deliberately, with a comment) | XS | Protection is a library default; a better-sqlite3 upgrade or refactor can silently drop it |
| 5 | F5: land `mode` on the snapshot with #539 (already ticketed) | XS | v2 telemetry strip permanently says "mode unknown" |
| 6 | F6: one startup `warn` in the supervisor when it links the orchestrator's lifecycle to the dashboard's | XS | Unattended `yarn serve` runs inherit dashboard-crash-halts-trading coupling silently |

Items 1–4 are all confined to `src/shared/store/` and `src/dashboard/index.ts`, item 6 to `src/serve/supervisor.ts`; none touches a pipeline stage, the tick loop, or the wire shape, and none blocks starting the v2 client work (`src/dashboard-web/`) in parallel.

## Claims not verified

- The supervisor's measured figures (48/50 migration-race failures; 25/25 clean SIGINT trials) are taken from its doc comments (`supervisor.ts:69-73`, `:135-137`), not re-measured.
- GitHub issue states (#533, #535, #539, #543 mappings) are taken from ADR/spec cross-references and commit `e5618f0`'s title, not from the GitHub API.
