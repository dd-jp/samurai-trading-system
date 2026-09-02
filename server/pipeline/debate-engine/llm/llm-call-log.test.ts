/**
 * `llm_call_log` — the prompt and response capture (#1035).
 *
 * Against a real (`:memory:`) SQLite instance, like `spend-sink.test.ts`,
 * because the properties worth pinning are the ones an in-memory fake would
 * assume away: that the row actually lands, that a text write failing does not
 * take the spend row with it, and that capture is genuinely off when it is
 * off. That last one is this repo's dominant defect shape in reverse — a
 * mechanism nothing calls — so "on by default at the composition root" is
 * tested where the default is decided, in `production.ts`'s wiring, and the
 * seam's own default (`false`) is tested here.
 */
import { openSharedStore, type SharedStore } from '../../../shared/store/index.js';
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

function callRows(db: SharedStore): CallRow[] {
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
    // The constructor default. Every test double and backtest construction of
    // this class gets this, so turning capture on is a deployment decision
    // taken once at the composition root and nowhere else.
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

    // The join that makes the text and the numbers one record.
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
    // A truncated capture must never read as a short prompt.
    expect(row?.prompt?.length).toBeLessThan(huge.length);
  });

  it('writes no row when the record carries no text at all', () => {
    // A caller that meters but has nothing to capture (a client that does not
    // supply the strings) leaves no empty rows behind.
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
    // Timing comes from the call's own measurement, not a second clock read
    // here, so the line cannot disagree with the row beside it.
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

  it('never fails the caller when the text write throws', () => {
    // The module's standing rule, extended to the capture: bookkeeping
    // attached to an already-billed call must not turn a real answer into an
    // error. The spend row is written first and survives.
    const db = openSharedStore(':memory:');
    db.prepare('DROP TABLE llm_call_log').run();
    const lines: LogEntry[] = [];

    expect(() =>
      new SqliteLlmSpendStore(db, { log: (entry) => lines.push(entry) }, true).record(ENTRY),
    ).not.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 1 });
    expect(lines.some((entry) => entry.level === 'warn')).toBe(true);
  });
});
