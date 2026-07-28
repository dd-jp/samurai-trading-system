/**
 * Orchestrator — see docs/specs/orchestrator-spec.md, epic #60.
 * Main entry point (`npm run orchestrator`).
 *
 * Ticket #94: the scheduler, the sequential stage chain, and bounded
 * concurrency across instruments. Ticket #95: trace-ID propagation into
 * structured logs and the `audit_log` spine (`JsonLogger`, `digest`).
 * Ticket #96: the `current_tick` row and the dead-man's-switch heartbeat
 * (`Heartbeat`, `TradeChannelHeartbeat`). Ticket #201: `SqliteAuditLog`/
 * `SqliteCurrentTickStore`, the real stores behind `audit_log`/`current_tick`
 * (#193), wired into the tick runner in place of the earlier in-memory
 * doubles. Ticket #209: `OrphanVerdictScanner` — restart-time detection of a
 * `verdict_log` `go` with no matching `execution`-stage `audit_log` row (a
 * crash between Verdict and Execution), alerting rather than auto-retrying.
 *
 * Ticket #236: the production composition root (`production.ts`,
 * [ADR-0004](../../docs/adr/0004-production-composition-root.md)) —
 * `buildProductionOrchestrator` binds all six real stages into one
 * `SequentialTickRunner` (four direct binds from #234, the Analysts/Debate
 * adapter shims from #235), constructs the SQLite-backed stores, the
 * `UniverseScheduler` over a narrow smoke-test universe, the `Heartbeat`,
 * and the `OrphanVerdictScanner`, and owns the start/stop of the tick loop.
 * (This supersedes the earlier note here that no composition root could
 * exist until #83/#86/#71 landed — all three are closed and merged.)
 *
 * This file is also the process entrypoint (`npm run orchestrator`): run
 * directly, it assembles a `ProductionConfig` and starts the loop. Every
 * external transport it needs (Alpaca REST, the LLM provider, the trade
 * channel, the CII feed) exists in this codebase as an interface with no
 * implementation, so `startFromEnvironment` fails fast with a message
 * naming what is missing rather than starting a half-wired process against
 * real money. See `production.ts`'s doc comment for why those transports
 * are injected seams rather than something this ticket implements.
 */
import { pathToFileURL } from 'node:url';
import { SystemClock } from '../shared/clock.js';
import { openSharedStore } from '../shared/store/open-shared-store.js';
import {
  buildProductionOrchestrator,
  type ProductionConfig,
  type ProductionOrchestrator,
  SMOKE_TEST_UNIVERSE,
} from './production.js';

export { digest } from './digest.js';
export { Heartbeat, type HeartbeatChannel } from './heartbeat.js';
export { TradeChannelHeartbeat } from './heartbeat-channel.js';
export { JsonLogger } from './logger.js';
export {
  type OrphanAlertChannel,
  type OrphanGoVerdict,
  OrphanVerdictScanner,
} from './orphan-verdict-scan.js';
export { buildAnalystsStep } from './production/analysts-adapter.js';
export { buildDebatePersonas, buildDebateStep } from './production/debate-adapter.js';
export {
  type AccountStateProvider,
  buildExecutionStep,
  buildPersistence,
  buildRiskStep,
  buildTraderStep,
  buildVerdictStep,
  type ExecutionStepDeps,
  type PersistenceInstances,
  type RiskStepDeps,
  type TraderStepDeps,
  type VerdictStepDeps,
  type VolatilityReadingProvider,
} from './production/direct-bind.js';
export {
  buildProductionComponents,
  buildProductionOrchestrator,
  buildProductionTickRunner,
  type LoopTimers,
  type ProductionComponents,
  type ProductionConfig,
  type ProductionOrchestrator,
  SMOKE_TEST_UNIVERSE,
  startTickLoop,
} from './production.js';
export { DEFAULT_UNIVERSE, type SchedulerConfig, UniverseScheduler } from './scheduler.js';
export { type AuditLogEntry, SqliteAuditLog } from './sqlite-audit-log.js';
export { SqliteCurrentTickStore } from './sqlite-current-tick-store.js';
export { runTickPlan, type TickLoopConfig } from './tick-loop.js';
export { SequentialTickRunner } from './tick-runner.js';
export type {
  AssetClass,
  AuditLog,
  CurrentTick,
  CurrentTickStore,
  Logger,
  Scheduler,
  TickContext,
  TickOutcome,
  TickPlan,
  TickRunner,
  TickStage,
  TickSteps,
  UniverseInstrument,
} from './types.js';

/**
 * Config fields the process cannot derive from the environment or from
 * in-repo code, and must therefore be supplied by the caller: the external
 * transports (no HTTP implementation of `AlpacaClient` /
 * `AnthropicMessagesClient` / `TelegramClient` / `CiiScoreProvider` exists in
 * `src/`, and `ccxt` is not a dependency) plus the per-stage config objects,
 * whose values are explicitly "tuned in paper trading" in every stage spec
 * rather than checked in.
 *
 * Listing them by name is the point: an operator running `npm run
 * orchestrator` today gets a message naming exactly what is not wired,
 * instead of a process that starts and silently trades on invented defaults.
 */
export const REQUIRED_INJECTED_CONFIG = [
  'alpacaBrokerClient',
  'alpacaDataClient',
  'llmClient',
  'heartbeatChannel',
  'approvals',
  'orphanAlerts',
  'ciiScoreProvider',
  'accountState',
  'volatility',
  'traderConfig',
  'riskConfig',
  'verdictConfig',
  'executionConfig',
  'correlationConfig',
  'breakerConfig',
  'costConfig',
  'ciiConsumerConfig',
] as const satisfies readonly (keyof ProductionConfig)[];

/**
 * Assembles a `ProductionConfig` from the environment plus `injected`, builds
 * the composition root, and starts it (orphan scan once, then the tick loop
 * and heartbeat). Throws — before opening any broker connection — if any
 * required dependency is absent.
 *
 * DB path convention matches `src/dashboard/index.ts` and
 * shared-sqlite-store-spec.md: `data/samurai-{env}.sqlite`, one file per
 * environment, so paper and live can never share state.
 */
export async function startFromEnvironment(
  injected: Partial<ProductionConfig> = {},
): Promise<ProductionOrchestrator> {
  const missing = REQUIRED_INJECTED_CONFIG.filter((key) => injected[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Orchestrator cannot start: ${missing.length} required dependencies are not wired ` +
        `(${missing.join(', ')}). These are injected seams, not settings: the HTTP clients ` +
        'for Alpaca/LLM/trade-channel/CII have no implementation in this codebase yet, and ' +
        'the per-stage config values are tuned in paper trading rather than checked in. ' +
        'Supply them via startFromEnvironment(injected) — see ProductionConfig in ' +
        'src/orchestrator/production.ts.',
    );
  }

  const env = process.env.NODE_ENV ?? 'development';
  const mode = (process.env.SAMURAI_MODE ?? 'paper') as ProductionConfig['mode'];
  const db = injected.db ?? openSharedStore(`data/samurai-${env}.sqlite`);

  const orchestrator = buildProductionOrchestrator({
    ...(injected as ProductionConfig),
    db,
    clock: injected.clock ?? new SystemClock(),
    mode,
  });

  const orphans = await orchestrator.start();
  orchestrator.logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: orphans.length > 0 ? 'warn' : 'info',
    message: 'orchestrator started',
    payload: {
      env,
      mode,
      universe: (injected.universe ?? SMOKE_TEST_UNIVERSE).map((i) => i.asset),
      orphaned_go_verdicts: orphans.length,
    },
  });

  return orchestrator;
}

// Entrypoint guard: `npm run orchestrator` runs this file directly, but it is
// also the package's export surface — importing it must not start a trading
// process.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const orchestrator = await startFromEnvironment();
    const shutdown = () => {
      orchestrator.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    // Message only — never the config object, which holds API credentials.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
