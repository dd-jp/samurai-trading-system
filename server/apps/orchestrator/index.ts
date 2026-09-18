import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SaxoTokenSource } from '../../pipeline/execution/index.js';
import {
  ALPACA_CREDENTIAL_ENV_VARS,
  SAXO_APP_CREDENTIAL_ENV_VARS,
  SAXO_CREDENTIAL_ENV_VARS,
  savedSessionExists,
  tokenFilePath,
} from '../../pipeline/execution/index.js';
import { LseRegularHoursCalendar } from '../../providers/market-data-service/index.js';
import { MiArchiveStore, miArchivePath } from '../../providers/market-intelligence/index.js';
import { logCaughtFailure, SystemClock } from '../../shared/index.js';
import {
  assertNoStaleKeyScheme,
  openSharedStore,
  type StoreHandle,
  sharedStorePath,
} from '../../shared/store/index.js';
import { loggingAlertChannel } from './alert-catalogue.js';
import {
  type AlertsMode,
  buildAlertChannels,
  resolveAlertsMode,
  TELEGRAM_ALERT_ENV_VARS,
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
} from './alert-transport.js';
import { type LiveStartingProfile, liveStartingProfile } from './live-profile.js';
import {
  type LogRetentionResult,
  logBareTruncateBytesFromEnvironment,
  logBareTruncateNamesFromEnvironment,
  logRetentionDaysFromEnvironment,
  logRetentionKeepNamesFromEnvironment,
  sweepStaleLogsWithLog,
} from './log-retention.js';
import { buildEntrypointLogger, JsonLogger } from './logger.js';
import { paperStartingProfile } from './paper-profile.js';
import { LSE_TICKERS } from './production/defaults.js';
import {
  armSameCurrencyCeilings,
  assertSameCurrencyFunding,
  type SameCurrencyVerdict,
  saxoFunding,
  verifySameCurrency,
} from './production/saxo-funding.js';
import {
  type BrokerVenue,
  buildSaxoBroker,
  buildSaxoTokenSource,
  buildSaxoVenueClient,
  resolveBrokerVenue,
  saxoTradeableUniverse,
} from './production/saxo-venue.js';
import { SaxoWeeklyReminder } from './production/saxo-weekly-reminder-alert.js';
import { resolveUsEquitySessionCalendar } from './production/us-equity-session-source.js';
import {
  buildProductionOrchestrator,
  type ProductionConfig,
  type ProductionOrchestrator,
} from './production.js';
import { type FileSinkConfig, fileSinkConfigFromEnvironment } from './rotating-file-sink.js';
import type { Logger } from './types.js';

export {
  ALERT_CATALOGUE,
  ALERT_IDS,
  type AlertId,
  type AlertOf,
  type AlertPort,
  type AlertSpec,
  type LoggedAlertId,
  loggingAlertChannel,
  tradeChannelAlert,
  UNLOGGED_ALERT_IDS,
  type UnloggedAlertId,
} from './alert-catalogue.js';
export { type AlertDeliveryFailure, SqliteAlertDeliveryLog } from './alert-delivery-log.js';
export {
  ALERT_CHANNEL_FIELDS,
  ALERTS_MODES,
  type AlertChannels,
  type AlertsMode,
  buildAlertChannels,
  resolveAlertsMode,
  TELEGRAM_ALERT_ENV_VARS,
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
} from './alert-transport.js';
export {
  breachLogMessage,
  breachStage,
  classifyBreach,
  formatBreachAlert,
  LLM_SPEND_CAP_BREACH,
} from './breach-text.js';
export {
  DebateBarDecisionGate,
  type DecisionGate,
} from './decision-bar-gate.js';
export { Heartbeat, type HeartbeatChannel } from './heartbeat.js';
export {
  LIVE_MONEY_GATE_SUMMARY,
  LIVE_MONEY_GATES,
  LIVE_MONEY_GATES_VERIFIED_ON,
} from './live-money-gates.js';
export {
  LIVE_MAX_CAPITAL_ENV_VAR,
  type LiveStartingProfile,
  liveStartingProfile,
  minLiveCapitalCeilingUsd,
  resolveLiveCapitalCeilingUsd,
} from './live-profile.js';
export {
  buildEntrypointLogger,
  formatLogLine,
  JsonLogger,
  type LogLineSink,
  type StdoutStream,
  watchStdoutErrors,
} from './logger.js';
export {
  type OrphanAlertChannel,
  type OrphanGoVerdict,
  OrphanVerdictScanner,
} from './orphan-verdict-scan.js';
export {
  LIVE_BOOK_GBP,
  LIVE_BOOK_SIZING_USD,
  paperStartingProfile,
  RISK_CAP_EQUITY_FRACTIONS,
  SIZING_USD_PER_GBP,
} from './paper-profile.js';
export {
  ALERT_AFTER_CONSECUTIVE_SKIPS,
  ALERT_REPEAT_EVERY_SKIPS,
  type AnalystSkipAlert,
  type AnalystSkipAlertChannel,
  buildAnalystsStep,
} from './production/analysts-adapter.js';
export { buildDebatePersonas, buildDebateStep } from './production/debate-adapter.js';
export { buildDefaultAlpacaBrokerClient } from './production/defaults.js';
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
  BENCHMARK_INSTRUMENTS,
  buildProductionComponents,
  buildProductionOrchestrator,
  buildProductionTickRunner,
  type DailyMetricsConfig,
  DEFAULT_FEEDBACK_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type FeedbackCycleConfig,
  type ProductionComponents,
  type ProductionConfig,
  type ProductionOrchestrator,
  SMOKE_TEST_UNIVERSE,
  startTickLoop,
} from './production.js';
export {
  DEFAULT_LOG_FILE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROTATED_FILES,
  type FileSinkConfig,
  fileSinkConfigFromEnvironment,
  RotatingFileSink,
} from './rotating-file-sink.js';
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

import { describeThrownSafely } from '../../shared/index.js';

export const REQUIRED_INJECTED_CONFIG = [
  'traderConfig',
  'riskConfig',
  'verdictConfig',
  'executionConfig',
  'correlationConfig',
  'breakerConfig',
  'costConfig',
  'ciiConsumerConfig',
  'universe',
] as const satisfies readonly (keyof ProductionConfig)[];

const MODES = ['live', 'paper', 'backtest'] as const;

function parseMode(raw: string | undefined): ProductionConfig['mode'] {
  if (raw === undefined) return 'paper';
  const mode = MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw new Error(`Orchestrator cannot start: SAMURAI_MODE must be one of ${MODES.join('|')}.`);
  }
  return mode;
}

export function credentialRequirements(): readonly {
  vars: readonly string[];
  unusedByThisRun: (context: {
    injected: Partial<ProductionConfig>;
    alertsMode: AlertsMode | undefined;
    mode: ProductionConfig['mode'];
    venue: BrokerVenue;
    savedSaxoSession: boolean;
  }) => boolean;
  alternatives?: Readonly<Record<string, readonly string[]>>;
}[] {
  return [
    {
      vars: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'],
      unusedByThisRun: ({ injected, venue }) =>
        alpacaOrderPathUnused(injected, venue) && alpacaDataPathUnused(injected),
    },
    {
      vars: [ALPACA_CREDENTIAL_ENV_VARS.live.key, ALPACA_CREDENTIAL_ENV_VARS.live.secret],
      unusedByThisRun: ({ injected, mode }) =>
        mode !== 'live' || injected.alpacaBrokerClient !== undefined,
    },
    {
      vars: ['NOUS_API_KEY', 'NOUS_BASE_URL'],
      alternatives: { NOUS_API_KEY: ['NOUS_DEBATE_API_KEY', 'NOUS_SENTIMENT_API_KEY'] },
      unusedByThisRun: ({ injected }) => injected.llmClient !== undefined,
    },
    {
      vars: TELEGRAM_ALERT_ENV_VARS.filter((name) => name !== TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR),
      unusedByThisRun: ({ alertsMode }) => alertsMode !== 'telegram',
    },
    {
      vars: [TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR],
      unusedByThisRun: ({ injected, alertsMode }) =>
        alertsMode !== 'telegram' || injected.heartbeatChannel !== undefined,
    },
    {
      vars: [SAXO_CREDENTIAL_ENV_VARS.sim.token],
      unusedByThisRun: ({ injected, venue, savedSaxoSession }) =>
        venue !== 'saxo' ||
        injected.saxoBrokerClient !== undefined ||
        injected.broker !== undefined ||
        savedSaxoSession,
    },
    {
      vars: [SAXO_APP_CREDENTIAL_ENV_VARS.sim.appKey, SAXO_APP_CREDENTIAL_ENV_VARS.sim.appSecret],
      unusedByThisRun: ({ injected, venue, savedSaxoSession }) =>
        venue !== 'saxo' ||
        injected.saxoBrokerClient !== undefined ||
        injected.broker !== undefined ||
        !savedSaxoSession,
    },
  ];
}

function alpacaOrderPathUnused(injected: Partial<ProductionConfig>, venue: BrokerVenue): boolean {
  if (injected.alpacaBrokerClient !== undefined) return true;
  const brokerIsNotAlpaca = injected.broker !== undefined || venue === 'saxo';
  const accountReadIsSupplied =
    injected.accountState !== undefined ||
    injected.accountFunding !== undefined ||
    saxoFundingWillBeBuilt(injected, venue);
  return brokerIsNotAlpaca && accountReadIsSupplied;
}

function saxoFundingWillBeBuilt(injected: Partial<ProductionConfig>, venue: BrokerVenue): boolean {
  return (
    venue === 'saxo' &&
    injected.broker === undefined &&
    injected.saxoBrokerClient === undefined &&
    injected.accountState === undefined &&
    injected.accountFunding === undefined
  );
}

function alpacaDataPathUnused(injected: Partial<ProductionConfig>): boolean {
  if (injected.dataSource !== undefined || injected.alpacaDataClient !== undefined) return true;
  if (injected.lseMarkClient === undefined) return false;
  const universe = injected.universe ?? [];
  return universe.length > 0 && universe.every((instrument) => LSE_TICKERS.has(instrument.asset));
}

export function missingCredentialEnvVars(
  injected: Partial<ProductionConfig>,
  alertsMode: AlertsMode | undefined,
  mode: ProductionConfig['mode'],
  venue: BrokerVenue,
): string[] {
  const isSet = (name: string): boolean => (process.env[name] ?? '').trim().length > 0;
  const savedSaxoSession = savedSessionExists(tokenFilePath('sim'));

  return credentialRequirements()
    .filter(
      (requirement) =>
        !requirement.unusedByThisRun({ injected, alertsMode, mode, venue, savedSaxoSession }),
    )
    .flatMap((requirement) =>
      requirement.vars.filter(
        (name) => !isSet(name) && !(requirement.alternatives?.[name] ?? []).some(isSet),
      ),
    );
}

function assertCredentialsPresent(
  injected: Partial<ProductionConfig>,
  alertsMode: AlertsMode | undefined,
  mode: ProductionConfig['mode'],
  venue: BrokerVenue,
): void {
  const missing = missingCredentialEnvVars(injected, alertsMode, mode, venue);
  if (missing.length === 0) return;

  const telegram = missing.filter((name) =>
    (TELEGRAM_ALERT_ENV_VARS as readonly string[]).includes(name),
  );

  throw new Error(
    `Orchestrator cannot start: ${missing.length} required credential(s) are not set ` +
      `(${missing.join(', ')}). Provide them via the environment — .env.local, which is ` +
      'gitignored — or pass the corresponding clients explicitly (alpacaBrokerClient / ' +
      'alpacaDataClient / llmClient on ProductionConfig). The tracked .env holds empty ' +
      'placeholders and is not a configured environment; an empty value counts as missing. ' +
      (telegram.length > 0
        ? `SAMURAI_ALERTS=telegram is what makes ${telegram.join(', ')} required — re-run with ` +
          'SAMURAI_ALERTS=log-only to accept log-only alerting for an ATTENDED run instead ' +
          '(not for an unattended soak). ' +
          `${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} must name a DIFFERENT chat from ` +
          'TELEGRAM_CHAT_ID (#342): the heartbeat posts forever on a fixed interval, and ' +
          'sharing the escalation chat is what drives an operator to mute the one channel ' +
          'that carries orphaned go verdicts, stuck lots and kill-threshold breaches. '
        : '') +
      'Note that `node dist/server/apps/orchestrator/index.js` does not read any .env file on its own — ' +
      'use `node --env-file=.env.local dist/server/apps/orchestrator/index.js` or export the variables.',
  );
}

export function storePathEncodesTradingMode(
  dbPath: string,
  mode: ProductionConfig['mode'],
): boolean {
  return basename(dbPath).includes(mode);
}

export function assertStorePathMatchesMode(deps: {
  dbPath: string;
  mode: ProductionConfig['mode'];
}): void {
  if (storePathEncodesTradingMode(deps.dbPath, deps.mode)) return;

  throw new Error(
    `Orchestrator cannot start: it is about to run in '${deps.mode}' mode but the shared store ` +
      `resolves to ${basename(deps.dbPath)}, which is not that mode's file. Store files are ` +
      `named after the trading mode (#168/#330) so paper and live state cannot mix — writing ` +
      `'${deps.mode}' state into another mode's database is exactly what that convention ` +
      'prevents. This happens when an injected mode disagrees with SAMURAI_MODE; set ' +
      `SAMURAI_MODE=${deps.mode} so the writer and the dashboard resolve the same file.`,
  );
}

function buildSaxoSessionWiring(deps: {
  injected: Partial<ProductionConfig>;
  venue: BrokerVenue;
  logger: Logger;
  clock: ProductionConfig['clock'];
  alertChannels: ReturnType<typeof buildAlertChannels>;
}): {
  saxoTokenSource: SaxoTokenSource | undefined;
  saxoWeeklyReminder: SaxoWeeklyReminder | undefined;
  saxoClient: ReturnType<typeof buildSaxoVenueClient> | undefined;
} {
  const { injected, venue, logger, clock, alertChannels } = deps;

  const saxoIsOwnedHere =
    venue === 'saxo' && injected.broker === undefined && injected.saxoBrokerClient === undefined;

  const saxoSessionLostAlerts =
    injected.saxoSessionLostAlerts ?? alertChannels.saxoSessionLostAlerts;

  const saxoTokenSource = saxoIsOwnedHere
    ? buildSaxoTokenSource(
        'sim',
        logger,
        saxoSessionLostAlerts === undefined ? {} : { sessionLostAlerts: saxoSessionLostAlerts },
      )
    : undefined;

  const saxoClient =
    saxoTokenSource === undefined ? undefined : buildSaxoVenueClient(logger, saxoTokenSource);

  const saxoWeeklyReminder = saxoIsOwnedHere
    ? new SaxoWeeklyReminder({
        environment: 'sim',
        tokenPath: tokenFilePath('sim'),
        channel:
          injected.saxoWeeklyReminderAlerts ??
          alertChannels.saxoWeeklyReminderAlerts ??
          loggingAlertChannel('saxoWeeklyReminderAlerts', logger),
        logger,
        clock,
      })
    : undefined;

  return { saxoTokenSource, saxoWeeklyReminder, saxoClient };
}

async function buildSaxoBrokerIfNeeded(deps: {
  injected: Partial<ProductionConfig>;
  venue: BrokerVenue;
  mode: ProductionConfig['mode'];
  db: StoreHandle;
  logger: Logger;
  clock: ProductionConfig['clock'];
  alertChannels: ReturnType<typeof buildAlertChannels>;
  accountFunding: ProductionConfig['accountFunding'];
  saxoWireClient: Parameters<typeof buildSaxoBroker>[0]['client'];
}): Promise<ProductionConfig['broker']> {
  const {
    injected,
    venue,
    mode,
    db,
    logger,
    clock,
    alertChannels,
    accountFunding,
    saxoWireClient,
  } = deps;
  if (venue !== 'saxo' || injected.broker !== undefined) return undefined;

  return buildSaxoBroker({
    mode,
    universe: injected.universe ?? [],
    accountState: injected.accountState,
    ...(accountFunding === undefined ? {} : { accountFunding }),
    db,
    logger,
    clock,
    legResizeAlerts:
      injected.legResizeAlerts ??
      alertChannels.legResizeAlerts ??
      loggingAlertChannel('legResizeAlerts', logger),
    dormantLegsAlerts:
      injected.dormantLegsAlerts ??
      alertChannels.dormantLegsAlerts ??
      loggingAlertChannel('dormantLegsAlerts', logger),
    priceUnitAlerts:
      injected.priceUnitAlerts ??
      alertChannels.priceUnitAlerts ??
      loggingAlertChannel('priceUnitAlerts', logger),
    ...(saxoWireClient === undefined ? {} : { client: saxoWireClient }),
  });
}

async function buildSaxoBrokerWiring(deps: {
  injected: Partial<ProductionConfig>;
  venue: BrokerVenue;
  mode: ProductionConfig['mode'];
  db: StoreHandle;
  logger: Logger;
  clock: ProductionConfig['clock'];
  alertChannels: ReturnType<typeof buildAlertChannels>;
  saxoClient: ReturnType<typeof buildSaxoVenueClient> | undefined;
}): Promise<{
  saxoBroker: ProductionConfig['broker'];
  accountFunding: ProductionConfig['accountFunding'];
  saxoCalendar: ProductionConfig['tradingCalendar'];
}> {
  const { injected, venue, mode, db, logger, clock, alertChannels, saxoClient } = deps;

  const saxoAccountFunding =
    saxoClient !== undefined && saxoFundingWillBeBuilt(injected, venue)
      ? saxoFunding(saxoClient)
      : undefined;
  const accountFunding = injected.accountFunding ?? saxoAccountFunding;
  const saxoWireClient = injected.saxoBrokerClient ?? saxoClient;

  const saxoBroker = await buildSaxoBrokerIfNeeded({
    injected,
    venue,
    mode,
    db,
    logger,
    clock,
    alertChannels,
    accountFunding,
    saxoWireClient,
  });

  const saxoCalendar =
    venue === 'saxo' && injected.tradingCalendar === undefined
      ? new LseRegularHoursCalendar()
      : undefined;

  return { saxoBroker, accountFunding, saxoCalendar };
}

async function buildSaxoIntegration(deps: {
  injected: Partial<ProductionConfig>;
  venue: BrokerVenue;
  mode: ProductionConfig['mode'];
  db: StoreHandle;
  logger: Logger;
  clock: ProductionConfig['clock'];
  alertChannels: ReturnType<typeof buildAlertChannels>;
}): Promise<{
  saxoTokenSource: SaxoTokenSource | undefined;
  saxoWeeklyReminder: SaxoWeeklyReminder | undefined;
  saxoBroker: ProductionConfig['broker'];
  accountFunding: ProductionConfig['accountFunding'];
  saxoCalendar: ProductionConfig['tradingCalendar'];
}> {
  const { injected, venue, mode, db, logger, clock, alertChannels } = deps;

  const { saxoTokenSource, saxoWeeklyReminder, saxoClient } = buildSaxoSessionWiring({
    injected,
    venue,
    logger,
    clock,
    alertChannels,
  });

  const { saxoBroker, accountFunding, saxoCalendar } = await buildSaxoBrokerWiring({
    injected,
    venue,
    mode,
    db,
    logger,
    clock,
    alertChannels,
    saxoClient,
  });

  return { saxoTokenSource, saxoWeeklyReminder, saxoBroker, accountFunding, saxoCalendar };
}

async function verifyFundingCurrency(
  venue: BrokerVenue,
  accountFunding: ProductionConfig['accountFunding'],
  logger: Logger,
): Promise<SameCurrencyVerdict | undefined> {
  const fundingToVerify = venue === 'saxo' ? accountFunding : undefined;
  if (fundingToVerify === undefined) return undefined;

  const sameCurrency = verifySameCurrency(await fundingToVerify.readFunding());
  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'same_currency_verified',
    level: sameCurrency.verified ? 'info' : 'warn',
    message: sameCurrency.verified
      ? 'account currency matches the declared book'
      : 'account currency does not match the declared book; refusing to start',
    payload: { ...sameCurrency },
  });
  assertSameCurrencyFunding(sameCurrency);
  return sameCurrency;
}

function resolveProductionConfig(deps: {
  injected: Partial<ProductionConfig>;
  alertChannels: ReturnType<typeof buildAlertChannels> | Record<string, never>;
  accountFunding: ProductionConfig['accountFunding'];
  sameCurrency: SameCurrencyVerdict | undefined;
  declaredRiskConfig: ProductionConfig['riskConfig'] | undefined;
  saxoBroker: ProductionConfig['broker'];
  saxoCalendar: ProductionConfig['tradingCalendar'];
  logger: Logger;
  db: StoreHandle;
  miArchive: MiArchiveStore;
  clock: ProductionConfig['clock'];
  mode: ProductionConfig['mode'];
}): ProductionConfig {
  const {
    injected,
    alertChannels,
    accountFunding,
    sameCurrency,
    declaredRiskConfig,
    saxoBroker,
    saxoCalendar,
    logger,
    db,
    miArchive,
    clock,
    mode,
  } = deps;

  return {
    ...alertChannels,
    ...(injected as ProductionConfig),
    ...(accountFunding === undefined ? {} : { accountFunding }),
    ...(sameCurrency === undefined || declaredRiskConfig === undefined
      ? {}
      : { riskConfig: armSameCurrencyCeilings(declaredRiskConfig, sameCurrency) }),
    ...(saxoBroker === undefined ? {} : { broker: saxoBroker }),
    ...(saxoCalendar === undefined ? {} : { tradingCalendar: saxoCalendar }),
    logger,
    db,
    miArchive,
    clock,
    mode,
  };
}

export async function startFromEnvironment(
  injected: Partial<ProductionConfig> = {},
): Promise<ProductionOrchestrator> {
  const missing = REQUIRED_INJECTED_CONFIG.filter((key) => injected[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Orchestrator cannot start: ${missing.length} required dependencies are not wired ` +
        `(${missing.join(', ')}). These are the per-stage tuning values, and nothing in this ` +
        'process can invent them. The transports are no longer on this list: the Alpaca broker ' +
        'and market-data clients, the LLM client and the account-state provider are built from ' +
        'the environment (#273/#286/#274/#276), and the three operator alert channels are ' +
        "selected by SAMURAI_ALERTS (#322) — telegram builds #275's TelegramBotApiClient, " +
        "log-only keeps the composition root's log-only stand-ins. For a paper run, pass the " +
        'checked-in starting profile: ' +
        'startFromEnvironment(paperStartingProfile(mode)) from server/apps/orchestrator/paper-profile.ts ' +
        '— that is exactly what `npm run orchestrator` does. To supply your own, see ' +
        'ProductionConfig in server/apps/orchestrator/production.ts.',
    );
  }

  const env = process.env.NODE_ENV ?? 'development';
  const mode = injected.mode ?? parseMode(process.env.SAMURAI_MODE);
  const alertsMode = resolveAlertsMode(injected);
  const venue = resolveBrokerVenue();
  assertCredentialsPresent(injected, alertsMode, mode, venue);

  const logger = injected.logger ?? new JsonLogger();

  let db = injected.db;
  if (db === undefined) {
    const dbPath = sharedStorePath();
    assertStorePathMatchesMode({ dbPath, mode });
    db = openSharedStore(dbPath);
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'info',
      message: 'orchestrator store opened',
      payload: { db_path: resolve(dbPath) },
    });
  }

  assertNoStaleKeyScheme(db);

  const miArchive = injected.miArchive ?? new MiArchiveStore(miArchivePath(mode));

  const alertChannels =
    alertsMode === undefined ? {} : buildAlertChannels({ alertsMode, injected, db, logger });

  const clock = injected.clock ?? new SystemClock();

  const { saxoTokenSource, saxoWeeklyReminder, saxoBroker, accountFunding, saxoCalendar } =
    await buildSaxoIntegration({ injected, venue, mode, db, logger, clock, alertChannels });

  const declaredRiskConfig = injected.riskConfig;
  const sameCurrency = await verifyFundingCurrency(venue, accountFunding, logger);

  const orchestrator = buildProductionOrchestrator(
    resolveProductionConfig({
      injected,
      alertChannels,
      accountFunding,
      sameCurrency,
      declaredRiskConfig,
      saxoBroker,
      saxoCalendar,
      logger,
      db,
      miArchive,
      clock,
      mode,
    }),
  );

  const started =
    saxoTokenSource === undefined
      ? orchestrator
      : withSaxoSessionStop(orchestrator, saxoTokenSource, saxoWeeklyReminder);

  const orphans = await orchestrator.start();
  saxoWeeklyReminder?.start();
  orchestrator.logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'orchestrator_started',
    level: orphans.length > 0 ? 'warn' : 'info',
    message: 'orchestrator started',
    payload: {
      env,
      mode,
      universe: orchestrator.universe.map((i) => i.asset),
      orphaned_go_verdicts: orphans.length,
    },
  });

  return started;
}

export function withSaxoSessionStop(
  orchestrator: ProductionOrchestrator,
  tokenSource: SaxoTokenSource,
  weeklyReminder?: SaxoWeeklyReminder,
): ProductionOrchestrator {
  return {
    ...orchestrator,
    stop: async () => {
      await orchestrator.stop();
      await tokenSource.stop();
      weeklyReminder?.stop();
    },
  };
}

export function startingProfileForMode(
  mode: ProductionConfig['mode'],
  logger?: Logger,
  venue: BrokerVenue = resolveBrokerVenue(),
): ReturnType<typeof paperStartingProfile> | LiveStartingProfile {
  if (mode === 'live') return liveStartingProfile(undefined, logger);
  return venue === 'saxo'
    ? paperStartingProfile(mode, saxoTradeableUniverse(), 'GBP')
    : paperStartingProfile(mode);
}

export function buildShutdownHandler(
  orchestrator: { stop: () => Promise<void> },
  effects: { exit: (code: number) => void; stderr: (message: string) => void } = {
    exit: (code) => process.exit(code),
    stderr: (message) => {
      process.stderr.write(message);
    },
  },
): () => void {
  let shuttingDown = false;

  return () => {
    if (shuttingDown) return;
    shuttingDown = true;

    void orchestrator.stop().then(
      () => effects.exit(0),
      (error: unknown) => {
        effects.stderr(`orchestrator shutdown failed: ${describeThrownSafely(error)}\n`);
        effects.exit(1);
      },
    );
  };
}

export function installFaultHandlers(
  logger: Logger,
  effects: {
    exit: (code: number) => void;
    stderr: (message: string) => void;
    on: (
      event: 'uncaughtException' | 'unhandledRejection',
      handler: (error: unknown) => void,
    ) => void;
  } = {
    exit: (code) => process.exit(code),
    stderr: (message) => {
      process.stderr.write(message);
    },
    on: (event, handler) => {
      process.on(event, handler);
    },
  },
): void {
  const fatal = (fault: 'uncaughtException' | 'unhandledRejection') => (error: unknown) => {
    const message = describeThrownSafely(error);
    logCaughtFailure(
      logger,
      {
        trace_id: 'fatal',
        stage: 'orchestrator',
        event: 'orchestrator_fatal_fault',
        level: 'error',
        message:
          `${fault} — the orchestrator is exiting rather than continuing in an unknown state ` +
          'with open positions (#714)',
      },
      error,
      { fault },
    );
    try {
      effects.stderr(`orchestrator ${fault}: ${message}\n`);
    } catch {}
    effects.exit(1);
  };

  effects.on('uncaughtException', fatal('uncaughtException'));
  effects.on('unhandledRejection', fatal('unhandledRejection'));
}

export function runEntrypointLogRetention(
  fileSinkConfig: FileSinkConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): LogRetentionResult {
  return sweepStaleLogsWithLog(
    {
      directory: dirname(fileSinkConfig.filePath),
      maxAgeMs: logRetentionDaysFromEnvironment(env) * 24 * 60 * 60 * 1000,
      keepNames: logRetentionKeepNamesFromEnvironment(env),
      bareTruncateBytes: logBareTruncateBytesFromEnvironment(env),
      bareTruncateNames: logBareTruncateNamesFromEnvironment(env),
      protectedPaths: [
        fileSinkConfig.filePath,
        ...Array.from(
          { length: fileSinkConfig.maxRotatedFiles },
          (_, index) => `${fileSinkConfig.filePath}.${index + 1}`,
        ),
      ],
    },
    logger,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fileSinkConfig = fileSinkConfigFromEnvironment();
    const entrypointLogger = buildEntrypointLogger(fileSinkConfig);
    installFaultHandlers(entrypointLogger);
    runEntrypointLogRetention(fileSinkConfig, entrypointLogger);
    const mode = parseMode(process.env.SAMURAI_MODE);
    const venue = resolveBrokerVenue();
    const tradingCalendar =
      mode === 'paper' && venue !== 'saxo'
        ? await resolveUsEquitySessionCalendar({ logger: entrypointLogger, now: () => new Date() })
        : undefined;
    const orchestrator = await startFromEnvironment({
      ...startingProfileForMode(mode, entrypointLogger, venue),
      logger: entrypointLogger,
      ...(tradingCalendar === undefined ? {} : { tradingCalendar }),
    });
    const shutdown = buildShutdownHandler(orchestrator);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
