import { type LogEntry, type Logger, maskCredentials } from '../../shared/index.js';

export type Severity = 'critical' | 'warning';

export interface Alert {
  readonly severity: Severity;
  readonly event: string;
  readonly message: string;
}

export type AlertFetch = (
  url: string,
  init: {
    method: string;
    signal: AbortSignal;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number }>;

export type AlertSender = (severity: Severity, text: string) => Promise<void>;

export interface Alerts {
  readonly logger: Logger;
  flush(): Promise<void>;
}

const SEND_TIMEOUT_MS = 10_000;
// Telegram Bot API sendMessage rejects text longer than 4096 characters
const TELEGRAM_MAX_CHARS = 4096;
const TRUNCATED = '\n…(truncated)';

const SEVERITIES: readonly Severity[] = ['critical', 'warning'];

const HEADERS: Readonly<Record<Severity, string>> = {
  critical: 'Samurai v2 CRITICAL',
  warning: 'Samurai v2 warning',
};

export const QUIET_EVENTS: ReadonlySet<string> = new Set([
  'v2_llm_transport_scripted',
  'v2_impact_fallback',
]);

export function severityOf(entry: LogEntry): Severity | undefined {
  if (QUIET_EVENTS.has(String(entry.event))) return undefined;
  if (entry.level === 'error') return 'critical';
  if (entry.level === 'warn') return 'warning';
  return undefined;
}

export class AlertingLogger implements Logger {
  readonly #inner: Logger;
  readonly #alerts: Alert[] = [];

  constructor(inner: Logger) {
    this.#inner = inner;
  }

  log(entry: LogEntry): void {
    this.#inner.log(entry);
    const severity = severityOf(entry);
    if (severity !== undefined) {
      this.#alerts.push({ severity, event: String(entry.event), message: entry.message });
    }
  }

  take(): Alert[] {
    return this.#alerts.splice(0);
  }
}

function eventLine(event: string, messages: readonly string[]): string {
  const [first = ''] = messages;
  if (messages.length === 1) return `${event}: ${first}`;
  const distinct = new Set(messages).size;
  const count = `(x${messages.length})`;
  return distinct === 1 ? `${event}: ${first} ${count}` : `${event} ${count}, first: ${first}`;
}

function truncated(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= TELEGRAM_MAX_CHARS) return text;
  return chars.slice(0, TELEGRAM_MAX_CHARS - TRUNCATED.length).join('') + TRUNCATED;
}

export function alertText(severity: Severity, alerts: readonly Alert[], secret: string): string {
  const byEvent = new Map<string, string[]>();
  for (const alert of alerts) {
    byEvent.set(alert.event, [...(byEvent.get(alert.event) ?? []), alert.message]);
  }
  const lines = [...byEvent].map(([event, messages]) => eventLine(event, messages));
  const text = [HEADERS[severity], ...lines].join('\n');
  const unsecret = secret === '' ? text : text.split(secret).join('[TELEGRAM_BOT_TOKEN]');
  return truncated(maskCredentials(unsecret));
}

function logAlerts(logger: Logger, event: string, message: string): void {
  logger.log({ trace_id: 'v2-alerts', stage: 'v2', level: 'warn', event, message });
}

export function telegramSender(
  token: string,
  chatId: string,
  fetchImpl: AlertFetch,
  logger: Logger,
): AlertSender {
  return async (severity, text) => {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_notification: severity !== 'critical',
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        logAlerts(logger, 'v2_alert_send_failed', `Telegram answered ${response.status}`);
      }
    } catch {
      // The fetch error text can carry the request URL, which holds the bot token
      logAlerts(logger, 'v2_alert_send_failed', `Telegram ${severity} alert did not complete`);
    }
  };
}

const NO_SEND: AlertSender = () => Promise.resolve();

function senderFor(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: AlertFetch,
  logger: Logger,
): AlertSender {
  if (argv.includes('--dry-run')) return NO_SEND;
  if (env.SAMURAI_ALERTS?.trim() === 'log-only') {
    logAlerts(logger, 'v2_alerts_log_only', 'SAMURAI_ALERTS=log-only: no Telegram alert is sent');
    return NO_SEND;
  }
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const chatId = env.TELEGRAM_CHAT_ID?.trim() ?? '';
  if (token === '' || chatId === '') {
    return (severity) => {
      logAlerts(
        logger,
        'v2_alerts_unset',
        `TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set: ${severity} alert not sent`,
      );
      return Promise.resolve();
    };
  }
  return telegramSender(token, chatId, fetchImpl, logger);
}

export function alertsFor(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: AlertFetch,
  logger: Logger,
): Alerts {
  const collector = new AlertingLogger(logger);
  const send = senderFor(argv, env, fetchImpl, logger);
  const secret = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  return {
    logger: collector,
    flush: async () => {
      const alerts = collector.take();
      for (const severity of SEVERITIES) {
        const matching = alerts.filter((alert) => alert.severity === severity);
        if (matching.length > 0) await send(severity, alertText(severity, matching, secret));
      }
    },
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function withAlerts(run: () => Promise<number>, alerts: Alerts): Promise<number> {
  try {
    return await run();
  } catch (error) {
    alerts.logger.log({
      trace_id: 'v2-alerts',
      stage: 'v2',
      level: 'error',
      event: 'v2_cycle_failed',
      message: messageOf(error),
    });
    throw error;
  } finally {
    await alerts.flush().catch(() => undefined);
  }
}
