import { describe, expect, it, vi } from 'vitest';
import type { RiskDecision } from '../../risk-manager/types.js';
import type { OrderIntent } from '../../shared/types.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  ApprovalRequest,
  VerdictDecision,
} from '../types.js';
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

type TelegramLike = TradeChannelNotifier & ApprovalChannel;

function makeTelegram(outcome: ApprovalOutcome = 'approved'): TelegramLike {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    requestApproval: vi.fn().mockResolvedValue(outcome),
  };
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

describe('TradeChannel.requestApproval', () => {
  it('delegates the HITL round-trip to Telegram', async () => {
    const telegram = makeTelegram('rejected');
    const channel = new TradeChannel(telegram, makeDiscord());
    const request: ApprovalRequest = {
      order_intent: makeIntent(),
      risk_decision: makeRiskDecision(),
      trace_id: 'trace-1',
      timeout_ms: 300_000,
    };

    const outcome = await channel.requestApproval(request);

    expect(outcome).toBe('rejected');
    expect(telegram.requestApproval).toHaveBeenCalledWith(request);
  });
});
