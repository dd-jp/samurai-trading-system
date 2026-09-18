import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import type { LogEntry } from '../../../shared/types.js';
import { SqliteLlmSpendStore } from './spend-sink.js';

const NOW = new Date('2026-09-02T12:00:00Z');

interface CallRow {
  id: number;
  spend_id: number | null;
  trace_id: string;
  stage: string;
  debate_id: string | null;
  model: string;
  prompt: string | null;
  response: string | null;
  timestamp: string;
}

function callRows(db: StoreHandle): CallRow[] {
  return db.prepare('SELECT * FROM llm_call_log ORDER BY id').all() as CallRow[];
}

const ENTRY = {
  trace_id: 'trace-1',
  stage: 'debate',
  debate_id: 'debate-1',
  model: 'anthropic/claude-haiku-4.5',
  usage: { input_tokens: 1_700, output_tokens: 260 },
  latency_ms: 3_200,
  timestamp: NOW,
  prompt: 'You are a bearish analyst. Instrument: SPY.',
  response: '{"direction":"bearish","confidence":0.61}',
};

describe('llm_call_log capture', () => {
  it('does not capture unless the seam is switched on', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record(ENTRY);

    expect(callRows(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 1 });
  });

  it('records the prompt and response, joined to the spend row', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db, undefined, true).record(ENTRY);

    const [row] = callRows(db);
    expect(row?.prompt).toBe(ENTRY.prompt);
    expect(row?.response).toBe(ENTRY.response);
    expect(row?.trace_id).toBe('trace-1');
    expect(row?.stage).toBe('debate');
    expect(row?.debate_id).toBe('debate-1');
    expect(row?.model).toBe('anthropic/claude-haiku-4.5');

    const spendId = (db.prepare('SELECT id FROM llm_spend').get() as { id: number }).id;
    expect(row?.spend_id).toBe(spendId);
  });

  it('masks a credential that reached the prompt through ingested text', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db, undefined, true).record({
      ...ENTRY,
      prompt: 'Headline: our key is Authorization: Bearer sk-ant-leaked-in-a-news-body',
    });

    const [row] = callRows(db);
    expect(row?.prompt).not.toContain('sk-ant-leaked-in-a-news-body');
    expect(row?.prompt).toContain('[REDACTED]');
  });

  it('caps an oversized prompt with a suffix that says so', () => {
    const db = openSharedStore(':memory:');
    const huge = 'x'.repeat(20_000);
    new SqliteLlmSpendStore(db, undefined, true).record({ ...ENTRY, prompt: huge });

    const [row] = callRows(db);
    expect(row?.prompt).toContain('(truncated, 20000 chars total)');
    expect(row?.prompt?.length).toBeLessThan(huge.length);
  });

  it('writes no row when the record carries no text at all', () => {
    const db = openSharedStore(':memory:');
    const { prompt: _p, response: _r, ...noText } = ENTRY;
    new SqliteLlmSpendStore(db, undefined, true).record(noText);

    expect(callRows(db)).toEqual([]);
  });

  it('emits one log line carrying every element of the call', () => {
    const db = openSharedStore(':memory:');
    const lines: LogEntry[] = [];
    new SqliteLlmSpendStore(db, { log: (entry) => lines.push(entry) }, true).record(ENTRY);

    const line = lines.find((entry) => entry.message.startsWith('llm call:'));
    expect(line?.stage).toBe('debate');
    expect(line?.trace_id).toBe('trace-1');
    expect(line?.started_at).toBe(NOW.toISOString());
    expect(line?.duration_ms).toBe(3_200);

    const payload = line?.payload as Record<string, unknown>;
    expect(payload.model).toBe('anthropic/claude-haiku-4.5');
    expect(payload.input_tokens).toBe(1_700);
    expect(payload.output_tokens).toBe(260);
    expect(payload.latency_ms).toBe(3_200);
    expect(payload.debate_id).toBe('debate-1');
    expect(typeof payload.cost_usd).toBe('number');
    expect(payload.prompt).toBe(ENTRY.prompt);
    expect(payload.response).toBe(ENTRY.response);
  });

  it('never fails the caller when the text write throws, and says which half failed', () => {
    const db = openSharedStore(':memory:');
    db.prepare('DROP TABLE llm_call_log').run();
    const lines: LogEntry[] = [];

    expect(() =>
      new SqliteLlmSpendStore(db, { log: (entry) => lines.push(entry) }, true).record(ENTRY),
    ).not.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 1 });
    const warnings = lines.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('llm call text capture failed');
    expect(warnings[0]).not.toContain('missing from the dashboard spend total');
  });
});
