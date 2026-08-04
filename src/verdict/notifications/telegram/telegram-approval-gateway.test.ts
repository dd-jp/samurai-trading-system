import type { RiskDecision } from '../../../risk-manager/index.js';
import type { OrderIntent } from '../../../shared/index.js';
import type { ApprovalRequest } from '../../types.js';
import type { ApprovalCallbackPayload } from '../approval-callback-verifier.js';
import { signApprovalCallback } from '../approval-callback-verifier.js';
import type { ApprovalButtonTarget, ApprovalCallback, TelegramClient } from '../types.js';
import { SignedApprovalChannel } from '../verified-approval-channel.js';
import { TelegramApprovalGateway } from './telegram-approval-gateway.js';

const SECRET = 'test-fake-hmac-secret';
const CHAT_ID = '-100123';

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

function makeRequest(): ApprovalRequest {
  return {
    order_intent: makeIntent(),
    risk_decision: makeRiskDecision(),
    trace_id: 'trace-1',
    timeout_ms: 60_000,
  };
}

const IDEM = 'AAPL-2026-07-15T13:55:00Z';

interface FakeClient extends TelegramClient {
  sent: { chatId: string; text: string; target: ApprovalButtonTarget }[];
  fire: (callback: ApprovalCallback) => void;
}

function makeClient(onSend?: () => Promise<void>): FakeClient {
  const handlers: ((callback: ApprovalCallback) => void)[] = [];
  const sent: { chatId: string; text: string; target: ApprovalButtonTarget }[] = [];
  return {
    sent,
    async sendMessage() {},
    async sendApprovalButtons(chatId, text, target) {
      sent.push({ chatId, text, target });
      if (onSend) await onSend();
    },
    onApprovalCallback(handler) {
      handlers.push(handler);
    },
    fire(callback) {
      for (const handler of handlers) handler(callback);
    },
  };
}

describe('TelegramApprovalGateway construction', () => {
  it('rejects a missing HMAC secret at construction (boot-time validation)', () => {
    const previous = process.env.TELEGRAM_APPROVAL_HMAC_SECRET;
    delete process.env.TELEGRAM_APPROVAL_HMAC_SECRET;
    try {
      expect(() => new TelegramApprovalGateway({ client: makeClient(), chatId: CHAT_ID })).toThrow(
        /TELEGRAM_APPROVAL_HMAC_SECRET/,
      );
    } finally {
      if (previous !== undefined) process.env.TELEGRAM_APPROVAL_HMAC_SECRET = previous;
    }
  });

  it('rejects an empty HMAC secret — an empty key signs and verifies consistently', () => {
    expect(
      () => new TelegramApprovalGateway({ client: makeClient(), chatId: CHAT_ID, secret: '' }),
    ).toThrow(/TELEGRAM_APPROVAL_HMAC_SECRET/);
  });

  it('rejects a whitespace-only HMAC secret', () => {
    expect(
      () => new TelegramApprovalGateway({ client: makeClient(), chatId: CHAT_ID, secret: '   ' }),
    ).toThrow(/TELEGRAM_APPROVAL_HMAC_SECRET/);
  });

  it('registers its inbound handler with the client exactly once', () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'onApprovalCallback');
    new TelegramApprovalGateway({ client, chatId: CHAT_ID, secret: SECRET });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramApprovalGateway.requestApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends inline buttons tagged with the request identity, without blocking', async () => {
    const client = makeClient();
    const gateway = new TelegramApprovalGateway({ client, chatId: CHAT_ID, secret: SECRET });

    const pending = gateway.requestApproval(makeRequest());
    await Promise.resolve();

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.chatId).toBe(CHAT_ID);
    expect(client.sent[0]?.text).toContain('Approval requested');
    expect(client.sent[0]?.target).toEqual({
      trace_id: 'trace-1',
      idempotency_key: IDEM,
      timeout_ms: 60_000,
    });

    vi.advanceTimersByTime(60_000);
    await expect(pending).resolves.toBe('timeout');
  });

  it('resolves the pending approval when a matching callback arrives', async () => {
    const client = makeClient();
    const gateway = new TelegramApprovalGateway({ client, chatId: CHAT_ID, secret: SECRET });

    const pending = gateway.requestApproval(makeRequest());
    await Promise.resolve();
    client.fire({ trace_id: 'trace-1', idempotency_key: IDEM, outcome: 'approved' });

    await expect(pending).resolves.toBe('approved');
  });

  it('resolves rejected the same way', async () => {
    const client = makeClient();
    const gateway = new TelegramApprovalGateway({ client, chatId: CHAT_ID, secret: SECRET });

    const pending = gateway.requestApproval(makeRequest());
    await Promise.resolve();
    client.fire({ trace_id: 'trace-1', idempotency_key: IDEM, outcome: 'rejected' });

    await expect(pending).resolves.toBe('rejected');
  });

  it('hands SignedApprovalChannel.handleCallback a locally-signed payload', async () => {
    const client = makeClient();
    const seen: { payload: ApprovalCallbackPayload; secret: string }[] = [];
    const gateway = new TelegramApprovalGateway({
      client,
      chatId: CHAT_ID,
      secret: SECRET,
      createChannel: (sender) => {
        const channel = new SignedApprovalChannel(sender);
        const original = channel.handleCallback.bind(channel);
        channel.handleCallback = (payload, secret) => {
          seen.push({ payload, secret });
          original(payload, secret);
        };
        return channel;
      },
    });

    const pending = gateway.requestApproval(makeRequest());
    await Promise.resolve();
    client.fire({ trace_id: 'trace-1', idempotency_key: IDEM, outcome: 'approved' });
    await expect(pending).resolves.toBe('approved');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.secret).toBe(SECRET);
    expect(seen[0]?.payload).toEqual({
      trace_id: 'trace-1',
      idempotency_key: IDEM,
      outcome: 'approved',
      signature: signApprovalCallback(
        { trace_id: 'trace-1', idempotency_key: IDEM, outcome: 'approved' },
        SECRET,
      ),
    });
  });

  it('a callback for an unknown request is a no-op — the pending request still times out', async () => {
    const client = makeClient();
    const gateway = new TelegramApprovalGateway({ client, chatId: CHAT_ID, secret: SECRET });

    const pending = gateway.requestApproval(makeRequest());
    await Promise.resolve();
    client.fire({ trace_id: 'other-trace', idempotency_key: IDEM, outcome: 'approved' });

    vi.advanceTimersByTime(60_000);
    await expect(pending).resolves.toBe('timeout');
  });

  it('a failed send falls through to the timeout fail-safe rather than crashing', async () => {
    const client = makeClient(async () => {
      throw new Error('telegram down');
    });
    const gateway = new TelegramApprovalGateway({ client, chatId: CHAT_ID, secret: SECRET });

    const pending = gateway.requestApproval(makeRequest());
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);

    await expect(pending).resolves.toBe('timeout');
  });
});
