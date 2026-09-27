import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LogEntry, Logger } from '../../shared/index.js';
import {
  type Alert,
  AlertingLogger,
  alertsFor,
  alertText,
  QUIET_EVENTS,
  severityOf,
  telegramSender,
  withAlerts,
} from './alerts.js';

const TOKEN = '123456:bot-secret-token';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100777' };

function recorder() {
  const entries: LogEntry[] = [];
  const logger: Logger = {
    log: (entry) => {
      entries.push(entry);
    },
  };
  return { entries, logger };
}

const entry = (level: LogEntry['level'], event: string, message = 'm'): LogEntry =>
  ({ trace_id: 't', stage: 'v2', level, event, message }) as LogEntry;

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200 });
}

function sentBodies(fetchImpl: ReturnType<typeof vi.fn>) {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body));
}

describe('severityOf', () => {
  it('makes errors critical and warnings silent warnings, and leaves the rest unsent', () => {
    expect(severityOf(entry('error', 'v2_x'))).toBe('critical');
    expect(severityOf(entry('warn', 'v2_x'))).toBe('warning');
    expect(severityOf(entry('info', 'v2_x'))).toBeUndefined();
    expect(severityOf(entry('debug', 'v2_x'))).toBeUndefined();
    expect(severityOf({ trace_id: 't', stage: 'v2', level: 'info', message: 'm' })).toBeUndefined();
  });

  it('never alerts a quiet event, at any level', () => {
    for (const event of QUIET_EVENTS) {
      expect(severityOf(entry('warn', event))).toBeUndefined();
      expect(severityOf(entry('error', event))).toBeUndefined();
    }
  });

  it('names only quiet events that v2 still logs', () => {
    const root = 'server/apps/v2';
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .filter((path) => !path.endsWith('alerts.ts'))
      .map((path) => readFileSync(join(root, path), 'utf8'))
      .join('\n');
    for (const event of QUIET_EVENTS) expect(sources).toContain(`'${event}'`);
  });
});

describe('AlertingLogger', () => {
  it('passes every entry on and keeps the ones that alert, once', () => {
    const { entries, logger } = recorder();
    const alerting = new AlertingLogger(logger);
    alerting.log(entry('info', 'v2_a', 'fine'));
    alerting.log(entry('warn', 'v2_b', 'slow'));
    alerting.log(entry('error', 'v2_c', 'down'));
    expect(entries.map((logged) => logged.event)).toEqual(['v2_a', 'v2_b', 'v2_c']);
    expect(alerting.take()).toEqual([
      { severity: 'warning', event: 'v2_b', message: 'slow' },
      { severity: 'critical', event: 'v2_c', message: 'down' },
    ]);
    expect(alerting.take()).toEqual([]);
  });
});

describe('alertText', () => {
  const alert = (event: string, message: string): Alert => ({
    severity: 'critical',
    event,
    message,
  });

  it('heads the text with its severity and counts repeated alerts', () => {
    expect(
      alertText('critical', [alert('v2_a', 'x'), alert('v2_b', 'y'), alert('v2_a', 'x')], ''),
    ).toBe('Samurai v2 CRITICAL\nv2_a: x (x2)\nv2_b: y');
    expect(alertText('warning', [alert('v2_a', 'x')], '')).toBe('Samurai v2 warning\nv2_a: x');
  });

  it('removes the bot token and masked credentials', () => {
    expect(alertText('critical', [alert('v2_a', `url bot${TOKEN}/send`)], TOKEN)).toBe(
      'Samurai v2 CRITICAL\nv2_a: url bot[TELEGRAM_BOT_TOKEN]/send',
    );
    expect(alertText('critical', [alert('v2_a', 'token=abc')], TOKEN)).toBe(
      'Samurai v2 CRITICAL\nv2_a: [REDACTED]',
    );
  });

  it('counts an event that repeats with different messages, keeping the first', () => {
    expect(
      alertText('warning', [alert('v2_a', 'x'), alert('v2_a', 'y'), alert('v2_a', 'x')], ''),
    ).toBe('Samurai v2 warning\nv2_a (x3), first: x');
  });

  it('stays inside the Telegram message limit, marks the cut and never splits a character', () => {
    const text = alertText('warning', [alert('v2_a', '😀'.repeat(5000))], '');
    const chars = Array.from(text);
    expect(chars).toHaveLength(4096);
    expect(text.startsWith('Samurai v2 warning\nv2_a: 😀')).toBe(true);
    expect(text.endsWith('😀\n…(truncated)')).toBe(true);
    const exact = alertText('warning', [alert('v2_a', 'y'.repeat(4096 - 25))], '');
    expect(exact).toHaveLength(4096);
    expect(exact.endsWith('y')).toBe(true);
  });
});

describe('telegramSender', () => {
  it('posts to the bot API, silently unless critical', async () => {
    const fetchImpl = okFetch();
    const send = telegramSender(TOKEN, '-100777', fetchImpl, recorder().logger);
    await send('critical', 'boom');
    await send('warning', 'meh');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(sentBodies(fetchImpl)).toEqual([
      { chat_id: '-100777', text: 'boom', disable_notification: false },
      { chat_id: '-100777', text: 'meh', disable_notification: true },
    ]);
  });

  it('logs a refused or failed send without the token, and never throws', async () => {
    const { entries, logger } = recorder();
    await telegramSender(
      TOKEN,
      'c',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
      logger,
    )('warning', 'x');
    await expect(
      telegramSender(
        TOKEN,
        'c',
        vi.fn().mockRejectedValue(new TypeError(`fetch failed bot${TOKEN}`)),
        logger,
      )('critical', 'x'),
    ).resolves.toBeUndefined();
    expect(entries.map((logged) => [logged.level, logged.event, logged.message])).toEqual([
      ['warn', 'v2_alert_send_failed', 'Telegram answered 401'],
      ['warn', 'v2_alert_send_failed', 'Telegram critical alert did not complete'],
    ]);
    expect(entries.every((logged) => logged.trace_id === 'v2-alerts')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('bot-secret-token');
  });
});

describe('alertsFor', () => {
  it('sends one message per severity, critical first, then nothing until more arrive', async () => {
    const fetchImpl = okFetch();
    const alerts = alertsFor([], ENV, fetchImpl, recorder().logger);
    alerts.logger.log(entry('warn', 'v2_w', 'one'));
    alerts.logger.log(entry('error', 'v2_e', 'two'));
    alerts.logger.log(entry('warn', 'v2_w', 'three'));
    await alerts.flush();
    await alerts.flush();
    expect(sentBodies(fetchImpl).map((body) => body.text)).toEqual([
      'Samurai v2 CRITICAL\nv2_e: two',
      'Samurai v2 warning\nv2_w (x2), first: one',
    ]);
  });

  it('sends only the severities that occurred', async () => {
    const fetchImpl = okFetch();
    const alerts = alertsFor([], ENV, fetchImpl, recorder().logger);
    alerts.logger.log(entry('warn', 'v2_w', 'one'));
    await alerts.flush();
    expect(sentBodies(fetchImpl).map((body) => body.disable_notification)).toEqual([true]);
  });

  it('scrubs the configured token from what it sends', async () => {
    const fetchImpl = okFetch();
    const alerts = alertsFor([], { ...ENV, TELEGRAM_BOT_TOKEN: ` ${TOKEN} ` }, fetchImpl, {
      log: () => {},
    });
    alerts.logger.log(entry('error', 'v2_e', `saw ${TOKEN}`));
    await alerts.flush();
    expect(sentBodies(fetchImpl)[0].text).toBe(
      'Samurai v2 CRITICAL\nv2_e: saw [TELEGRAM_BOT_TOKEN]',
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });

  it('sends nothing on a dry run, and says so when SAMURAI_ALERTS=log-only', async () => {
    const fetchImpl = okFetch();
    for (const [argv, env, logged] of [
      [['--dry-run'], { ...ENV, SAMURAI_ALERTS: 'log-only' }, ['v2_e']],
      [[], { ...ENV, SAMURAI_ALERTS: ' log-only ' }, ['v2_alerts_log_only', 'v2_e']],
    ] as const) {
      const { entries, logger } = recorder();
      const alerts = alertsFor(argv, env, fetchImpl, logger);
      alerts.logger.log(entry('error', 'v2_e'));
      await alerts.flush();
      expect(entries.map((each) => each.event)).toEqual(logged);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('warns that log-only mutes Telegram', () => {
    const { entries, logger } = recorder();
    alertsFor([], { SAMURAI_ALERTS: 'log-only' }, okFetch(), logger);
    expect(entries).toEqual([
      {
        trace_id: 'v2-alerts',
        stage: 'v2',
        level: 'warn',
        event: 'v2_alerts_log_only',
        message: 'SAMURAI_ALERTS=log-only: no Telegram alert is sent',
      },
    ]);
  });

  it('warns once per severity when the bot token or chat is unset', async () => {
    const fetchImpl = okFetch();
    for (const env of [
      { TELEGRAM_CHAT_ID: 'c' },
      { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: ' ' },
    ]) {
      const { entries, logger } = recorder();
      const alerts = alertsFor([], env, fetchImpl, logger);
      alerts.logger.log(entry('error', 'v2_e'));
      alerts.logger.log(entry('warn', 'v2_w'));
      await alerts.flush();
      expect(
        entries.slice(2).map((logged) => [logged.level, logged.event, logged.message]),
      ).toEqual([
        [
          'warn',
          'v2_alerts_unset',
          'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set: critical alert not sent',
        ],
        [
          'warn',
          'v2_alerts_unset',
          'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set: warning alert not sent',
        ],
      ]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('withAlerts', () => {
  it('flushes after a clean run and returns its code', async () => {
    const fetchImpl = okFetch();
    const alerts = alertsFor([], ENV, fetchImpl, recorder().logger);
    const code = await withAlerts(() => {
      alerts.logger.log(entry('warn', 'v2_w', 'slow'));
      return Promise.resolve(3);
    }, alerts);
    expect(code).toBe(3);
    expect(sentBodies(fetchImpl).map((body) => body.text)).toEqual([
      'Samurai v2 warning\nv2_w: slow',
    ]);
  });

  it('keeps the run outcome when the flush itself fails', async () => {
    const failing = { logger: recorder().logger, flush: () => Promise.reject(new Error('flush')) };
    await expect(withAlerts(() => Promise.resolve(0), failing)).resolves.toBe(0);
    const cycle = new Error('cycle');
    await expect(withAlerts(() => Promise.reject(cycle), failing)).rejects.toBe(cycle);
  });

  it('turns a thrown run into a critical alert, sends it, and rethrows', async () => {
    const fetchImpl = okFetch();
    const { entries, logger } = recorder();
    const alerts = alertsFor([], ENV, fetchImpl, logger);
    const failure = new Error('store locked');
    await expect(withAlerts(() => Promise.reject(failure), alerts)).rejects.toBe(failure);
    await expect(withAlerts(() => Promise.reject('plain'), alerts)).rejects.toBe('plain');
    expect(sentBodies(fetchImpl).map((body) => body.text)).toEqual([
      'Samurai v2 CRITICAL\nv2_cycle_failed: store locked',
      'Samurai v2 CRITICAL\nv2_cycle_failed: plain',
    ]);
    expect(entries[0]).toEqual({
      trace_id: 'v2-alerts',
      stage: 'v2',
      level: 'error',
      event: 'v2_cycle_failed',
      message: 'store locked',
    });
  });
});
