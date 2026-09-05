import type { OrderIntent } from '../../../shared/index.js';
import type { RiskDecision } from '../../risk-manager/index.js';
import type { VerdictDecision } from '../types.js';
import { DiscordChannel } from './discord-channel.js';
import type { DiscordClient } from './types.js';

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
    warnings: [],
    next_breaker_state: [],
  };
}

function makeDecision(overrides: Partial<VerdictDecision> = {}): VerdictDecision {
  return {
    status: 'no_go',
    order: null,
    no_go_reason: 'staleness',
    no_go_detail: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    timestamp: new Date('2026-07-15T14:00:00Z'),
    ...overrides,
  };
}

describe('DiscordChannel.notify', () => {
  it('posts the formatted decision message to the configured channel', async () => {
    const client: DiscordClient = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const channel = new DiscordChannel(client, 'channel-456');

    await channel.notify(makeDecision(), makeRiskDecision());

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      'channel-456',
      expect.stringContaining('NO-GO (staleness)'),
    );
  });
});
