import { describe, expect, it } from 'vitest';
import type {
  AnthropicMessageRequest,
  AnthropicMessagesClient,
  LlmSpendSink,
} from '../../pipeline/debate-engine/index.js';
import {
  LlmProviderError,
  runBullPersona,
  runMediatorPersona,
  UNCAPPED_SPEND,
} from '../../pipeline/debate-engine/index.js';
import type { LogEntry } from '../../shared/index.js';
import { buildLlmPanel, rotateSeats, seatModels } from './llm-panel.js';
import { DEBATER_MAX_TOKENS, JUDGE_MAX_TOKENS } from './models.js';
import { BULLISH_SCRIPT, ScriptedTransport } from './scripted-transport.js';

describe('rotateSeats', () => {
  it('rotates all three providers through the two seats with one idle per day', () => {
    const days = [
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
    ];
    const rotations = days.map(rotateSeats);
    for (const rotation of rotations) {
      expect(new Set([rotation.bull, rotation.bear, rotation.idle]).size).toBe(3);
    }
    expect(new Set(rotations.map((r) => r.idle)).size).toBe(3);
    expect(new Set(rotations.map((r) => `${r.bull}/${r.bear}`)).size).toBe(6);
  });

  it('idles one seat per three-day block and swaps bull and bear every other block', () => {
    expect(rotateSeats('2026-09-25')).toEqual({ bull: 'deepseek', bear: 'gpt', idle: 'sonnet' });
    expect(rotateSeats('2026-09-28')).toEqual({ bull: 'gpt', bear: 'deepseek', idle: 'sonnet' });
    expect(rotateSeats('2026-09-29')).toEqual({ bull: 'sonnet', bear: 'deepseek', idle: 'gpt' });
    expect(seatModels('2026-09-25')).toEqual([
      'deepseek/deepseek-v4-pro-0813',
      'openai/gpt-5.5',
      'anthropic/claude-opus-5',
    ]);
  });

  it('is deterministic for a date and rejects a bad one', () => {
    expect(rotateSeats('2026-09-25')).toEqual(rotateSeats('2026-09-25'));
    expect(() => rotateSeats('not-a-date')).toThrow(/bad trading date/);
  });
});

describe('buildLlmPanel', () => {
  it('builds one client per pin, journals spend under the priced id and calls the pinned wire id', async () => {
    const transports = new Map<string, ScriptedTransport>();
    const records: Parameters<LlmSpendSink['record']>[0][] = [];
    const panel = buildLlmPanel({
      transportFor: (pin) => {
        const transport = new ScriptedTransport(pin, BULLISH_SCRIPT);
        transports.set(pin.wire, transport);
        return transport;
      },
      spendSink: { record: (entry) => records.push(entry) },
      spendCap: UNCAPPED_SPEND,
    });
    expect(Object.keys(panel.debaters).sort()).toEqual(['deepseek', 'gpt', 'sonnet']);
    expect(panel.pins.map((pin) => pin.wire)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-pro-0813',
      'anthropic/claude-opus-5',
    ]);

    const response = await runBullPersona(panel.debaters.gpt, {
      trace_id: 'trace',
      analyst_views: [],
    });
    expect(response.stance).toBe('bullish');
    expect(transports.get('openai/gpt-5.5')?.calls[0]?.model).toBe('openai/gpt-5.5');
    expect(records[0]?.model).toBe('openai/gpt-5.5');
    expect(records[0]?.stage).toBe('debate');
  });
});

describe('buildLlmPanel failure and limits', () => {
  it('caps tokens per seat and logs a failed call under the pinned wire id', async () => {
    const requests: AnthropicMessageRequest[] = [];
    const logs: LogEntry[] = [];
    let failing = false;
    const transport = (): AnthropicMessagesClient => ({
      createMessage: (request) => {
        requests.push(request);
        if (failing) return Promise.reject(new LlmProviderError('upstream down'));
        return Promise.resolve({
          content: [{ type: 'text', text: BULLISH_SCRIPT(request) }],
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'end_turn',
          model: request.model,
          ttfb_ms: 0,
        });
      },
    });
    const panel = buildLlmPanel({
      transportFor: transport,
      spendSink: { record: () => {} },
      spendCap: UNCAPPED_SPEND,
      logger: { log: (entry) => logs.push(entry) },
    });
    const bull = await runBullPersona(panel.debaters.sonnet, { trace_id: 't', analyst_views: [] });
    await runMediatorPersona(panel.judge, {
      trace_id: 't',
      analyst_views: [],
      bullResponse: bull,
      bearResponse: bull,
    });
    expect(requests.map((request) => [request.model, request.max_tokens])).toEqual([
      ['anthropic/claude-sonnet-5', DEBATER_MAX_TOKENS],
      ['anthropic/claude-opus-5', JUDGE_MAX_TOKENS],
    ]);
    failing = true;
    await expect(
      runBullPersona(panel.debaters.gpt, { trace_id: 't', analyst_views: [] }),
    ).rejects.toBeInstanceOf(LlmProviderError);
    expect(logs.filter((entry) => entry.event === 'v2_llm_call_failed')).toMatchObject([
      {
        level: 'warn',
        trace_id: 't',
        message: expect.stringContaining('openai/gpt-5.5 call failed'),
        payload: { model: 'openai/gpt-5.5' },
      },
    ]);
  });
});
