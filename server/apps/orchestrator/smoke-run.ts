/**
 * Offline end-to-end smoke run (ticket #350) — the pre-soak gate. See
 * [ADR-0004](../../docs/adr/0004-production-composition-root.md) §5 and
 * docs/specs/orchestrator-spec.md (story 19, "Testing Decisions" §
 * "Composition root seam").
 *
 * ## Where this sits against the spec's two done-bars
 *
 * ADR-0004 §5 and orchestrator-spec.md story 19 define two: **wiring
 * validated** (one clean automated tick end-to-end through all six stages
 * against real Alpaca paper, correctly audit-logged) and **paper trading
 * achieved** (the 14-day unattended soak, #238). The spec's Testing Decisions
 * are explicit that the first is "the manual/CI-gated E2E check, not a unit
 * test ... run once per environment, not on every commit".
 *
 * This run does **not** replace that bar and must not be read as clearing it:
 * it never touches Alpaca, so it proves nothing about credentials, venue
 * semantics or live market data. What it does is make the same six-stage
 * assertion — every stage reached, a `go` recorded, an order submitted, a fill
 * ingested — cheaply, offline, and on every commit, so the credentialed run
 * and the soak start from a process that has already been seen to transact.
 * It also satisfies the spec's determinism story ("same injected simulated
 * clock + fixed universe -> byte-identical rows across two runs") at the
 * composition-root level rather than the tick-runner level; see
 * `smoke-run.test.ts`.
 *
 * ## The exit path (#576)
 *
 * The six-stage assertion above only ever exercises ENTRY — nothing about a
 * fixed bullish fixture makes the pipeline reach an `exit` intent honestly.
 * Six merged fixes (#508/#516/#517/#525/#568/#571) live entirely in
 * `Execution`'s exit path, downstream of that intent, and this gate could
 * pass with every one of them regressed. `runExitPathScenarios` closes that
 * gap by composing `ExecutionImpl` directly (via the same production binding
 * helper the tick loop itself uses) and driving three scenarios — a full
 * exit, a partial flatten, and a two-lot flatten — against a deterministic
 * offline broker. See that function's own doc for why it does not go through
 * `startFromEnvironment`, and `evaluateSmokeGate`'s "The exit path" section
 * for what it now requires.
 *
 * ## What this is for
 *
 * Before #350 there was no way to run the pipeline **as a process** without
 * live credentials. `yarn orchestrator` needs Alpaca + Anthropic keys, spends
 * money per debate round, and depends on live market conditions to reach an
 * interesting branch — observed with dummy credentials it reaches
 * `analysts: quorum_skip` on tick 1 and goes no further, so every stage after
 * Analysts is unexercised at process level. `yarn test`'s
 * `composed tick chain (integration)` case does drive one instrument through
 * all six steps, but inside vitest with hand-built parts: it proves the stage
 * wiring, not the shipped binary's composition root, timers, shutdown path,
 * logging or store round-trip over repeated ticks.
 *
 * This module closes that gap. It starts the REAL entrypoint assembly —
 * `startFromEnvironment` -> `buildProductionOrchestrator` — over fixtures and a
 * simulated broker, runs a bounded number of ticks, reads back what the
 * pipeline actually did from the shared store, prints it, and exits non-zero
 * if the pipeline never transacted. Run it before starting the 14-day soak
 * (#238): starting that soak without ever having seen the pipeline transact
 * end to end in a real process means discovering a wiring gap on day 1, and —
 * since alerting depends on config that is easy to omit — possibly not
 * discovering it at all.
 *
 * ## No second composition root
 *
 * The one constraint that makes this evidence rather than decoration: it calls
 * `startFromEnvironment` (orchestrator/index.ts), which builds the config the
 * shipped entrypoint builds and hands it to `buildProductionOrchestrator`. A
 * smoke run that assembled its own parallel wiring would prove nothing about
 * what ships. Everything below is supplied through `ProductionConfig`'s
 * already-documented override seams (`broker`, `dataSource`, `llmClient`,
 * `accountState`, the four alert channels) — the same seams whose doc comments
 * name `SimulatedBrokerAdapter` and `FixtureDataSource` as the intended
 * bindings. Nothing here is a new branch inside the composition root.
 *
 * Two things are unavoidably constructed here rather than reached through the
 * root, both noted where they appear: a second `MarketDataServiceImpl` for the
 * simulated broker (the broker is a constructor argument to the root, so it
 * cannot be handed the root's own instance), and an `AccountStateProvider`
 * (the only in-repo implementation is Alpaca-backed).
 *
 * ## Safety posture (#293/#320/#324)
 *
 * The fake/simulated mode is explicitly named and is **not reachable by
 * omission from the real entrypoint**:
 *
 * - This is a separate module with its own entrypoint guard and its own npm
 *   script (`yarn smoke`). `orchestrator/index.ts` does not import it, and it
 *   is not on the package's export surface, so no path from
 *   `yarn orchestrator` can select fixtures or the simulated broker.
 * - `mode` is hard-coded to `'paper'`. `SAMURAI_MODE` is never read, so this
 *   process cannot be steered towards `live`.
 * - The Alpaca wire client is injected as `UnreachableAlpacaClient`, which
 *   throws on every method. There is no code path from here to a broker, a
 *   market-data feed, or an LLM provider: no `fetch` is reachable at all.
 * - Alerting is named as log-only by injecting the four log stand-ins
 *   directly, which is exactly what `SAMURAI_ALERTS=log-only` resolves to
 *   (alert-transport.ts). It is not read from the environment, so a supervised
 *   offline gate can neither page anyone nor fall back to silence by omission.
 *
 * ## Determinism
 *
 * The clock is a `SimulatedClock` frozen at `SMOKE_RUN_INSTANT`, and every
 * fixture bar, mark and quote is anchored to that same instant, so the run
 * reproduces byte for byte. The tick loop, fill poll, heartbeat and shutdown
 * still run on real `setTimeout`/`setInterval` wall-clock timers — those are
 * precisely the process-level behaviours this run exists to exercise; only
 * `Clock.now()` is frozen.
 *
 * Freezing it is also load-bearing, not just tidy. `SimulatedBrokerAdapter`
 * dates its modelled entry fill at the MARK's observation time
 * (`MarketState.timestamp`), while `ExecutionImpl` stamps `OpenPosition.opened_at`
 * with `clock.now()` at submit time, and `ingestFills()` only asks the venue
 * for fills at or after the earliest `opened_at`. Against a fixture whose mark
 * is a fixed instant and a running wall clock, every modelled fill would be
 * dated strictly before the lot that owns it and would be filtered out
 * forever — the run would submit orders and never ingest a fill. One frozen
 * instant for both collapses that gap to zero.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  type ArmComparison,
  type ArmPerformance,
  SqliteArmComparisonSource,
} from '../../pipeline/control-arm/index.js';
import type {
  AssetClass,
  LlmClient,
  LlmRequest,
  LlmResponse,
  PromptTierAlert,
  RateLimiterSnapshot,
} from '../../pipeline/debate-engine/index.js';
import {
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
  MAX_ROUNDS_BY_ASSET_CLASS,
  RateLimiter,
  SqliteLlmSpendStore,
} from '../../pipeline/debate-engine/index.js';
import type {
  AlpacaBrokerClient,
  AlpacaLimitOrderRequest,
  AlpacaOrder,
  AlpacaStopLimitOrderRequest,
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionResult,
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  ReconcileDivergence,
  ReconcileReport,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from '../../pipeline/execution/index.js';
import {
  ALERT_AFTER_CONSECUTIVE_ZERO_SIZE,
  AlpacaBrokerAdapter,
  FilledZeroSizeThrottle,
  SimulatedBrokerAdapter,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
  TERMINAL_SWEEP_AGE_MS,
} from '../../pipeline/execution/index.js';
// #1125: not re-exported through the barrel above (see ingest-fills.ts's own
// exports) — imported directly, the same way `filled-zero-size-wiring.test.ts`
// already does.
import { FILLED_WITH_ZERO_SIZE } from '../../pipeline/execution/ingest-fills.js';
import {
  assertKillThresholdsWithinBounds,
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  runArmComparisonCycle,
  runOutsideBenchmarkCycle,
  SqliteArmComparisonSampleStore,
  SqliteFeedbackCycleScheduleStore,
  SqliteOutsideBenchmarkSampleStore,
  SqliteTuningStore,
} from '../../pipeline/feedback-loop/index.js';
import type {
  BenchmarkObservation,
  BenchmarkSeriesSource,
} from '../../pipeline/outside-benchmark/index.js';
import type {
  BreakerConfig,
  RiskConfig,
  RiskDecision,
  SessionBasisByClass,
} from '../../pipeline/risk-manager/index.js';
import {
  CircuitBreakers,
  RiskManagerImpl,
  resolveRiskConfig,
} from '../../pipeline/risk-manager/index.js';
import type {
  ApprovalChannel,
  VerdictConfig,
  VerdictDecision,
} from '../../pipeline/verdict/index.js';
import { VerdictImpl } from '../../pipeline/verdict/index.js';
import type { Bar, MarketDataService } from '../../providers/market-data-service/index.js';
import {
  AlwaysOpenCalendar,
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import {
  CURATED_MACRO_MARKETS,
  GDELT_MACRO_ENTITY,
  GdeltGkgClient,
  type MarketIntelligenceStore,
  MiArchiveStore,
  POLYMARKET_ASSET_CLASS,
  PolymarketClient,
  PROJECTED_COLUMNS,
  type RawArchiveRow,
  SOURCE_GDELT,
  SOURCE_POLYMARKET,
} from '../../providers/market-intelligence/index.js';
import type {
  ContinueOnFaultEffects,
  ErrorStream as FaultGuardErrorStream,
  StdoutStream as FaultGuardStdoutStream,
  OpenPosition,
  OrderIntent,
  TradingArm,
} from '../../shared/index.js';
import {
  boundFor,
  delay,
  GUARDED_THRESHOLD_NAMES,
  isThresholdBoundViolation,
  SimulatedClock,
  TokenBucket,
} from '../../shared/index.js';
import { openSharedStore, type SharedStore as SqliteHandle } from '../../shared/store/index.js';
import type { CostConfig, CostModel } from '../../tools/backtest/index.js';
import { CostModelImpl } from '../../tools/backtest/index.js';
import {
  installDashboardContinueOnFault,
  watchDashboardStdout,
} from '../service-api/fault-guard.js';
import { SqliteQueryStore } from '../service-api/sqlite-query-store.js';
import {
  installSupervisorContinueOnFault,
  watchSupervisorStdout,
} from '../supervisor/fault-guard.js';
import type { AlertChannels } from './alert-transport.js';
import {
  LoggingAnalystSkipAlertChannel,
  LoggingArmDivergenceAlertChannel,
  LoggingBreachAlertChannel,
  LoggingCalendarFallbackAlertChannel,
  LoggingDataFailoverAlertChannel,
  LoggingFlattenReconcileAlertChannel,
  LoggingHeartbeatChannel,
  LoggingLlmFailureRateAlertChannel,
  LoggingLoosenNotificationChannel,
  LoggingLseCalendarCoverageAlertChannel,
  LoggingMiCoverageAlertChannel,
  LoggingOcoDoubleFillAlertChannel,
  LoggingOrphanAlertChannel,
  LoggingPromptTierAlertChannel,
  LoggingResidualExposureAlertChannel,
  LoggingUnpricedFillAlertChannel,
} from './console-channels.js';
import {
  FILL_SYNC_POLL_FAILED,
  FILL_SYNC_RECONCILE_FAILED,
  FILL_SYNC_SWEEP_FAILED,
} from './fill-sync.js';
import { installFaultHandlers, runEntrypointLogRetention, startFromEnvironment } from './index.js';
import { buildEntrypointLogger, JsonLogger, type StdoutStream } from './logger.js';
import {
  buildStartingProfileConfigs,
  LIVE_BOOK_SIZING_USD,
  paperStartingProfile,
} from './paper-profile.js';
import type { DataFailoverAlert } from './production/data-failover.js';
import { worstCaseLlmCallsForAssetClass } from './production/debate-adapter.js';
import type { AccountStateProvider } from './production/direct-bind.js';
import { buildExecutionSurface } from './production/direct-bind.js';
import {
  buildProductionComponents,
  buildProductionOrchestrator,
  SMOKE_TEST_UNIVERSE,
} from './production.js';
import type { LogEntry, Logger } from './types.js';

/** Baseline buckets the seed below fills, and records in each. */
const SMOKE_GDELT_SEED_BUCKETS = 24;
const SMOKE_GDELT_SEED_PER_BUCKET = 2;
/** Records the seed puts in the signal hour — above `MIN_SIGNAL_RECORDS`. */
const SMOKE_GDELT_SEED_SIGNAL_ROWS = 5;
const SMOKE_GDELT_SEEDED_ROWS =
  SMOKE_GDELT_SEED_BUCKETS * SMOKE_GDELT_SEED_PER_BUCKET + SMOKE_GDELT_SEED_SIGNAL_ROWS;

/**
 * Puts 25 hours of GDELT history in the archive before the run starts.
 *
 * Without it this gate could only ever observe the scoring pass REFUSING: a
 * smoke run holds one canned batch at one instant, and the pass leads the
 * signal by a full 24h baseline by design (`gdelt-scoring-pass.ts`). A gate
 * that asserted the refusal would pass just as happily for a pass that is
 * built and never called, which is the defect the archive-half-with-no-reader
 * state WAS.
 *
 * These rows are written directly rather than served through
 * `smokeGdeltClient`, and that is not a shortcut around the decode path: the
 * client serves ONE batch (GDELT publishes one file per 15 minutes and the
 * fetcher's cursor takes the latest), so 25 hours of history cannot be
 * fetched inside one run at all. The decode path stays covered by the canned
 * batch; this covers the derivation over an archive that has run for a day.
 *
 * A MACRO theme, which is on every leg's watchlist, so whatever classes
 * `SMOKE_TEST_UNIVERSE` carries derive — one today, crypto, per
 * `SMOKE_GDELT_EXPECTED_AGGREGATES`, which states what that leaves uncovered.
 * The tones are flat across the baseline and one point higher in the signal
 * hour, so the derived aggregate is a modest positive with a deterministic
 * confidence rather than an extreme that would dominate whatever else reaches
 * `fundamental`.
 */
function seedSmokeGdeltBaseline(archive: MiArchiveStore): void {
  const bar = floorToBar(SMOKE_RUN_INSTANT, DEBATE_BAR_TIMEFRAME_MS);
  const hourMs = 60 * 60 * 1000;
  const line = (tone: number): string => {
    const columns = new Array<string>(27).fill('');
    columns[0] = 'smoke-seed';
    columns[1] = '20260804120000';
    columns[3] = 'smoke.seed';
    columns[4] = 'https://smoke.test/seed';
    columns[7] = 'ECON_INTEREST_RATES';
    columns[15] = `${tone},2.0,0.5,2.5,20,0.1,400`;
    return PROJECTED_COLUMNS.map((column) => columns[column] ?? '').join('\t');
  };
  const rows: RawArchiveRow[] = [];
  const push = (at: number, tone: number, id: string): void => {
    rows.push({
      source: SOURCE_GDELT,
      native_id: `smoke-seed-${id}`,
      updated_at: new Date(at),
      payload: line(tone),
      ingested_at: new Date(at),
      fidelity: 'live',
    });
  };
  const baselineStart = bar.getTime() - (SMOKE_GDELT_SEED_BUCKETS + 1) * hourMs;
  for (let bucket = 0; bucket < SMOKE_GDELT_SEED_BUCKETS; bucket += 1) {
    for (let n = 0; n < SMOKE_GDELT_SEED_PER_BUCKET; n += 1) {
      push(baselineStart + bucket * hourMs + n * 60_000, 0, `b${bucket}-${n}`);
    }
  }
  for (let n = 0; n < SMOKE_GDELT_SEED_SIGNAL_ROWS; n += 1) {
    push(bar.getTime() - hourMs + n * 60_000, 1, `s${n}`);
  }
  archive.write(rows, []);
}

/**
 * How many rows the archive should hold: the seed above, plus the one canned
 * batch row `smokeGdeltClient`'s theme filter keeps.
 *
 * Named because the gate below and the fixture above are the same fact stated
 * twice: edit the fixture to carry three matching rows and a hardcoded number
 * in the gate turns a correct run red, or worse, keeps passing for the wrong
 * reason.
 */
export const SMOKE_GDELT_EXPECTED_ROWS = SMOKE_GDELT_SEEDED_ROWS + 1;

/**
 * The asset classes the scoring pass derives for on a smoke run, and the
 * aggregates it should therefore produce from the seeded baseline: one each.
 *
 * Derived from `SMOKE_TEST_UNIVERSE` rather than written as a literal, for
 * `SMOKE_GDELT_EXPECTED_ROWS`' reason — `production.ts` passes the pass the
 * universe's own classes, so adding an equity name to that fixture would
 * otherwise turn a correct run red. The seed carries a MACRO theme, which is
 * on both legs' watchlists (`gdelt-themes.ts`), so every leg present derives
 * one. A zero here means the pass is built and never called, which is the
 * exact defect the archive-half-with-no-reader state was.
 *
 * **What this gate does NOT cover, stated because the count reads like it
 * does:** `SMOKE_TEST_UNIVERSE` is BTC-USD alone, so only the CRYPTO leg is
 * exercised end-to-end here. Two consequences. First, the equities leg's
 * derivation is covered by `gdelt-scoring-pass.test.ts` and the composition-
 * root wiring test only. Second, the aggregate this gate observes reaches no
 * analyst that scores it: `fundamentalAnalyst.applies_to` is stocks-only and
 * no other analyst scores `MarketContext.intel` (the technical analyst only
 * quotes its count into `key_points`, #1164), so on a crypto universe the
 * item is stored and served but never voted on. The gate asserts the pass is
 * CALLED and its item reaches the store — not that an analyst consumed it.
 * Adding an equity leg to the fixture is not the fix: `SMOKE_TEST_UNIVERSE`
 * is crypto-only on purpose, because crypto bypasses `UniverseScheduler`'s
 * calendar gate and a stock leg would make the whole gate hostage to US
 * market hours.
 */
export const SMOKE_GDELT_ASSET_CLASSES: readonly AssetClass[] = [
  ...new Set(SMOKE_TEST_UNIVERSE.map((instrument) => instrument.asset_class)),
];

export const SMOKE_GDELT_EXPECTED_AGGREGATES = SMOKE_GDELT_ASSET_CLASSES.length;

/**
 * A GDELT client serving one canned batch, over a real deflate zip.
 *
 * Built rather than mocked so the gate exercises the WHOLE decode path — zip
 * header, inflate, TSV split, theme filter, tone parse — offline. A hand-rolled
 * fake returning parsed records would leave exactly the parsing this module is
 * mostly made of untested in the one gate that runs the real composition root.
 *
 * Two rows: one carrying a watched theme, one not, so the run's archived count
 * is 1 and a filter that has stopped filtering shows up as 2.
 *
 * The `lastupdate.txt` fixture is GDELT's real three-line shape (export /
 * mentions / gkg, each `size md5 url`), not the one-line stub this used to be
 * (#713 item 4): `GdeltGkgClient.latestBatchUrl` selects the gkg entry by
 * `.gkg.csv.zip` suffix out of three lines, per the client's own unit tests,
 * and a one-line manifest here would still pass smoke if the client
 * regressed to "parse line N". This does not cover every such regression —
 * "parse the LAST line" would still happen to select the right entry, since
 * gkg is listed last both here and in the real manifest — the reordered case
 * is covered by `gdelt-gkg-client.test.ts`'s "selects the gkg file by
 * suffix, not by line position", not by smoke.
 */
function smokeGdeltClient(): GdeltGkgClient {
  // Fifteen minutes before `SMOKE_RUN_INSTANT`, which is what a live poll
  // sees. It has to be NEWER than `seedSmokeGdeltBaseline`'s rows or the
  // fetcher's cursor (`latestUpdatedAt`) skips the download as already held,
  // and the whole decode path — zip, inflate, TSV split, theme filter, tone
  // parse — would stop being exercised the moment the archive was seeded.
  const stamp = '20260804114500';
  const url = `http://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`;
  const lastupdate = [
    `44212 c2b1cae80b87a07106acb37a837c014d http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`,
    `61450 e86d6493d86819b56d5cc413828825df http://data.gdeltproject.org/gdeltv2/${stamp}.mentions.CSV.zip`,
    `3370784 f7c5359b15d09d7e931f8338cd6a7e60 ${url}`,
  ].join('\n');
  const row = (id: string, themes: string, tone: string): string => {
    const columns = new Array<string>(27).fill('');
    columns[0] = id;
    columns[1] = stamp;
    columns[3] = 'smoke.test';
    columns[4] = 'https://smoke.test/a';
    columns[7] = themes;
    columns[15] = tone;
    return columns.join('\t');
  };
  const csv = [
    row(`${stamp}-1`, 'ECON_STOCKMARKET;EPU_ECONOMY', '1.5,2.0,0.5,2.5,20,0.1,400'),
    row(`${stamp}-2`, 'SOC_GENERALCRIME', '-3.0,0.5,3.5,4.0,18,0.2,250'),
  ].join('\n');

  const name = Buffer.from(`${stamp}.gkg.csv`);
  const uncompressed = Buffer.from(csv);
  const deflated = deflateRawSync(uncompressed);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(uncompressed), 14);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  const archive = Buffer.concat([header, name, deflated]);

  return new GdeltGkgClient({
    fetchImpl: (async (input: string | URL) =>
      String(input).endsWith('lastupdate.txt')
        ? new Response(lastupdate)
        : new Response(archive)) as unknown as typeof fetch,
  });
}

/**
 * How many Polymarket macro items the canned wire should produce (#504).
 *
 * Named for `SMOKE_GDELT_EXPECTED_ROWS`' reason — the fixture below and the
 * gate are one fact stated twice, and a hardcoded number in the gate would
 * either turn a correct fixture change red or, worse, keep passing for the
 * wrong reason. ONE: the fixture serves a healthy market for the first curated
 * row, a thin-volume market for the second, and a rotted (empty) event for
 * every other row. So 0 means the poller never ran from the composition root,
 * and 2 means the fail-closed volume guard stopped biting.
 */
const SMOKE_POLYMARKET_EXPECTED_ITEMS = 1;

/**
 * A Polymarket client serving canned Gamma and CLOB responses.
 *
 * A REAL `PolymarketClient` behind a fake `fetchImpl`, not a hand-rolled fake
 * returning parsed objects — `smokeGdeltClient`'s header has the argument, and
 * it applies with equal force here: Gamma serialises `outcomes`,
 * `outcomePrices` and `clobTokenIds` as JSON-encoded STRINGS, and that decode
 * is most of what this client is. A fake returning ready-made objects would
 * leave it unexercised in the one gate that runs the real composition root.
 *
 * The event payloads are derived from `CURATED_MACRO_MARKETS` rather than
 * restating slugs, so the shipped table and this fixture cannot drift: a row
 * re-pointed at a new slug keeps working here without an edit.
 */
function smokePolymarketClient(): PolymarketClient {
  const [healthy, thin] = CURATED_MACRO_MARKETS;
  const marketFor = (slug: string, volume24hr: number): Record<string, unknown> => ({
    slug,
    question: 'Smoke macro market',
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.34", "0.66"]',
    clobTokenIds: '["token-yes", "token-no"]',
    bestBid: 0.65,
    bestAsk: 0.66,
    spread: 0.01,
    volume24hr,
    liquidityNum: 250_000,
    updatedAt: new Date(SMOKE_RUN_INSTANT.getTime() - 5 * 60_000).toISOString(),
    closed: false,
  });

  const eventsFor = (slug: string): unknown[] => {
    if (healthy !== undefined && slug === healthy.eventSlug) {
      return [{ slug, markets: [marketFor(healthy.marketSlug, 533_307)] }];
    }
    if (thin !== undefined && slug === thin.eventSlug) {
      // Below `MIN_VOLUME_24H_USD`, so the agent must refuse it — the negative
      // half of this probe, and the reason the expected count is 1 and not 2.
      return [{ slug, markets: [marketFor(thin.marketSlug, 5)] }];
    }
    // Every other curated row reads as rotted: Gamma answers with an empty
    // array for a slug that no longer exists, which is the shape the agent
    // logs a warn for and ingests nothing on.
    return [];
  };

  // A 24h hourly series ending at the frozen run instant, rising 0.60 -> 0.66.
  // A +0.06 delta clears the ±0.02 dead band, so the item is `sentiment: 1`
  // with `confidence` 0.30 — a real direction rather than a dead-band zero,
  // which would pass the gate while proving less.
  const history = Array.from({ length: 25 }, (_, index) => ({
    t: Math.floor((SMOKE_RUN_INSTANT.getTime() - (24 - index) * 60 * 60_000) / 1000),
    p: 0.6 + (0.06 * index) / 24,
  }));

  return new PolymarketClient({
    fetchImpl: (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/prices-history')) {
        return new Response(JSON.stringify({ history }));
      }
      const slug = new URL(url).searchParams.get('slug') ?? '';
      return new Response(JSON.stringify(eventsFor(slug)));
    }) as unknown as typeof fetch,
  });
}

/**
 * The instant the whole run is frozen at — clock, bars, mark and quote alike.
 * A fixed literal rather than `new Date()` so two runs of `yarn smoke` produce
 * identical fixtures and identical decisions.
 *
 * **2026-08-17 (#738) — this instant is NOT inside US equity regular hours**
 * (`UsEquityRegularHoursCalendar().isOpen(SMOKE_RUN_INSTANT)` is `false`;
 * measured, not assumed). That used to be irrelevant: crypto bypassed
 * `UniverseScheduler`'s calendar gate entirely, so `SMOKE_TEST_UNIVERSE`'s
 * BTC-USD ticked regardless of wall-clock time. `UniverseScheduler` is now
 * asset-class-blind — every instrument, crypto included, is gated on
 * whatever calendar `ProductionConfig.tradingCalendar` resolves to — so this
 * run injects its own `AlwaysOpenCalendar` override below rather than
 * depending on `SMOKE_RUN_INSTANT` falling inside a real session. Nothing
 * else in the offline path compares against real wall-clock time.
 *
 * The exact-hour alignment is LOAD-BEARING for the Polymarket gate (#504).
 * Items are stamped at the ingest instant (#782), and
 * `MarketIntelligenceStore.getContext()` floors its window end to the debate
 * bar, so an item stamped at 12:00:00.000 is visible while one stamped at
 * 12:00:00.001 is not until 13:00. Do not nudge this constant off the hour
 * without expecting `intel items served: 0` with a row still archived.
 */
export const SMOKE_RUN_INSTANT = new Date('2026-08-04T12:00:00.000Z');

/** The instrument the fixtures describe — `SMOKE_TEST_UNIVERSE`'s single entry. */
const SMOKE_INSTRUMENT = SMOKE_TEST_UNIVERSE[0]?.asset ?? 'BTC-USD';

/**
 * The fixture bar series, per timeframe. Each count is a floor forced by
 * something downstream, not a round number:
 *
 * - `5m` x 60 — the technical analyst's `SMA_SPEC`/`RSI_SPEC` (#742 moved the
 *   technical read from `1h` to `5m`, retaining `1h` only as context — see
 *   below). #319's minimum-length guard in `computeIndicator` rejects a
 *   window shorter than `period + 1`, so `RSI_SPEC`'s period-14 arithmetic
 *   needs 15 bars as a HARD floor; `RSI_SPEC`'s own lookback is the converged
 *   warm-up of **57** (`recommendedWarmupFor`), and 60 clears it by three —
 *   but 57 is a SOFT floor: below it the RSI silently computes over a shorter
 *   warm-up rather than throwing, so shrinking this series would degrade the
 *   analyst's read without failing anything. `WARMUP_5M` (260) asks for more
 *   than this series holds; `FixtureDataSource` returns however many exist
 *   rather than padding, and `MarketDataServiceImpl.cachedBars`'s route 1
 *   still collapses `SMA_SPEC`/`RSI_SPEC` to the one fetch this makes, since
 *   60 already clears `RSI_SPEC.lookback`.
 * - `1h` x 60 — the Trader's ATR stop (`atr_timeframe: '1h'`,
 *   `atr_lookback: 14`, unchanged by #742) and the volatility breaker's
 *   ATR(14) — `period + 1` = 15-bar HARD floor as above, but both now ask
 *   for the converged warm-up of **57** (`recommendedWarmupFor`, #757), same
 *   soft-floor shape as `RSI_SPEC`'s: 60 clears it by three, and below 57
 *   the ATR silently computes over a shorter warm-up rather than throwing.
 *   Also now the technical analyst's 1h CONTEXT read
 *   (`CONTEXT_CANDLE_LOOKBACK`, 20) — 60 clears that too.
 * - `1m` x 60 — the short-timeframe reads the Analysts take.
 * - `1d` x 40 — the widest daily consumers: `adv_window` (`{'1d', 20}`,
 *   `executionConfig.simulated`) and `correlationConfig` (`{'1d', 30}` with
 *   `min_bars: 20`). 30 would satisfy both; 40 leaves headroom.
 *
 * Short-changing any of these does not produce a loud failure — it produces a
 * stage that quietly degrades and a smoke run that skips instead of trading,
 * which is exactly what the gate below exists to catch. `smoke-run.test.ts`
 * pins these against the profile's own lookbacks so a profile change that
 * outgrows the fixtures fails a test rather than the gate.
 */
const SMOKE_BAR_SERIES: readonly { timeframe: string; count: number; stepMs: number }[] = [
  { timeframe: '5m', count: 60, stepMs: 5 * 60 * 1_000 },
  { timeframe: '1h', count: 60, stepMs: 60 * 60 * 1_000 },
  { timeframe: '1m', count: 60, stepMs: 60_000 },
  { timeframe: '1d', count: 40, stepMs: 24 * 60 * 60 * 1_000 },
];

/** The mark, and the last fixture close, the run trades against. */
const SMOKE_MARK_PRICE = 160;

/**
 * One cycle of the fixture's close-to-close moves: three down bars, then four
 * up, netting `+5` every seven bars and ending on an up bar.
 *
 * **A rising series is not enough — it has to rise with pullbacks.** The
 * technical analyst reads `bullish` only when the last close is above its
 * SMA(14) AND RSI(14) is under 70 (`technical-analyst.ts` `directionFrom`), and
 * a monotonic ramp has no down bars at all, so its RSI is exactly 100: the
 * analyst returns `neutral`, "overbought", on the strongest possible uptrend.
 * These pullbacks put RSI at **68.52** and the close above its SMA, which is
 * what the analyst actually needs.
 *
 * That was **63.16** until #722 re-pointed `RSI_SPEC` from the 15-bar
 * fabrication floor to the converged `recommendedWarmupFor` of 57, which is the
 * repricing that ticket accepted. The cycle is deliberately NOT re-tuned to
 * restore the old number: 63.16 was a warm-up artefact, and fitting the fixture
 * to reproduce it would be preserving exactly what #722 removed.
 *
 * **The margin to the overbought gate is now 1.48 points, not 6.84.** Wilder's
 * smoothing weights this pattern's recent up-bars more heavily than the plain
 * mean did, so the fixture sits closer to 70 than it used to; a future edit to
 * `SMOKE_CLOSE_CYCLE` that adds any upward bias can push it over, at which
 * point the analyst reads `neutral`/"overbought" and the gate fails with
 * nothing traded. That failure is loud, which is why the thin margin is
 * recorded rather than padded.
 *
 * Only the `5m` series feeds it (#742 moved `technical-analyst.ts`'s
 * `INDICATOR_TIMEFRAME` from `1h` to `5m`), and 60 bars clears the 57 the spec
 * asks for by three. `buildTrendingCloses` depends only on `count`/`lastClose`,
 * not `timeframe`, so the `5m` series carries the identical close values the
 * `1h` series used to (including RSI's exact 68.52/1.48-point margin above) —
 * the move did not require retuning this cycle.
 * `1d` x 40 does NOT clear it, which costs nothing today because no RSI reads
 * daily bars — but it is why the count below is a floor forced by a consumer
 * rather than a round number.
 */
const SMOKE_CLOSE_CYCLE: readonly number[] = [-2, -2, -3, 3, 3, 3, 3];

/**
 * `count` closes ending exactly at `lastClose`, walking `SMOKE_CLOSE_CYCLE`
 * backwards so the final bar is always the cycle's last up bar.
 */
export function buildTrendingCloses(count: number, lastClose: number): number[] {
  const length = SMOKE_CLOSE_CYCLE.length;
  const closes = new Array<number>(count);
  closes[count - 1] = lastClose;

  for (let step = 1; step < count; step += 1) {
    // `((x % n) + n) % n` — a bare `%` goes negative once `step` passes the
    // cycle length, which silently reads past the end of the array.
    const delta = SMOKE_CLOSE_CYCLE[(((length - step) % length) + length) % length];
    const next = closes[count - step];
    if (delta === undefined || next === undefined) {
      // Unreachable after the guarded modulo, and thrown rather than defaulted:
      // substituting a price here would quietly produce a fixture whose exact
      // closes the calendar/RSI assertions are pinned to, turning an indexing
      // bug into a wrong-but-plausible series.
      throw new Error(`buildTrendingCloses: no close or delta at step ${step} of ${count}`);
    }
    closes[count - 1 - step] = next - delta;
  }

  return closes;
}

/**
 * A rising fixture series with pullbacks, ending just under `SMOKE_MARK_PRICE`.
 *
 * The trend is deliberate and is what lets the run reach a `go` at all: the
 * Analysts have to agree directionally for `computeConvictionScore`'s
 * consensus term to clear `traderConfig.conviction_floor` (0.55 via
 * `DEFAULT_TRADER_CONFIG`), and a flat or noisy series produces a split view
 * set, a sub-floor conviction and a `trader: no_trade` short-circuit. Same
 * shape as the `composed tick chain (integration)` fixtures in
 * `production.test.ts`, re-anchored to `SMOKE_RUN_INSTANT`.
 *
 * **This series used to be a monotonic ramp**, which pinned RSI at 100 and made
 * the technical analyst read `neutral` — so the run's only directional
 * participant was the mediator, and the `go` came through the mediator-override
 * branch #625 exists to close rather than through a desk that agreed. The
 * comment claimed analyst agreement while the fixture never produced it. See
 * `SMOKE_CLOSE_CYCLE`.
 *
 * The `+/- 2` high/low band around each close gives a true range of at least 4
 * and a non-degenerate ATR, so the Trader's stop distance (`atr_k * ATR`) is a
 * real number rather than a floor artefact.
 */
export function buildSmokeFixtureBars(instrument: string = SMOKE_INSTRUMENT): Bar[] {
  return SMOKE_BAR_SERIES.flatMap(({ timeframe, count, stepMs }) => {
    const closes = buildTrendingCloses(count, SMOKE_MARK_PRICE - 1);

    return Array.from({ length: count }, (_, index) => {
      const close_time = new Date(SMOKE_RUN_INSTANT.getTime() - (count - index) * stepMs);
      const close = closes[index];
      if (close === undefined) {
        throw new Error(`buildSmokeFixtureBars: no close at index ${index} of ${count}`);
      }
      return {
        instrument,
        timeframe,
        open_time: new Date(close_time.getTime() - stepMs),
        close_time,
        open: close,
        high: close + 2,
        low: close - 2,
        close,
        volume: 1_000,
        source: 'smoke-fixture',
      };
    });
  });
}

/**
 * The deterministic stub LLM.
 *
 * Constant rather than queue-based, which is the whole difference from
 * `MockLlmClient` (debate-engine/llm/mock-client.ts): that one dequeues per
 * call and throws once exhausted, so it cannot back a run whose call count
 * depends on how many ticks reach Debate. This answers the same text forever.
 *
 * One payload serves bull, bear, mediator and `detectDisagreements` alike —
 * each call site brings its own `parseResponse`, and this shape satisfies all
 * of them (the same string the composed-chain integration test enqueues).
 * `converged: true` terminates the debate on round 1, which bounds the run's
 * work and keeps every tick's stage sequence identical.
 *
 * `stance: 'bullish'` is what makes a GO reachable: a bearish or neutral
 * mediator would produce a `sell`/no-trade branch and the gate could never
 * pass, which the issue calls out explicitly.
 */
export const SMOKE_LLM_RESPONSE = JSON.stringify({
  stance: 'bullish',
  rationale: 'offline smoke fixture: uptrend intact, structure supports a long entry',
  converged: true,
});

export class ConstantResponseLlmClient implements LlmClient {
  /** How many times the debate stage called out — reported so a run that never debated is legible. */
  calls = 0;

  constructor(private readonly rawText: string = SMOKE_LLM_RESPONSE) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls += 1;
    const parsed = request.parseResponse(this.rawText);
    if (!parsed.valid) {
      throw new Error(
        `ConstantResponseLlmClient: the fixture response does not satisfy this call site's ` +
          `parser (${parsed.reason}). The stub payload and the debate schema have drifted apart.`,
      );
    }
    return { data: parsed.data, raw_text: this.rawText, latency_ms: 0 };
  }
}

/**
 * The account scalars, fixed.
 *
 * Injected rather than composed because the only in-repo `AccountStateProvider`
 * is `AlpacaAccountStateProvider`, which reads `GET /v2/account` — a network
 * call, and therefore out of bounds here. `equity` feeds `portfolio.equity`
 * directly, and every `riskConfig` cap is a fraction resolved against that
 * figure at evaluate time (#886) rather than a boot-time anchor, so this
 * value need only be plausible, not calibrated to a specific constant.
 *
 * All four values are the "healthy account" case on purpose: a tripped circuit
 * breaker halts entries, and a smoke run that halts is indistinguishable at a
 * glance from a run that decided not to trade. Breaker behaviour has its own
 * suite; this run is testing that the pipeline transacts.
 */
export class FixedAccountStateProvider implements AccountStateProvider {
  constructor(private readonly equity: number = 100_000) {}

  async getAccountState(): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }> {
    // A flat session, stated as such: `open_equity` equals current equity and
    // nothing has realized, so every class's daily PnL computes to exactly 0.
    // Deliberately `known`, not unknown — an unknown figure arms
    // `daily_pnl_unknown` and would make a healthy smoke run look degraded.
    const flat = { known: true, open_equity: this.equity, realized_pnl: 0 } as const;

    return {
      cash: this.equity,
      peak_equity: this.equity,
      daily_basis: { crypto: flat, stocks: flat, portfolio: flat },
      consecutive_losses: 0,
    };
  }
}

/**
 * The Alpaca wire client, as a tripwire.
 *
 * `buildProductionComponents` resolves `config.alpacaBrokerClient ??
 * buildDefaultAlpacaBrokerClient(...)` eagerly, before it knows whether
 * `broker` and `accountState` were both overridden — and
 * `AlpacaHttpBrokerClient`'s constructor throws without `ALPACA_API_KEY`. So a
 * credential-free run must inject *something* here even though, with both of
 * those overridden, this object has no call sites at all.
 *
 * Given that, the honest object is one that throws rather than one that
 * pretends to answer: if a future change gives the composition root a reason
 * to call the wire client, this run fails loudly instead of silently
 * exercising a fabricated Alpaca. `smoke-run.test.ts` asserts it was never
 * touched.
 */
export class UnreachableAlpacaClient implements AlpacaBrokerClient {
  /** Set if anything ever reached this client — asserted against in tests. */
  reached = false;

  private refuse(method: string): never {
    this.reached = true;
    throw new Error(
      `UnreachableAlpacaClient.${method} was called during the offline smoke run. This run is ` +
        'credential-free and must make no network call; reaching the Alpaca wire client means ' +
        'the composition root now needs it for something the smoke run overrides. Fix the ' +
        'wiring or supply a real client deliberately — do not soften this into a stub.',
    );
  }

  async submitOrder(): Promise<never> {
    return this.refuse('submitOrder');
  }

  async getOrder(): Promise<never> {
    return this.refuse('getOrder');
  }

  async getOrderByClientOrderId(): Promise<never> {
    return this.refuse('getOrderByClientOrderId');
  }

  async getAccount(): Promise<never> {
    return this.refuse('getAccount');
  }

  async submitMarketOrder(): Promise<never> {
    return this.refuse('submitMarketOrder');
  }

  async submitOcoOrder(): Promise<never> {
    return this.refuse('submitOcoOrder');
  }

  async submitLimitOrder(): Promise<never> {
    return this.refuse('submitLimitOrder');
  }

  async submitStopLimitOrder(): Promise<never> {
    return this.refuse('submitStopLimitOrder');
  }

  async cancelOrder(): Promise<never> {
    return this.refuse('cancelOrder');
  }

  async getPositions(): Promise<never> {
    return this.refuse('getPositions');
  }
}

/**
 * The exit path (#576) — the pre-soak gate's other half.
 *
 * Everything above this point exercises ENTRY: the real six-stage tick loop,
 * through `startFromEnvironment`, on a fixture engineered to make Analysts
 * agree bullish. There is no equivalent way to make the same loop reach an
 * `exit` intent: the Trader only produces one when Debate resolves opposite
 * the held lot's side (`production.test.ts`'s `#568` wiring test drives this
 * by hand-feeding the Trader step a bearish `DebateResult` — nobody drives it
 * through Analysts and a real LLM, because nothing about this fixture's fixed
 * uptrend would ever make that resolution happen honestly). Six merged fixes
 * (#508/#516/#517/#525/#568/#571) live entirely downstream of that intent, in
 * `Execution`, and none of them needed Analysts, Debate, Trader, Risk or
 * Verdict to be exercised to be regressed or fixed.
 *
 * So this harness composes Execution directly, the same way the SIX-STAGE
 * run composes the whole pipeline: `buildExecutionSurface`
 * (production/direct-bind.ts) is the identical function
 * `buildProductionComponents` calls to bind the tick loop's own `execution`
 * step and the fill-sync loop's `ingestFills`/`reconcile` surfaces — reusing
 * it here is not a second composition root, it is calling the production
 * binding helper for the one layer these six fixes actually live in.
 * `VerdictDecision`s are hand-built (skipping Analysts/Debate/Trader/Risk/
 * Verdict, all already proven reachable by the entry-path run above) and fed
 * straight to `ExecutionImpl.execute()`/`.ingestFills()` against the SAME
 * `:memory:` store `readSmokeObservations` reads back.
 *
 * Three instruments, one per invariant, so no scenario's lots ever appear in
 * another's `heldLots` filter (`executeExit`, execute.ts, filters
 * `getOpenPositions()` by instrument alone) — sharing one would mean a
 * still-open residual from an earlier phase silently joining a later phase's
 * flatten:
 *
 * 1. `EXIT_PATH_INSTRUMENTS.fullExit` — open, exit, assert `closed` +
 *    `ClosedTrade`, assert cancel-before-flatten ORDERING (#508/#516/#517).
 * 2. `EXIT_PATH_INSTRUMENTS.partialFlatten` — a flatten that fills only
 *    partially, asserting the residual is re-armed, not left naked (#525).
 * 3. `EXIT_PATH_INSTRUMENTS.twoLot` — an older lot with a prior partial exit
 *    (itself produced the same way as scenario 2) plus a fresh second lot,
 *    flattened together, asserting NEITHER is left phantom-open (#571).
 * 4. `EXIT_PATH_INSTRUMENTS.crashRestart` — a flatten that acks but whose
 *    fill is not ingested before a "restart" (a second `buildExecutionSurface`
 *    over the SAME store + SAME broker, `reconcile.test.ts`'s own definition
 *    of one): asserts `reconcile()`'s flatten sweep finds the unresolved
 *    journal row, resolves it against the venue, and the lot still reaches
 *    `closed` afterward (#519, #526).
 * 5. `EXIT_PATH_INSTRUMENTS.residualSweep` — a partial flatten (scenario 2's
 *    technique) whose observing-poll re-arm is scripted to FAIL once, then a
 *    restart: asserts the durable residual-protection marker (migration
 *    0024) plus `reconcile()`'s #549 sweep re-arm the residual, clear the
 *    marker, and page exactly once for the episode.
 */
const EXIT_PATH_INSTRUMENTS = {
  fullExit: 'ETH-USD',
  partialFlatten: 'SOL-USD',
  twoLot: 'AVAX-USD',
  crashRestart: 'DOGE-USD',
  /** Scenario 5 (#549): the residual-protection sweep across a restart. */
  residualSweep: 'LINK-USD',
} as const;

/**
 * `CostModelImpl.fill()` (cost-model.ts) always returns
 * `filled_size: request.size` — there is no partial-fill modelling anywhere
 * in the real cost model or `SimulatedBrokerAdapter`, so a genuinely partial
 * flatten cannot be produced by the unmodified production adapter (verified
 * by reading cost-model.ts before building this — it is the reason this
 * harness exists rather than just calling `runSmoke` with a bigger fixture).
 * `ExitPathBrokerAdapter` below truncates a NAMED flatten's fill to this
 * fraction of what was requested, deterministically, entirely on this side
 * of the `BrokerAdapter` seam — `execution/` is untouched.
 */
const PARTIAL_FLATTEN_FRACTION = 0.4;
/** Scenario 3's setup fraction — see the class docs above for why it reuses this technique. */
const PRIOR_EXIT_FRACTION = 0.3;

/** Every entry lot this harness opens, before any exit. */
const EXIT_PATH_LOT_SIZE = 10;

/**
 * Records every alert `ingestFills()`'s `maybeRearmResidual` posts
 * (ingest-fills.ts), on any of its three paths — a failed store read, a
 * non-finite/non-positive residual, or the broker rejecting the re-arm
 * itself. All three mean the same thing from a smoke run's chair: the #525
 * re-arm did not happen, because `ResidualExposureAlert` (residual-exposure-
 * alert.ts) is explicitly documented as "the FALLBACK for when that re-arm
 * itself fails, never the primary mechanism ... a successful re-arm posts
 * nothing here". A healthy smoke run, against a deterministic offline
 * broker, should therefore produce zero of these, ever — see
 * `evaluateSmokeGate`'s check for the reasoning this feeds.
 */
export class RecordingResidualExposureAlertChannel implements ResidualExposureAlertChannel {
  readonly alerts: ResidualExposureAlert[] = [];

  constructor(private readonly inner?: ResidualExposureAlertChannel) {}

  async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
    this.alerts.push(alert);
    await this.inner?.postResidualExposureAlert(alert);
  }
}

/**
 * Records every flatten-reconcile alert posted (#519) — a healthy scenario 4
 * (below) resolves cleanly against the deterministic Simulated venue, so this
 * should stay empty; `evaluateSmokeGate` asserts exactly that, the same
 * shape `RecordingResidualExposureAlertChannel` above already establishes for
 * a different escalation.
 */
export class RecordingFlattenReconcileAlertChannel implements FlattenReconcileAlertChannel {
  readonly alerts: FlattenReconcileAlert[] = [];

  async postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

/**
 * The `error`-level lines `startFillSync`'s three `catch` blocks
 * (orchestrator/fill-sync.ts `runPoll`/`runOnce`) write when a pass rejects,
 * referenced from that module's exports so a rewording there cannot leave a
 * stale literal here. All three are the SAME hole: the loop logs, keeps polling, and nothing else
 * in the process reacts — so a `reconcile()`/`ingestFills()`/sweep that
 * rejects on every poll is invisible to every other check in this gate,
 * which reads effects (rows, alerts, snapshots) rather than log lines.
 */
const FILL_SYNC_FAILURE_MESSAGES = [
  FILL_SYNC_RECONCILE_FAILED,
  FILL_SYNC_POLL_FAILED,
  FILL_SYNC_SWEEP_FAILED,
] as const;

export type FillSyncFailureMessage = (typeof FILL_SYNC_FAILURE_MESSAGES)[number];

function isFillSyncFailureMessage(message: string): message is FillSyncFailureMessage {
  return (FILL_SYNC_FAILURE_MESSAGES as readonly string[]).includes(message);
}

/**
 * One rejection the fill-sync loop logged and survived (#1049). `error` is the
 * message the loop put in its payload — for `ingestFills` that is
 * `throwContainedFailures`'s summary, which names each contained scope and
 * key and never carries column content.
 */
export interface FillSyncFailure {
  message: FillSyncFailureMessage;
  error: string;
}

/** What `evaluateSmokeGate` needs from the fill-sync loop (#1049). */
export interface FillSyncFailureEvidence {
  failures: readonly FillSyncFailure[];
}

/**
 * Fill-sync rejections a healthy smoke run is ALLOWED to produce, matched by
 * substring against `FillSyncFailure.error`. Empty, and deliberately declared
 * rather than implied: the one fault the harness scripts on this path
 * (scenario 5's failed re-arm, #549) is contained inside `maybeRearmResidual`
 * and surfaces as a residual-exposure alert the gate already counts, never as
 * a poll rejection. A future scripted fault that DOES reject a poll gets
 * named here, by its identifier, rather than lifting the gate's count.
 */
export const TOLERATED_FILL_SYNC_FAILURES: readonly string[] = [];

/**
 * The rejections the gate fails on: every recorded failure whose `error`
 * contains no tolerated substring. An empty tolerated entry is IGNORED rather
 * than honoured — `'x'.includes('')` is true, so one blank line in the
 * allowlist would otherwise tolerate every failure the loop ever logs.
 */
export function untoleratedFillSyncFailures(
  failures: readonly FillSyncFailure[],
  tolerated: readonly string[] = TOLERATED_FILL_SYNC_FAILURES,
): FillSyncFailure[] {
  const allowed = tolerated.filter((entry) => entry.length > 0);
  return failures.filter((failure) => !allowed.some((entry) => failure.error.includes(entry)));
}

/**
 * Records every fill-sync rejection (#1049) on the way to the real logger, so
 * the gate can read the one channel the poll loop's failures reach.
 *
 * A wrapper scoped to `FILL_SYNC_FAILURE_MESSAGES` rather than a `Logger` the
 * gate reads back in full: the gate's other checks read effects, not log
 * lines, and this stays as narrow as the hole it closes. Never throws: a
 * recorder that could fail would take the logger it wraps down with it.
 */
export class FillSyncFailureRecorder implements Logger {
  private readonly failures: FillSyncFailure[] = [];

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.level === 'error' && isFillSyncFailureMessage(entry.message)) {
      this.failures.push({ message: entry.message, error: payloadError(entry.payload) });
    }
    this.inner.log(entry);
  }

  evidence(): FillSyncFailureEvidence {
    return { failures: [...this.failures] };
  }
}

/** What `evaluateSmokeGate` needs from the market-data fetch path (#1082). */
export interface MarketDataFetchEvidence {
  /** How many `market_data_fetch` lines the run recorded — see `MarketDataFetchRecorder`. */
  fetchCount: number;
  /**
   * The distinct `trace_id`s those lines carried. A bar fetch inside a tick
   * takes that tick's id from `shared/trace-context.ts`; `'market-data'` is
   * the fallback for a fetch with no enclosing tick. The gate joins these
   * against `audit_log`'s traces — see the check on this field.
   */
  traceIds: string[];
}

/**
 * Records every `market_data_fetch` line (#1082) on the way to the real
 * logger, so the gate can prove the telemetry mechanism actually FIRES
 * through the real composition root — not merely that `MarketDataServiceImpl`
 * was constructed with a `telemetry` argument (#430's dominant defect class:
 * built, unit-tested, never wired, every test green).
 *
 * Matched by `LogEntry.event`, unlike `FillSyncFailureRecorder` above (which
 * matches a closed, enumerated `message` set): this line's message is
 * instrument/timeframe-specific prose, so the grep-unique event code —
 * `market_data_fetch`, the convention #1115 made compulsory for every
 * `warn`/`error` line — is the one fixed field every line carries.
 *
 * Unlike #1083's `token_bucket_wait` (deliberately given NO evidence field —
 * see the comment on `evaluateSmokeGate`'s options), a cache-miss line here
 * fires for free on the FIRST bar fetch any fixture-driven run makes against
 * a cold `:memory:` store — no artificial real-time wait needed — which is
 * what makes a real (non-vacuous) assertion on this mechanism's DURABLE
 * effect achievable, unlike the wait case.
 */
export class MarketDataFetchRecorder implements Logger {
  private fetchCount = 0;
  private readonly traceIds = new Set<string>();

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.event === 'market_data_fetch') {
      this.fetchCount += 1;
      this.traceIds.add(entry.trace_id);
    }
    this.inner.log(entry);
  }

  evidence(): MarketDataFetchEvidence {
    return { fetchCount: this.fetchCount, traceIds: [...this.traceIds] };
  }
}

/** The `error` string `startFillSync` puts in its rejection payloads, or `''` if absent. */
function payloadError(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const { error } = payload as { error?: unknown };
  return typeof error === 'string' ? error : '';
}

/**
 * Decorates a real `SimulatedBrokerAdapter` for the exit-path harness (#576).
 * Adds exactly two things neither the real adapter nor a change to
 * `execution/` (out of this ticket's scope) is needed for:
 *
 * 1. **Call-sequence recording.** `executeExit` cancels every held lot
 *    BEFORE calling `submitFlatten` (#516) — an ordering property no store
 *    row observes; `flatten_submissions` and `open_positions` both look
 *    identical whether the cancel happened first or never happened at all.
 *    `callSequence` is the only way to assert the ORDERING the ticket asks
 *    for, not merely that both calls occurred.
 * 2. **A deterministic partial flatten fill.** See `PARTIAL_FLATTEN_FRACTION`
 *    above for why the real adapter cannot produce one. `truncateFlattenFill`
 *    opts a specific flatten's `clientOrderId` into a fixed-fraction fill;
 *    `fetchNewFills` rewrites that one fill's `qty`/`fee` on the way out,
 *    leaving `broker_fill_id` untouched — `ingestFills()` dedups on that id
 *    globally (ingest-fills.ts) and `redistributeFlattenFills` derives a
 *    per-lot id FROM it, so renaming it would silently break that contract
 *    in a way that would look like a #571 regression rather than what it is.
 *
 * `getOpenPositions()` is passed straight through to the delegate and is
 * DELIBERATELY not reconciled against the truncated feed above: the
 * delegate's own netting still sees its full-size internal fill, so the two
 * disagree by construction once a truncation is in effect. Nothing in this
 * harness (or the gate) reads `getOpenPositions()` — it exists on this class
 * only because `BrokerAdapter` requires it. This is a fixed-scenario smoke
 * fixture, not a general-purpose adapter; a caller with a different need
 * must not assume this method is trustworthy here.
 */
export class ExitPathBrokerAdapter implements BrokerAdapter {
  /** Every `cancel`/`submitBracket`/`submitFlatten`/`rearmProtectiveLegs` call, in call order. */
  readonly callSequence: string[] = [];
  private readonly partialFlattenFraction = new Map<string, number>();
  /** Lots whose NEXT `rearmProtectiveLegs` call throws — scenario 5's one-shot failure (#549). */
  private readonly rearmFailuresOnce = new Set<string>();

  /**
   * `delegate` is deliberately typed as the concrete `SimulatedBrokerAdapter`,
   * not the `BrokerAdapter` interface: `getProtectedQty` below is not part of
   * that interface, and this class's only caller (`runExitPathScenarios`)
   * needs it to read back scenario 2's residual. Widening this parameter to
   * `BrokerAdapter` would compile but break `getProtectedQty` silently at the
   * one call site that matters.
   */
  constructor(private readonly delegate: SimulatedBrokerAdapter) {}

  /** Opts `clientOrderId`'s flatten into a truncated fill — see the class docs. */
  truncateFlattenFill(clientOrderId: string, fraction: number): void {
    this.partialFlattenFraction.set(clientOrderId, fraction);
  }

  /**
   * Makes this lot's NEXT `rearmProtectiveLegs` call throw, once (#549,
   * scenario 5) — the deterministic stand-in for "the observing poll's
   * re-arm did not confirm", which is what forces the durable marker to be
   * the ONLY path back to protection. One-shot so the restarted process's
   * sweep retry succeeds against the same adapter.
   */
  failRearmOnce(clientOrderId: string): void {
    this.rearmFailuresOnce.add(clientOrderId);
  }

  /** Appends `action:clientOrderId` to `callSequence` — the one thing every recorded call shares. */
  private record(action: string, clientOrderId: string): void {
    this.callSequence.push(`${action}:${clientOrderId}`);
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    this.record('submitBracket', order.client_order_id);
    return this.delegate.submitBracket(order);
  }

  async getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    return this.delegate.getOrder(clientOrderId, instrument);
  }

  /** #519/#526's reconcile-driven flatten sweep — recorded like every other call for scenario 4. */
  async resumeFlatten(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    this.record('resumeFlatten', clientOrderId);
    return this.delegate.resumeFlatten(clientOrderId, instrument);
  }

  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills = await this.delegate.fetchNewFills(since);
    if (this.partialFlattenFraction.size === 0) return fills;

    return fills.map((fill) => {
      // A flatten's fill id is always `${clientOrderId}:flatten` (simulated-adapter.ts).
      const clientOrderId = fill.broker_fill_id.endsWith(':flatten')
        ? fill.broker_fill_id.slice(0, -':flatten'.length)
        : undefined;
      const fraction =
        clientOrderId === undefined ? undefined : this.partialFlattenFraction.get(clientOrderId);
      if (fraction === undefined) return fill;
      // `broker_fill_id` is left untouched — see the class docs' dedup note.
      return { ...fill, qty: fill.qty * fraction, fee: fill.fee * fraction };
    });
  }

  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    this.record('resizeProtectiveLegs', clientOrderId);
    return this.delegate.resizeProtectiveLegs(clientOrderId, filledQty);
  }

  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    this.record('rearmProtectiveLegs', clientOrderId);
    if (this.rearmFailuresOnce.delete(clientOrderId)) {
      throw new Error(
        `smoke exit-path harness: scripted one-shot re-arm failure for '${clientOrderId}' (#549 scenario 5)`,
      );
    }
    return this.delegate.rearmProtectiveLegs(clientOrderId, instrument, side, qty, stop, target);
  }

  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    this.record('submitFlatten', clientOrderId);
    return this.delegate.submitFlatten(instrument, side, size, clientOrderId);
  }

  async cancel(clientOrderId: string, instrument: string): Promise<void> {
    this.record('cancel', clientOrderId);
    return this.delegate.cancel(clientOrderId, instrument);
  }

  /** Passed straight through — see the class docs for why this is deliberately unreconciled. */
  async getOpenPositions(): ReturnType<BrokerAdapter['getOpenPositions']> {
    return this.delegate.getOpenPositions();
  }

  /** The quantity `rearmProtectiveLegs`/`resizeProtectiveLegs` last set for this lot. */
  getProtectedQty(clientOrderId: string): number | null {
    return this.delegate.getProtectedQty(clientOrderId);
  }
}

/**
 * A minimal, internally-consistent `OrderIntent` for the exit-path harness.
 * Every field the Trader would normally compute (sizing rationale, cosine
 * precedent, conviction) is a fixed placeholder — `execute()`'s exit branch
 * reads none of them, and the entry branch only reads `entry`/`stop`/
 * `target` to expand the bracket, so any internally-consistent numbers serve.
 */
function exitPathOrder(
  instrument: string,
  idempotencyKey: string,
  side: 'buy' | 'sell',
  intentType: 'entry' | 'exit',
  size: number,
  decisionTime: Date,
): OrderIntent {
  return {
    idempotency_key: idempotencyKey,
    instrument,
    asset_class: 'crypto',
    side,
    intent_type: intentType,
    size,
    entry: SMOKE_MARK_PRICE,
    stop: SMOKE_MARK_PRICE - 10,
    target: SMOKE_MARK_PRICE + 20,
    time_in_force: 'gtc',
    decision_timestamp: decisionTime,
    decided_at: decisionTime,
    metadata: {
      debate_id: `debate-${idempotencyKey}`,
      conviction: 0.7,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
      // #793: `executeExit` now refuses to write ahead without one — this
      // harness has no debate/trader run behind it, so a fixed 'flatten'
      // stands in; it exercises the exit path's mechanics (cancel-then-
      // submit, attribution, `ClosedTrade`), not which of the three reasons
      // fired.
      ...(intentType === 'exit' ? { exit_reason: 'flatten' as const } : {}),
    },
  };
}

/** An approved `RiskDecision` for `order`, shared by every harness in this file that needs one. */
function approvedRiskDecision(order: OrderIntent): RiskDecision {
  return {
    status: 'approved',
    order_intent: order,
    modifications: null,
    binding_constraint: null,
    reasons: [],
    warnings: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
    next_breaker_state: [],
  };
}

/**
 * The gate config the exit-path harness drives the REAL Verdict with (#894).
 *
 * This harness used to fabricate its own `go` (`exitPathVerdict`), which is
 * how #894 stayed invisible in the one place a flatten is driven to the
 * broker: a hand-built `go` cannot be refused by a gate, so the smoke run
 * proved the exit MECHANICS and said nothing about whether a flatten survives
 * the stage above them.
 *
 * Every dial is the paper profile's own **by construction** — spread from
 * `buildStartingProfileConfigs`, not re-typed, so a retune of the shipped
 * profile cannot leave this harness silently testing a config nothing runs.
 * There is exactly one override, and it is spelled out below.
 */
const EXIT_PATH_VERDICT_CONFIG: VerdictConfig = {
  ...buildStartingProfileConfigs().verdictConfig,
  /**
   * The ONE override. `FixtureDataSource` is constructed with a single
   * `SMOKE_RUN_INSTANT` mark, so every mark it serves carries that one fixed
   * timestamp while this harness advances its clock between phases. Mark
   * freshness is therefore a property of the fixture here, not of the code
   * under test, and `market-data-service`'s own suite owns that gate. The
   * staleness, drift, dedup, calendar and breaker gates all run exactly as
   * the paper profile ships them.
   */
  max_mark_age: { crypto: 24 * 60 * 60_000, stocks: 24 * 60 * 60_000 },
};

/**
 * The REAL `VerdictImpl` decision for `order` — what `execute()` then acts on.
 *
 * A `no_go` throws rather than being returned: every scenario here is
 * constructed to pass every gate, so a refusal is the harness having lost a
 * precondition (or a gate having changed), and the smoke run must say which
 * reason fired rather than quietly submitting nothing.
 */
async function exitPathVerdict(
  order: OrderIntent,
  deps: {
    marketData: MarketDataService;
    positionStore: SqliteExecutionStore;
    clock: SimulatedClock;
  },
  step: string,
): Promise<VerdictDecision> {
  const decision = await new VerdictImpl().decide({
    trace_id: 'smoke-exit-path',
    risk_decision: approvedRiskDecision(order),
    clock: deps.clock,
    marketData: deps.marketData,
    // Crypto instruments (`EXIT_PATH_INSTRUMENTS`), so the `market_closed`
    // gate (4) does not consult this at all; the always-open calendar is
    // what the rest of this run uses.
    tradingCalendar: new AlwaysOpenCalendar(),
    positionStore: deps.positionStore,
    breakers: {
      portfolio_tripped: false,
      asset_class_tripped: { crypto: false, stocks: false },
      armed_breakers: [],
    },
    config: EXIT_PATH_VERDICT_CONFIG,
    mode: 'paper',
    approvals: { requestApproval: async () => 'approved' as const },
  });

  if (decision.status !== 'go') {
    throw new Error(
      `smoke exit-path harness: '${step}' was refused by Verdict ` +
        `(no_go: ${decision.no_go_reason ?? 'unknown'}) — the order never reached Execution`,
    );
  }

  return decision;
}

/** Throws with the harness step named, rather than letting a silent no-op reach the gate. */
function assertSubmitted(result: ExecutionResult, step: string): void {
  if (result.status !== 'submitted') {
    throw new Error(
      `smoke exit-path harness: '${step}' did not submit (status=${result.status}, ` +
        `reason=${result.reason ?? 'none'}) — a scenario precondition is wrong, not the gate`,
    );
  }
}

/** What `evaluateSmokeGate` needs from the exit-path harness beyond the store. */
export interface ExitPathEvidence {
  /** `ExitPathBrokerAdapter.callSequence` — the #516 ordering evidence. */
  brokerCallSequence: readonly string[];
  /** Every residual-exposure alert posted anywhere during the run (harness + tick loop). */
  residualAlerts: readonly ResidualExposureAlert[];
  /**
   * Scenario 1's lot (#508/#517): named so the gate can check THIS lot
   * specifically reached `closed`, not merely that the aggregate
   * `closed_trades` count is nonzero. Scoped for the same reason the #571
   * check below is scoped to its own two lots — an aggregate-only check
   * would keep passing if scenario 1 alone regressed (e.g. a reintroduced
   * #517 misattribution on ETH-USD) as long as scenario 3 still closed its
   * two lots, since the aggregate count would stay nonzero either way.
   */
  fullExit: { lotKey: string };
  /** Scenario 2's residual (#525): what was expected vs. what the broker actually protected. */
  partialFlatten: {
    idempotencyKey: string;
    expectedResidual: number;
    protectedQty: number | null;
  };
  /** Scenario 3's two lots (#571): named here so the gate can check neither is phantom-open. */
  twoLotFlatten: { lotKeys: readonly string[] };
  /**
   * Scenario 4's crash-restart (#519, #526): the lot the gate checks reached
   * `closed`, the flatten's OWN idempotency key (`ReconcileDivergence`s key
   * off the flatten, never the lot — a flatten writes no `OpenPosition`), and
   * the `ReconcileReport` the RESTARTED `Execution` produced — what proves
   * `reconcile()`'s flatten sweep, not merely `ingestFills()`, is what
   * recovered it.
   */
  crashRestart: { lotKey: string; flattenKey: string; reconcileReport: ReconcileReport };
  /** Every flatten-reconcile alert posted anywhere during the run — a healthy scenario 4 posts none. */
  flattenReconcileAlerts: readonly FlattenReconcileAlert[];
  /**
   * Scenario 5 (#549): a partial flatten whose OBSERVING-POLL re-arm failed
   * (scripted, one-shot), so the durable marker (migration 0024) + the
   * restarted `reconcile()`'s residual-protection sweep are the ONLY path
   * back to protection. The gate checks the sweep re-armed the residual
   * (`protectedQty`), settled the marker (`markerCleared`), reported it
   * (`sweepDivergenceAction: 'adopted'`, `sweepDivergenceReason` naming the
   * #549 sweep specifically), and paged exactly once for the whole episode —
   * the observing poll's inline alert, never a second from the sweep (#342).
   */
  residualSweep: {
    lotKey: string;
    expectedResidual: number;
    protectedQty: number | null;
    /** `open_positions.residual_unprotected_since IS NULL` after the restarted sweep. */
    markerCleared: boolean;
    /** The restarted reconcile()'s divergence for the LOT's own key, if any. */
    sweepDivergenceAction: ReconcileDivergence['action'] | undefined;
    /**
     * The SAME divergence's own `reason` text (#1285 B2) — read off the SAME
     * lookup as `sweepDivergenceAction` (`findSweepDivergence`, below), never
     * a second `.find()` over `lotKey`. A second, independent lookup would
     * let a wrong-key mutation at one call site alone still satisfy this
     * check with the OTHER call site's correct key — see `findSweepDivergence`'s
     * doc for the measured case (scenario 4's flatten divergence is also
     * `action: 'adopted'`, so `sweepDivergenceAction` alone cannot tell a
     * wrong-key substitution from the real thing; only `sweepOne`'s own
     * re-arm reason text — `'... by the #549 sweep'`, residual-protection-
     * sweep.ts — can).
     */
    sweepDivergenceReason: string | undefined;
  };
  /**
   * #1088: a `rejected`, `filled_size = 0` row seeded with a `decision_timestamp`
   * already past `TERMINAL_SWEEP_AGE_MS` (reconcile.ts) — the durable effect
   * `sweepTerminalPositions` exists to produce. Named separately from
   * `crashRestart` above: that scenario's `ReconcileReport` proves the
   * FLATTEN sweep ran, which is a different mechanism (#519/#526) reading a
   * different table (`flatten_submissions`) than this one reads
   * (`open_positions`), so a regression in either must be caught on its own.
   */
  terminalSweep: {
    seededKey: string;
    /** `true` = the seeded row is STILL in `open_positions` after the restarted `reconcile()` — a failure. */
    rowPresentAfterSweep: boolean;
    /** The restarted reconcile()'s own `swept` count, read the same pass. */
    swept: number;
  };
}

/**
 * The #549 sweep's own divergence for ONE lot, picked out of a restarted
 * reconcile()'s full `divergences` list — every scenario's flatten/lot
 * shares that one list, so this is a lookup by key, not "the first entry" or
 * "any entry at all". Returns the whole divergence, not just its `action`
 * (#1285 B2, see below), so both fields callers need come off ONE lookup —
 * a wrong-key mutation at one call site cannot leave a second, correctly-
 * keyed lookup elsewhere still satisfying whatever check reads the field the
 * mutated call site did not touch.
 *
 * Pulled out of `runExitPathScenarios` (#1285) so it has a unit test that
 * does not also have to stand up the rest of the exit-path harness.
 * Measurement (#1228/#1285) found `.action` alone is the ENTIRE runtime
 * discriminator for scenario 5 (#549): of `ExitPathEvidence.residualSweep`'s
 * fields, an in-process heal of the deliberately-failed re-arm (an extra
 * `ingestFills()` ahead of the restart — see `PostSweepScenarioContext`
 * above) takes `maybeRearmResidual`'s mark-unprotected -> rearmProtectiveLegs
 * -> confirm-protected path (ingest-fills.ts). A genuine restart-sweep heal
 * takes a DIFFERENT path — `sweepOne` (residual-protection-sweep.ts): the
 * marker is already set (no mark-unprotected write), and a confirmed re-arm
 * clears it via `store.confirmResidualProtected` directly, never
 * `bestEffortMarkerWrite`. The two paths share no MARKER-WRITING path (#1285
 * N5, round-2 review corrects the earlier "share no code" framing here,
 * which was false: `residual-protection-sweep.ts` imports
 * `recordedExposure`/`coversQty` from `ingest-fills.ts`, so that arithmetic
 * IS shared code) — what they share is only those two exported helpers,
 * which `sweepOne` deliberately calls fresh off the persisted fill record
 * rather than trusting any cached figure, "so the two surfaces cannot
 * disagree about flatness" — which is exactly why they leave the same `markerCleared`,
 * `protectedQty`, and alert-count footprint and only THIS lookup, keyed on
 * which code path's divergence list entry it is, tells them apart. `.action`
 * returning `undefined` because the restarted reconcile() found nothing left
 * to sweep is the discriminator #1285 measured.
 *
 * `.action` alone is not sufficient, though (#1285 B2, round 1 review): a
 * wrong-key mutation at this lookup's call site can read a DIFFERENT
 * scenario's divergence whose `action` also happens to be `'adopted'` —
 * measured concretely by substituting scenario 4's `crashRestartLot.exitKey`
 * for scenario 5's `residualSweep.lotKey`: `reconcileFlatten`
 * (reconcile.ts) reports that lot's flatten as `action: 'adopted'` too, with
 * `reason: "flatten journal said '...'; broker reports '...'"`. `.action`
 * cannot tell that apart from `sweepOne`'s own `'adopted'`, but `.reason`
 * can: `sweepOne`'s re-arm branch (residual-protection-sweep.ts) reports
 * `"protective legs re-armed for residual … by the #549 sweep — ..."`, which
 * no flatten-reconcile divergence text can produce. `evaluateSmokeGate`'s
 * #549 section checks `.reason` for exactly that.
 *
 * `.find` (first match), never `.findLast`, deliberately (#1285 N2, round-2
 * review): `reconcile()` (reconcile.ts) pushes this lot's real #549-sweep
 * divergence, if any, well before it appends `findUnrecordedVenuePositions`'s
 * results — which carry `idempotency_key: ''` — LAST in the same list. An
 * empty string is a substring and a suffix of every key, so under a
 * containment-family predicate (the very mutants the `===` unit tests below
 * pin against) `.findLast` would land on that trailing `''`-keyed sentinel
 * instead of this lot's own entry. `.find` forecloses that structurally, not
 * just because today's fixture happens to produce one match: it stays the
 * first (and normally only) match even if a future scenario adds a second
 * divergence for this same key ahead of it in the list.
 */
export function findSweepDivergence(
  divergences: readonly ReconcileDivergence[],
  lotKey: string,
): ReconcileDivergence | undefined {
  return divergences.find((divergence) => divergence.idempotency_key === lotKey);
}

/**
 * Drives the exit-path scenarios documented above against `db`, using `clock`
 * (advanced deterministically between phases — see `SimulatedClock.advanceTo`)
 * and the given cost/execution config. Returns everything `evaluateSmokeGate`
 * needs that is not itself a store row.
 */
async function runExitPathScenarios(input: {
  db: SqliteHandle;
  clock: SimulatedClock;
  costConfig: CostConfig;
  executionConfig: ExecutionConfig;
  logger: Logger;
}): Promise<ExitPathEvidence> {
  const { db, clock, costConfig, executionConfig, logger } = input;

  const bars = Object.values(EXIT_PATH_INSTRUMENTS).flatMap((instrument) =>
    buildSmokeFixtureBars(instrument),
  );
  const dataSource = new FixtureDataSource(
    bars,
    { price: SMOKE_MARK_PRICE, observed_at: SMOKE_RUN_INSTANT, source: 'smoke-fixture' },
    'crypto',
    { bid: SMOKE_MARK_PRICE - 0.5, ask: SMOKE_MARK_PRICE + 0.5, observed_at: SMOKE_RUN_INSTANT },
  );
  const marketData = new MarketDataServiceImpl(
    dataSource,
    clock,
    'live',
    new SqliteMarketDataStore(db),
  );
  const costModel = new CostModelImpl(costConfig);
  const innerBroker = new SimulatedBrokerAdapter({
    clock,
    costModel,
    marketData,
    config: executionConfig.simulated,
  });
  const broker = new ExitPathBrokerAdapter(innerBroker);
  const residualAlerts = new RecordingResidualExposureAlertChannel();
  const flattenReconcileAlerts = new RecordingFlattenReconcileAlertChannel();
  const execution = buildExecutionSurface(
    {
      clock,
      broker,
      store: new SqliteExecutionStore(db),
      costModel,
      marketData,
      config: executionConfig,
      mode: 'paper',
      residualExposureAlerts: residualAlerts,
      // #527: not recorded/gated like `residualAlerts` above — no scenario
      // here is expected to over-fill a flatten, and wiring a gate check for
      // it is out of this ticket's scope (see `FlattenOverfillAlertChannel`'s
      // doc for why this channel has no phone-reaching counterpart yet
      // either).
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts,
      logger,
      // #1087: NOT recorded/gated on THIS harness's own evidence, unlike
      // `residualAlerts`/`flattenReconcileAlerts` above. `FILLED_WITH_ZERO_SIZE`
      // fires only when a broker violates the "no fill predates its own
      // lot's `opened_at`" invariant — the exact defect #1087 fixed at the
      // source — and none of the exit-path scenarios above scripts that
      // violation: they all share one `innerBroker` (`SimulatedBrokerAdapter`)
      // through this one composition root, so wedging a lot here would mean
      // reintroducing the fixed defect rather than exercising it honestly.
      // #1125 gates the mechanism instead, through its OWN dedicated broker
      // and composition root — see `runFilledZeroSizeWedgeScenario` and
      // `SmokeWedgedLotBroker` below, and `evaluateSmokeGate`'s
      // `filledZeroSizeWedge` check. Targeted regression coverage also lives
      // in simulated-adapter.test.ts and ingest-fills.test.ts, and
      // `filled-zero-size-wiring.test.ts` separately proves the throttle
      // instance is SHARED across every surface this same
      // `buildExecutionSurface` binding builds.
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    },
    'smoke-exit-path',
  );

  const tick = (): Date => {
    clock.advanceTo(new Date(clock.now().getTime() + 1_000));
    return clock.now();
  };

  const positionStore = new SqliteExecutionStore(db);

  /**
   * Drives `order` through the REAL Verdict and then Execution, asserting it
   * actually reached the broker (#894 — the `go` is decided here, not
   * fabricated).
   */
  const submit = async (order: OrderIntent, step: string): Promise<void> => {
    const verdict = await exitPathVerdict(order, { marketData, positionStore, clock }, step);
    assertSubmitted(await execution.execute(verdict), step);
  };

  const ctx: ExitPathScenarioContext = {
    db,
    clock,
    costModel,
    marketData,
    executionConfig,
    logger,
    broker,
    execution,
    positionStore,
    residualAlerts,
    flattenReconcileAlerts,
    tick,
    submit,
  };

  const fullExit = await runFullExitScenario(ctx);
  const partialFlatten = await runPartialFlattenScenario(ctx);
  const twoLotFlatten = await runTwoLotFlattenScenario(ctx);
  const crashRestartLot = await enterCrashRestartLotAheadOfResidualSweep(ctx);
  const residualSweep = await runResidualSweepScenario(ctx);
  // #549/#1228: the Simulated feed re-offers a flatten's fill on every poll,
  // so an extra `ingestFills()` before the restart would retry (and heal)
  // this failed re-arm in-process. `PostSweepScenarioContext` makes that
  // call unreachable inside the three functions below. It does not close a
  // statement added directly in THIS function between here and the restart
  // — the bare `execution` local above (not just `ctx`) is still in scope,
  // so no context type could close this route — but that route is caught by
  // the runtime #549 gate assertion below: a healed-in-process residual
  // still clears the marker and protects the right quantity on its own, so
  // only `residualSweep.sweepDivergenceAction`/`sweepDivergenceReason`
  // (`findSweepDivergence`, above) discriminate, not the compiler.
  await exitCrashRestartLotWithoutSweep(ctx, crashRestartLot.exitKey);
  const terminalSweepKey = await seedTerminalSweepRow(ctx);
  const { restarted, restartReconcile } = await restartExecutionAndReconcile(ctx);
  await restarted.ingestFills();

  // Scenario 5's evidence, read AFTER the restarted reconcile+ingest: the
  // sweep's own divergence keys on the LOT (a flatten's divergence keys on
  // the flatten's own id, so the lookup cannot collide), the venue-side
  // protection off the delegate adapter, and the marker column raw off the
  // store — the durable effect the gate exists to enforce (#430).
  const lot5MarkerRow = db
    .prepare('SELECT residual_unprotected_since FROM open_positions WHERE idempotency_key = ?')
    .get(residualSweep.lotKey) as { residual_unprotected_since: string | null } | undefined;
  const sweepDivergence = findSweepDivergence(restartReconcile.divergences, residualSweep.lotKey);

  // #1088: the seeded row's fate, read the same way — raw SQL rather than
  // `getOpenPositions()`, which would never have shown a terminal row either
  // way and so cannot distinguish "swept" from "was never open".
  const terminalSweepRow = db
    .prepare('SELECT 1 FROM open_positions WHERE idempotency_key = ?')
    .get(terminalSweepKey);

  return {
    brokerCallSequence: broker.callSequence,
    residualAlerts: residualAlerts.alerts,
    fullExit,
    partialFlatten: {
      idempotencyKey: partialFlatten.idempotencyKey,
      expectedResidual: partialFlatten.expectedResidual,
      protectedQty: broker.getProtectedQty(partialFlatten.idempotencyKey),
    },
    twoLotFlatten,
    crashRestart: {
      lotKey: crashRestartLot.lotKey,
      flattenKey: crashRestartLot.exitKey,
      reconcileReport: restartReconcile,
    },
    flattenReconcileAlerts: flattenReconcileAlerts.alerts,
    residualSweep: {
      lotKey: residualSweep.lotKey,
      expectedResidual: residualSweep.expectedResidual,
      protectedQty: broker.getProtectedQty(residualSweep.lotKey),
      markerCleared:
        lot5MarkerRow !== undefined && lot5MarkerRow.residual_unprotected_since === null,
      // ONE lookup, both fields below read off its result (#1285 B2) — see
      // `findSweepDivergence`'s doc for why a second, independently-keyed
      // lookup would not close the wrong-key hole this guards against.
      sweepDivergenceAction: sweepDivergence?.action,
      sweepDivergenceReason: sweepDivergence?.reason,
    },
    terminalSweep: {
      seededKey: terminalSweepKey,
      rowPresentAfterSweep: terminalSweepRow !== undefined,
      swept: restartReconcile.swept,
    },
  };
}

/** Everything the extracted exit-path scenarios below share and mutate in sequence. */
interface ExitPathScenarioContext {
  readonly db: SqliteHandle;
  readonly clock: SimulatedClock;
  readonly costModel: CostModelImpl;
  readonly marketData: MarketDataService;
  readonly executionConfig: ExecutionConfig;
  readonly logger: Logger;
  readonly broker: ExitPathBrokerAdapter;
  readonly execution: ReturnType<typeof buildExecutionSurface>;
  readonly positionStore: SqliteExecutionStore;
  readonly residualAlerts: RecordingResidualExposureAlertChannel;
  readonly flattenReconcileAlerts: RecordingFlattenReconcileAlertChannel;
  readonly tick: () => Date;
  readonly submit: (order: OrderIntent, step: string) => Promise<void>;
}

/**
 * `ExitPathScenarioContext` minus `execution` (#1228). Scenario 5's
 * (#549) failed re-arm depends on no further `ingestFills()` reaching the
 * pre-restart `Execution` before `restartExecutionAndReconcile` runs — the
 * Simulated feed re-offers a flatten's fill on every poll, so one more
 * ingest would retry (and heal) the re-arm in-process and the restart would
 * find nothing left to sweep. Functions that run in that window take this
 * type instead of `ExitPathScenarioContext`, so `ctx.execution` does not
 * type-check inside them — an edit that adds an `ingestFills()` call to one
 * of them, or a new scenario function slotted in beside them, fails to
 * compile rather than failing the gate later. The runtime #549 gate
 * assertion already catches the call from anywhere else in this window —
 * a healed-in-process residual still clears the marker and protects the
 * right quantity on its own, so of its checks only
 * `residualSweep.sweepDivergenceAction`/`sweepDivergenceReason` (undefined
 * when the restart's own sweep found nothing left to do — see
 * `findSweepDivergence`, above `runExitPathScenarios`, and its own test
 * coverage, #1285) actually discriminate — this type only moves that failure
 * from `yarn smoke` to `yarn typecheck` for these three functions
 * specifically.
 */
type PostSweepScenarioContext = Omit<ExitPathScenarioContext, 'execution'>;

/**
 * Scenario 1 (#508/#516/#517): open, exit in full. `evaluateSmokeGate` reads
 * the cancel-before-flatten ORDERING off `broker.callSequence` and the
 * `ClosedTrade` off `closed_trades` — nothing scenario-specific has to be
 * returned for this one beyond the lot key.
 */
async function runFullExitScenario(ctx: ExitPathScenarioContext): Promise<{ lotKey: string }> {
  const lot1 = 'smoke-exit-full-lot';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.fullExit,
      lot1,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 1 entry',
  );
  await ctx.execution.ingestFills();
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.fullExit,
      'smoke-exit-full-exit',
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 1 exit',
  );
  await ctx.execution.ingestFills();

  return { lotKey: lot1 };
}

/** Scenario 2 (#525): a flatten that fills only partially. */
async function runPartialFlattenScenario(
  ctx: ExitPathScenarioContext,
): Promise<{ idempotencyKey: string; expectedResidual: number }> {
  const lot2 = 'smoke-exit-partial-lot';
  const lot2ExitKey = 'smoke-exit-partial-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.partialFlatten,
      lot2,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 2 entry',
  );
  await ctx.execution.ingestFills();
  ctx.broker.truncateFlattenFill(lot2ExitKey, PARTIAL_FLATTEN_FRACTION);
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.partialFlatten,
      lot2ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 2 exit',
  );
  await ctx.execution.ingestFills();
  // Matches ingest-fills.ts's own `filledSize - exitQty`, not an algebraic
  // rearrangement of it — the two are not guaranteed to be the same float64
  // bit pattern (ADR-0005), only the SAME expression is.
  const exitFillQty = EXIT_PATH_LOT_SIZE * PARTIAL_FLATTEN_FRACTION;
  const expectedResidual = EXIT_PATH_LOT_SIZE - exitFillQty;

  return { idempotencyKey: lot2, expectedResidual };
}

/**
 * Scenario 3 (#571): an older lot with a prior partial exit, plus a fresh
 * sibling, flattened TOGETHER. The older lot's "prior exit" is built with the
 * same partial-fill technique as scenario 2 (a full-size exit that only
 * partially fills) — that is the only way to leave it holding less than its
 * entry size, since `executeExit` refuses any exit whose size does not
 * exactly equal what is currently held (execute.ts).
 */
async function runTwoLotFlattenScenario(
  ctx: ExitPathScenarioContext,
): Promise<{ lotKeys: readonly string[] }> {
  const lot3Older = 'smoke-exit-twolot-older';
  const lot3PriorExitKey = 'smoke-exit-twolot-older-prior-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3Older,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 3 older-lot entry',
  );
  await ctx.execution.ingestFills();
  ctx.broker.truncateFlattenFill(lot3PriorExitKey, PRIOR_EXIT_FRACTION);
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3PriorExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 3 older-lot prior exit',
  );
  await ctx.execution.ingestFills();

  const lot3Newer = 'smoke-exit-twolot-newer';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3Newer,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 3 newer-lot entry',
  );
  await ctx.execution.ingestFills();

  // Both lots' held quantity, summed: the older one already gave up
  // `PRIOR_EXIT_FRACTION` of its size (same `filledSize - exitQty` form as
  // above), the newer one is untouched.
  const olderPriorExitFillQty = EXIT_PATH_LOT_SIZE * PRIOR_EXIT_FRACTION;
  const olderHeld = EXIT_PATH_LOT_SIZE - olderPriorExitFillQty;
  const twoLotFlattenSize = olderHeld + EXIT_PATH_LOT_SIZE;
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      'smoke-exit-twolot-flatten',
      'sell',
      'exit',
      twoLotFlattenSize,
      ctx.tick(),
    ),
    'scenario 3 two-lot flatten',
  );
  await ctx.execution.ingestFills();

  return { lotKeys: [lot3Older, lot3Newer] };
}

/**
 * Scenario 4's entry (#519/#526), hoisted ahead of scenario 5: scenario 5's
 * failed re-arm must be the LAST thing any `ingestFills()` does before the
 * restart — the Simulated feed re-offers a flatten's fill every poll, so any
 * later poll would retry (and heal) the re-arm IN-PROCESS and the restart
 * would find nothing to sweep. Scenario 4's own constraint is only that no
 * ingest runs between its EXIT and the restart, so its entry fill is
 * ingested here and its exit submitted by
 * `exitCrashRestartLotWithoutSweep`, after scenario 5's observing poll.
 */
async function enterCrashRestartLotAheadOfResidualSweep(
  ctx: ExitPathScenarioContext,
): Promise<{ lotKey: string; exitKey: string }> {
  const lot4 = 'smoke-exit-restart-lot';
  const lot4ExitKey = 'smoke-exit-restart-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.crashRestart,
      lot4,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 4 entry',
  );
  await ctx.execution.ingestFills();

  return { lotKey: lot4, exitKey: lot4ExitKey };
}

/**
 * Scenario 5 (#549): a partial flatten whose observing-poll re-arm FAILS
 * (scripted, one-shot). The inline #525 alert fires once and the durable
 * marker (migration 0024) is written; nothing in the poll path ever retries.
 * The restarted `reconcile()`'s residual-protection sweep is what re-arms
 * the residual and clears the marker — evidence read after the restart, by
 * the caller.
 */
async function runResidualSweepScenario(
  ctx: ExitPathScenarioContext,
): Promise<{ lotKey: string; expectedResidual: number }> {
  const lot5 = 'smoke-exit-sweep-lot';
  const lot5ExitKey = 'smoke-exit-sweep-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.residualSweep,
      lot5,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 5 entry',
  );
  await ctx.execution.ingestFills();
  ctx.broker.truncateFlattenFill(lot5ExitKey, PARTIAL_FLATTEN_FRACTION);
  ctx.broker.failRearmOnce(lot5);
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.residualSweep,
      lot5ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 5 exit',
  );
  // The observing poll: the partial fill lands, the re-arm throws once, the
  // lot's residual is left naked with only the marker pointing at it.
  await ctx.execution.ingestFills();
  const exitFillQty = EXIT_PATH_LOT_SIZE * PARTIAL_FLATTEN_FRACTION;
  // Same `filledSize - exitQty` expression as ingest-fills.ts — scenario 2's
  // own float-identity reasoning, unchanged.
  const expectedResidual = EXIT_PATH_LOT_SIZE - exitFillQty;

  return { lotKey: lot5, expectedResidual };
}

/**
 * Scenario 4's exit (#519/#526): a flatten that acks but is never swept for
 * fills before a "restart" — `reconcile()`'s flatten-journal sweep, not
 * `ingestFills()` alone, is what recovers it. Its entry was opened and
 * ingested by `enterCrashRestartLotAheadOfResidualSweep`, before scenario 5.
 */
async function exitCrashRestartLotWithoutSweep(
  ctx: PostSweepScenarioContext,
  lot4ExitKey: string,
): Promise<void> {
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.crashRestart,
      lot4ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 4 exit',
  );
  // Deliberately NO `execution.ingestFills()` here — the flatten's journal
  // row is acked ('submitted') but its fill has not been redistributed, so
  // `fills_swept_at` is still NULL: exactly the row
  // `SharedStore.getUnresolvedFlattens()` exists to find, and exactly what a
  // restart would otherwise strand if a live adapter's process-local
  // `flattens` map (`AlpacaBrokerAdapter`) were the only record of it.
}

/**
 * Scenario 6 (#1088): the terminal-row sweep. Seeded directly via the store
 * port, never through `submit()` — the point is a row that already IS
 * terminal and old enough for `sweepTerminalPositions` to act on, not one
 * this harness drives there through a live broker round-trip. The clock has
 * only advanced by a handful of `tick()` seconds since `SMOKE_RUN_INSTANT`,
 * so `decision_timestamp` is set the full `TERMINAL_SWEEP_AGE_MS` (+ margin)
 * behind `clock.now()` directly, rather than relying on the smoke clock ever
 * running that far forward.
 */
async function seedTerminalSweepRow(ctx: PostSweepScenarioContext): Promise<string> {
  const terminalSweepKey = 'smoke-terminal-sweep-target';
  const terminalSweepDecisionTimestamp = new Date(
    ctx.clock.now().getTime() - TERMINAL_SWEEP_AGE_MS - 60 * 60 * 1_000,
  );
  await ctx.positionStore.writeAheadPosition({
    idempotency_key: terminalSweepKey,
    debate_id: 'debate-smoke-terminal-sweep',
    instrument: EXIT_PATH_INSTRUMENTS.crashRestart,
    asset_class: 'crypto',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 1,
    target: 2,
    order_state: 'rejected',
    broker_order_ids: [],
    opened_at: terminalSweepDecisionTimestamp,
    decision_timestamp: terminalSweepDecisionTimestamp,
    conviction: 0.5,
    converged: true,
  });

  return terminalSweepKey;
}

/**
 * The restart: a SECOND `Execution` over the SAME store + SAME broker,
 * `buildExecutionSurface` (the real composition-root binding function)
 * called again — `reconcile.test.ts`'s own definition of "a restart".
 */
async function restartExecutionAndReconcile(ctx: PostSweepScenarioContext): Promise<{
  restarted: ReturnType<typeof buildExecutionSurface>;
  restartReconcile: ReconcileReport;
}> {
  const restarted = buildExecutionSurface(
    {
      clock: ctx.clock,
      broker: ctx.broker,
      store: new SqliteExecutionStore(ctx.db),
      costModel: ctx.costModel,
      marketData: ctx.marketData,
      config: ctx.executionConfig,
      mode: 'paper',
      residualExposureAlerts: ctx.residualAlerts,
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: ctx.flattenReconcileAlerts,
      logger: ctx.logger,
      // Fresh, not the pre-restart `execution`'s instance — a real restart's
      // process is gone too, and `FilledZeroSizeThrottle` is documented
      // restart-clean by design (filled-zero-size-throttle.ts).
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    },
    'smoke-exit-path-restart',
  );
  const restartReconcile = await restarted.reconcile();

  return { restarted, restartReconcile };
}

/**
 * The crypto-emulation scenario (#586) — the pre-soak gate's third leg,
 * beside the six-stage entry run and the exit-path harness.
 *
 * Alpaca rejects every advanced order class for crypto (verified live, #550:
 * `422` code `42210000`), so `AlpacaBrokerAdapter` emulates the protective
 * pair for crypto: plain entry, plain stop_limit/limit legs armed by the
 * fill sweep, sibling cancelled by hand, every transition journalled in
 * `broker_brackets`. None of that is reachable by the six-stage run (it
 * overrides the broker with `SimulatedBrokerAdapter`) or by the exit-path
 * harness (same), and the smoke universe is crypto — so a soak's entire
 * bracket path runs on this mechanism while nothing else in this gate can
 * see it. Wiring a new mechanism means adding its enforcement assertion
 * here (#430), so this scenario composes the REAL `AlpacaBrokerAdapter`
 * over a REAL `SqliteBrokerStateStore` on the shared `:memory:` store, with
 * only the wire client scripted — and the script mirrors the verified venue
 * posture: any advanced order class for crypto is refused, exactly as the
 * live API does, so a regression back to `order_class: 'bracket'` fails
 * this run the same way it would fail the soak.
 */
class CryptoEmulationScenarioClient implements AlpacaBrokerClient {
  private readonly orders = new Map<string, AlpacaOrder>();
  private readonly idsByClientOrderId = new Map<string, string>();
  /** Every venue order id a cancel reached — the sibling-cancel evidence. */
  readonly cancelledOrderIds: string[] = [];
  private nextId = 1;

  private accept(request: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: string;
    client_order_id: string;
  }): AlpacaOrder {
    // #585/#588: the adapter boundary must have converted to slash form
    // before the wire — the live venue 422s dash form as "asset not found".
    if (!request.symbol.endsWith('/USD')) {
      throw new Error(
        `smoke crypto-emulation scenario: order for '${request.symbol}' reached the wire in ` +
          'dash form — the adapter boundary stopped converting (#585); the live venue rejects ' +
          'this with 422 "asset not found"',
      );
    }
    const order: AlpacaOrder = {
      id: `scenario-alpaca-${this.nextId++}`,
      client_order_id: request.client_order_id,
      symbol: request.symbol,
      side: request.side,
      qty: request.qty,
      order_class: '',
      status: 'accepted',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    this.orders.set(order.id, order);
    this.idsByClientOrderId.set(request.client_order_id, order.id);
    return { ...order };
  }

  /** The #550-verified posture, scripted: crypto + advanced order class = 422. */
  private rejectAdvancedOrderClass(method: string): never {
    throw new Error(
      `smoke crypto-emulation scenario: ${method} sent an advanced order_class for crypto — ` +
        'the live venue rejects this with 422 {"code":42210000,"message":"crypto orders not ' +
        'allowed for advanced order_class"} (verified #550). The adapter must take the ' +
        'emulated path (#586), never this one.',
    );
  }

  async submitOrder(): Promise<never> {
    this.rejectAdvancedOrderClass('submitOrder (order_class: bracket)');
  }

  async submitOcoOrder(): Promise<never> {
    this.rejectAdvancedOrderClass('submitOcoOrder (order_class: oco)');
  }

  async submitLimitOrder(request: AlpacaLimitOrderRequest): Promise<AlpacaOrder> {
    return this.accept(request);
  }

  async submitStopLimitOrder(request: AlpacaStopLimitOrderRequest): Promise<AlpacaOrder> {
    return this.accept(request);
  }

  async submitMarketOrder(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: no flatten is scripted here');
  }

  async cancelOrder(alpacaOrderId: string): Promise<void> {
    this.cancelledOrderIds.push(alpacaOrderId);
    const order = this.orders.get(alpacaOrderId);
    if (order !== undefined && order.status !== 'filled') order.status = 'canceled';
  }

  async getOrder(alpacaOrderId: string): Promise<AlpacaOrder> {
    const order = this.orders.get(alpacaOrderId);
    if (order === undefined) {
      throw new Error(`smoke crypto-emulation scenario: unknown order id '${alpacaOrderId}'`);
    }
    return { ...order };
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    const id = this.idsByClientOrderId.get(clientOrderId);
    return id === undefined ? null : this.getOrder(id);
  }

  async getPositions(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: getPositions is not scripted here');
  }

  async getAccount(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: getAccount is not scripted here');
  }

  /** The scripted market: marks an order fully filled at `price`. */
  fillByClientOrderId(clientOrderId: string, price: number, filledAt: string): void {
    const id = this.idsByClientOrderId.get(clientOrderId);
    const order = id === undefined ? undefined : this.orders.get(id);
    if (order === undefined) {
      throw new Error(
        `smoke crypto-emulation scenario: cannot fill unknown client order id '${clientOrderId}'`,
      );
    }
    order.status = 'filled';
    order.filled_qty = order.qty;
    order.filled_avg_price = String(price);
    order.filled_at = filledAt;
  }

  venueOrderId(clientOrderId: string): string | undefined {
    return this.idsByClientOrderId.get(clientOrderId);
  }
}

/** What `evaluateSmokeGate` needs from the crypto-emulation scenario (#586). */
export interface CryptoEmulationEvidence {
  /** The lot's `broker_brackets` row after the full drive, or undefined if none was journalled. */
  journalRow:
    | {
        phase: string;
        asset_class: string | null;
        stop_order_id: string | null;
        target_order_id: string | null;
      }
    | undefined;
  /** The entry fill came back through the emulation's sweep. */
  entryFillSeen: boolean;
  /** The stop leg's fill came back through the sweep after it fired. */
  stopFillSeen: boolean;
  /** The surviving take-profit leg's cancel reached the venue after the stop filled. */
  siblingCancelled: boolean;
}

const CRYPTO_EMULATION_LOT_KEY = 'smoke-crypto-emulated-lot';

/**
 * Drives one emulated crypto bracket end to end against the scripted venue:
 * submit (must NOT be an advanced order class — the script 422s that), fill
 * the entry, sweep (arms the legs), fill the stop, sweep (cancels the
 * sibling), then read the journal back off the SAME db the gate reads.
 */
async function runCryptoEmulationScenario(
  db: SqliteHandle,
  logger: Logger,
): Promise<CryptoEmulationEvidence> {
  const client = new CryptoEmulationScenarioClient();
  const adapter = new AlpacaBrokerAdapter({
    client,
    rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
    state: new SqliteBrokerStateStore(db),
    unpricedFillAlerts: {
      postUnpricedFillAlert: async () => {},
    },
    // #609: the SAME logger `runSmoke` built above, not a second instance —
    // matches the composition-root convention `production.ts` follows.
    logger,
    // A double fill is impossible in this script (the target is cancelled
    // before it could ever fill), so an alert here is itself a defect —
    // thrown rather than swallowed, failing the run loudly.
    ocoDoubleFillAlerts: {
      postOcoDoubleFillAlert: async (alert) => {
        throw new Error(
          `smoke crypto-emulation scenario: unexpected double-fill alert for ` +
            `'${alert.client_order_id}'`,
        );
      },
    },
  });

  const ack = await adapter.submitBracket({
    client_order_id: CRYPTO_EMULATION_LOT_KEY,
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    size: 0.5,
    entry: 60_000,
    stop: 57_000,
    target: 66_000,
    time_in_force: 'gtc',
  });
  if (ack.order_state !== 'submitted') {
    throw new Error(
      `smoke crypto-emulation scenario: entry ack was '${ack.order_state}', not 'submitted' — ` +
        'a scenario precondition is wrong, not the gate',
    );
  }

  client.fillByClientOrderId(CRYPTO_EMULATION_LOT_KEY, 60_000, '2026-01-02T00:00:00Z');
  const armSweep = await adapter.fetchNewFills(new Date(0));

  // The emulation's deterministic first-episode leg id (#586) — the stop
  // firing is the OCO edge under test.
  client.fillByClientOrderId(`${CRYPTO_EMULATION_LOT_KEY}:stop`, 57_000, '2026-01-02T00:01:00Z');
  const exitSweep = await adapter.fetchNewFills(new Date(0));

  const journalRow = db
    .prepare(
      'SELECT phase, asset_class, stop_order_id, target_order_id FROM broker_brackets ' +
        "WHERE venue = 'alpaca' AND client_order_id = ?",
    )
    .get(CRYPTO_EMULATION_LOT_KEY) as CryptoEmulationEvidence['journalRow'];

  const targetVenueId = client.venueOrderId(`${CRYPTO_EMULATION_LOT_KEY}:target`);
  return {
    journalRow,
    entryFillSeen: armSweep.some(
      (fill) => fill.leg === 'entry' && fill.client_order_id === CRYPTO_EMULATION_LOT_KEY,
    ),
    stopFillSeen: exitSweep.some(
      (fill) => fill.leg === 'stop' && fill.client_order_id === CRYPTO_EMULATION_LOT_KEY,
    ),
    siblingCancelled:
      targetVenueId !== undefined && client.cancelledOrderIds.includes(targetVenueId),
  };
}

/**
 * What the logging-fault scenario (#714) observed. Every field is an EFFECT —
 * a line on disk, a chosen exit code — not "an object was constructed".
 */
export interface LoggerResilienceEvidence {
  /** Stdout was retired rather than retried after the pipe died. */
  stdoutRetired: boolean;
  /** The degradation notice reached the durable file — the failure was not lost. */
  degradationRecordedInFile: boolean;
  /** Lines that reached the file AFTER stdout died: the run kept its trace. */
  linesAfterStdoutDeath: number;
  /** A logger with nowhere to record the failure threw instead of continuing blind. */
  escalatedWhenNothingCouldRecord: boolean;
  /**
   * That same logger still left the line on stderr. The throw alone is not
   * enough: inside a tick it is swallowed by `safeLog` (#573), so stderr is the
   * only trace that ordering produces.
   */
  lastResortTraceOnStderr: boolean;
  /** The fault handler's record of an unhandled fault reached the durable file. */
  fatalRecordedInFile: boolean;
  /** The exit code the fault handler chose. Null if it never called `exit`. */
  fatalExitCode: number | null;
}

/** A stdout that can be killed the way a real pipe dies: asynchronously. */
class BreakablePipe implements StdoutStream {
  private listener?: (error: Error) => void;
  /** Set to make `write` throw, modelling synchronous (file/TTY) stdio. */
  throwOn?: Error;
  /** Lines that reached it while it was alive. */
  readonly lines: string[] = [];

  write(line: string): boolean {
    if (this.throwOn !== undefined) throw this.throwOn;
    this.lines.push(line);
    return true;
  }

  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }

  breakPipe(): void {
    if (this.listener === undefined) {
      throw new Error(
        'smoke logging-fault scenario: nothing subscribed to stdout errors — ' +
          '`buildEntrypointLogger` stopped calling `watchStdoutErrors` (#714), so a broken ' +
          'pipe would reach `uncaughtException` and end an unattended soak',
      );
    }
    this.listener(new Error('EPIPE: broken pipe'));
  }
}

/**
 * The logging-fault scenario (#714) — the pre-soak gate's fourth leg.
 *
 * A soak dies from a closed terminal only in production, never in a unit test,
 * and the two mechanisms that stop it (`watchStdoutErrors` and
 * `installFaultHandlers`) live at the entrypoint, which nothing else in this
 * gate exercises. Wiring a mechanism means adding its enforcement assertion
 * here (#430), so this drives BOTH against a REAL `RotatingFileSink` on disk
 * and reads the resulting file back — the effect, not the construction.
 *
 * The file goes to a temp directory, removed afterwards: like the `:memory:`
 * store, a gate must leave no artefacts in the checkout, and in particular
 * must not create the `logs/` a real soak writes to.
 */
function runLoggerResilienceScenario(): LoggerResilienceEvidence {
  const directory = mkdtempSync(join(tmpdir(), 'samurai-smoke-log-'));
  try {
    const filePath = join(directory, 'orchestrator.log');
    const stdout = new BreakablePipe();
    // The REAL entrypoint builder, so a regression that stops subscribing to
    // stdout errors, or stops opening the file, fails this run.
    const logger = buildEntrypointLogger(
      { filePath, maxBytes: 1024 * 1024, maxRotatedFiles: 1 },
      stdout,
    );
    const entry = (message: string) => ({
      trace_id: 'smoke-logging-fault',
      stage: 'orchestrator',
      level: 'info' as const,
      message,
      payload: {},
    });

    logger.log(entry('before the pipe died'));
    stdout.breakPipe();
    logger.log(entry('after the pipe died'));

    const afterPipe = readLogLines(filePath);
    const degradationRecordedInFile = afterPipe.some(
      (line) =>
        (line.payload as { log_stdout_sink?: string } | undefined)?.log_stdout_sink === 'degraded',
    );
    const linesAfterStdoutDeath = afterPipe.filter(
      (line) => line.message === 'after the pipe died',
    ).length;

    // The other half of the rule: with no sink able to hold the report, the
    // logger must NOT degrade quietly.
    let escalatedWhenNothingCouldRecord = false;
    const deadStdout = new BreakablePipe();
    deadStdout.throwOn = new Error('EBADF');
    const stderrLines: string[] = [];
    const sinkless = new JsonLogger(undefined, deadStdout, {
      write: (line) => {
        stderrLines.push(line);
      },
    });
    try {
      sinkless.log(entry('nowhere to go'));
    } catch {
      escalatedWhenNothingCouldRecord = true;
    }
    const lastResortTraceOnStderr = stderrLines.some((line) => line.includes('nowhere to go'));

    // And the composition root's fault net: an unhandled fault is recorded
    // durably and exits, rather than being shrugged off.
    const exits: number[] = [];
    const handlers = new Map<string, (error: unknown) => void>();
    installFaultHandlers(logger, {
      exit: (code) => exits.push(code),
      stderr: () => {},
      on: (event, handler) => handlers.set(event, handler),
    });
    handlers.get('uncaughtException')?.(new Error('smoke-injected fault'));

    return {
      stdoutRetired: logger.stdoutRetired,
      degradationRecordedInFile,
      linesAfterStdoutDeath,
      escalatedWhenNothingCouldRecord,
      lastResortTraceOnStderr,
      fatalRecordedInFile: readLogLines(filePath).some((line) =>
        line.message.includes('uncaughtException'),
      ),
      fatalExitCode: exits[0] ?? null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * What the #1116 retention sweep observed. Every field is an EFFECT of
 * driving the REAL `runEntrypointLogRetention` against files on disk — not
 * "the function exists".
 */
export interface LogRetentionEvidence {
  /** A file well outside the retention window was actually removed. */
  staleFileRemoved: boolean;
  /** A file inside the retention window survived — a sweep must not eat evidence of a live run. */
  freshFileKept: boolean;
  /** The sink's own rotation generation survived despite being old. */
  protectedFileKeptDespiteAge: boolean;
  /**
   * An undated bare name survived despite being old — the shape a still-open
   * writer holds (`service-api.log`), which unlinking would turn into
   * invisible growth rather than reclaimed space. It also survives the
   * truncate path (#1206), which is default-on again as of the #1281 review
   * round-2 reversal, because `service-api.log` is not in
   * `bareTruncateNames`'s default (`soak-boot.out` alone) — the name
   * allowlist, not this fixture's small size, is what protects it now.
   */
  liveShapedFileKeptDespiteAge: boolean;
  /** A non-log file in the swept directory survived despite being old. */
  nonLogFileKeptDespiteAge: boolean;
  /**
   * #1206, exercised end to end with NO configuration at all (#1281 review
   * round 2): an oversized `soak-boot.out` — the one file the ticket names —
   * was actually truncated by the real entrypoint helper, proving the
   * default-on threshold and the default name allowlist both reach it
   * without an operator setting anything.
   */
  oversizedSoakBootTruncatedByDefault: boolean;
  /** `bytesReclaimed` actually accounted for the file that was removed. */
  bytesReclaimed: number;
}

/**
 * The #1116 retention-sweep scenario — the pre-soak gate's leg for `logs/`
 * housekeeping.
 *
 * Driven through `runEntrypointLogRetention`, the exported boot helper the
 * `import.meta.url` guard in `index.ts` calls, so the ARGUMENT DERIVATION is
 * covered too — which directory `dirname(SAMURAI_LOG_FILE)` picks, and which
 * paths are protected — and not just the sweep it delegates to. The guard
 * itself is unreachable from any in-process caller; `index.test.ts` asserts
 * on its source that the call is still there.
 *
 * The `FileSinkConfig` is built literally rather than through
 * `fileSinkConfigFromEnvironment`, and `env` is passed explicitly: both
 * default to the real `logs/` a soak is writing to, and a gate must never run
 * the sweep against that, nor let an operator's shell perturb its window.
 *
 * The directory goes to `os.tmpdir()`, removed afterwards: like the other
 * scenarios above, a gate must leave no artefacts in the checkout.
 */
function runLogRetentionScenario(): LogRetentionEvidence {
  const directory = mkdtempSync(join(tmpdir(), 'samurai-smoke-log-retention-'));
  try {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const stalePath = join(directory, 'orchestrator-20260101-0000.log');
    const freshPath = join(directory, 'orchestrator-20260904-0000.log');
    const activePath = join(directory, 'orchestrator.log');
    // Archival-shaped, so `protectedPaths` — not the name rule — is the only
    // thing keeping it, which is what makes the assertion on it falsifiable.
    const rotatedPath = `${activePath}.1`;
    // The `service-api.log` shape: undated, bare, and quietly held open by a
    // sibling process for weeks at a time.
    const liveShapedPath = join(directory, 'service-api.log');
    const nonLogPath = join(directory, '.env.local');
    // #1206, round 2: the one file the ticket names, oversized so it crosses
    // `DEFAULT_BARE_TRUNCATE_BYTES` (16 MiB) — this is what proves the
    // default-on threshold plus the default name allowlist actually reach it
    // in a real process, with no env var set for either.
    const soakBootPath = join(directory, 'soak-boot.out');
    for (const path of [
      stalePath,
      freshPath,
      activePath,
      rotatedPath,
      liveShapedPath,
      nonLogPath,
    ]) {
      writeFileSync(path, 'line\n');
    }
    writeFileSync(soakBootPath, 'x'.repeat(17 * 1024 * 1024)); // > 16 MiB

    const oldSeconds = (Date.now() - 40 * oneDayMs) / 1000;
    const recentSeconds = (Date.now() - oneDayMs) / 1000;
    for (const path of [stalePath, rotatedPath, liveShapedPath, nonLogPath]) {
      utimesSync(path, oldSeconds, oldSeconds);
    }
    utimesSync(freshPath, recentSeconds, recentSeconds);

    // The REAL boot helper, not a stand-in, so a regression that stops
    // deleting stale files, starts deleting live-shaped or non-log ones,
    // stops honouring `protectedPaths`, or derives the wrong directory from
    // the sink config fails this run.
    const result = runEntrypointLogRetention(
      { filePath: activePath, maxBytes: 1_000_000, maxRotatedFiles: 1 },
      { log: () => {} },
      { SAMURAI_LOG_RETENTION_DAYS: '30' },
    );

    return {
      staleFileRemoved: !existsSync(stalePath),
      freshFileKept: existsSync(freshPath),
      protectedFileKeptDespiteAge: existsSync(rotatedPath),
      liveShapedFileKeptDespiteAge: existsSync(liveShapedPath),
      nonLogFileKeptDespiteAge: existsSync(nonLogPath),
      oversizedSoakBootTruncatedByDefault: statSync(soakBootPath).size === 0,
      bytesReclaimed: result.bytesReclaimed,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * What the #764 entrypoint fault guards observed, per entrypoint. Every field
 * is an EFFECT of driving the REAL exported guard functions
 * (`service-api/fault-guard.ts`, `supervisor/fault-guard.ts`) against a fake
 * shaped like the async-`'error'`-only pipe #714 measured — not "the function
 * exists".
 */
export interface EntrypointFaultGuardEvidence {
  entries: {
    name: 'service-api' | 'supervisor';
    /** The stdout fault was reported on stderr — not silently absorbed. */
    faultReportedOnStderr: boolean;
    /** An arbitrary uncaught fault was reported and the process was NOT told to exit. */
    continuesOnArbitraryFault: boolean;
  }[];
}

/**
 * A stdout/stderr stand-in with the same "throw when nothing subscribed"
 * trick as `BreakablePipe.breakPipe` above (#714): a mutation that stops
 * calling `watchStdoutErrors` on either stream inside `watchDashboardStdout` /
 * `watchSupervisorStdout` makes this throw, which aborts `yarn smoke` loudly
 * rather than passing the gate silently. Also implements `write`, since the
 * same object stands in for stderr (the reporting channel) as well as stdout.
 */
class NoListenerBreakablePipe {
  private listener?: (error: Error) => void;
  readonly lines: string[] = [];
  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }
  write(line: string): void {
    this.lines.push(line);
  }
  breakPipe(name: string, streamName: 'stdout' | 'stderr'): void {
    if (this.listener === undefined) {
      throw new Error(
        `smoke entrypoint-fault-guard scenario: nothing subscribed to ${name}'s ${streamName} ` +
          `errors (#764) — a broken pipe would reach uncaughtException${streamName === 'stdout' ? ', same class #714 fixed for the orchestrator' : ' with no report ever landing, defeating the continue-posture at the one moment it exists to cover'}`,
      );
    }
    this.listener(new Error('EPIPE: broken pipe'));
  }
}

/**
 * The #764 entrypoint fault-guard scenario — the pre-soak gate's fifth leg,
 * alongside #714's `runLoggerResilienceScenario` above.
 *
 * #714 fixed the unguarded-stdout class for the orchestrator only, and
 * captured — rather than fixed — the same class on the service-api and
 * supervisor entrypoints. #764 fixes those two, with a DIFFERENT
 * arbitrary-fault decision from the orchestrator's (continue, not stop — see
 * each `fault-guard.ts`'s own doc for the reasoning). This drives the REAL
 * exported functions from both modules, exactly as `runLoggerResilienceScenario`
 * drives the real `buildEntrypointLogger` rather than a stand-in.
 */
function runEntrypointFaultGuardScenario(): EntrypointFaultGuardEvidence {
  function probe(
    name: 'service-api' | 'supervisor',
    watchStdout: (
      stdout: FaultGuardStdoutStream,
      stderr: FaultGuardStdoutStream & FaultGuardErrorStream,
    ) => void,
    install: (effects: ContinueOnFaultEffects) => void,
  ): EntrypointFaultGuardEvidence['entries'][number] {
    const stdoutPipe = new NoListenerBreakablePipe();
    const stderrPipe = new NoListenerBreakablePipe();
    watchStdout(stdoutPipe, stderrPipe);
    // A mutation that stops calling `watchStdoutErrors` on stdout inside
    // `watchStdout` leaves nothing subscribed, so `breakPipe` throws —
    // propagated rather than caught, aborting this run loudly, matching
    // `runLoggerResilienceScenario`'s own `BreakablePipe.breakPipe` (#714).
    // There is deliberately no boolean field recording this outcome: the
    // throw itself is the enforcement, and a field that can only ever read
    // `true` when reached is the vacuous-backstop shape #388 warns about
    // above.
    stdoutPipe.breakPipe(name, 'stdout');
    // Same trick for stderr — a mutation that stops subscribing to stderr's
    // own error event (the fix for the reporting-channel-shares-the-fd gap;
    // see each fault-guard.ts's "Both streams, not just stdout") leaves
    // nothing subscribed here too, so this throws just as loudly.
    stderrPipe.breakPipe(name, 'stderr');
    const stdoutFaultLines = stderrPipe.lines;

    const arbitraryFaultLines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();
    install({
      stderr: { write: (line) => arbitraryFaultLines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });
    if (!handlers.has('uncaughtException') || !handlers.has('unhandledRejection')) {
      throw new Error(
        `smoke entrypoint-fault-guard scenario: ${name} did not subscribe to both ` +
          'uncaughtException and unhandledRejection (#764)',
      );
    }
    handlers.get('uncaughtException')?.(new Error('smoke-injected fault'));

    return {
      name,
      faultReportedOnStderr: stdoutFaultLines.length > 0,
      continuesOnArbitraryFault: arbitraryFaultLines.length > 0,
    };
  }

  return {
    entries: [
      probe('service-api', watchDashboardStdout, installDashboardContinueOnFault),
      probe('supervisor', watchSupervisorStdout, installSupervisorContinueOnFault),
    ],
  };
}

function readLogLines(filePath: string): { message: string; payload?: unknown }[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message: string; payload?: unknown });
}

/** One tick's audit trail: the stages it reached and what each decided. */
export interface SmokeTick {
  trace_id: string;
  stages: { stage: string; decision: string }[];
}

/**
 * What the run observably did, read back from the shared store after the loop
 * has drained.
 *
 * Read with SQL against the same handle the process wrote through, rather than
 * from log strings: the gate has to assert on effects, and a log line is a
 * description of an effect. This is a read-only observer over the production
 * schema, not a second composition root.
 */
export interface SmokeObservations {
  /** From `audit_log`, grouped by trace, ordered as the tick runner wrote them. */
  ticks: SmokeTick[];
  /**
   * From `debate_log` — the row `feedback-loop/attribution.ts` joins on to
   * credit analysts (#364). Observed here because a store with no caller is
   * invisible to every other check in this file: the tick's `audit_log` line
   * says `debate: bullish` whether or not a row was ever written.
   */
  debates: {
    debate_id: string;
    instrument: string;
    direction: string;
    rounds: number;
    /** #1081. Null would mean `buildDebateLog` stopped setting it — see the gate below. */
    termination: string | null;
  }[];
  /** From `verdict_log` — the row `OrphanVerdictScanner` reads at restart. */
  verdicts: {
    trace_id: string;
    instrument: string;
    status: string;
    no_go_reason: string | null;
    /** #1111, migration 0046 — what the gate measured and the bound it broke. */
    no_go_detail_measured_ms: number | null;
    no_go_detail_bound_ms: number | null;
  }[];
  /** From `open_positions` — written ahead by `ExecutionImpl` before the broker call. */
  positions: {
    idempotency_key: string;
    instrument: string;
    side: string;
    requested_size: number;
    filled_size: number;
    avg_entry_price: number;
    order_state: string;
    /**
     * #753, migration 0033 — which arm opened this lot.
     *
     * Observed for the reason `debates` is: falsifier arm 2 is mandated
     * (ADR-0014 amendment 2, ADR-0017 §Consequences) to run in parallel with the
     * live arm from the first soak day, and a control arm that has silently
     * stopped producing is invisible to every other check in this file. This
     * column is also the acceptance criterion itself — "the control arm's trades
     * are distinguishable in the trade record" — so reading it here is reading
     * the thing the ticket promised, not a proxy for it.
     */
    arm: TradingArm;
  }[];
  /** From `fills` — appended by `ingestFills()` on the fill-sync poll. */
  fills: { idempotency_key: string; leg: string; price: number; qty: number; fee: number }[];
  /**
   * From `closed_trades` — written by `ingestFills()`'s round-trip-to-flat
   * branch (#82/#83). Empty until #576's exit-path harness (`runExitPathScenarios`
   * below) started driving `intent_type: 'exit'` through `execute()`; before
   * that this table was unreachable offline, because
   * `SimulatedBrokerAdapter.submitBracket` models only the entry fill and
   * nothing ever submitted a flatten. See `evaluateSmokeGate`'s check.
   */
  closedTrades: {
    idempotency_key: string;
    realized_pnl_net: number;
    close_reason: string;
    /** #753 — see `positions.arm`. The column the comparison report groups on. */
    arm: TradingArm;
  }[];
  /**
   * From `flatten_submissions` (#508/#516 review, migration 0019) — the
   * write-ahead journal `executeExit` writes BEFORE cancelling a held lot's
   * bracket and BEFORE calling `submitFlatten`. A row here is the durable
   * proof an exit reached that path at all; its `status` proves whether the
   * broker call resolved (`'submitted'`) or was refused/left ambiguous.
   */
  flattenSubmissions: { idempotency_key: string; instrument: string; status: string }[];
  /**
   * Rows the GDELT macro layer archived (#556). Read from the MI archive, not
   * `db` — MI lives in its own file (#554) — so it is passed in rather than
   * queried here.
   *
   * Observed for the reason `debates` is: an ingestion path with no caller is
   * invisible to every other check in this file. Nothing else in a smoke run
   * changes whether or not this poller ever fired.
   */
  gdeltRowsArchived: number;
  /**
   * Aggregates the GDELT scoring pass (#1086) put in front of the analysts.
   *
   * BOTH this and `gdeltRowsArchived`, for the reason the Polymarket pair
   * below states: the archive count proves bytes were fetched, and only the
   * store read proves anything derived from them reached the `intel` bucket
   * an analyst queries (#1164: class-wide GDELT items route to `intel`, not
   * `news`). #556 shipped the first half alone for a year, which is exactly
   * the gap this number closes.
   */
  gdeltAggregateItems: number;
  /**
   * Rows the Polymarket macro layer archived, and the items it actually put in
   * front of `fundamental` (#504).
   *
   * BOTH, deliberately. The archive row proves a fetch happened; only the
   * store read proves the item reached the `intel` bucket the analyst queries
   * (#1164: class-wide Polymarket items route to `intel`, not `news`) — and
   * the gap between those two claims is where this repo's dominant defect (a
   * mechanism nothing consumes) lives.
   */
  polymarketRowsArchived: number;
  polymarketItemsArchived: number;
  polymarketIntelItems: number;
  /**
   * From `cosine_setups` — the row `Trader.decide` writes at decision time
   * (#432). Observed here for `debates`' reason and from the same defect: the
   * retrieval mechanism (#75) and the store (#198) both existed and `decide()`
   * called neither, so every position took a permanent 0.75x haircut and the
   * table stayed empty for the life of the process. Nothing else in this file
   * can see that — the `audit_log` line reads `trader: intent` either way.
   */
  cosineSetups: { debate_id: string; instrument: string }[];
  /**
   * From `risk_thresholds` — the dials the composition root seeds at startup
   * and `RiskManagerImpl.evaluate` reads live (#433). An empty table means
   * `autoTighten` has nothing to step from, so a kill-line breach tightens
   * nothing: the defensive response writes a row nobody reads, which is the
   * defect #433 closed.
   */
  riskThresholds: { name: string; value: number }[];
  /**
   * From `analyst_weights` — seeded at startup (#371) so the daily cycle has a
   * row to step per analyst. Zero rows is the shape that let a soak "run
   * cleanly" while attributing nothing.
   */
  analystWeights: { analyst_id: string }[];
  /**
   * From `trader_log` / `risk_log` — the decision records (#328). Empty means
   * the two stages that decide WHAT to trade and HOW BIG left nothing behind
   * but an `audit_log` digest, so a soak's surprises are unreconstructable
   * afterwards. Both write on a skip/rejection too, so a run that traded
   * nothing must still produce rows: zero is always a wiring failure, never a
   * quiet market.
   */
  traderDecisions: { trace_id: string; instrument: string; intent_type: string | null }[];
  riskDecisions: { trace_id: string; instrument: string; status: string }[];
  /**
   * From `breaker_state` — the sticky breakers' durable home (#203, review
   * 2026-08-06 B1). Two rows (one per tier) exist only if the tick path's
   * breaker evaluation persisted its state; an empty table means a tripped
   * kill switch silently re-arms on restart — the exact gap the table was
   * created to close and then sat unwritten behind for the life of the
   * project.
   */
  breakerStates: { tier: string; tripped: number }[];
}

/** Reads everything the gate and the report need, in one pass over the store. */
export function readSmokeObservations(
  db: SqliteHandle,
  miArchive?: MiArchiveStore,
  marketIntelligence?: MarketIntelligenceStore,
): SmokeObservations {
  const auditRows = db
    .prepare('SELECT trace_id, stage, decision FROM audit_log ORDER BY rowid')
    .all() as { trace_id: string; stage: string; decision: string }[];

  const byTrace = new Map<string, SmokeTick>();
  for (const row of auditRows) {
    const tick = byTrace.get(row.trace_id) ?? { trace_id: row.trace_id, stages: [] };
    tick.stages.push({ stage: row.stage, decision: row.decision });
    byTrace.set(row.trace_id, tick);
  }

  return {
    ticks: [...byTrace.values()],
    debates: db
      .prepare(
        'SELECT debate_id, instrument, direction, rounds, termination FROM debate_log ORDER BY rowid',
      )
      .all() as SmokeObservations['debates'],
    verdicts: db
      .prepare(
        'SELECT trace_id, instrument, status, no_go_reason, no_go_detail_measured_ms, ' +
          'no_go_detail_bound_ms FROM verdict_log ORDER BY rowid',
      )
      .all() as SmokeObservations['verdicts'],
    // #1028: ordered by content (`arm`/`idempotency_key`/`leg`), not `rowid`.
    // `rowid` reflects insertion order, which for these two tables is
    // insertion-timing-dependent — `open_positions` rows are written by
    // whichever arm's Trader stage reaches the store first, and `fills`
    // rows are written by whichever arm's independently-scheduled
    // `startFillSync()` poll ingests first (production.ts). Both races are
    // real but harmless to outcome; a content-based order makes the
    // readback describe *what* was recorded rather than *when*, so
    // `runSmoke()`'s determinism check compares stable results instead of
    // an accidental scheduling order.
    positions: db
      .prepare(
        'SELECT idempotency_key, instrument, side, requested_size, filled_size, avg_entry_price, ' +
          'order_state, arm FROM open_positions ORDER BY arm, idempotency_key',
      )
      .all() as SmokeObservations['positions'],
    fills: db
      .prepare(
        'SELECT idempotency_key, leg, price, qty, fee FROM fills ' +
          'ORDER BY idempotency_key, leg, rowid',
      )
      .all() as SmokeObservations['fills'],
    // #1028: same content-based ordering as `positions`/`fills` above — `closed_trades`
    // rows are also written per-arm, on whichever arm's exit path (round-trip-to-flat,
    // #82/#83) reaches the store first, so `rowid` order is the same insertion-timing
    // race. `idempotency_key` is `closed_trades`' PRIMARY KEY (migration 0031), so
    // ordering by it after `arm` is a total, stable order.
    closedTrades: db
      .prepare(
        'SELECT idempotency_key, realized_pnl_net, close_reason, arm FROM closed_trades ' +
          'ORDER BY arm, idempotency_key',
      )
      .all() as SmokeObservations['closedTrades'],
    flattenSubmissions: db
      .prepare('SELECT idempotency_key, instrument, status FROM flatten_submissions ORDER BY rowid')
      .all() as SmokeObservations['flattenSubmissions'],
    gdeltRowsArchived: miArchive?.rawRows(SOURCE_GDELT).length ?? 0,
    // Counted across every leg of `SMOKE_TEST_UNIVERSE` — the same list
    // `SMOKE_GDELT_EXPECTED_AGGREGATES` is sized from, so the observation and
    // the expectation cannot drift apart — because the pass derives per asset
    // class and a per-class read would hide a leg that stopped deriving. The
    // 24h window is `fundamental`'s own (`MI_CONTEXT_WINDOW_MS`), on the same
    // store instance, so this counts what the analyst would have seen rather
    // than what was merely written.
    gdeltAggregateItems: SMOKE_GDELT_ASSET_CLASSES.reduce(
      (total, asset_class) =>
        total +
        (marketIntelligence
          ?.getContext(asset_class, 24 * 60 * 60 * 1000, 'smoke')
          .intel.filter((item) => item.entity === GDELT_MACRO_ENTITY).length ?? 0),
      0,
    ),
    polymarketRowsArchived: miArchive?.rawRows(SOURCE_POLYMARKET).length ?? 0,
    // #835: the ITEMS table, not the raw one. This source wrote `[]` for its
    // items, which no raw-row count could see, and `hydrate()` deliberately
    // does not read them back — so without this line nothing in the gate would
    // notice them going missing again.
    polymarketItemsArchived:
      miArchive?.itemsKnownAt(POLYMARKET_ASSET_CLASS, SMOKE_RUN_INSTANT, [SOURCE_POLYMARKET])
        .length ?? 0,
    // The SAME 24h window `fundamental` reads (`MI_CONTEXT_WINDOW_MS`), on the
    // same store instance, AND entity-scoped like every analyst read is
    // (`resolveMiSubject(signal.asset)`, #914/#960) — so this counts what the
    // analyst would have seen. Unscoped it did not: a curated market is filed
    // under a macro series name, so an item missing `scope: 'asset_class'`
    // reached this count and no analyst, and the gate stayed green while the
    // whole feed was dark. The ticker is arbitrary — a class-wide item is
    // admitted for any entity, and one filed per entity is admitted for none.
    // #1164: class-wide Polymarket items route to `intel`, not `news`.
    polymarketIntelItems:
      marketIntelligence
        ?.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'smoke', undefined, 'SPY')
        .intel.filter((item) => item.source === SOURCE_POLYMARKET).length ?? 0,
    // #430. Each of these is a mechanism that was, at some point, fully built,
    // fully unit-tested and called by nothing in production. The table row is
    // the only evidence that a caller exists.
    cosineSetups: db
      .prepare('SELECT debate_id, instrument FROM cosine_setups')
      .all() as SmokeObservations['cosineSetups'],
    riskThresholds: db
      .prepare('SELECT threshold_name AS name, value FROM risk_thresholds')
      .all() as SmokeObservations['riskThresholds'],
    traderDecisions: db
      .prepare('SELECT trace_id, instrument, intent_type FROM trader_log')
      .all() as SmokeObservations['traderDecisions'],
    riskDecisions: db
      .prepare('SELECT trace_id, instrument, status FROM risk_log')
      .all() as SmokeObservations['riskDecisions'],
    analystWeights: db
      .prepare('SELECT analyst_id FROM analyst_weights')
      .all() as SmokeObservations['analystWeights'],
    breakerStates: db
      .prepare('SELECT tier, tripped FROM breaker_state')
      .all() as SmokeObservations['breakerStates'],
  };
}

export interface SmokeGateResult {
  passed: boolean;
  /** One line per unmet requirement, in the order they are checked. Empty on a pass. */
  failures: string[];
}

/**
 * The gate. Pure over observations so every branch is unit-testable without
 * starting a process — a gate that passes when nothing transacted is worse
 * than no gate.
 *
 * "Transacted" is deliberately a conjunction of independently-observable
 * effects rather than one summary flag, because each is a different wiring
 * defect:
 *
 * 1. the loop ran at all (timers, scheduler, shutdown);
 * 2. some tick got past Analysts — the literal condition #350 names, and the
 *    one a credentialed run against a 401ing data feed fails;
 * 3. a resolved debate reached `debate_log` (#364 — the store was constructed
 *    and never called, so a whole paper run of converged debates left the
 *    Feedback Loop's attribution input at zero rows);
 * 4. a `go` reached `verdict_log` (Verdict's gates, the HITL path, and the row
 *    `OrphanVerdictScanner` reads at restart);
 * 5. Execution accepted the `go` and reported `submitted`;
 * 6. a lot was written ahead to `open_positions` and reached the broker;
 * 7. a fill came back through the fill-sync poll — the only thing that proves
 *    `ingestFills()` is actually scheduled and draining.
 *
 * Requirement 3 asks for at least ONE row, not one per tick: the smoke clock
 * is frozen at `SMOKE_RUN_INSTANT` and the fixture views are identical every
 * tick, so all three ticks hash to the same `debate_id` and the writer's
 * first-write-wins guard (debate-adapter.ts) correctly collapses them to one
 * row rather than duplicating that debate's analysts in attribution.
 *
 * ## The exit path (#576)
 *
 * A `ClosedTrade` IS now required — see `options.exitPath` and
 * `runExitPathScenarios`. Six merged fixes (#508/#516/#517/#525/#568/#571)
 * live entirely in `Execution`'s exit path and none of them were reachable
 * from anything above; this gate could pass with every one of them
 * regressed, which was #576's entire finding. The checks below are a
 * conjunction for the same reason requirements 1-7 above are: each names a
 * different one of the six.
 */
/**
 * What the threshold-clamp probe (#638) observed. Every field records a
 * REFUSAL that actually happened at a real seam, not that a validator exists.
 */
/**
 * A minimal `RiskInput` for the #766 exit-bypass probe below — same shape
 * `risk-manager/index.test.ts`'s own fixtures use, trimmed to what
 * `RiskManagerImpl.evaluate` actually reads on the branch this probe drives.
 */
function makeExitProbeInput(overrides: Partial<OrderIntent> = {}) {
  const intent: OrderIntent = {
    idempotency_key: 'smoke-threshold-clamp-exit-probe',
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'sell',
    intent_type: 'exit',
    size: 1,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: SMOKE_RUN_INSTANT,
    decided_at: SMOKE_RUN_INSTANT,
    metadata: {
      debate_id: 'smoke-threshold-clamp-exit-probe',
      conviction: 0.5,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: 0, no_precedent: true },
    },
    ...overrides,
  };
  return {
    trace_id: 'smoke-threshold-clamp-exit-probe',
    intent,
    clock: { now: () => SMOKE_RUN_INSTANT },
    portfolio: {
      equity: 100_000,
      peak_equity: 100_000,
      drawdown_pct: 0,
      exposure_by_instrument: {},
      exposure_by_class: { crypto: 0, stocks: 0 },
      gross_exposure: 0,
      daily_pnl: {
        crypto: { known: true as const, pct: 0 },
        stocks: { known: true as const, pct: 0 },
        portfolio: { known: true as const, pct: 0 },
      },
      consecutive_losses: 0,
      // #841: a fully-valued book, which is what this probe is about — the
      // clamp, not the valuation. A non-empty list here would make the ENTRY
      // half of the probe pass for the wrong reason.
      unvalued_instruments: [],
    },
    breakers: {
      portfolio_tripped: false,
      asset_class_tripped: { crypto: false, stocks: false },
      armed_breakers: [],
    },
    next_breaker_state: [],
    correlation: { correlations: {}, insufficient_history: [] },
    cii: {},
    mode: 'paper' as const,
  };
}

/**
 * The exit/flatten side of #766: with a live `risk_thresholds` row out of
 * bounds, does an EXIT intent still reach Execution, or does it abort the
 * same as an entry would? Drives the REAL `RiskManagerImpl.evaluate()` —
 * the same class `buildRiskStep` (direct-bind.ts) wraps — rather than a
 * reimplementation, so a regression in the exit-bypass ordering
 * (risk-manager/index.ts) fails this probe exactly the way it would fail in
 * production.
 *
 * Also probes the ENTRY side, which MUST still throw: a probe that only
 * checked "exit does not throw" could not tell a working clamp from one that
 * silently stopped enforcing anything at all.
 */
function probeExitBypassesLiveClamp(riskConfig: RiskConfig): boolean {
  const badThresholds = { getRiskThresholds: () => ({ max_pbo: 0.5 }) }; // bound: max 0.05
  const manager = new RiskManagerImpl(riskConfig, badThresholds);

  let exitApproved = false;
  try {
    const decision = manager.evaluate(makeExitProbeInput());
    exitApproved = decision.status === 'approved';
  } catch {
    exitApproved = false;
  }

  const entryStillRefused = refuses(() => {
    manager.evaluate(makeExitProbeInput({ intent_type: 'entry', idempotency_key: 'smoke-entry' }));
  });

  return exitApproved && entryStillRefused;
}

export interface ThresholdClampEvidence {
  /**
   * The guarded names this probe drove. Compared against
   * `GUARDED_THRESHOLD_NAMES` by the gate, so deleting a row from the bounds
   * table turns the gate red instead of quietly shrinking what is covered.
   */
  probedNames: readonly string[];
  /** Guarded names the LIVE `risk_thresholds` read accepted out of bounds. */
  liveReadAccepted: readonly string[];
  /** Guarded names the Feedback Loop's write door accepted out of bounds. */
  writeDoorAccepted: readonly string[];
  /** The breaker constructor refused an out-of-bound drawdown pair. */
  breakerConstructionRefused: boolean;
  /** The kill-line boot check refused a softened PBO line. */
  killLineCheckRefused: boolean;
  /** The SHIPPED paper values still boot — the clamp bounds a dial, not forbids one. */
  shippedConfigAccepted: boolean;
  /**
   * #766: with a live `risk_thresholds` row out of bounds, an EXIT intent
   * reached `RiskManagerImpl.evaluate()`'s `approved` bypass and an ENTRY
   * intent was still refused — see `probeExitBypassesLiveClamp`. False means
   * either the exit path is stranded behind the clamp (ADR-0014's flat-by-
   * close invariant at risk) or the clamp stopped refusing entries at all.
   */
  exitBypassesLiveClamp: boolean;
}

/** A value one whole unit outside whichever edge the bound states. */
function outOfBoundValueFor(name: string): number {
  const bound = boundFor(name);
  if (bound === undefined) {
    throw new Error(`smoke threshold-clamp probe: '${name}' has no bound — the table changed`);
  }
  if (bound.max !== undefined) return bound.max + 1;
  if (bound.min !== undefined) return bound.min - 1;
  throw new Error(`smoke threshold-clamp probe: '${name}' states neither edge`);
}

function refuses(probe: () => void): boolean {
  try {
    probe();
    return false;
  } catch (error) {
    // Only a BOUNDS refusal counts. Any other throw — a TypeError from a
    // changed shape, say — would otherwise read as the clamp working while the
    // probe never reached it, which is the shape of defect this gate exists
    // to catch. `isThresholdBoundViolation` (#766) is the same single-vs-
    // aggregate-shaped match both alert seams gate on — sharing it here means
    // this probe and the two catch sites can never drift apart on what counts
    // as "the clamp".
    return isThresholdBoundViolation(error);
  }
}

/**
 * The threshold-clamp scenario (#638) — negative probes through the REAL seams.
 *
 * ADR-0013 makes the numeric thresholds the only stop left: nothing re-arms by
 * hand and nothing gates a loosening, so a config edit — or, since #736, the
 * Feedback Loop on its own — is the entire distance between the running system
 * and an arbitrary risk limit. Wiring a mechanism means adding its
 * enforcement assertion here (#430), and the enforcement being asserted is a
 * REFUSAL: for every guarded name, an out-of-bound value is pushed at each seam
 * that can put a number into force, and the seam must reject it.
 *
 * The live read is the one that matters. `RiskManagerImpl.evaluate()`
 * re-resolves its config from the `risk_thresholds` table on every call, so a
 * boot-only clamp would constrain nothing the loop does between two ticks.
 */
function runThresholdClampScenario(
  breakerConfig: BreakerConfig,
  riskConfig: RiskConfig,
): ThresholdClampEvidence {
  const db = openSharedStore(':memory:');
  try {
    const store = new SqliteTuningStore(db, new SimulatedClock(SMOKE_RUN_INSTANT));
    const liveReadAccepted: string[] = [];
    const writeDoorAccepted: string[] = [];

    for (const name of GUARDED_THRESHOLD_NAMES) {
      const bad = outOfBoundValueFor(name);
      if (!refuses(() => resolveRiskConfig(riskConfig, { [name]: bad }))) {
        liveReadAccepted.push(name);
      }
      if (!refuses(() => store.setRiskThreshold(name, bad))) {
        writeDoorAccepted.push(name);
      }
    }

    return {
      probedNames: [...GUARDED_THRESHOLD_NAMES],
      liveReadAccepted,
      writeDoorAccepted,
      breakerConstructionRefused: refuses(
        () =>
          new CircuitBreakers({
            ...breakerConfig,
            // The pair the pre-existing relative width check happily accepts:
            // 0.90 is strictly below 0.95, so ordering passes and the drawdown
            // breaker never fires.
            max_drawdown_pct: 0.95,
            auto_rearm: { ...breakerConfig.auto_rearm, recovery_drawdown_pct: 0.9 },
          }),
      ),
      killLineCheckRefused: refuses(() =>
        assertKillThresholdsWithinBounds(
          {
            max_pbo: 0.5,
            min_oos_sharpe: 0.5,
            min_deflated_sharpe: 0.95,
            max_live_backtest_divergence: 0.5,
          },
          'smoke threshold-clamp probe',
        ),
      ),
      // The other half, and the reason this is not a one-sided check: a clamp
      // that refused the shipped configuration would be a broken clamp, and
      // every negative probe above would still pass.
      shippedConfigAccepted: !refuses(() => new CircuitBreakers(breakerConfig)),
      // #766.
      exitBypassesLiveClamp: probeExitBypassesLiveClamp(riskConfig),
    };
  } finally {
    db.close();
  }
}

/** What `evaluateSmokeGate` needs from the approvals-fallback probe (#1152). */
export interface ApprovalFallbackEvidence {
  /** Whether calling `requestApproval` on the uninjected fallback rejected instead of answering. */
  refusedFabricatedConsent: boolean;
  /** The rejection's message, or `null` if it did not reject. */
  message: string | null;
}

/**
 * The approvals-fallback probe (#1152) — the surviving fallback
 * (`UnwiredApprovalChannel`, resolved once by `resolveApprovalsChannel` at
 * composition-root construction) must refuse rather than fabricate consent
 * if Verdict's HITL gate (6) is ever reached.
 *
 * No full-orchestrator TICK can exercise this: ADR-0007's `auto` automation
 * dial makes the gate unreachable on every real tick (`shouldEngageHitl`
 * short-circuits before `approvals.requestApproval` is ever called), so a
 * class that silently went back to fabricating consent would leave every
 * other check in this gate green — #430's defect class exactly, the same
 * reason `runThresholdClampScenario` above reaches its seams directly rather
 * than through a tick.
 *
 * `channel` MUST be read off a real, built `ProductionOrchestrator` /
 * `ProductionComponents` (`orchestrator.approvals` — the caller in
 * `runSmoke`), never reconstructed here by calling `resolveApprovalsChannel`
 * a second time: a probe that built its own instance would prove the
 * HELPER refuses, not that the composition root's own `verdictStepDeps`
 * is actually bound to that refusal. A mutation of `buildProductionComponents`
 * that stopped passing the resolved channel through (while leaving
 * `resolveApprovalsChannel` itself untouched) would go undetected by a
 * self-reconstructing probe; reading the field back off the built
 * orchestrator is what makes it detectable. `production.test.ts`'s
 * `resolveApprovalsChannel` describe block already covers the helper's own
 * logic in isolation — this probe's job is the wiring, not the helper.
 */
async function runApprovalFallbackScenario(
  channel: ApprovalChannel,
): Promise<ApprovalFallbackEvidence> {
  const orderIntent = exitPathOrder(
    'BTC-USD',
    'smoke-approval-fallback-probe',
    'buy',
    'entry',
    1,
    SMOKE_RUN_INSTANT,
  );
  try {
    await channel.requestApproval({
      order_intent: orderIntent,
      risk_decision: approvedRiskDecision(orderIntent),
      trace_id: 'smoke-approval-fallback-probe',
      timeout_ms: 1_000,
    });
    return { refusedFabricatedConsent: false, message: null };
  } catch (error) {
    return {
      refusedFabricatedConsent: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * What `evaluateSmokeGate` needs from the arm-comparison surface (#971).
 *
 * The Feedback Loop's daily timer is 24h and this run lasts seconds, so the
 * orchestrator's own cycle cannot fire here. The probe therefore drives the
 * REAL `runArmComparisonCycle` — the same function `production.ts` calls, over
 * the same `SqliteArmComparisonSource`, `SqliteArmComparisonSampleStore` and
 * thresholds — against the tape this run just traded. Same posture as
 * `runThresholdClampScenario`: when the shipped timer cannot be reached inside
 * a smoke run, the gate exercises the shipped classes directly rather than
 * asserting nothing.
 */
export interface ArmComparisonEvidence {
  /** Both arms as computed. `null` only if the cycle produced no comparison at all. */
  live: ArmPerformance | null;
  control: ArmPerformance | null;
  /** Rows read back out of `arm_comparison_samples` — 0 means nothing persisted. */
  persistedRows: number;
  /** Whether the drawdown column survived the round trip on BOTH arms. */
  persistedBothDrawdowns: boolean;
  diverged: boolean;
  /** Divergence alerts that reached the injected channel. */
  alerts: number;
  /**
   * The comparison itself, so the outside-benchmark probe can be handed the
   * SAME window rather than recomputing one that merely looks equal (#981).
   */
  comparison: ArmComparison;
}

/**
 * What `evaluateSmokeGate` needs from the outside-benchmark surface (#981).
 *
 * Same posture and same reason as `ArmComparisonEvidence` above: FL's daily
 * timer cannot fire inside a seconds-long run, so the gate drives the shipped
 * `runOutsideBenchmarkCycle` directly over this run's own store.
 */
export interface OutsideBenchmarkEvidence {
  /** Benchmarks the cycle measured — 0 means the mechanism produced nothing. */
  measured: number;
  /** Rows read back out of `outside_benchmark_samples` — 0 means nothing persisted. */
  persistedRows: number;
  /** Whether return AND drawdown both survived the round trip on every row (D4). */
  persistedBothColumns: boolean;
  /**
   * Whether every persisted row's window is the arm comparison's own window,
   * to the millisecond. The one property #636 turns on: a benchmark measured
   * over an approximate window is noise, not a comparison.
   */
  windowsMatchArmComparison: boolean;
  /** Benchmarks the cycle could not measure, with reasons — for the report. */
  unmeasured: readonly string[];
}

/**
 * Whether `scheduleFeedbackCycle` (production.ts, #1110) actually ran inside
 * THIS run's `start()`/`stop()` — read from the same store, after `stop()`
 * drains everything. Unlike `runArmComparisonProbe` below, this reads no
 * shipped class directly: `feedback_cycle_schedule.last_boundary` is written
 * ONLY by the composition root's own timer, so a row present here is
 * evidence the real scheduler ran, not evidence a probe standing in for it
 * ran.
 */
function feedbackCycleScheduleWasWritten(db: SqliteHandle): boolean {
  return new SqliteFeedbackCycleScheduleStore(db).lastBoundary() !== null;
}

/**
 * #1112 AC5 — see the `sizingCeiling` branches in `evaluateSmokeGate`.
 *
 * Filtered to `BTC-USD`, `SMOKE_TEST_UNIVERSE`'s only instrument: the exit
 * scenarios below trade five OTHER underlyings through their own
 * directly-constructed `SqliteExecutionStore`s, sharing this run's database
 * but not its `config.capitalCeilingUsd` — including them would let a
 * genuinely broken composition-root wire pass on the exit scenarios' rows
 * alone.
 *
 * Both tables, because a lot that opened and closed inside the run leaves
 * `open_positions` empty and `closed_trades` populated; reading only the
 * former would report "the wire is broken" for a run that merely finished its
 * position, which is a misdiagnosis, not a gate.
 *
 * Compared against the run's own `config.capitalCeilingUsd` rather than
 * null-checked: a wire that stamps any non-null number — a literal that has
 * drifted from the config, another store's ceiling — is exactly the defect
 * this field exists to catch, and a null check passes it.
 */
export type SizingCeilingEvidence = {
  /** `paperStartingProfile('paper').capitalCeilingUsd` for this run — `undefined` is itself the #1112 defect. */
  configuredCeiling: number | undefined;
  /** BTC-USD rows across both tables; zero is no-evidence, not a passing gate. */
  rows: number;
  allMatchConfiguredCeiling: boolean;
};

function readSizingCeilingStamps(
  db: SqliteHandle,
  expected: number | undefined,
): SizingCeilingEvidence {
  const rows = db
    .prepare(
      `SELECT sizing_capital_ceiling FROM open_positions WHERE instrument = 'BTC-USD'
       UNION ALL
       SELECT sizing_capital_ceiling FROM closed_trades WHERE instrument = 'BTC-USD'`,
    )
    .all() as { sizing_capital_ceiling: number | null }[];

  return {
    configuredCeiling: expected,
    rows: rows.length,
    allMatchConfiguredCeiling:
      expected !== undefined && rows.every((row) => row.sizing_capital_ceiling === expected),
  };
}

/**
 * #1140 — what the DASHBOARD would read as this run's LLM cap.
 *
 * Read through `SqliteQueryStore.getLlmSpend`, the shipped read that fills
 * `DashboardSnapshot.llm_spend`, rather than off `llm_spend_cap` directly:
 * the ticket's defect is a denominator that agrees with the enforcer by luck,
 * and only the whole path — composition root writes, dashboard's own query
 * reads — falsifies it. Dropping `publishedSpendCap.arm(...)` from
 * `production.ts`, or defaulting the field in the query layer, makes this
 * disagree with the run's own profile while every other check stays green.
 *
 * `capArmedAt` rides along for #1196: a real booted run always arms (either
 * branch of `production.ts`'s `if/else`), so a real smoke run reading `null`
 * here means the wire's "never armed" case leaked into a process that DID
 * boot — `armed_at` stopped being read on the path that fills the wire.
 */
function readPublishedLlmCap(db: SqliteHandle): {
  capUsd: number | null;
  capArmedAt: string | null;
} {
  const spend = new SqliteQueryStore(db).getLlmSpend(SMOKE_RUN_INSTANT);
  return { capUsd: spend.cap_usd, capArmedAt: spend.cap_armed_at };
}

/** Drives the shipped arm-comparison cycle over the smoke run's own store. */
export function runArmComparisonProbe(db: SqliteHandle): ArmComparisonEvidence {
  let alerts = 0;
  const samples = new SqliteArmComparisonSampleStore(db);
  const sample = runArmComparisonCycle({
    clock: new SimulatedClock(SMOKE_RUN_INSTANT),
    trades: new SqliteArmComparisonSource(db),
    samples,
    alerts: {
      postArmDivergenceAlert: () => {
        alerts += 1;
      },
    },
    basis: LIVE_BOOK_SIZING_USD,
    window_ms: DEFAULT_ARM_COMPARISON_WINDOW_MS,
    thresholds: DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  });

  const persisted = samples.getRecent(5, SMOKE_RUN_INSTANT);
  return {
    live: sample.comparison.live,
    control: sample.comparison.control,
    persistedRows: persisted.length,
    persistedBothDrawdowns: persisted.every(
      (row) =>
        Number.isFinite(row.comparison.live.max_drawdown_pct) &&
        Number.isFinite(row.comparison.control.max_drawdown_pct),
    ),
    diverged: sample.divergence.diverged,
    alerts,
    comparison: sample.comparison,
  };
}

/**
 * A deterministic, offline stand-in for the benchmark vendor (#981).
 *
 * The live source is `MarketDataBenchmarkSeriesSource` over the already-wired
 * Alpaca daily bars (SPY and AGG were verified obtainable there on 2026-09-01).
 * A smoke run makes no network call, so — exactly as it fabricates the Alpaca
 * wire everywhere else — it hands the shipped cycle a fixture series instead.
 *
 * The closes below are NOT a claim about SPY or AGG. They exist so the gate can
 * assert the WIRING: that the cycle computes, persists, round-trips both
 * columns, and inherits the arm comparison's window. Nothing downstream of the
 * gate reads these numbers, and nothing writes them anywhere a real benchmark
 * reading is served from.
 */
const SMOKE_BENCHMARK_DAY_MS = 24 * 60 * 60 * 1000;

class FixtureBenchmarkSeriesSource implements BenchmarkSeriesSource {
  /** Per-day drift, so the two legs are distinguishable and neither is flat. */
  private static readonly DRIFT: Record<string, number> = { SPY: 0.001, AGG: 0.0002 };

  async getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]> {
    // Three days of pad before `from` so the anchor bar the computation
    // requires exists — the same surplus the real source over-fetches for.
    const start = from.getTime() - 3 * SMOKE_BENCHMARK_DAY_MS;
    const drift = FixtureBenchmarkSeriesSource.DRIFT[instrument] ?? 0.0005;
    const observations: BenchmarkObservation[] = [];
    let close = 100;
    for (let t = start; t <= to.getTime(); t += SMOKE_BENCHMARK_DAY_MS) {
      // A single mid-series dip, so `max_drawdown_pct` is a real reading rather
      // than the 0 a monotonic series would always produce.
      const step = observations.length === 7 ? -0.01 : drift;
      close *= 1 + step;
      observations.push({ close_time: new Date(t), close });
    }
    return observations;
  }
}

/** Drives the shipped outside-benchmark cycle over the arm comparison's window. */
async function runOutsideBenchmarkProbe(
  db: SqliteHandle,
  comparison: ArmComparison,
): Promise<OutsideBenchmarkEvidence> {
  const samples = new SqliteOutsideBenchmarkSampleStore(db);
  const result = await runOutsideBenchmarkCycle({
    clock: new SimulatedClock(SMOKE_RUN_INSTANT),
    comparison,
    series: new FixtureBenchmarkSeriesSource(),
    samples,
  });

  const persisted = samples.getRecent(10, SMOKE_RUN_INSTANT);
  return {
    measured: result.measured.length,
    persistedRows: persisted.length,
    persistedBothColumns: persisted.every(
      (row) =>
        Number.isFinite(row.performance.buy_and_hold_return_pct) &&
        Number.isFinite(row.performance.max_drawdown_pct),
    ),
    windowsMatchArmComparison:
      persisted.length > 0 &&
      persisted.every(
        (row) =>
          row.from.getTime() === comparison.from.getTime() &&
          row.to.getTime() === comparison.to.getTime(),
      ),
    unmeasured: result.unmeasured.map((entry) => `${entry.benchmark}: ${entry.reason}`),
  };
}

/** What `evaluateSmokeGate` needs from the OHLCV failover scenario (#562). */
export interface DataFailoverEvidence {
  /** `bars.source` values the store holds for the failed-over instrument, in `open_time` order. */
  storedSources: readonly string[];
  /** `open_time`s the store holds, ISO — so an out-of-session row is visible, not merely counted. */
  storedOpenTimes: readonly string[];
  /** Failover alerts that reached the injected channel. */
  alerts: readonly DataFailoverAlert[];
  /** The primary's throw, if the read failed outright instead of failing over. */
  readError: string | null;
}

/**
 * Regular-hours `1h` opens on the last trading session completed before
 * `SMOKE_RUN_INSTANT` (Tuesday 08:00 ET), plus one PRE-MARKET open the vendor
 * would also serve. The pre-market row is the negative half: the fallback must
 * drop it, because the primary's own `NormalizingDataSource` would have.
 */
const FAILOVER_FIXTURE_OPEN_TIMES = [
  '2026-08-03T09:00:00.000Z',
  '2026-08-03T18:00:00.000Z',
  '2026-08-03T19:00:00.000Z',
] as const;

export const FAILOVER_IN_SESSION_OPEN_TIMES: readonly string[] =
  FAILOVER_FIXTURE_OPEN_TIMES.slice(1);

/**
 * The OHLCV failover's enforcement assertion (#562), per the standard that
 * wiring a mechanism means asserting it HERE (#430).
 *
 * Driven through `buildProductionOrchestrator` — the real composition root —
 * with a market-data client that cannot answer and a fallback fetcher that
 * can, against a COLD `:memory:` store so the read cannot be satisfied from
 * the Tier-2 cache. Deleting the root's `buildFailoverDataSource` call makes
 * this scenario record the primary's throw and the gate FAIL, which a unit
 * test of the wrapper cannot do by construction.
 *
 * It asserts the DURABLE effect, not construction: a `bars` row stamped
 * `polygon`, and no out-of-session row beside it.
 */
async function runDataFailoverScenario(logger: Logger): Promise<DataFailoverEvidence> {
  const db = openSharedStore(':memory:');
  try {
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const profile = paperStartingProfile('paper');
    const alerts: DataFailoverAlert[] = [];

    const orchestrator = buildProductionOrchestrator({
      ...profile,
      db,
      clock,
      logger,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      // The REAL equity calendar, not this run's `AlwaysOpenCalendar`
      // override: an always-open calendar would drop nothing, and the
      // out-of-session half of this probe would pass vacuously.
      tradingCalendar: new UsEquityRegularHoursCalendar(),
      stocksTradingWindow: () => true,
      // The stall being survived.
      alpacaDataClient: {
        getBars: async () => {
          throw new Error('alpaca 503 (smoke failover probe)');
        },
        getLatestQuote: async () => ({ t: SMOKE_RUN_INSTANT.toISOString(), ap: 100, bp: 99 }),
      },
      // The vendor's own coverage: extended hours included, uncalendared.
      equitiesFallbackBarFetcher: async (symbol, window) =>
        FAILOVER_FIXTURE_OPEN_TIMES.map((openTime): Bar => {
          const open_time = new Date(openTime);
          return {
            instrument: symbol,
            timeframe: window.timeframe,
            open_time,
            close_time: new Date(open_time.getTime() + 3_600_000),
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 1_000,
            source: 'polygon',
          };
        }),
      dataFailoverAlerts: {
        postDataFailoverAlert: async (alert) => {
          alerts.push(alert);
        },
      },
      miArchive: new MiArchiveStore(),
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient: new UnreachableAlpacaClient(),
      llmClient: new ConstantResponseLlmClient(),
    });

    let readError: string | null = null;
    try {
      await orchestrator.marketData.getBars(
        'SPY',
        { timeframe: '1h', lookback: 2 },
        SMOKE_RUN_INSTANT,
      );
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }

    const stored = db
      .prepare('SELECT open_time, source FROM bars WHERE instrument = ? ORDER BY open_time')
      .all('SPY') as { open_time: string; source: string }[];

    return {
      storedSources: stored.map((row) => row.source),
      storedOpenTimes: stored.map((row) => new Date(row.open_time).toISOString()),
      alerts,
      readError,
    };
  } finally {
    db.close();
  }
}

/** What `evaluateSmokeGate` needs from the analyst failure-cause scenario (#1114). */
export interface AnalystFailureCauseEvidence {
  /** Every `stage: 'analysts', level: 'debug'` payload the run's own `AnalystOrchestrator` recorded. */
  debugPayloads: readonly Record<string, unknown>[];
  /** The run's own `AnalystRunResult.failures[].kind` values, so the gate can tell a genuine rejection happened rather than trusting the payloads alone. */
  failureKinds: readonly string[];
}

/**
 * Records every `stage: 'analysts', level: 'debug'` line on the way to the
 * real logger — the one channel #1114's cause-logging mechanism reaches.
 * Mirrors `FillSyncFailureRecorder`'s shape: scoped to the hole it closes,
 * never throws itself, and passes everything through to `inner` unchanged.
 */
class AnalystDebugRecorder implements Logger {
  private readonly payloads: Record<string, unknown>[] = [];

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.stage === 'analysts' && entry.level === 'debug') {
      this.payloads.push((entry.payload ?? {}) as Record<string, unknown>);
    }
    this.inner.log(entry);
  }

  evidence(failureKinds: readonly string[]): AnalystFailureCauseEvidence {
    return { debugPayloads: [...this.payloads], failureKinds };
  }
}

/**
 * #1114's enforcement assertion, per the standard that wiring a mechanism
 * means asserting it HERE (#430).
 *
 * Driven through `buildProductionOrchestrator` — the same real composition
 * root `runDataFailoverScenario` above uses — with BOTH the primary AND the
 * equities fallback throwing, so the technical analyst's `market_data.getBars`
 * genuinely REJECTS (a real combined error carrying a `.cause` chain,
 * `ohlcv-failover.ts`'s `withOhlcvFailover`) rather than timing out.
 *
 * That choice is deliberate, not an oversight of the timeout path: #1114's
 * own soak tally found 100% of the historical failures were timeouts, and a
 * timeout's cause is unrecoverable by construction at the point it is
 * detected (see `withTimeout`'s doc comment in `pipeline/analysts/
 * orchestrator.ts`) — proving THAT path fired for real here would mean
 * waiting out a genuine multi-second deadline inside every `yarn smoke` run
 * for a probe that cannot assert anything a fake-timer unit test
 * (`orchestrator.test.ts`, "failure cause logging (#1114)") doesn't already
 * mutation-test more cheaply. The non-timeout half is the one this gate CAN
 * prove in milliseconds, through the exact composition root and the exact
 * `AnalystOrchestrator` instance `production.ts` builds — which is also
 * literally what the ticket asks for (a non-timeout rejection's collapsed
 * detail), just not the headline failure mode.
 *
 * Asserted on the DURABLE effect, not construction: the `debug` payloads the
 * real `AnalystOrchestrator` recorded through the real `logger` `production.ts`
 * wires into it via `new AnalystOrchestrator({ ..., logger })`. Delete that
 * one field and this scenario records nothing (the orchestrator falls back to
 * its internal `NOOP_LOGGER`) — the gate's whole point.
 */
async function runAnalystFailureCauseScenario(
  logger: Logger,
): Promise<AnalystFailureCauseEvidence> {
  const db = openSharedStore(':memory:');
  const recorder = new AnalystDebugRecorder(logger);
  try {
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const profile = paperStartingProfile('paper');
    const signal = { asset: 'SPY', asset_class: 'stocks' as const };

    const orchestrator = buildProductionOrchestrator({
      ...profile,
      db,
      clock,
      logger: recorder,
      universe: [{ asset: signal.asset, asset_class: signal.asset_class }],
      tradingCalendar: new UsEquityRegularHoursCalendar(),
      stocksTradingWindow: () => true,
      // Both legs down — see the doc comment above for why a double failure,
      // not a single one that would fail over cleanly like
      // `runDataFailoverScenario`'s probe.
      alpacaDataClient: {
        getBars: async () => {
          throw new Error('alpaca down (smoke analyst-failure-cause probe, #1114)');
        },
        getLatestQuote: async () => ({ t: SMOKE_RUN_INSTANT.toISOString(), ap: 100, bp: 99 }),
      },
      equitiesFallbackBarFetcher: async () => {
        throw new Error('polygon down too (smoke analyst-failure-cause probe, #1114)');
      },
      dataFailoverAlerts: {
        postDataFailoverAlert: async () => {},
      },
      miArchive: new MiArchiveStore(),
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient: new UnreachableAlpacaClient(),
      llmClient: new ConstantResponseLlmClient(),
    });

    const result = await orchestrator.analysts.runAnalysts(
      'smoke-analyst-failure-cause',
      signal,
      clock,
      SMOKE_RUN_INSTANT,
    );

    return recorder.evidence(result.failures.map((failure) => failure.kind));
  } finally {
    db.close();
  }
}

/** What `evaluateSmokeGate` needs from the FILLED_WITH_ZERO_SIZE wedge scenario (#1125). */
export interface FilledZeroSizeWedgeEvidence {
  /** Every FILLED_WITH_ZERO_SIZE payload the scenario's own recorder captured, in poll order. */
  warnings: readonly {
    idempotency_key: string;
    instrument: string;
    order_state: string;
    consecutive: number;
    stuck_ms: number;
  }[];
}

/** The lot `runFilledZeroSizeWedgeScenario` seeds — named here so the gate check below can pin it. */
const FILLED_ZERO_SIZE_WEDGE_LOT_KEY = 'smoke-filled-zero-size-wedge';
const FILLED_ZERO_SIZE_WEDGE_INSTRUMENT = 'AAPL';
/** How far before the scenario's fixed clock the lot opened — arbitrary but deterministic, giving a nonzero `stuck_ms`. */
const FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS = 60 * 60_000;
/**
 * How far before `opened_at` the decision was made — kept DISTINCT from it
 * (never the same Date) so a swap of the two fields at the call site is
 * something the gate could in principle catch, rather than invisible because
 * both carried an identical value.
 */
const FILLED_ZERO_SIZE_WEDGE_DECISION_BEFORE_OPENED_MS = 5_000;

/**
 * Records every FILLED_WITH_ZERO_SIZE line on the way to the real logger —
 * the one channel #1087's throttled wedge-detector reaches. Mirrors
 * `AnalystDebugRecorder`'s shape (#1114): scoped to the one message this
 * scenario exists to prove, never throws itself, passes everything through.
 */
class FilledZeroSizeWarningRecorder implements Logger {
  private readonly warnings: FilledZeroSizeWedgeEvidence['warnings'][number][] = [];

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.message === FILLED_WITH_ZERO_SIZE) {
      this.warnings.push(entry.payload as FilledZeroSizeWedgeEvidence['warnings'][number]);
    }
    this.inner.log(entry);
  }

  evidence(): FilledZeroSizeWedgeEvidence {
    return { warnings: [...this.warnings] };
  }
}

/**
 * The second broker/harness surface #1125 asked for: a `BrokerAdapter` that
 * reports a lot `filled` while never surfacing its own fill. `fetchNewFills`
 * below applies its own `since` filter, matching a real broker's contract —
 * it is handed the SAME `since` `ingest-fills.ts`'s floor computed (this
 * lot's own `opened_at`, since it is the store's sole open position), and
 * the scripted fill is dated 1ms BEFORE that, so the filter excludes it on
 * every poll: `fetchNewFills` returns `[]` forever, never returning the
 * fill to the caller at all. One way to wedge a lot at zero `filled_size`
 * forever, not the only one — a non-entry-leg fill or a zero-qty entry fill
 * would wedge it identically; this one reproduces #1087's own incident
 * shape. Same shape as `filled-zero-size-wiring.test.ts`'s `WedgingBroker`,
 * which proves a DIFFERENT property (the throttle is SHARED across two
 * surfaces built from one `executionDeps`) against the composition root
 * directly; this class exists to drive the same wedge through `yarn
 * smoke`'s own gate instead.
 *
 * `SimulatedBrokerAdapter` cannot produce this post-#1087 — it now stamps
 * every fill at submit time, which is the fix — so no scripting of the
 * exit-path harness's own `innerBroker` could ever reach this branch. The
 * wedge is a broker-side invariant violation, not a missing feature of
 * `SimulatedBrokerAdapter`'s cost/market-data machinery, so this broker needs
 * none of it: every method beyond `getOrder`/`fetchNewFills` throws, so an
 * unexpected call fails loudly rather than returning a silently-wrong stub.
 */
class SmokeWedgedLotBroker implements BrokerAdapter {
  constructor(
    private readonly order: NormalizedOrder,
    private readonly scriptedFills: NormalizedFill[],
  ) {}

  async submitBracket(): Promise<BrokerAck> {
    throw new Error(
      'SmokeWedgedLotBroker.submitBracket: this scenario seeds its position directly',
    );
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return this.order;
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.scriptedFills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('SmokeWedgedLotBroker.resizeProtectiveLegs: no new fill is ever ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error(
      'SmokeWedgedLotBroker.rearmProtectiveLegs: no partial flatten in this scenario',
    );
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    throw new Error(
      'SmokeWedgedLotBroker.resumeFlatten: reconcile() has nothing unresolved to sweep',
    );
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('SmokeWedgedLotBroker.submitFlatten: this scenario never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('SmokeWedgedLotBroker.cancel: this scenario never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

/**
 * #1125 — the second broker/harness surface the #1096 review deferred:
 * drives a genuinely wedged lot through the REAL `ingestFills()`/throttle
 * path (`buildExecutionSurface`, the same binding `production.ts` uses), on
 * its own composition root and its own cold `:memory:` store, so the
 * exit-path harness's single shared `innerBroker` is never in the way.
 *
 * `reconcile()` adopts the broker's `filled` state first (matching #1087's
 * own incident shape: the venue reported the fill before the feed surfaced
 * it), then `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE` consecutive `ingestFills()`
 * polls — each seeing the same excluded-forever fill — reach the throttle's
 * first warning. `costModel`/`marketData` are never consulted on this path
 * (verified by reading ingest-fills.ts/reconcile.ts before building this —
 * neither file references `input.config`, `costModel` or `marketData`): the
 * empty cast below rests on that reading, not on itself as proof — a cast to
 * `unknown` only guarantees an unexpected METHOD call throws, not that a
 * stray property read would be caught (it would return `undefined` and
 * likely fail elsewhere, less legibly). Same convention
 * `filled-zero-size-wiring.test.ts`'s `stubConfig` uses for the fields its
 * own scenario never reaches.
 */
async function runFilledZeroSizeWedgeScenario(
  logger: Logger,
): Promise<FilledZeroSizeWedgeEvidence> {
  const db = openSharedStore(':memory:');
  try {
    const recorder = new FilledZeroSizeWarningRecorder(logger);
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const openedAt = new Date(
      SMOKE_RUN_INSTANT.getTime() - FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS,
    );
    const brokerOrderIds = [
      `${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}:entry`,
      `${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}:stop`,
      `${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}:target`,
    ];
    const broker = new SmokeWedgedLotBroker(
      {
        client_order_id: FILLED_ZERO_SIZE_WEDGE_LOT_KEY,
        broker_order_ids: brokerOrderIds,
        order_state: 'filled',
        filled_qty: 10,
      },
      [
        {
          client_order_id: FILLED_ZERO_SIZE_WEDGE_LOT_KEY,
          broker_fill_id: 'smoke-wedge-fill',
          leg: 'entry',
          qty: 10,
          price: 100,
          fee: 1,
          // Dated before this lot's OWN `opened_at` — with this the store's
          // sole open position, `opened_at` IS the poll's `since` floor
          // (ingest-fills.ts), so this fill is excluded FOREVER, exactly
          // #1087's incident shape.
          timestamp: new Date(openedAt.getTime() - 1),
        },
      ],
    );
    const store = new SqliteExecutionStore(db);
    const position: OpenPosition = {
      idempotency_key: FILLED_ZERO_SIZE_WEDGE_LOT_KEY,
      debate_id: 'smoke-filled-zero-size-wedge-debate',
      instrument: FILLED_ZERO_SIZE_WEDGE_INSTRUMENT,
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10,
      filled_size: 0,
      avg_entry_price: 0,
      stop: 95,
      target: 110,
      order_state: 'submitted',
      broker_order_ids: brokerOrderIds,
      opened_at: openedAt,
      decision_timestamp: new Date(
        openedAt.getTime() - FILLED_ZERO_SIZE_WEDGE_DECISION_BEFORE_OPENED_MS,
      ),
      conviction: 0.7,
      converged: true,
    };
    await store.writeAheadPosition(position);

    const execution = buildExecutionSurface(
      {
        clock,
        broker,
        store,
        costModel: {} as unknown as CostModel,
        marketData: {} as unknown as MarketDataService,
        config: paperStartingProfile('paper').executionConfig,
        mode: 'paper',
        residualExposureAlerts: {
          postResidualExposureAlert: async () => {
            throw new Error('SmokeWedgedLotBroker: this scenario never partially flattens');
          },
        },
        flattenOverfillAlerts: {
          postFlattenOverfillWarning: async () => {
            throw new Error('SmokeWedgedLotBroker: this scenario never flattens');
          },
        },
        flattenReconcileAlerts: {
          postFlattenReconcileAlert: async () => {
            throw new Error('SmokeWedgedLotBroker: this scenario never flattens');
          },
        },
        logger: recorder,
        filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      },
      'smoke-filled-zero-size-wedge',
    );

    await execution.reconcile();
    for (let poll = 0; poll < ALERT_AFTER_CONSECUTIVE_ZERO_SIZE; poll += 1) {
      await execution.ingestFills();
    }

    return recorder.evidence();
  } finally {
    db.close();
  }
}

/** What `evaluateSmokeGate` needs from the risk-critic scenario (#957, extended by the invalidation fold #994). */
export interface RiskCriticEvidence {
  /** `risk_critic_log.verdict` values the run's own composition root wrote, in insertion order. */
  loggedVerdicts: readonly string[];
  /** The step's throw, if consulting the critic took the risk stage down instead of failing open. */
  stepError: string | null;
  /** `state` of every persisted invalidation condition — MEASURED by `invalidation.ts`, never asserted by the model (#994). */
  conditionStates: readonly string[];
  /** The decision's `binding_constraint`. `risk_critic:invalidated` is the fold's own enforcement path. */
  bindingConstraint: string | null;
}

/**
 * The one LLM double in the smoke process, answering BOTH call sites (#994).
 *
 * The shared debate fixture does not satisfy the critic's parser, so before
 * the fold the critic could only ever be observed failing open. That is enough
 * to prove the producer is wired, and NOT enough to prove the invalidation
 * half runs: a conditions block that is never emitted is measured by nothing,
 * and "conditions never fire" is precisely this repo's dominant defect shape.
 *
 * So this client branches on the attribution stage the producer already sets
 * for metering, and hands the critic call one well-formed condition whose
 * outcome is FIXED BY THE FIXTURE: the mark is `SMOKE_MARK_PRICE`, the
 * threshold sits one unit above it, and `<` on a `buy` is the coherent
 * direction — so a correctly wired evaluator must measure `breached`, and
 * `evaluate()` must reject under its own constraint. Nothing here asserts a
 * state; the state is measured from the same fixture feed the rest of the run
 * uses.
 */
export class SmokeLlmClient implements LlmClient {
  readonly #debate = new ConstantResponseLlmClient();

  get calls(): number {
    return this.#debate.calls;
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    if (request.context.attribution?.stage !== 'risk_critic') {
      return this.#debate.complete(request);
    }
    const rawText = JSON.stringify({
      verdict: 'pass',
      max_notional: null,
      reasoning: 'smoke fixture: no narrative risk, one falsifying condition',
      conditions: [
        {
          id: 'smoke-thesis-needs-price-above-threshold',
          observable: { kind: 'mark' },
          comparator: '<',
          threshold: SMOKE_MARK_PRICE + 1,
          rationale: 'below this the breakout that justified the entry has already failed',
        },
      ],
    });
    const parsed = request.parseResponse(rawText);
    if (!parsed.valid) {
      throw new Error(
        `SmokeLlmClient: the critic fixture no longer satisfies the critic parser ` +
          `(${parsed.reason}) — the stub payload and the critic schema have drifted apart.`,
      );
    }
    return { data: parsed.data, raw_text: rawText, latency_ms: 0 };
  }
}

/**
 * The risk critic's enforcement assertion (#957), per the standard that wiring
 * a mechanism means asserting it HERE (#430).
 *
 * Driven through the REAL `buildProductionComponents` — the composition root
 * that owns the one `critic:` line — and asserted on the DURABLE effect: a
 * `risk_critic_log` row for the intent's `debate_id`. Delete that line and this
 * scenario records nothing and the gate FAILS, which is the whole point: this
 * repo's dominant defect class is a built, tested, wired mechanism nothing
 * external ever asserts fires (#388, #364, #562), and step 7 spent its entire
 * life so far in exactly that state (docs/reviews/triage-2026-08-06.md F-5).
 *
 * The fold (#994) is asserted too, not just the wiring. `SmokeLlmClient`
 * answers the `risk_critic` stage — and only that stage — with a `pass` prose
 * verdict carrying one condition the fixture mark already violates
 * (`mark < SMOKE_MARK_PRICE + 1`, against a fixture mark of
 * `SMOKE_MARK_PRICE`). So the gate can assert content without drifting with
 * the shared debate fixture: the persisted condition must read `breached`,
 * proving deterministic code measured it rather than trusting the model, and
 * the decision's binding constraint must be `risk_critic:invalidated`, proving
 * a measured breach rejects an intent whose prose verdict said `pass`.
 */
async function runRiskCriticScenario(logger: Logger): Promise<RiskCriticEvidence> {
  const db = openSharedStore(':memory:');
  try {
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const profile = paperStartingProfile('paper');
    const dataSource = new FixtureDataSource(
      buildSmokeFixtureBars(),
      { price: SMOKE_MARK_PRICE, observed_at: SMOKE_RUN_INSTANT, source: 'smoke-fixture' },
      'crypto',
      {
        bid: SMOKE_MARK_PRICE - 0.5,
        ask: SMOKE_MARK_PRICE + 0.5,
        observed_at: SMOKE_RUN_INSTANT,
      },
    );

    const components = buildProductionComponents({
      ...profile,
      db,
      clock,
      logger,
      universe: SMOKE_TEST_UNIVERSE,
      tradingCalendar: new AlwaysOpenCalendar(),
      stocksTradingWindow: () => true,
      dataSource,
      miArchive: new MiArchiveStore(),
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient: new UnreachableAlpacaClient(),
      llmClient: new SmokeLlmClient(),
    });

    // A viable ENTRY — the population #955's cadence names. An exit would
    // bypass the entry gates and never reach step 7, so it would prove
    // nothing about the wiring. Size 1 rather than a dust lot on purpose: at
    // `SMOKE_MARK_PRICE` that is $160 of notional, clear of the profile's own
    // `min_viable_size` floor, which rejects ABOVE step 7 (a 0.01 lot bound on
    // `min_viable_size` here and the critic was correctly never asked).
    const intent = exitPathOrder(
      SMOKE_INSTRUMENT,
      'smoke-risk-critic-entry',
      'buy',
      'entry',
      1,
      SMOKE_RUN_INSTANT,
    );

    let stepError: string | null = null;
    let bindingConstraint: string | null = null;
    try {
      const decision = await components.steps.risk({
        trace_id: 'smoke-risk-critic',
        intent,
        clock,
      });
      bindingConstraint = decision.binding_constraint;
    } catch (error) {
      stepError = error instanceof Error ? error.message : String(error);
    }

    const logged = db
      .prepare('SELECT verdict, conditions_json FROM risk_critic_log ORDER BY rowid')
      .all() as { verdict: string; conditions_json: string | null }[];

    return {
      loggedVerdicts: logged.map((row) => row.verdict),
      stepError,
      conditionStates: logged.flatMap((row) => readSmokeConditionStates(row.conditions_json)),
      bindingConstraint,
    };
  } finally {
    db.close();
  }
}

/** What `evaluateSmokeGate` needs from the prompt-tier-crossing scenario (#1155). */
export interface PromptTierWarningEvidence {
  /** `postPromptTierAlert` calls the real channel observed — should be exactly 1 (see the scenario's own doc). */
  alertsFired: number;
  /** `llm_spend` rows the crossing call itself wrote, over the SAME store the alert channel is wired into. */
  spendRows: number;
  /** The crossing call's persisted `cost_usd` — the tier RATE actually applied, not just the warning. */
  costUsd: number | null;
}

/**
 * #1155's producer, asserted on its DURABLE effect through the real
 * `SqliteLlmSpendStore` — the same "own composition root, own cold
 * `:memory:` store" pattern `runRiskCriticScenario` and
 * `runDataFailoverScenario` use for a mechanism the six-stage tick loop above
 * cannot exercise for real: `ConstantResponseLlmClient`/`SmokeLlmClient`
 * (this file) implement `LlmClient` directly and carry no `usage` field at
 * all, so no metered call — let alone a tiered one — happens anywhere else in
 * this process.
 *
 * `record()` is called directly rather than through a fabricated
 * `AnthropicMessagesClient` wrapped in `AnthropicLlmClient`: the gap #1155
 * closes is entirely inside `SqliteLlmSpendStore.record` (whether it calls
 * `crossesPromptTier` and dispatches), and `AnthropicLlmClient`'s own usage
 * extraction is unchanged and already covered by anthropic-client.test.ts.
 * Only the INPUT — "the provider reported this many prompt tokens" — is
 * fabricated here, the same relationship `FixtureDataSource` has to the
 * indicators computed over its bars: the mechanism under test runs for real,
 * for a real tiered model (`x-ai/grok-4.5`, pricing.ts), against a real
 * `:memory:` `llm_spend` table, through the real `crossesPromptTier` and the
 * real throttle, into a channel double that only counts calls — the same
 * "hand-rolled alert channel" shape `runArmComparisonProbe` above uses for
 * `postArmDivergenceAlert`.
 *
 * Two crossing calls, not one: the FIRST call alone cannot distinguish a
 * throttle that fires once from one deleted outright (both would show
 * `alertsFired: 1` after a single call), which is exactly the "vacuous either
 * way" shape #1155's own instructions warn against. The second call, on the
 * SAME model, must be suppressed — `alertsFired` staying at 1 proves the
 * throttle ran, not just that a crossing was dispatched once.
 */
function runPromptTierWarningScenario(): PromptTierWarningEvidence {
  const db = openSharedStore(':memory:');
  try {
    const alerts: PromptTierAlert[] = [];
    const store = new SqliteLlmSpendStore(db, undefined, false, {
      postPromptTierAlert: (alert) => {
        alerts.push(alert);
      },
    });

    // 200,001 prompt tokens against x-ai/grok-4.5's published 200,000-token
    // large-prompt tier (pricing.ts) — one token over, the same fixture
    // pricing.test.ts pins `crossesPromptTier`'s own answer against.
    const crossingUsage = { input_tokens: 200_001, output_tokens: 1_000 };
    const record = () =>
      store.record({
        trace_id: 'smoke-prompt-tier',
        stage: 'debate',
        model: 'x-ai/grok-4.5',
        usage: crossingUsage,
        latency_ms: 10,
        timestamp: SMOKE_RUN_INSTANT,
      });

    record();
    record();

    const rows = db.prepare('SELECT cost_usd FROM llm_spend ORDER BY id').all() as {
      cost_usd: number | null;
    }[];

    return {
      alertsFired: alerts.length,
      spendRows: rows.length,
      costUsd: rows[0]?.cost_usd ?? null,
    };
  } finally {
    db.close();
  }
}

/** Reads persisted condition states for the gate, tolerating a NULL or unreadable column exactly as the replay path does. */
function readSmokeConditionStates(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String((entry as { state?: unknown }).state));
  } catch {
    return [];
  }
}

export function evaluateSmokeGate(
  observations: SmokeObservations,
  options: {
    minTicks: number;
    /**
     * Whether anything reached `UnreachableAlpacaClient`. Checked here rather
     * than left to the throw, because `startTickLoop` catches everything a tick
     * throws and logs it — so a run that tried to reach the network would
     * otherwise fail the gate for a downstream symptom (no verdict, no fill)
     * and never name the cause.
     */
    alpacaWireClientReached?: boolean;
    /**
     * `RateLimiter.snapshot()` after the run — how many LLM calls the process's
     * limiter actually metered (#388).
     *
     * Checked here, alongside `alpacaWireClientReached`, and for the same
     * reason: it is an effect of the run that no table records. #388 WAS a
     * fully-implemented, fully-unit-tested component with no production
     * caller, and every one of 1800+ unit tests passed throughout — the same
     * shape as #364, whose `debate_log` assertion in this gate is the only
     * check that has ever caught it. A limiter that metered nothing while
     * debates were resolving is that defect, exactly.
     *
     * **REQUIRED, unlike `alpacaWireClientReached` above.** That asymmetry is
     * the point and was found by mutation: with this optional, deleting the
     * one line in `runSmoke` that passes it left the check vacuously true —
     * `yarn smoke` exited 0 and the entire suite stayed green. A backstop that
     * can be switched off by omitting an argument is #388's own defect class
     * reproduced inside the fix for #388. Required makes forgetting it a
     * COMPILE error, the same structural argument that makes `RateLimiter` a
     * required positional on `buildDebateStep`.
     */
    llmRateLimiterSnapshot: RateLimiterSnapshot;
    /**
     * The exit-path harness's evidence (#576) — required for the same
     * "compile error, not a silent no-op" reason `llmRateLimiterSnapshot`
     * above is: `runExitPathScenarios` always runs as part of `runSmoke`, so
     * an omitted argument here would be a caller that stopped wiring it in,
     * not a run that legitimately has nothing to report.
     */
    exitPath: ExitPathEvidence;
    /**
     * The crypto-emulation scenario's evidence (#586) — required for the
     * same "compile error, not a silent no-op" reason the two above are:
     * `runCryptoEmulationScenario` always runs as part of `runSmoke`, and
     * the smoke universe is crypto, so the soak's entire bracket path runs
     * on the mechanism this gates.
     */
    cryptoEmulation: CryptoEmulationEvidence;
    /**
     * The logging-fault scenario's evidence (#714) — required for the same
     * "compile error, not a silent no-op" reason the three above are. What it
     * gates is a soak that dies on day three because someone closed its
     * terminal: nothing else in this gate, and no unit test, exercises the
     * entrypoint's stdout `'error'` subscription or its fault net.
     */
    loggerResilience: LoggerResilienceEvidence;
    /**
     * The logs/ retention sweep's evidence (#1116) — required for the same
     * "compile error, not a silent no-op" reason the mechanism above is:
     * `runLogRetentionScenario` always runs as part of `runSmoke`, and
     * nothing else in this gate, and no unit test, drives the real
     * `sweepStaleLogs` against files on disk.
     */
    logRetention: LogRetentionEvidence;
    /**
     * The threshold-clamp probe's evidence (#638) — required, not optional,
     * for the same "compile error, not a silent no-op" reason the four above
     * are. What it gates is the only stop ADR-0013 leaves standing: with no
     * human gate anywhere, a config edit (or, after #736, the Feedback Loop by
     * itself) is the entire distance between the running system and an
     * arbitrary risk limit.
     */
    thresholdClamp: ThresholdClampEvidence;
    /**
     * The service-api/supervisor stdout + arbitrary-fault guards' evidence
     * (#764) — required for the same "compile error, not a silent no-op"
     * reason the mechanisms above are. #714 fixed the unguarded-stdout class
     * for the orchestrator only; nothing else in this gate, and no unit test,
     * drives the two other entrypoints' guards against the actual async
     * `'error'` event a destroyed pipe delivers.
     */
    entrypointFaultGuards: EntrypointFaultGuardEvidence;
    /**
     * The OHLCV failover's evidence (#562) — required, not optional, for the
     * same "compile error, not a silent no-op" reason the mechanisms above
     * are. The composition root's `config.dataSource ??` seam short-circuits
     * the failover for the main run (which injects a fixture source), so
     * without this probe deleting the entire `buildFailoverDataSource` call
     * site would leave `yarn smoke` green — #430's defect class exactly.
     */
    dataFailover: DataFailoverEvidence;
    /**
     * The risk critic's evidence (#957) — required, not optional, for the same
     * "compile error, not a silent no-op" reason the mechanisms above are.
     * Check-pipeline step 7 has a producer for the first time; deleting the one
     * `critic:` line in `production.ts` would return it to the never-run state
     * with every unit test still green, and nothing else here would notice.
     */
    riskCritic: RiskCriticEvidence;
    /**
     * The prompt-tier-crossing warning's evidence (#1155) — required, not
     * optional, for the same "compile error, not a silent no-op" reason the
     * mechanisms above are. `crossesPromptTier` (pricing.ts) had a test but no
     * production caller at all; deleting the `crossesPromptTier(...)` call or
     * the `postPromptTierAlert(...)` dispatch inside `SqliteLlmSpendStore.record`
     * (spend-sink.ts) would return it to that never-called state with every
     * other unit test still green, and nothing else here would notice.
     */
    promptTierWarning: PromptTierWarningEvidence;
    /**
     * The analyst failure-cause scenario's evidence (#1114) — required, not
     * optional, for the same "compile error, not a silent no-op" reason the
     * mechanisms above are (coding-standards.md's `llmRateLimiterSnapshot`
     * precedent). `production.ts`'s `new AnalystOrchestrator({ ..., logger })`
     * has exactly one durable effect an unattended run can show for it: the
     * `debug` lines this scenario reads back. An optional field here would
     * let a future edit drop that one argument and leave `yarn smoke` green.
     */
    analystFailureCause: AnalystFailureCauseEvidence;
    /**
     * The FILLED_WITH_ZERO_SIZE wedge scenario's evidence (#1125) — required,
     * not optional, for the same "compile error, not a silent no-op" reason
     * the mechanisms above are. #1096's review deferred smoke coverage of
     * this warning for want of a second broker/harness surface;
     * `runFilledZeroSizeWedgeScenario` is that surface, and an optional field
     * here would let a future edit drop the call that wires it in and leave
     * `yarn smoke` green regardless.
     */
    filledZeroSizeWedge: FilledZeroSizeWedgeEvidence;
    /**
     * The arm-comparison surface's evidence (#971) — required, not optional,
     * for the same "compile error, not a silent no-op" reason the mechanisms
     * above are. #636/#913 put the matched control's comparison on the Feedback
     * Loop's cadence and on the operator's surfaces; the FL timer is 24h, so
     * without this probe the whole path could be deleted from `production.ts`
     * and every unit test — and `yarn smoke` — would stay green.
     */
    armComparison: ArmComparisonEvidence;
    /**
     * The outside benchmarks' evidence (#981) — required, not optional, for the
     * same reason every mechanism above is: deleting the benchmark cycle from
     * the composition root must break the build here, not quietly leave
     * `yarn smoke` green with a dashboard panel that says nothing was measured.
     */
    outsideBenchmarks: OutsideBenchmarkEvidence;
    /**
     * The daily feedback cycle's restart-durable schedule (#1110) — required,
     * not optional, for the same reason every mechanism above is. Neither
     * `armComparison` nor `outsideBenchmarks` above cover this: both are
     * evidence from `runArmComparisonProbe`/`runOutsideBenchmarkProbe`, which
     * call `runArmComparisonCycle`/`runOutsideBenchmarkCycle` DIRECTLY, never
     * through `scheduleFeedbackCycle`. This is the one piece of evidence in
     * the whole gate that only the composition root's OWN timer — not a
     * probe standing in for it — can produce, so deleting
     * `SqliteFeedbackCycleScheduleStore`/`scheduleFeedbackCycle` from
     * `production.ts` and leaving both probes in place would leave every
     * other check here green.
     */
    feedbackCycleScheduleWritten: boolean;
    /**
     * #1112 AC5 (migration 0045) — required, not optional, for the same
     * "compile error, not a silent no-op" reason every mechanism above is.
     * `SqliteExecutionStore`'s stamp is unit-tested directly
     * (sqlite-shared-store.test.ts) and `capitalCeilingUsd` reaching the
     * Trader's sizing is proven at the composition root
     * (production.test.ts's #1112 cases) — neither proves the ONE-LINE
     * wire from `config.capitalCeilingUsd` into `new SqliteExecutionStore(
     * ..., config.capitalCeilingUsd)` in `production.ts` itself. This is
     * checked against `open_positions` rows for `BTC-USD` specifically —
     * the smoke universe's only instrument driven through
     * `startFromEnvironment`, as opposed to the exit-path scenarios' own
     * directly-constructed `SqliteExecutionStore` instances (#576), which
     * share this run's database but not its config and so are not evidence
     * either way — and against `closed_trades` as well as `open_positions`,
     * so a lot that closed inside the run is evidence rather than a spurious
     * failure. The stamped value is compared to this run's OWN
     * `paperStartingProfile('paper').capitalCeilingUsd`, not merely
     * null-checked: a wire stamping some other non-null number is the same
     * broken wire.
     */
    sizingCeiling: SizingCeilingEvidence;
    /**
     * #1140 — required, not optional, for the same "compile error, not a
     * silent no-op" reason every mechanism above is. The cap the dashboard
     * would draw its meter against, compared to the budget THIS run armed its
     * enforcer with: a published cap that is merely non-null, or one that
     * matches by having been retyped somewhere, is the defect the field
     * exists to end.
     */
    publishedLlmCapUsd: number | null;
    /** The budget THIS run's profile armed the enforcer with — the expected value above. */
    configuredLlmBudgetUsd: number | undefined;
    /**
     * #1196 — a real booted run always arms (`production.ts`'s `if/else` has
     * no third branch), so `null` here on an actual smoke run means the wire
     * is reporting "never armed" for a process that manifestly did boot —
     * `armed_at` stopped being read on the path that fills `DashboardSnapshot`.
     */
    publishedLlmCapArmedAt: string | null;
    /**
     * The fill-sync loop's rejections (#1049) — required, not optional, for the
     * same "compile error, not a silent no-op" reason every mechanism above is.
     * This is the only check in the gate that reads the poll loop's own
     * failure channel; without it `ingestFills` can reject on every poll with
     * the gate green.
     */
    fillSync: FillSyncFailureEvidence;
    /**
     * The market-data fetch telemetry's evidence (#1082) — required, not
     * optional, for the same "compile error, not a silent no-op" reason
     * every mechanism above is. Unlike #1083's `token_bucket_wait` just
     * below (deliberately given NO evidence field), a cache-miss
     * `market_data_fetch` line fires for free on the first bar fetch any
     * fixture-driven run makes against a cold `:memory:` store — no
     * artificial wait needed — so this check is a real, non-vacuous
     * assertion on the mechanism's DURABLE effect: deleting `{ logger }`
     * from the primary `new MarketDataServiceImpl(...)` call in
     * `production.ts` leaves every fetch identical and every other check
     * here green, and only this one would notice.
     */
    marketDataFetch: MarketDataFetchEvidence;
    /**
     * The approvals-fallback probe's evidence (#1152) — required, not
     * optional, for the same "compile error, not a silent no-op" reason
     * `thresholdClamp` above is. See `runApprovalFallbackScenario`'s doc
     * comment for what this checks and why it must read the real composition
     * root rather than reconstruct the fallback itself.
     */
    approvalFallback: ApprovalFallbackEvidence;
    // #1083's wait telemetry has DELIBERATELY no evidence field here, unlike
    // every mechanism above — the standard's "wiring a mechanism means
    // asserting it here" still applies, but this mechanism does not fit the
    // shape this gate checks:
    //
    // - Every field above reads back a DURABLE effect a fixture-driven run
    //   produces for free (a risk_critic_log row, a RateLimiterSnapshot,
    //   persisted bars). #1083 is a log line with no row — there is nothing
    //   to read back once the run ends.
    // - Producing that line requires a REAL wait past
    //   TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS: `delay()` (shared/http/delay.ts)
    //   is real `setTimeout` by design ("every caller is a backoff or a
    //   pacing wait that vitest drives with fake timers") — `yarn smoke` has
    //   no fake-timer escape hatch, so asserting the line's PRESENCE would
    //   spend real wall-clock seconds pacing this gate for a scenario built
    //   only to trigger it, and asserting its ABSENCE is vacuously green:
    //   the smoke universe's own call volume never drains a healthy-sized
    //   bucket, so the line does not fire whether the wiring is correct or
    //   deleted — precisely the `llmRateLimiterSnapshot` comment's warning
    //   above, reproduced.
    //
    // Enforcement instead lives in
    // `server/apps/orchestrator/production/rate-limit-wiring.test.ts`, describe
    // block "the composition root wires wait telemetry onto the shared Alpaca
    // bucket (#1083)" — driven through the same real `buildProductionComponents`
    // this gate uses, with fake timers standing in for the real wait, and
    // mutation-killed (drop `{ logger, name: 'alpaca' }` from `production.ts`'s
    // `new TokenBucket(...)` and that test fails; nothing here would notice
    // either way).
  },
): SmokeGateResult {
  const failures: string[] = [];
  const { ticks, debates, verdicts, positions, fills } = observations;

  if (options.alpacaWireClientReached === true) {
    failures.push(
      'the Alpaca wire client was reached during an offline run — this run is credential-free ' +
        'and must make no network call. The composition root now needs the wire client for ' +
        'something the smoke run overrides; see UnreachableAlpacaClient',
    );
  }

  if (ticks.length < options.minTicks) {
    failures.push(
      `the tick loop completed ${ticks.length} of ${options.minTicks} expected ticks — the ` +
        'loop, the scheduler or the shutdown drain did not behave over repeated ticks',
    );
  }

  const pastAnalysts = ticks.filter((tick) =>
    tick.stages.some((entry) => entry.stage !== 'analysts'),
  );
  if (pastAnalysts.length === 0) {
    failures.push(
      'no tick got past Analysts — every pass short-circuited at the quorum gate, so Debate, ' +
        'Trader, Risk, Verdict and Execution were never exercised at all (this is exactly what ' +
        'a credential-less real run does today, and the reason #350 exists)',
    );
  }

  if (debates.length === 0) {
    failures.push(
      'no row in debate_log — a tick got past Analysts but no resolved debate was persisted, so ' +
        "the Feedback Loop's weight attribution (attribution.ts joins closed_trades.debate_id " +
        'against debate_log) has no input and the debate itself is unreconstructable after the ' +
        'fact (audit_log holds digests only). This is the #364 defect exactly',
    );
  }

  // #1081: every row `buildDebateLog` writes must classify itself — the whole
  // point of the fix is that no `debate_log` row can be silently ambiguous
  // between a converged/non-converged debate and one the latency budget cut
  // short. Hung off `debates.length` for the same reason as 3b above: a run
  // with no rows at all fails on the check above, naming the real cause.
  const unclassified = debates.filter((debate) => debate.termination == null);
  if (debates.length > 0 && unclassified.length > 0) {
    failures.push(
      `${unclassified.length} of ${debates.length} debate_log row(s) have a NULL termination — ` +
        'buildDebateLog (debate-log-store.ts) stopped setting it. That reopens #1081: a debate ' +
        'the latency budget truncated becomes indistinguishable, in the stored record, from one ' +
        'the analysts genuinely could not agree on.',
    );
  }

  // Requirement 3b (#388): the debate that produced that row went through the
  // rate limiter. Hung off `debates.length` rather than standing alone so that
  // a run which never debated fails on the check above, naming the real cause.
  if (debates.length > 0) {
    const totals = Object.values(options.llmRateLimiterSnapshot);
    const llmCallsUsed = totals.reduce((sum, entry) => sum + entry.llmCallsUsed, 0);
    const debatesUsed = totals.reduce((sum, entry) => sum + entry.debatesUsed, 0);
    if (debatesUsed === 0 || llmCallsUsed === 0) {
      failures.push(
        `debates resolved (${debates.length} row(s) in debate_log) but the LLM RateLimiter ` +
          `metered ${debatesUsed} debate(s) and ${llmCallsUsed} call(s) — so it is constructed ` +
          'beside the LLM path rather than in it. This is the #388 defect exactly: the ' +
          'component was implemented, tested and exported while nothing in production ever ' +
          'called it, and the whole unit suite passed the entire time',
      );
    }
  }

  // #753 — falsifier arm 2 has a production caller.
  //
  // Hung off "a tick reached Execution" rather than standing alone, so a run
  // that never traded at all fails on the checks above naming the real cause.
  // Given that the live arm transacted over this tape, the control arm saw the
  // same tape on the same tick and must have left its own row: the arms are
  // matched by construction on name, bracket, stop and conviction floor, and
  // the control's entry is the same deterministic axis vote the live arm's
  // Analysts stage produced.
  //
  // This is the ONLY check anywhere that the control arm has a caller. Every
  // one of its units can pass while `TickSteps.controlArm` is unbound in
  // `production.ts` — the member is optional, so unbinding it is not even a
  // compile error — and the soak would then run for its whole duration with no
  // matched control, which is the exact thing ADR-0014 amendment 2 forbids and
  // the repo's dominant defect class (a tested mechanism nothing calls).
  const transactedThisRun = ticks.some((tick) =>
    tick.stages.some((entry) => entry.stage === 'execution'),
  );
  if (transactedThisRun) {
    const controlLots = positions.filter((position) => position.arm === 'control');
    if (controlLots.length === 0) {
      failures.push(
        "a tick reached Execution but not one `open_positions` row carries `arm = 'control'` — " +
          'falsifier arm 2 (#753) did not run against the tape the live arm just traded. Either ' +
          '`TickSteps.controlArm` is unbound in the composition root or the control arm threw ' +
          'and was swallowed; a soak in this state produces a live track with no matched ' +
          'control, which ADR-0014 amendment 2 and ADR-0017 both require',
      );
    }
    const liveKeys = new Set(
      positions.filter((position) => position.arm === 'live').map((row) => row.idempotency_key),
    );
    const collided = controlLots.filter((row) => liveKeys.has(row.idempotency_key));
    if (collided.length > 0) {
      failures.push(
        `${collided.length} control lot(s) share an idempotency key with a live lot — \`arm\` has ` +
          'stopped being a hash input to `computeIdempotencyKey`, so on every bar the two arms ' +
          "agree on, Execution's `findByKey` gate silently drops the control order. The " +
          'comparison would then be biased on exactly the subset it is most sensitive to',
      );
    }
  }

  // #971 — falsifier arm 2's comparison reaches a surface, not just a report.
  //
  // Stands alone rather than hanging off `transactedThisRun`: the comparison is
  // computable over an empty window (a zero-trade sample is a real, honest
  // measurement), so the properties below hold on every run. What they enforce
  // is the WIRING — that the shipped cycle produces both arms, persists them,
  // and alerts exactly when it says it diverged.
  const arms = options.armComparison;
  if (arms.live === null || arms.control === null) {
    failures.push(
      'the arm-comparison cycle produced no comparison — `runArmComparisonCycle` (#971) could ' +
        'not derive both arms from `closed_trades`, so the Feedback Loop has nothing to persist ' +
        'and the dashboard panel has nothing to show',
    );
  }
  if (arms.persistedRows === 0) {
    failures.push(
      'the arm-comparison cycle wrote no row to `arm_comparison_samples` — either migration 0034 ' +
        'did not apply or `SqliteArmComparisonSampleStore.append` stopped being called. The ' +
        'dashboard panel (#913 surface 2) reads FL persisted samples and nothing else, so a soak ' +
        'in this state shows "no comparison computed yet" for its whole duration',
    );
  }
  if (!arms.persistedBothDrawdowns) {
    failures.push(
      'an `arm_comparison_samples` row came back without a finite drawdown on both arms — ' +
        'the persisted comparison has become a return-only view, which is exactly what doc 12 D4 ' +
        'rules out and what `ArmPerformance.max_drawdown_pct` being required exists to prevent',
    );
  }
  if (arms.diverged !== arms.alerts > 0) {
    failures.push(
      `the arm comparison reported diverged=${String(arms.diverged)} but posted ${arms.alerts} ` +
        'alert(s) — the divergence verdict and the escalation have come apart, so either a ' +
        'divergence reaches nobody or an alert fires on a comparison that did not diverge (#971)',
    );
  }

  // #1110 — the daily cycle's restart-durable schedule must have a row after
  // a real `start()`/`stop()` through the composition root. `arms` above
  // proves nothing about this: `runArmComparisonProbe` calls
  // `runArmComparisonCycle` DIRECTLY, never through `scheduleFeedbackCycle`,
  // so it stays green even if the scheduler is deleted entirely. This is the
  // one check in the gate that can only pass if the composition root's own
  // timer actually ran.
  if (!options.feedbackCycleScheduleWritten) {
    failures.push(
      'no row in `feedback_cycle_schedule` after the run — either `scheduleFeedbackCycle` was ' +
        "dropped from production.ts's composition root, or `paperStartingProfile`'s `feedback` " +
        "block stopped reaching `start()`. This is exactly #1110's defect: a mechanism that " +
        'every unit test exercises directly but the real composition root never calls, so a ' +
        'soak restarted more often than once a day would go back to accumulating zero ' +
        '`arm_comparison_samples` rows for its whole life',
    );
  }

  // #1112 AC5 (migration 0045) — see `sizingCeiling`'s own doc. Three
  // distinct failures, named separately: a gate that reports "the wire is
  // broken" for a run that produced no row at all is a misdiagnosis.
  const { configuredCeiling, rows, allMatchConfiguredCeiling } = options.sizingCeiling;
  if (configuredCeiling === undefined) {
    failures.push(
      "`paperStartingProfile('paper')` no longer sets `capitalCeilingUsd` — the Trader is back " +
        "to sizing off the paper broker's funded equity rather than the declared book (#1112)",
    );
  } else if (rows === 0) {
    failures.push(
      'no BTC-USD row in `open_positions` or `closed_trades` after the run, so the ' +
        '`sizing_capital_ceiling` stamp has no evidence either way — the six-stage tick loop ' +
        'took no position at all (#1112)',
    );
  } else if (!allMatchConfiguredCeiling) {
    failures.push(
      `a BTC-USD row carries a \`sizing_capital_ceiling\` other than this run's configured ` +
        `${configuredCeiling} — \`production.ts\` stopped passing \`config.capitalCeilingUsd\` ` +
        'into `new SqliteExecutionStore(...)`, so a `closed_trades` window could once again ' +
        'silently mix rows sized under two different equity bases (#1112)',
    );
  }

  // #1112 AC3, and #1180's conversion with it: the comparison's denominator
  // and the Trader's sizing denominator are ONE value. Split them and
  // `return_pct` is a return on capital nothing was sized against — the
  // reading that made both figures wrong when the ceiling became a converted
  // USD figure and the basis stayed at the raw GBP book.
  if (configuredCeiling !== undefined && arms.comparison.basis !== configuredCeiling) {
    failures.push(
      `the arm comparison divided both arms by ${arms.comparison.basis} while this run sized ` +
        `against ${configuredCeiling} — the Feedback Loop's basis and the Trader's capital ` +
        'ceiling have come apart, so every persisted `return_pct` is measured against capital ' +
        'the arms were never sized on (#1112 AC3, #1180)',
    );
  }

  // #1140 — the meter's denominator on the wire is the enforcer's own budget.
  if (options.publishedLlmCapUsd !== (options.configuredLlmBudgetUsd ?? null)) {
    failures.push(
      `the dashboard's LLM cap reads ${options.publishedLlmCapUsd ?? 'null'} while this run ` +
        `armed its spend cap at ${options.configuredLlmBudgetUsd ?? 'null'} — ` +
        '`publishedSpendCap.arm(...)` is no longer beside the `SqliteSpendCap` construction in ' +
        'production.ts, so the rail measures spend against a cap nobody is enforcing (#1140)',
    );
  }

  // #1196 — this process manifestly booted, so a null `cap_armed_at` here
  // means `SqliteQueryStore.getLlmSpend` stopped reading `armed_at` off the
  // row `SqliteLlmSpendCapStore.arm(...)` wrote, and the wire is telling the
  // rail "never armed" while an enforcer is, in fact, live.
  if (options.publishedLlmCapArmedAt === null) {
    failures.push(
      "the dashboard's LLM cap reports `cap_armed_at: null` on a run that booted and armed its " +
        'spend cap — `SqliteQueryStore.getLlmSpend` (or `SqliteLlmSpendCapStore.read`) stopped ' +
        'reading `armed_at`, so the rail cannot tell this run apart from one where nothing ever ' +
        'armed (#1196)',
    );
  }

  // #981 — the risk-adjusted OUTSIDE benchmarks reach a surface too, and reach
  // it over the arm comparison's own window.
  //
  // Stands alone for `arms`' reason: a benchmark is computable regardless of
  // what the tape did, so these properties hold on every run. They assert the
  // WIRING and the two invariants that would rot silently — D4's paired columns
  // and the inherited window.
  const benchmarks = options.outsideBenchmarks;
  if (benchmarks.measured === 0) {
    failures.push(
      'the outside-benchmark cycle measured nothing — `runOutsideBenchmarkCycle` (#981) produced ' +
        'no benchmark at all, so the dashboard has no market context beside the arm comparison. ' +
        `Reasons given: ${benchmarks.unmeasured.join('; ') || '(none reported)'}`,
    );
  }
  if (benchmarks.persistedRows === 0) {
    failures.push(
      'the outside-benchmark cycle wrote no row to `outside_benchmark_samples` — either migration ' +
        '0036 did not apply or `SqliteOutsideBenchmarkSampleStore.append` stopped being called, ' +
        'and the panel reads FL persisted samples and nothing else (#981)',
    );
  }
  if (!benchmarks.persistedBothColumns) {
    failures.push(
      'an `outside_benchmark_samples` row came back without BOTH a finite return and a finite ' +
        'drawdown — the persisted benchmark has become a return-only view, which is what doc 12 ' +
        'D4 rules out and what the two NOT NULL columns exist to prevent (#981)',
    );
  }
  if (!benchmarks.windowsMatchArmComparison) {
    failures.push(
      'a persisted outside benchmark does not cover the SAME window the arm comparison was ' +
        'measured over — #636: a benchmark on an approximate window is not a risk-adjusted ' +
        'comparison, it is noise. The window is meant to be inherited from the `ArmComparison`, ' +
        'so this means it stopped being (#981)',
    );
  }

  // #581 — the per-asset-class round cap is wired through the composition
  // root. Each `debate_log` row is checked against ITS instrument's cap
  // (looked up through `SMOKE_TEST_UNIVERSE`, so widening the smoke universe
  // to stocks keeps healthy 3-round debates passing); a row above its cap
  // means `buildDebateStep` stopped threading the cap into `runDebate`.
  // Paired with a per-class call-accounting bound that is TIGHT under the
  // stub (a converged crypto debate spends exactly its worst case: 3 persona
  // calls + 1 disagreement call), so one extra LLM call per debate — an
  // unwired cap, a second disagreement pass — fails the gate rather than
  // passing unseen.
  const smokeAssetClass = new Map<string, AssetClass>(
    SMOKE_TEST_UNIVERSE.map((entry) => [entry.asset, entry.asset_class]),
  );
  const overCap = debates.filter((debate) => {
    const assetClass = smokeAssetClass.get(debate.instrument) ?? 'crypto';
    return debate.rounds > MAX_ROUNDS_BY_ASSET_CLASS[assetClass];
  });
  if (overCap.length > 0) {
    failures.push(
      `${overCap.length} debate_log row(s) ran more rounds than their asset class's cap ` +
        '(#581) — the per-asset-class round cap is no longer reaching `runDebate` from the ' +
        'composition root, so live crypto debates are back to blowing their latency budget ' +
        'on every tick',
    );
  }
  // Iterated over the closed AssetClass set rather than Object.entries, so a
  // malformed snapshot key can never produce an undefined cap (whose NaN
  // bound would compare false everywhere and silently pass the gate).
  for (const assetClass of ['crypto', 'stocks'] as const satisfies readonly AssetClass[]) {
    const entry = options.llmRateLimiterSnapshot[assetClass];
    if (entry === undefined) continue;
    const perDebateBound = worstCaseLlmCallsForAssetClass(assetClass);
    if (entry.debatesUsed > 0 && entry.llmCallsUsed > entry.debatesUsed * perDebateBound) {
      failures.push(
        `the ${assetClass} limiter metered ${entry.llmCallsUsed} LLM call(s) across ` +
          `${entry.debatesUsed} debate(s), above the per-debate worst case of ` +
          `${perDebateBound} (#581) — a debate is spending calls its reservation never ` +
          'booked, so admission control is under-reserving',
      );
    }
  }

  // #430 — one assertion per wired mechanism, aimed at ENFORCEMENT.
  //
  // The repo's dominant defect class is a complete, tested mechanism with no
  // production caller: #327, #364, #366, #371, #374, #379, #388, #432, #433 —
  // at least nine times. Each instance is individually correct code, the gap is
  // always at the composition root, and unit tests cannot see it by
  // construction. These checks are the convention that answer: WIRING A NEW
  // MECHANISM MEANS ADDING ITS ENFORCEMENT ASSERTION HERE.
  //
  // "Aimed at enforcement" is the part that matters. Each check asserts the
  // mechanism's own durable EFFECT — a row only that mechanism writes — not
  // that an object was constructed and not that a log line was emitted. A
  // check on construction passes for a component nothing calls, which is the
  // defect itself.
  // #714 — the logging-fault mechanisms, asserted on their durable effects.
  const logging = options.loggerResilience;
  if (!logging.stdoutRetired || logging.linesAfterStdoutDeath === 0) {
    failures.push(
      'a dead stdout pipe did not leave the logger degraded-but-running — stdout was not ' +
        `retired (${logging.stdoutRetired}) or nothing reached the file afterwards ` +
        `(${logging.linesAfterStdoutDeath} lines). An unattended soak (#238) dies the moment ` +
        'its terminal closes, which is #714 exactly',
    );
  }
  if (!logging.degradationRecordedInFile) {
    failures.push(
      'stdout failed and nothing recorded it on the surviving sink — the run would continue ' +
        'blind, and a sink that silently stopped working is indistinguishable from a quiet ' +
        'system (#714)',
    );
  }
  if (!logging.escalatedWhenNothingCouldRecord) {
    failures.push(
      'a logger with no sink left to record on swallowed its failure instead of throwing — ' +
        'the degrade in #714 is only honest because it stops when the failure can no longer ' +
        'be written down anywhere',
    );
  }
  if (!logging.lastResortTraceOnStderr) {
    failures.push(
      'a logger with no sink left threw but wrote nothing to stderr — and that throw is raised ' +
        "inside a tick, where tick-loop's catch and safeLog swallow it by design (#573). " +
        'Without the stderr line the run would keep trading with no trace on any stream (#714)',
    );
  }
  if (!logging.fatalRecordedInFile || logging.fatalExitCode !== 1) {
    failures.push(
      'an unhandled fault was not recorded durably and exited with ' +
        `${logging.fatalExitCode ?? 'no code'} rather than 1 — the fault net must record where ` +
        'a soak can find it and STOP. A live-money process that keeps running in an unknown ' +
        'state with open positions is worse than one that dies (#714)',
    );
  }

  // #1116 — the logs/ retention sweep, asserted on its durable effects: a
  // stale file actually gone, a fresh one and an explicitly protected one
  // actually surviving. `bytesReclaimed` is aspirational rather than exact
  // when another process still holds a removed file open, but it is not
  // aspirational here — the fixture is single-process — so a mutation that
  // drops the byte accounting on an otherwise-correct removal is caught too.
  const retention = options.logRetention;
  if (!retention.staleFileRemoved) {
    failures.push(
      'the logs/ retention sweep did not remove a file well outside its retention window — ' +
        'unbounded growth in logs/ on an always-on host is exactly what #1116 exists to bound',
    );
  }
  if (!retention.freshFileKept) {
    failures.push(
      'the logs/ retention sweep removed a file inside its retention window — deleting a ' +
        'file this recent risks deleting evidence of a run still in progress (#1116)',
    );
  }
  if (!retention.protectedFileKeptDespiteAge) {
    failures.push(
      'the logs/ retention sweep removed a path passed as protected despite it being old — ' +
        "the active sink's own rotation set must survive regardless of mtime (#1116)",
    );
  }
  if (!retention.liveShapedFileKeptDespiteAge) {
    failures.push(
      'the logs/ retention sweep removed an undated bare name (the service-api.log shape) — ' +
        'a writer still holding that file open keeps appending to the unlinked inode, so the ' +
        'space is never reclaimed and the content is unrecoverable (#1116)',
    );
  }
  if (!retention.nonLogFileKeptDespiteAge) {
    failures.push(
      'the logs/ retention sweep removed a non-log file — pointed at a directory that is not ' +
        'logs/ this is how it reaches .env.local, and no age window can make that recoverable ' +
        '(#1116)',
    );
  }
  if (!retention.oversizedSoakBootTruncatedByDefault) {
    failures.push(
      'the logs/ retention sweep left an oversized soak-boot.out untouched with no ' +
        'configuration at all — #1206 is supposed to bound it by default (bareTruncateBytes and ' +
        'bareTruncateNames both default on, #1281 review round 2), so an operator who sets ' +
        'nothing is left with the exact unbounded growth this ticket exists to close',
    );
  }
  if (retention.staleFileRemoved && retention.bytesReclaimed <= 0) {
    failures.push(
      'the logs/ retention sweep removed a file but reported 0 bytes reclaimed — the byte ' +
        "accounting a soak's own artefact depends on (#1116) is not tracking what was deleted",
    );
  }

  // #764 — the same stdout-write class #714 fixed for the orchestrator,
  // decided separately for the service-api and supervisor entrypoints.
  // There is no `stdoutErrorHandled` field here to check: an entrypoint that
  // stopped subscribing to stdout's error event makes
  // `runEntrypointFaultGuardScenario`'s `pipe.breakPipe(name)` throw, which
  // aborts this whole run (`GATE: FAIL`, exit 1) before this loop is ever
  // reached — a boolean that could only ever read `true` on the path that
  // reaches it would be the vacuous-backstop shape #388 warns about above.
  for (const guard of options.entrypointFaultGuards.entries) {
    if (guard.faultReportedOnStderr !== true) {
      failures.push(
        `${guard.name} stdout fault was not reported on stderr — a degrade that is not recorded ` +
          'anywhere is indistinguishable from a quiet failure (#764)',
      );
    }
    if (!guard.continuesOnArbitraryFault) {
      failures.push(
        `${guard.name} arbitrary-fault handler did not continue the process — this entrypoint ` +
          'decided CONTINUE, not the orchestrator STOP: exiting takes the other half of the ' +
          'system down through the supervisor rule that either child dying stops the other (#764)',
      );
    }
  }

  // #638 — the in-code clamp on the last stop ADR-0013 leaves standing.
  const clamp = options.thresholdClamp;
  const missingFromProbe = GUARDED_THRESHOLD_NAMES.filter(
    (name) => !clamp.probedNames.includes(name),
  );
  if (missingFromProbe.length > 0 || clamp.probedNames.length !== GUARDED_THRESHOLD_NAMES.length) {
    failures.push(
      `the threshold-clamp probe covered ${clamp.probedNames.length} of ` +
        `${GUARDED_THRESHOLD_NAMES.length} guarded thresholds (missing: ` +
        `${missingFromProbe.join(', ') || 'none'}) — a bounds-table entry that nothing probes ` +
        'is a limit nobody has seen enforced (#638)',
    );
  }
  if (clamp.liveReadAccepted.length > 0) {
    failures.push(
      `the LIVE risk_thresholds read accepted out-of-bound values for ` +
        `${clamp.liveReadAccepted.join(', ')} — RiskManagerImpl.evaluate() re-resolves its ` +
        'config from that table on every call, so this is the path the Feedback Loop moves a ' +
        'dial on between two ticks, with no boot in between (#638/ADR-0013)',
    );
  }
  if (clamp.writeDoorAccepted.length > 0) {
    failures.push(
      `the Feedback Loop write door accepted out-of-bound values for ` +
        `${clamp.writeDoorAccepted.join(', ')} — ADR-0013 requires every dial change to be ` +
        'rejected in code if it would cross a hard bound, and after #736 there is nobody in ' +
        'the path at all (#638)',
    );
  }
  if (!clamp.breakerConstructionRefused) {
    failures.push(
      'the breaker constructor accepted a 0.95/0.90 drawdown pair — the pre-existing check is ' +
        'a relative ordering test only, so this boots a system whose hard drawdown breaker ' +
        'can never fire (#638)',
    );
  }
  if (!clamp.killLineCheckRefused) {
    failures.push(
      'the kill-line boot check accepted a PBO threshold of 0.5 — CONTEXT.md states 0.05 as a ' +
        'bright line and the Feedback Loop holds the only mutable copy of it (#638)',
    );
  }
  if (!clamp.shippedConfigAccepted) {
    failures.push(
      'the shipped paper breaker configuration is itself refused by the clamp — the bound is ' +
        'wrong, not the config, and every negative probe above would still pass (#638)',
    );
  }
  if (!clamp.exitBypassesLiveClamp) {
    failures.push(
      'with a live risk_thresholds row out of bounds, an exit intent did not reach ' +
        "RiskManagerImpl.evaluate()'s approved bypass while an entry intent was still refused — " +
        "either the exit/flatten path is stranded behind #638's clamp (a materially worse " +
        "defect than #766 was filed for: ADR-0014's flat-by-close invariant has no session-end " +
        'job to catch a missed flatten) or the clamp stopped refusing entries at all (#766)',
    );
  }

  // #1152 — the composition root's approvals fallback must refuse rather
  // than fabricate consent if Verdict's HITL gate (6) is ever reached: no
  // auto-approving default may ever be wired here.
  const approvalFallback = options.approvalFallback;
  if (!approvalFallback.refusedFabricatedConsent) {
    failures.push(
      "the composition root's approvals fallback did NOT refuse Verdict's HITL gate (6) — it " +
        'answered instead of throwing, which is the auto-approving shape this fallback must ' +
        'never take (#1152)',
    );
  } else if (!(approvalFallback.message ?? '').includes('no ApprovalChannel is wired')) {
    failures.push(
      'the approvals fallback rejected, but not with the expected refusal (got: ' +
        `${approvalFallback.message}) — a different exception could be masking a fallback that ` +
        'no longer refuses on purpose (#1152)',
    );
  }

  // #562 — the live orchestrator's OHLCV failover, asserted on its DURABLE
  // effect: a bar the fallback served, in the store, with the fallback's own
  // provenance and the primary's session semantics.
  const failover = options.dataFailover;
  if (failover.readError !== null) {
    failures.push(
      `the composition root's equities bar read threw instead of failing over: ` +
        `${failover.readError} — a stalled primary must degrade to the fallback vendor, not ` +
        'stop the tick. The root is not building a FailoverDataSource at all (#562)',
    );
  }
  if (!failover.storedSources.every((source) => source === 'polygon')) {
    failures.push(
      `the bars the fallback served were stamped [${failover.storedSources.join(', ')}] in the ` +
        "store rather than all 'polygon' — provenance is the only thing that makes a " +
        'fallback-sourced row detectable after the stall, and nothing re-derives it (#562)',
    );
  }
  if (failover.storedSources.length === 0) {
    failures.push(
      'no bars row landed from the fallback vendor — the failover produced nothing durable, so ' +
        'a stage reading bars on the next tick still has no data (#562)',
    );
  }
  if (
    failover.storedOpenTimes.length !== FAILOVER_IN_SESSION_OPEN_TIMES.length ||
    !failover.storedOpenTimes.every((openTime, i) => openTime === FAILOVER_IN_SESSION_OPEN_TIMES[i])
  ) {
    failures.push(
      `the fallback persisted bars at [${failover.storedOpenTimes.join(', ')}] where the ` +
        `session-normalized set is [${FAILOVER_IN_SESSION_OPEN_TIMES.join(', ')}] — the primary ` +
        'is a NormalizingDataSource and drops out-of-session candles, so a raw fallback puts a ' +
        'different window behind the same lookback and an ATR spans extended hours instead of ' +
        'regular sessions, permanently (#562)',
    );
  }
  if (failover.alerts.length === 0) {
    failures.push(
      'the failover served bars but raised nothing on the DataFailoverAlertChannel — an ' +
        'unattended soak that silently switched vendors is a stall nobody learns about (#562)',
    );
  }

  // #957 — check-pipeline step 7's producer, asserted on its DURABLE effect
  // through the real composition root. See `runRiskCriticScenario`.
  const critic = options.riskCritic;
  if (critic.stepError !== null) {
    failures.push(
      `the risk step threw while consulting the critic: ${critic.stepError} — step 7 is ` +
        'specified to FAIL OPEN (a decision proceeds on the mechanical steps with ' +
        'risk_critic: skipped), so a throw here turns an unreachable model into a dead tick ' +
        'in front of an order (#957, ADR-0003)',
    );
  }
  if (critic.loggedVerdicts.length === 0) {
    failures.push(
      'a viable entry reached the risk stage through the real composition root and no ' +
        'risk_critic_log row was written — the critic producer is not wired at all, so ' +
        'check-pipeline step 7 is back to the never-run state review F-5 recorded, and every ' +
        'decision silently records risk_critic: skipped while looking healthy (#957)',
    );
  }

  // #994: the fold's own enforcement assertion. The fixture pins the outcome
  // — a mark of SMOKE_MARK_PRICE against a threshold one unit above it — so a
  // measured `breached` and the reject that follows are the ONLY correct
  // result. Delete the `marketData:` line from `buildRiskCriticProducer`, or
  // the `breachedConditions` block from `evaluate()`, and this fails.
  if (!critic.conditionStates.includes('breached')) {
    failures.push(
      'the risk critic emitted a well-formed invalidation condition and no persisted ' +
        `condition measured \`breached\` (states: ${JSON.stringify(critic.conditionStates)}) — ` +
        'the deterministic evaluator did not run over the fixture feed, so the typed ' +
        'invalidation half is emitted and measured by nothing (#994)',
    );
  } else if (critic.bindingConstraint !== 'risk_critic:invalidated') {
    failures.push(
      'a measured BREACHED invalidation condition did not reject the intent (binding ' +
        `constraint: ${critic.bindingConstraint ?? 'none'}) — \`evaluate()\` holds that ` +
        'authority (#997 Q2b), so a breach that only gets logged is a checklist with no ' +
        'teeth (#994)',
    );
  }

  // #1155 — the prompt-tier crossing warning, asserted on its DURABLE effect
  // through the real `SqliteLlmSpendStore`. See `runPromptTierWarningScenario`.
  const promptTierWarning = options.promptTierWarning;
  if (promptTierWarning.spendRows !== 2) {
    failures.push(
      `the prompt-tier scenario's two metered calls wrote ${promptTierWarning.spendRows} ` +
        '`llm_spend` row(s), not 2 — the scenario itself is broken, not the mechanism it exists ' +
        'to gate (#1155)',
    );
  } else if (promptTierWarning.costUsd === null || promptTierWarning.costUsd < 0.8) {
    failures.push(
      `the crossing call priced at $${String(promptTierWarning.costUsd)}, not at x-ai/grok-4.5's ` +
        "large-prompt TIER rate (~$0.812) — the scenario's own fixture usage does not actually " +
        'cross the tier, so its alert count proves nothing about #1155',
    );
  } else if (promptTierWarning.alertsFired !== 1) {
    failures.push(
      `two consecutive calls that cross the SAME model's prompt tier produced ` +
        `${promptTierWarning.alertsFired} alert(s), not exactly 1 — either \`crossesPromptTier\` ` +
        '(pricing.ts) is not being consulted inside `SqliteLlmSpendStore.record` at all (0 ' +
        'alerts: the exact silent-2.5x-step #1155 was filed against), or the crossing is not ' +
        'throttled (2 alerts: a retrieval-heavy model would page on every single call)',
    );
  }

  // #1114 — the analyst failure-cause logging's enforcement assertion, on its
  // DURABLE effect through the real composition root. See
  // `runAnalystFailureCauseScenario`'s own doc for why this proves the
  // non-timeout half of the ticket rather than waiting out a real deadline.
  const failureCause = options.analystFailureCause;
  if (!failureCause.failureKinds.includes('error')) {
    failures.push(
      "the analyst failure-cause probe's double-failed data source did not produce a genuine " +
        `(non-timeout) analyst rejection (kinds observed: ${JSON.stringify(failureCause.failureKinds)}) ` +
        '— the probe itself is broken, not the mechanism it exists to gate (#1114)',
    );
  } else if (failureCause.debugPayloads.length === 0) {
    failures.push(
      'a genuine analyst rejection happened and no `stage: "analysts", level: "debug"` line was ' +
        'recorded for it — `production.ts` is not wiring its `logger` into `new ' +
        'AnalystOrchestrator({...})` (or the orchestrator fell back to its internal NOOP_LOGGER), ' +
        'so the cause behind a stage failure is back to the verdict-only line #1114 was filed ' +
        'against',
    );
  } else {
    const withCause = failureCause.debugPayloads.find(
      (payload) =>
        payload.analyst_type === 'technical' &&
        typeof payload.cause === 'string' &&
        typeof payload.name === 'string' &&
        typeof payload.message === 'string',
    );
    if (withCause === undefined) {
      failures.push(
        `debug lines were recorded (${JSON.stringify(failureCause.debugPayloads)}) but none carried ` +
          'the rendered name/message/cause a non-timeout rejection is supposed to keep — ' +
          '`renderErrorDetail` (pipeline/analysts/orchestrator.ts) stopped rendering the caught ' +
          'error, or stopped being called (#1114)',
      );
    }
  }

  // #1125 — the FILLED_WITH_ZERO_SIZE wedge scenario's enforcement assertion,
  // on its DURABLE effect (the warning payload) through the real
  // `buildExecutionSurface` binding. See `runFilledZeroSizeWedgeScenario`.
  const wedge = options.filledZeroSizeWedge;
  if (wedge.warnings.length !== 1) {
    failures.push(
      `the FILLED_WITH_ZERO_SIZE wedge scenario produced ${wedge.warnings.length} warning(s), ` +
        "expected exactly 1 — either the scenario's wedged lot never reached the throttle's " +
        'first-warning threshold (ALERT_AFTER_CONSECUTIVE_ZERO_SIZE consecutive zero-filled-size ' +
        "polls), ingest-fills.ts's own no-new-fills zero-filled-size warning branch has been " +
        "removed or stopped firing, or execution.reconcile() no longer adopts the broker's " +
        "'filled' order_state onto this lot (that branch is guarded on " +
        "order_state === 'filled' || 'partially_filled' — if reconcile's adopt semantics change " +
        "so the lot stays 'submitted', this branch is never reached and zero warnings fire even " +
        'though it is fully intact) (#1125)',
    );
  } else {
    const [warning] = wedge.warnings;
    if (
      warning === undefined ||
      warning.idempotency_key !== FILLED_ZERO_SIZE_WEDGE_LOT_KEY ||
      warning.instrument !== FILLED_ZERO_SIZE_WEDGE_INSTRUMENT ||
      warning.order_state !== 'filled' ||
      warning.consecutive !== ALERT_AFTER_CONSECUTIVE_ZERO_SIZE ||
      // Exact, not `> 0` (#1125 review round 2, finding 1): under
      // `SimulatedClock`, `stuck_ms` is `now - position.opened_at` computed
      // at a FIXED clock reading (no poll advances it), so it is
      // deterministic — `FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS` exactly.
      // A `> 0` check cannot catch `ingest-fills.ts` reading
      // `decision_timestamp` instead of `opened_at`: the two are only 5s
      // apart against a 1h `stuck_ms`, so the wrong field still passes
      // `> 0`. Measured: swapping that field yields `stuck_ms: 3605000`
      // and this exact equality check catches it (`3605000 !==
      // 3600000`), where `> 0` did not.
      warning.stuck_ms !== FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS
    ) {
      failures.push(
        `the FILLED_WITH_ZERO_SIZE warning fired with an unexpected shape ` +
          `(${JSON.stringify(warning)}) — expected idempotency_key ` +
          `'${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}', instrument '${FILLED_ZERO_SIZE_WEDGE_INSTRUMENT}', ` +
          `order_state 'filled', consecutive ${ALERT_AFTER_CONSECUTIVE_ZERO_SIZE} and stuck_ms ` +
          `${FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS} (#1125)`,
      );
    }
  }

  if (debates.length > 0 && observations.cosineSetups.length === 0) {
    failures.push(
      'a debate resolved and reached the Trader, but no row in cosine_setups — `decide()` did ' +
        'not write the setup it embedded, so cosine retrieval has nothing to find and every ' +
        'position takes the permanent 0.75x no-precedent haircut. This is the #432 defect ' +
        'exactly: retrieval (#75) and the store (#198) both existed and `decide()` called ' +
        'neither, while the whole unit suite passed',
    );
  }

  if (observations.riskThresholds.length === 0) {
    failures.push(
      'no row in risk_thresholds — the composition root did not seed the dials, so ' +
        "`autoTighten` has no current value to step from and the Feedback Loop's defensive " +
        'response to a kill-line breach tightens nothing. This is the #433 defect: the write ' +
        'end existed and the read end did not, and nothing failed',
    );
  }

  // #328. Anchored on `debates.length > 0` for the same reason the
  // cosine_setups check is: a run where no debate resolved never reached the
  // Trader, and demanding a row then would fail for a reason that is not this
  // one. Once a debate HAS resolved, a row is unconditional — the Trader
  // writes on a skip and Risk on a rejection, so "nothing traded" is not an
  // explanation for an empty table.
  if (debates.length > 0 && observations.traderDecisions.length === 0) {
    failures.push(
      'a debate resolved and reached the Trader, but no row in trader_log — the decision ' +
        'record is not wired, so why a size came out at N (or why nothing traded at all) is ' +
        'reconstructable only from an `audit_log` digest and ephemeral stdout. Note the ' +
        'Trader writes on a SKIP too, so this cannot be explained by a quiet tick',
    );
  }

  if (observations.traderDecisions.length > 0 && observations.riskDecisions.length === 0) {
    failures.push(
      'the Trader produced an intent but no row in risk_log — Risk evaluated it and left no ' +
        'record of what portfolio state it sized against or which gate bound. A rejected ' +
        'intent never reaches Verdict, so with this unwired a rejection has no durable ' +
        'record anywhere in the system',
    );
  }

  if (observations.analystWeights.length === 0) {
    failures.push(
      'no row in analyst_weights — the startup seeder did not run, so `runDailyCycle` skips ' +
        'every analyst it cannot find a row for and the loop attributes nothing while reporting ' +
        'a clean run. This is the #371 defect',
    );
  }

  const breakerTiers = new Set(observations.breakerStates.map((row) => row.tier));
  if (!breakerTiers.has('portfolio_drawdown') || !breakerTiers.has('kill_switch')) {
    failures.push(
      'breaker_state is missing a tier row — the tick path never persisted the sticky ' +
        "breakers' state, so a tripped hard-drawdown breaker or kill switch re-arms itself on " +
        'restart. Under ADR-0007 the breakers are the only remaining stop; this table sat ' +
        'unwritten behind a doc comment claiming "the caller persists this" (review 2026-08-06 B1)',
    );
  }

  // #1111: the two gates whose refusal is a number against a bound must write
  // that number. A column written by `buildVerdictLog` and never read back is
  // the same defect one table over — the reason a `staleness` row could not be
  // diagnosed without joining to `debate_log` in the first place.
  //
  // This is the only #1111 assertion this gate carries. It does not, and
  // cannot, assert on the `readAt` coordinate itself: a smoke run's fixture
  // marks stay fresh by construction. The six-stage run's fixture mark is
  // frozen at `SMOKE_RUN_INSTANT`, and the run's total wall-clock span
  // (default 3 ticks at 250ms, see `tickIntervalMs`'s own doc, which sizes
  // that gap against `max_signal_age`) stays far below `max_mark_age` too —
  // its smaller value here is 2 minutes (paper-profile.ts, crypto); the
  // exit-path harness instead overrides `max_mark_age` to 24h because it
  // advances its own clock between phases. Either way, no staleness/
  // stale_feed verdict is ever produced here to check the detail on. The
  // one structural guard on `readAt` reaching a real caller is
  // `PortfolioAccountingInput.clock` being a required (non-optional) field —
  // a compile-time check, not a runtime one — so a caller that regresses to
  // threading `asOf` through both parameters would still type-check and this
  // gate would not see it.
  const undetailedStaleness = verdicts.filter(
    (verdict) =>
      (verdict.no_go_reason === 'staleness' || verdict.no_go_reason === 'stale_feed') &&
      (verdict.no_go_detail_measured_ms == null || verdict.no_go_detail_bound_ms == null),
  );
  if (undetailedStaleness.length > 0) {
    failures.push(
      `${undetailedStaleness.length} verdict_log row(s) refused on staleness/stale_feed without ` +
        `recording what was measured (${undetailedStaleness
          .map((verdict) => `${verdict.instrument}:${verdict.no_go_reason}`)
          .join(', ')}) — the cause is unrecoverable from the row, which is what #1111 fixed`,
    );
  }

  if (!verdicts.some((verdict) => verdict.status === 'go')) {
    failures.push(
      `no GO verdict was recorded in verdict_log (${verdicts.length} verdict row(s): ` +
        `${summariseVerdicts(verdicts)}) — the pipeline never authorised a trade`,
    );
  }

  const submitted = ticks.flatMap((tick) =>
    tick.stages.filter((entry) => entry.stage === 'execution' && entry.decision === 'submitted'),
  );
  if (submitted.length === 0) {
    failures.push(
      'no tick reached Execution with a `submitted` result — nothing was ever handed to the ' +
        'broker adapter',
    );
  }

  if (positions.length === 0) {
    failures.push(
      'no row in open_positions — Execution never wrote a lot ahead of the broker call, so ' +
        'there is nothing for reconcile() or the fill poll to advance',
    );
  }

  if (!fills.some((fill) => fill.leg === 'entry')) {
    failures.push(
      'no entry fill in fills — the order was submitted but no fill was ever ingested, so the ' +
        'fill-sync poll (ingestFills) is not draining the venue feed',
    );
  }

  // #576 — the exit path, unconditional: `runExitPathScenarios` always runs,
  // so every one of these is expected on every healthy smoke run, the same
  // way `positions`/`fills` above are.

  // #508/#516: the write-ahead journal must exist and every row must have
  // resolved — an unresolved row means an exit was journalled and then the
  // broker call was refused or left ambiguous.
  if (observations.flattenSubmissions.length === 0) {
    failures.push(
      "no row in flatten_submissions — no exit ever reached executeExit()'s write-ahead journal " +
        "(#508), so #516's cancel-before-flatten guard was never exercised",
    );
  } else {
    const unresolved = observations.flattenSubmissions.filter((row) => row.status !== 'submitted');
    if (unresolved.length > 0) {
      failures.push(
        `flatten_submissions has ${unresolved.length} row(s) not resolved to 'submitted' ` +
          `(${unresolved.map((row) => `${row.idempotency_key}:${row.status}`).join(', ')}) — an ` +
          'exit was journalled but its flatten never reached, or was refused by, the broker',
      );
    }
  }

  // #516 — ORDERING, not merely that both calls happened: every `submitFlatten`
  // must have a `cancel` recorded FRESH since the previous `submitFlatten` (or
  // the start of the run), not merely "somewhere earlier in the sequence" —
  // that weaker form would report the FIRST flatten's own missing cancel and
  // then stop, because every later flatten's window contains SOME earlier
  // cancel and (wrongly) reads as satisfied.
  //
  // What this window scoping does NOT do: verify the cancel it finds belongs
  // to the SAME lot the flatten is closing. A resting bracket leg cancelled
  // after the flatten (or never) can fire into the now-flat position and open
  // a reverse one, and this check catches that for the FIRST flatten a
  // regression touches — sufficient in practice because `executeExit` cancels
  // and flattens through one uniform code path applied to every exit, so a
  // real regression of #516's ordering shows up on the first flatten, not
  // selectively on a later one.
  const { brokerCallSequence } = options.exitPath;
  let sincePreviousFlatten = 0;
  const flattensWithoutPriorCancel: string[] = [];
  for (const [index, call] of brokerCallSequence.entries()) {
    if (!call.startsWith('submitFlatten:')) continue;
    const window = brokerCallSequence.slice(sincePreviousFlatten, index);
    if (!window.some((entry) => entry.startsWith('cancel:'))) {
      flattensWithoutPriorCancel.push(call);
    }
    sincePreviousFlatten = index + 1;
  }
  if (flattensWithoutPriorCancel.length > 0) {
    failures.push(
      `broker call(s) ${flattensWithoutPriorCancel.join(', ')} have no 'cancel' call recorded ` +
        `before them (full sequence: ${brokerCallSequence.join(' -> ') || '(empty)'}) — a resting ` +
        'bracket leg cancelled after the flatten (or never) can fire into the now-flat position ' +
        'and open a reverse one (#516)',
    );
  }
  if (!brokerCallSequence.some((call) => call.startsWith('submitFlatten:'))) {
    failures.push(
      'the exit-path harness recorded no submitFlatten call at all — exits never reached ' +
        'submitFlatten (#508)',
    );
  }

  // #508/#517: every exit must eventually round-trip a lot to `closed` with
  // a `ClosedTrade` — see `SmokeObservations.closedTrades`'s doc for why this
  // was NOT required before #576.
  if (observations.closedTrades.length === 0) {
    failures.push(
      'no row in closed_trades — the exit-path scenarios never round-tripped a lot to flat, so ' +
        "either a flatten's fill was never attributed back to the lot it closed (#517) or " +
        'ingestFills() never reached its round-trip-to-flat branch at all',
    );
  }

  // Scoped to scenario 1's OWN lot, not just the aggregate above: scenario 3
  // alone closes two lots, so an aggregate-only check stays green if
  // scenario 1 regresses in isolation (e.g. a reintroduced #517
  // misattribution confined to its instrument) while scenario 3 still
  // closes normally. Same pattern the #571 check below uses for its own lots.
  const fullExitLot = positions.find(
    (position) => position.idempotency_key === options.exitPath.fullExit.lotKey,
  );
  if (fullExitLot === undefined || fullExitLot.order_state !== 'closed') {
    failures.push(
      `lot '${options.exitPath.fullExit.lotKey}' (scenario 1's full exit) never reached ` +
        `order_state 'closed' (${
          fullExitLot === undefined
            ? 'no row in open_positions'
            : `state=${fullExitLot.order_state}`
        }) — the #508/#517 exit path did not round-trip it to flat`,
    );
  }

  // #525 — the residual left by a partial flatten must be RE-ARMED (not left
  // naked), and re-arming must not have needed the fallback alert: a
  // successful re-arm posts nothing (residual-exposure-alert.ts).
  const { partialFlatten, residualAlerts } = options.exitPath;
  if (partialFlatten.protectedQty === null) {
    failures.push(
      `lot '${partialFlatten.idempotencyKey}' has no protective legs armed after its partial ` +
        "flatten — the #525 residual re-arm never ran, leaving the lot's residual naked",
    );
  } else if (partialFlatten.protectedQty !== partialFlatten.expectedResidual) {
    failures.push(
      `lot '${partialFlatten.idempotencyKey}' has ${partialFlatten.protectedQty} protected after ` +
        `its partial flatten, expected the residual ${partialFlatten.expectedResidual} — the ` +
        're-arm (#525) sized the wrong quantity',
    );
  }
  // Scoped since #549: scenario 5 DELIBERATELY fails one re-arm, so exactly
  // its one inline alert is expected — any OTHER lot alerting still means a
  // re-arm failed on a deterministic offline broker.
  const { residualSweep } = options.exitPath;
  const strayResidualAlerts = residualAlerts.filter(
    (alert) => alert.idempotency_key !== residualSweep.lotKey,
  );
  if (strayResidualAlerts.length > 0) {
    failures.push(
      `${strayResidualAlerts.length} residual-exposure alert(s) fired during the smoke run ` +
        `(lot(s): ${strayResidualAlerts.map((alert) => alert.idempotency_key).join(', ')}) — a ` +
        'successful re-arm posts nothing (residual-exposure-alert.ts); an alert here means the ' +
        '#525 re-arm failed on a deterministic offline broker',
    );
  }

  // #549 — the residual-protection sweep's ENFORCEMENT assertions (#430's
  // convention, mirroring #519/#526's above): scenario 5's observing-poll
  // re-arm was scripted to fail, so ONLY the durable marker + the restarted
  // reconcile()'s sweep can have re-established protection. Each check below
  // catches a real way the #549 mechanism can regress on its OWN terms — the
  // dedup breaking, the sweep settling on the wrong action, the marker
  // surviving, the qty coming out wrong — but they are not four independent
  // witnesses to the SAME failure. Measured (#1228/#1285): an extra
  // `ingestFills()` ahead of the restart heals the deliberately-failed re-arm
  // in-process, through `maybeRearmResidual`'s mark-unprotected ->
  // rearmProtectiveLegs -> confirm-protected path (ingest-fills.ts). A
  // GENUINE restart-sweep heal takes a different path — `sweepOne`
  // (residual-protection-sweep.ts), which never writes mark-unprotected (the
  // marker is already set) and clears via `store.confirmResidualProtected`
  // directly. What makes the two indistinguishable to the other three checks
  // is not a shared code path but `sweepOne`'s own doc'd choice to recompute
  // off the SAME `recordedExposure`/`coversQty` expressions
  // `maybeRearmResidual` uses, so both leave an identical marker/qty/alert
  // footprint. The `scenario5Alerts` count check below, and the
  // `markerCleared`/`protectedQty` checks further below, all read a healed-
  // in-process residual as indistinguishable from a genuinely swept one.
  // `sweepDivergenceAction === undefined` (`findSweepDivergence`, above
  // `runExitPathScenarios`) sees that the restarted sweep itself found
  // nothing left to do — positive evidence the RESTARTED sweep, not an
  // earlier poll, did the healing. `.action` alone is not sufficient,
  // though (#1285 B2, round-1 review): a wrong-key mutation at the
  // `findSweepDivergence` call site can read a DIFFERENT scenario's
  // divergence whose `.action` also happens to be `'adopted'` — measured
  // concretely by substituting scenario 4's `crashRestartLot.exitKey` for
  // this lot's key, which reads scenario 4's flatten-reconcile divergence
  // (`reconcileFlatten`, reconcile.ts) instead, itself `'adopted'`.
  // `sweepDivergenceReason` is the same lookup's `reason` text, so it cannot
  // silently disagree with `sweepDivergenceAction` about which divergence was
  // found — and only `sweepOne`'s own re-arm reason
  // (`'... for residual N by the #549 sweep …'`, residual-protection-sweep.ts)
  // can produce the text this check requires. That excludes more than
  // flatten-reconcile divergences: `sweepOne` itself has a SECOND
  // `action: 'adopted'` return — the `coversQty` flat-path no-op, taken when
  // the persisted fill record already reads flat, whose reason ("marked lot
  // reads flat on the persisted fill record…") never names the #549 sweep
  // either. So this check discriminates WITHIN `sweepOne`, not only against
  // other mechanisms: only its own re-arm branch — the one that actually
  // retried `broker.rearmProtectiveLegs` — satisfies it. Since #1285 N3
  // (round-2 review), the matched text is also bound to THIS lot's own
  // `expectedResidual`, not just the literal `'by the #549 sweep'` suffix —
  // narrowing the aperture the B2 fix left open: a future scenario adding a
  // second lot through `sweepOne`'s real re-arm branch would otherwise also
  // produce `'adopted'` text naming the #549 sweep, and a wrong-key lookup
  // landing on THAT lot's divergence would pass B2's check without also
  // matching this lot's own residual quantity.
  const scenario5Alerts = residualAlerts.filter(
    (alert) => alert.idempotency_key === residualSweep.lotKey,
  );
  if (scenario5Alerts.length !== 1) {
    failures.push(
      `scenario 5's residual episode alerted ${scenario5Alerts.length} time(s), expected exactly 1 ` +
        "(the observing poll's inline #525 alert) — 0 means the failed re-arm no longer pages at " +
        'all; more than 1 means the once-per-episode dedup (#549/#342, ' +
        'open_positions.residual_rearm_alerted_at) regressed and the sweep re-pages every pass',
    );
  }
  if (residualSweep.sweepDivergenceAction === undefined) {
    failures.push(
      `the restarted Execution's reconcile() report named no divergence for scenario 5's lot ` +
        `'${residualSweep.lotKey}' — the durable residual-protection marker (migration 0024) was ` +
        'never written by the observing poll, or SharedStore.getUnprotectedResidualLots() found ' +
        'nothing, so the #549 sweep either never ran or had nothing to find',
    );
  } else if (residualSweep.sweepDivergenceAction !== 'adopted') {
    failures.push(
      `the restarted Execution's residual-protection sweep settled scenario 5's lot with action ` +
        `'${residualSweep.sweepDivergenceAction}', not 'adopted' — the retry against a healthy ` +
        'deterministic broker should have re-armed and confirmed; anything else means the sweep ' +
        'could not settle a marker it should have (#549)',
    );
  } else if (
    !residualSweep.sweepDivergenceReason?.includes(
      `for residual ${residualSweep.expectedResidual} by the #549 sweep`,
    )
  ) {
    failures.push(
      `the lookup keyed on scenario 5's lot '${residualSweep.lotKey}' returned a divergence ` +
        `reading 'adopted', but its reason ('${residualSweep.sweepDivergenceReason}') does not ` +
        `name the #549 sweep re-arming this lot's OWN residual ` +
        `(${residualSweep.expectedResidual}) — this is the #1285 ` +
        'B2/N3 case: a lookup keyed on the WRONG lot could still land on a divergence reading ' +
        "'adopted' (another scenario's flatten-reconcile, or sweepOne's own coversQty flat-path " +
        "no-op), and binding the match to this lot's own residual quantity closes that even for a " +
        "future scenario adding a second lot through sweepOne's real re-arm branch; only " +
        "sweepOne's re-arm of THIS residual (residual-protection-sweep.ts) can satisfy this text",
    );
  }
  if (!residualSweep.markerCleared) {
    failures.push(
      `scenario 5's residual-protection marker (open_positions.residual_unprotected_since, lot ` +
        `'${residualSweep.lotKey}') is still set after the restarted reconcile() — protection was ` +
        'never CONFIRMED, so the lot would be re-swept forever (#549)',
    );
  }
  if (residualSweep.protectedQty !== residualSweep.expectedResidual) {
    failures.push(
      `lot '${residualSweep.lotKey}' has ${residualSweep.protectedQty ?? 'no'} protected after ` +
        `the #549 sweep's retry, expected the residual ${residualSweep.expectedResidual} — the ` +
        'sweep either never re-armed (the lot is naked) or sized the wrong quantity',
    );
  }

  // #571 — neither lot named by a multi-lot flatten may be left phantom-open:
  // both must have reached `order_state: 'closed'` in `open_positions`.
  const phantomOpen = options.exitPath.twoLotFlatten.lotKeys.filter((key) => {
    const row = positions.find((position) => position.idempotency_key === key);
    return row === undefined || row.order_state !== 'closed';
  });
  if (phantomOpen.length > 0) {
    failures.push(
      `lot(s) ${phantomOpen.join(', ')} were named by a two-lot flatten but never reached ` +
        "order_state 'closed' — the #571 fill split left quantity unaccounted for on at least " +
        'one sibling lot',
    );
  }

  // #519/#526 — the ENFORCEMENT assertions for the flatten-journal sweep
  // (#430's convention: a durable EFFECT only the new mechanism produces,
  // not that an object was constructed). A regression that deletes
  // `reconcile()`'s flatten sweep, or reverts `resumeFlatten` to a no-op,
  // leaves scenario 4's lot open forever — `ingestFills()` alone never polls
  // an order the process-local `flattens` map has forgotten, so nothing
  // short of the sweep itself can close it.
  const { crashRestart, flattenReconcileAlerts: flattenReconcileAlertsFired } = options.exitPath;
  const crashRestartDivergence = crashRestart.reconcileReport.divergences.find(
    (divergence) => divergence.idempotency_key === crashRestart.flattenKey,
  );
  if (crashRestartDivergence === undefined) {
    failures.push(
      `the restarted Execution's reconcile() report named no divergence for scenario 4's ` +
        `flatten '${crashRestart.flattenKey}' (lot '${crashRestart.lotKey}') — ` +
        'SharedStore.getUnresolvedFlattens() found nothing to resolve, so the journal sweep ' +
        '(#519) either never ran or the row was not recognised as unresolved ' +
        `(checked=${crashRestart.reconcileReport.checked}, ` +
        `divergences=${crashRestart.reconcileReport.divergences.length})`,
    );
  } else if (crashRestartDivergence.action !== 'adopted') {
    failures.push(
      `the restarted Execution's reconcile() settled scenario 4's flatten with action ` +
        `'${crashRestartDivergence.action}', not 'adopted' (reason: ` +
        `${crashRestartDivergence.reason}) — the venue genuinely acked this flatten, so anything ` +
        "other than 'adopted' means reconcile() mis-settled a row it should have resolved cleanly",
    );
  }
  const crashRestartLot = positions.find(
    (position) => position.idempotency_key === crashRestart.lotKey,
  );
  if (crashRestartLot === undefined || crashRestartLot.order_state !== 'closed') {
    failures.push(
      `lot '${crashRestart.lotKey}' (scenario 4's crash-restart flatten) never reached ` +
        `order_state 'closed' after the restarted Execution's reconcile() + ingestFills() ` +
        `(${crashRestartLot === undefined ? 'no row in open_positions' : `state=${crashRestartLot.order_state}`}) ` +
        "— reconcile()'s flatten sweep did not re-establish the fill-sweep worklist the way " +
        '#519/#526 require',
    );
  }
  if (flattenReconcileAlertsFired.length > 0) {
    failures.push(
      `${flattenReconcileAlertsFired.length} flatten-reconcile alert(s) fired during the smoke ` +
        `run (flatten(s): ${flattenReconcileAlertsFired.map((alert) => alert.idempotency_key).join(', ')}) ` +
        "— scenario 4's flatten resolves cleanly against a deterministic offline broker; an " +
        'alert here means reconcile() could not settle a row it should have',
    );
  }

  // #1088 — the terminal-row sweep's ENFORCEMENT assertion (#430's
  // convention again): scenario 6 seeded a `rejected`, `filled_size = 0`
  // `open_positions` row already older than `TERMINAL_SWEEP_AGE_MS`. Nothing
  // else in this run ever reads or clears that row — `getOpenPositions()`
  // already excluded it from every other check above by virtue of being
  // terminal — so its continued presence after the restarted `reconcile()`
  // can only mean `sweepTerminalPositions` was deleted, stopped being
  // called from `reconcile()`, or regressed its own predicate.
  const { terminalSweep } = options.exitPath;
  if (terminalSweep.rowPresentAfterSweep) {
    failures.push(
      `open_positions row '${terminalSweep.seededKey}' (seeded 'rejected', filled_size 0, ` +
        `decision_timestamp past TERMINAL_SWEEP_AGE_MS) is STILL present after the restarted ` +
        `reconcile() (swept=${terminalSweep.swept}) — the #1088 terminal-row sweep either never ` +
        'ran or no longer deletes what it should; a table this leaves growing forever is the ' +
        'exact defect #1088 closed',
    );
  }

  // #586 — the emulated crypto protective legs, unconditional for #430's
  // reason: `runCryptoEmulationScenario` always runs, the smoke universe is
  // crypto, and no other check in this gate can see the emulation at all
  // (the six-stage run and the exit-path harness both override the broker
  // with `SimulatedBrokerAdapter`). Each check names a different way the
  // mechanism can silently stop being wired.
  const emulation = options.cryptoEmulation;
  if (emulation.journalRow === undefined || emulation.journalRow.asset_class !== 'crypto') {
    failures.push(
      "the emulated-leg journal (broker_brackets, venue 'alpaca') has no crypto row for the " +
        "crypto-emulation scenario's lot — submitBracket stopped journalling the emulated " +
        'bracket (#586), so a crash between the entry and its protective legs leaves a live ' +
        'crypto position nothing knows to protect',
    );
  } else {
    if (
      emulation.journalRow.stop_order_id == null ||
      emulation.journalRow.target_order_id == null
    ) {
      failures.push(
        "the crypto-emulation scenario's journal row is missing protective-leg order ids after " +
          'the entry filled — the legs were never submitted as plain crypto orders (#586), so ' +
          'the filled lot sat naked',
      );
    }
    if (emulation.journalRow.phase !== 'resolved') {
      failures.push(
        `the crypto-emulation scenario's journal row ended in phase ` +
          `'${emulation.journalRow.phase}', expected 'resolved' — the emulated OCO edge ` +
          '(leg fill -> sibling cancel) did not complete (#586)',
      );
    }
  }
  if (!emulation.entryFillSeen) {
    failures.push(
      "the crypto-emulation scenario's entry fill never came back through fetchNewFills — the " +
        'emulation sweep is not polling its plain entry order (#586), so ingestFills would ' +
        'never learn a crypto entry filled',
    );
  }
  if (!emulation.stopFillSeen) {
    failures.push(
      "the crypto-emulation scenario's stop-leg fill never came back through fetchNewFills — " +
        'the emulation sweep is not polling its resting legs (#586), so a stop-out would go ' +
        'unbooked',
    );
  }
  if (!emulation.siblingCancelled) {
    failures.push(
      'the surviving take-profit leg was never cancelled after the stop leg filled — the ' +
        'emulated one-cancels-other edge is not firing (#586), leaving a resting order that ' +
        'can fire into a flat position and open a reverse one',
    );
  }

  // The seeded 25h baseline plus the canned batch's one row on a watched
  // theme (the batch carries two, one off-watchlist). Asserted rather than
  // merely printed, because the two ways this can be wrong are the two this
  // observation exists to catch and neither shows up anywhere else: the seed
  // count alone means the poller never fired from the composition root (the
  // no-caller defect this repo keeps producing), and one more than expected
  // means the theme filter stopped filtering and the archive is taking the
  // whole world's news.
  if (observations.gdeltRowsArchived !== SMOKE_GDELT_EXPECTED_ROWS) {
    failures.push(
      `GDELT archived ${observations.gdeltRowsArchived} macro rows, expected exactly ` +
        `${SMOKE_GDELT_EXPECTED_ROWS} — ` +
        `${SMOKE_GDELT_SEEDED_ROWS} means the poller never ran from the composition root, ` +
        `${SMOKE_GDELT_EXPECTED_ROWS + 1} means the theme filter matched both canned rows and ` +
        'is no longer filtering (#556)',
    );
  }

  // #1086, and the half the line above cannot see: bytes in the archive are
  // not intelligence until something derives them. This is the scoring pass
  // observed through the store the analysts read, on the real composition
  // root — 0 means it is built and never called, which is the state #556's
  // archive half shipped in.
  if (observations.gdeltAggregateItems !== SMOKE_GDELT_EXPECTED_AGGREGATES) {
    failures.push(
      `GDELT scoring derived ${observations.gdeltAggregateItems} macro aggregates, expected ` +
        `exactly ${SMOKE_GDELT_EXPECTED_AGGREGATES} (one per asset class) — 0 means the ` +
        'scoring pass never ran from the composition root, or refused on a baseline the seed ' +
        'was supposed to have filled (#1086)',
    );
  }

  // #504/#430. Two counts, because they answer different questions: the
  // archive row says a fetch reached the vendor path, the store item says the
  // fundamental analyst could actually see the result. A mechanism that
  // fetches and stores nothing readable is the shape this repo keeps shipping.
  //
  // What these two cover is the STARTUP refresh only — `start()` fires
  // `void polymarketAgent.refresh('startup')` once, and the repeating
  // `setInterval` behind it runs at DEFAULT_POLYMARKET_POLL_INTERVAL_MS
  // (15 minutes) against a smoke run that finishes in seconds, so it provably
  // never fires here. The recurring poll is UNCOVERED by this gate; only the
  // composition-root wiring of the first refresh is.
  if (observations.polymarketRowsArchived !== SMOKE_POLYMARKET_EXPECTED_ITEMS) {
    failures.push(
      `Polymarket archived ${observations.polymarketRowsArchived} macro rows, expected exactly ` +
        `${SMOKE_POLYMARKET_EXPECTED_ITEMS} — 0 means the startup refresh never ran from the ` +
        'composition root, more means the fail-closed guard stopped refusing the thin-volume ' +
        'market the fixture serves (#504)',
    );
  }
  if (observations.polymarketItemsArchived !== SMOKE_POLYMARKET_EXPECTED_ITEMS) {
    failures.push(
      `Polymarket archived ${observations.polymarketItemsArchived} items in mi_items, expected ` +
        `exactly ${SMOKE_POLYMARKET_EXPECTED_ITEMS} — 0 with rows archived means the source is ` +
        'back to writing raw bytes with no items, which makes it unreplayable as items (#835)',
    );
  }
  if (observations.polymarketIntelItems !== SMOKE_POLYMARKET_EXPECTED_ITEMS) {
    failures.push(
      `Polymarket put ${observations.polymarketIntelItems} items in the intel bucket, expected ` +
        `exactly ${SMOKE_POLYMARKET_EXPECTED_ITEMS} — 0 with rows archived means the items ` +
        'never reached MarketIntelligenceStore, were dropped by the entity filter, or were ' +
        'stamped outside the debate bar the analysts query. This read is ENTITY-SCOPED like ' +
        "every analyst read, so an item that lost `scope: 'asset_class'` reads 0 here with " +
        'a row archived: filed under a macro series name, it matches no ticker (#914/#960), ' +
        "and #1164's routing (`scope: 'asset_class'` -> `intel`, not `news`) would also read " +
        '0 here if that predicate broke. Items also carry the INGEST INSTANT (#782), and ' +
        'getContext floors its window to the hour, so this count depends on SMOKE_RUN_INSTANT ' +
        'being exactly hour-aligned — a smoke clock that drifts off the hour before the ' +
        'startup refresh lands would read 0 here with a row archived (#504, #782)',
    );
  }

  // #1049 — the fill-sync loop must never have rejected a poll. It logs and
  // keeps polling by design (fill-sync.ts `runOnce`), so this is the only
  // place a run whose `ingestFills` fails on every call is visible at all.
  const untolerated = untoleratedFillSyncFailures(options.fillSync.failures);
  if (untolerated.length > 0) {
    const distinct = [
      ...new Set(untolerated.map((failure) => `${failure.message}: ${failure.error}`)),
    ];
    failures.push(
      `${untolerated.length} fill-sync poll failure(s) were logged and survived — the loop keeps ` +
        'polling by design, so nothing else in this gate sees a reconcile/ingestFills/sweep path that ' +
        `rejects on every call (#1049). Distinct: ${distinct.join(' | ')}`,
    );
  }

  // #1082 — the market-data fetch path must have logged at least one
  // `market_data_fetch` line. `MarketDataServiceImpl`'s store starts cold
  // (`:memory:`), so the run's very first bar fetch through the composition
  // root's PRIMARY `marketData` instance is a guaranteed cache miss; zero
  // lines means the `telemetry` argument was dropped from `production.ts`'s
  // `new MarketDataServiceImpl(...)` call, returning the bar/indicator path
  // to the undiagnosable-silence state #1082 was filed against.
  if (options.marketDataFetch.fetchCount === 0) {
    failures.push(
      'zero market_data_fetch lines were recorded over the run — the store starts cold, so at ' +
        'least one venue-reaching bar fetch (and therefore one recorded miss) is guaranteed on a ' +
        'correctly wired composition root; a zero count means the `telemetry` argument was dropped ' +
        "from production.ts's primary `MarketDataServiceImpl` construction, and the market-data " +
        'path is back to emitting no telemetry at all (#1082)',
    );
  }

  // The fetch telemetry must be JOINABLE to the tick that caused it, which is
  // the whole point of putting the tick's `trace_id` in ambient context: a
  // fetch inside a tick carries that tick's id, and `'market-data'` is the
  // fallback for one with no enclosing tick.
  //
  // A run with no ticks at all is not this check's business — the tick and
  // minTicks checks above own that, and piling on would report a trace defect
  // for a run that never got far enough to have one.
  //
  // Asserted here because nothing else can. Deleting the `runWithTraceId`
  // wrapper from `SequentialTickRunner.runInstrument` leaves every fetch
  // byte-identical, every unit test green (each site's fallback is a legal
  // return), and every other check in this gate green — the lines just
  // quietly revert to the category label and join to nothing.
  const tickTraces = new Set(observations.ticks.map((tick) => tick.trace_id));
  const joined = options.marketDataFetch.traceIds.some((trace_id) => tickTraces.has(trace_id));
  if (tickTraces.size > 0 && options.marketDataFetch.fetchCount > 0 && !joined) {
    failures.push(
      'no market_data_fetch line carried a tick trace_id — every recorded fetch fell back to ' +
        "the 'market-data' category label, so the bar path's telemetry joins to no tick in " +
        'audit_log. Either `runWithTraceId` has been dropped from ' +
        'SequentialTickRunner.runInstrument, or the fetch no longer runs inside the tick',
    );
  }

  return { passed: failures.length === 0, failures };
}

function summariseVerdicts(verdicts: SmokeObservations['verdicts']): string {
  if (verdicts.length === 0) return 'none';
  return verdicts
    .map((verdict) => `${verdict.status}${verdict.no_go_reason ? `:${verdict.no_go_reason}` : ''}`)
    .join(', ');
}

/**
 * The human-readable run report — the thing a person reads to believe the
 * pipeline transacted rather than skipped. Returned as lines so tests can
 * assert on it without capturing stdout.
 */
export function formatSmokeReport(
  observations: SmokeObservations,
  gate: SmokeGateResult,
): string[] {
  const lines: string[] = [
    '',
    '=== Samurai offline end-to-end smoke run (#350) ===',
    'mode=paper  broker=SimulatedBrokerAdapter  data=FixtureDataSource  llm=ConstantResponseLlmClient',
    `no credentials, no network, no money. Clock frozen at ${SMOKE_RUN_INSTANT.toISOString()}`,
    '',
    `ticks completed: ${observations.ticks.length}`,
  ];

  for (const [index, tick] of observations.ticks.entries()) {
    const reached = tick.stages.map((entry) => `${entry.stage}:${entry.decision}`).join(' -> ');
    lines.push(`  tick ${index + 1} [${tick.trace_id}] ${reached}`);
  }

  lines.push('', `debates logged: ${observations.debates.length}`);
  for (const debate of observations.debates) {
    lines.push(
      `  ${debate.instrument} ${debate.direction} rounds=${debate.rounds} [${debate.debate_id}]`,
    );
  }

  lines.push('', `verdicts recorded: ${observations.verdicts.length}`);
  for (const verdict of observations.verdicts) {
    lines.push(
      `  ${verdict.instrument} ${verdict.status}${
        verdict.no_go_reason ? ` (${verdict.no_go_reason})` : ''
      } [${verdict.trace_id}]`,
    );
  }

  lines.push('', `lots submitted to the broker: ${observations.positions.length}`);
  for (const position of observations.positions) {
    lines.push(
      `  ${position.instrument} ${position.side} requested=${position.requested_size} ` +
        `filled=${position.filled_size} @ ${position.avg_entry_price} ` +
        `state=${position.order_state} [${position.idempotency_key}]`,
    );
  }

  lines.push('', `fills ingested: ${observations.fills.length}`);
  for (const fill of observations.fills) {
    lines.push(
      `  ${fill.leg} qty=${fill.qty} @ ${fill.price} fee=${fill.fee} [${fill.idempotency_key}]`,
    );
  }

  lines.push('', `closed trades: ${observations.closedTrades.length}`);
  for (const trade of observations.closedTrades) {
    lines.push(
      `  ${trade.close_reason} realized_pnl_net=${trade.realized_pnl_net} [${trade.idempotency_key}]`,
    );
  }

  lines.push('', `flatten submissions journalled: ${observations.flattenSubmissions.length}`);
  for (const row of observations.flattenSubmissions) {
    lines.push(`  ${row.instrument} status=${row.status} [${row.idempotency_key}]`);
  }

  // `SMOKE_GDELT_EXPECTED_ROWS`: the seeded 25h baseline plus the ONE row of
  // the canned two-row batch that carries a watched theme. One row more than
  // expected means the theme filter has stopped filtering.
  lines.push('', `GDELT macro rows archived: ${observations.gdeltRowsArchived}`);
  lines.push(`GDELT macro aggregates derived: ${observations.gdeltAggregateItems}`);
  // One healthy market, one refused on thin volume, the rest served as rotted
  // slugs — so 1 and 1 is correct and anything else is a wiring or guard
  // change.
  lines.push(
    `Polymarket macro rows archived: ${observations.polymarketRowsArchived}, ` +
      `items archived: ${observations.polymarketItemsArchived}, ` +
      `intel items served: ${observations.polymarketIntelItems}`,
  );

  lines.push('');
  if (gate.passed) {
    lines.push('GATE: PASS — the pipeline transacted end to end in a real process.');
  } else {
    lines.push('GATE: FAIL — the pipeline did not transact end to end:');
    for (const failure of gate.failures) lines.push(`  - ${failure}`);
  }
  lines.push('');

  return lines;
}

export interface SmokeRunOptions {
  /** How many ticks must complete before the run is allowed to stop. Default 3. */
  ticks?: number;
  /**
   * Gap between ticks. Default 250ms — fast enough for a pre-commit gate, and
   * `ticks * tickIntervalMs` must stay far below
   * `verdictConfig.max_signal_age.crypto` (5 minutes), since the fixture mark's
   * `observed_at` is frozen and Verdict's staleness gate measures against it.
   * Raising either constant materially is what would silently start no-going
   * the later ticks.
   */
  tickIntervalMs?: number;
  /**
   * Gap between fill polls. Default 100ms — deliberately tighter than the tick
   * interval, because the entry fill only lands when `ingestFills()` runs, and
   * a run that stopped before the first poll would fail the gate spuriously.
   */
  fillPollIntervalMs?: number;
  /**
   * Heartbeat cadence. Default 100ms, so the dead-man's-switch timer actually
   * fires several times inside a ~1s run rather than being wired but inert.
   */
  heartbeatIntervalMs?: number;
  /**
   * Hard wall-clock ceiling. Default 30s. The run stops and reports whatever it
   * reached rather than hanging — a gate that can hang is a gate nobody runs.
   */
  deadlineMs?: number;
  logger?: Logger;
}

const DEFAULT_SMOKE_TICKS = 3;
const DEFAULT_SMOKE_TICK_INTERVAL_MS = 250;
const DEFAULT_SMOKE_FILL_POLL_INTERVAL_MS = 100;
const DEFAULT_SMOKE_HEARTBEAT_INTERVAL_MS = 100;
const DEFAULT_SMOKE_DEADLINE_MS = 30_000;
/** How long to keep waiting for the fill poll once the tick target is met. */
const FILL_GRACE_MS = 2_000;
/** Store-polling granularity for the two waits below. */
const OBSERVE_INTERVAL_MS = 25;
/**
 * #1028 — the two arms `readSmokeObservations().positions` can ever carry a
 * row for. Not an incidental default: falsifier arm 2 (control) is mandated
 * to run in parallel with the live arm from the first soak day (ADR-0014
 * amendment 2, ADR-0017 §Consequences), and this composition root wires it
 * unconditionally (`production.ts`'s `controlArm` step) — there is no smoke
 * config that runs `live` alone. Used below to compute how many `open_positions`
 * rows a transacting run must produce before the post-tick wait can trust the
 * readback is fully drained, rather than just nonempty.
 */
const SMOKE_TRADING_ARMS: readonly TradingArm[] = ['live', 'control'];

/** Polls the store until `done` or the deadline — never a fixed sleep. */
async function waitUntil(check: () => boolean, deadline: number): Promise<void> {
  while (Date.now() < deadline && !check()) {
    await delay(OBSERVE_INTERVAL_MS);
  }
}

export interface SmokeRunResult {
  observations: SmokeObservations;
  gate: SmokeGateResult;
  /** The human-readable report lines. Printed by the entrypoint, not by `runSmoke` itself. */
  report: string[];
}

/**
 * Starts the real entrypoint assembly over fixtures, runs a bounded number of
 * ticks, drains, and evaluates the gate.
 *
 * Every dependency below goes in through a documented `ProductionConfig`
 * override; none of it is a branch inside the composition root.
 */
export async function runSmoke(options: SmokeRunOptions = {}): Promise<SmokeRunResult> {
  const targetTicks = options.ticks ?? DEFAULT_SMOKE_TICKS;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_SMOKE_TICK_INTERVAL_MS;
  const fillPollIntervalMs = options.fillPollIntervalMs ?? DEFAULT_SMOKE_FILL_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_SMOKE_HEARTBEAT_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_SMOKE_DEADLINE_MS;
  // Plain `JsonLogger` (stdout), never `buildEntrypointLogger()`: that one
  // opens the rotating file sink and creates `logs/`, and a gate should leave
  // no artefacts behind. The store is `:memory:` for the same reason — no
  // `data/*.sqlite` to clean up, and no chance of a smoke run polluting a real
  // paper run's history.
  // #1049: every line the run logs passes through the recorder, so the
  // fill-sync loop's swallowed rejections reach the gate. Forwarding is
  // unconditional — the operator still sees every line.
  const fillSyncFailures = new FillSyncFailureRecorder(options.logger ?? new JsonLogger());
  // #1082: chained on top, same unconditional-forwarding shape — every line
  // still reaches the operator, and this recorder additionally counts
  // `market_data_fetch` lines for the gate below.
  const marketDataFetch = new MarketDataFetchRecorder(fillSyncFailures);
  const logger: Logger = marketDataFetch;
  const db = openSharedStore(':memory:');

  try {
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const profile = paperStartingProfile('paper');
    const dataSource = new FixtureDataSource(
      buildSmokeFixtureBars(),
      { price: SMOKE_MARK_PRICE, observed_at: SMOKE_RUN_INSTANT, source: 'smoke-fixture' },
      'crypto',
      {
        bid: SMOKE_MARK_PRICE - 0.5,
        ask: SMOKE_MARK_PRICE + 0.5,
        observed_at: SMOKE_RUN_INSTANT,
      },
    );

    // The one instance this module has to build rather than reach through the
    // root: `SimulatedBrokerAdapter` needs a `MarketDataService` at
    // construction, and the broker is itself a constructor input to
    // `buildProductionOrchestrator`, so the root's own instance does not exist
    // yet. Same data source, same store, same 'live' mode the root derives for
    // `mode: 'paper'` — so the two instances cannot disagree about a fixture.
    const marketDataForBroker = new MarketDataServiceImpl(
      dataSource,
      clock,
      'live',
      new SqliteMarketDataStore(db),
    );
    const broker = new SimulatedBrokerAdapter({
      clock,
      costModel: new CostModelImpl(profile.costConfig),
      marketData: marketDataForBroker,
      config: profile.executionConfig.simulated,
    });
    const alpacaBrokerClient = new UnreachableAlpacaClient();
    // Built here rather than left to the composition root for one reason: the
    // gate has to READ it afterwards (#388). Same config the root would have
    // used — `profile.rateLimiterConfig` — so this override changes who holds
    // the reference, not what the limiter permits.
    const llmRateLimiter = new RateLimiter(clock, profile.rateLimiterConfig);
    // #576: the tick loop's own residual-exposure channel, recorded rather
    // than left at the `LoggingResidualExposureAlertChannel` default — the
    // gate has to see whether the SIX-STAGE run ever posted one too, not
    // only the exit-path harness below.
    const tickLoopResidualAlerts = new RecordingResidualExposureAlertChannel(
      new LoggingResidualExposureAlertChannel(logger),
    );
    // Hoisted out of the config below for `llmRateLimiter`'s reason: the gate
    // has to READ it afterwards to report how many macro rows the run actually
    // archived. In-memory, as the config comment below explains.
    const smokeMiArchive = new MiArchiveStore();
    seedSmokeGdeltBaseline(smokeMiArchive);

    // Every `ALERT_CHANNEL_FIELDS` member (alert-transport.ts), typed as
    // `Required<AlertChannels>` so a future field added to `AlertChannelSlots`
    // (production/config.ts) and to `ALERT_CHANNEL_FIELDS` fails `yarn
    // typecheck` HERE, at the smoke run's own injection site, if this object
    // is not updated to match — rather than waiting for a developer to
    // notice `SAMURAI_ALERTS` is suddenly demanded of a clean checkout
    // (#803's regression: a twelfth channel, `miCoverageAlerts`, landed
    // without this injection, and only `alert-transport.ts`'s own
    // exhaustiveness check caught the missing FIELD — nothing caught the
    // missing INJECTION here, because `resolveAlertsMode`'s all-or-nothing
    // exemption is a runtime property this object satisfies by construction,
    // not one TypeScript enforced before this line existed).
    //
    // Log-only throughout: this run is attended and offline by definition.
    // `verdictAlerts`/`traderDiagnosticAlerts` are bare no-ops rather than
    // `Logging…Channel` stand-ins because their real implementations already
    // log everything they'd otherwise duplicate (see each field's inline
    // history below `git blame` before #803 folded them into this object).
    const smokeAlertChannels = {
      heartbeatChannel: new LoggingHeartbeatChannel(logger),
      orphanAlerts: new LoggingOrphanAlertChannel(logger),
      unpricedFillAlerts: new LoggingUnpricedFillAlertChannel(logger),
      ocoDoubleFillAlerts: new LoggingOcoDoubleFillAlertChannel(logger),
      breachAlerts: new LoggingBreachAlertChannel(logger),
      loosenNotices: new LoggingLoosenNotificationChannel(logger),
      analystSkipAlerts: new LoggingAnalystSkipAlertChannel(logger),
      // #576: recorded, not just logged — see `tickLoopResidualAlerts` above.
      residualExposureAlerts: tickLoopResidualAlerts,
      // The six-stage tick loop above never reaches a flatten (no exit
      // intent is ever driven through it — see `runExitPathScenarios`'s own
      // file doc for why), so there is nothing here for the gate to read
      // back; a plain log-only instance is enough.
      flattenReconcileAlerts: new LoggingFlattenReconcileAlertChannel(logger),
      verdictAlerts: { notify: async () => {} },
      // A bare no-op rather than a log-only stand-in, deliberately:
      // `postTraderDiagnosticAlert` (direct-bind.ts) writes every diagnostic
      // to the log at `error` BEFORE it consults the port, so a logging
      // instance here would emit each condition twice. Swallowing nothing —
      // measured rather than assumed: a counting stub in this slot records
      // zero diagnostics across a full smoke run. Matters because
      // `ALERT_AFTER_CONSECUTIVE_DIAGNOSTICS` is 1, so a first diagnostic
      // alerts immediately and a silent no-op would eat it; re-measure
      // rather than trust this line if the offline calendar or the fixture
      // bars ever change.
      traderDiagnosticAlerts: { postTraderDiagnosticAlert: async () => {} },
      // #752 — the twelfth `ALERT_CHANNEL_FIELDS` member.
      miCoverageAlerts: new LoggingMiCoverageAlertChannel(logger),
      // #766 — the thirteenth `ALERT_CHANNEL_FIELDS` member. A bare no-op,
      // same reason as `traderDiagnosticAlerts` above: both catch sites this
      // port serves already log at `error` before consulting it, so a
      // logging instance here would emit each trip twice. Nothing in this
      // run trips the live-read or daily-cycle clamp (the composition root's
      // own `risk_thresholds` seed and kill lines are the shipped in-bound
      // values), so this slot is never exercised here — see
      // `runThresholdClampScenario`/`probeExitBypassesLiveClamp` for the
      // actual enforcement probe, which drives the real classes directly.
      thresholdClampAlerts: { postThresholdClampAlert: () => {} },
      // #562 — the fourteenth `ALERT_CHANNEL_FIELDS` member. Log-only like
      // the rest of this attended, offline run. Nothing here fails over: the
      // smoke run's data source is a fixture, so the failover wrapper the
      // composition root builds is never reached with a throwing primary —
      // see production.test.ts's composition-root case for the exercise that
      // does reach it.
      dataFailoverAlerts: new LoggingDataFailoverAlertChannel(logger),
      // #841 — the fifteenth `ALERT_CHANNEL_FIELDS` member. A bare no-op for
      // the same reason as `thresholdClampAlerts` above: both seams that
      // raise it (the risk and verdict binds in direct-bind.ts) write an
      // `error`-level line before consulting the port. Never exercised in
      // this run — the fixture data source values every held instrument —
      // so the enforcement evidence is direct-bind.test.ts's degraded-exit
      // cases, not this slot.
      exitValuationAlerts: { postExitValuationDegradedAlert: () => {} },
      // #684 — the sixteenth `ALERT_CHANNEL_FIELDS` member. This run injects
      // `tradingCalendar: new AlwaysOpenCalendar()` directly (below), so
      // `resolveUsEquitySessionCalendar` never runs and this slot is never
      // exercised — a log-only stand-in is enough, same posture as
      // `dataFailoverAlerts` above.
      calendarFallbackAlerts: new LoggingCalendarFallbackAlertChannel(logger),
      // #971 — the seventeenth `ALERT_CHANNEL_FIELDS` member. Log-only like the
      // rest of this attended, offline run.
      //
      // Since #1110 this slot IS reached from the orchestrator here: a virgin
      // `feedback_cycle_schedule` catches up on its first boundary inside
      // `start()` (see `paperStartingProfile('paper')`'s `feedback` block
      // above), so the real daily cycle — and therefore this channel, if the
      // arms diverge — runs during this run, not just seconds-long-and-never.
      // The gate's `feedback_cycle_schedule.last_boundary` assertion below
      // (`evaluateSmokeGate`) is what proves that reach on every run,
      // regardless of whether this run's fixtures happen to diverge.
      //
      // What this run's short fixture window does NOT reliably exercise is
      // divergence itself — `runArmComparisonProbe`, run after
      // `orchestrator.stop()` below, drives the real `runArmComparisonCycle`
      // again over the complete tape for that. That the composition root
      // RESOLVES this slot at all is additionally held by `satisfies
      // Required<AlertChannels>` on this object plus `production.test.ts`'s
      // "arm comparison runs on the daily feedback cycle" pair, which drive
      // `buildProductionOrchestrator`'s own timer under fake timers to a
      // divergent outcome — the one thing this offline run cannot guarantee.
      armDivergenceAlerts: new LoggingArmDivergenceAlertChannel(logger),
      // #1084 — the eighteenth `ALERT_CHANNEL_FIELDS` member. A bare no-op,
      // same reason as `traderDiagnosticAlerts` above: overlapping tick
      // passes are unreachable in an offline smoke run — everything here
      // settles well inside one `tickIntervalMs`, so the reentrancy guard
      // (#669) never has anything to report as busy, let alone a materially
      // degraded pass, and this slot is never exercised here. The real
      // enforcement evidence is `production.test.ts`'s `startTickLoop` suite,
      // which drives multi-tick busy/degraded sequences under fake timers,
      // PLUS `production.test.ts`'s "tickSkipAlerts is wired by the
      // composition root (#1084)" suite, which proves `config.tickSkipAlerts`
      // actually reaches a real `buildProductionOrchestrator` tick loop
      // rather than only a directly-called `startTickLoop` — the one thing a
      // seconds-long smoke run cannot.
      tickSkipAlerts: { postTickSkipAlert: async () => {} },
      // #1155 — the nineteenth `ALERT_CHANNEL_FIELDS` member. Log-only like
      // the rest of this attended, offline run: `runPromptTierWarningScenario`
      // below drives the real wiring — `SqliteLlmSpendStore.record`,
      // `crossesPromptTier`, the throttle, and this port — end to end on its
      // own composition root and its own cold `:memory:` store, the same
      // pattern `runRiskCriticScenario`/`runDataFailoverScenario` use for a
      // mechanism the six-stage tick loop above cannot exercise for real.
      promptTierAlerts: new LoggingPromptTierAlertChannel(logger),
      // #1378. This run injects `tradingCalendar: new AlwaysOpenCalendar()`
      // directly (below), so `assertLseCalendarCoverage`'s
      // `LseRegularHoursCalendar` gate never fires and this slot is never
      // exercised — a log-only stand-in is enough, same posture as
      // `calendarFallbackAlerts` above.
      lseCalendarCoverageAlerts: new LoggingLseCalendarCoverageAlertChannel(logger),
      // #1396. No debate runs long enough in the smoke fixture to accumulate
      // a real rate — log-only is enough, same posture as the other channels
      // above that this run never exercises.
      llmFailureRateAlerts: new LoggingLlmFailureRateAlertChannel(logger),
    } satisfies Required<AlertChannels>;

    const orchestrator = await startFromEnvironment({
      // The same checked-in tuning values `yarn orchestrator` runs on, at the
      // same `mode: 'paper'` — so the HITL gate resolves through
      // `automation_level: 'auto'` exactly as it will during the soak.
      // `mode: 'backtest'` was the alternative and was rejected deliberately:
      // it bypasses Verdict's HITL gate (6) outright (verdict/index.ts),
      // which would leave the pre-soak gate validating a path the soak
      // never takes.
      //
      // **This is now the enforcement check for ADR-0007, and it works by
      // omission.** No `approvals` is injected here, so the composition root
      // installs its `UnwiredApprovalChannel` default — which THROWS if the
      // HITL gate (6) is ever reached. A smoke run that transacts is
      // therefore positive evidence that the `auto` dial short-circuits
      // before any approval is requested, on the real composition root
      // rather than in a unit test.
      // Flip either class off `auto` without wiring a transport and this gate
      // fails loudly instead of auto-approving. `runApprovalFallbackScenario`
      // asserts that throw directly (#1152) — this comment only covers the
      // "never even asked" half.
      ...profile,
      // #1112: `profile.traderConfig` now sizes against the declared book
      // (£1,000 at `SIZING_USD_PER_GBP`, via `capitalCeilingUsd`, #1180)
      // rather than this run's
      // `FixedAccountStateProvider` balance (100,000) — that gap between the
      // sizing basis and the fixture's account balance is exactly the defect
      // #1112 fixes. The shared profile's crypto risk multiplier was tuned
      // against the OLD, ~100x-inflated sizing basis: at the corrected
      // $1,270 ceiling, this fixture's ATR (~9.53, from the fixed +/-2
      // high/low spread `buildSmokeFixtureBars` uses) makes the organic entry
      // size ~0.22 BTC, which `whole_share_sizing` floors to zero and the run
      // never transacts. Bumped for THIS OFFLINE RUN ONLY, enough to clear the
      // whole-share floor with one BTC of headroom below the crypto exposure
      // cap (`per_asset_class_cap_fraction_of_equity.crypto`) at this
      // fixture's $160 mark — not tuned to hit any particular notional, and
      // `paperStartingProfile`'s own multiplier (real paper/live sizing) is
      // untouched.
      traderConfig: {
        ...profile.traderConfig,
        asset_class_risk_multiplier: {
          ...profile.traderConfig.asset_class_risk_multiplier,
          crypto: 3.5,
        },
      },
      db,
      // In-memory for the same reason `db` is (line 2288): the smoke run must
      // not touch a real store path in this checkout. Left to default, the
      // composition root opens `data/samurai-mi-paper.sqlite` — the live
      // soak's own MI archive — and a gate run would both create it on a
      // fresh clone and write fixture items into the file a real soak reads.
      miArchive: smokeMiArchive,
      // GDELT would otherwise reach the live network from `start()`, breaking
      // this run's "no credentials, no network" claim in the banner above. A
      // canned batch keeps the claim true AND keeps the archive write path
      // exercised end to end — an offline stub that throws would leave the
      // whole macro layer unproven in the one gate that runs the real
      // composition root.
      gdeltClient: smokeGdeltClient(),
      // Polymarket needs no key either, so without this injection the run
      // would reach the live vendor from `start()` and break the banner's
      // "no credentials, no network" claim. A canned wire keeps the claim true
      // AND keeps the whole decode/guard/ingest path exercised — see
      // `smokePolymarketClient`.
      polymarketClient: smokePolymarketClient(),
      clock,
      logger,
      universe: SMOKE_TEST_UNIVERSE,
      // #738: `SMOKE_RUN_INSTANT` is outside US equity regular hours (see its
      // doc comment), and `UniverseScheduler` no longer exempts crypto from
      // the calendar gate — so without this override, `SMOKE_TEST_UNIVERSE`'s
      // BTC-USD would never appear in a tick plan and this run would hang
      // waiting for a tick that never comes. `equityCalendarFor` honours
      // `tradingCalendar` before falling back to a real-hours calendar, so
      // this is a documented `ProductionConfig` override, not a branch inside
      // the composition root. Scoped to this offline run only — production
      // resolves its calendar from `mode` as normal.
      tradingCalendar: new AlwaysOpenCalendar(),
      // `...profile` below carries `stocksTradingWindow: londonEntryWindow()`
      // (paper-profile.ts) — an ADDITIONAL narrowing on top of the calendar
      // (#706), and the scheduler applies it to every instrument now, not
      // just equities (#738). `buildProductionOrchestrator` widens it to
      // `withFlattenTail(entryWindow, tradingCalendar, ...)`, and against the
      // `AlwaysOpenCalendar` above `sessionEnd` is `null`, so the widened
      // window collapses to the bare London entry window — which
      // `SMOKE_RUN_INSTANT` (08:00 London) falls outside of, same as US
      // regular hours. Overridden to unconditionally admit, for the same
      // reason `tradingCalendar` is: this run needs BTC-USD to tick
      // regardless of wall-clock time, and production's own window is
      // untouched by this override (it lives on `ProductionConfig`, not on
      // the scheduler or `paperStartingProfile` themselves).
      stocksTradingWindow: () => true,
      // The three overrides `ProductionConfig`'s own doc comments name as the
      // intended offline bindings.
      broker,
      dataSource,
      llmClient: new ConstantResponseLlmClient(),
      llmRateLimiter,
      // See the class docs: both of these exist because the composition root's
      // defaults reach Alpaca over the network.
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient,
      // Naming log-only alerting explicitly, exhaustively over
      // `ALERT_CHANNEL_FIELDS` — see `smokeAlertChannels` above for why it is
      // a separate `satisfies Required<AlertChannels>` object rather than
      // inline fields here. Injecting all of `ALERT_CHANNEL_FIELDS` is also
      // what makes `resolveAlertsMode` return `undefined`
      // (alert-transport.ts), so this run neither reads `SAMURAI_ALERTS` nor
      // falls back by omission.
      ...smokeAlertChannels,
      tickIntervalMs,
      fillPollIntervalMs,
      // Fast enough to fire several times inside a ~1s run. The heartbeat is a
      // dead-man's switch and this process is attended, so it is not what the
      // gate asserts on — but it is one of the process-level timers #350 names,
      // and a smoke run in which it never fired would leave `Heartbeat.emit`
      // and its channel unexercised. Log-only here (see the channels above), so
      // firing it costs nothing and pages nobody.
      heartbeatIntervalMs,
      maxConcurrentInstruments: 1,
    });

    const deadline = Date.now() + deadlineMs;
    try {
      await waitUntil(() => readSmokeObservations(db).ticks.length >= targetTicks, deadline);
      // Then a bounded grace period for the fill poll to follow the submit —
      // the fill lands on `ingestFills()`, not on the tick that submitted.
      //
      // #1028: this used to be `fills.length > 0`, which only asks whether
      // *some* fill has been ingested. The live and control arms each run
      // their own independently-scheduled `startFillSync()` poll loop
      // (`production.ts`, `fillSync` / `controlFillSync`), so a single fill
      // from either arm satisfied the predicate while the other arm's lot
      // was still sitting at `order_state: 'submitted'`, `filled_size: 0`.
      // `orchestrator.stop()` then cancelled that arm's not-yet-fired poll
      // timer (`fill-sync.ts`'s `stop()` is a bare `clearTimeout`, nothing
      // to await when the timer hasn't fired), and the readback observed
      // whichever lot won the race — nondeterministically, across runs.
      //
      // Every lot the smoke run opens fills fully and synchronously inside
      // `SimulatedBrokerAdapter.submitBracket()` (`CostModelImpl.fill()` has
      // no partial-fill modelling), so "drained" means every currently-open
      // position has actually been ingested, not just that fills exist.
      //
      // #1028 (residual): `positions.length > 0` is still satisfiable by ONE
      // fully-filled arm's row(s) while the OTHER arm hasn't even submitted
      // its order yet — that arm's row does not exist in `open_positions` at
      // all, so `every()` over the partial set says nothing about what is
      // still missing. `SMOKE_TEST_UNIVERSE` has exactly one instrument and
      // `SMOKE_TRADING_ARMS` names the two arms this composition root always
      // wires, and Trader routes a held instrument into its exit branch
      // rather than re-entering it (decide.ts), so a transacting run opens
      // AT MOST one lot per (arm, instrument) regardless of tick count —
      // `expectedOpenPositions` is that ceiling. Requiring the count to reach
      // it before checking `filled_size` closes the gap: the wait can no
      // longer return while a whole arm's row is simply absent.
      const expectedOpenPositions = SMOKE_TEST_UNIVERSE.length * SMOKE_TRADING_ARMS.length;
      await waitUntil(
        () => {
          const observations = readSmokeObservations(db);
          return (
            observations.positions.length === expectedOpenPositions &&
            observations.positions.every((position) => position.filled_size > 0)
          );
        },
        Math.min(Date.now() + FILL_GRACE_MS, deadline),
      );
    } finally {
      // Always drained, including on the deadline path: `stop()` awaits the
      // in-flight tick, and abandoning one mid-pipeline manufactures exactly
      // the orphaned verdict #209 exists to detect.
      await orchestrator.stop();
    }

    // #576: the exit path. Run AFTER the tick loop has stopped and drained —
    // it shares `db` and `clock` with the six-stage run above, but drives its
    // own instruments (`EXIT_PATH_INSTRUMENTS`), so the two cannot contend
    // for the same lots or the same `heldLots` filter (execute.ts).
    const exitPathHarnessResult = await runExitPathScenarios({
      db,
      clock,
      costConfig: profile.costConfig,
      executionConfig: profile.executionConfig,
      logger,
    });

    // #586: the emulated crypto protective legs, on the REAL AlpacaBrokerAdapter
    // over the same db — its own lot key and its own scripted client, so it
    // contends with nothing above.
    const cryptoEmulation = await runCryptoEmulationScenario(db, logger);

    // #714: the entrypoint's logging-fault mechanisms, on a real file sink in
    // a temp directory. Independent of the store and the clock, so it runs
    // beside the three scenarios above rather than inside any of them.
    const loggerResilience = runLoggerResilienceScenario();

    // #1116: the logs/ retention sweep, on real files in its own temp
    // directory. Independent of the store and the clock, so it runs beside
    // the scenarios above rather than inside any of them.
    const logRetention = runLogRetentionScenario();

    // #764: the service-api and supervisor entrypoints' own stdout + fault
    // guards, driven for real — see runEntrypointFaultGuardScenario's doc.
    const entrypointFaultGuards = runEntrypointFaultGuardScenario();

    // #638: negative probes through every seam that can put a risk threshold
    // into force, against the SHIPPED paper values. Its own in-memory store, so
    // it writes nothing the observations below read back.
    const thresholdClamp = runThresholdClampScenario(profile.breakerConfig, profile.riskConfig);

    // #1152: the surviving approvals-fallback probe, off the tick loop for the
    // same reason `thresholdClamp` above is. See `runApprovalFallbackScenario`'s
    // doc comment for why `orchestrator.approvals` (not a second
    // `resolveApprovalsChannel` call) is what makes this detect a
    // composition-root wiring regression.
    const approvalFallback = await runApprovalFallbackScenario(orchestrator.approvals);

    // #562: the OHLCV failover, on its own composition root and its own cold
    // in-memory store — the main run above injects a fixture data source, so
    // the root's `config.dataSource ??` seam short-circuits the failover there.
    const dataFailover = await runDataFailoverScenario(logger);

    // #957: check-pipeline step 7's producer, on its own composition root and
    // its own cold in-memory store. The six-stage run above cannot stand in
    // for it — it has produced zero approved entries historically (#625), so
    // a critic that never fired would be indistinguishable from one that was
    // never wired.
    const riskCritic = await runRiskCriticScenario(logger);

    // #1155: the prompt-tier-crossing warning, on its own real
    // `SqliteLlmSpendStore` and its own cold in-memory store — no metered call
    // this run's own `ConstantResponseLlmClient`/`SmokeLlmClient` make carries
    // a `usage` field at all, so nothing else here could ever exercise it.
    const promptTierWarning = runPromptTierWarningScenario();

    // #1114: the analyst failure-cause logging's enforcement assertion, on
    // its own composition root and its own cold in-memory store, same
    // pattern as `dataFailover`/`riskCritic` above.
    const analystFailureCause = await runAnalystFailureCauseScenario(logger);

    // #1125: the FILLED_WITH_ZERO_SIZE wedge, on its own composition root and
    // its own cold in-memory store — the second broker/harness surface
    // #1096's review deferred, so a genuinely wedged lot can drive the real
    // gate instead of only `filled-zero-size-wiring.test.ts`'s unit proof.
    const filledZeroSizeWedge = await runFilledZeroSizeWedgeScenario(logger);

    // Safe to read the Polymarket counts here, and only here: `start()` fires
    // the first refresh as `void polymarketAgent.refresh('startup')`, so its
    // store write is in flight after `start()` resolves — but `stop()` (line
    // above, in the `finally`) awaits `polymarketAgent.whenIdle()` in its
    // `Promise.allSettled`, which drains it. Moving this read ABOVE the
    // `orchestrator.stop()` call would race that write. The two earlier
    // `readSmokeObservations(db)` calls pass no store, so they observe ticks
    // and fills only and are unaffected.
    const observations = readSmokeObservations(db, smokeMiArchive, orchestrator.marketIntelligence);
    // #981. Runs AFTER the arm comparison and is handed its `ArmComparison`,
    // which is the shipped ordering: the benchmark's window is the matched
    // control's, never one of its own.
    const armComparison = runArmComparisonProbe(db);
    const outsideBenchmarks = await runOutsideBenchmarkProbe(db, armComparison.comparison);
    // #1140 / #1196: one read, both halves of the LLM-cap evidence below.
    const publishedLlmCap = readPublishedLlmCap(db);
    const gate = evaluateSmokeGate(observations, {
      minTicks: targetTicks,
      alpacaWireClientReached: alpacaBrokerClient.reached,
      llmRateLimiterSnapshot: llmRateLimiter.snapshot(),
      cryptoEmulation,
      loggerResilience,
      logRetention,
      entrypointFaultGuards,
      thresholdClamp,
      approvalFallback,
      dataFailover,
      riskCritic,
      promptTierWarning,
      analystFailureCause,
      filledZeroSizeWedge,
      // #971. Run against the same store the observations were read from, and
      // AFTER `orchestrator.stop()` for `readSmokeObservations`' reason: the
      // tape has to be complete before the comparison is taken over it.
      armComparison,
      outsideBenchmarks,
      // #1110. Read after `orchestrator.stop()`, same as `armComparison`
      // above and for the same reason — though unlike `armComparison`, this
      // one is unaffected by tape completeness; it only needs `start()` to
      // have run at all.
      feedbackCycleScheduleWritten: feedbackCycleScheduleWasWritten(db),
      sizingCeiling: readSizingCeilingStamps(db, profile.capitalCeilingUsd),
      // #1140. Both halves come from this run: the published cap off the
      // dashboard's own read, the expected one off the profile the
      // orchestrator booted on — never a literal 50, which would pass on a
      // wire that had stopped carrying anything from the config at all.
      // `capArmedAt` (#1196) rides the same read — see `readPublishedLlmCap`.
      publishedLlmCapUsd: publishedLlmCap.capUsd,
      configuredLlmBudgetUsd: profile.llmBudgetUsd,
      publishedLlmCapArmedAt: publishedLlmCap.capArmedAt,
      fillSync: fillSyncFailures.evidence(),
      marketDataFetch: marketDataFetch.evidence(),
      exitPath: {
        ...exitPathHarnessResult,
        // Alerts from BOTH the six-stage tick loop and the exit-path harness —
        // a residual alert is a defect wherever it fires during a smoke run.
        residualAlerts: [...tickLoopResidualAlerts.alerts, ...exitPathHarnessResult.residualAlerts],
      },
    });
    return { observations, gate, report: formatSmokeReport(observations, gate) };
  } finally {
    db.close();
  }
}

// Entrypoint guard, matching orchestrator/index.ts's. `yarn smoke` runs this
// file directly; importing it (from its own test) must not start a run.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { report, gate } = await runSmoke();
    process.stdout.write(`${report.join('\n')}\n`);
    // The exit code is the gate. A run where every tick quorum-skips, or where
    // no order is ever submitted, must fail — otherwise this is decoration
    // rather than a pre-soak gate.
    process.exit(gate.passed ? 0 : 1);
  } catch (error) {
    // Message only, matching orchestrator/index.ts: nothing here holds a
    // credential, but the posture should not differ between the two
    // entrypoints.
    process.stderr.write(
      `offline smoke run failed to complete: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }
}
