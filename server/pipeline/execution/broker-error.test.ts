import { BrokerError, sanitizeBrokerError } from './broker-error.js';

/** A credential the wrapper must never carry forward, in any field. */
const SECRET = 'PKTEST_APIKEY_9f2c';

describe('sanitizeBrokerError', () => {
  it('builds the message from the curated fields alone', () => {
    const error = sanitizeBrokerError('alpaca', 'submitBracket', {
      status: 429,
      code: 'throttled',
    });

    expect(error).toBeInstanceOf(BrokerError);
    expect(error.message).toBe('alpaca submitBracket failed (status 429, code throttled)');
    expect(error.venue).toBe('alpaca');
    expect(error.operation).toBe('submitBracket');
    expect(error.statusCode).toBe(429);
    expect(error.venueCode).toBe('throttled');
  });

  it('never carries any part of the original message', () => {
    const raw = new Error(
      `401 Unauthorized: GET https://api.example/v2/orders — headers: {"APCA-API-KEY-ID":"${SECRET}"}`,
    );

    const error = sanitizeBrokerError('alpaca', 'getOrder', raw);

    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('api.example');
    expect(error.message).not.toContain('Unauthorized');
    expect(error.message).toBe('alpaca getOrder failed (status unknown)');
  });

  it('retains no reference to the original error anywhere on the wrapper', () => {
    // The whole point of the boundary: a curated message with the raw error
    // still hanging off `cause` leaks the moment anything serializes the error.
    const raw = Object.assign(new Error(`boom ${SECRET}`), { status: 500, apiKey: SECRET });

    const error = sanitizeBrokerError('ccxt', 'createOrder', raw);

    expect('cause' in error).toBe(false);
    expect(Object.values(error)).not.toContain(raw);
    expect(JSON.stringify({ ...error, message: error.message, stack: '' })).not.toContain(SECRET);
  });

  it.each([
    ['status', { status: 503 }],
    ['statusCode', { statusCode: 503 }],
    ['response.status', { response: { status: 503 } }],
  ])('duck-types the status code off %s', (_shape, cause) => {
    expect(sanitizeBrokerError('ccxt', 'fetchOrder', cause).statusCode).toBe(503);
  });

  it('stringifies a numeric venue code', () => {
    expect(sanitizeBrokerError('ibkr', 'fetchNewFills', { code: 1100 }).venueCode).toBe('1100');
  });

  it.each([
    ['a bare string', 'connection reset'],
    ['null', null],
    ['undefined', undefined],
    ['an error with no HTTP context', new Error('socket hang up')],
    ['a non-finite status', { status: Number.NaN }],
    ['an empty code', { code: '' }],
  ])('degrades to unknown when %s is thrown', (_shape, cause) => {
    const error = sanitizeBrokerError('ibkr', 'submitBracket', cause);

    expect(error.statusCode).toBeUndefined();
    expect(error.venueCode).toBeUndefined();
    expect(error.venueMessage).toBeUndefined();
    expect(error.message).toBe('ibkr submitBracket failed (status unknown)');
  });
});

// #1003: `sanitizeBrokerError` used to discard the venue's own diagnostic
// text entirely, leaving `ExecutionResult.reason` (and the durable log line
// it becomes) as just "alpaca submitBracket failed (status 422)" — no
// indication of WHY. This block covers the curated `venueMessage` field that
// closes that gap while keeping the module's credential-safety boundary
// intact: only a dedicated, allowlisted property is ever read, never the
// client's own `.message`.
describe('sanitizeBrokerError venueMessage (#1003)', () => {
  it('captures a venue diagnostic message exposed on the dedicated venueMessage property', () => {
    const error = sanitizeBrokerError('alpaca', 'submitBracket', {
      status: 422,
      code: 42210000,
      venueMessage:
        'invalid take_profit.limit_price 746.96416125. sub-penny increment does not fulfill ' +
        'minimum pricing criteria',
    });

    expect(error.venueMessage).toBe(
      'invalid take_profit.limit_price 746.96416125. sub-penny increment does not fulfill ' +
        'minimum pricing criteria',
    );
    expect(error.message).toBe(
      'alpaca submitBracket failed (status 422, code 42210000): invalid take_profit.limit_price ' +
        '746.96416125. sub-penny increment does not fulfill minimum pricing criteria',
    );
  });

  it('is present even when no venue code was exposed', () => {
    const error = sanitizeBrokerError('alpaca', 'submitBracket', {
      status: 422,
      venueMessage: 'symbol is not shortable',
    });

    expect(error.venueCode).toBeUndefined();
    expect(error.venueMessage).toBe('symbol is not shortable');
    expect(error.message).toBe('alpaca submitBracket failed (status 422): symbol is not shortable');
  });

  it("never reads the cause's own .message as a venueMessage — that is the exact credential-leak vector this module guards against", () => {
    const raw = Object.assign(new Error(`boom ${SECRET}`), { status: 500 });

    const error = sanitizeBrokerError('ccxt', 'createOrder', raw);

    expect(error.venueMessage).toBeUndefined();
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('boom');
  });

  it('degrades a non-string venueMessage to undefined', () => {
    const error = sanitizeBrokerError('alpaca', 'submitBracket', {
      status: 422,
      venueMessage: { nested: 'not a string' },
    });

    expect(error.venueMessage).toBeUndefined();
  });

  it('degrades an empty venueMessage to undefined', () => {
    const error = sanitizeBrokerError('alpaca', 'submitBracket', { status: 422, venueMessage: '' });

    expect(error.venueMessage).toBeUndefined();
  });

  it('truncates an oversized venueMessage as defense-in-depth, independent of the upstream bound', () => {
    const oversized = 'x'.repeat(1000);
    const error = sanitizeBrokerError('alpaca', 'submitBracket', {
      status: 422,
      venueMessage: oversized,
    });

    expect(error.venueMessage).toContain('truncated, 1000 chars total');
    expect(error.venueMessage?.length).toBeLessThan(1000);
  });
});
