import { describe, expect, it, vi } from 'vitest';
import type { RiskDecision } from '../../risk-manager/types.js';
import type { OrderIntent } from '../../shared/types.js';
import type { ApprovalRequest, VerdictDecision } from '../types.js';
import { TelegramChannel } from './telegram-channel.js';
import type { TelegramClient } from './types.js';

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

function makeDecision(overrides: Partial<VerdictDecision> = {}): VerdictDecision {
  return {
    status: 'go',
    order: makeIntent(),
    no_go_reason: null,
    approval_path: 'human',
    would_require_approval: true,
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    timestamp: new Date('2026-07-15T14:00:00Z'),
    ...overrides,
  };
}

function makeClient(overrides: Partial<TelegramClient> = {}): TelegramClient {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendApprovalRequest: vi.fn().mockResolvedValue('approved'),
    ...overrides,
  };
}

describe('TelegramChannel.notify', () => {
  it('posts the formatted decision message to the configured chat', async () => {
    const client = makeClient();
    const channel = new TelegramChannel(client, 'chat-123');

    await channel.notify(makeDecision(), makeRiskDecision(), 'trace-1');

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(chatId).toBe('chat-123');
    expect(text).toContain('Verdict: GO');
  });
});

describe('TelegramChannel.requestApproval', () => {
  it('round-trips a request through the client and returns its outcome', async () => {
    const client = makeClient({ sendApprovalRequest: vi.fn().mockResolvedValue('rejected') });
    const channel = new TelegramChannel(client, 'chat-123');
    const request: ApprovalRequest = {
      order_intent: makeIntent(),
      risk_decision: makeRiskDecision(),
      trace_id: 'trace-1',
      timeout_ms: 300_000,
    };

    const outcome = await channel.requestApproval(request);

    expect(outcome).toBe('rejected');
    expect(client.sendApprovalRequest).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('Approval requested'),
      300_000,
    );
  });
});
