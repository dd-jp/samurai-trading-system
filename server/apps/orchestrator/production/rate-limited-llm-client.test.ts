import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  RateLimiter,
} from '../../../pipeline/debate-engine/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { RateLimitedLlmClient } from './rate-limited-llm-client.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');

function request(signal?: AbortSignal): LlmRequest<string> {
  return {
    prompt: 'p',
    context: { analyst_views: [] },
    parseResponse: (raw) => ({ valid: true, data: raw }),
    signal,
  };
}

function stubClient(): LlmClient & { calls: number } {
  const client = {
    calls: 0,
    async complete<T>(input: LlmRequest<T>): Promise<LlmResponse<T>> {
      client.calls += 1;
      const parsed = input.parseResponse('ok');
      if (!parsed.valid) throw new Error('unreachable');
      return { data: parsed.data, raw_text: 'ok', latency_ms: 1 };
    },
  };
  return client;
}

function limiter(
  overrides: Partial<{ maxLlmCalls: number; maxDebates: number }> = {},
): RateLimiter {
  return new RateLimiter(new SimulatedClock(NOW), {
    default: { windowMs: 60_000, maxLlmCalls: 100, maxDebates: 10, ...overrides },
  });
}

describe('RateLimitedLlmClient', () => {
  it('passes the call through and meters it against the debate budget', async () => {
    const inner = stubClient();
    const rateLimiter = limiter();
    const recordCall = vi.spyOn(rateLimiter, 'recordCall');

    const response = await new RateLimitedLlmClient(inner, rateLimiter, 'crypto').complete(
      request(),
    );

    expect(response.data).toBe('ok');
    expect(inner.calls).toBe(1);
    expect(recordCall).toHaveBeenCalledWith('crypto');
  });

  it('meters against the asset class it was built for, not a fixed one', async () => {
    const rateLimiter = limiter();
    const recordCall = vi.spyOn(rateLimiter, 'recordCall');

    await new RateLimitedLlmClient(stubClient(), rateLimiter, 'stocks').complete(request());

    expect(recordCall).toHaveBeenCalledWith('stocks');
  });

  it('records the call BEFORE issuing it, so a call that fails still spent budget', async () => {
    const rateLimiter = limiter();
    const order: string[] = [];
    vi.spyOn(rateLimiter, 'recordCall').mockImplementation(() => {
      order.push('recorded');
    });
    const failing: LlmClient = {
      complete() {
        order.push('issued');
        return Promise.reject(new Error('transport blew up'));
      },
    };

    await expect(
      new RateLimitedLlmClient(failing, rateLimiter, 'crypto').complete(request()),
    ).rejects.toThrow('transport blew up');

    // The venue counted the request the moment it went out; a local counter
    // that only credits successes drifts under exactly the failure conditions
    // it exists to protect.
    expect(order).toEqual(['recorded', 'issued']);
  });

  /**
   * The #347/#373 cancellation contract. The decorator adds no wait of its own
   * (see the class doc), so the only way it can create a zombie is by issuing
   * — and billing — a call for a debate that has already been cancelled.
   */
  describe('cancellation', () => {
    it('refuses to issue a call whose signal is already aborted', async () => {
      const inner = stubClient();
      const controller = new AbortController();
      controller.abort(new Error('latency budget exceeded'));

      await expect(
        new RateLimitedLlmClient(inner, limiter(), 'crypto').complete(request(controller.signal)),
      ).rejects.toThrow(/cancelled/i);

      expect(inner.calls).toBe(0);
    });

    it('does not spend budget on a call it refused to issue', async () => {
      const rateLimiter = limiter();
      const recordCall = vi.spyOn(rateLimiter, 'recordCall');
      const controller = new AbortController();
      controller.abort(new Error('latency budget exceeded'));

      await expect(
        new RateLimitedLlmClient(stubClient(), rateLimiter, 'crypto').complete(
          request(controller.signal),
        ),
      ).rejects.toThrow();

      expect(recordCall).not.toHaveBeenCalled();
    });

    it('surfaces the abort reason rather than a bare "aborted"', async () => {
      const controller = new AbortController();
      controller.abort(new Error('debate cancelled: latency budget of 15000ms exceeded'));

      await expect(
        new RateLimitedLlmClient(stubClient(), limiter(), 'crypto').complete(
          request(controller.signal),
        ),
      ).rejects.toThrow(/latency budget of 15000ms/);
    });

    it('passes a live (un-aborted) signal straight through to the inner client', async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const inner: LlmClient = {
        async complete<T>(input: LlmRequest<T>): Promise<LlmResponse<T>> {
          seen = input.signal;
          const parsed = input.parseResponse('ok');
          if (!parsed.valid) throw new Error('unreachable');
          return { data: parsed.data, raw_text: 'ok', latency_ms: 1 };
        },
      };

      await new RateLimitedLlmClient(inner, limiter(), 'crypto').complete(
        request(controller.signal),
      );

      expect(seen).toBe(controller.signal);
    });
  });
});
