/**
 * Alert-transport selection at the composition root (ticket #322) — the thing
 * that makes the 14-day **unattended** paper soak (#238) actually unattended.
 *
 * ## The bug this closes
 *
 * Three operator-facing escalations existed with real transports available and
 * none of them wired: the dead-man's-switch heartbeat (#96), the orphaned
 * go-verdict alert (#209), and the permanently-unpriced-fill alert (#298). All
 * three fell through to `console-channels.ts`'s log-only stand-ins **by
 * omission** — the composition root simply never constructed a
 * `TelegramClient`. That satisfies each ticket's acceptance criteria and none
 * of their intent: the failures they exist to surface (the bot silently
 * stopping, a lot stuck unpriced, a `go` verdict with no execution record) are
 * exactly the ones nobody notices for days when the only record is a log line
 * on an unattended MacBook.
 *
 * ## `SAMURAI_ALERTS` is required, with no default
 *
 * The degraded mode has to be **named**, never reached by omission — the
 * precedent #293/#320 set for the Alpaca paper/live environment, where the
 * dangerous configuration is refused rather than defaulted. So:
 *
 * - `SAMURAI_ALERTS=telegram` — push notifications. The posture an unattended
 *   run requires. Demands `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and
 *   `TELEGRAM_ALLOWED_USER_IDS`; startup fails naming whichever are absent.
 * - `SAMURAI_ALERTS=log-only` — the log-only stand-ins. A legitimate, and
 *   explicitly acknowledged, choice for an **attended** run: a local dev run, a
 *   supervised smoke test, a backtest. It is logged at `warn` every time,
 *   because a process in this mode cannot tell anyone it has stopped.
 * - unset, or anything else — a startup failure naming the variable and both
 *   values. There is deliberately no default: a default of `log-only` is the
 *   bug being fixed, and a default of `telegram` would fail every dev run for
 *   want of a bot token.
 *
 * A caller that injected all three channels itself is not asked for the
 * variable at all (`resolveAlertsMode` returns `undefined`), mirroring
 * `missingCredentialEnvVars`' `satisfiedByInjection` in index.ts: it has
 * already made the decision explicitly. Injecting *some* of them does not
 * exempt the rest — that would be the same silent-by-omission hole one level
 * down.
 *
 * ## Why the allowlist is required for outbound-only alerts
 *
 * `TELEGRAM_ALLOWED_USER_IDS` is on the required list even though nothing here
 * receives anything. That is a consequence of construction, not a claim that
 * this ticket arms the HITL gate: `TelegramBotApiClient` is the only in-repo
 * `TelegramClient`, and it validates the allowlist in its constructor
 * (allowlist.ts) — deliberately, since an unset or wildcard allowlist is either
 * a silently fail-closed gate or a critical exposure, and verdict-spec.md
 * requires that to be caught at boot rather than discovered at runtime.
 *
 * To be unambiguous about what this file does NOT do: no poll loop is started
 * (`client.start()` is never called — `getUpdates` is single-consumer per bot
 * token, and starting one here would make a *second* process' approval poll
 * impossible), no approval handler is registered, and
 * `ProductionConfig.approvals` still falls back to `ConsoleApprovalChannel`.
 * Wiring HITL approvals through Telegram is #275's remaining half. Validating
 * the allowlist now rather than then is the same fail-at-boot posture the spec
 * asks for: an unattended soak must not discover a broken allowlist on the day
 * approvals go live.
 *
 * ## Why here and not in `production.ts`
 *
 * #322 asks for the client to be built in `production.ts`. It is built here and
 * called from `startFromEnvironment` (index.ts) instead, for one reason:
 * `buildProductionOrchestrator` is called directly by a large number of tests
 * and by any programmatic composition root, and none of them should have to set
 * a process-wide environment variable to construct an orchestrator with stubbed
 * channels. The *deployment* decision belongs where the other deployment
 * decisions already live — alongside `assertCredentialsPresent` and
 * `parseMode`, on the path the shipped entrypoint takes. `production.ts` keeps
 * its log-only defaults, which is what `log-only` mode resolves to.
 */
import type { SharedStore as SqliteHandle } from '../shared/store/index.js';
import { TelegramBotApiClient } from '../verdict/index.js';
import { TradeChannelBreachAlert } from './breach-alert-channel.js';
import { TradeChannelHeartbeat } from './heartbeat-channel.js';
import { TradeChannelOrphanAlert } from './orphan-alert-channel.js';
import type { ProductionConfig } from './production.js';
import { SqliteAuditLog } from './sqlite-audit-log.js';
import type { Logger } from './types.js';
import { TradeChannelUnpricedFillAlert } from './unpriced-fill-channel.js';

const ENV_VAR = 'SAMURAI_ALERTS';

export const ALERTS_MODES = ['telegram', 'log-only'] as const;

export type AlertsMode = (typeof ALERTS_MODES)[number];

/**
 * The `ProductionConfig` fields this module owns — the outbound operator
 * escalations, and nothing else. `approvals` is deliberately absent: it is an
 * inbound round trip, not an alert, and wiring it is #275's remaining half.
 *
 * `breachAlerts` joined the list in #327: a kill-threshold breach is the
 * fourth outbound escalation, and it had the same shape of hole as the
 * original three — a real channel type with no transport selected for it.
 */
export const ALERT_CHANNEL_FIELDS = [
  'heartbeatChannel',
  'orphanAlerts',
  'unpricedFillAlerts',
  'breachAlerts',
] as const satisfies readonly (keyof ProductionConfig)[];

/** What `SAMURAI_ALERTS=telegram` needs in the environment. See the module doc for the allowlist. */
export const TELEGRAM_ALERT_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_ALLOWED_USER_IDS',
] as const;

/** The three channels, as `buildProductionOrchestrator` takes them. */
export type AlertChannels = Pick<ProductionConfig, (typeof ALERT_CHANNEL_FIELDS)[number]>;

/**
 * The alerts posture for this run, or `undefined` when the caller supplied
 * every channel itself and there is nothing left to decide.
 *
 * Throws — before anything is constructed, and before any store is opened —
 * when the variable is absent or unrecognised.
 */
export function resolveAlertsMode(injected: Partial<ProductionConfig>): AlertsMode | undefined {
  if (ALERT_CHANNEL_FIELDS.every((field) => injected[field] !== undefined)) return undefined;

  const raw = process.env[ENV_VAR];
  const mode = ALERTS_MODES.find((candidate) => candidate === raw);
  if (mode !== undefined) return mode;

  throw new Error(
    `Orchestrator cannot start: ${ENV_VAR} must be one of ${ALERTS_MODES.join('|')}` +
      `${raw === undefined ? ' and is not set' : ''}. It selects where operator alerts go — the ` +
      "dead-man's-switch heartbeat, orphaned go-verdicts and stuck unpriced lots — and has no " +
      'default on purpose: an unattended run (#238) whose alerts quietly fall back to the log ' +
      'stream is exactly the failure this variable exists to prevent. Use ' +
      `${ENV_VAR}=telegram for an unattended run (also needs ` +
      `${TELEGRAM_ALERT_ENV_VARS.join(', ')}), or ${ENV_VAR}=log-only to accept log-only ` +
      'alerting for an attended one — a local dev run or a supervised smoke test, where ' +
      'somebody is reading stdout.',
  );
}

/**
 * The channels for `alertsMode`, omitting any the caller already injected.
 *
 * `log-only` returns nothing at all, deliberately: `production.ts` already
 * documents and constructs `LoggingHeartbeatChannel` /
 * `LoggingOrphanAlertChannel` / `LoggingUnpricedFillAlertChannel` as its
 * defaults, and a second set built here would be two places to keep in sync
 * for no behavioural difference. The `warn` is the point of the branch.
 *
 * `telegram` builds ONE `TelegramBotApiClient` shared by all three adapters —
 * not one each: they share a bot token, a retry budget and Telegram's ~30
 * messages/second ceiling, and three clients would each believe they owned the
 * whole allowance.
 */
export function buildAlertChannels(deps: {
  alertsMode: AlertsMode;
  injected: Partial<ProductionConfig>;
  db: SqliteHandle;
  logger: Logger;
}): AlertChannels {
  if (deps.alertsMode === 'log-only') {
    deps.logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'warn',
      message:
        `${ENV_VAR}=log-only — every operator alert (heartbeat, orphaned go verdict, stuck ` +
        'unpriced fill, kill-threshold breach) is a log line, and nothing will reach a phone. ' +
        `Correct for an ATTENDED run only; an unattended soak (#238) needs ${ENV_VAR}=telegram.`,
      payload: { alerts: 'log-only' },
    });
    return {};
  }

  const chatId = requireEnv('TELEGRAM_CHAT_ID');
  // The bot token and the allowlist are read by the client itself, from the
  // same variables — not re-read here, so there is exactly one place that
  // touches the token and exactly one that validates the allowlist.
  const telegram = new TelegramBotApiClient({
    // Where the client posts its own repeated-allowlist-rejection security
    // alert. The same chat the alerts go to: it is the channel the operator is
    // already watching, and a security signal with nowhere to go is the
    // failure mode this whole ticket is about.
    alertChatId: chatId,
    // Written to on an inbound allowlist rejection. Unused while nothing polls
    // (see the module doc), and supplied anyway rather than stubbed: the store
    // is the durable one every other component here writes to, so the day
    // approvals are wired there is no second decision to get wrong.
    auditLog: new SqliteAuditLog(deps.db),
    logger: deps.logger,
  });

  deps.logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'info',
    message:
      `${ENV_VAR}=telegram — heartbeat, orphaned go verdicts, stuck unpriced fills and ` +
      'kill-threshold breaches will be pushed to the trade channel. No approval poll is started ' +
      'here; HITL approvals still resolve through ProductionConfig.approvals (#275).',
    // Never the token, and never the chat id: neither is a secret worth a log
    // line, and the token is a bearer credential for the entire bot.
    payload: { alerts: 'telegram' },
  });

  return {
    ...(deps.injected.heartbeatChannel === undefined
      ? { heartbeatChannel: new TradeChannelHeartbeat(telegram, chatId) }
      : {}),
    ...(deps.injected.orphanAlerts === undefined
      ? { orphanAlerts: new TradeChannelOrphanAlert(telegram, chatId) }
      : {}),
    ...(deps.injected.unpricedFillAlerts === undefined
      ? { unpricedFillAlerts: new TradeChannelUnpricedFillAlert(telegram, chatId) }
      : {}),
    ...(deps.injected.breachAlerts === undefined
      ? {
          breachAlerts: new TradeChannelBreachAlert(
            telegram,
            chatId,
            undefined,
            undefined,
            deps.logger,
          ),
        }
      : {}),
  };
}

/**
 * A backstop, not the primary check: `missingCredentialEnvVars` (index.ts)
 * names every absent variable at once, before this module is reached. This
 * exists so that a programmatic caller reaching `buildAlertChannels` directly
 * still fails with a legible message instead of posting to `chat_id: undefined`.
 * Names the variable only — never its value.
 */
function requireEnv(name: (typeof TELEGRAM_ALERT_ENV_VARS)[number]): string {
  const value = process.env[name] ?? '';
  if (value.length === 0) {
    throw new Error(
      `Orchestrator cannot start: ${ENV_VAR}=telegram was selected but ${name} is not set ` +
        '(an empty value counts as missing). Set it, or re-run with ' +
        `${ENV_VAR}=log-only to accept log-only alerting for an attended run.`,
    );
  }
  return value;
}
