# v1 teardown reachability (#1748, Step 5 phase 1)

Status: **report for David's review. Nothing is deleted or moved by this doc or its PR.** Session F (doc 68) stops here: the waves below run only after David has ruled on the questions in §11. Revised after review round 1 on PR #1999 (§13). Waves 1–5 are done; the teardown summary at the end of §4 closes them.

Base: `origin/main` at d692553d (2026-10-02). Rulings applied: doc 66 Q11, G8, G14, G17, G18 and the 2026-10-01 ruling 8 (#1946: concrete broker adapters stay in v1 until Step 5), plus the #1946 scope note on #1748 (option C: the broker code v2 still imports moves to a v2-visible place, its interfaces to `contracts/`).

This doc writes without backticks every file path that a later wave deletes or moves, so the citation checker (`npm run check:citations`) keeps passing after each wave. The generator asserts this.

## 1. Summary

A file is on the deletion list only if **both** methods find it unreachable from every v2 root (§2, §3), and also unreachable once the files kept by ruling and the files held for a ruling are added as extra roots (§3.3). Out of 604 production TypeScript files, fallow finds 322 unreachable from the v2 roots and graphify 326. The 4 extra files are the disagreements in §9, and they stay. Of the 322 that both methods agree on, 24 are not deleted:

- **7 excluded.** The two Vitest setup files and the Vite config are config, not modules. The other four are test helpers that kept tests import (§3.5).
- **6 kept by ruling.** The G18 X/social code (3 files) and the three files it imports that nothing in v2 reaches: archive/mi-archive-store.ts, archive/mi-sources.ts and server/shared/llm/nous-responses.ts (§6).
- **11 held for a ruling.** These are the v1 CGT matcher (Q3, #1947) and the v1 Saxo bracket adapter (Q2), each with the files it imports that are otherwise on the list (§6).

That leaves **298 production files and 276 test files (574 files, 164,608 lines)** on the list, in five waves. Each file is deleted no later than the wave of anything that imports it (§4):

| Wave | Area | Prod files | Prod lines | Test files | Test lines |
|---|---|---:|---:|---:|---:|
| 1 | v1 command-line tools | 38 | 7,966 | 27 | 8,011 |
| 2 | v1 apps and the backtest library they use | 97 | 23,566 | 116 | 55,267 |
| 3 | v1 pipeline | 107 | 14,848 | 90 | 37,181 |
| 4 | v1 providers | 39 | 6,851 | 33 | 8,799 |
| 5 | dead shared helpers and v1 wire contracts | 17 | 1,122 | 10 | 997 |
| **Total** | | **298** | **54,353** | **276** | **110,255** |

A sixth wave deletes nothing. v2 still reaches 114 production files outside `server/apps/v2/`, `client/`, `contracts/` and `e2e/`: 26 under server/pipeline/execution, 44 in other v1-named directories, 37 in `server/shared` and 7 in `server/tools`. The sixth wave moves the first two groups, starting with the #1946 broker code (§5). These are the surviving v1-named modules that Step 5 also renames.

## 2. Roots

The v2 roots are every entry point that runs v2, builds or tests it, or keeps it alive on the Mac:

- **v2 npm scripts** (`package.json`): `v2:run`, `v2:capital`, `v2:entry-offsets`, `v2:cost-fidelity`, `v2:replay`, `v2:backup`, `v2:restore`, `v2:dashboard`, `v2:telegram`, `v2:signals`, `v2:trials`, `v2:backtest`, `v2:sim-cfd-stop-drill` and `v2:cfd-catalogue`. Their files are `server/apps/v2/{index,set-capital,report-entry-offsets,report-cost-fidelity,replay-cli,backup-cli,trial-ledger,backtest-cli,cfd-catalogue-cli}.ts`, `server/apps/v2/api/main.ts`, `server/apps/v2/api/telegram-main.ts`, `server/apps/v2/signals/main.ts` and `server/apps/v2/execution/sim-cfd-stop-drill-cli.ts`.
- **v2 smoke and e2e**: `server/apps/v2/smoke.ts` (the v2 half of `npm run smoke`), `server/apps/v2/api/fixture-server.ts`, `e2e/playwright.config.ts` and `e2e/support/*.ts`. Every e2e spec runs against the v2 fixture server.
- **launchd plists** (`ops/launchd/`): `com.samurai.v2-paper` (`server/apps/v2/index.ts`), `com.samurai.v2-signals` (`server/apps/v2/signals/main.ts`), `com.samurai.v2-telegram` (`server/apps/v2/api/telegram-main.ts`) and `com.samurai.saxo-keepalive` (`server/tools/saxo-keepalive.ts`).
- **Saxo token bootstrap**: server/tools/saxo-login.ts (`npm run saxo:login`). The keep-alive needs the token file it writes, and doc 74 names it as the only recovery when a chain dies. Treating it as a v2 root is a judgement call; §9 shows what it keeps alive.
- **Repo gates**: `server/tools/check-path-citations.ts`, `server/tools/check-live-money-gates.ts`, `server/tools/crap-gate.ts` and `server/tools/mutation-local.ts` (CI and CLAUDE.md).
- **Client**: `client/src/main.tsx`. The UI is kept, and the client imports only `@contracts`, which is `contracts/index.ts`.

`ops/bars-snapshot.sh` (`bars:snapshot`) is shell and imports no TypeScript. The v1 scripts (`start`, `orchestrator`, `api`, `dev:api`, `serve`, `dashboard`, `data`, `ingest-history`, `backfill-market-data`, `report:*`, `classify:debate-termination`, `place-soak-position` and the v1 half of `smoke`) are not roots. They go with the waves that delete their files.

## 3. Method

Both methods use the same reachability rule. An import reaches the file that **declares** the imported name, with barrels (`index.ts` re-export files) followed through to the declaring file. A reached file's own imports are then followed. The importer is taken at file level and the target at symbol level. A plain file-level walk would mark almost all of v1 reachable, because v2 imports barrels such as `server/shared/index.ts`, and at file level every file a barrel re-exports counts as used. Barrels on a live import path stay, and each wave removes their re-export lines for deleted files.

Both methods analyse the same tree: an archive of HEAD with the `package.json` scripts cut to the v2 set and the `.fallowrc.json` `entry` replaced by the §2 roots. graphify is rebuilt inside that copy, so a stale or dirty working-tree graph cannot leak in. Test files are never roots; they are classified afterwards (§3.5).

### 3.1 fallow (method A)

fallow 3.26.0, the repo's own dead-code tool (`.fallowrc.json`), on Node v24.21.0.

1. `fallow list --files --production` discovers 604 production `.ts`/`.tsx` files: every non-test file except the three in `server/tools/__fixtures__`. Without the cut-down `package.json`, fallow would seed every script, v1 included, as an entry.
2. `fallow dead-code --production --trace-file <file> --format json` runs once for each of the 604 files. Each trace lists every export together with the files that import it, already resolved through barrels, and the file's own re-export map.
3. A fixpoint walks those traces from the roots. A live file makes every export it imports live. A live re-export makes its source export live. An import that binds no name counts as a side-effect import and makes the whole file live. There is one such import: `client/vite.config.ts` importing `contracts/index.ts`.

A plain `fallow dead-code --production --unused-files` run with the same roots reports only 63 unused files. It is file-level, so it shows the barrel effect described above.

### 3.2 graphify (method B)

graphify 0.9.73 (`pip install graphifyy`), AST-only. `graphify update . --no-cluster` builds `graphify-out/graph.json` in the copy (15,231 nodes, 45,674 edges, 1,410 files) without any LLM call. Its tree-sitter SQL grammar is not installed, so the 87 `.sql` files add nothing; that does not affect TypeScript reachability.

The walk starts from every symbol in each root file. A live file follows three kinds of edge:

- its `imports` edges, which graphify resolves through barrels to the declaring symbol;
- its `dynamic_import` edges;
- for an `imports_from` edge with no symbol import behind it, the target file. That is either a side-effect import or a barrel on the import path.

Live symbols follow `calls`, `references`, `implements`, `inherits`, `method`, `contains` and `indirect_call`. graphify resolves some calls by name, which can only add reachability. A run that follows imports alone gives the identical set, so name resolution changed nothing here.

### 3.3 Keep and hold closure

Kept and held files have their own imports, and the v2 roots do not reach them. So the script runs both methods twice more:

- **Pass 2** adds the kept files as extra roots: the three configs, the four test helpers and the G18 X/social files. Anything that becomes reachable is kept. That is how server/shared/llm/nous-responses.ts, imported by grok/x-search-client.ts, comes off wave 5.
- **Pass 3** adds the held roots: the four server/pipeline/cgt files for Q3 and adapters/saxo-adapter.ts for Q2. Anything that becomes reachable is held conditionally. A run per hold records which answer releases each file (§6).

One edge is cut in pass 3. saxo-adapter.ts imports only the constant `SAXO_COMMISSION_RATE` from cost-model.ts. cost-model.ts imports types.ts, and types.ts type-imports `TickOutcome` from the orchestrator. Without the cut, holding the adapter whole holds 244 files, the entire orchestrator among them. With the cut, it holds the adapter's own 4 small files plus book-currency.ts. If Q2 keeps the adapter, the constant moves before wave 2 (§6).

### 3.4 Wave order

A wave may not delete a file that something surviving the wave still imports or reads. The script therefore settles every list file to the latest wave of any list file that imports it (symbol-level, by both methods, plus `readFileSync(new URL(...))` paths). It does this before assigning tests.

Settling moved most of the server/tools/backtest library from wave 1 to wave 2, because the orchestrator imports cost-model, metrics, the stage2 selection files and others. It moved types.ts to wave 3, because execute.ts, simulated-adapter.ts and types/execution.ts import it.

One edge would tie waves 2 and 3 into a cycle: types.ts type-imports `TickOutcome` from the orchestrator. That import is cut by a one-line edit in wave 2 (§4).

After settling, a surviving file reaches a deleted file only in three places: a barrel line its own wave trims, that one cut, and the two adapter tests in §4.6. This was checked by re-running every surviving file's imports and reads against the final lists.

### 3.5 Test files and test support

There are 516 test files (`*.test.ts[x]`, `*.spec.ts`). A test's dependencies are its symbol-level imports (graphify, through barrels), its direct relative imports and `vi.mock` paths, and any file it reads through `new URL(..., import.meta.url)`. Each test is then classified:

- **Same-name subject.** A test whose same-name subject (`foo.test.ts` → `foo.ts`) is on the list is deleted. A test whose subject is held is held. A test whose subject stays, stays.
- **No same-name subject.** The test is deleted when every non-test file it depends on is on the list, when its directory has no surviving production file, or when its only other dependencies are in `server/shared` and `contracts`. Otherwise the rule still deletes it but flags it for review. 13 tests were flagged; each was checked by hand and is v1-only. Two tests are kept by name because they test surviving code: `server/shared/debate/llm/prompt-caching.test.ts` and server/pipeline/execution/broker-state-persistence.test.ts. One is held by name with Q2: adapters/saxo-per-request-pacing.test.ts.
- **Wave.** A deleted test leaves in the earliest wave that deletes anything it depends on. For example, server/shared/threshold-bounds-readers.test.ts reads orchestrator/production.ts, so it leaves in wave 2.
- **Surviving tests.** A kept or held test that depends on a list file needs a rewrite by that file's wave (§4.6).

Result: 276 tests are deleted, 6 are held and 234 stay.

Four production files that both methods find unreachable are **kept as test support**, because kept tests import them:

- `client/src/test-wire.ts`, imported by nine client tests;
- `server/shared/recording-logger.ts`, imported by seven server tests;
- `server/shared/strip-comments.ts`, imported by `contracts/boundary.test.ts`;
- server/pipeline/debate-engine/llm/mock-client.ts, imported by the personas and prompt-caching tests.

`vitest.setup.ts`, `vitest.global-setup.ts` and `client/vite.config.ts` are test runner and build config.

### 3.6 What static reachability cannot see, and the config each wave edits

- **Path-loaded assets.** `server/shared/store/migrate.ts` loads `server/shared/store/migrations/` by path and is live, so every shared-store migration stays (kill line: no migration deleted or edited). The MI archive store loads its own four SQL migrations and is kept under G18. `build:migrations` in `package.json` copies both directories. The script lists the non-TypeScript files under `server/` that only list files and config mention:
  - orchestrator/alert-catalogue.golden.json (wave 2);
  - the indicator golden fixture and its generator (wave 4).
- **Dynamic imports.** The only one is `server/tools/mutation-local.ts` loading `stryker.config.mjs`.
- **Shell and launchd** entry points are listed in §2 by hand.
- **Config and tooling that name list paths.** The script scans every tracked non-doc file (TS, MJS, JSON, YAML, plist, shell, Python), taking `package.json` and `.fallowrc.json` from HEAD rather than from the analysis copy. Each wave edits the files it found, as §4 sets out:
  - `package.json` scripts;
  - `.fallowrc.json`: the data-cli and service-api fixture entries, the `server/apps/*/index.ts` glob, the market-data-service `__fixtures__` ignore, and the `usedClassMembers` entries that are v1 names;
  - `.oxlintrc.json`: the barrel rules for each deleted directory, two orchestrator file overrides, and the `__fixtures__` ignore;
  - `.vscode/launch.json`: the service-api and orchestrator launch configs;
  - `.github/workflows/ci.yml`: the indicator golden step;
  - `stryker.config.mjs`: the mutate globs;
  - `server/tools/mutation-local.ts` `TRADING_PATH_PREFIXES` and the cases in `server/tools/mutation-local.test.ts` that pin those paths. CI uses these prefixes to decide which changed files must meet the mutation score bar;
  - the `tsconfig.build.json` comment;
  - a fixture string in `server/tools/check-path-citations.test.ts`.

Removing a rule whose directory no longer exists is not loosening it. Mutation globs and trading-path prefixes for surviving code move with the code (§5).

## 4. Deletion waves

Each wave is one PR. Before it is merged, its kill line (#1748, doc 68) must hold:

- typecheck, test, lint and smoke are green;
- the client reads no deleted field;
- `npm run check:live-gates` output is unchanged;
- no migration is deleted or edited.

Each wave also:

- trims the barrels that re-export its files;
- removes its scripts and config entries (§3.6);
- marks or rewrites the backticked citations that point at its files. Citations in `docs/adr/`, `docs/reviews/`, `docs/wayfinder/` and `docs/research/archive/` are not scanned and stay as historical records.

Open PRs #1988 and #1992 already touch candidates (#1988 edits an orchestrator test and service-api/sqlite-query-store.ts), so **each wave PR re-runs the script on its own base** (§12).

### Wave 1: v1 command-line tools

38 production files (7,966 lines) and 27 test files (8,011 lines). The top-level v1 CLIs in server/tools, the doc 70 momentum harness in server/tools/backtest/momentum, and the backtest files only those CLIs use. It removes the `data`, `ingest-history`, `backfill-market-data`, `report:arms`, `report:cgt`, `report:debate-flip-rate`, `report:debate-conviction`, `classify:debate-termination` and `place-soak-position` scripts and the data-cli.ts entry in `.fallowrc.json`, and trims the server/tools/backtest barrel. server/tools/__fixtures__/seed-unvalidated.ts goes too: only two momentum tests in this wave import it, and fallow ignores the directory. report-cgt-disposals.ts reads the archived v1 paper database, so it is here whatever Q3 decides.

| Directory | Files (lines) |
|---|---|
| server/tools/ | backfill-market-data.ts (311), classify-debate-termination.ts (304), cli-args.ts (40), data-cli.ts (53), ingest-tiingo-history.ts (50), measure-conviction-ceiling.ts (368), place-soak-position.ts (217), replay-debate-conviction.ts (482), report-arm-comparison.ts (190), report-cgt-disposals.ts (163), report-debate-round-flip-rate.ts (102), run-spread-calibration.ts (639), run-stage2-cost-decomposition.ts (381), run-stage2.ts (434), stage2-source.ts (67), stage2-support.ts (54) |
| server/tools/backtest/ | cost-attribution.ts (146), free-stack-aggregates-client.ts (291), http-polygon-client.ts (129), http-tiingo-client.ts (133), stage2-historical-store.ts (340) |
| server/tools/backtest/momentum/ | bar-csv.ts (29), constituents.ts (71), fixture.ts (71), fx.ts (57), grid.ts (96), market.ts (124), measure-alpaca-spread.ts (192), measure-saxo-spread.ts (157), pull-alpaca-bars.ts (117), pull-saxo-bars.ts (456), repair-saxo-bar-shape.ts (260), report.ts (119), run.ts (394), simulate.ts (537), splice.ts (131), trial-ledger.ts (56), verdict.ts (205) |

<details><summary>Wave 1 tests (27)</summary>

- server/tools/ (15 files, 3,671 lines): backfill-market-data.test.ts, classify-debate-termination.test.ts, cli-args.test.ts, data-cli.test.ts, ingest-tiingo-history.test.ts, measure-conviction-ceiling.test.ts, place-soak-position.test.ts, replay-debate-conviction.test.ts, report-arm-comparison.test.ts, report-cgt-disposals.test.ts, report-debate-round-flip-rate.test.ts, run-spread-calibration.test.ts, run-stage2-cost-decomposition.test.ts, run-stage2.test.ts, stage2-source.test.ts
- server/tools/backtest/ (5 files, 1,685 lines): cost-attribution.test.ts, free-stack-aggregates-client.test.ts, http-polygon-client.test.ts, http-tiingo-client.test.ts, stage2-historical-store.test.ts
- server/tools/backtest/momentum/ (7 files, 2,655 lines): data-tools.test.ts, repair-saxo-bar-shape.test.ts, run.test.ts, saxo-pull-run.test.ts, saxo-tools.test.ts, simulate.test.ts, verdict.test.ts

</details>

### Wave 2: v1 apps and the backtest library they use

97 production files (23,566 lines) and 116 test files (55,267 lines). Three steps happen first. (1) server/apps/orchestrator/live-money-gates.ts moves, unchanged, next to `server/tools/check-live-money-gates.ts` (§5.2). (2) server/tools/backtest/types.ts stops importing `TickOutcome` from the orchestrator: the type is inlined or the `tick_outcomes` field dropped. That one type-only import is the only edge that otherwise ties waves 2 and 3 into a cycle. types.ts itself goes in wave 3, because execute.ts, simulated-adapter.ts and types/execution.ts import it. (3) If Q2 keeps the Saxo bracket adapter, `SAXO_COMMISSION_RATE` moves out of cost-model.ts first (§6). Then the wave deletes the three apps and the backtest library they import (cost-model, metrics, stage2 selection and verdict, replay driver, trial execution and the rest listed below). It removes the `start`, `orchestrator`, `api`, `dev:api`, `serve` and `dashboard` scripts, drops the orchestrator half of `smoke` (leaving `node dist/server/apps/v2/smoke.js`), narrows the `server/apps/*/index.ts` `.fallowrc.json` entry to v2 and drops its service-api fixture entry, removes the orchestrator and supervisor `.oxlintrc.json` rules (including the two orchestrator file overrides), the service-api and orchestrator launch configs in `.vscode/launch.json`, and the service-api mention in the `tsconfig.build.json` comment, and deletes alert-catalogue.golden.json with its test. Five tests from other areas leave here because they import or read a wave 2 file: threshold-bounds-readers.test.ts reads orchestrator/production.ts with `readFileSync(new URL(...))`, and the others are listed below.

| Directory | Files (lines) |
|---|---|
| server/apps/orchestrator/ | alert-catalogue.ts (1118), alert-delivery-log.ts (51), alert-transport.ts (184), analysts-decision.ts (41), breach-text.ts (109), console-channels.ts (114), control-arm.ts (123), debate-decision.ts (17), decision-bar-gate.ts (55), fill-sync.ts (252), flatten-tail-priority.ts (11), heartbeat.ts (39), index.ts (895), live-profile.ts (115), log-retention.ts (409), logger.ts (222), orphan-verdict-scan.ts (68), paper-profile.ts (551), production.ts (2552), redact-payload.ts (115), rotating-file-sink.ts (159), scheduler.ts (57), smoke-run.ts (4640), sqlite-account-state-store.ts (65), sqlite-audit-log.ts (64), sqlite-current-tick-store.ts (53), sqlite-daily-equity-store.ts (60), sqlite-session-equity-store.ts (89), tick-loop.ts (274), tick-runner.ts (294), types.ts (147) |
| server/apps/orchestrator/production/ | account-state.ts (241), analysts-adapter.ts (198), bar-prefetch.ts (69), calendar-fallback-alert.ts (9), capital-ceiling.ts (12), carried-lot-alert.ts (162), config.ts (231), control-account-state.ts (170), control-arm-wiring.ts (141), daily-equity-metrics-source.ts (201), data-failover.ts (187), debate-adapter.ts (624), defaults.ts (367), direct-bind.ts (893), environment.ts (106), exit-skip-write-throttle.ts (39), exit-valuation-alert.ts (11), flatten-tick-coupling.ts (58), gate-refusal-rate-guard.ts (141), llm-failure-rate-guard.ts (131), lse-calendar-coverage-alert.ts (9), lse-calendar-coverage-guard.ts (63), mi-coverage.ts (170), mi-refresh-queue.ts (152), on-trade-close-hookup.ts (60), rate-limited-llm-client.ts (35), saxo-funding.ts (70), saxo-venue.ts (284), saxo-weekly-reminder-alert.ts (135), stocks-tick-window.ts (33), threshold-clamp-alert.ts (10), tick-skip-alert.ts (100), trader-diagnostic-alert.ts (66), us-equity-session-source.ts (97), volatility-reading-provider.ts (150), wiring-config-fixtures.ts (87) |
| server/apps/service-api/ | alpaca-client.ts (15), bind-guard.ts (29), fault-guard.ts (32), fixture-server.ts (96), fixture-store.ts (766), index.ts (81), pipeline-query.ts (264), provider-status.ts (211), request-auth.ts (28), server.ts (138), snapshot.ts (335), sqlite-query-store.ts (659), types.ts (101) |
| server/apps/supervisor/ | fault-guard.ts (34), index.ts (32), supervisor.ts (137) |
| server/tools/backtest/ | config-trial-log.ts (36), cost-model.ts (117), eval-executor.ts (90), eval-types.ts (32), lookahead.ts (40), metrics.ts (262), proxy-strategy.ts (81), replay-driver.ts (522), splits.ts (167), sqlite-stage2-selection-store.ts (85), stage2-selection.ts (83), stage2-verdict.ts (277), trade-derivation.ts (94), trial-execution.ts (267) |

<details><summary>Wave 2 tests (116)</summary>

- server/apps/orchestrator/ (44 files, 22,924 lines): alert-catalogue.test.ts, alert-delivery-failure-retention.test.ts, alert-delivery-log.test.ts, alert-transport.test.ts, analysts-decision.test.ts, breach-text.test.ts, console-channels.test.ts, control-arm.test.ts, current-tick-store.test.ts, d5-trader-cap-agreement.test.ts, debate-decision.test.ts, decision-bar-gate.test.ts, fill-sync.test.ts, flatten-tail-priority.test.ts, heartbeat.test.ts, index.test.ts, live-profile.test.ts, llm-call-log-retention.test.ts, llm-capture-config.test.ts, log-level.test.ts, log-retention.test.ts, logger.test.ts, mi-archive-retention.test.ts, orphan-verdict-scan.test.ts, paper-profile-provenance.test.ts, paper-profile.test.ts, phase-split.test.ts, production-alpaca-clients.test.ts, production-startup-helpers.test.ts, production.test.ts, redact-payload.test.ts, rotating-file-sink.test.ts, saxo-composition-root.test.ts, scheduler.test.ts, smoke-run.test.ts, sqlite-audit-log.test.ts, sqlite-daily-equity-store.test.ts, startup.test.ts, subclass-deployment-cap.test.ts, tick-loop-helpers.test.ts, tick-loop.test.ts, tick-runner.test.ts, trading-window.test.ts, x-search-dial-config.test.ts
- server/apps/orchestrator/production/ (41 files, 17,292 lines): account-state.test.ts, analysts-adapter.test.ts, bar-prefetch.test.ts, capital-ceiling.test.ts, carried-lot-alert.test.ts, carried-lot-reporter-arm-wiring.test.ts, control-account-state.test.ts, daily-equity-metrics-source.test.ts, data-failover.test.ts, debate-adapter.test.ts, debate-cancellation.test.ts, direct-bind.test.ts, exit-skip-write-throttle.test.ts, filled-zero-size-wiring.test.ts, flat-by-close-to-execution.test.ts, flatten-guard-arm-wiring.test.ts, flatten-reconcile-arm-wiring.test.ts, flatten-tick-coupling.test.ts, gate-refusal-rate-guard.test.ts, gdelt-scoring-wiring.test.ts, llm-failure-rate-guard.test.ts, llm-in-flight-wiring.test.ts, lse-calendar-coverage-guard.test.ts, mi-coverage.test.ts, mi-refresh-queue.test.ts, mi-refresh-wiring.test.ts, on-trade-close-hookup.test.ts, rate-limit-wiring.test.ts, rate-limited-llm-client.test.ts, residual-and-overfill-arm-wiring.test.ts, residual-reflatten-wiring.test.ts, retention-wiring.test.ts, saxo-funding.test.ts, saxo-venue.test.ts, saxo-weekly-reminder-alert.test.ts, stocks-tick-window.test.ts, terminal-sweep-wiring.test.ts, tick-skip-alert.test.ts, trader-diagnostic-alert.test.ts, us-equity-session-source.test.ts, volatility-reading-provider.test.ts
- server/apps/service-api/ (10 files, 4,468 lines): alpaca-client.test.ts, bind-guard.test.ts, fault-guard.test.ts, fixture-store.test.ts, pipeline-query.test.ts, provider-status.test.ts, request-auth.test.ts, server.test.ts, snapshot.test.ts, sqlite-query-store.test.ts
- server/apps/supervisor/ (2 files, 359 lines): fault-guard.test.ts, supervisor.test.ts
- server/pipeline/execution/ (2 files, 5,588 lines): ingest-fills.test.ts, simulated-adapter.test.ts
- server/pipeline/trader/ (1 file, 131 lines): atr-warmup.test.ts
- server/pipeline/verdict/notifications/telegram/ (1 file, 618 lines): telegram-bot-api-client.test.ts
- server/shared/ (1 file, 56 lines): threshold-bounds-readers.test.ts
- server/tools/backtest/ (14 files, 3,831 lines): config-trial-log.test.ts, cost-model.test.ts, eval-executor.test.ts, intraday-replay.test.ts, lookahead.test.ts, metrics.test.ts, proxy-strategy.test.ts, replay-driver.test.ts, splits.test.ts, sqlite-stage2-selection-store.test.ts, stage2-selection.test.ts, stage2-verdict.test.ts, trade-derivation.test.ts, trial-execution.test.ts

</details>

### Wave 2 status (2026-10-03, PR #2043)

Done. Re-run on base 79e88af4 with refreshed roots before deleting: V2_ROOTS adds `server/apps/v2/cash-move.ts` and replaces the old saxo-login entry with `server/apps/v2/execution/saxo/saxo-login.ts` (Q9, after the MOVE); V2_SCRIPTS adds `build:migrations`, `precommit` and the five `fallow:*` scripts; the Q3 hold drops the CGT barrel that wave 1 deleted; the broker-state persistence test KEEP points at its v2 home. The wave 2 list came out identical to the one above (97 production files, 116 tests), so nothing dropped out. Waves 4 and 5 are unchanged; wave 3 gains the server/pipeline/execution barrel.

Deleted: the 97 production files, 114 of the 116 tests and alert-catalogue.golden.json, about 77,500 lines. Two execution tests stay, because deleting them left surviving wave 3 code untested and over the CRAP gates. server/pipeline/execution/ingest-fills.test.ts loses only its arm-cost-symmetry block (#1121); without it the observing-poll rearm-unsupported path of residual-protection.ts went untested and `handleRearmFailure` rose over the repo-wide CRAP 15. server/pipeline/execution/simulated-adapter.test.ts swaps the deleted cost model for a full-fill stub and drops the two cases that priced through it; without it `getOpenPositions` hit fallow health's CRAP 30. Both go in wave 3 with the files they test. The pre-steps ran as listed: live-money-gates.ts moved to `server/tools/live-money-gates.ts`, unchanged except that its dead `LIVE_MONEY_GATE_SUMMARY` was dropped (the gate list itself is untouched, and `check:live-gates` output matches base); backtest/types.ts dropped the `TickOutcome` import together with `BacktestReport`, whose only users were wave 2 files; `SAXO_COMMISSION_RATE` moved into the Saxo bracket adapter. The script, `.fallowrc.json`, `.oxlintrc.json`, launch and tsconfig edits are as listed, and `npm run smoke` is now the v2 smoke alone.

Two wave 3 files went early because fallow reported them unused once wave 2 was gone: the server/pipeline/execution barrel (§5.1) and the v1 Telegram Bot API client in server/pipeline/verdict/notifications/telegram. Exports left unused by the deletion were trimmed or removed so `fallow dead-code` stays clean, and two ExecutionStore methods that fallow misreads as unused class members (`isRetryableFlattenError`, `getUnprotectedResidualLots`, called through the interface) were added to `usedClassMembers`.

Newly dead, not deleted: server/apps/v2/execution/saxo/saxo-http-client.ts. Its only route in was the type pass-through from the old saxo-login (§7), which the MOVE re-pointed. It sits in no wave and waits on §7. The Q2 hold now also covers the moved saxo-client.ts and saxo-broker-errors.ts and the two execution type files they import.

### Wave 3: v1 pipeline

107 production files (14,848 lines) and 90 test files (37,181 lines). Trims the server/pipeline/debate-engine, server/pipeline/execution (index.ts and types.ts) and server/pipeline/momentum barrels. Removes the two wave 2 `usedClassMembers` entries in `.fallowrc.json` (`isRetryableFlattenError`, `getUnprotectedResidualLots`) once server/pipeline/execution/sqlite-shared-store.ts and its callers go. The 18 #1121 arm-cost-symmetry cases wave 2 dropped from ingest-fills.test.ts tested wave 3 code (ingest-fills.ts and the execute harness), so nothing in v2 lost coverage with them. Removes the trader, risk-manager and verdict globs from `stryker.config.mjs`, and the trader, risk-manager, verdict and momentum/loss-budget.ts entries from `TRADING_PATH_PREFIXES` in `server/tools/mutation-local.ts`, with the `server/tools/mutation-local.test.ts` cases that pin those paths. It also removes the analysts, control-arm, feedback-loop, outside-benchmark, risk-manager, trader and verdict `.oxlintrc.json` rules and rewrites the fixture string in `server/tools/check-path-citations.test.ts`. adapters/alpaca-adapter.test.ts must be rewritten in this wave (§4.6). momentum/loss-budget.ts is the copy that doc 67 Step 3 sends "with Step 5".

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
| server/tools/backtest/ | types.ts (71) |

<details><summary>Wave 3 tests (90)</summary>

- server/pipeline/analysts/ (9 files, 3,253 lines): analyst-prompt-cost.test.ts, analyst-stage-wall-clock.test.ts, fundamental-analyst.test.ts, orchestrator.test.ts, rsi-warmup.test.ts, sentiment-analyst.test.ts, technical-analyst.test.ts, technical-axes.test.ts, technical-rvol.test.ts
- server/pipeline/control-arm/ (3 files, 904 lines): arm-comparison.test.ts, axis-vote-decision.test.ts, sqlite-arm-comparison-source.test.ts
- server/pipeline/debate-engine/ (9 files, 2,967 lines): analyst-response-collector.test.ts, conviction-score.test.ts, debate-logger.test.ts, disagreement-detector.integration.test.ts, disagreement-detector.test.ts, latency-budget.test.ts, rate-limiter.test.ts, sqlite-debate-log-store.test.ts, weighted-conviction.test.ts
- server/pipeline/execution/ (12 files, 10,571 lines): closed-trade.test.ts, cumulative-feed.test.ts, execute-helpers.test.ts, execute.test.ts, filled-zero-size-throttle.test.ts, flatten-attribution.test.ts, money-math-precision.test.ts, reconcile.test.ts, residual-protection-sweep.test.ts, settlement-helpers.test.ts, sqlite-shared-store.test.ts, wedged-zero-fill-sweep.test.ts
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

</details>

### Wave 3 status (2026-10-03)

Done. Re-run on base 8d2bb1a1. The rulings on Q2 (option C: the transport moved, the bracket adapter goes) and Q3 (the v1 CGT matcher goes; #1998 ported it to v2) release both holds, so the script's `HOLD`, `HOLD_CUTS` and `HOLD_TESTS` are now empty and the run reports nothing held. Wave 3 came out at 116 production files and 97 tests against the 107 and 90 above. The Telegram Bot API client dropped out, because wave 2 already deleted it. Ten production files joined: the three server/pipeline/cgt files, the Saxo bracket adapter, its price-unit helper, its three alert-type files, the server/pipeline/execution types.ts barrel, and types/broker.ts. Seven tests joined: the three CGT tests, saxo-adapter.test.ts, saxo-per-request-pacing.test.ts, and the two execution tests wave 2 kept. Wave 5 gains book-currency.ts, store/fill-row.ts and its test. Waves 4 and 5 are otherwise unchanged.

Deleted: the 116 production files and 94 of the 97 tests, about 63,000 lines. Three tests stay, because their subjects survive to wave 4. Each drops only the cases that pinned a deleted v1 consumer:

- indicator-registry.test.ts drops three cases: the analyst's RSI and SMA specs, and the trader's ATR spec.
- mi-ingest-agent.test.ts drops its two fundamental-analyst readbacks. The store assertions beside them already cover the same refresh.
- lse-etp-pool.test.ts drops the subclass-bracket resolution.

The v2 alpaca-adapter.test.ts (§4.6) had three cases that drove the adapter through the v1 `ExecutionImpl` harness. They now drive the adapter directly:

- A filled flatten stops being polled while a working one is still polled.
- The venue's cumulative fill is followed across polls.
- An undated partial fill is dated at the sweep's observation, with no since-floor warning (#842).

The config edits are as listed, plus one more: the v2 `.oxlintrc.json` regex that kept server/pipeline/execution behind v2 execution goes, together with its fixture in `server/apps/v2/boundaries.test.ts`, because nothing is left for it to match. The v1 execution barrel pattern was the only `**/execution/**` group in the non-v2 blocks, so there it stays with its message re-pointed at v2 execution. Exports left unused were trimmed until `fallow dead-code` was clean. That also removed the shared declarations only wave 3 used, and two Saxo error classifiers that only the bracket adapter called (`isDuplicateRequestRefusal`, `isOrderNotFound`; tag v1-final keeps them). Wave 5's store/closed-trade-row.ts went early, once fallow reported it unused. The `MINIMUM_EVENT_ASSIGNMENTS` floor in `server/shared/types/log-event-code.test.ts` drops from 120 to 80, because the scan now finds 84 assignments.

v2 share matching covers what the v1 matcher's tests pinned. That covers the same-day, 30-day and section 104 rules, the window boundary, disposal ordering and the tax year. The v1 tests that went with nothing to replace them tested the v1 report layer: the annual exempt amount, the read-only store opener, and the fill source's join across closed and open lots. That report was already deleted in wave 1. The fill-source tests also pinned pence (GBX) to pounds conversion, refusal of a zero or negative FX rate, exclusion of control-arm and crypto rows, and refusal of sell lots. v2's tax log holds out any currency other than GBP or USD, so it is safe today, but once Saxo LSE fills arrive (#1916) GBX disposals stay held out until that conversion is rebuilt in v2.

Not in a wave: the moved transport, server/apps/v2/execution/saxo/saxo-client.ts, saxo-broker-errors.ts and saxo-http-client.ts. Under option C it stays for #1916 part 2. Nothing in v2 calls it yet.

### Wave 4: v1 providers

39 production files (6,851 lines) and 33 test files (8,799 lines). Trims the server/providers/market-data-service and server/providers/market-intelligence barrels and removes the universe-pool `.oxlintrc.json` rule. Removes the indicator golden fixture as well: server/providers/market-data-service/__fixtures__/ (generate-indicator-golden.py and indicator-golden.json), the "Indicator golden fixture is generated, not hand-edited" step in `.github/workflows/ci.yml`, and the ignore entries for that directory in `.fallowrc.json` and `.oxlintrc.json`. Its last reader, indicator-golden.test.ts, is in this wave. G17 deletes GDELT, Polymarket and WorldMonitor. The grok/ and archive/ files stay under G18 (§6). universe-pool's lse-etp-pool.ts is the 3× ETP universe that Q11 lists as known-dead.

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

### Wave 4 status (2026-10-03)

Done. Re-run on base a6d59095. The production list came out identical to the one above: 39 files, now 6,843 lines because wave 3 trimmed exports in some of them. The test list gains the three tests wave 3 kept and trimmed (indicator-registry.test.ts, mi-ingest-agent.test.ts and lse-etp-pool.test.ts), whose subjects go here, for 36 tests and 10,269 lines. Nothing dropped out, and nothing newly unreachable joined: outside the waves the run still finds only the moved Saxo transport (§7, wave 3 status). Q4 (doc 66) ruled that G18's keep covers the X/social code only, so the MI ingest agent, the item scorer and the Polymarket code went as listed. Doc citations: §10 counted 12 in 10 files; the re-run marked 12 in 11; the §10 file count was one short. Left as a record, since migrations are immutable: migration 0003's index on the MI archive now serves only its own test (its comment still names the deleted `rawRowsBetween`), and the `mi_refusal_streaks` table has no reader or writer left.

Deleted: the 39 production files, the 36 tests and the indicator golden fixture directory (the generator, 880 lines, and the JSON, 4,098), about 22,100 lines. The config edits are as listed:

- The market-data-service barrel loses its `Bar` and `BarWindow` re-export from types.ts. The market-intelligence barrel had no wave 4 line left.
- `.oxlintrc.json` loses the universe-pool override and the universe-pool barrel pattern in every other block, and both ignore files lose the fixture directory.
- `.github/workflows/ci.yml` loses the golden step, and with it the citations job's Python setup, which only that step used. The orchestrate-issues skill's merge gate drops the same two commands.
- `stryker.config.mjs` and `TRADING_PATH_PREFIXES` name no wave 4 path, so they and their tests are unchanged.

Exports left unused were trimmed until `fallow dead-code` was clean:

- `server/providers/calendar/trading-calendar.ts` makes `toZonedTime`, `findSessionClose`, `MAX_SESSION_SEARCH_DAYS` and `SessionSearchDirection` module-private; alpaca-session-calendar.ts was their only other user.
- The G18 archive files stay. `MiArchiveStore` loses `rawRowsBetween` (only the GDELT scoring pass read it) and the three refusal-streak methods (only the Polymarket agent), and `server/providers/news/archive/mi-sources.ts` loses `HYDRATING_MI_SOURCES` and its hydration table (only the MI ingest agent). No migration is touched, and the test that migration 0003's index serves the windowed query stays. Tag v1-final keeps the removed methods.
- Two wave 5 barrels lose re-exports whose last users went here: `server/shared/index.ts` drops `InstrumentSubclass` (also from `server/shared/types.ts` and `server/shared/types/primitives.ts`; lse-etp-pool.ts) and `LogEntryTemplate` (the GDELT and Polymarket agents). No wave 5 file is deleted.
- `server/pipeline/debate-engine/index.ts` drops five re-exports that only wave 4 files used: `DEBATE_BAR_TIMEFRAME_MS` and `floorToBar` (market-intelligence imports them from the declaring file), `BARE_JSON_INSTRUCTION` and `unwrapFencedJson` (personas.ts imports them directly), and the `LlmRequest` type. No debate-engine file moves or loses a declaration, so the §5.2 home question is untouched. <!-- cite-exempt: historical — the wave 4 state; the §5.2 rename moved this barrel to server/shared/debate/index.ts and re-exported both constants from it -->

The `MINIMUM_EVENT_ASSIGNMENTS` floor in `server/shared/types/log-event-code.test.ts` drops from 80 to 60. The scan finds 66 assignments against 86 on base, and all 20 lost ones were in deleted files: service.ts 2, gdelt-ingest-agent.ts 4, gdelt-scoring-pass.ts 2, mi-ingest-agent.ts 4, polymarket-agent.ts 6 and item-scorer.ts 2. No surviving file's count changed.

Wave 5 on this base is 18 production files (1,131 lines) and 11 tests (1,052 lines).

### Wave 5: dead shared helpers and v1 wire contracts

17 production files (1,122 lines) and 10 test files (997 lines) at the original run; the re-run on wave 3's head finds 18 production files, without store/closed-trade-row.ts (deleted early in wave 3), and wave 5 refreshes this table from its own base. Trims `server/shared/index.ts`, `server/shared/store/index.ts` and `contracts/index.ts`. contracts/snapshot.ts, metrics.ts, pipeline.ts and providers.ts are the v1 dashboard wire, and §8 confirms the client reads none of them. No migration is touched; the dead store files are row mappers and stores. nous-responses.ts, book-currency.ts and store/fill-row.ts are not here: the first is kept under G18, the other two are held (§6).

| Directory | Files (lines) |
|---|---|
| contracts/ | metrics.ts (26), pipeline.ts (83), providers.ts (34), snapshot.ts (302) |
| server/shared/ | decision-records.ts (65), median.ts (7), no-data-marker.ts (1), parse-json-column.ts (13), stdout-fault-guard.ts (54), threshold-bounds.ts (119) |
| server/shared/http/ | polygon-aggregates.ts (28) |
| server/shared/store/ | key-scheme-guard.ts (66), open-position-row.ts (101), prune-llm-call-log.ts (12), sqlite-decision-record-stores.ts (141), sqlite-llm-spend-cap-store.ts (32) |

<details><summary>Wave 5 tests (10)</summary>

- contracts/ (3 files, 95 lines): metrics.test.ts, pipeline.test.ts, snapshot.test.ts
- server/shared/ (2 files, 248 lines): stdout-fault-guard.test.ts, threshold-bounds.test.ts
- server/shared/store/ (5 files, 654 lines): key-scheme-guard.test.ts, open-position-row.test.ts, prune-llm-call-log.test.ts, sqlite-decision-record-stores.test.ts, sqlite-llm-spend-cap-store.test.ts

</details>

### Wave 5 status (2026-10-03)

Done. Re-run on base 5e37dd95. The list came out as wave 4 predicted: 18 production files (1,131 lines) and 11 tests (1,052 lines). Against the table above, store/closed-trade-row.ts is gone (wave 3 deleted it early), and book-currency.ts and store/fill-row.ts with its test joined, because doc 66's 2026-10-02 rulings 2 (Q2, option C) and 3 (Q3) released both §6 holds. Nothing dropped out and nothing newly unreachable joined. Of the 332 production files, fallow finds 34 unreachable from the v2 roots and graphify 35. The extra one is `server/shared/types/broker.ts`, a barrel hop that fallow reaches through `server/shared/types.ts`, so it stays (§9). Outside the waves the run still finds only the moved Saxo transport. The G18 keep closure is unchanged: the archive store, archive/mi-sources.ts and nous-responses.ts.

Client check (§8): client/ and e2e/ name none of the 57 exports of contracts/snapshot.ts, metrics.ts, pipeline.ts and providers.ts. The search was word-bounded on every export name, including `DASHBOARD_SNAPSHOT_FIELD_NAMES`, which was not in the barrel. The client still imports only `@contracts`, and its tests pass on the trimmed barrel.

Deleted: the 18 production files and the 11 tests, about 2,290 lines with the barrel trims. No migration is touched. The barrel and contract edits:

- `server/shared/index.ts` loses its seven wave 5 re-exports, `server/shared/store/index.ts` loses the key-scheme guard, and `contracts/index.ts` loses the four v1 wire files.
- Exports left unused were trimmed until `fallow dead-code` was clean. `server/shared/types.ts` and `server/shared/types/records.ts` stop re-exporting `ExitReason`, whose last users through them were decision-records.ts and store/fill-row.ts. `contracts/primitives.ts` drops `InstrumentSubclass` and `TradingArm`. They had no reader left (the last ones went in wave 4 and with snapshot.ts), but fallow cannot see this, because the client side of `contracts/index.ts` counts as used.
- Two test fixtures named deleted contract files only as strings: the deep-import regex cases in `contracts/boundary.test.ts` and an `isMutableProductionFile` case in `server/tools/mutation-local.test.ts`. They now name surviving contract files. They test patterns, so the change keeps every case.

No `stryker.config.mjs` glob, `TRADING_PATH_PREFIXES` entry, `.fallowrc.json` or `.oxlintrc.json` entry names a wave 5 path, so none changed, and `mutation-local --list` reports no trading-path file. Doc citations: §10 counted 6 in 3 files. The checker flagged 2, which are now marked: the `SAMURAI_LLM_CALL_LOG_MAX_ROWS` row in `README.md` and the currency section of `docs/cgt-disposal-matching.md`. Every other backticked citation of a wave 5 path was on a line that an earlier wave had already marked. The dashboard spec's note that the v1 wire types go "in Step 5's client pass" now says they went here. Migrations 0039, 0042, 0047 and 0065 still name deleted files in their comments. They are immutable, so they stay as a record.

The `MINIMUM_EVENT_ASSIGNMENTS` floor in `server/shared/types/log-event-code.test.ts` stays at 60. The scan finds 66 assignments on base and on this branch, and no wave 5 file had one.

### Teardown summary, waves 1–5

| Wave | PR | Merge | Production files | Tests | Lines removed |
|---|---|---|---:|---:|---:|
| 1. v1 command-line tools | #2039 | 79e88af4 | 38, plus the seed fixture and the CGT barrel | 27 | about 16,300 |
| 2. v1 apps and the backtest library | #2043 | 8d2bb1a1 | 97, plus 2 wave 3 files early | 114 | about 77,500 |
| 3. v1 pipeline and the CGT matcher | #2046 | a6d59095 | 116 | 94 | about 63,000 |
| 4. v1 providers | #2047 | 5e37dd95 | 39 | 36 | about 22,400 |
| 5. dead shared helpers and v1 wire contracts | this PR | | 18 | 11 | about 2,290 |

The production counts are each wave's re-run list. Lines removed is git's deletion count for each PR. It includes the barrel trims, the config edits and the non-TypeScript assets a wave named (the alert-catalogue golden file and the indicator golden fixture). The re-run on this base finds no deletion candidate left in any wave.

What remains outside the waves:

- **The moved Saxo transport.** server/apps/v2/execution/saxo/saxo-client.ts, saxo-broker-errors.ts and saxo-http-client.ts are unreachable from every v2 root by both methods. They stay for #1916 part 2 under doc 66's Q2 ruling (option C), which builds the live Saxo leg on them.
- **The G18 keeps.** The three grok/ files, archive/mi-archive-store.ts, archive/mi-sources.ts and server/shared/llm/nous-responses.ts, with their tests and the archive's four migrations. They are unreachable from v2 and stay while G18's trial runs (#1753 open).
- **The §6 holds.** None is left. Q2 and Q3 released all eleven files, which went in waves 3 and 5.
- **Test support and config** (§3.5). The four test helpers and the three config files stay.
- **The §5.2 survivors.** These are 44 production files in v1-named directories that v2 reaches. The debate-engine and momentum survivors still have no ruled home. Putting them under `server/apps/v2/` breaks the v2 module boundaries in `.oxlintrc.json`, so their renames are **David's call**. The other §5.2 groups are proposals that no wave needed. server/pipeline/momentum/loss-budget.ts, which doc 67 Step 3 sent "with Step 5", went in wave 3.

Doc 67 Step 5 status: the reachability list, its review and the per-area deletion waves are done. Each wave merged as its own reviewed PR, in the order doc 66 ruled (Q7). The crypto cut came first (#2010), then the MOVE (§5.1, #2034), the #900 live-gate refresh, `BrokerAdapter` into `contracts/broker.ts` (#2038), and waves 1–5. G17's parked market-intelligence code is deleted, and the X/social code stays under G18. Step 5 is not closed. Two items are left:

- The Step 0 item 8 renames of the §5.2 survivors. They wait on David's homes.
- The README. Its architecture, status and scripts sections still describe the v1 runtime, and its citations to deleted files are only marked historical. Rewriting it for v2 is outside the waves. *Rewritten for v2 in #2049.*

### 4.6 Surviving tests that need a rewrite

| Test | Rewrite by | What it imports from the list |
|---|---|---|
| adapters/alpaca-adapter.test.ts (moves with the broker code, §5.1) | wave 3 | `CostModel` (tools/backtest/types.ts, wave 3); `ExecutionImpl` and its harness (execute.ts, sqlite-store-harness.ts, filled-zero-size-throttle.ts, unrecorded-venue-position-throttle.ts, types/execution.ts, wave 3); the verdict barrel and types (wave 3); `MarketDataService` (market-data-service/types.ts, wave 4) |
| adapters/saxo-adapter.test.ts (held with Q2) | wave 2, only if Q2 keeps the adapter | `SAXO_COMMISSION_RATE` (cost-model.ts, wave 2); `CostModel` and the execute harness (wave 3); `LSE_ETP_POOL` (universe-pool, wave 4); `MarketDataService` (wave 4) |

Holding cost-model.ts, the 1,393-line lse-etp-pool.ts and the v1 execute harness only so that a held test keeps compiling would hold most of v1 (§3.3). The rewrite keeps the test and lets the waves proceed.

## 5. MOVE list: v1 code that v2 still needs

### 5.1 The #1946 broker code (wave 6, first)

All 22 files are reachable from the v2 roots: 21 by both methods, and types/broker.ts by fallow only (§9). The paths in are `server/apps/v2/execution/{index,alpaca,saxo-session,create-executor,broker-books,sim-cfd-stop-drill-cli,saxo-token-secrets}.ts`, `server/tools/saxo-keepalive.ts` and server/tools/saxo-login.ts. That is 12 import lines across 9 files, plus:

- the `vi.mock` paths in `server/apps/v2/index.test.ts`, `server/apps/v2/egress.test.ts` and `server/apps/v2/execution/saxo-token-secrets.test.ts`;
- a fixture in `server/apps/v2/boundaries.test.ts`.

The target locations below are **proposals for David to confirm**; the ruling says "a v2-visible place" and does not name one.

| Group | Files (lines), all under server/pipeline/execution/ | Proposed concrete target | Interface into `contracts/` |
|---|---|---|---|
| Alpaca adapter and client | adapters/alpaca-adapter.ts (1,001), adapters/alpaca-http-client.ts (455), adapters/alpaca-broker-errors.ts (94), adapters/alpaca-order-normalization.ts (100), adapters/us-equity-price-tick.ts (119), adapters/alpaca-crypto-emulation.ts (606), broker-error.ts (86), protective-rearm-unsupported.ts (15) | server/apps/v2/execution/alpaca/ | AlpacaBrokerClient and its wire types (adapters/alpaca-client.ts, 105) |
| Broker state store | broker-state-store.ts (178, InMemoryBrokerStateStore), sqlite-broker-state-store.ts (267) | server/apps/v2/execution/broker-state/ | the BrokerStateStore interface |
| Saxo token, OAuth, keep-alive | adapters/saxo-environment.ts (13), adapters/saxo-oauth.ts (160), adapters/saxo-token-file.ts (133), adapters/saxo-token-lock.ts (41), adapters/saxo-token-source.ts (434), adapters/saxo-keepalive-state.ts (50), adapters/venue-errors.ts (27) | server/apps/v2/execution/saxo/ | SaxoTokenSource, SaxoSessionState |
| Alert-channel types | oco-double-fill-alert.ts (11), unpriced-fill-alert.ts (15), and SaxoSessionLostAlertChannel in adapters/saxo-token-source.ts | stays with its producer | OcoDoubleFillAlertChannel, UnpricedFillAlertChannel, SaxoSessionLostAlertChannel |
| Type barrels | types.ts (58) and types/broker.ts (9), which re-export the server/shared/types/broker.ts types (#1945); index.ts (118) | deleted once importers point at the new homes | `BrokerAdapter` and its order types could move from `server/shared` to `contracts/` in the same wave (**David's call**; ruled 2026-10-02 and 2026-10-03, see the note below the table) |

That is 22 files and 3,977 lines before the barrels. Notes for the build:

- `contracts/` must keep importing nothing from `server/` (`contracts/boundary.test.ts`).
- **Mutation gating has to move with the files, in the same PR.** `TRADING_PATH_PREFIXES` in `server/tools/mutation-local.ts` lists server/pipeline/execution/ and server/pipeline/momentum/sizing.ts. A moved Alpaca adapter or a moved sizing.ts matches no prefix, so CI would report later changes to it as "changed but not mutated" without failing. The MOVE PR adds the new paths to the prefixes, updates the `server/tools/mutation-local.test.ts` cases that pin the old ones, and moves the `stryker.config.mjs` globs for server/pipeline/execution and server/pipeline/momentum.
- `server/apps/v2/boundaries.test.ts` has an `imports-v1-broker` fixture that must point at the new path.
- `BrokerAdapter`'s home: ruled 2026-10-03 (doc 66, broker contracts ruling 1): it moves to `contracts/` with ISO 8601 strings in place of `Date` (`fetchNewFills(since: string)`, `NormalizedFill.timestamp: string`), and the adapters convert at the edge. It shipped as its own PR after the MOVE, #2038 (`a526ef2b`), in `contracts/broker.ts`.
- The MOVE landed on 2026-10-03: #2032 split the broker functions whose complexity blocked the move, and #2034 moved the Alpaca, broker-state and Saxo groups above into `server/apps/v2/execution/alpaca/`, `server/apps/v2/execution/broker-state/` and `server/apps/v2/execution/saxo/`.
- adapters/alpaca-crypto-emulation.ts (606 lines) is live only because AlpacaBrokerAdapter calls it, and Q11 lists crypto remnants as known-dead. Cutting it out changes the live Alpaca adapter, which is broker code, so whether that happens in the MOVE PR or in its own PR is **David's call**.
  - Ruled 2026-10-02 (doc 66, items 6–7): its own PR, before the MOVE. The #1748 cut deleted it with its test, oco-double-fill-alert.ts (the emulation was its only producer), the Alpaca client's limit and stop-limit placements (only the emulation sent them), the crypto symbol mapping and the v1 smoke's crypto-emulation probe. The adapter now refuses any bracket that is not stocks. The Alpaca group above moves without those files.
- adapters/alpaca-adapter.test.ts needs the wave 3 rewrite in §4.6 whichever wave order is chosen.

### 5.2 Other survivors in v1-named directories (rename, Step 0 item 8)

These 44 production files are reachable by both methods and live outside `server/apps/v2/`. The renames were **proposals**: Step 0 item 8 asks for v2 vocabulary but rules no names, and putting the momentum and debate-engine survivors under `server/apps/v2/` would break the v2 module boundaries in `.oxlintrc.json`. David ruled the homes on 2026-10-03 (doc 66, §5.2 homes rulings): momentum to `server/shared/market/` and the debate engine to `server/shared/debate/`, both under `server/shared/`, and the other rows as proposed below.

| Today | Files (lines) | What v2 uses it for | Proposed home |
|---|---|---|---|
| server/pipeline/debate-engine/ (survivors) | 17 (1,830): llm/anthropic-client, llm/nous-messages-client, llm/spend-cap, llm/spend-sink, llm/errors, llm/failure-cause, llm/json-response, llm/prompt-safety, llm/prompt-tier-alert, llm/types, personas, round-orchestrator, debate-id, analyst-contribution, debate-log-store, types, index | the debate panel's LLM clients, spend cap and sink, the three personas and the round loop | server/apps/v2/signal/debate/ and an llm/ module |
| server/pipeline/momentum/ (survivors) | 6 (321): bars, costs, signal, sizing, stop, index | marks, simulated costs and the candidate sleeves | server/apps/v2/signal/rules/ or risk/; sizing.ts must stay under a trading-path prefix (§5.1) |
| server/tools/backtest/ (survivors) | 7 (628): index, overfitting, combinatorics, universe, validation-types, momentum/folds, momentum/stats | DSR/PBO evidence and backtest verdicts | server/apps/v2/evidence/ |
| server/providers/bar-store/ | 5 (807) | the Parquet bar store and Alpaca pulls | stays a provider (name is not v1-specific) |
| server/providers/saxo-bars/ | 3 (471) | the Saxo chart and CFD catalogue reads | stays a provider |
| server/providers/market-data-service/ (survivors) | 2 (546): index, trading-calendar | venue sessions and holidays | server/providers/calendar/ |
| server/providers/market-intelligence/ (survivors) | 3 (494): index, sources/alpaca-news-client, types | US headlines for the debate | server/providers/news/ |
| server/apps/orchestrator/live-money-gates.ts | 1 (25) | read by `npm run check:live-gates` | server/tools/ next to its checker. This one moves **in wave 2**, before its directory goes, with its content unchanged. |

`server/shared/` (37 reachable files), `contracts/` and the repo gate tools already carry neutral names and stay where they are.

### 5.2 status (2026-10-03, #2061)

Moved in #2061 with `git mv`, file contents unchanged except import paths, plus the debate barrel re-exporting `DEBATE_BAR_TIMEFRAME_MS` and `floorToBar`. The CRAP-gate splits these files needed landed first in #2062 on the old paths (doc 66, §5.2 homes ruling 4), so #2061 is a pure move:

| From | To | Files |
|---|---|---|
| server/pipeline/momentum/ | `server/shared/market/` | 11 (6 production, 5 tests) |
| server/pipeline/debate-engine/ | `server/shared/debate/` | 37 (17 survivors, the `MockLlmClient` test double, 19 tests) |
| server/tools/backtest/ | `server/apps/v2/evidence/` | 11 (7 production, 4 tests) |
| server/providers/market-data-service/ | `server/providers/calendar/` | 4 (2 production, 2 tests) |
| server/providers/market-intelligence/ | `server/providers/news/` | 20 (8 production with the G18 grok and archive files, 8 tests, the 4 archive migrations) |

- server/pipeline/, server/tools/backtest/ and the two old provider directories are gone. `bar-store` and `saxo-bars` stay.
- The momentum helpers are re-exported from `server/shared/index.ts`, so every importer reaches them through the shared barrel; the oxlint `**/shared/**` pattern already refuses a deep import.
- `.oxlintrc.json`: each moved directory's barrel pattern is renamed in every override (`**/shared/debate/**`, `**/calendar/**`, `**/news/**`; `**/evidence/**` inside `server/apps/v2/` and `**/v2/evidence/**` elsewhere, because `client/src/components/evidence/` would match the bare name). The old server/tools/backtest override is dropped: `server/apps/v2/**` now covers the evidence files with a superset of its patterns. Inside `server/shared/`, where the moved modules reach each other by short relative paths that the `**/shared/…/**` patterns never see, the `server/shared/**`, `llm`, `store` and `debate` overrides also carry folder-name patterns (`**/llm/**`, `**/debate/**`, `**/market/**`, each module leaving out its own name, and the debate override exempting its own `./llm/` folder), so a deep import between them fails as it did on the old paths. Market and debate also refuse a deep import of a `server/shared` root file (`../*.js` from `market/` and debate's root, `../../*.js` from `debate/llm/`, the root barrel excepted), which `**/shared/**` refused from their old paths; debate's root level has its own override because `debate/llm/types.ts` imports debate's own `../types.js`. The news barrel's own override gains the debate pattern, and it now imports `DEBATE_BAR_TIMEFRAME_MS` and `floorToBar` through the debate barrel instead of from the declaring file.
- Mutation: the `TRADING_PATH_PREFIXES` entry and the `stryker.config.mjs` glob move to `server/shared/market/`. The evidence files leave the `server/tools/` exclusion and become advisory mutation targets under `server/apps/v2/`.
- `npm run build:migrations` copies the archive migrations from their new path; the migration files themselves are untouched.
- The CRAP gate diffs with `--no-renames`, so every moved function counts as touched. Five functions with complexity above 7 (`runDebate`, the spend cap's refusal path, the Grok agent's archive write, and the X search and Nous sentiment clients' parsing) and two at 7 with partial coverage were split into helpers, with the same checks in the same order, in #2062 on the old paths, merged ahead of #2061 (David, 2026-10-03; the #2032 precedent). #2062 also added a test of the `x_search_items_dropped` payload.

## 6. KEEP by ruling, and held for a ruling

| Item | Files | Ruling | Status |
|---|---|---|---|
| X/social code | server/providers/market-intelligence/grok/{grok-agent, nous-sentiment-client, x-search-client}.ts (847 lines) and their four tests; plus everything they import that v2 does not reach: archive/mi-archive-store.ts and archive/mi-sources.ts (268 lines) with the archive test and its 4 SQL migrations, and server/shared/llm/nous-responses.ts (296 lines, `nousResponses` and `NousCitation`, imported by x-search-client.ts) with its test | **G18**: not deleted while its trial runs; G17's delete is amended for X/social | **KEEP** (ruled). Unreachable from v2 today; there is no v2 social input yet (#1753 open). |
| Shared-store migrations | `server/shared/store/migrations/` | kill line, doc 67 Step 5 | KEEP (live, never edited) |
| v1 ADRs and specs | already deleted | G8, G14 | nothing left to do |

**Held for a ruling.** Each file below stays until the answer that releases it. It then joins the wave its path gives (cgt files and saxo-adapter files wave 3, book-currency.ts and store/fill-row.ts wave 5), together with its tests.

| File (lines) | Released by |
|---|---|
| server/pipeline/cgt/cgt-disposal-matching.ts (360) | Q3 |
| server/pipeline/cgt/index.ts (16) | Q3 |
| server/pipeline/cgt/open-readonly-cgt-store.ts (57) | Q3 |
| server/pipeline/cgt/sqlite-cgt-fill-source.ts (167) | Q3 |
| server/pipeline/execution/adapters/saxo-adapter.ts (1200) | Q2 |
| server/pipeline/execution/adapters/saxo-price-unit.ts (11) | Q2 |
| server/pipeline/execution/dormant-legs-unresolved-alert.ts (10) | Q2 |
| server/pipeline/execution/leg-resize-unverified-alert.ts (11) | Q2 |
| server/pipeline/execution/unresolved-price-unit-alert.ts (10) | Q2 |
| server/shared/book-currency.ts (12) | Q2 and Q3 |
| server/shared/store/fill-row.ts (47) | Q3 |

- **Q3, the v1 CGT matcher (#1947, open).** The ticket says v1's matcher "holds the matching rules. Reuse them or port them; do not re-derive them." Holding it keeps server/pipeline/cgt/ and its test files, store/fill-row.ts (`FillRow`, `fromFillRow`) with its test, and book-currency.ts (`BOOK_CURRENCY`, `isPenceCurrency`). Answer "delete now and port from tag v1-final" releases them.
- **Q2, the v1 Saxo bracket adapter.** This is adapters/saxo-adapter.ts, its price-unit helper and three alert-type files, plus saxo-adapter.test.ts and saxo-per-request-pacing.test.ts. It also holds book-currency.ts (`isBookCurrency`). The adapter imports `SAXO_COMMISSION_RATE` from cost-model.ts (wave 2). If the answer keeps the adapter (option B), the constant moves next to the adapter before wave 2. Holding cost-model.ts would hold the orchestrator with it (§3.3). Options A and C release everything in this row. #1426 (open) names saxo-adapter.ts as its code.
- book-currency.ts is released only when both answers release it.

Four more items need David to say whether G18's keep covers them. Until he answers, they stay in the waves where they are listed:

- server/pipeline/analysts/sentiment-analyst.ts and intelligence-scoring.ts (wave 3). This is v1's sentiment *analyst*, where the class-wide-vote defect that G18 (3) binds against lived. It is not the X/social source code.
- server/providers/market-intelligence/mi-ingest-agent.ts and scoring/item-scorer.ts (wave 4). The X agent does not import either one. mi-ingest-agent.ts is v1's Alpaca news ingest (`MiIngestAgent`, `newsClient.fetchNews`), and G18 says of it: *"The duplicated headlines were already fixed on main by PR 965; the follow-up fix (PR 1755) was closed unmerged and v1's news feed is left as it is."*
- The Polymarket code (wave 4). G18 says Polymarket is "skipped for now", and G17 deletes it.
- G17's parked tickets stay open whichever way this goes: #688 (GDELT), #1042 (MI archive Reddit), and #1685/#1686 (X).

## 7. saxo-http-client.ts: options for David (not decided)

What the reachability shows:

- **The v2 runtime never constructs a Saxo order client.** `createBrokerAccess` (`server/apps/v2/execution/create-executor.ts`) routes `saxo`, `saxo_cfd_gbp` and `saxo_cfd_usd` to `DryRunBrokerAdapter`. v2's real Saxo HTTP traffic is `server/apps/v2/execution/saxo-sim-gateway.ts` (sim-only, the CFD stop drill) and the bars and catalogue reads in server/providers/saxo-bars.
- **fallow marks saxo-http-client.ts reachable only as a type pass-through.** server/tools/saxo-login.ts imports the `SaxoTradingEnvironment` type through the server/pipeline/execution barrel. The barrel re-exports it from saxo-http-client.ts, which re-exports it from saxo-environment.ts. graphify resolves the type straight to saxo-environment.ts and finds saxo-http-client.ts, saxo-client.ts and saxo-broker-errors.ts unreachable (§9). No line of SaxoHttpBrokerClient runs from any v2 root. Pointing that one type import at saxo-environment.ts makes all three files unreachable by both methods.
- **Size.** It is 844 production lines (saxo-http-client.ts 551, saxo-client.ts 127, saxo-broker-errors.ts 166) and 1,601 test lines. saxo-token-source.test.ts also builds a SaxoHttpBrokerClient.

Options:

| Option | What happens | #1930 (`__next` AccountKey fix) | #1868 (accountKey config) | #1426 (GTC-leg SIM probe) |
|---|---|---|---|---|
| **A. Delete**, in wave 3 together with the §6 Q2 hold, after re-pointing the type import | v2's live Saxo adapter is built fresh when the live gate needs it, with tag v1-final for reference | close unmerged | close; its wiring target (orchestrator saxo-venue.ts) is deleted in wave 2 | re-scope to v2's future adapter or close |
| **B. Move** the client with its types and errors into v2 (for example server/apps/v2/execution/saxo/) as the base of the live Saxo adapter, with saxo-adapter.ts held or moved too | carries 844 unwired lines, or about 2,100 with saxo-adapter.ts, and their tests until a v2 Saxo route exists; fallow will report them unused unless they are listed as entries; `SAXO_COMMISSION_RATE` moves (§6) | merge first, then move | re-scope to a v2 config field | runs against the moved adapter |
| **C. Move the transport only** (saxo-http-client.ts, saxo-client.ts types, saxo-broker-errors.ts, venue-errors.ts) and delete saxo-adapter.ts, whose DayOrder/IfDone bracket semantics belong to the intraday design | keeps the account scoping, pacing and pagination work (#1848, #1930) without the v1 bracket logic | merge first, then move | re-scope to v2 | close or re-scope (it probes the deleted adapter's branch) |

Not decided here. The choice also depends on whether the live Saxo leg (ETFs at Saxo, Q2) should reuse v1's client or extend `saxo-sim-gateway.ts`, which is outside this ticket.

## 8. Client pass

- The client (`client/src/`) imports only `@contracts`, and uses 38 distinct names from it. None of them comes from the v1 wire files that wave 5 deletes (contracts/snapshot.ts, metrics.ts, pipeline.ts, providers.ts). The names were checked against every export of those files.
- The client talks only to the v2 dashboard API (`server/apps/v2/api/`), which is entirely live, so no endpoint loses a field.
- The v2 API reads only the `v2_*` tables plus `llm_spend` and `llm_call_log`, which the surviving debate-engine spend sink writes. No table it reads is fed only by deleted code.
- **Fields that would go unread: none.** The v1 dashboard and its wire (service-api, contracts/snapshot.ts) were replaced in the Step 3c build (doc 66 U5), so waves 2 and 5 delete only the server side of a client that is already gone.

## 9. Where the two methods disagree

| File | fallow | graphify | Why | Effect |
|---|---|---|---|---|
| server/pipeline/execution/adapters/saxo-http-client.ts | reachable | unreachable | type pass-through for `SaxoTradingEnvironment` from saxo-login.ts (§7); graphify resolves to the declaring file, fallow stops at the re-exporting file | not on the list; §7 decides |
| server/pipeline/execution/adapters/saxo-client.ts | reachable | unreachable | only saxo-http-client.ts uses it | follows saxo-http-client.ts |
| server/pipeline/execution/adapters/saxo-broker-errors.ts | reachable | unreachable | the same | follows saxo-http-client.ts |
| server/pipeline/execution/types/broker.ts | reachable | unreachable | a 9-line re-export of the server/shared/types/broker.ts types (#1945) that fallow keeps as a hop | not on the list; goes with the §5.1 barrels |

No file is unreachable by fallow but reached by graphify. Before graphify was given the barrel-on-import-path rule (§3.2), it reported 22 more files unreachable. Nineteen were barrels that v2 imports through, such as `server/shared/index.ts`, whose re-exported symbols graphify credits to the declaring file. The other three are imported only by a barrel's own code: server/pipeline/debate-engine/debate-log-store.ts, server/providers/market-intelligence/types.ts and server/shared/types/ports.ts. All 22 are live and stay.

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

The exit code was 1. A check through the GitHub API on the same day found **#895 open and #900 closed**, so the list carries one stale entry. Refreshing it is **David's call** and outside this ticket; the waves must leave the output unchanged. The list lives in server/apps/orchestrator/live-money-gates.ts, which is live and moves in wave 2 without edits.

Deletion candidates that cite an issue: 237 of the 574 files cite 347 distinct issue numbers. These are the ones that are open today:

| Open issue | Cited by |
|---|---|
| #895 (LSE mark source, live gate) | wave 2: orchestrator/paper-profile.test.ts, orchestrator/production/defaults.ts, orchestrator/smoke-run.ts |
| #1387 (LSE holidays to 2029) | wave 2: orchestrator/production.test.ts, orchestrator/production/lse-calendar-coverage-guard.ts |
| #1400 (Step 4b Saxo SIM drill) | wave 2: orchestrator/saxo-composition-root.test.ts |
| #688 (GDELT confidence curve, G17 parked) | wave 4: providers/market-intelligence/sources/gdelt-scorer.test.ts |

The issue tickets keep their targets:

- #1387 (LSE holidays) still has v2's calendar, `server/providers/calendar/trading-calendar.ts` (moved from server/providers/market-data-service/ in §5.2).
- #1400 (Saxo SIM drill) still has v2's drill, `server/apps/v2/execution/sim-cfd-stop-drill.ts`.

The other references to note:

- **#900** is closed but still on the live-gate list. It is cited by orchestrator/paper-profile.test.ts and trader/decide.test.ts.
- **#1426** is cited only by the held saxo-adapter.test.ts (§7).
- **#1717, #1753 and #1785** are cited only by `client/src/test-wire.ts`, which is kept.

Issue citations per wave: Wave 1 cites 30, none open. Wave 2 cites 271, with #895, #1387, #1400 open. Wave 3 cites 148, none open. Wave 4 cites 39, with #688 open. Wave 5 cites 9, none open.

Doc citations each wave must fix, outside the immutable record directories: wave 1 has 19 in 9 files; wave 2 has 41 in 15 files; wave 3 has 31 in 13 files; wave 4 has 12 in 10 files; wave 5 has 6 in 3 files.

## 11. Questions for David

1. **Approve the deletion list** (§4), wave by wave or as a whole.
2. **saxo-http-client.ts**: option A, B or C (§7). This decides #1930, #1868 and #1426, and whether the Q2 hold in §6 is released.
3. **The v1 CGT matcher** (§6): hold it until #1947 ports it, or delete it and port from tag v1-final? This also decides store/fill-row.ts and, together with Q2, book-currency.ts.
4. **G18 scope** (§6): does "the X/social code" also cover the v1 sentiment analyst, the MI ingest agent and the item scorer? G18 also says "v1's news feed is left as it is", and mi-ingest-agent.ts is that feed's ingest. If the answer is yes, those files move from waves 3 and 4 to KEEP.
5. **MOVE targets and names** (§5): confirm the proposed homes, and whether `BrokerAdapter` moves from `server/shared` to `contracts/` in the same wave. *Ruled 2026-10-02 and 2026-10-03 (doc 66): §5.1's homes confirmed and built (#2034); `BrokerAdapter` to `contracts/` with ISO 8601 strings, in its own PR after the MOVE (#2038). §5.2's homes ruled 2026-10-03 (doc 66) and moved in #2061.*
6. **Alpaca crypto emulation** (§5.1): cut it from the live Alpaca adapter inside the MOVE PR, or in its own PR?
7. **Order**: waves 1 to 5 and then the MOVE wave, as proposed, or the MOVE first so v2 stops importing `pipeline/` before any deletion? The wave settling in §3.4 holds either way.
8. **Momentum backtest scripts** (wave 1, server/tools/backtest/momentum): doc 67 Step 3 already sends the momentum loss-budget copy "with Step 5". Confirm that doc 70's numbers are then reproducible only from tag v1-final.
9. **`saxo:login` as a v2 root** (§2): confirm it. If it is not a root, the only change is that the §7 pass-through disappears.
10. **Stale live gate #900** (§10): refresh the list now, or leave it for the live gate review?

## 12. Re-running

Run `python3 docs/research/77-v1-teardown-reachability.py <out-dir>` from the repo root, with `graphify` (pip `graphifyy`) on `PATH`. It takes about four minutes on 4 cores.

`reach.json` holds every list in this doc:

- the per-method counts and disagreements;
- the kept closure and the held files, with what releases each;
- the waves, line counts and test classes;
- the rewrites;
- the config references and assets;
- every reachable file outside v2.

Each wave PR re-runs the script on its own base and diffs its wave against `reach.json`:

- A file that has become reachable since 2026-10-02 drops out of the wave.
- A newly unreachable file waits for the next review rather than joining silently.

## 13. Review round 1

The review on PR #1999 raised 11 findings, all accepted and fixed here:

1. **Keep closure.** The kept and held files are now extra roots (§3.3). nous-responses.ts moved from wave 5 to G18 KEEP.
2. **Conditional holds.** Files the held code imports are held conditionally, with the answer that releases each (§6). saxo-adapter.ts reaches the orchestrator through cost-model.ts, so for Q2 the constant moves instead of the file being held. The held test's other dependencies are handled as a rewrite (§4.6), not a hold, for the same reason.
3. **alpaca-adapter.test.ts.** The rewrite is now scheduled by the earliest wave that breaks it, and its list covers `CostModel` and `MarketDataService` (§4.6). Wave settling (§3.4) moved the backtest library out of wave 1, so that earliest wave is now 3.
4. **File reads.** File reads and `new URL` paths now count as dependencies. threshold-bounds-readers.test.ts is in wave 2. A rescan found no other surviving file that reads a list file.
5. **Mutation gating.** `mutation-local.ts` and its test are in §3.6, wave 3 and §5.1.
6. **Indicator golden fixture.** The fixture, its generator, the CI step and both ignore entries are in wave 4.
7. **`.vscode/launch.json`.** It is in wave 2.
8. **Backticked paths.** The two backticked list paths are now plain text, and the generator rejects any backticked list, held or moved path.
9. **README row.** The row now names the four disagreements and sits after doc 76.
10. **G18 quote.** Q4 now quotes the G18 clause.
11. **Same tree.** The script now rebuilds graphify inside the analysis copy, so both methods read the same tree.

The fix for finding 3 exposed a larger gap that the review did not name. The wave check had compared file-level imports only, and barrels hid symbol-level breaks. Wave 1 would have deleted tools/backtest/types.ts, cost-model.ts and metrics.ts while the orchestrator (wave 2) and execute.ts (wave 3) still imported them. Settling every file to the latest wave of its importers (§3.4) moved 14 backtest library files to wave 2 and types.ts to wave 3. It also exposed the `TickOutcome` cycle, which a one-line edit cuts in wave 2.
