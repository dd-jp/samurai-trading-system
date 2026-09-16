/**
 * Orchestrator — main entry point (`npm run orchestrator`): assembles a
 * `ProductionConfig` and starts the tick loop. Also the package's export
 * surface, so the entrypoint guard at the bottom must not fire on import.
 * Transports and credentials are deliberately not in the checked-in starting
 * profile — `SAMURAI_ALERTS` and `assertCredentialsPresent` below fail fast
 * rather than starting half-wired against real money.
 */
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
export { digest } from './digest.js';
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

/**
 * Per-stage config objects this entrypoint cannot derive and must be supplied
 * explicitly — required even though `./paper-profile.ts` satisfies it, so a
 * caller that forgets one is told which. `universe` is included because,
 * unlike `production.ts`'s library default (`SMOKE_TEST_UNIVERSE`), a
 * fallback resolved on a closed session here produces an empty tick plan
 * indistinguishable from a healthy no-trade run, so this entrypoint refuses
 * to guess.
 */
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

/**
 * Defaults absent to `paper`, throws on anything unrecognised. Deliberately
 * does NOT trim: `'live '` trimmed would resolve to `live`, turning a hard
 * refusal into a real-money path — live must be typed exactly.
 */
function parseMode(raw: string | undefined): ProductionConfig['mode'] {
  if (raw === undefined) return 'paper';
  const mode = MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw new Error(`Orchestrator cannot start: SAMURAI_MODE must be one of ${MODES.join('|')}.`);
  }
  return mode;
}

/**
 * Credentials the composition root's defaults read from `process.env`,
 * checked here ahead of construction so a missing one is reported all at
 * once rather than one per run through `buildProductionComponents`. A
 * function, not a module constant: `server/tools/backtest` imports this
 * module back, so the clients' env-var tables can be mid-initialization when
 * this is first evaluated.
 */
export function credentialRequirements(): readonly {
  vars: readonly string[];
  /** True when this run never touches these variables (injected client, or an alerts mode needing no transport credentials) */
  unusedByThisRun: (context: {
    injected: Partial<ProductionConfig>;
    alertsMode: AlertsMode | undefined;
    /** The resolved trading mode — makes the live Alpaca pair required, or unread */
    mode: ProductionConfig['mode'];
    /** The resolved broker venue — decides whether the Alpaca ORDER path exists at all */
    venue: BrokerVenue;
    /** Whether `npm run saxo:login` saved a SIM session; passed in so both Saxo entries below are testable without a token file */
    savedSaxoSession: boolean;
  }) => boolean;
  /**
   * Names in `vars` a DIFFERENT variable can satisfy instead, keyed by the
   * name reported when none is set — e.g. `nousCredentials`' fallback chain,
   * where demanding the shared key alongside a per-role one would block a
   * boot on a variable nothing reads.
   */
  alternatives?: Readonly<Record<string, readonly string[]>>;
}[] {
  return [
    {
      vars: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'],
      // Both the ORDER half and the DATA half must be covered before the pair
      // can be called unread. Each clause below names a construction site
      // rather than an intention, since getting this wrong permissively
      // means a boot that 401s on its first order
      unusedByThisRun: ({ injected, venue }) =>
        alpacaOrderPathUnused(injected, venue) && alpacaDataPathUnused(injected),
    },
    {
      // The live account's own pair, live-only by design — a paper boot
      // never looks these up, so an operator without live keys still gets a
      // clean paper start. The PAPER pair above stays required in live mode
      // too: `buildDefaultAlpacaDataClient` has no mode branch and always
      // reads `ALPACA_API_KEY` for bars
      vars: [ALPACA_CREDENTIAL_ENV_VARS.live.key, ALPACA_CREDENTIAL_ENV_VARS.live.secret],
      unusedByThisRun: ({ injected, mode }) =>
        mode !== 'live' || injected.alpacaBrokerClient !== undefined,
    },
    {
      // One provider, one base URL, no default. The key is a fallback chain
      // (per-role key, or `NOUS_API_KEY` for every role) — skipped when
      // `llmClient` is injected, since a caller supplying its own client is
      // not asked for keys it will never read
      vars: ['NOUS_API_KEY', 'NOUS_BASE_URL'],
      alternatives: { NOUS_API_KEY: ['NOUS_DEBATE_API_KEY', 'NOUS_SENTIMENT_API_KEY'] },
      unusedByThisRun: ({ injected }) => injected.llmClient !== undefined,
    },
    {
      // Required only under `SAMURAI_ALERTS=telegram` — the alerts mode is
      // resolved before this pre-flight runs for exactly that reason
      vars: TELEGRAM_ALERT_ENV_VARS.filter((name) => name !== TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR),
      unusedByThisRun: ({ alertsMode }) => alertsMode !== 'telegram',
    },
    {
      // The heartbeat's own chat, split from the three above since an
      // injected `heartbeatChannel` is the only thing that makes it
      // unnecessary — the escalation chat stays required either way
      vars: [TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR],
      unusedByThisRun: ({ injected, alertsMode }) =>
        alertsMode !== 'telegram' || injected.heartbeatChannel !== undefined,
    },
    {
      // The SIM gateway's 24-hour bearer only — live is refused outright
      // It's a FALLBACK, not the only way in: a saved `npm run saxo:login`
      // session reads its bearer from the token file instead, matching
      // `buildSaxoTokenSource`'s own choice
      vars: [SAXO_CREDENTIAL_ENV_VARS.sim.token],
      unusedByThisRun: ({ injected, venue, savedSaxoSession }) =>
        venue !== 'saxo' ||
        injected.saxoBrokerClient !== undefined ||
        injected.broker !== undefined ||
        savedSaxoSession,
    },
    {
      // The other half: the saved-session branch does NOT read the pasted
      // token but hard-requires the app credentials (every refresh re-sends
      // them as Basic auth) — without this a token-file run with no app key
      // passes the pre-flight and fails on the first `getAccessToken`
      vars: [SAXO_APP_CREDENTIAL_ENV_VARS.sim.appKey, SAXO_APP_CREDENTIAL_ENV_VARS.sim.appSecret],
      unusedByThisRun: ({ injected, venue, savedSaxoSession }) =>
        venue !== 'saxo' ||
        injected.saxoBrokerClient !== undefined ||
        injected.broker !== undefined ||
        !savedSaxoSession,
    },
  ];
}

/**
 * True when nothing in this run constructs an Alpaca ORDER client. See the
 * `ALPACA_API_KEY` entry above; split out so both clauses are testable and so
 * the two halves of the pair's exemption cannot be read as one condition.
 */
function alpacaOrderPathUnused(injected: Partial<ProductionConfig>, venue: BrokerVenue): boolean {
  if (injected.alpacaBrokerClient !== undefined) return true;
  const brokerIsNotAlpaca = injected.broker !== undefined || venue === 'saxo';
  const accountReadIsSupplied =
    injected.accountState !== undefined ||
    injected.accountFunding !== undefined ||
    // A Saxo run builds its own GBP-native funding read, keyed off the same
    // condition `startFromEnvironment` builds `saxoAccountFunding` on so the
    // two cannot drift
    saxoFundingWillBeBuilt(injected, venue);
  return brokerIsNotAlpaca && accountReadIsSupplied;
}

/**
 * Whether `startFromEnvironment` will build the Saxo funding read for this run.
 *
 * Read by the credential pre-flight as well as the wiring, so what the
 * operator is asked for and what is actually constructed cannot disagree.
 */
function saxoFundingWillBeBuilt(injected: Partial<ProductionConfig>, venue: BrokerVenue): boolean {
  return (
    venue === 'saxo' &&
    injected.broker === undefined &&
    injected.saxoBrokerClient === undefined &&
    injected.accountState === undefined &&
    injected.accountFunding === undefined
  );
}

/** True when nothing in this run constructs an Alpaca MARKET-DATA client */
function alpacaDataPathUnused(injected: Partial<ProductionConfig>): boolean {
  if (injected.dataSource !== undefined || injected.alpacaDataClient !== undefined) return true;
  if (injected.lseMarkClient === undefined) return false;
  const universe = injected.universe ?? [];
  // Every instrument, and at least one — a MIXED universe is refused by
  // `buildLseMarkSourceIfNeeded` rather than routed
  return universe.length > 0 && universe.every((instrument) => LSE_TICKERS.has(instrument.asset));
}

/**
 * Every credential this run will need and does not have. Empty and
 * whitespace-only both count as absent — the tracked `.env` ships Alpaca
 * keys as empty placeholders, and `requireEnv`/`nonEmpty` elsewhere already
 * trim before deciding, so this pre-flight must agree or a quoted-empty value
 * would pass here and throw one step later. Returns names only; never reads,
 * echoes, or logs a credential's value.
 */
export function missingCredentialEnvVars(
  injected: Partial<ProductionConfig>,
  alertsMode: AlertsMode | undefined,
  /** The resolved trading mode. Required, not defaulted to `paper` — that default would make the live-credential requirement vacuous. */
  mode: ProductionConfig['mode'],
  /** The resolved broker venue, required for `mode`'s reason — defaulting to `alpaca` would make the Saxo token requirement vacuous */
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

/**
 * Fails the process before anything is constructed when a credential the
 * defaults need is absent. This is correct behaviour, not an obstacle: a
 * trading process that cannot authenticate must stop loudly rather than start
 * into a half-alive state and discover it on its first order.
 */
function assertCredentialsPresent(
  injected: Partial<ProductionConfig>,
  alertsMode: AlertsMode | undefined,
  mode: ProductionConfig['mode'],
  venue: BrokerVenue,
): void {
  const missing = missingCredentialEnvVars(injected, alertsMode, mode, venue);
  if (missing.length === 0) return;

  // Named separately: these are missing because of a mode the operator
  // selected, and re-selecting the other mode is a way out the generic
  // advice below does not suggest
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

/**
 * Whether `dbPath`'s filename identifies its trading mode (e.g.
 * `data/samurai-paper.sqlite` / `data/samurai-live.sqlite`). Filename only,
 * never the directories above it — a checkout living under `~/live/` must
 * not silence this by accident.
 */
export function storePathEncodesTradingMode(
  dbPath: string,
  mode: ProductionConfig['mode'],
): boolean {
  return basename(dbPath).includes(mode);
}

/**
 * Refuses to start when the file this process is about to write cannot
 * distinguish paper money from real money. The one case this catches: an
 * INJECTED mode disagreeing with `SAMURAI_MODE` — invisible otherwise, since
 * `sharedStorePath` reads the environment and would silently write live
 * state into the paper database.
 */
export function assertStorePathMatchesMode(deps: {
  dbPath: string;
  mode: ProductionConfig['mode'];
}): void {
  if (storePathEncodesTradingMode(deps.dbPath, deps.mode)) return;

  throw new Error(
    `Orchestrator cannot start: it is about to run in '${deps.mode}' mode but the shared store ` +
      // Filename, not the absolute path — a startup error is not the place to disclose a home directory
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

  // The Saxo venue, built HERE (not the composition root) because resolving
  // its instruments is async while `buildProductionOrchestrator` is
  // synchronous. `injected.broker` wins over the environment, since a caller
  // that passed its own adapter has already chosen. ONE Saxo client per run
  // — the broker and funding read share it, since the pacing budget belongs
  // to the account, not the client
  const saxoIsOwnedHere =
    venue === 'saxo' && injected.broker === undefined && injected.saxoBrokerClient === undefined;

  // No forced log-only default (unlike `legResizeAlerts` below) — `lose()`'s
  // own `saxo_session_lost` line already covers that mode
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

  // The other half: scoped to the same condition as `saxoTokenSource`, since
  // this nudge belongs to the token file this process itself owns
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

  // The GBP-native funding read — skipped when the caller supplied a whole
  // `accountState`/funding source, or (via `saxoClient`) a broker/wire client
  const saxoAccountFunding =
    saxoClient !== undefined && saxoFundingWillBeBuilt(injected, venue)
      ? saxoFunding(saxoClient)
      : undefined;
  const accountFunding = injected.accountFunding ?? saxoAccountFunding;
  const saxoWireClient = injected.saxoBrokerClient ?? saxoClient;

  const saxoBroker =
    venue === 'saxo' && injected.broker === undefined
      ? await buildSaxoBroker({
          mode,
          universe: injected.universe ?? [],
          accountState: injected.accountState,
          ...(accountFunding === undefined ? {} : { accountFunding }),
          db,
          logger,
          clock,
          // Alert channels the adapter requires with no default: caller
          // first, then `SAMURAI_ALERTS`' transport, then the log-only stand-in
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
        })
      : undefined;

  // The venue picks the CALENDAR too. Left unset, a Saxo run would gate
  // entries on New York and carry ~4.5h overnight past a 16:30 London close,
  // and the LSE table-coverage guard would never arm. `injected` wins over
  // this, same as `broker`
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
  // Armed from the real read or not at all. Runs on every Saxo boot, not
  // only when there's a ceiling to arm — sizing reads this source's
  // `equity` regardless. Scoped by VENUE (not by who built the source) so
  // an injected `accountFunding` is checked too: `venue === 'saxo'` is what
  // makes `LIVE_BOOK_CURRENCY` the right book
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

/**
 * Assembles a `ProductionConfig` from the environment plus `injected`, builds
 * the composition root, and starts it. Throws — before opening any broker
 * connection — if any required dependency or credential is absent, or if
 * `SAMURAI_ALERTS` is unset. DB path is one file per TRADING MODE, keyed off
 * `SAMURAI_MODE` (previously `NODE_ENV`, which let one host write paper and
 * live state into the same file).
 */
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
  // An explicitly injected mode wins over the environment — must not silently
  // downgrade a deliberate `backtest`/`live` to whatever `SAMURAI_MODE` says
  const mode = injected.mode ?? parseMode(process.env.SAMURAI_MODE);
  // Before the credential pre-flight: alerts mode decides whether Telegram
  // variables are needed, so the pre-flight can't name them until this resolves
  const alertsMode = resolveAlertsMode(injected);
  // Resolved here for the same reason: venue decides whether the Alpaca pair
  // is needed. An injected `broker` does not suppress it.
  const venue = resolveBrokerVenue();
  // Before the store is opened: a run that cannot authenticate should not
  // leave a freshly-created SQLite file behind as a side effect of failing
  assertCredentialsPresent(injected, alertsMode, mode, venue);

  // One logger for the whole startup: the warning below must land on the
  // same stream as every line after it
  const logger = injected.logger ?? new JsonLogger();

  // Resolved and warned about before opening, and only when we resolved it —
  // an injected handle's path is not ours to guess at
  let db = injected.db;
  if (db === undefined) {
    const dbPath = sharedStorePath();
    assertStorePathMatchesMode({ dbPath, mode });
    db = openSharedStore(dbPath);
    // `dbPath` is relative to the process's cwd, which the orchestrator and
    // dashboard can each resolve differently with no error on either side —
    // naming the resolved ABSOLUTE path here makes that mismatch visible
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'info',
      message: 'orchestrator store opened',
      payload: { db_path: resolve(dbPath) },
    });
  }

  // Rollout guard: runs against both the handle we opened and one the caller
  // injected, before `orchestrator.start()` arms the tick loop — once a pass
  // is in flight a replay can already have placed the duplicate order
  assertNoStaleKeyScheme(db);

  // The MI archive, in its own database file, opened here so one process
  // holds one handle. Its absence is not neutral — without it
  // `sentiment`/`fundamental` report NO DATA every tick and the conviction
  // ceiling stays in force
  const miArchive = injected.miArchive ?? new MiArchiveStore(miArchivePath(mode));

  // Built after the store is open (Telegram audit-logs through it) and
  // spread before `injected`, so an explicitly-passed channel always wins
  const alertChannels =
    alertsMode === undefined ? {} : buildAlertChannels({ alertsMode, injected, db, logger });

  const clock = injected.clock ?? new SystemClock();

  const { saxoTokenSource, saxoWeeklyReminder, saxoBroker, accountFunding, saxoCalendar } =
    await buildSaxoIntegration({ injected, venue, mode, db, logger, clock, alertChannels });

  const declaredRiskConfig = injected.riskConfig;
  const sameCurrency = await verifyFundingCurrency(venue, accountFunding, logger);

  const orchestrator = buildProductionOrchestrator({
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
  });

  const started =
    saxoTokenSource === undefined
      ? orchestrator
      : withSaxoSessionStop(orchestrator, saxoTokenSource, saxoWeeklyReminder);

  const orphans = await orchestrator.start();
  // Armed after a successful boot, not at construction — a boot that throws
  // before this line should not leave a reminder timer running
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
      // Read off the orchestrator's own resolution, not re-derived from `injected.universe`
      universe: orchestrator.universe.map((i) => i.asset),
      orphaned_go_verdicts: orphans.length,
    },
  });

  return started;
}

/**
 * Folds the token refresher into the orchestrator's own shutdown, AFTER it:
 * `orchestrator.stop()`'s drain still sends Saxo requests, so stopping the
 * refresher first would drain on an expired bearer, and `stop()` is awaited
 * so it joins an in-flight token rotation rather than stranding the session
 * mid-rename
 */
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

/**
 * The profile the shipped entrypoint boots on for the mode the operator asked
 * for — exported so this hop is testable behind the unreachable
 * `import.meta.url` guard below. The venue chooses the UNIVERSE here rather
 * than after: `buildStartingProfileConfigs` derives risk envelopes FROM the
 * universe it's given, so a Saxo universe spread over an already-built
 * profile would arm against the wrong instruments invisibly.
 */
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

/**
 * Builds the SIGINT/SIGTERM handler: drain, then exit deterministically.
 * Exported (effects injected) so two things are testable behind the
 * unreachable entrypoint guard: a rejected drain exits 1 with a message only
 * (never the error object, which may hold credentials), and a second signal
 * is ignored rather than re-entering `stop()` — which would exit 0 *through*
 * the first drain, manufacturing an orphaned-verdict gap.
 */
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

/**
 * The last-resort fault net: record an unhandled fault durably (through
 * `logger`, which survives a dead stdout), then exit non-zero. Not a
 * swallow — every fault that reaches it ends the process; this only makes the
 * death diagnosable and message-only, matching the startup `catch` below.
 * A broken stdout pipe is handled separately, at its origin, by
 * `watchStdoutErrors` (logger.ts) — this handler doesn't special-case error
 * codes, since a live-money process in an unknown state must stop, and no
 * drain is attempted here (that's `buildShutdownHandler`'s job).
 */
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
    // `logCaughtFailure`, not `logger.log`: the logger can throw when it has
    // no sink left, and a fault handler that throws hides the fault it was called about
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
    } catch {
      // stderr can be as dead as stdout; the exit below is the message then
    }
    effects.exit(1);
  };

  effects.on('uncaughtException', fatal('uncaughtException'));
  effects.on('unhandledRejection', fatal('unhandledRejection'));
}

/**
 * Boot sweep over `logs/`. `RotatingFileSink` bounds only
 * `fileSinkConfig.filePath` — everything else a run leaves in `logs/` is
 * unbounded growth on the host holding live position state. A separate
 * exported function (not inlined in the guard below) because `dirname` of an
 * operator's `SAMURAI_LOG_FILE` decides which directory gets files deleted
 * from it — `index.test.ts` needs a seam to assert on.
 */
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

// Entrypoint guard: `npm run orchestrator` runs this file directly, but it is
// also the package's export surface — importing it must not start a trading
// process
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // The profile is passed explicitly, never defaulted into
    // `startFromEnvironment`: `parseMode` runs here so `paperStartingProfile`
    // can refuse `live` before anything is constructed. The logger is passed
    // here and only here — this is the deployment that needs a durable trace
    // for an unattended soak; `startFromEnvironment` keeps its stdout-only
    // fallback so no test opens a file as a side effect
    const fileSinkConfig = fileSinkConfigFromEnvironment();
    const entrypointLogger = buildEntrypointLogger(fileSinkConfig);
    installFaultHandlers(entrypointLogger);
    runEntrypointLogRetention(fileSinkConfig, entrypointLogger);
    const mode = parseMode(process.env.SAMURAI_MODE);
    // Resolved HERE, not inside `startFromEnvironment`, since dozens of tests
    // call that directly with no `fetch` stubbed. PAPER only — a backtest
    // fetching this would be actively wrong, since the window is anchored to
    // wall-clock `now` and would silently zero out historical bars. NOT on a
    // Saxo run: this is Alpaca's US calendar, and injecting it would override
    // the LSE calendar the venue resolves
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
    // Message only — never the config object, which holds API credentials
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
