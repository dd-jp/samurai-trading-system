# v1 teardown reachability (#1748, Step 5 phase 1)

Status: **report for David's review. Nothing is deleted or moved by this doc or its PR.** Session F (doc 68) stops here: the waves below run only after David has ruled on the questions in §11.

Base: `origin/main` at d692553d (2026-10-02). Rulings applied: doc 66 Q11, G8, G14, G17, G18 and the 2026-10-01 ruling 8 (#1946: concrete broker adapters stay in v1 until Step 5), plus the #1946 scope note on #1748 (option C: the broker code v2 still imports moves to a v2-visible place, its interfaces to `contracts/`).

File paths that a later wave deletes or moves are written without backticks in this doc, so the citation checker (`npm run check:citations`) keeps passing after each wave.

## 1. Summary

A file is on the deletion list only if **both** methods find it unreachable from every v2 root (§2, §3). Out of 604 production TypeScript files, fallow finds 322 unreachable and graphify 326; the 4 extra files are the disagreements in §9, and they stay. Of the 322 that both methods agree on, 21 are not deleted:

- 7 are excluded as tooling or test support: two Vitest setup files and the Vite config, which are config rather than modules, and four test helpers that kept tests import (§3.4).
- 14 are held for a ruling: the G18 X/social code (5 files, §6), the v1 CGT matcher (4 files, #1947) and the v1 Saxo bracket adapter with its alert types (5 files, which go with the saxo-http-client.ts decision in §7).

That leaves **301 production files and 278 test files (579 files, 165,206 lines)** on the list, in five waves:

| Wave | Area | Prod files | Prod lines | Test files | Test lines |
|---|---|---:|---:|---:|---:|
| 1 | v1 CLIs and the v1 backtest harness in server/tools | 53 | 10,190 | 41 | 11,842 |
| 2 | v1 apps: orchestrator, service-api, supervisor | 83 | 21,413 | 99 | 45,792 |
| 3 | v1 pipeline: analysts, control-arm, feedback-loop, outside-benchmark, risk-manager, trader, verdict, dead parts of debate-engine, execution and momentum | 106 | 14,777 | 93 | 42,825 |
| 4 | v1 providers: dead market-data-service, G17 market intelligence (GDELT, Polymarket, WorldMonitor, MI ingest, scorer), universe-pool | 39 | 6,851 | 33 | 8,799 |
| 5 | Dead `server/shared` helpers and the v1 wire contracts | 20 | 1,477 | 12 | 1,240 |
| **Total** | | **301** | **54,708** | **278** | **110,498** |

A sixth wave deletes nothing. v2 still reaches 114 production files outside `server/apps/v2/`, `client/`, `contracts/` and `e2e/`: 26 under server/pipeline/execution, 44 in other v1-named directories, 37 in `server/shared` and 7 repo tools. The sixth wave moves the first two groups, starting with the #1946 broker code (§5). These are the surviving v1-named modules that Step 5 also renames.

## 2. Roots

The v2 roots are every entry point that runs v2, builds or tests it, or keeps it alive on the Mac:

- **v2 npm scripts** (`package.json`): `v2:run`, `v2:capital`, `v2:entry-offsets`, `v2:cost-fidelity`, `v2:replay`, `v2:backup`, `v2:restore`, `v2:dashboard`, `v2:telegram`, `v2:signals`, `v2:trials`, `v2:backtest`, `v2:sim-cfd-stop-drill` and `v2:cfd-catalogue`. Their files are `server/apps/v2/{index,set-capital,report-entry-offsets,report-cost-fidelity,replay-cli,backup-cli,trial-ledger,backtest-cli,cfd-catalogue-cli}.ts`, `server/apps/v2/api/main.ts`, `server/apps/v2/api/telegram-main.ts`, `server/apps/v2/signals/main.ts` and `server/apps/v2/execution/sim-cfd-stop-drill-cli.ts`.
- **v2 smoke and e2e**: `server/apps/v2/smoke.ts` (the v2 half of `npm run smoke`), `server/apps/v2/api/fixture-server.ts`, `e2e/playwright.config.ts` and `e2e/support/*.ts`. Every e2e spec runs against the v2 fixture server.
- **launchd plists** (`ops/launchd/`): `com.samurai.v2-paper` (`server/apps/v2/index.ts`), `com.samurai.v2-signals` (`server/apps/v2/signals/main.ts`), `com.samurai.v2-telegram` (`server/apps/v2/api/telegram-main.ts`) and `com.samurai.saxo-keepalive` (`server/tools/saxo-keepalive.ts`).
- **Saxo token bootstrap**: `server/tools/saxo-login.ts` (`npm run saxo:login`). The keep-alive needs the token file it writes, and doc 74 names it as the only recovery when a chain dies. Treating it as a v2 root is a judgement call (§9 shows what it keeps alive).
- **Repo gates**: `server/tools/check-path-citations.ts`, `server/tools/check-live-money-gates.ts`, `server/tools/crap-gate.ts` and `server/tools/mutation-local.ts` (CI and CLAUDE.md).
- **Client**: `client/src/main.tsx`. The UI is kept, and the client imports only `@contracts`, which is `contracts/index.ts`.

`ops/bars-snapshot.sh` (`bars:snapshot`) is shell and imports no TypeScript. The v1 scripts (`start`, `orchestrator`, `api`, `dev:api`, `serve`, `dashboard`, `data`, `ingest-history`, `backfill-market-data`, `report:*`, `classify:debate-termination`, `place-soak-position` and the v1 half of `smoke`) are not roots. They go with the waves that delete their files.

## 3. Method

Both methods use the same reachability rule. An import reaches the file that **declares** the imported name, with barrels (`index.ts` re-export files) followed through to the declaring file. A reached file's own imports are then followed. The importer is taken at file level and the target at symbol level. A plain file-level walk would mark almost all of v1 reachable, because v2 imports barrels such as `server/shared/index.ts`, and at file level every file a barrel re-exports counts as used. Barrels on a live import path stay, and each wave removes their re-export lines for deleted files.

Test files are never roots. They are classified afterwards (§3.4).

### 3.1 fallow (method A)

fallow 3.26.0, the repo's own dead-code tool (`.fallowrc.json`), on Node v24.21.0.

1. An analysis copy of HEAD (`git archive`), with `package.json` scripts cut to the v2 set and `.fallowrc.json` `entry` replaced by the §2 roots. Without this, fallow seeds every `package.json` script (v1 included) as an entry.
2. `fallow list --files --production` discovers 604 production `.ts`/`.tsx` files. That is every non-test file except the three in `server/tools/__fixtures__`.
3. `fallow dead-code --production --trace-file <file> --format json` for each of the 604 files. Each trace lists every export with the files that import it, already resolved through barrels, and the file's own re-export map.
4. A fixpoint over those traces from the roots: a live file makes live every export it imports, a live re-export makes its source export live, and an import that binds no name counts as a side-effect import and makes the whole file live. There is one such import, `client/vite.config.ts` importing `contracts/index.ts`.

A plain `fallow dead-code --production --unused-files` run with the same roots reports only 63 unused files. It is file-level, so it shows the barrel effect described above.

### 3.2 graphify (method B)

graphify 0.9.73 (`pip install graphifyy`), AST-only: `graphify update . --no-cluster` built `graphify-out/graph.json` with 15,231 nodes and 45,674 edges from 1,410 files, with no LLM call. Its tree-sitter SQL grammar is not installed, so the 87 `.sql` files add nothing, which does not affect TypeScript reachability.

The walk starts from every symbol in each root file. A live file follows its `imports` edges, which graphify resolves to the declaring symbol through barrels; its `dynamic_import` edges; and, for an `imports_from` edge with no symbol import behind it, the target file (a side-effect import, or a barrel on the import path). Live symbols follow `calls`, `references`, `implements`, `inherits`, `method`, `contains` and `indirect_call`.

graphify resolves some calls by name, which can only add reachability. A run following imports alone gives the identical set, so name resolution changed nothing here.

### 3.3 Commands

```
npm ci --no-audit --no-fund
pip install graphifyy && graphify update . --no-cluster
python3 docs/research/77-v1-teardown-reachability.py <out-dir>
npm run check:live-gates
```

`docs/research/77-v1-teardown-reachability.py` does §3.1 and §3.2 end to end and writes `reach.json`: the base SHA, the both-unreachable list, the one-method-only lists with the reason the other method found each file live, and every reachable file outside v2. It takes a few minutes on 4 cores. **Each wave PR re-runs it on its own base** and deletes only what is still unreachable by both methods. Open PRs #1988 and #1992 already touch candidates (#1988 edits an orchestrator test and service-api/sqlite-query-store.ts) and add v2 files.

### 3.4 Test files and test support

There are 516 test files (`*.test.ts[x]`, `*.spec.ts`), classified by these rules:

- A test whose same-name subject (`foo.test.ts` → `foo.ts`) is on the list is deleted with it. If the subject stays, the test stays.
- A test with no same-name subject is deleted when every non-test file it imports is on the list, when its directory has no surviving production file, or when its only other imports are `server/shared` and `contracts`. Otherwise it is reviewed by hand. There were 16 such tests. 13 were deleted. Two were kept because they test surviving code: server/pipeline/debate-engine/llm/prompt-caching.test.ts and server/pipeline/execution/broker-state-persistence.test.ts. One, saxo-per-request-pacing.test.ts, is held with §7. Three tests the rules marked for deletion are kept, because their subjects are kept as test support: `contracts/boundary.test.ts`, `server/shared/strip-comments.test.ts` and server/pipeline/debate-engine/llm/mock-client.test.ts.
- A test goes in the earliest wave that deletes anything it imports. For example, trader's atr-warmup.test.ts imports orchestrator defaults, so it leaves in wave 2.

Result: 278 tests are deleted, 10 are held with their subjects (§6, §7) and 228 stay.

Four production files that both methods find unreachable are **kept as test support**, because kept tests import them: client/src/test-wire.ts (nine client tests), server/shared/recording-logger.ts (seven server tests), server/shared/strip-comments.ts (`contracts/boundary.test.ts`) and server/pipeline/debate-engine/llm/mock-client.ts (the personas and prompt-caching tests). `vitest.setup.ts`, `vitest.global-setup.ts` and `client/vite.config.ts` are test runner and build config, so they are not deletion candidates either.

### 3.5 What static reachability cannot see

- **Path-loaded assets.** `server/shared/store/migrate.ts` loads `server/shared/store/migrations/` by path and is live, so every shared-store migration stays (kill line: no migration deleted or edited). server/providers/market-intelligence/archive/mi-archive-store.ts loads its own `migrations/` (four SQL files) and is held under G18 (§6). `build:migrations` in `package.json` copies both directories.
- **Dynamic imports.** The only one is `server/tools/mutation-local.ts` loading `stryker.config.mjs`.
- **Shell and launchd** entry points are listed in §2 by hand.
- **Config that names v1 paths** is not code, but each wave edits it: the `.fallowrc.json` `entry` globs (`server/apps/*/index.ts`, `server/apps/service-api/fixture-server.ts`, `server/tools/data-cli.ts`) and its `usedClassMembers` (several are v1 names); the `.oxlintrc.json` barrel rules for each deleted directory; the `stryker.config.mjs` mutate globs; and the `tsconfig.build.json` comment. Removing a rule whose directory no longer exists is not loosening it. Mutation globs for surviving code move with the code (§5).

## 4. Deletion waves

Each wave is one PR. Before it is merged, its kill line (#1748, doc 68) must hold: typecheck, test, lint and smoke green, the client reads no deleted field, `npm run check:live-gates` output unchanged, and no migration deleted or edited. Each wave also trims the barrels that re-export its files, removes its `package.json` scripts and config entries, and marks or rewrites the backticked citations that point at its files. Citations in `docs/adr/`, `docs/reviews/`, `docs/wayfinder/` and `docs/research/archive/` are not scanned and stay as historical records.

The order deletes leaves first. Every file left after a wave imports nothing that wave deletes, apart from the barrel lines the wave itself trims and the two adapter tests noted in wave 3. This was checked with the import map for each wave.

### Wave 1: v1 CLIs and the v1 backtest harness

53 production files (10,190 lines) and 41 test files (11,842 lines). Leaves only: nothing that survives imports these files. Also removes the `data`, `ingest-history`, `backfill-market-data`, `report:arms`, `report:cgt`, `report:debate-flip-rate`, `report:debate-conviction`, `classify:debate-termination` and `place-soak-position` scripts and the server/tools/data-cli.ts `.fallowrc.json` entry, and trims the server/tools/backtest barrel. The momentum scripts are doc 70's harness (§11 q8). report-cgt-disposals.ts reads the archived v1 paper database and is here whatever happens to the CGT matcher (§6).

| Directory | Files (lines) |
|---|---|
| server/tools/ | backfill-market-data.ts (311), classify-debate-termination.ts (304), cli-args.ts (40), data-cli.ts (53), ingest-tiingo-history.ts (50), measure-conviction-ceiling.ts (368), place-soak-position.ts (217), replay-debate-conviction.ts (482), report-arm-comparison.ts (190), report-cgt-disposals.ts (163), report-debate-round-flip-rate.ts (102), run-spread-calibration.ts (639), run-stage2-cost-decomposition.ts (381), run-stage2.ts (434), stage2-source.ts (67), stage2-support.ts (54) |
| server/tools/backtest/ | config-trial-log.ts (36), cost-attribution.ts (146), cost-model.ts (117), eval-executor.ts (90), eval-types.ts (32), free-stack-aggregates-client.ts (291), http-polygon-client.ts (129), http-tiingo-client.ts (133), lookahead.ts (40), metrics.ts (262), proxy-strategy.ts (81), replay-driver.ts (522), splits.ts (167), sqlite-stage2-selection-store.ts (85), stage2-historical-store.ts (340), stage2-selection.ts (83), stage2-verdict.ts (277), trade-derivation.ts (94), trial-execution.ts (267), types.ts (71) |
| server/tools/backtest/momentum/ | bar-csv.ts (29), constituents.ts (71), fixture.ts (71), fx.ts (57), grid.ts (96), market.ts (124), measure-alpaca-spread.ts (192), measure-saxo-spread.ts (157), pull-alpaca-bars.ts (117), pull-saxo-bars.ts (456), repair-saxo-bar-shape.ts (260), report.ts (119), run.ts (394), simulate.ts (537), splice.ts (131), trial-ledger.ts (56), verdict.ts (205) |

<details><summary>Wave 1 tests (41)</summary>

- server/tools/ (15 files, 3,671 lines): backfill-market-data.test.ts, classify-debate-termination.test.ts, cli-args.test.ts, data-cli.test.ts, ingest-tiingo-history.test.ts, measure-conviction-ceiling.test.ts, place-soak-position.test.ts, replay-debate-conviction.test.ts, report-arm-comparison.test.ts, report-cgt-disposals.test.ts, report-debate-round-flip-rate.test.ts, run-spread-calibration.test.ts, run-stage2-cost-decomposition.test.ts, run-stage2.test.ts, stage2-source.test.ts
- server/tools/backtest/ (19 files, 5,516 lines): config-trial-log.test.ts, cost-attribution.test.ts, cost-model.test.ts, eval-executor.test.ts, free-stack-aggregates-client.test.ts, http-polygon-client.test.ts, http-tiingo-client.test.ts, intraday-replay.test.ts, lookahead.test.ts, metrics.test.ts, proxy-strategy.test.ts, replay-driver.test.ts, splits.test.ts, sqlite-stage2-selection-store.test.ts, stage2-historical-store.test.ts, stage2-selection.test.ts, stage2-verdict.test.ts, trade-derivation.test.ts, trial-execution.test.ts
- server/tools/backtest/momentum/ (7 files, 2,655 lines): data-tools.test.ts, repair-saxo-bar-shape.test.ts, run.test.ts, saxo-pull-run.test.ts, saxo-tools.test.ts, simulate.test.ts, verdict.test.ts

</details>

### Wave 2: v1 apps

83 production files (21,413 lines) and 99 test files (45,792 lines). First moves server/apps/orchestrator/live-money-gates.ts, unchanged, next to `server/tools/check-live-money-gates.ts` (§5.2). Then it deletes the three apps and removes the `start`, `orchestrator`, `api`, `dev:api`, `serve` and `dashboard` scripts. The orchestrator half of `smoke` goes, leaving `node dist/server/apps/v2/smoke.js`. It also narrows the `server/apps/*/index.ts` `.fallowrc.json` entry to v2, drops the service-api fixture entry, removes the orchestrator and supervisor `.oxlintrc.json` barrel rules, and drops the service-api mention in the `tsconfig.build.json` comment. Two pipeline tests leave here because they import orchestrator files: trader/atr-warmup.test.ts and verdict/notifications/telegram/telegram-bot-api-client.test.ts.

| Directory | Files (lines) |
|---|---|
| server/apps/orchestrator/ | alert-catalogue.ts (1118), alert-delivery-log.ts (51), alert-transport.ts (184), analysts-decision.ts (41), breach-text.ts (109), console-channels.ts (114), control-arm.ts (123), debate-decision.ts (17), decision-bar-gate.ts (55), fill-sync.ts (252), flatten-tail-priority.ts (11), heartbeat.ts (39), index.ts (895), live-profile.ts (115), log-retention.ts (409), logger.ts (222), orphan-verdict-scan.ts (68), paper-profile.ts (551), production.ts (2552), redact-payload.ts (115), rotating-file-sink.ts (159), scheduler.ts (57), smoke-run.ts (4640), sqlite-account-state-store.ts (65), sqlite-audit-log.ts (64), sqlite-current-tick-store.ts (53), sqlite-daily-equity-store.ts (60), sqlite-session-equity-store.ts (89), tick-loop.ts (274), tick-runner.ts (294), types.ts (147) |
| server/apps/orchestrator/production/ | account-state.ts (241), analysts-adapter.ts (198), bar-prefetch.ts (69), calendar-fallback-alert.ts (9), capital-ceiling.ts (12), carried-lot-alert.ts (162), config.ts (231), control-account-state.ts (170), control-arm-wiring.ts (141), daily-equity-metrics-source.ts (201), data-failover.ts (187), debate-adapter.ts (624), defaults.ts (367), direct-bind.ts (893), environment.ts (106), exit-skip-write-throttle.ts (39), exit-valuation-alert.ts (11), flatten-tick-coupling.ts (58), gate-refusal-rate-guard.ts (141), llm-failure-rate-guard.ts (131), lse-calendar-coverage-alert.ts (9), lse-calendar-coverage-guard.ts (63), mi-coverage.ts (170), mi-refresh-queue.ts (152), on-trade-close-hookup.ts (60), rate-limited-llm-client.ts (35), saxo-funding.ts (70), saxo-venue.ts (284), saxo-weekly-reminder-alert.ts (135), stocks-tick-window.ts (33), threshold-clamp-alert.ts (10), tick-skip-alert.ts (100), trader-diagnostic-alert.ts (66), us-equity-session-source.ts (97), volatility-reading-provider.ts (150), wiring-config-fixtures.ts (87) |
| server/apps/service-api/ | alpaca-client.ts (15), bind-guard.ts (29), fault-guard.ts (32), fixture-server.ts (96), fixture-store.ts (766), index.ts (81), pipeline-query.ts (264), provider-status.ts (211), request-auth.ts (28), server.ts (138), snapshot.ts (335), sqlite-query-store.ts (659), types.ts (101) |
| server/apps/supervisor/ | fault-guard.ts (34), index.ts (32), supervisor.ts (137) |

<details><summary>Wave 2 tests (99)</summary>

- server/apps/orchestrator/ (44 files, 22,924 lines): alert-catalogue.test.ts, alert-delivery-failure-retention.test.ts, alert-delivery-log.test.ts, alert-transport.test.ts, analysts-decision.test.ts, breach-text.test.ts, console-channels.test.ts, control-arm.test.ts, current-tick-store.test.ts, d5-trader-cap-agreement.test.ts, debate-decision.test.ts, decision-bar-gate.test.ts, fill-sync.test.ts, flatten-tail-priority.test.ts, heartbeat.test.ts, index.test.ts, live-profile.test.ts, llm-call-log-retention.test.ts, llm-capture-config.test.ts, log-level.test.ts, log-retention.test.ts, logger.test.ts, mi-archive-retention.test.ts, orphan-verdict-scan.test.ts, paper-profile-provenance.test.ts, paper-profile.test.ts, phase-split.test.ts, production-alpaca-clients.test.ts, production-startup-helpers.test.ts, production.test.ts, redact-payload.test.ts, rotating-file-sink.test.ts, saxo-composition-root.test.ts, scheduler.test.ts, smoke-run.test.ts, sqlite-audit-log.test.ts, sqlite-daily-equity-store.test.ts, startup.test.ts, subclass-deployment-cap.test.ts, tick-loop-helpers.test.ts, tick-loop.test.ts, tick-runner.test.ts, trading-window.test.ts, x-search-dial-config.test.ts
- server/apps/orchestrator/production/ (41 files, 17,292 lines): account-state.test.ts, analysts-adapter.test.ts, bar-prefetch.test.ts, capital-ceiling.test.ts, carried-lot-alert.test.ts, carried-lot-reporter-arm-wiring.test.ts, control-account-state.test.ts, daily-equity-metrics-source.test.ts, data-failover.test.ts, debate-adapter.test.ts, debate-cancellation.test.ts, direct-bind.test.ts, exit-skip-write-throttle.test.ts, filled-zero-size-wiring.test.ts, flat-by-close-to-execution.test.ts, flatten-guard-arm-wiring.test.ts, flatten-reconcile-arm-wiring.test.ts, flatten-tick-coupling.test.ts, gate-refusal-rate-guard.test.ts, gdelt-scoring-wiring.test.ts, llm-failure-rate-guard.test.ts, llm-in-flight-wiring.test.ts, lse-calendar-coverage-guard.test.ts, mi-coverage.test.ts, mi-refresh-queue.test.ts, mi-refresh-wiring.test.ts, on-trade-close-hookup.test.ts, rate-limit-wiring.test.ts, rate-limited-llm-client.test.ts, residual-and-overfill-arm-wiring.test.ts, residual-reflatten-wiring.test.ts, retention-wiring.test.ts, saxo-funding.test.ts, saxo-venue.test.ts, saxo-weekly-reminder-alert.test.ts, stocks-tick-window.test.ts, terminal-sweep-wiring.test.ts, tick-skip-alert.test.ts, trader-diagnostic-alert.test.ts, us-equity-session-source.test.ts, volatility-reading-provider.test.ts
- server/apps/service-api/ (10 files, 4,468 lines): alpaca-client.test.ts, bind-guard.test.ts, fault-guard.test.ts, fixture-store.test.ts, pipeline-query.test.ts, provider-status.test.ts, request-auth.test.ts, server.test.ts, snapshot.test.ts, sqlite-query-store.test.ts
- server/apps/supervisor/ (2 files, 359 lines): fault-guard.test.ts, supervisor.test.ts
- server/pipeline/trader/ (1 file, 131 lines): atr-warmup.test.ts
- server/pipeline/verdict/notifications/telegram/ (1 file, 618 lines): telegram-bot-api-client.test.ts

</details>

### Wave 3: v1 pipeline

106 production files (14,777 lines) and 93 test files (42,825 lines). Trims the server/pipeline/debate-engine, server/pipeline/execution (index.ts and types.ts) and server/pipeline/momentum barrels. Removes the `stryker.config.mjs` globs for trader, risk-manager and verdict, whose directories are gone, and the `.oxlintrc.json` barrel rules for analysts, control-arm, feedback-loop, outside-benchmark, risk-manager, trader and verdict. Rewrites adapters/alpaca-adapter.test.ts fixtures off execute.ts, sqlite-store-harness.ts and the verdict barrel; the held saxo-adapter.test.ts needs the same if it stays. momentum/loss-budget.ts is the copy doc 67 Step 3 sends "with Step 5". Four tests from other areas leave here because they import pipeline files.

| Directory | Files (lines) |
|---|---|
| server/pipeline/analysts/ | fundamental-analyst.ts (53), index.ts (25), intelligence-scoring.ts (24), orchestrator.ts (301), sentiment-analyst.ts (63), technical-analyst.ts (582), types.ts (70) |
| server/pipeline/control-arm/ | arm-comparison.ts (149), axis-vote-decision.ts (53), index.ts (23), sqlite-arm-comparison-source.ts (140) |
| server/pipeline/debate-engine/ | analyst-response-collector.ts (140), conviction-score.ts (95), debate-logger.ts (203), disagreement-detector.ts (160), latency-budget.ts (190), rate-limiter.ts (138), sqlite-debate-log-store.ts (235), weighted-conviction.ts (41) |
| server/pipeline/execution/ | closed-trade.ts (50), cumulative-feed.ts (52), execute.ts (700), fill-cost.ts (49), filled-zero-size-throttle.ts (49), flatten-attribution.ts (106), flatten-overfill-alert.ts (10), flatten-reconcile-alert.ts (11), ingest-fills.ts (778), non-sterling-fee-alert.ts (13), reconcile.ts (688), residual-exposure-alert.ts (16), residual-protection-sweep.ts (318), residual-protection.ts (302), residual-reflatten.ts (272), simulated-adapter.ts (226), sqlite-shared-store.ts (782), sqlite-store-harness.ts (207), unattributed-flatten-fill-alert.ts (14), unrecorded-venue-position-alert.ts (11), unrecorded-venue-position-throttle.ts (27), wedged-zero-fill-sweep.ts (95) |
| server/pipeline/execution/types/ | execution.ts (175), store.ts (128) |
| server/pipeline/feedback-loop/ | arm-comparison-cycle.ts (84), attribution.ts (84), cycle-schedule.ts (14), daily-cycle.ts (160), debate-attribution-lookup.ts (13), fixture-stores.ts (132), guardrails.ts (32), index.ts (47), metrics.ts (139), on-trade-close.ts (16), outside-benchmark-cycle.ts (46), seed-analyst-weights.ts (37), sqlite-adjustment-log.ts (100), sqlite-arm-comparison-sample-store.ts (156), sqlite-closed-trade-store.ts (29), sqlite-feedback-cycle-schedule-store.ts (49), sqlite-outside-benchmark-sample-store.ts (67), sqlite-store-harness.ts (62), sqlite-tuning-store.ts (101), types.ts (32) |
| server/pipeline/feedback-loop/types/ | arm-comparison.ts (69), cycle.ts (34), metrics.ts (52), outside-benchmark.ts (29), tuning.ts (57) |
| server/pipeline/momentum/ | loss-budget.ts (97) |
| server/pipeline/outside-benchmark/ | index.ts (13), market-data-benchmark-series-source.ts (29), outside-benchmark.ts (172) |
| server/pipeline/risk-manager/ | breakers.ts (261), cii-mapping.ts (15), correlation.ts (87), critic-store.ts (174), critic.ts (447), index.ts (611), invalidation.ts (587), portfolio-view.ts (257), risk-thresholds.ts (79), sqlite-breaker-state-store.ts (54), types.ts (188) |
| server/pipeline/trader/ | build-bracket.ts (159), cosine-precedent.ts (95), decide.ts (679), early-exit.ts (50), fixture-setup-store.ts (38), idempotency-key.ts (36), index.ts (22), setup-vector.ts (43), sqlite-setup-store.ts (94), subclass-bracket.ts (101), types.ts (135) |
| server/pipeline/verdict/ | index.ts (241), logging-verdict.ts (19), notifying-verdict.ts (22), sqlite-verdict-log-store.ts (29), types.ts (72), verdict-log-store.ts (22) |
| server/pipeline/verdict/notifications/ | format.ts (34), notable-verdict.ts (12), telegram-channel.ts (18), types.ts (10) |
| server/pipeline/verdict/notifications/telegram/ | telegram-bot-api-client.ts (237), telegram-errors.ts (133) |

<details><summary>Wave 3 tests (93)</summary>

- server/pipeline/analysts/ (9 files, 3,253 lines): analyst-prompt-cost.test.ts, analyst-stage-wall-clock.test.ts, fundamental-analyst.test.ts, orchestrator.test.ts, rsi-warmup.test.ts, sentiment-analyst.test.ts, technical-analyst.test.ts, technical-axes.test.ts, technical-rvol.test.ts
- server/pipeline/control-arm/ (3 files, 904 lines): arm-comparison.test.ts, axis-vote-decision.test.ts, sqlite-arm-comparison-source.test.ts
- server/pipeline/debate-engine/ (9 files, 2,967 lines): analyst-response-collector.test.ts, conviction-score.test.ts, debate-logger.test.ts, disagreement-detector.integration.test.ts, disagreement-detector.test.ts, latency-budget.test.ts, rate-limiter.test.ts, sqlite-debate-log-store.test.ts, weighted-conviction.test.ts
- server/pipeline/execution/ (14 files, 16,159 lines): closed-trade.test.ts, cumulative-feed.test.ts, execute-helpers.test.ts, execute.test.ts, filled-zero-size-throttle.test.ts, flatten-attribution.test.ts, ingest-fills.test.ts, money-math-precision.test.ts, reconcile.test.ts, residual-protection-sweep.test.ts, settlement-helpers.test.ts, simulated-adapter.test.ts, sqlite-shared-store.test.ts, wedged-zero-fill-sweep.test.ts
- server/pipeline/feedback-loop/ (17 files, 3,261 lines): arm-comparison-cycle.test.ts, attribution.test.ts, cycle-schedule.test.ts, daily-cycle.test.ts, debate-attribution-lookup.test.ts, guardrails.test.ts, metrics.test.ts, on-trade-close.test.ts, outside-benchmark-cycle.test.ts, seed-analyst-weights.test.ts, sqlite-adjustment-log.test.ts, sqlite-arm-comparison-sample-store.test.ts, sqlite-closed-trade-store.test.ts, sqlite-feedback-cycle-schedule-store.test.ts, sqlite-outside-benchmark-sample-store.test.ts, sqlite-tuning-store.test.ts, threshold-clamp.test.ts
- server/pipeline/momentum/ (1 file, 109 lines): loss-budget.test.ts
- server/pipeline/outside-benchmark/ (1 file, 257 lines): outside-benchmark.test.ts
- server/pipeline/risk-manager/ (13 files, 6,938 lines): breakers.test.ts, cii-mapping.test.ts, correlation.test.ts, critic.test.ts, gate-messages.test.ts, index.test.ts, invalidation.test.ts, per-subclass-deployment-cap.test.ts, portfolio-view.test.ts, risk-thresholds.test.ts, sqlite-breaker-state-store.test.ts, threshold-clamp.test.ts, types.test.ts
- server/pipeline/trader/ (12 files, 4,810 lines): atr-equivalence.test.ts, book-valuation-refusal.test.ts, build-bracket.test.ts, cosine-precedent.test.ts, decide.test.ts, fixture-setup-store.test.ts, gated-tape-conviction.test.ts, idempotency-key.test.ts, setup-vector.test.ts, sqlite-setup-store.test.ts, subclass-bracket.test.ts, whole-share-sizing.test.ts
- server/pipeline/verdict/ (6 files, 2,083 lines): index.test.ts, logging-verdict.test.ts, market-closed-gate.test.ts, notifying-verdict.test.ts, sqlite-verdict-log-store.test.ts, verdict-log-store.test.ts
- server/pipeline/verdict/notifications/ (3 files, 220 lines): format.test.ts, notable-verdict.test.ts, telegram-channel.test.ts
- server/pipeline/verdict/notifications/telegram/ (1 file, 235 lines): telegram-errors.test.ts
- server/providers/market-data-service/ (1 file, 145 lines): indicator-registry.test.ts
- server/providers/market-intelligence/ (1 file, 762 lines): mi-ingest-agent.test.ts
- server/providers/universe-pool/ (1 file, 666 lines): lse-etp-pool.test.ts
- server/shared/ (1 file, 56 lines): threshold-bounds-readers.test.ts

</details>

### Wave 4: v1 providers

39 production files (6,851 lines) and 33 test files (8,799 lines). Trims the server/providers/market-data-service and server/providers/market-intelligence barrels and removes the universe-pool `.oxlintrc.json` rule. G17 deletes GDELT, Polymarket and WorldMonitor. The grok/ and archive/ files stay under G18 (§6). universe-pool's lse-etp-pool.ts is the 3× ETP universe Q11 lists as known-dead.

| Directory | Files (lines) |
|---|---|
| server/providers/market-data-service/ | alpaca-session-calendar.ts (265), fixture-data-source.ts (43), forming-candle-client.ts (16), indicator-cache.ts (46), indicators.ts (432), ingestion.ts (72), mark-freshness.ts (32), marks-batch.ts (19), rvol.ts (111), service.ts (308), session-features.ts (47), source-factory.ts (28), sqlite-market-data-store.ts (118), timeframe.ts (29), types.ts (85) |
| server/providers/market-data-service/sources/ | alpaca-data-errors.ts (108), alpaca-http-client.ts (421), alpaca-source.ts (89), asset-class-routing-source.ts (58), failover-data-source.ts (146), lse-mark-source.ts (221), normalizing-data-source.ts (212), ohlcv-failover.ts (58), polygon-bars-client.ts (158), polygon-bars-errors.ts (59), session-normalized-fetcher.ts (67) |
| server/providers/market-intelligence/ | gdelt-ingest-agent.ts (181), gdelt-scoring-pass.ts (173), mi-ingest-agent.ts (286) |
| server/providers/market-intelligence/polymarket/ | curated-markets.ts (86), polymarket-agent.ts (496), polymarket-client.ts (174) |
| server/providers/market-intelligence/scoring/ | item-scorer.ts (163) |
| server/providers/market-intelligence/sources/ | gdelt-gkg-client.ts (315), gdelt-scorer.ts (217), gdelt-themes.ts (47) |
| server/providers/market-intelligence/worldmonitor-adapter/ | cii-consumer.ts (63) |
| server/providers/universe-pool/ | index.ts (9), lse-etp-pool.ts (1393) |

<details><summary>Wave 4 tests (33)</summary>

- server/providers/market-data-service/ (14 files, 3,009 lines): alpaca-session-calendar.test.ts, indicator-cache.test.ts, indicator-golden.test.ts, indicator-new-kinds.test.ts, indicator.test.ts, ingestion-round-trip.test.ts, ingestion.test.ts, mark-freshness-session-replay.test.ts, mark-freshness.test.ts, rvol.test.ts, service.test.ts, session-features.test.ts, sqlite-market-data-store.test.ts, timeframe.test.ts
- server/providers/market-data-service/sources/ (10 files, 3,146 lines): alpaca-data-errors.test.ts, alpaca-http-client.test.ts, asset-class-routing-source.test.ts, failover-data-source.test.ts, lse-mark-source.test.ts, normalizing-data-source.test.ts, ohlcv-failover.test.ts, polygon-bars-client.test.ts, session-normalized-fetcher.test.ts, sources.test.ts
- server/providers/market-intelligence/ (2 files, 733 lines): gdelt-ingest-agent.test.ts, gdelt-scoring-pass.test.ts
- server/providers/market-intelligence/polymarket/ (3 files, 902 lines): curated-markets.test.ts, polymarket-agent.test.ts, polymarket-client.test.ts
- server/providers/market-intelligence/scoring/ (1 file, 228 lines): item-scorer.test.ts
- server/providers/market-intelligence/sources/ (2 files, 677 lines): gdelt-gkg-client.test.ts, gdelt-scorer.test.ts
- server/providers/market-intelligence/worldmonitor-adapter/ (1 file, 104 lines): cii-consumer.test.ts

</details>

### Wave 5: dead shared helpers and v1 wire contracts

20 production files (1,477 lines) and 12 test files (1,240 lines). Trims `server/shared/index.ts`, `server/shared/llm/index.ts`, `server/shared/store/index.ts` and `contracts/index.ts`. contracts/snapshot.ts, metrics.ts, pipeline.ts and providers.ts are the v1 dashboard wire; §8 confirms the client reads none of them. No migration is touched: the dead store files are row mappers and stores, not migrations.

| Directory | Files (lines) |
|---|---|
| contracts/ | metrics.ts (26), pipeline.ts (83), providers.ts (34), snapshot.ts (302) |
| server/shared/ | book-currency.ts (12), decision-records.ts (65), median.ts (7), no-data-marker.ts (1), parse-json-column.ts (13), stdout-fault-guard.ts (54), threshold-bounds.ts (119) |
| server/shared/http/ | polygon-aggregates.ts (28) |
| server/shared/llm/ | nous-responses.ts (296) |
| server/shared/store/ | closed-trade-row.ts (38), fill-row.ts (47), key-scheme-guard.ts (66), open-position-row.ts (101), prune-llm-call-log.ts (12), sqlite-decision-record-stores.ts (141), sqlite-llm-spend-cap-store.ts (32) |

<details><summary>Wave 5 tests (12)</summary>

- contracts/ (3 files, 95 lines): metrics.test.ts, pipeline.test.ts, snapshot.test.ts
- server/shared/ (2 files, 248 lines): stdout-fault-guard.test.ts, threshold-bounds.test.ts
- server/shared/llm/ (1 file, 188 lines): nous-responses.test.ts
- server/shared/store/ (6 files, 709 lines): fill-row.test.ts, key-scheme-guard.test.ts, open-position-row.test.ts, prune-llm-call-log.test.ts, sqlite-decision-record-stores.test.ts, sqlite-llm-spend-cap-store.test.ts

</details>

## 5. MOVE list: v1 code that v2 still needs

### 5.1 The #1946 broker code (wave 6, first)

All 22 files are reachable from the v2 roots (21 by both methods; types/broker.ts by fallow only, §9), through `server/apps/v2/execution/{index,alpaca,saxo-session,create-executor,broker-books,sim-cfd-stop-drill-cli,saxo-token-secrets}.ts` and through `server/tools/saxo-keepalive.ts` and `server/tools/saxo-login.ts`. Those are 12 import lines across 9 files, plus the `vi.mock` paths in `server/apps/v2/index.test.ts`, `server/apps/v2/egress.test.ts` and `server/apps/v2/execution/saxo-token-secrets.test.ts`, and a fixture in `server/apps/v2/boundaries.test.ts`.

The target locations below are **proposals for David to confirm**. The ruling says "a v2-visible place" and does not name one.

| Group | Files (lines), all under server/pipeline/execution/ | Proposed concrete target | Interface into `contracts/` |
|---|---|---|---|
| Alpaca adapter and client | adapters/alpaca-adapter.ts (1,001), adapters/alpaca-http-client.ts (455), adapters/alpaca-broker-errors.ts (94), adapters/alpaca-order-normalization.ts (100), adapters/us-equity-price-tick.ts (119), adapters/alpaca-crypto-emulation.ts (606), broker-error.ts (86), protective-rearm-unsupported.ts (15) | server/apps/v2/execution/alpaca/ | AlpacaBrokerClient and its wire types (adapters/alpaca-client.ts, 105) |
| Broker state store | broker-state-store.ts (178, InMemoryBrokerStateStore), sqlite-broker-state-store.ts (267) | server/apps/v2/execution/broker-state/ | the BrokerStateStore interface |
| Saxo token, OAuth, keep-alive | adapters/saxo-environment.ts (13), adapters/saxo-oauth.ts (160), adapters/saxo-token-file.ts (133), adapters/saxo-token-lock.ts (41), adapters/saxo-token-source.ts (434), adapters/saxo-keepalive-state.ts (50), adapters/venue-errors.ts (27) | server/apps/v2/execution/saxo/ | SaxoTokenSource, SaxoSessionState |
| Alert-channel types | oco-double-fill-alert.ts (11), unpriced-fill-alert.ts (15), and SaxoSessionLostAlertChannel in adapters/saxo-token-source.ts | stays with its producer | OcoDoubleFillAlertChannel, UnpricedFillAlertChannel, SaxoSessionLostAlertChannel |
| Type barrels | types.ts (58) and types/broker.ts (9), which re-export the server/shared/types/broker.ts types (#1945); index.ts (118) | deleted once importers point at the new homes | `BrokerAdapter` and its order types could move from `server/shared` to `contracts/` in the same wave (**David's call**) |

That is 22 files and 3,977 lines before the barrels. Notes for the build:

- `contracts/` must keep importing nothing from `server/` (`contracts/boundary.test.ts`).
- The `stryker.config.mjs` glob server/pipeline/execution/** must follow the files, so mutation coverage of the moved adapter is not lost.
- `server/apps/v2/boundaries.test.ts` has an `imports-v1-broker` fixture that must point at the new path.
- adapters/alpaca-crypto-emulation.ts (606 lines) is live only because AlpacaBrokerAdapter calls it. Q11 lists crypto remnants as known-dead. Cutting it out means changing the live Alpaca adapter, which is broker code, so whether that happens in the MOVE PR or in its own PR is **David's call**.
- adapters/alpaca-adapter.test.ts still builds fixtures from v1 execute.ts, sqlite-store-harness.ts, filled-zero-size-throttle.ts, unrecorded-venue-position-throttle.ts and the verdict barrel, all of which wave 3 deletes. Wave 3 has to rewrite those fixtures.

### 5.2 Other survivors in v1-named directories (rename, Step 0 item 8)

These 44 production files are reachable by both methods and live outside `server/apps/v2/`. The renames are **proposals**. Step 0 item 8 asks for v2 vocabulary but rules no names.

| Today | Files (lines) | What v2 uses it for | Proposed home |
|---|---|---|---|
| server/pipeline/debate-engine/ (survivors) | 17 (1,830): llm/anthropic-client, llm/nous-messages-client, llm/spend-cap, llm/spend-sink, llm/errors, llm/failure-cause, llm/json-response, llm/prompt-safety, llm/prompt-tier-alert, llm/types, personas, round-orchestrator, debate-id, analyst-contribution, debate-log-store, types, index | the debate panel's LLM clients, spend cap and sink, the three personas and the round loop | server/apps/v2/signal/debate/ and an llm/ module |
| server/pipeline/momentum/ (survivors) | 6 (321): bars, costs, signal, sizing, stop, index | marks, simulated costs and the candidate sleeves | server/apps/v2/signal/rules/ or risk/ |
| server/tools/backtest/ (survivors) | 7 (628): index, overfitting, combinatorics, universe, validation-types, momentum/folds, momentum/stats | DSR/PBO evidence and backtest verdicts | server/apps/v2/evidence/ |
| server/providers/bar-store/ | 5 (807) | the Parquet bar store and Alpaca pulls | stays a provider (name is not v1-specific) |
| server/providers/saxo-bars/ | 3 (471) | the Saxo chart and CFD catalogue reads | stays a provider |
| server/providers/market-data-service/ (survivors) | 2 (546): index, trading-calendar | venue sessions and holidays | server/providers/calendar/ |
| server/providers/market-intelligence/ (survivors) | 3 (494): index, sources/alpaca-news-client, types | US headlines for the debate | server/providers/news/ |
| server/apps/orchestrator/live-money-gates.ts | 1 (25) | read by `npm run check:live-gates` | server/tools/ next to its checker. This has to move **in wave 2**, before its directory goes, with its content unchanged. |

`server/shared/` (37 reachable files), `contracts/` and the repo gate tools already carry neutral names and stay where they are.

## 6. KEEP by ruling, and held for a ruling

| Item | Files | Ruling | Status |
|---|---|---|---|
| X/social code | server/providers/market-intelligence/grok/{grok-agent, nous-sentiment-client, x-search-client}.ts (847 lines) and their four tests, plus their only dependencies archive/mi-archive-store.ts and archive/mi-sources.ts (268 lines), the archive test and its 4 SQL migrations | **G18**: not deleted while its trial runs; G17's delete is amended for X/social | **KEEP** (ruled). Unreachable from v2 today; there is no v2 social input yet (#1753 open). |
| v1 CGT matcher | server/pipeline/cgt/ (4 files, 600 lines, and 3 tests) | #1947 (open): "v1's matcher … holds the matching rules. Reuse them or port them; do not re-derive them" | **HOLD, David's call**: keep until #1947 ports it, or delete now and port from tag v1-final. server/tools/report-cgt-disposals.ts, the v1 paper-DB report, is in wave 1 either way. |
| v1 Saxo bracket adapter | server/pipeline/execution/adapters/saxo-adapter.ts (1,200), saxo-price-unit.ts and three alert-type files (42); saxo-adapter.test.ts (2,536) and saxo-per-request-pacing.test.ts (227) | none yet; tied to §7 | **HOLD, David's call** with saxo-http-client.ts. #1426 (open) names saxo-adapter.ts as its code. |
| Shared-store migrations | `server/shared/store/migrations/` | kill line, doc 67 Step 5 | KEEP (live, never edited) |
| v1 ADRs and specs | already deleted | G8, G14 | nothing left to do |

Four more items need David to say whether G18's keep covers them; they are in the waves as listed until he answers:

- server/pipeline/analysts/sentiment-analyst.ts and intelligence-scoring.ts (wave 3). These are v1's sentiment *analyst*, where the class-wide-vote defect that G18 (3) binds against lived. They are not the X/social source code.
- server/providers/market-intelligence/mi-ingest-agent.ts and scoring/item-scorer.ts (wave 4). These are generic MI ingest and scoring, which the X agent does not import.
- The Polymarket code (wave 4). G18 says Polymarket is "skipped for now" and G17 deletes it.
- G17's parked tickets stay open whichever way this goes: #688 (GDELT), #1042 (MI archive Reddit), and #1685/#1686 (X).

## 7. saxo-http-client.ts: options for David (not decided)

What the reachability shows:

- **The v2 runtime never constructs a Saxo order client.** `createBrokerAccess` (`server/apps/v2/execution/create-executor.ts`) routes `saxo`, `saxo_cfd_gbp` and `saxo_cfd_usd` to `DryRunBrokerAdapter`. v2's real Saxo HTTP is `server/apps/v2/execution/saxo-sim-gateway.ts` (sim-only, the CFD stop drill) and the bars and catalogue reads in server/providers/saxo-bars.
- **fallow marks saxo-http-client.ts reachable only as a type pass-through.** `server/tools/saxo-login.ts` imports the `SaxoTradingEnvironment` type through the server/pipeline/execution barrel, which re-exports it from saxo-http-client.ts, which re-exports it from saxo-environment.ts. graphify resolves the type straight to saxo-environment.ts and finds saxo-http-client.ts, saxo-client.ts and saxo-broker-errors.ts unreachable (§9). No line of SaxoHttpBrokerClient runs from any v2 root. Pointing that one type import at saxo-environment.ts makes the three files unreachable by both methods.
- Its weight is 844 production lines (saxo-http-client.ts 551, saxo-client.ts 127, saxo-broker-errors.ts 166) and 1,601 test lines. saxo-token-source.test.ts also builds a SaxoHttpBrokerClient.

Options:

| Option | What happens | #1930 (`__next` AccountKey fix) | #1868 (accountKey config) | #1426 (GTC-leg SIM probe) |
|---|---|---|---|---|
| **A. Delete** with the §6 Saxo adapter hold, in wave 3, after re-pointing the type import | v2's live Saxo adapter is built fresh when the live gate needs it, with tag v1-final for reference | close unmerged | close; its wiring target (orchestrator saxo-venue.ts) is deleted in wave 2 | re-scope to v2's future adapter or close |
| **B. Move** the client and its types and errors into v2 (for example server/apps/v2/execution/saxo/) as the base of the live Saxo adapter, keeping saxo-adapter.ts held or moving it too | carries 844 (or about 2,100) unwired lines and their tests until a v2 Saxo route exists; fallow will report them unused unless they are listed as entries | merge first, then move | re-scope to a v2 config field | runs against the moved adapter |
| **C. Move the transport only** (saxo-http-client.ts, saxo-client.ts types, saxo-broker-errors.ts, venue-errors.ts) and delete saxo-adapter.ts, whose DayOrder/IfDone bracket semantics are the intraday design | keeps the account scoping, pacing and pagination work (#1848, #1930) without the v1 bracket logic | merge first, then move | re-scope to v2 | close or re-scope (it probes the deleted adapter's branch) |

Not decided here. The choice also depends on whether the live Saxo leg (ETFs at Saxo, Q2) should reuse v1's client or extend `saxo-sim-gateway.ts`, which is outside this ticket.

## 8. Client pass

- The client (`client/src/`) imports only `@contracts`, and 38 distinct names from it. None comes from the v1 wire files that wave 5 deletes (contracts/snapshot.ts, metrics.ts, pipeline.ts, providers.ts). They were checked by name against every export of those files.
- The client talks only to the v2 dashboard API (`server/apps/v2/api/`), which is entirely live, so no endpoint loses a field.
- The v2 API reads only `v2_*` tables plus `llm_spend` and `llm_call_log`, which the surviving debate-engine spend sink writes. No table it reads is fed only by deleted code.
- **Fields that would go unread: none.** The v1 dashboard and its wire (service-api, contracts/snapshot.ts) were replaced in the Step 3c build (doc 66 U5), so wave 2 and wave 5 delete only the server side of a client that is already gone.

## 9. Where the two methods disagree

| File | fallow | graphify | Why | Effect |
|---|---|---|---|---|
| server/pipeline/execution/adapters/saxo-http-client.ts | reachable | unreachable | type pass-through for `SaxoTradingEnvironment` from saxo-login.ts (§7); graphify resolves to the declaring file, fallow stops at the re-exporting file | not on the list; §7 decides |
| server/pipeline/execution/adapters/saxo-client.ts | reachable | unreachable | only saxo-http-client.ts uses it | follows saxo-http-client.ts |
| server/pipeline/execution/adapters/saxo-broker-errors.ts | reachable | unreachable | the same | follows saxo-http-client.ts |
| server/pipeline/execution/types/broker.ts | reachable | unreachable | a 9-line re-export of the server/shared/types/broker.ts types (#1945) that fallow keeps as a hop | not on the list; goes with the §5.1 barrels |

There are no files that fallow finds unreachable and graphify reaches. Before graphify was given the barrel-on-import-path rule (§3.2), it reported 22 more files unreachable. 19 were barrels that v2 imports through, such as `server/shared/index.ts`, whose re-exported symbols graphify credits to the declaring file. The other 3 are imported only by a barrel's own code: server/pipeline/debate-engine/debate-log-store.ts, server/providers/market-intelligence/types.ts and server/shared/types/ports.ts. All 22 are live and stay.

## 10. Live gates and issue references

`npm run check:live-gates`, run on 2026-10-02 in a container where `gh` is not authenticated:

```
LIVE_MONEY_GATES re-verification
  list last verified on:  2026-08-31
  issues cited:           2

  [UNKNOWN] #895 — the live equity leg still has no chosen mark vendor — …
  [UNKNOWN] #900 — a data-source outage leaves the book able to take exactly ONE action — …

  UNKNOWN: 2 issue(s) could not be checked: #895, #900.
  This is NOT a clearance — check `gh auth status` and re-run. An unchecked gate
  must be treated as open.
```

The exit code was 1. Checked through the GitHub API instead on the same day: **#895 is open and #900 is closed**, so the list carries one stale entry. Refreshing it is **David's call** and outside this ticket; the waves must leave the output unchanged. The list lives in server/apps/orchestrator/live-money-gates.ts, which is live, and moves in wave 2 without edits.

Deletion candidates that cite an issue: 238 of the 579 files cite 347 distinct issue numbers. Four of those numbers are open issues today (#895, #1387, #1400 and #688). The table adds #900, which is a live gate, and the open issues cited by held or kept files:

| Open issue | Cited by (wave) |
|---|---|
| #895 (LSE mark source, live gate) | orchestrator/production/defaults.ts, orchestrator/smoke-run.ts, orchestrator/paper-profile.test.ts (wave 2) |
| #900 (closed; still on the live-gate list) | orchestrator/paper-profile.test.ts (wave 2), trader/decide.test.ts (wave 3) |
| #1400 (Step 4b Saxo SIM drill) | orchestrator/saxo-composition-root.test.ts (wave 2). v2's drill is `server/apps/v2/execution/sim-cfd-stop-drill.ts`, so the ticket keeps a target. |
| #1387 (LSE holidays to 2029) | orchestrator/production/lse-calendar-coverage-guard.ts, orchestrator/production.test.ts (wave 2). The v2 calendar is server/providers/market-data-service/trading-calendar.ts (§5.2), so the ticket keeps a target. |
| #688 (GDELT confidence curve, G17 parked) | market-intelligence/sources/gdelt-scorer.test.ts (wave 4) |
| #1426 (Saxo GTC-leg probe) | adapters/saxo-adapter.test.ts (held, not on the list; §7) |
| #1717, #1753, #1785 | client/src/test-wire.ts (kept as test support, not on the list) |

Per wave: wave 1 cites 37 distinct issues and no open one. Wave 2 cites 252, with #895, #1387 and #1400 open. Wave 3 cites 155, none open. Wave 4 cites 39, with #688 open. Wave 5 cites 10, none open. Doc citations each wave must fix, outside the immutable record directories: wave 1 has 23 in 10 files, wave 2 has 34 in 12, wave 3 has 32 in 13 (one is a fixture string in `server/tools/check-path-citations.test.ts`), wave 4 has 12 in 10 and wave 5 has 7 in 4.

## 11. Questions for David

1. **Approve the deletion list** (§4), wave by wave or as a whole.
2. **saxo-http-client.ts**: option A, B or C (§7). This decides #1930, #1868 and #1426.
3. **The v1 CGT matcher** (§6): hold it until #1947 ports it, or delete it in wave 3 and port it from tag v1-final?
4. **G18 scope** (§6): does "the X/social code" also cover the v1 sentiment analyst, the MI ingest agent and the item scorer? If yes, they move from waves 3 and 4 to KEEP.
5. **MOVE targets and names** (§5): confirm the proposed homes, and whether `BrokerAdapter` moves from `server/shared` to `contracts/` in the same wave.
6. **Alpaca crypto emulation** (§5.1): cut it from the live Alpaca adapter inside the MOVE PR, or in its own PR?
7. **Order**: waves 1 to 5, then the MOVE wave, as proposed. Or the MOVE first, so v2 stops importing `pipeline/` before any deletion?
8. **Momentum backtest scripts** (wave 1, server/tools/backtest/momentum): doc 67 Step 3 already sends the momentum loss-budget copy "with Step 5". Confirm that doc 70's numbers are then reproduced only from tag v1-final.
9. **`saxo:login` as a v2 root** (§2): confirm. If it is not a root, nothing changes except the §7 pass-through.
10. **Stale live gate #900** (§10): refresh the list, or leave it for the live gate review?

## 12. Re-running

Run `python3 docs/research/77-v1-teardown-reachability.py <out-dir>` on the wave's base, then diff `reach.json`'s `both_unreachable` against the wave's list above. A file that has become reachable since 2026-10-02 drops out of the wave. A newly unreachable file waits for the next review rather than joining silently.
