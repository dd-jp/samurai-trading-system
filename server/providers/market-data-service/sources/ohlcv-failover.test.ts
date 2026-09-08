import type { Bar, BarWindow } from '../index.js';
import { type FailoverEvent, withOhlcvFailover } from './ohlcv-failover.js';

const ASOF = new Date('2026-08-07T12:00:00Z');
const WINDOW: BarWindow = { timeframe: '1h', lookback: 20 };

function bar(source: string): Bar {
  return {
    instrument: 'SPY',
    timeframe: '1h',
    open_time: new Date('2026-08-07T11:00:00Z'),
    close_time: new Date('2026-08-07T12:00:00Z'),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    source,
  };
}

describe('withOhlcvFailover', () => {
  it('calls only the primary when it succeeds, never touching the fallback', async () => {
    const primary = vi.fn().mockResolvedValue([bar('alpaca')]);
    const fallback = vi.fn().mockResolvedValue([bar('polygon')]);
    const alert = vi.fn();

    const fetcher = withOhlcvFailover({
      leg: 'equities',
      primary,
      primaryName: 'alpaca',
      fallback,
      fallbackName: 'polygon',
      alert,
    });

    const bars = await fetcher('SPY', WINDOW, ASOF);

    expect(bars).toEqual([bar('alpaca')]);
    expect(fallback).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('falls back and alerts when the primary throws', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('Alpaca 403: SIP data window'));
    const fallback = vi.fn().mockResolvedValue([bar('polygon')]);
    const alert = vi.fn();

    const fetcher = withOhlcvFailover({
      leg: 'equities',
      primary,
      primaryName: 'alpaca',
      fallback,
      fallbackName: 'polygon',
      alert,
    });

    const bars = await fetcher('SPY', WINDOW, ASOF);

    expect(bars).toEqual([bar('polygon')]);
    expect(fallback).toHaveBeenCalledWith('SPY', WINDOW, ASOF);
    expect(alert).toHaveBeenCalledTimes(1);
    const event = alert.mock.calls[0]?.[0] as FailoverEvent;
    expect(event).toMatchObject({
      leg: 'equities',
      symbol: 'SPY',
      timeframe: '1h',
      primaryName: 'alpaca',
      fallbackName: 'polygon',
      primaryError: expect.stringContaining('403') as unknown,
    });
  });

  // #1351: `primaryMessage` is rendered at the TOP of the catch, before both
  // `safeAlert` and the fallback attempt — an unguarded throw here defeats
  // the failover this function exists to perform (no alert, no fallback
  // bars) and nothing downstream catches it.
  it('an unrenderable primary error still alerts and still falls back', async () => {
    // Circular (defeats `JSON.stringify`) with a throwing `Symbol.toPrimitive`
    // (defeats the `String()` fallback too) — same shape as the #1262
    // tick-loop hostile value.
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;
    const primary = vi.fn().mockRejectedValue(hostile);
    const fallback = vi.fn().mockResolvedValue([bar('polygon')]);
    const alert = vi.fn();

    const fetcher = withOhlcvFailover({
      leg: 'equities',
      primary,
      primaryName: 'alpaca',
      fallback,
      fallbackName: 'polygon',
      alert,
    });

    // The durable artifact: the fallback's bars, not a rejected promise.
    const bars = await fetcher('SPY', WINDOW, ASOF);

    expect(bars).toEqual([bar('polygon')]);
    expect(alert).toHaveBeenCalledTimes(1);
    const event = alert.mock.calls[0]?.[0] as FailoverEvent;
    expect(event.primaryError).toBe('[unrenderable error]');
  });

  it('alerts BEFORE attempting the fallback, not after', async () => {
    const order: string[] = [];
    const primary = vi.fn().mockImplementation(async () => {
      order.push('primary');
      throw new Error('boom');
    });
    const fallback = vi.fn().mockImplementation(async () => {
      order.push('fallback');
      return [bar('polygon')];
    });
    const alert = vi.fn().mockImplementation(() => order.push('alert'));

    await withOhlcvFailover({
      leg: 'crypto',
      primary,
      primaryName: 'coinbase',
      fallback,
      fallbackName: 'bitstamp',
      alert,
    })('BTC-USD', WINDOW, ASOF);

    expect(order).toEqual(['primary', 'alert', 'fallback']);
  });

  it('throws a combined error naming both sources when both primary and fallback fail, preserving the fallback error as cause', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('coinbase: network error'));
    const fallbackError = new Error('bitstamp: HTTP 503');
    const fallback = vi.fn().mockRejectedValue(fallbackError);
    const alert = vi.fn();

    const fetcher = withOhlcvFailover({
      leg: 'crypto',
      primary,
      primaryName: 'coinbase',
      fallback,
      fallbackName: 'bitstamp',
      alert,
    });

    let thrown: unknown;
    try {
      await fetcher('BTC-USD', WINDOW, ASOF);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toContain('coinbase');
    expect(error.message).toContain('bitstamp');
    expect(error.message).toContain('network error');
    expect(error.cause).toBe(fallbackError);
    // The alert still fired even though the whole call ultimately failed —
    // the operator learns about the primary's stall regardless of whether
    // the fallback could rescue it.
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("a throwing alerter cannot mask the fallback's result — the guard swallows it and the fetch still succeeds", async () => {
    const primary = vi.fn().mockRejectedValue(new Error('stalled'));
    const fallback = vi.fn().mockResolvedValue([bar('polygon')]);
    const alert = vi.fn().mockImplementation(() => {
      throw new Error('alert channel EPIPE');
    });

    const bars = await withOhlcvFailover({
      leg: 'equities',
      primary,
      primaryName: 'alpaca',
      fallback,
      fallbackName: 'polygon',
      alert,
    })('SPY', WINDOW, ASOF);

    expect(bars).toEqual([bar('polygon')]);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('a throwing alerter does not mask the combined error when the fallback ALSO fails', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('stalled'));
    const fallback = vi.fn().mockRejectedValue(new Error('also down'));
    const alert = vi.fn().mockImplementation(() => {
      throw new Error('alert channel EPIPE');
    });

    await expect(
      withOhlcvFailover({
        leg: 'equities',
        primary,
        primaryName: 'alpaca',
        fallback,
        fallbackName: 'polygon',
        alert,
      })('SPY', WINDOW, ASOF),
    ).rejects.toThrow(/alpaca.*polygon/);
  });
});
