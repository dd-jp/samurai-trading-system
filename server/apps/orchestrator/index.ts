/**
 * Orchestrator — see docs/specs/orchestrator-spec.md, epic #60.
 * Main entry point (`npm run orchestrator`).
 *
 * Ticket #94: the scheduler, the sequential stage chain, and bounded
 * concurrency across instruments. Ticket #95: trace-ID propagation into
 * structured logs and the `audit_log` spine (`JsonLogger`, `digest`).
 * Ticket #96: the `current_tick` row and the dead-man's-switch heartbeat
 * (`Heartbeat`, the catalogue's `heartbeatChannel`). Ticket #201: `SqliteAuditLog`/
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
 * `UniverseScheduler` over the configured universe (`DEFAULT_UNIVERSE` for a
 * paper start since #381; `SMOKE_TEST_UNIVERSE` remains the default for a
 * caller that supplies none), the `Heartbeat`,
 * and the `OrphanVerdictScanner`, and owns the start/stop of the tick loop.
 * (This supersedes the earlier note here that no composition root could
 * exist until #83/#86/#71 landed — all three are closed and merged.)
 *
 * This file is also the process entrypoint (`npm run orchestrator`): run
 * directly, it assembles a `ProductionConfig` and starts the loop.
 *
 * Ticket #323: it now actually can. The entrypoint passes the checked-in
 * paper starting profile (`./paper-profile.ts`) — the eight per-stage config
 * objects `REQUIRED_INJECTED_CONFIG` demands, every value carrying its
 * provenance — so there is a path from `yarn orchestrator` to a running tick
 * loop for the first time. Those values are explicitly a *starting point for
 * tuning*, not tuned values, and `paperStartingProfile` refuses `live`
 * outright for that reason.
 *
 * What the profile deliberately does NOT supply is the transports. Ticket
 * #322 supplies the operator-facing three (heartbeat, orphaned go verdict,
 * stuck unpriced fill) here instead, from `SAMURAI_ALERTS` — a REQUIRED
 * variable with no default, because falling back to the log-only stand-ins by
 * omission is precisely what made the "unattended" soak (#238) not unattended.
 * See `./alert-transport.ts` for the full rationale. Credentials are not
 * supplied either, and must not be: `assertCredentialsPresent` below fails the
 * process fast, naming every missing variable, rather than starting a
 * half-wired process against real money.
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
export { paperStartingProfile, RISK_CAP_EQUITY_FRACTIONS } from './paper-profile.js';
export {
  ALERT_AFTER_CONSECUTIVE_SKIPS,
  ALERT_REPEAT_EVERY_SKIPS,
  type AnalystSkipAlert,
  type AnalystSkipAlertChannel,
  buildAnalystsStep,
} from './production/analysts-adapter.js';
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
 * The per-stage config objects the process cannot derive from the environment
 * or from in-repo code, and must therefore be supplied by the caller.
 *
 * Every remaining entry is a set of *tuning values*. The transports are no
 * longer among them: the Alpaca broker/market-data clients and the LLM client
 * are built from the environment (#273/#286/#274), the account-state provider
 * is composed in-repo (#276), and the three operator alert channels are built
 * from `SAMURAI_ALERTS` plus the Telegram variables (#322, `TelegramBotApiClient`
 * from #275). The HITL `approvals` channel is the one human-facing seam still
 * on a log-only default — an inbound round trip, not an alert, and #275's
 * remaining half.
 *
 * The list stays required even though `./paper-profile.ts` now satisfies it,
 * and that is deliberate: a programmatic caller that forgets one must still be
 * told which one, by name, rather than silently inheriting a profile nobody
 * chose. The shipped entrypoint passes the profile explicitly; nothing
 * defaults to it.
 *
 * **`universe` joined this list in #738, and it is the odd one out on
 * purpose.** Every other member is a per-stage tuning value with no sane
 * process-wide default; `universe` actually has one — `buildProductionComponents`
 * (production.ts) still falls back to `SMOKE_TEST_UNIVERSE` for a library
 * caller that constructs an orchestrator directly. This process's own
 * composition root is different: an equities-only fallback resolved on a
 * closed session produces an EMPTY tick plan, which is indistinguishable from
 * a healthy no-trade run (#691, #625 both presented with exactly that
 * signature) — so `startFromEnvironment` refuses to guess and demands an
 * explicitly-configured universe instead. The library default is unchanged;
 * only this entrypoint's silence is closed.
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
 * `SAMURAI_MODE` is not a free-form string: it selects the HITL posture as
 * well as the broker. `backtest` overrides gate 6's outcome to `go` once the
 * injected `ApprovalChannel` answers, rather than skipping the call — a
 * channel that throws instead of answering still refuses (verdict/index.ts)
 * — and `live` spends real money, so a typo'd or unset-to-
 * garbage value must not be cast through — it defaults to `paper` when
 * absent and throws when present and unrecognised.
 *
 * **Deliberately does not trim**, unlike `SAMURAI_ALERTS` and the chat ids
 * (#342 follow-up). Examined during that sweep and left alone, because both
 * edges move the wrong way here: `'live '` throws today and would resolve to
 * `live` with a trim — turning a hard refusal into a real-money path — and
 * `'  '` throws today but would become "absent", silently defaulting to
 * `paper`. Where the trimmed value could be `live`, a value nobody typed
 * exactly is refused rather than guessed at, per production.ts: live "is not
 * reachable by omission, by a defaulted constant, or by a mis-set env var".
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
 * The credentials the composition root's own defaults will read straight out
 * of `process.env`, listed against the injected override that would make each
 * one unnecessary.
 *
 * Checked here, ahead of construction, purely so the operator learns about all
 * of them at once. Each client already refuses to be built without its key —
 * that check is the authority and stays where it is — but they are constructed
 * one after another inside `buildProductionComponents`, so an unconfigured
 * host otherwise reveals exactly one missing variable per run, and only the
 * first one.
 *
 * The overrides are not incidental: `buildProductionComponents` builds the
 * Alpaca *broker* client lazily (the account-state provider needs it whenever
 * `ProductionConfig.accountState` is not supplied, even when
 * `ProductionConfig.broker` is overridden — #1400), while the *data* client
 * is skipped when either `dataSource` or `alpacaDataClient` is supplied, and
 * the LLM client is skipped when `llmClient` is. A test injecting stubs must
 * not be asked for keys it will never use.
 *
 * **A function, not a module-level constant.** The entries name variables
 * through the clients' own exported tables, and `server/tools/backtest`
 * imports this module back (`trial-execution.ts` reads `digest`), so those
 * tables can be mid-initialization when this module is first evaluated —
 * `SAXO_CREDENTIAL_ENV_VARS` read as `undefined` at module scope and threw at
 * import time. Building the list per call reads them when they are needed
 * instead, which is also the only moment their values matter.
 */
export function credentialRequirements(): readonly {
  vars: readonly string[];
  /**
   * True when this run never touches these variables — because the caller
   * injected the client that would have read them, or because the alerts mode
   * it selected needs no transport credentials at all.
   */
  unusedByThisRun: (context: {
    injected: Partial<ProductionConfig>;
    alertsMode: AlertsMode | undefined;
    /** The resolved trading mode — what makes the live Alpaca pair required, or a variable this run will never read (#511). */
    mode: ProductionConfig['mode'];
    /** The resolved broker venue (#1400) — what decides whether the Alpaca ORDER path exists at all. */
    venue: BrokerVenue;
    /**
     * Whether `yarn saxo:login` has saved a SIM session (#1523). Passed in
     * rather than read here so the two Saxo entries below — which require
     * opposite sets of variables on opposite sides of it — are testable
     * without a token file on the machine running the suite.
     */
    savedSaxoSession: boolean;
  }) => boolean;
  /**
   * Names in `vars` that a DIFFERENT variable can satisfy instead, keyed by
   * the name reported when none of them is set.
   *
   * `vars` is otherwise all-required, which is right for a credential pair
   * like Alpaca's key and secret — both are read, so both must be there. It is
   * wrong for a fallback chain: `nousCredentials` resolves a role's key as
   * `NOUS_<ROLE>_API_KEY` then `NOUS_API_KEY`, so an operator who sets a key
   * per model has configured the run completely, and demanding the shared one
   * as well would block a boot on a variable nothing would read — the exact
   * "keys it will never use" complaint the `unusedByThisRun` escape exists to
   * avoid, one level down.
   */
  alternatives?: Readonly<Record<string, readonly string[]>>;
}[] {
  return [
    {
      vars: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'],
      // Both halves of what these keys serve have to be covered before the pair
      // can be called unread, and #1400 added a second way to cover each. The
      // ORDER half is covered by an injected wire client as before, and now
      // also by a run whose broker is not Alpaca AND whose account state is
      // supplied — `buildProductionComponents` builds the Alpaca wire client
      // lazily since #1400 precisely so those two together mean it is never
      // constructed. The DATA half is covered by an injected source or client as
      // before, and now also by an all-LSE universe with an `lseMarkClient`:
      // `buildAlpacaDataSource` returns `LseMarkDataSource` before it reaches
      // any Alpaca client at all (defaults.ts).
      //
      // Getting this wrong in the permissive direction is the dangerous one — a
      // run that boots and 401s on its first order — which is why each clause
      // names a construction site rather than an intention.
      unusedByThisRun: ({ injected, venue }) =>
        alpacaOrderPathUnused(injected, venue) && alpacaDataPathUnused(injected),
    },
    {
      // #511. The live account's own pair — see `ALPACA_CREDENTIAL_ENV_VARS`
      // (execution/adapters/alpaca-http-client.ts) for why the pair is keyed by
      // environment and never falls back.
      //
      // **Live only, and that asymmetry is the point.** `unusedByThisRun` returns
      // true for paper and backtest, so a paper boot never looks these variables
      // up: an operator who has not yet been issued live keys, or who typo'd one,
      // still gets a clean paper start. The client's constructor refuses on the
      // same condition and is the authority; this entry exists so the operator
      // learns about them alongside every other missing credential instead of one
      // per attempt.
      //
      // The PAPER pair above stays required in live mode too, deliberately:
      // `buildDefaultAlpacaDataClient` has no mode branch (Alpaca serves market
      // data from one host for both account types) and still reads
      // `ALPACA_API_KEY`. A live run therefore needs both pairs — the live one for
      // orders, the paper one for bars.
      //
      // Names taken from the client's own table rather than restated: this
      // pre-flight exists to report what the constructor would refuse on, so two
      // lists of strings that could drift apart would defeat it.
      vars: [ALPACA_CREDENTIAL_ENV_VARS.live.key, ALPACA_CREDENTIAL_ENV_VARS.live.secret],
      unusedByThisRun: ({ injected, mode }) =>
        mode !== 'live' || injected.alpacaBrokerClient !== undefined,
    },
    {
      // ADR-0009: one provider, one base URL. `NOUS_BASE_URL` is unconditional —
      // there is no default in source, so nothing can resolve without it.
      //
      // The key is a fallback chain, not a single variable: a per-role key
      // satisfies the requirement on its own, because that is the "a key per
      // model" setup ADR-0009 was asked for. `NOUS_API_KEY` is the name reported
      // when none of them is set, since it is the one that configures every role
      // at once. The `_MODEL` variables are not listed at all — they are
      // optional overrides with role defaults behind them.
      //
      // Skipped when `llmClient` is injected, same as the Anthropic entry this
      // replaces: a caller supplying its own client is not asked for keys it
      // will never read. The market-intelligence agent shares these variables
      // and degrades to no-agent when they are absent, so it does not widen the
      // requirement.
      vars: ['NOUS_API_KEY', 'NOUS_BASE_URL'],
      alternatives: { NOUS_API_KEY: ['NOUS_DEBATE_API_KEY', 'NOUS_SENTIMENT_API_KEY'] },
      unusedByThisRun: ({ injected }) => injected.llmClient !== undefined,
    },
    {
      // #322. Required only under `SAMURAI_ALERTS=telegram`, which is why the
      // alerts mode is resolved before this pre-flight runs rather than
      // alongside it — the mode is what decides whether these are credentials
      // this run needs or variables it will never read. `log-only` (and a caller
      // that injected every channel, which resolves to `undefined`) needs none.
      vars: TELEGRAM_ALERT_ENV_VARS.filter((name) => name !== TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR),
      unusedByThisRun: ({ alertsMode }) => alertsMode !== 'telegram',
    },
    {
      // #342. The heartbeat's own chat, split out from the three above for one
      // reason: it is the only one an injected channel makes unnecessary. A
      // caller that passed `heartbeatChannel` has already chosen where the beat
      // goes, and nothing in `buildAlertChannels` will read this variable — so
      // demanding it would be the same "keys it will never use" complaint the
      // Alpaca and Anthropic entries above exist to avoid. The escalation chat
      // stays required either way; that is the destination this exists to keep
      // free of heartbeats.
      vars: [TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR],
      unusedByThisRun: ({ injected, alertsMode }) =>
        alertsMode !== 'telegram' || injected.heartbeatChannel !== undefined,
    },
    {
      // #1400. The SIM gateway's 24-hour bearer, and only the SIM one: the
      // Saxo venue refuses `SAMURAI_MODE=live` outright (saxo-venue.ts), so
      // `SAXO_LIVE_ACCESS_TOKEN` is a variable no run this repo can start will
      // ever read and is deliberately absent from this list.
      //
      // Named from the client's own table rather than restated, for the reason
      // the live Alpaca entry gives: this pre-flight exists to report what the
      // constructor would refuse on, and two lists that could drift apart
      // defeat it.
      // Since #1523 the variable is the FALLBACK, not the only way in: a run
      // with a saved `yarn saxo:login` session reads its bearer from the token
      // file and renews it, so demanding the pasted token there would refuse
      // exactly the boot this repo now wants. `buildSaxoTokenSource` makes the
      // same choice in the same order; this stays a report of what that
      // constructor would refuse on.
      vars: [SAXO_CREDENTIAL_ENV_VARS.sim.token],
      unusedByThisRun: ({ injected, venue, savedSaxoSession }) =>
        venue !== 'saxo' ||
        injected.saxoBrokerClient !== undefined ||
        injected.broker !== undefined ||
        savedSaxoSession,
    },
    {
      // The other half of the entry above: the saved-session branch does NOT
      // read the pasted token, but it hard-requires the app credentials —
      // `buildSaxoTokenSource` → `resolveSaxoOAuthConfig` throws
      // `SAXO_SIM_APP_KEY is not set` — and every refresh re-sends them as
      // Basic auth. Without this a run with a token file and no app key
      // passes the pre-flight and fails on the first `getAccessToken`, which
      // is exactly the drift this list exists to prevent. Only SIM, for the
      // reason above: live is refused outright.
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
    // #1509: a Saxo run builds its own GBP-native funding read, so the
    // lazily-built Alpaca wire client is never constructed on that path
    // either. Keyed off the same condition `startFromEnvironment` builds
    // `saxoAccountFunding` on, so the two cannot drift: an injected broker or
    // wire client suppresses that read, and the Alpaca account call comes
    // back.
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

/** True when nothing in this run constructs an Alpaca MARKET-DATA client. */
function alpacaDataPathUnused(injected: Partial<ProductionConfig>): boolean {
  if (injected.dataSource !== undefined || injected.alpacaDataClient !== undefined) return true;
  if (injected.lseMarkClient === undefined) return false;
  const universe = injected.universe ?? [];
  // Every instrument, and at least one: a MIXED universe is refused by
  // `buildLseMarkSourceIfNeeded` rather than routed, and an EMPTY one falls
  // through to the Alpaca branch.
  return universe.length > 0 && universe.every((instrument) => LSE_TICKERS.has(instrument.asset));
}

/**
 * Every credential this run will need and does not have. Empty string counts
 * as absent — the tracked `.env` ships the Alpaca keys as empty placeholders,
 * and `--env-file` turns those into `''` rather than leaving them unset, which
 * is the same "not configured" state. So does whitespace-only, for the same
 * reason and to keep one rule: `requireEnv` in alert-transport.ts trims before
 * it decides (#342 follow-up), and `rotating-file-sink.ts`'s `nonEmpty` already
 * says this pre-flight "takes the same line". If it did not, a quoted-empty
 * `TELEGRAM_CHAT_ID=' '` would pass here and throw one step later from
 * `buildAlertChannels` — defeating the entire point of naming every missing
 * variable at once.
 *
 * Exported for tests. Returns names only; it never reads, echoes, or logs a
 * credential's value.
 */
export function missingCredentialEnvVars(
  injected: Partial<ProductionConfig>,
  alertsMode: AlertsMode | undefined,
  /**
   * The resolved trading mode (#511).
   *
   * **Required, deliberately.** A default of `paper` would be exactly the value
   * that makes the live-credential requirement vacuous, and PR #390 is the
   * standing precedent: an optional argument dropped at one call site left a
   * gate assertion vacuously true with the whole suite green
   * (docs/coding-standards.md, "Prefer a required argument to an optional one").
   */
  mode: ProductionConfig['mode'],
  /**
   * The resolved broker venue (#1400). Required for `mode`'s reason: a
   * default of `alpaca` is exactly the value that makes the Saxo token
   * requirement vacuous.
   */
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

  // Named separately because the fix is different in kind: these are missing
  // because of a mode the operator selected, and re-selecting the other mode is
  // a legitimate way out that the generic advice below does not suggest.
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
 * Whether `dbPath`'s filename identifies the trading mode it belongs to —
 * i.e. whether it is the shape shared-sqlite-store-spec.md § "DB file path
 * convention" (#168) asks for (`data/samurai-paper.sqlite` /
 * `data/samurai-live.sqlite`).
 *
 * True on every ordinary run since #330 re-keyed the path off the trading
 * mode. It was written against the FIXED shape while the code still had the
 * broken one, so the fix made it start answering true rather than needing a
 * separate edit — and what used to be a warning below is now a refusal, which
 * is what it can afford to be once the check normally passes.
 *
 * Filename only, never the directories above it: a checkout that happens to
 * live under `~/live/` must not be able to silence this by accident.
 */
export function storePathEncodesTradingMode(
  dbPath: string,
  mode: ProductionConfig['mode'],
): boolean {
  return basename(dbPath).includes(mode);
}

/**
 * Refuses to start when the file this process is about to write cannot
 * distinguish paper money from real money —
 * [#330](https://github.com/dd-jp/samurai-trading-system/issues/330).
 *
 * This was a `warn` until #330 was fixed, because the path was keyed off
 * `NODE_ENV` and every filename in use failed the check: refusing would have
 * refused every start. Now that `sharedStorePath` keys off the trading mode,
 * the check passes on every ordinary run, and the one case that can still fail
 * it is the residual hazard #330 named — an INJECTED mode that disagrees with
 * `SAMURAI_MODE`.
 *
 * That case matters precisely because it is invisible: `sharedStorePath` reads
 * the environment, so a programmatic caller passing `mode: 'live'` on a host
 * whose `SAMURAI_MODE` still says `paper` would write live state into the paper
 * database. There is nothing to warn about there — the run is already wrong —
 * so it refuses, which is the same posture `SAMURAI_ALERTS` and `parseMode`
 * take for their own unrecoverable configurations.
 */
export function assertStorePathMatchesMode(deps: {
  dbPath: string;
  mode: ProductionConfig['mode'];
}): void {
  if (storePathEncodesTradingMode(deps.dbPath, deps.mode)) return;

  throw new Error(
    `Orchestrator cannot start: it is about to run in '${deps.mode}' mode but the shared store ` +
      // Filename, not the absolute path: the path can carry a home directory,
      // and a startup error is not the place to disclose one.
      `resolves to ${basename(deps.dbPath)}, which is not that mode's file. Store files are ` +
      `named after the trading mode (#168/#330) so paper and live state cannot mix — writing ` +
      `'${deps.mode}' state into another mode's database is exactly what that convention ` +
      'prevents. This happens when an injected mode disagrees with SAMURAI_MODE; set ' +
      `SAMURAI_MODE=${deps.mode} so the writer and the dashboard resolve the same file.`,
  );
}

/**
 * Assembles a `ProductionConfig` from the environment plus `injected`, builds
 * the composition root, and starts it (orphan scan once, then the tick loop
 * and heartbeat). Throws — before opening any broker connection — if any
 * required dependency or credential is absent, or if the operator has not said
 * where alerts go (`SAMURAI_ALERTS`, #322 — see `./alert-transport.ts`).
 *
 * DB path convention matches `server/apps/service-api/index.ts` (both call
 * `sharedStorePath`): `data/samurai-{mode}.sqlite`, one file per TRADING MODE
 * (shared-sqlite-store-spec.md § "DB file path convention", #168) — which is
 * what makes paper/live PnL cross-contamination physically impossible.
 *
 * **Re-keyed in #330**, where it used to key off `NODE_ENV`: a single
 * `NODE_ENV=production` host that flipped `SAMURAI_MODE` from `paper` to
 * `live` wrote both into one file, and a live composition root would have read
 * paper lots and fills as real state.
 *
 * #330's open question was how the READER derives a mode it is never told. The
 * answer is `resolveStoreMode`: both entrypoints read `SAMURAI_MODE` through
 * the same function, so writer and reader cannot mean different files. The one
 * case that can still diverge — an INJECTED mode disagreeing with the
 * environment — is refused by `assertStorePathMatchesMode` rather than written
 * to the wrong database.
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
        '— that is exactly what `yarn orchestrator` does. To supply your own, see ' +
        'ProductionConfig in server/apps/orchestrator/production.ts.',
    );
  }

  const env = process.env.NODE_ENV ?? 'development';
  // An explicitly injected mode wins over the environment: a caller that
  // passed `backtest`/`live` deliberately must not be silently downgraded to
  // whatever `SAMURAI_MODE` says (mode selects the HITL posture).
  const mode = injected.mode ?? parseMode(process.env.SAMURAI_MODE);
  // Strictly before the credential pre-flight: the alerts mode is what decides
  // whether the Telegram variables are credentials this run needs or ones it
  // will never read, so the pre-flight cannot name them until this resolves.
  // An operator with nothing configured therefore sees SAMURAI_ALERTS first
  // and the credential list on the next attempt — the one place this file
  // knowingly gives up its "name everything at once" property, because the
  // alternative is guessing which transport's credentials to demand.
  const alertsMode = resolveAlertsMode(injected);
  // #1400, resolved here for `alertsMode`'s reason: the venue is what decides
  // whether the Alpaca pair is a credential this run needs or one it will
  // never read, so the pre-flight cannot name the right set until it does.
  // An injected `broker` does not suppress it — that seam is how the Saxo
  // adapter itself arrives, and a run that named a venue is entitled to a
  // refusal about that venue rather than silence.
  const venue = resolveBrokerVenue();
  // After the modes are resolved and before the store is opened: an
  // unrecognised `SAMURAI_MODE` is the more fundamental error (mode decides
  // which Alpaca host the credentials would even be used against), and a run
  // that cannot authenticate should not leave a freshly-created SQLite file
  // behind as a side effect of failing.
  assertCredentialsPresent(injected, alertsMode, mode, venue);

  // One logger for the whole startup, threaded into the composition root
  // rather than left for it to default: the #330 warning below has to be
  // emitted before the store is opened, and it must land on the same stream as
  // every line after it.
  const logger = injected.logger ?? new JsonLogger();

  // `sharedStorePath()` is called with no argument, exactly as
  // `server/apps/service-api/index.ts` calls it: the resolver reads `NODE_ENV` itself,
  // so the writer and the reader cannot derive different paths. `env` above is
  // for the startup log line only.
  //
  // Resolved and warned about before opening, and only when we resolved it —
  // an injected handle's path is not ours to guess at (#330).
  let db = injected.db;
  if (db === undefined) {
    const dbPath = sharedStorePath();
    assertStorePathMatchesMode({ dbPath, mode });
    db = openSharedStore(dbPath);
    // #940: `dbPath` is relative to the process's working directory (see the
    // `sharedStorePath()` comment above) — the orchestrator and the dashboard
    // can each resolve it against a different cwd and silently open two
    // different files, with no error on either side. Naming the resolved
    // ABSOLUTE path here is what would have made that mismatch visible.
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'info',
      message: 'orchestrator store opened',
      payload: { db_path: resolve(dbPath) },
    });
  }

  // #686 rollout guard. Runs against BOTH the handle we opened and one the
  // caller injected — the hazard is a property of the rows, not of who opened
  // them — and before `orchestrator.start()` arms the tick loop, because once a
  // pass is in flight a replay can already have placed the duplicate order.
  // Throws with a drain instruction; see `key-scheme-guard.ts` for why refusing
  // beats recomputing the old keys.
  assertNoStaleKeyScheme(db);

  // #552: the MI archive, in its OWN database file. Opened here rather than
  // inside the composition root so one process holds one handle, and skipped
  // when the caller injected its own (a test may pass an in-memory archive).
  //
  // Its absence is not neutral — without it the run falls back to the
  // retrieval-era agent, which ingests `[]` by construction, so `sentiment`
  // and `fundamental` report NO DATA on every tick and #625's conviction
  // ceiling stays in force. That is why the default is to open it, not to omit.
  const miArchive = injected.miArchive ?? new MiArchiveStore(miArchivePath(mode));

  // #322. Built after the store is open (the Telegram client audit-logs
  // inbound allowlist rejections through it) and spread BEFORE `injected`, so
  // a channel the caller passed explicitly always wins over the one this
  // resolves. `buildAlertChannels` also omits any field already injected, so
  // the two mechanisms agree rather than relying on spread order alone.
  const alertChannels =
    alertsMode === undefined ? {} : buildAlertChannels({ alertsMode, injected, db, logger });

  const clock = injected.clock ?? new SystemClock();

  // #1400 — the Saxo venue, built HERE rather than inside the composition
  // root because `saxoInstrumentResolverFromVenue` reads the venue's own
  // instrument details per line (#1302) and is therefore async, while
  // `buildProductionOrchestrator` is synchronous by design. It arrives
  // through `ProductionConfig.broker`, the seam whose own doc comment says a
  // non-Alpaca adapter binds there "without the composition root growing a
  // broker-selection branch" — so this is the branch, at the one level that
  // already reads the environment.
  //
  // `injected.broker` wins: a caller that passed its own adapter (the smoke
  // gate's `SimulatedBrokerAdapter`, a test's) has already chosen, and
  // overriding that from an environment variable would make the seam
  // unfalsifiable.
  //
  // ONE Saxo client per run (#1509): the broker and the funding read share it,
  // because the venue's pacing budget belongs to the account and two clients
  // would be two budgets against one limit. Built only when neither an adapter
  // nor a client was injected — a caller that passed either has already chosen
  // its transport, and the funding read must not open a second one behind it.
  // The bearer the client reads PER REQUEST (#1523), built beside the client
  // for the same reason the client is built once: the refresher owns the saved
  // session file, and two of them would rotate the same refresh token against
  // each other. Whoever builds the client builds this.
  const saxoIsOwnedHere =
    venue === 'saxo' && injected.broker === undefined && injected.saxoBrokerClient === undefined;

  // #1524. No forced log-only default (unlike `legResizeAlerts` etc. below):
  // `saxoSessionLostAlerts` has no log-only form — `lose()`'s own
  // `saxo_session_lost` line already covers that mode — so an absent channel
  // here is the correct `log-only` posture, not a gap.
  const saxoSessionLostAlerts =
    injected.saxoSessionLostAlerts ?? alertChannels.saxoSessionLostAlerts;

  const saxoTokenSource = saxoIsOwnedHere
    ? buildSaxoTokenSource('sim', logger, {
        ...(saxoSessionLostAlerts === undefined
          ? {}
          : { sessionLostAlerts: saxoSessionLostAlerts }),
      })
    : undefined;

  const saxoClient =
    saxoTokenSource === undefined ? undefined : buildSaxoVenueClient(logger, saxoTokenSource);

  // #1524's other half — the weekly reminder. Scoped to the same condition as
  // `saxoTokenSource` above: a caller that injected its own broker/client has
  // already chosen its Saxo wiring, and this nudge belongs to the token file
  // this process itself owns, not to one it never reads.
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

  // The GBP-native funding read. Skipped when the caller supplied a whole
  // `accountState` or its own funding source, so this never fires under a test
  // that already stubbed the account — and, with `saxoClient` above, never
  // under one that injected a broker or a wire client either.
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
          // The alert channels the adapter REQUIRES and has no default for.
          // Resolved the same way the composition root resolves its own:
          // caller first, then `SAMURAI_ALERTS`' transport, then the log-only
          // stand-in — so a `telegram` run pages a phone and a `log-only` one
          // is explicitly attended, never silent by omission.
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

  // #1400 round 1 — the venue picks the CALENDAR too, not just the adapter.
  // `equityCalendarFor` resolves `UsEquityRegularHoursCalendar` for every
  // non-`live` mode, and `live` is the one mode the Saxo venue refuses. Left
  // unset, a Saxo run would gate entries on New York and take its flatten
  // tail from the 21:00 London US close — 4.5 hours of overnight-style carry
  // (#668) on a book that closed at 16:30 — while `LseMarkDataSource`
  // normalised its bars against London, and #1378's table-coverage guard,
  // which only arms on an `LseRegularHoursCalendar`, would never run.
  //
  // `injected` wins, for `broker`'s reason: a caller that chose a calendar
  // has chosen, and an environment variable must not override it.
  const saxoCalendar =
    venue === 'saxo' && injected.tradingCalendar === undefined
      ? new LseRegularHoursCalendar()
      : undefined;

  // #949's guard, armed from the real read or not at all (#1509).
  //
  // The read runs on every boot that uses the Saxo funding source, NOT only
  // when there is a ceiling to arm: `getAccountState` sizes every tick against
  // this source's `equity`, so an account in another currency is a defect
  // whether or not a ceiling happens to be declared. `assertSameCurrencyFunding`
  // refuses the boot on a mismatch — the refusal `assertSaxoVenueBootable` used
  // to get by demanding a deliberate account read, kept rather than traded away
  // for the read itself.
  //
  // Scoped by VENUE, not by who built the source. `assertSaxoVenueBootable`
  // accepts an `accountFunding` in place of a whole `accountState`, so an
  // injected one reaches the same per-tick sizing the entrypoint's own does —
  // exempting it would leave the refusal true only of the path that needed it
  // least. `venue === 'saxo'` is what makes `LIVE_BOOK_CURRENCY` the right
  // book to compare against (ADR-0015: the Saxo leg is the GBP LSE one); a
  // non-Saxo run's injected funding is not GBP-denominated and is not checked
  // here.
  //
  // Out of reach either way: a caller that composes `buildProductionOrchestrator`
  // or `buildSaxoBroker` itself, as `production.ts` documents for every other
  // entrypoint-level guard.
  //
  // Arming is the narrower step: `armSameCurrencyCeilings` writes only the
  // ceilings the profile declares, so a profile that declares none is left
  // alone. The SIM trial account answers EUR (doc 44 §6.3), so today the
  // refusal above is what a Saxo boot reaches.
  const declaredRiskConfig = injected.riskConfig;
  const fundingToVerify = venue === 'saxo' ? accountFunding : undefined;
  const sameCurrency =
    fundingToVerify === undefined
      ? undefined
      : verifySameCurrency(await fundingToVerify.readFunding());
  if (sameCurrency !== undefined) {
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
  }

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
  // Armed after a successful boot, not at construction: a boot that throws
  // before this line (a refused credential, a currency mismatch) should not
  // leave a reminder timer running against an orchestrator that never started.
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
      // Read off the orchestrator's own resolution (#1167), not re-derived from `injected.universe`.
      universe: orchestrator.universe.map((i) => i.asset),
      orphaned_go_verdicts: orphans.length,
    },
  });

  return started;
}

/**
 * Folds the token refresher into the orchestrator's own shutdown (#1523),
 * AFTER it — in that order for two reasons, both of which cost a live session
 * if reversed:
 *
 * 1. `orchestrator.stop()` drains an in-flight tick, and that drain (flatten,
 *    cancel) still sends Saxo requests. A refresher stopped first stops
 *    renewing, so a tick that outlives the ≤60 s refresh lead — routine, since
 *    a tick is LLM-bound — would be draining on an expired bearer. Stopping
 *    first buys nothing anyway: the timer is `unref`'d, so it never holds the
 *    process open.
 * 2. `stop()` is awaited because it joins an in-flight rotation. Saxo
 *    invalidated the previous refresh token when it issued the one in flight,
 *    so exiting between receipt and `rename` strands the session and costs the
 *    operator a manual `yarn saxo:login`. `buildShutdownHandler` calls
 *    `effects.exit(0)` the moment this resolves, so the join has to happen
 *    here or it does not happen at all.
 *
 * A spread rather than a subclass because `buildProductionOrchestrator`
 * returns a plain object literal whose methods close over its own locals, so
 * copying them carries no `this` binding to lose. Exported so that spread —
 * the one wiring line no `startFromEnvironment` test can reach offline — is
 * testable.
 *
 * `weeklyReminder` (#1524) is stopped alongside the token source, same order
 * reasoning as `tokenSource`: it is a plain `unref`'d timer, so stopping it
 * first or last costs nothing correctness-wise, but folding it in here (rather
 * than a separate wrapper) keeps `startFromEnvironment` from needing two spread
 * layers for one shutdown. Optional and defaulted so the existing two-argument
 * call shape — and every test written against it — keeps working unchanged.
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
 * The profile the shipped entrypoint boots on, for the mode the operator asked
 * for (#511) — the ONE place the paper and live profiles are chosen between.
 *
 * **Exported so this hop is testable.** The entrypoint below sits behind an
 * `import.meta.url` guard that no unit test can reach, so leaving the choice
 * inline would have made "SAMURAI_MODE=live reaches the live profile" a claim
 * about three lines nothing exercises — the exact "tested mechanism nothing
 * calls" shape this repo keeps rediscovering, inverted.
 *
 * `live` is reachable only by an operator typing it exactly: `parseMode`
 * refuses an unrecognised value, resolves an ABSENT one to `paper`, and
 * deliberately does not trim, so `' live '` throws rather than resolving. The
 * branch is a literal comparison against that resolved mode — no lookup table,
 * no default. And the paper branch cannot be reached with `live` regardless,
 * because `paperStartingProfile` still refuses it.
 *
 * `backtest` goes to the paper profile, which accepts it: that mode spends no
 * money and `breakerConfig.auto_rearm` exists for it.
 *
 * **The venue chooses the UNIVERSE, and it has to be chosen here (#1400).**
 * `buildStartingProfileConfigs` derives `riskConfig.subclass_of` and D5's
 * per-subclass deployment envelope FROM the universe it is given (#739), so a
 * Saxo run whose universe was spread over an already-built profile would arm
 * both against `DEFAULT_UNIVERSE`'s SPY/QQQ/AAPL/TSLA while ticking LSE ETPs
 * — a per-instrument refusal at tick time, invisible at boot. The venue's
 * universe therefore reaches the profile BUILDER, not the built profile.
 *
 * `live` is untouched by the venue: the Saxo path refuses `live` outright
 * (saxo-venue.ts), so there is no live Saxo profile to choose.
 */
export function startingProfileForMode(
  mode: ProductionConfig['mode'],
  logger?: Logger,
  venue: BrokerVenue = resolveBrokerVenue(),
  // A union of the two profiles' own return types, not `Partial<ProductionConfig>`:
  // both are typed to carry every value `REQUIRED_INJECTED_CONFIG` demands, and
  // widening to `Partial` here would move that guarantee from the compiler to
  // the runtime guard for the shipped entrypoint alone.
): ReturnType<typeof paperStartingProfile> | LiveStartingProfile {
  if (mode === 'live') return liveStartingProfile(undefined, logger);
  return venue === 'saxo'
    ? paperStartingProfile(mode, saxoTradeableUniverse(), 'GBP')
    : paperStartingProfile(mode);
}

/**
 * Builds the SIGINT/SIGTERM handler: drain, then exit deterministically.
 *
 * Exported (and its effects injected) purely so the two things that are easy
 * to get silently wrong here are testable — this lives behind the entrypoint
 * guard below, which no unit test can reach.
 *
 * **A rejected drain still exits, and exits quietly.** `stop()` can reject:
 * it awaits the in-flight tick, and while `runOnce` swallows its own errors,
 * a pass that rejects after `stop()` has already captured `inFlight` rejects
 * in the caller too. Left unhandled the process does not hang — Node ≥15
 * throws on unhandled rejections — but it dies on Node's terms: an exit code
 * nobody chose, and a raw stack dump, which is exactly what the startup
 * `catch` below refuses to print. Same posture here: message only, never the
 * error object, because the config it may reference holds API credentials.
 *
 * **A second signal is ignored, not obeyed.** Draining matters more than
 * signal responsiveness: exiting mid-pass between Verdict's `go` and
 * Execution's write manufactures precisely the orphaned verdict #209 exists
 * to detect. Without the guard a second Ctrl-C re-enters `stop()`, which now
 * finds its timers cleared and its loop released and so resolves immediately
 * — exiting 0 *through* the first drain rather than after it.
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
 * The last-resort fault net: record an unhandled fault durably, then exit
 * non-zero (#714).
 *
 * **This is not a swallow, and the distinction is the whole point.** It
 * catches nothing narrowly, allows nothing to continue, and classifies
 * nothing: every fault that reaches it ends the process. What it adds is that
 * the death is *recorded where a soak can find it* — through `logger`, whose
 * rotating file survives a stdout that has already gone — and that the exit
 * code is chosen rather than incidental. Node already exits 1 on an uncaught
 * exception and (since v15) on an unhandled rejection, so this handler does
 * not make the process more lethal; it makes the same death diagnosable, and
 * replaces Node's raw stack dump with a message-only line, matching the
 * startup `catch` below (the config it may reference holds API credentials).
 *
 * **Where the line between recoverable and unknown is drawn, and why there.**
 * The one fault a soak must survive — a broken stdout pipe — is handled at the
 * stream that produced it, by `watchStdoutErrors` (logger.ts), which knows it
 * is a stdout failure because it is subscribed to stdout's own `'error'`
 * event. Identity by *origin*, not by inspecting an error's `code` here. Two
 * weaker lines were rejected:
 *
 * - *exempting `EPIPE` in this handler* — an `EPIPE` can come from a broker
 *   socket or an alert transport just as easily as from the log stream, and
 *   those are unknown-state faults. A code is not a provenance.
 * - *exempting anything thrown from inside a logging call* — that swallows
 *   serialization bugs and faults in an injected sink, which are unknown-state
 *   faults wearing a logging costume.
 *
 * A logging EPIPE is narrow, known, and recoverable **because a second durable
 * sink is still taking the trace**; when even that is gone, `JsonLogger` stops
 * degrading and throws, and it lands here, where it belongs. An arbitrary
 * uncaught exception is none of those things: this is a live-money process
 * holding real positions, and one that keeps running in an unknown state is
 * strictly worse than one that stops. Restart-time reconciliation
 * (`OrphanVerdictScanner`, #209, and the flatten journal) is built precisely
 * for a process that died mid-pass; nothing is built for one that traded on
 * after an exception nobody saw.
 *
 * No drain is attempted. `buildShutdownHandler`'s drain awaits the in-flight
 * tick, which is exactly the code whose state is in question here.
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
    // `logCaughtFailure` and not `logger.log`: the logger is allowed to throw
    // when it has no sink left, and a fault handler that throws is a fault
    // handler that hides the fault it was called about.
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
      // stderr can be as dead as stdout; the exit below is the message then.
    }
    effects.exit(1);
  };

  effects.on('uncaughtException', fatal('uncaughtException'));
  effects.on('unhandledRejection', fatal('unhandledRejection'));
}

/**
 * The #1116 boot sweep over `logs/`, argument derivation included.
 *
 * `RotatingFileSink` bounds only `fileSinkConfig.filePath` — every other file
 * a run leaves in `logs/` (a supervisor's own redirected stdout, a hand-run
 * `> logs/orchestrator-DATE.log`) is unbounded, which is unattended growth on
 * the host holding live position state. Swept from the entrypoint rather than
 * inside `buildProductionComponents`, matching `buildEntrypointLogger`: a
 * real filesystem side effect belongs on the deployment path, not on every
 * test's composition root.
 *
 * It is a separate exported function and not an inline block in the
 * `import.meta.url` guard below for the same reason `startingProfileForMode`
 * is: the guard is unreachable from any in-process test, and the derivation
 * is where this feature's sharp edge lives — `dirname` of an operator's
 * `SAMURAI_LOG_FILE` decides which directory gets files deleted from it. The
 * guard is left holding only the call, which `index.test.ts` asserts on the
 * source text because there is no runtime seam into it.
 *
 * The active sink file and its rotation set are named explicitly so this
 * sweep never fights `RotatingFileSink`'s own count-based retention over the
 * same files; see `log-retention.ts` for the rest of the liveness rule.
 *
 * `bareTruncateBytes`/`bareTruncateNames` reach the same directory:
 * `soak-boot.out` — the supervisor's own shell-redirected stdout — is a bare
 * name in this same `logs/` directory, so it needs no separate wiring beyond
 * the two settings themselves (#1206). Both default the same way every other
 * setting sourced below does — `logBareTruncateNamesFromEnvironment` defaults
 * to `soak-boot.out` alone, the one file #1206 names, which is what keeps a
 * default-on threshold from reaching any co-located bare file it does not
 * recognise (see `log-retention.ts`'s "Bare live names" section for the full
 * reasoning, including why an earlier, opt-in-threshold version of this fix
 * was reversed).
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
// process.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // The profile is passed explicitly, never defaulted into
    // `startFromEnvironment` (#323): the guard above has to stay falsifiable
    // for every other caller. `parseMode` runs here so `paperStartingProfile`
    // can refuse `live` before anything is constructed; the resolved mode then
    // travels on the profile, so `startFromEnvironment` does not re-derive it.
    //
    // The logger is passed here for the same reason, and only here (#325):
    // this is the *deployment* — the run that must leave a durable diagnostic
    // trace behind without a shell redirect, because a 14-day unattended soak
    // (#238) is unanswerable without one. `startFromEnvironment` keeps its
    // stdout-only `new JsonLogger()` fallback, so no test or programmatic
    // composition root opens a file as a side effect of constructing an
    // orchestrator. An unwritable path degrades to stdout with a warn rather
    // than stopping the process; see logger.ts / rotating-file-sink.ts.
    //
    // #714: `buildEntrypointLogger` also subscribes to stdout's `'error'`
    // event, so a broken pipe — the soak's realistic logging failure, and
    // asynchronous on a pipe rather than a throw — degrades to the file
    // instead of reaching the handler installed next. That handler is the
    // opposite posture on purpose: it ends the process. See both doc comments.
    const fileSinkConfig = fileSinkConfigFromEnvironment();
    const entrypointLogger = buildEntrypointLogger(fileSinkConfig);
    installFaultHandlers(entrypointLogger);
    runEntrypointLogRetention(fileSinkConfig, entrypointLogger);
    const mode = parseMode(process.env.SAMURAI_MODE);
    // #684. Resolved HERE, at the real deployment, and not inside
    // `startFromEnvironment` itself — deliberately, the same reason
    // `startingProfileForMode` is a separate exported hop rather than inlined
    // there: `startFromEnvironment` is what dozens of tests call directly with
    // no `fetch` stubbed, and threading a live Alpaca calendar fetch into it
    // would turn every one of those into a real outbound network call. Placing
    // it here means only the actual `yarn orchestrator` process ever awaits
    // it; `resolveUsEquitySessionCalendar` itself is unit-tested directly with
    // an injected `AlpacaCalendarClient`, the same split `startingProfileForMode`'s
    // own doc comment explains for the mode/profile hop.
    //
    // PAPER only, narrower than "not live" — #684's own scope. No production
    // entrypoint constructs a `SAMURAI_MODE=backtest` pipeline (the one
    // candidate, `BacktestHarness`, was deleted as unwired dead code — #1156)
    // and this entrypoint is not it either, so in practice
    // `SAMURAI_MODE=backtest` never reaches this line. But
    // fetching here regardless would be actively wrong if it ever did:
    // `resolveUsEquitySessionCalendar`'s window is anchored to wall-clock
    // `now`, and `AlpacaEquitySessionCalendar` answers "not a trading day" for
    // any date outside that window (the safe direction for the live paper
    // book) — which would silently zero out every historical bar a backtest
    // replays, with no alert, because the fetch itself would have succeeded.
    // `startFromEnvironment` still resolves `equityCalendarFor`'s LSE default
    // for `live`, an `LseRegularHoursCalendar` for a Saxo paper run (#1400),
    // and its hand-entered `UsEquityRegularHoursCalendar` default for
    // `backtest`, when `tradingCalendar` is omitted (production.ts).
    //
    // NOT on a Saxo run (#1400): this table is Alpaca's US session calendar,
    // and injecting it would override the LSE calendar `startFromEnvironment`
    // resolves for the venue — the override wins there by design.
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
    // Message only — never the config object, which holds API credentials.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
