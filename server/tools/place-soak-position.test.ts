import { describe, expect, it, vi } from 'vitest';
import {
  latestTradePrice,
  opened,
  probeOrder,
  refuseOrWarnWhenClosed,
  refuseWhenHeld,
} from './place-soak-position.js';

const ENV = { ALPACA_API_KEY: 'test-key', ALPACA_API_SECRET: 'test-secret' };

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe('latestTradePrice', () => {
  it('reads the latest trade price with the paper key pair', async () => {
    const fetchFn = fetchReturning({ trade: { p: 512.34 } });
    expect(await latestTradePrice('SPY', ENV, fetchFn)).toBe(512.34);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://data.alpaca.markets/v2/stocks/SPY/trades/latest');
    expect(init.headers).toEqual({
      'APCA-API-KEY-ID': 'test-key',
      'APCA-API-SECRET-KEY': 'test-secret',
    });
  });

  it('refuses without both credentials', async () => {
    await expect(
      latestTradePrice('SPY', { ALPACA_API_KEY: 'k' }, fetchReturning({})),
    ).rejects.toThrow('ALPACA_API_KEY / ALPACA_API_SECRET must be set');
  });

  it('refuses a failed lookup', async () => {
    await expect(latestTradePrice('SPY', ENV, fetchReturning('nope', 500))).rejects.toThrow(
      'latest trade lookup failed: 500',
    );
  });

  it.each([[{}], [{ trade: { p: 0 } }], [{ trade: { p: '1' } }]])(
    'refuses a body with no usable price: %j',
    async (body) => {
      await expect(latestTradePrice('SPY', ENV, fetchReturning(body))).rejects.toThrow(
        'latest trade lookup returned no usable price',
      );
    },
  );
});

describe('refuseOrWarnWhenClosed', () => {
  const now = new Date('2026-10-01T20:00:00Z');

  it('does nothing while the session is open', () => {
    const log = vi.fn();
    refuseOrWarnWhenClosed(true, now, true, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('warns and continues on a closed session in a dry run', () => {
    const log = vi.fn();
    refuseOrWarnWhenClosed(false, now, false, log);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^WARNING \(dry run continues\): US equities are closed at 2026-10-01T20:00:00.000Z/,
      ),
    );
  });

  it('refuses a confirmed placement on a closed session', () => {
    expect(() => refuseOrWarnWhenClosed(false, now, true, vi.fn())).toThrow(
      'US equities are closed at 2026-10-01T20:00:00.000Z',
    );
  });
});

describe('probeOrder', () => {
  it('prices a one-share SPY bracket around the last trade, keyed by the UTC date', () => {
    const now = new Date('2026-10-01T13:45:00Z');
    const { idempotencyKey, entry, stop, target, intent } = probeOrder(now, 500);

    expect(idempotencyKey).toBe('soak-lifecycle-probe-2026-10-01');
    expect({ entry, stop, target }).toEqual({ entry: 500.5, stop: 475, target: 525 });
    expect(intent).toMatchObject({
      idempotency_key: idempotencyKey,
      instrument: 'SPY',
      side: 'buy',
      intent_type: 'entry',
      size: 1,
      entry: 500.5,
      stop: 475,
      target: 525,
      time_in_force: 'day',
      decision_timestamp: now,
      metadata: { debate_id: idempotencyKey },
    });
  });

  it('rounds each leg to cents', () => {
    const { entry, stop, target } = probeOrder(new Date(0), 123.456);
    expect({ entry, stop, target }).toEqual({ entry: 123.58, stop: 117.28, target: 129.63 });
  });
});

describe('refuseWhenHeld', () => {
  it('allows a placement when nothing is held', () => {
    expect(() => refuseWhenHeld([])).not.toThrow();
  });

  it('names every held lot', () => {
    expect(() => refuseWhenHeld([{ idempotency_key: 'a' }, { idempotency_key: 'b' }])).toThrow(
      'refusing to place: 2 open lot(s) already held for SPY (a, b)',
    );
  });
});

describe('opened', () => {
  it.each([
    ['submitted', true],
    ['deduped', true],
    ['rejected', false],
  ])('%s -> %s', (status, expected) => {
    expect(opened(status)).toBe(expected);
  });
});
