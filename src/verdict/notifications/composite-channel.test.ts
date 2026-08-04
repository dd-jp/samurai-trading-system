import type { RiskDecision } from '../../risk-manager/index.js';
import type { OrderIntent } from '../../shared/index.js';
import type { VerdictDecision } from '../types.js';
import { TradeChannel } from './composite-channel.js';
import type { TradeChannelNotifier } from './types.js';

function makeIntent(): OrderIntent {
  return {
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T13:55:00Z'),
    metadata: {
      debate_id: 'debate-abc123',
      conviction: 0.72,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1.2,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 5, weighted_mean_r: 0.4, no_precedent: false },
    },
  };
}

function makeRiskDecision(): RiskDecision {
  return {
    status: 'approved',
    order_intent: makeIntent(),
    modifications: null,
    binding_constraint: null,
    reasons: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
  };
}

function makeDecision(): VerdictDecision {
  return {
    status: 'go',
    order: makeIntent(),
    no_go_reason: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    timestamp: new Date('2026-07-15T14:00:00Z'),
  };
}

function makeTelegram(): TradeChannelNotifier {
  return { notify: vi.fn().mockResolvedValue(undefined) };
}

function makeDiscord(): TradeChannelNotifier {
  return { notify: vi.fn().mockResolvedValue(undefined) };
}

describe('TradeChannel.notify', () => {
  it('fans out a single notify call to both Telegram and Discord', async () => {
    const telegram = makeTelegram();
    const discord = makeDiscord();
    const channel = new TradeChannel(telegram, discord);

    await channel.notify(makeDecision(), makeRiskDecision(), 'trace-1');

    expect(telegram.notify).toHaveBeenCalledTimes(1);
    expect(discord.notify).toHaveBeenCalledTimes(1);
  });

  it('works with no Discord channel configured', async () => {
    const telegram = makeTelegram();
    const channel = new TradeChannel(telegram);

    await expect(
      channel.notify(makeDecision(), makeRiskDecision(), 'trace-1'),
    ).resolves.toBeUndefined();
    expect(telegram.notify).toHaveBeenCalledTimes(1);
  });
});

// `TradeChannel.requestApproval` was retired in #275 — see the class doc comment.
// The live HITL gate is covered by telegram/telegram-approval-gateway.test.ts.
