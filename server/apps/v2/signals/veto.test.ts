import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../../contracts/index.js';
import {
  MockLlmClient,
  type SpendCap,
  UNCAPPED_SPEND,
} from '../../../pipeline/debate-engine/index.js';
import {
  parseVetoReply,
  SIGNAL_VETO_BARS,
  SIGNAL_VETO_PROMPT,
  type SignalVetoInput,
  signalVeto,
  vetoContext,
} from './veto.js';

function bar(day: number, close = 50): V2Bar {
  return {
    date: `2026-09-${String(day).padStart(2, '0')}`,
    open: close / 2,
    high: (close + 1) / 2,
    low: (close - 1) / 2,
    close: close / 2,
    volume: 1_000_000,
    rawClose: close,
  };
}

const INPUT: SignalVetoInput = {
  symbol: 'INTC',
  entryLow: 49,
  entryHigh: 50,
  limit: 50,
  stop: 48,
  target: 56,
  targets: [52, 56],
  lastClose: 50.2,
  bars: Array.from({ length: 25 }, (_, index) => bar(index + 1)),
};

const CAPPED: SpendCap = {
  check: () => ({ admitted: false, spent_usd: 30, budget_usd: 30, kind: 'budget' }),
};

describe('vetoContext', () => {
  it('carries the signal and the last 20 raw-priced bars, and no account data', () => {
    const context = vetoContext(INPUT);
    expect(Object.keys(context).sort()).toEqual(['daily_bars', 'signal']);
    expect(Object.keys(context.signal as object).sort()).toEqual([
      'bracket_target',
      'entry_high',
      'entry_low',
      'last_close',
      'limit',
      'side',
      'stop',
      'symbol',
      'targets',
    ]);
    const bars = context.daily_bars as Record<string, unknown>[];
    expect(bars).toHaveLength(SIGNAL_VETO_BARS);
    expect(bars[0]).toEqual({
      date: '2026-09-06',
      open: 50,
      high: 51,
      low: 49,
      close: 50,
      volume: 1_000_000,
    });
    const text = JSON.stringify(context).toLowerCase();
    for (const word of ['size', 'equity', 'cash', 'book', 'position', 'account', 'gbp']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('parseVetoReply', () => {
  it('reads a veto and its reason, inside prose or fences', () => {
    expect(parseVetoReply('```json\n{"veto": true, "reason": " stop inside noise "}\n```')).toEqual({
      valid: true,
      data: { veto: true, reason: 'stop inside noise' },
    });
  });

  it('caps the reason at 500 characters', () => {
    const parsed = parseVetoReply(JSON.stringify({ veto: false, reason: 'x'.repeat(600) }));
    expect(parsed.valid && parsed.data.reason.length).toBe(500);
  });

  it.each([
    ['no object here', 'no JSON object'],
    ['} before {', 'no JSON object'],
    ['{not json}', 'malformed JSON'],
    ['{"veto": "yes", "reason": "r"}', 'veto is not a boolean'],
    ['{"veto": false}', 'reason is not a non-empty string'],
    ['{"veto": false, "reason": "  "}', 'reason is not a non-empty string'],
    ['null {} null', 'veto is not a boolean'],
  ])('refuses %s', (raw, reason) => {
    expect(parseVetoReply(raw)).toEqual({ valid: false, reason });
  });
});

describe('signalVeto', () => {
  it('asks the judge with the veto prompt and the signal as untrusted data', async () => {
    const judge = new MockLlmClient();
    judge.enqueueText('{"veto": false, "reason": "trend supports a long"}');
    const verdict = await signalVeto(judge, UNCAPPED_SPEND, INPUT, 'trace-1');
    expect(verdict).toEqual({ kind: 'pass', reason: 'trend supports a long' });
    const [request] = judge.requests;
    expect(request?.prompt).toBe(SIGNAL_VETO_PROMPT);
    expect(request?.context).toEqual({
      analyst_views: [],
      debate_state: vetoContext(INPUT),
      attribution: { trace_id: 'trace-1', stage: 'v2_signal_veto' },
    });
  });

  it('returns a veto', async () => {
    const judge = new MockLlmClient();
    judge.enqueueText('{"veto": true, "reason": "stop inside noise"}');
    expect(await signalVeto(judge, UNCAPPED_SPEND, INPUT, 't')).toEqual({
      kind: 'veto',
      reason: 'stop inside noise',
    });
  });

  it('is unavailable without calling the judge when the spend cap refuses', async () => {
    const judge = new MockLlmClient();
    expect(await signalVeto(judge, CAPPED, INPUT, 't')).toEqual({
      kind: 'unavailable',
      reason: 'llm_spend_cap:budget',
    });
    expect(judge.requests).toHaveLength(0);
  });

  it('is unavailable when the call fails', async () => {
    const judge = new MockLlmClient();
    judge.enqueueError(new Error('timeout'));
    expect(await signalVeto(judge, UNCAPPED_SPEND, INPUT, 't')).toEqual({
      kind: 'unavailable',
      reason: 'llm_call_failed: timeout',
    });
  });
});
