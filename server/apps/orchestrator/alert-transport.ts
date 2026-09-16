/**
 * Alert-transport selection at the composition root — what makes an
 * unattended paper soak actually unattended (operator escalations were
 * previously reachable but never wired, so they fell through to log-only
 * stand-ins by omission, silently).
 *
 * `SAMURAI_ALERTS` has no default: a `log-only` default would recreate the
 * bug being fixed, and a `telegram` default would fail every dev run wanting
 * a bot token — so the mode must be named explicitly or startup refuses.
 *
 * The heartbeat gets its own chat (`TELEGRAM_HEARTBEAT_CHAT_ID`, distinct
 * from `TELEGRAM_CHAT_ID`, refused at boot if equal): at a steady interval it
 * generates enough volume over a long soak that operators mute the chat it's
 * in, which would also mute real escalations sharing that destination.
 *
 * `TelegramBotApiClient` is outbound-only (no human-in-the-loop gate exists
 * at the shipped `auto` automation level, so no approval channel is wired).
 *
 * Built here rather than in `production.ts` because `buildProductionOrchestrator`
 * is called directly by many tests and programmatic callers that shouldn't
 * need a process-wide env var to construct a stubbed orchestrator; the
 * deployment decision belongs on the shipped entrypoint's path instead.
 */
import { TelegramBotApiClient, TelegramChannel } from '../../pipeline/verdict/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { ALERT_IDS, type AlertId, type AlertPort, tradeChannelAlert } from './alert-catalogue.js';
import { SqliteAlertDeliveryLog } from './alert-delivery-log.js';
import type { AlertChannelSlots, ProductionConfig } from './production.js';
import type { Logger } from './types.js';

const ENV_VAR = 'SAMURAI_ALERTS';

export const ALERTS_MODES = ['telegram', 'log-only'] as const;

export type AlertsMode = (typeof ALERTS_MODES)[number];

/**
 * The `AlertChannelSlots` fields this module owns — the outbound operator
 * escalations, and nothing else. `approvals` is deliberately absent: it's an
 * inbound round trip (`requestApproval` returns an answer), not an alert, and
 * the gate it would serve is unreachable at the shipped `auto` config.
 *
 * This list was previously hand-maintained against `ProductionConfig`, and
 * repeatedly missed a new channel with no transport wired for it. `satisfies
 * readonly (keyof AlertChannelSlots)[]` only catches a field that does NOT
 * belong here — `ALL_ALERT_CHANNEL_FIELDS_COVERED` below closes the other
 * direction, failing typecheck when a new `AlertChannelSlots` field has no
 * catalogue entry behind it.
 */
export const ALERT_CHANNEL_FIELDS = [
  ...ALERT_IDS,
  // Not a catalogue entry: `verdictAlerts`' port is shaped for a
  // `VerdictDecision` and implemented by Verdict's own `TelegramChannel`
  'verdictAlerts',
] as const satisfies readonly (keyof AlertChannelSlots)[];

/**
 * The other half of the exhaustiveness check. When `ALERT_CHANNEL_FIELDS`
 * covers every `AlertChannelSlots` key, the mapped type below has no keys and
 * `{}` satisfies it; miss a new field and the mapped type gains a required
 * key for it, so `{}` fails typecheck naming that key.
 *
 * Exported, not a throwaway local: the guard lives entirely in this binding's
 * TYPE, so an "unused local" cleanup would silently remove it.
 *
 * @knipignore never imported by name — the guard is its type, not a value
 * any caller reads. See knip.json's `tags`.
 */
export const ALL_ALERT_CHANNEL_FIELDS_COVERED: {
  [K in Exclude<keyof AlertChannelSlots, (typeof ALERT_CHANNEL_FIELDS)[number]>]: never;
} = {};

/**
 * Named separately because it's the one variable a caller can be exempted
 * from: injecting a `heartbeatChannel` means nothing here needs this chat id.
 * `missingCredentialEnvVars` (index.ts) keys its exemption off this constant.
 */
export const TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR = 'TELEGRAM_HEARTBEAT_CHAT_ID';

/** What `SAMURAI_ALERTS=telegram` needs in the environment */
export const TELEGRAM_ALERT_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
] as const;

/** The alert channels, as `buildProductionOrchestrator` takes them */
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

  // Trimmed so a trailing newline from an env file doesn't produce a
  // confusing "must be one of..." error about a value that reads correctly
  // on screen. (`SAMURAI_MODE` deliberately does NOT trim — see `parseMode`
  // in index.ts.)
  const raw = process.env[ENV_VAR]?.trim();
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
 * `log-only` returns nothing (production.ts's own defaults already cover it).
 * `telegram` builds ONE shared `TelegramBotApiClient`, not one per channel:
 * they share a bot token, a retry budget, and Telegram's rate ceiling.
 */
function logAlertsLogOnly(logger: Logger): void {
  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'alerts_log_only',
    level: 'warn',
    message:
      `${ENV_VAR}=log-only — every operator alert (heartbeat, orphaned go verdict, stuck ` +
      'unpriced fill, unprotected residual position, kill-threshold breach, proposed ' +
      'risk-threshold loosening) is a log line, and nothing will reach a phone. Correct for ' +
      `an ATTENDED run only; an unattended soak (#238) needs ${ENV_VAR}=telegram.`,
    payload: { alerts: 'log-only' },
  });
}

// Branched, not boilerplate: on the injected path this module reads no
// heartbeat chat id, so claiming the beat goes to
// `TELEGRAM_HEARTBEAT_CHAT_ID` would name a destination no heartbeat reaches
function heartbeatRoutingClause(heartbeatChatId: string | undefined): string {
  if (heartbeatChatId === undefined) {
    return (
      'The heartbeat is not routed here at all: ProductionConfig.heartbeatChannel was ' +
      `supplied by the caller, so where the beat goes is that channel's decision and ` +
      `${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} is neither read nor required (#342).`
    );
  }
  return (
    `The heartbeat goes to ${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} instead (#342), so that ` +
    'muting the beat cannot mute an escalation.'
  );
}

function logAlertsTelegram(logger: Logger, heartbeatChatId: string | undefined): void {
  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'info',
    message:
      `${ENV_VAR}=telegram — orphaned go verdicts, stuck unpriced fills, unprotected residual ` +
      'positions, unresolved flatten reconciliations, kill-threshold breaches and APPLIED ' +
      `risk-threshold loosenings will be pushed to the escalation chat (TELEGRAM_CHAT_ID). ` +
      `${heartbeatRoutingClause(heartbeatChatId)} ` +
      'Keep the escalation chat unmuted. Nothing is read back from Telegram: the loosening ' +
      'notice is outbound-only — it reports a dial the Feedback Loop already moved on its own ' +
      'authority, inside the hard bounds, and no reply to it is read (#366/#736).',
    // Never the token or either chat id: the token is a bearer credential
    // for the entire bot
    payload: {
      alerts: 'telegram',
      heartbeat: heartbeatChatId === undefined ? 'caller-supplied' : 'separate-chat',
    },
  });
}

function populateAlertChannels(
  channels: AlertChannels,
  injected: Partial<ProductionConfig>,
  telegram: TelegramBotApiClient,
  chatId: string,
  heartbeatChatId: string | undefined,
  logger: Logger,
): void {
  for (const id of ALERT_IDS) {
    if (injected[id] !== undefined) continue;
    if (id === 'heartbeatChannel') {
      if (heartbeatChatId !== undefined) {
        channels.heartbeatChannel = tradeChannelAlert(id, {
          telegram,
          chatId: heartbeatChatId,
          logger,
        });
      }
      continue;
    }
    assign(channels, id, tradeChannelAlert(id, { telegram, chatId, logger }));
  }
}

export function buildAlertChannels(deps: {
  alertsMode: AlertsMode;
  injected: Partial<ProductionConfig>;
  db: StoreHandle;
  logger: Logger;
}): AlertChannels {
  if (deps.alertsMode === 'log-only') {
    logAlertsLogOnly(deps.logger);
    return {};
  }

  const chatId = requireEnv('TELEGRAM_CHAT_ID');
  // Resolved before the client is constructed, so a misconfigured pair fails
  // with nothing built. `undefined` only when the caller supplied its own
  // heartbeat channel
  const heartbeatChatId =
    deps.injected.heartbeatChannel === undefined ? requireHeartbeatChatId(chatId) : undefined;

  const telegram = new TelegramBotApiClient({
    // Where the client posts its own repeated-delivery-failure notice — the
    // chat the operator is already watching
    alertChatId: chatId,
    // Durable record of a send that exhausts retries, so "how many
    // escalations went undelivered" survives the process that raised them
    alertDeliveryLog: new SqliteAlertDeliveryLog(deps.db),
    logger: deps.logger,
  });

  logAlertsTelegram(deps.logger, heartbeatChatId);

  const channels: AlertChannels = {};
  populateAlertChannels(channels, deps.injected, telegram, chatId, heartbeatChatId, deps.logger);
  if (deps.injected.verdictAlerts === undefined) {
    channels.verdictAlerts = new TelegramChannel(telegram, chatId);
  }
  return channels;
}

/** `channels[id] = channel` with the key and the value typed together, which a plain assignment loses on a union key */
function assign<K extends AlertId>(channels: AlertChannels, id: K, channel: AlertPort<K>): void {
  const slot: Pick<AlertChannelSlots, K> = channels;
  slot[id] = channel;
}

/**
 * The heartbeat's destination, refused when absent or equal to the escalation
 * chat — refused rather than warned about, since the warning would be
 * delivered to the chat the operator is about to mute
 */
function requireHeartbeatChatId(escalationChatId: string): string {
  const heartbeatChatId = requireEnv(TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR);
  if (heartbeatChatId === escalationChatId) {
    throw new Error(
      `Orchestrator cannot start: ${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} is the same chat as ` +
        'TELEGRAM_CHAT_ID. The heartbeat needs a destination of its own: it posts on a fixed ' +
        'interval forever (~1,300 messages over a 14-day soak, #238), and pointed at the ' +
        'escalation chat it drives the operator to mute the one channel that carries orphaned ' +
        'go verdicts, stuck unpriced fills and kill-threshold breaches (#342). Create a second ' +
        `chat for the beat and set ${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} to it, or re-run with ` +
        `${ENV_VAR}=log-only to accept log-only alerting for an attended run.`,
    );
  }
  return heartbeatChatId;
}

/**
 * A backstop, not the primary check: `missingCredentialEnvVars` (index.ts)
 * names every absent variable up front. This lets a programmatic caller
 * reaching `buildAlertChannels` directly still fail legibly.
 *
 * Trims deliberately: without it, a trailing newline from an env file would
 * slip past the same-chat equality check above while still addressing the
 * escalation chat, silently defeating that guard — and separately, a
 * `chat_id` carrying a newline is a Bot API 400 on every send.
 */
function requireEnv(name: (typeof TELEGRAM_ALERT_ENV_VARS)[number]): string {
  const value = (process.env[name] ?? '').trim();
  if (value.length === 0) {
    throw new Error(
      `Orchestrator cannot start: ${ENV_VAR}=telegram was selected but ${name} is not set ` +
        '(an empty or whitespace-only value counts as missing). Set it, or re-run with ' +
        `${ENV_VAR}=log-only to accept log-only alerting for an attended run.`,
    );
  }
  return value;
}
