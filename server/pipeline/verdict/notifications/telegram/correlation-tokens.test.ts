import { CorrelationTokenStore } from './correlation-tokens.js';

const TARGET = { trace_id: 'trace-1', idempotency_key: 'idem-1' };

describe('CorrelationTokenStore.mintPair', () => {
  it('mints two distinct 32-hex-char (128-bit) tokens, one per outcome', () => {
    const store = new CorrelationTokenStore();
    const pair = store.mintPair(TARGET, 60_000);

    expect(pair.approved).toMatch(/^[0-9a-f]{32}$/);
    expect(pair.rejected).toMatch(/^[0-9a-f]{32}$/);
    expect(pair.approved).not.toBe(pair.rejected);

    store.clear();
  });

  it('never mints the same token twice across many requests', () => {
    const store = new CorrelationTokenStore();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pair = store.mintPair({ trace_id: `t-${i}`, idempotency_key: `k-${i}` }, 60_000);
      seen.add(pair.approved);
      seen.add(pair.rejected);
    }
    expect(seen.size).toBe(400);
    store.clear();
  });

  it('fits inside the Bot API 64-byte callback_data cap', () => {
    const store = new CorrelationTokenStore();
    const pair = store.mintPair(TARGET, 60_000);
    expect(Buffer.byteLength(pair.approved, 'utf8')).toBeLessThanOrEqual(64);
    store.clear();
  });
});

describe('CorrelationTokenStore.peek', () => {
  it('resolves a token to its request + outcome without consuming it', () => {
    const store = new CorrelationTokenStore();
    const pair = store.mintPair(TARGET, 60_000);

    expect(store.peek(pair.approved)).toEqual({ ...TARGET, outcome: 'approved' });
    expect(store.peek(pair.rejected)).toEqual({ ...TARGET, outcome: 'rejected' });
    // Still live after two peeks.
    expect(store.size).toBe(2);
    expect(store.peek(pair.approved)).toEqual({ ...TARGET, outcome: 'approved' });

    store.clear();
  });

  it('returns undefined for an unknown token', () => {
    const store = new CorrelationTokenStore();
    expect(store.peek('deadbeef'.repeat(4))).toBeUndefined();
  });
});

describe('CorrelationTokenStore.consume', () => {
  it('resolves the pressed button and invalidates its sibling', () => {
    const store = new CorrelationTokenStore();
    const pair = store.mintPair(TARGET, 60_000);

    expect(store.consume(pair.approved)).toEqual({ ...TARGET, outcome: 'approved' });
    expect(store.consume(pair.approved)).toBeUndefined();
    expect(store.consume(pair.rejected)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('is a no-op for an unknown token — a redelivered update resolves nothing twice', () => {
    const store = new CorrelationTokenStore();
    expect(store.consume('0'.repeat(32))).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe('CorrelationTokenStore expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops both tokens on the same timeout_ms as the pending approval', () => {
    const store = new CorrelationTokenStore();
    const pair = store.mintPair(TARGET, 60_000);

    vi.advanceTimersByTime(59_999);
    expect(store.peek(pair.approved)).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(store.peek(pair.approved)).toBeUndefined();
    expect(store.peek(pair.rejected)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('expires each request independently', () => {
    const store = new CorrelationTokenStore();
    const short = store.mintPair(TARGET, 1_000);
    const long = store.mintPair({ trace_id: 'trace-2', idempotency_key: 'idem-2' }, 10_000);

    vi.advanceTimersByTime(1_000);
    expect(store.peek(short.approved)).toBeUndefined();
    expect(store.peek(long.approved)).toBeDefined();

    vi.advanceTimersByTime(9_000);
    expect(store.peek(long.approved)).toBeUndefined();
  });

  it('clear() drops every entry and cancels its pending timers', () => {
    const store = new CorrelationTokenStore();
    const pair = store.mintPair(TARGET, 60_000);
    store.clear();

    expect(store.size).toBe(0);
    expect(store.peek(pair.approved)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
