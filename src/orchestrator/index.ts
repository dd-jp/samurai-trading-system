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
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SystemClock } from '../shared/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';
import {
  type AlertsMode,
  buildAlertChannels,
  resolveAlertsMode,
  TELEGRAM_ALERT_ENV_VARS,
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
} from './alert-transport.js';
import { buildEntrypointLogger, JsonLogger } from './logger.js';
import { paperStartingProfile } from './paper-profile.js';
import {
  buildProductionOrchestrator,
  type ProductionConfig,
  type ProductionOrchestrator,
  SMOKE_TEST_UNIVERSE,
} from './production.js';
import type { Logger } from './types.js';

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
export { TradeChannelBreachAlert } from './breach-alert-channel.js';
export { digest } from './digest.js';
export { Heartbeat, type HeartbeatChannel } from './heartbeat.js';
export { TradeChannelHeartbeat } from './heartbeat-channel.js';
export { buildEntrypointLogger, formatLogLine, JsonLogger, type LogLineSink } from './logger.js';
export { TradeChannelOrphanAlert } from './orphan-alert-channel.js';
export {
  type OrphanAlertChannel,
  type OrphanGoVerdict,
  OrphanVerdictScanner,
} from './orphan-verdict-scan.js';
export { PAPER_ACCOUNT_EQUITY_ANCHOR, paperStartingProfile } from './paper-profile.js';
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
  type DailyMetricsConfig,
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
export { TradeChannelUnpricedFillAlert } from './unpriced-fill-channel.js';

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
] as const satisfies readonly (keyof ProductionConfig)[];

const MODES = ['live', 'paper', 'backtest'] as const;

/**
 * `SAMURAI_MODE` is not a free-form string: it selects the HITL posture as
 * well as the broker. `backtest` auto-approves every HITL gate
 * (verdict/types.ts) and `live` spends real money, so a typo'd or unset-to-
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
 * Alpaca *broker* client unconditionally (the account-state provider needs it
 * even when `ProductionConfig.broker` is overridden), while the *data* client
 * is skipped when either `dataSource` or `alpacaDataClient` is supplied, and
 * the LLM client is skipped when `llmClient` is. A test injecting stubs must
 * not be asked for keys it will never use.
 */
const CREDENTIAL_REQUIREMENTS: readonly {
  vars: readonly string[];
  /**
   * True when this run never touches these variables — because the caller
   * injected the client that would have read them, or because the alerts mode
   * it selected needs no transport credentials at all.
   */
  unusedByThisRun: (context: {
    injected: Partial<ProductionConfig>;
    alertsMode: AlertsMode | undefined;
  }) => boolean;
}[] = [
  {
    vars: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'],
    unusedByThisRun: ({ injected }) =>
      injected.alpacaBrokerClient !== undefined &&
      (injected.dataSource !== undefined || injected.alpacaDataClient !== undefined),
  },
  {
    vars: ['ANTHROPIC_API_KEY'],
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
];

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
): string[] {
  return CREDENTIAL_REQUIREMENTS.filter(
    (requirement) => !requirement.unusedByThisRun({ injected, alertsMode }),
  )
    .flatMap((requirement) => requirement.vars)
    .filter((name) => (process.env[name] ?? '').trim().length === 0);
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
): void {
  const missing = missingCredentialEnvVars(injected, alertsMode);
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
          '(not for an unattended soak). TELEGRAM_ALLOWED_USER_IDS is on that list because ' +
          'TelegramBotApiClient validates the HITL approval allowlist at construction, not ' +
          'because this process polls for approvals — see alert-transport.ts. ' +
          `${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} must name a DIFFERENT chat from ` +
          'TELEGRAM_CHAT_ID (#342): the heartbeat posts forever on a fixed interval, and ' +
          'sharing the escalation chat is what drives an operator to mute the one channel ' +
          'that carries orphaned go verdicts, stuck lots and kill-threshold breaches. '
        : '') +
      'Note that `node dist/orchestrator/index.js` does not read any .env file on its own — ' +
      'use `node --env-file=.env.local dist/orchestrator/index.js` or export the variables.',
  );
}

/**
 * Whether `dbPath`'s filename identifies the trading mode it belongs to —
 * i.e. whether it is the shape shared-sqlite-store-spec.md § "DB file path
 * convention" (#168) asks for (`data/samurai-paper.sqlite` /
 * `data/samurai-live.sqlite`) rather than the `NODE_ENV`-keyed shape this
 * codebase actually resolves.
 *
 * False for every filename in use today, which is the point: it is the
 * condition for the startup warning below, written against the *fixed* shape
 * so that [#330](https://github.com/dd-jp/samurai-trading-system/issues/330)
 * re-keying the path silences the warning by making this true. Nobody has to
 * remember to delete it, and nobody can delete it early without the test
 * turning red.
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
 * Warns, once at startup, when the file this process is about to write cannot
 * distinguish paper money from real money —
 * [#330](https://github.com/dd-jp/samurai-trading-system/issues/330).
 *
 * The hazard in full: `sharedStorePath()` keys off `NODE_ENV`, so a single
 * `NODE_ENV=production` host that flips `SAMURAI_MODE` from `paper` to `live`
 * writes both into `samurai-production.sqlite`. A live composition root then
 * reads paper lots and fills as real state and computes its risk caps and
 * drawdown against them — the exact cross-contamination #168's convention
 * exists to make impossible.
 *
 * A warning rather than a refusal, deliberately: paper trading on one
 * `NODE_ENV` is unaffected in practice, and #323's whole purpose was to let a
 * paper run start. Refusing here would re-break the thing that ticket fixed,
 * to guard a transition (`paper` → `live` on one host) that the shipped
 * entrypoint already refuses on other grounds.
 *
 * **Do not delete this as noise.** #330 records that it is removed only when
 * the real fix lands — and by construction it removes itself then, because
 * `storePathEncodesTradingMode` starts answering true.
 */
export function warnIfStorePathIgnoresMode(deps: {
  dbPath: string;
  mode: ProductionConfig['mode'];
  logger: Logger;
}): void {
  if (storePathEncodesTradingMode(deps.dbPath, deps.mode)) return;

  deps.logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'warn',
    message:
      'shared store path is keyed off NODE_ENV, not trading mode — this file cannot separate ' +
      'paper from live, so a later live run on this host would inherit paper positions as real ' +
      'state (#330, spec #168). Safe for a paper-only host; must be resolved before live money.',
    payload: {
      mode: deps.mode,
      // Filename, not the absolute path: the path can carry a home directory,
      // and a startup log line is not the place to disclose one.
      db_file: basename(deps.dbPath),
      expected_convention: `samurai-${deps.mode}.sqlite`,
    },
  });
}

/**
 * Assembles a `ProductionConfig` from the environment plus `injected`, builds
 * the composition root, and starts it (orphan scan once, then the tick loop
 * and heartbeat). Throws — before opening any broker connection — if any
 * required dependency or credential is absent, or if the operator has not said
 * where alerts go (`SAMURAI_ALERTS`, #322 — see `./alert-transport.ts`).
 *
 * DB path convention matches `src/dashboard/index.ts` (both call
 * `sharedStorePath`): `data/samurai-{env}.sqlite`, one file per `NODE_ENV`.
 *
 * **This does not yet deliver paper/live separation, despite the shape.**
 * shared-sqlite-store-spec.md § "DB file path convention" (#168) names the
 * files `data/samurai-paper.sqlite` / `data/samurai-live.sqlite` — that is,
 * keyed off the *trading mode*, which is what makes "paper/live PnL
 * cross-contamination physically impossible". This code keys off `NODE_ENV`
 * instead, so a single `NODE_ENV=production` host that flips `SAMURAI_MODE`
 * from `paper` to `live` writes both into one file.
 *
 * **Reachable as of #323, where it was latent before — tracked as
 * [#330](https://github.com/dd-jp/samurai-trading-system/issues/330).** The
 * earlier note here said the `REQUIRED_INJECTED_CONFIG` guard threw long
 * before this line, which is no longer true: `yarn orchestrator` now boots, so
 * the path is resolved on every start. Two things still stand between this
 * hazard and a live wrong answer — the shipped entrypoint runs on
 * `paperStartingProfile`, which refuses `live` outright, and a `live` process
 * would have to be someone's own composition root — but it is still the wrong
 * key, and #330 gates it on any live-money run.
 *
 * Not re-keyed here, deliberately and not for lack of effort: `mode` resolves
 * from `injected.mode ?? SAMURAI_MODE`, and an injected mode is invisible to
 * the dashboard, which calls `sharedStorePath()` with no argument precisely so
 * writer and reader cannot derive different paths. Switching the key needs a
 * decision about how the *reader* derives mode, plus a migration story for
 * existing files — #330's scope, not a template-string change.
 *
 * What this function does do meanwhile is say so out loud:
 * `warnIfStorePathIgnoresMode` logs a `warn` at startup naming the mode and
 * the file actually being written. Per #330 that warning is removed only when
 * the real fix lands — and it retires itself when it does, since re-keying
 * makes `storePathEncodesTradingMode` true.
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
        'startFromEnvironment(paperStartingProfile(mode)) from src/orchestrator/paper-profile.ts ' +
        '— that is exactly what `yarn orchestrator` does. To supply your own, see ' +
        'ProductionConfig in src/orchestrator/production.ts.',
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
  // After the modes are resolved and before the store is opened: an
  // unrecognised `SAMURAI_MODE` is the more fundamental error (mode decides
  // which Alpaca host the credentials would even be used against), and a run
  // that cannot authenticate should not leave a freshly-created SQLite file
  // behind as a side effect of failing.
  assertCredentialsPresent(injected, alertsMode);

  // One logger for the whole startup, threaded into the composition root
  // rather than left for it to default: the #330 warning below has to be
  // emitted before the store is opened, and it must land on the same stream as
  // every line after it.
  const logger = injected.logger ?? new JsonLogger();

  // `sharedStorePath()` is called with no argument, exactly as
  // `src/dashboard/index.ts` calls it: the resolver reads `NODE_ENV` itself,
  // so the writer and the reader cannot derive different paths. `env` above is
  // for the startup log line only.
  //
  // Resolved and warned about before opening, and only when we resolved it —
  // an injected handle's path is not ours to guess at (#330).
  let db = injected.db;
  if (db === undefined) {
    const dbPath = sharedStorePath();
    warnIfStorePathIgnoresMode({ dbPath, mode, logger });
    db = openSharedStore(dbPath);
  }

  // #322. Built after the store is open (the Telegram client audit-logs
  // inbound allowlist rejections through it) and spread BEFORE `injected`, so
  // a channel the caller passed explicitly always wins over the one this
  // resolves. `buildAlertChannels` also omits any field already injected, so
  // the two mechanisms agree rather than relying on spread order alone.
  const alertChannels =
    alertsMode === undefined ? {} : buildAlertChannels({ alertsMode, injected, db, logger });

  const orchestrator = buildProductionOrchestrator({
    ...alertChannels,
    ...(injected as ProductionConfig),
    logger,
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
        effects.stderr(
          `orchestrator shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        effects.exit(1);
      },
    );
  };
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
    const orchestrator = await startFromEnvironment({
      ...paperStartingProfile(parseMode(process.env.SAMURAI_MODE)),
      logger: buildEntrypointLogger(),
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
