import { TelegramBotApiClient, TelegramChannel } from '../../pipeline/verdict/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { ALERT_IDS, type AlertId, type AlertPort, tradeChannelAlert } from './alert-catalogue.js';
import { SqliteAlertDeliveryLog } from './alert-delivery-log.js';
import type { AlertChannelSlots, ProductionConfig } from './production.js';
import type { Logger } from './types.js';

const ENV_VAR = 'SAMURAI_ALERTS';

export const ALERTS_MODES = ['telegram', 'log-only'] as const;

export type AlertsMode = (typeof ALERTS_MODES)[number];

export const ALERT_CHANNEL_FIELDS = [
  ...ALERT_IDS,
  'verdictAlerts',
] as const satisfies readonly (keyof AlertChannelSlots)[];

const _ALL_ALERT_CHANNEL_FIELDS_COVERED: {
  [K in Exclude<keyof AlertChannelSlots, (typeof ALERT_CHANNEL_FIELDS)[number]>]: never;
} = {};

export const TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR = 'TELEGRAM_HEARTBEAT_CHAT_ID';

export const TELEGRAM_ALERT_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
] as const;

export type AlertChannels = Pick<ProductionConfig, (typeof ALERT_CHANNEL_FIELDS)[number]>;

export function resolveAlertsMode(injected: Partial<ProductionConfig>): AlertsMode | undefined {
  if (ALERT_CHANNEL_FIELDS.every((field) => injected[field] !== undefined)) return undefined;

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
  const heartbeatChatId =
    deps.injected.heartbeatChannel === undefined ? requireHeartbeatChatId(chatId) : undefined;

  const telegram = new TelegramBotApiClient({
    alertChatId: chatId,
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

function assign<K extends AlertId>(channels: AlertChannels, id: K, channel: AlertPort<K>): void {
  const slot: Pick<AlertChannelSlots, K> = channels;
  slot[id] = channel;
}

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
