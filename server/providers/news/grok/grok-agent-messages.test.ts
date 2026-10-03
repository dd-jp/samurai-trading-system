import { describe, expect, it } from 'vitest';
import { refreshFailureMessage, retrievalEvidenceAbsentMessage } from './grok-agent.js';

describe('retrievalEvidenceAbsentMessage', () => {
  it('names the discarded count when items were dropped', () => {
    expect(retrievalEvidenceAbsentMessage('AAPL', 2)).toBe(
      'grok: discarding 2 item(s) for AAPL — the response parsed cleanly but carried no evidence ' +
        'of retrieval (no citations, no tool step), so it cannot be told apart from model recall. ' +
        'Reporting NO DATA instead of risking confabulated sentiment as signal. See #485.',
    );
  });

  it('reports could-not-look when nothing came back', () => {
    expect(retrievalEvidenceAbsentMessage('AAPL', 0)).toBe(
      'grok: no retrieval evidence for AAPL this call (no citations, no tool step) — reporting ' +
        'NO DATA. "Could not look" rather than "looked and saw nothing". See #485.',
    );
  });
});

describe('refreshFailureMessage', () => {
  it('calls an unrouted model a configuration fault', () => {
    expect(refreshFailureMessage('AAPL', 'search tools are not available', true)).toMatch(
      /^grok: RETRIEVAL IS DARK for AAPL — .*\(search tools are not available\)\. This is a configuration fault/,
    );
  });

  it('reports any other failure as retryable', () => {
    expect(refreshFailureMessage('AAPL', 'timeout', false)).toBe(
      'grok: sentiment refresh failed for AAPL — timeout. The analysts will report NO DATA for ' +
        'this window; the bucket is NOT marked, so the next pass retries.',
    );
  });
});
