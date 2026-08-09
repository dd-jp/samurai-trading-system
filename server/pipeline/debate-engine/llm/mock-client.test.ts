import { LlmMalformedResponseError, LlmTimeoutError } from './errors.js';
import { MockLlmClient } from './mock-client.js';
import type { LlmRequest } from './types.js';

interface ParsedData {
  value: string;
}

function request(): LlmRequest<ParsedData> {
  return {
    prompt: 'analyze this',
    context: { analyst_views: [] },
    parseResponse: (rawText) =>
      rawText === 'good'
        ? { valid: true, data: { value: rawText } }
        : { valid: false, reason: 'not "good"' },
  };
}

describe('MockLlmClient', () => {
  it('returns a queued text response run through parseResponse', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText('good');

    const result = await mock.complete(request());

    expect(result.data).toEqual({ value: 'good' });
    expect(result.raw_text).toBe('good');
  });

  it('throws a queued error', async () => {
    const mock = new MockLlmClient();
    const error = new LlmTimeoutError('boom');
    mock.enqueueError(error);

    await expect(mock.complete(request())).rejects.toBe(error);
  });

  it('raises LlmMalformedResponseError when the queued text fails parseResponse', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText('garbage');

    await expect(mock.complete(request())).rejects.toBeInstanceOf(LlmMalformedResponseError);
  });

  it('serves queued responses in order across multiple calls', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText('good');
    mock.enqueueError(new LlmTimeoutError('second call times out'));

    await expect(mock.complete(request())).resolves.toEqual(
      expect.objectContaining({ data: { value: 'good' } }),
    );
    await expect(mock.complete(request())).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('records every request it received', async () => {
    const mock = new MockLlmClient();
    mock.enqueueText('good');
    const req = request();

    await mock.complete(req);

    expect(mock.requests).toEqual([req]);
  });

  it('throws when complete is called with nothing queued', async () => {
    const mock = new MockLlmClient();

    await expect(mock.complete(request())).rejects.toThrow(/no queued response/);
  });
});
