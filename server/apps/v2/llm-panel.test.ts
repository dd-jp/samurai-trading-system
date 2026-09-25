import { describe, expect, it } from 'vitest';
import {
  type LlmSpendRecord,
  runBullPersona,
  UNCAPPED_SPEND,
} from '../../pipeline/debate-engine/index.js';
import { buildLlmPanel, rotateSeats } from './llm-panel.js';
import { ScriptedTransport } from './scripted-transport.js';

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

  it('is deterministic for a date and rejects a bad one', () => {
    expect(rotateSeats('2026-09-25')).toEqual(rotateSeats('2026-09-25'));
    expect(() => rotateSeats('not-a-date')).toThrow(/bad trading date/);
  });
});

describe('buildLlmPanel', () => {
  it('builds one client per pin, journals spend under the priced id and calls the pinned wire id', async () => {
    const transports = new Map<string, ScriptedTransport>();
    const records: LlmSpendRecord[] = [];
    const panel = buildLlmPanel({
      transportFor: (pin) => {
        const transport = new ScriptedTransport(pin);
        transports.set(pin.wire, transport);
        return transport;
      },
      spendSink: { record: (entry) => records.push(entry) },
      spendCap: UNCAPPED_SPEND,
    });
    expect(Object.keys(panel.debaters).sort()).toEqual(['deepseek', 'gpt', 'sonnet']);
    expect(panel.pins.map((pin) => pin.wire)).toEqual([
      'claude-sonnet-5',
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-pro-0813',
      'claude-opus-5',
    ]);

    const response = await runBullPersona(panel.debaters.gpt, {
      trace_id: 'trace',
      analyst_views: [],
    });
    expect(response.stance).toBe('neutral');
    expect(transports.get('openai/gpt-5.5')?.calls[0]?.model).toBe('openai/gpt-5.5');
    expect(records[0]?.model).toBe('openai/gpt-5.5');
    expect(records[0]?.stage).toBe('debate');
  });
});
