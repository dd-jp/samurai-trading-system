import { describe, expect, it } from 'vitest';

import {
  LlmInFlightRefusedError,
  NousApiError,
  NousRefusalError,
  NousTruncatedError,
} from '../../../shared/llm/index.js';
import {
  LlmAdmissionRefusedError,
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmTimeoutError,
  LlmTruncatedError,
} from './errors.js';
import { classifyFailureCause } from './failure-cause.js';

const USAGE = { input_tokens: 10, output_tokens: 20 };

describe('classifyFailureCause (#1394)', () => {
  it('maps the typed LLM hierarchy onto the taxonomy', () => {
    expect(classifyFailureCause(new LlmRefusalError('no', 'stop_reason="refusal"'))).toBe(
      'refusal',
    );
    expect(classifyFailureCause(new LlmTruncatedError('cut', 'model-x', 1024))).toBe('truncated');
    expect(classifyFailureCause(new LlmMalformedResponseError('not JSON'))).toBe('unparseable');
    expect(classifyFailureCause(new LlmTimeoutError('slow'))).toBe('timeout');
    expect(classifyFailureCause(new LlmRateLimitError('429'))).toBe('rate_limited');
    expect(classifyFailureCause(new LlmCancelledError('budget fired'))).toBe('cancelled');
    expect(classifyFailureCause(new LlmProviderError('500'))).toBe('transport');
  });

  it('maps a gate refusal to `gate_refused`, on both reasons and at both layers (#1080)', () => {
    const fields = { queue_depth: 3, in_flight: 1, budget_ms: 28_000, waited_ms: 0 };
    // Both layers, because the gate's own error crosses the MI clients
    // untranslated while `NousMessagesClient` re-wraps it for the debate path —
    // and a refusal is not a `transport` fault at either: nothing was sent
    expect(
      classifyFailureCause(
        new LlmInFlightRefusedError({ ...fields, reason: 'admission', message: 'refused' }),
      ),
    ).toBe('gate_refused');
    expect(
      classifyFailureCause(
        new LlmAdmissionRefusedError({ ...fields, reason: 'admission', message: 'refused' }),
      ),
    ).toBe('gate_refused');
    expect(
      classifyFailureCause(
        new LlmAdmissionRefusedError({ ...fields, reason: 'queue_deadline', message: 'dropped' }),
      ),
    ).toBe('gate_refused');
  });

  it('maps the Nous wire hierarchy, which never reaches the typed classes on the MI path', () => {
    expect(classifyFailureCause(new NousRefusalError('model-x', 'refusal_in_body', USAGE))).toBe(
      'refusal',
    );
    expect(classifyFailureCause(new NousTruncatedError('model-x', 512, USAGE))).toBe('truncated');
    expect(classifyFailureCause(new NousApiError(429, 'rate limited'))).toBe('rate_limited');
    expect(classifyFailureCause(new NousApiError(408, 'request timeout'))).toBe('timeout');
    expect(classifyFailureCause(new NousApiError(504, 'gateway timeout'))).toBe('timeout');
    expect(classifyFailureCause(new NousApiError(500, 'server error'))).toBe('transport');
  });

  it('duck-types an unclassified HTTP-shaped rejection on its status, as `classifyProviderError` does', () => {
    expect(classifyFailureCause({ status: 429 })).toBe('rate_limited');
    expect(classifyFailureCause({ status: 408 })).toBe('timeout');
    expect(classifyFailureCause({ status: 504 })).toBe('timeout');
    expect(classifyFailureCause({ status: 401 })).toBe('transport');
  });

  it('reads a DOMException-shaped abort as a cancellation, not as a fault', () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    expect(classifyFailureCause(aborted)).toBe('cancelled');

    const timedOut = new Error('The operation was aborted due to timeout');
    timedOut.name = 'TimeoutError';
    expect(classifyFailureCause(timedOut)).toBe('timeout');
  });

  it('refuses to guess: anything else is `other`, never a counterfeit transport fault', () => {
    expect(classifyFailureCause(new Error('alpaca down and polygon down too'))).toBe('other');
    expect(classifyFailureCause('a thrown string')).toBe('other');
    expect(classifyFailureCause(undefined)).toBe('other');
    expect(classifyFailureCause({ status: 'not a number' })).toBe('other');
  });

  it('never throws on a hostile rejection value', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter');
        },
      },
    );
    expect(classifyFailureCause(hostile)).toBe('other');
  });
});
