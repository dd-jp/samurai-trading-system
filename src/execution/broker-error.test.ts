import { describe, expect, it } from 'vitest';
import { describeBrokerError } from './broker-error.js';

describe('describeBrokerError', () => {
  it('keeps a plain transport message readable', () => {
    expect(describeBrokerError(new Error('connection reset'))).toBe('Error: connection reset');
  });

  it('stringifies non-Error throwables', () => {
    expect(describeBrokerError('boom')).toBe('boom');
  });

  it('masks credential-named fields', () => {
    const error = new Error(
      'request failed: APCA-API-KEY-ID: PK123SHORT, APCA-API-SECRET-KEY: sk9, status 403',
    );
    const described = describeBrokerError(error);
    expect(described).not.toContain('PK123SHORT');
    expect(described).not.toContain('sk9');
    expect(described).toContain('[REDACTED]');
  });

  it('masks long key-shaped token blobs even without a field name', () => {
    const secret = 'AbC123dEf456GhI789jKl012MnO345pQr678StU9';
    const described = describeBrokerError(new Error(`kraken rejected nonce for ${secret}`));
    expect(described).not.toContain(secret);
    expect(described).toContain('[REDACTED]');
  });

  it('strips query strings, which can carry signed params', () => {
    const described = describeBrokerError(
      new Error('GET https://api.example.com/v2/orders?apiKey=deadbeef&sig=ffff failed'),
    );
    expect(described).not.toContain('deadbeef');
    expect(described).toContain('?[REDACTED]');
  });

  it('caps the length so a dumped request body cannot flood the audit log', () => {
    const described = describeBrokerError(new Error('x'.repeat(2_000)));
    expect(described.length).toBeLessThanOrEqual(301);
  });
});
