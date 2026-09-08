import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { runWithTraceId } from '../../shared/index.js';
import {
  breachLogMessage,
  breachStage,
  classifyBreach,
  formatBreachAlert,
  LLM_SPEND_CAP_BREACH,
  TradeChannelBreachAlert,
} from './breach-alert-channel.js';
import type { LogEntry, Logger } from './types.js';

const ALERT = {
  breaches: [LLM_SPEND_CAP_BREACH],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

const KILL_LINE_ALERT = {
  breaches: ['pbo_over_max'],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

const BOTH_ALERT = {
  breaches: [LLM_SPEND_CAP_BREACH, 'pbo_over_max'],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

const NONE_ALERT = {
  breaches: [] as string[],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

/**
 * The two markers `breachOutcome`/`breachLogMessage` decide between. Tests
 * below assert on these directly — if the kill-line and spend-cap text were
 * ever swapped, these assertions redden (#1343's mutation-proof requirement).
 * `hasSpendCapMarker` is a regex because the prose spells it both
 * `spend-cap` (hyphenated, e.g. "a spend-cap refusal") and `spend cap`
 * (e.g. "the LLM spend cap has refused") depending on the sentence.
 */
const KILL_LINE_MARKER = 'auto-tightened';
function hasSpendCapMarker(text: string): boolean {
  return /spend[- ]cap/i.test(text);
}

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

function failingTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockRejectedValue(new Error('telegram 502')),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  } as unknown as TelegramClient;
}

describe('TradeChannelBreachAlert (#1280)', () => {
  // The send is fire-and-forget; let the `.then` on the settled pair run.
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  // Same two callers as `LoggingBreachAlertChannel`: the daily kill-line batch
  // outside any tick, and `llm_spend_cap` raised inside one by
  // `SqliteSpendCap#refuse`. Differential, so no single constant passes.
  it('logs an undelivered breach under whichever caller raised it', async () => {
    const logger = makeLogger();
    const post = (): void => {
      new TradeChannelBreachAlert(failingTelegram(), 'chat-escalation', logger).postBreachAlert(
        ALERT,
      );
    };

    post();
    runWithTraceId('tick-spend-cap', post);
    await flush();

    expect(logger.entries.map((entry) => entry.trace_id)).toEqual([
      'feedback-cycle',
      'tick-spend-cap',
    ]);
  });

  // The `stage` half. Threading the trace made a hardcoded `'feedback-loop'`
  // wrong on the spend-cap caller, whose sibling line in `SqliteSpendCap#refuse`
  // logs under `debate` — an operator grepping that stage for the tick would
  // otherwise miss the breach entirely.
  it('files a breach under the stage of the caller that raised it', () => {
    expect(breachStage(ALERT)).toBe('debate');
    expect(breachStage(KILL_LINE_ALERT)).toBe('feedback-loop');
    // Conservative on a list the two current producers never build.
    expect(
      breachStage({ breaches: [LLM_SPEND_CAP_BREACH, 'pbo_over_max'], reported_at: new Date() }),
    ).toBe('feedback-loop');
  });

  it('logs an undelivered breach under that same stage', async () => {
    const logger = makeLogger();
    const post = (alert: typeof ALERT): void => {
      new TradeChannelBreachAlert(failingTelegram(), 'chat-escalation', logger).postBreachAlert(
        alert,
      );
    };

    post(ALERT);
    post(KILL_LINE_ALERT);
    await flush();

    expect(logger.entries.map((entry) => entry.stage)).toEqual(['debate', 'feedback-loop']);
  });

  // #1343: the failed-send line named every undelivered alert "kill-threshold
  // breach", which was false for a spend-cap send failure. `breachLabel`
  // (internal to breach-alert-channel.ts) discriminates it the same way
  // `formatBreachAlert`/`breachLogMessage` do.
  it("names what failed to send, not always 'kill-threshold'", async () => {
    const logger = makeLogger();
    const post = (alert: typeof ALERT): void => {
      new TradeChannelBreachAlert(failingTelegram(), 'chat-escalation', logger).postBreachAlert(
        alert,
      );
    };

    post(KILL_LINE_ALERT);
    post(ALERT);
    post(BOTH_ALERT);
    post(NONE_ALERT);
    await flush();

    const messages = logger.entries.map((entry) => entry.message);
    expect(messages[0]).toBe(
      'kill-threshold breach alert failed to send — the breach still stands',
    );
    expect(messages[1]).toBe('LLM spend-cap breach alert failed to send — the breach still stands');
    expect(messages[2]).toBe(
      'kill-threshold and LLM spend-cap breach alert failed to send — the breach still stands',
    );
    expect(messages[3]).toBe('breach alert failed to send — the breach still stands');
  });
});

describe('classifyBreach (#1343)', () => {
  it('is total over the four shapes breaches can take', () => {
    expect(classifyBreach(KILL_LINE_ALERT.breaches)).toBe('kill-line');
    expect(classifyBreach(ALERT.breaches)).toBe('spend-cap');
    expect(classifyBreach(BOTH_ALERT.breaches)).toBe('both');
    expect(classifyBreach(NONE_ALERT.breaches)).toBe('none');
  });

  it('treats any non-spend-cap id as kill-line, matching breachStage', () => {
    expect(classifyBreach(['oos_sharpe_under_min'])).toBe('kill-line');
    expect(classifyBreach(['dsr_insignificant'])).toBe('kill-line');
    expect(classifyBreach(['live_backtest_divergence_over_max'])).toBe('kill-line');
  });
});

describe('formatBreachAlert (#1343)', () => {
  it('describes auto-tighten on the kill-line caller, and nothing else', () => {
    const text = formatBreachAlert(KILL_LINE_ALERT);

    expect(text).toContain('Samurai KILL-THRESHOLD BREACH');
    expect(text).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(text)).toBe(false);
    // Unchanged from before #1343 — this caller's text was already true.
    expect(text).toBe(
      'Samurai KILL-THRESHOLD BREACH (1): pbo_over_max.\n' +
        'Detected 2026-09-08T09:00:00.000Z.\n' +
        'Every risk threshold has been defensively auto-tightened. No kill has been applied ' +
        'and none will be — kill or rework is your decision. Review the strategy before the ' +
        'next session.',
    );
  });

  it('describes the spend-cap refusal, and claims no threshold was tightened', () => {
    const text = formatBreachAlert(ALERT);

    expect(text).toContain('Samurai LLM SPEND-CAP BREACH');
    expect(hasSpendCapMarker(text)).toBe(true);
    expect(text).not.toContain(KILL_LINE_MARKER);
    // The wiring in production.ts discards SpendCapVerdict, so the alert
    // cannot say which refusal kind fired — a budget refusal stays refused
    // until raised, but a ledger-read fault can clear on its own on a later
    // tick (SqliteSpendCap's #budgetAnnounced/#faultAnnounced doc). The text
    // must not promise a fix an operator may not need to make.
    expect(text).not.toContain('window');
    expect(text).toContain('either the budget being reached');
    expect(text).toContain('spend ledger being unreadable');
    expect(text).toContain('can clear on its own');
  });

  it('describes both when both breach kinds are present', () => {
    const text = formatBreachAlert(BOTH_ALERT);

    expect(text).toContain('Samurai KILL-THRESHOLD BREACH + LLM SPEND-CAP BREACH');
    expect(text).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(text)).toBe(true);
  });

  it('claims neither outcome when no recognized breach id is present', () => {
    const text = formatBreachAlert(NONE_ALERT);

    expect(text).toContain('Samurai BREACH (0): none.');
    expect(text).not.toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(text)).toBe(false);
    expect(text).toContain('No recognized breach id was reported');
  });
});

describe('breachLogMessage (#1343)', () => {
  it("matches formatBreachAlert's discrimination for the log line", () => {
    expect(breachLogMessage(KILL_LINE_ALERT.breaches)).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(breachLogMessage(KILL_LINE_ALERT.breaches))).toBe(false);
    // Unchanged from before #1343.
    expect(breachLogMessage(KILL_LINE_ALERT.breaches)).toBe(
      'kill-threshold breach — risk thresholds auto-tightened; review the strategy and ' +
        'decide kill or rework (no automatic kill is ever applied)',
    );

    expect(hasSpendCapMarker(breachLogMessage(ALERT.breaches))).toBe(true);
    expect(breachLogMessage(ALERT.breaches)).not.toContain(KILL_LINE_MARKER);
    expect(breachLogMessage(ALERT.breaches)).not.toContain('window');
    // Same hedge as formatBreachAlert: the wiring discards SpendCapVerdict,
    // so the message must not promise permanence a fault refusal may not need.
    expect(breachLogMessage(ALERT.breaches)).toContain('Either the budget has been reached');
    expect(breachLogMessage(ALERT.breaches)).toContain('may clear on its own');

    expect(breachLogMessage(BOTH_ALERT.breaches)).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(breachLogMessage(BOTH_ALERT.breaches))).toBe(true);

    expect(breachLogMessage(NONE_ALERT.breaches)).not.toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(breachLogMessage(NONE_ALERT.breaches))).toBe(false);
  });
});
