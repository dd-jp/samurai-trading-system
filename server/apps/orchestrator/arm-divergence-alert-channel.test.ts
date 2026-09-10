import type { ArmDivergenceAlert } from '../../pipeline/feedback-loop/index.js';
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import {
  formatArmDivergenceAlert,
  TradeChannelArmDivergenceAlert,
} from './arm-divergence-alert-channel.js';
import type { Logger } from './types.js';

const ALERT: ArmDivergenceAlert = {
  comparison: {
    from: new Date('2026-08-02T00:00:00Z'),
    to: new Date('2026-09-01T00:00:00Z'),
    basis: 1000,
    live: {
      arm: 'live',
      trade_count: 11,
      realized_pnl_net: -4.5,
      return_pct: -0.0045,
      max_drawdown_pct: 0.031,
      refused_pass_count: 0,
    },
    control: {
      arm: 'control',
      trade_count: 14,
      realized_pnl_net: 18.2,
      return_pct: 0.0182,
      max_drawdown_pct: 0.019,
      refused_pass_count: 0,
    },
  },
  reason: 'the control arm is ahead by 2.27% of the book over this window',
  reported_at: new Date('2026-09-01T06:00:00Z'),
};

function makeTelegram(): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalButtons: vi.fn().mockResolvedValue(undefined),
    onApprovalCallback: vi.fn(),
  };
}

function makeLogger(): Logger {
  return { log: vi.fn() } as unknown as Logger;
}

describe('formatArmDivergenceAlert', () => {
  it('prints both arms with return AND drawdown — no return-only line exists (doc 12 D4)', () => {
    const text = formatArmDivergenceAlert(ALERT);

    // Every line that carries a return must carry the drawdown beside it. This
    // is asserted structurally rather than by substring so a future edit that
    // splits the columns onto separate lines fails here.
    const armLines = text.split('\n').filter((line) => line.includes('return '));
    expect(armLines).toHaveLength(2);
    for (const line of armLines) {
      expect(line).toContain('max drawdown');
    }
    expect(text).toContain('live:    11 trade(s), return -0.45%, max drawdown 3.10%');
    expect(text).toContain('control: 14 trade(s), return 1.82%, max drawdown 1.90%');
  });

  it('states the ONE window and the shared basis, so two-window misreading is impossible', () => {
    const text = formatArmDivergenceAlert(ALERT);

    expect(text).toContain('Window 2026-08-02T00:00:00.000Z → 2026-09-01T00:00:00.000Z');
    expect(text).toContain('basis $1000.00 (the same denominator for both arms)');
  });

  it("carries the cycle's own reason sentence, so alert and dashboard cannot disagree", () => {
    expect(formatArmDivergenceAlert(ALERT)).toContain(`Why this fired: ${ALERT.reason}.`);
  });

  it('carries the convergence asymmetry and says nothing was auto-tightened', () => {
    const text = formatArmDivergenceAlert(ALERT);

    expect(text).toContain('ONE KNOWN ASYMMETRY');
    expect(text).toContain('always treated as converged');
    expect(text).toContain('Nothing was auto-tightened');
    // It must NOT read as a kill-line breach: that wording would tell an
    // operator thresholds had already moved.
    expect(text).not.toContain('KILL-THRESHOLD BREACH');
  });
});

describe('TradeChannelArmDivergenceAlert', () => {
  it('posts the formatted alert to the escalation chat it was given', () => {
    const telegram = makeTelegram();

    new TradeChannelArmDivergenceAlert(
      telegram,
      'chat-escalation',
      makeLogger(),
    ).postArmDivergenceAlert(ALERT);

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe('chat-escalation');
    expect(text).toBe(formatArmDivergenceAlert(ALERT));
  });

  it('logs an error when the send fails — a divergence that failed to send still stands', async () => {
    const telegram = makeTelegram();
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('telegram 502'));
    const logger = makeLogger();

    new TradeChannelArmDivergenceAlert(telegram, 'chat-escalation', logger).postArmDivergenceAlert(
      ALERT,
    );
    // The port is synchronous and the send is fire-and-forget; let the
    // rejection handler run.
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.log).toHaveBeenCalledTimes(1);
    const [entry] = (logger.log as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { level: string; message: string; payload: Record<string, unknown> },
    ];
    expect(entry.level).toBe('error');
    expect(entry.message).toContain('the divergence still stands');
    expect(entry.payload.error).toBe('telegram 502');
    expect(entry.payload.reason).toBe(ALERT.reason);
  });
});
