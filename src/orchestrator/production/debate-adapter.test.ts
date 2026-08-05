import type { AnalystView, LlmClient, LlmRequest } from '../../debate-engine/index.js';
import {
  computeDebateId,
  InMemoryDebateLogStore,
  SqliteDebateLogStore,
} from '../../debate-engine/index.js';
import { accumulateCredit } from '../../feedback-loop/index.js';
import type { Clock, ClosedTrade, LogEntry, Logger } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { buildDebateStep } from './debate-adapter.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['price above the 50d'],
    timestamp: NOW,
    ...overrides,
  };
}

interface FakeLlmOptions {
  /** false → the mediator never converges, so the debate runs to the 3-round hard cap. */
  converged?: boolean;
  /** Throws from the mediator call, standing in for a debate that fails partway. */
  failOnMediator?: boolean;
}

/** Routes by prompt content — mirrors what personas.ts's four prompt shapes actually say. */
function fakeLlmClient(options: FakeLlmOptions = {}): LlmClient {
  const { converged = true, failOnMediator = false } = options;
  return {
    async complete<T>(request: LlmRequest<T>) {
      let raw: string;
      if (request.prompt.includes('Bull persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
      } else if (request.prompt.includes('Bear persona')) {
        raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
      } else if (request.prompt.includes('Mediator persona')) {
        if (failOnMediator) {
          throw new Error('llm transport blew up mid-debate');
        }
        raw = JSON.stringify({ stance: 'bullish', rationale: 'bull case wins', converged });
      } else {
        raw = JSON.stringify({ summary: 'no material disagreement', conflicts: [] });
      }
      const parsed = request.parseResponse(raw);
      if (!parsed.valid) {
        throw new Error(`fakeLlmClient: parseResponse rejected fixture: ${parsed.reason}`);
      }
      return { data: parsed.data, raw_text: raw, latency_ms: 1 };
    },
  };
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('buildDebateStep', () => {
  it('presents the one-argument TickSteps.debate shape and returns a converged DebateResult', async () => {
    const step = buildDebateStep(fakeLlmClient(), new InMemoryDebateLogStore());
    const views = [makeView()];

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      clock: CLOCK,
    });

    expect(result.converged).toBe(true);
    expect(result.direction).toBe('bullish');
    expect(result.rounds_completed).toBe(1);
    expect(result.contributions).toHaveLength(1);
    // position is the one field this adapter derives rather than sources
    // from an existing computation (see debate-adapter.ts doc comment) —
    // assert it's populated, not a specific fabricated value.
    expect(result.position.length).toBeGreaterThan(0);
  });

  it('writes exactly one debate_log row for a completed debate (#364)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      clock: CLOCK,
    });

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM debate_log WHERE debate_id = ?')
      .get(result.debate_id) as { n: number };
    expect(count.n).toBe(1);

    const row = store.getByDebateId(result.debate_id);
    expect(row).toBeDefined();
    expect(row?.instrument).toBe('AAPL');
    // The row's bar_timestamp must be the SAME bar that went into
    // debate_id's hash — otherwise the row claims a coordinate the id
    // does not encode.
    expect(row?.bar_timestamp.toISOString()).toBe(NOW.toISOString());
    expect(row?.direction).toBe('bullish');
    expect(row?.rounds).toBe(result.rounds_completed);
    expect(row?.contributions).toEqual(result.contributions);
  });

  it('writes a row for a debate that resolves WITHOUT converging (hard-cap termination)', async () => {
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(fakeLlmClient({ converged: false }), store);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
      clock: CLOCK,
    });

    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(3);
    // A halted debate is at least as interesting as a converged one: the row
    // is written on the same path, no convergence branch.
    expect(store.getByDebateId(result.debate_id)?.rounds).toBe(3);
  });

  it('writes NO row when the debate throws partway, and logs the miss', async () => {
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(fakeLlmClient({ failOnMediator: true }), store, logger);
    const views = [makeView()];

    await expect(
      step({ trace_id: 'trace-1', instrument: 'AAPL', views, clock: CLOCK }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    // debate_id is recomputable from (instrument, bar, views) even though the
    // debate produced no result — assert nothing was written under it, so the
    // eventual successful re-run can still claim the write-once key.
    expect(store.getByDebateId(computeDebateId('AAPL', NOW, views))).toBeUndefined();

    const missed = entries.find((entry) => entry.stage === 'debate' && entry.level === 'error');
    expect(missed).toBeDefined();
    expect(missed?.message).toContain('no debate_log row');
  });

  it('does not double-write when the same tick re-runs (same instrument, bar and views)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(fakeLlmClient(), store, logger);
    const input = { trace_id: 'trace-1', instrument: 'AAPL', views: [makeView()], clock: CLOCK };

    const first = await step(input);
    // Same clock, same views, same instrument → the same content-hash
    // debate_id, which is exactly what a retried tick produces.
    const second = await step({ ...input, trace_id: 'trace-1-retry' });
    expect(second.debate_id).toBe(first.debate_id);

    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);

    const duplicate = entries.find((entry) => entry.message.includes('already has a debate_log'));
    expect(duplicate).toBeDefined();
    expect(duplicate?.level).toBe('warn');
  });

  it("produces rows the Feedback Loop's attribution reader can consume end to end", async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      clock: CLOCK,
    });

    const trade: ClosedTrade = {
      idempotency_key: 'AAPL-2026-07-28T14',
      debate_id: result.debate_id,
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      entry: 100,
      stop: 95,
      filled_size: 10,
      realized_pnl_net: 100,
      fees_total: 1,
      opened_at: NOW,
      closed_at: new Date('2026-07-29T14:00:00Z'),
      close_reason: 'target',
    };

    const credits = accumulateCredit([trade], store, {
      shadow_credit: 0.1,
      shadow_influence_ceiling: 0.2,
    });

    // Before #364 this map was empty for every trade in the soak: no row, so
    // `getContributionsForAttribution` returned undefined and the trade was
    // skipped outright.
    const credit = credits.get('technical-1');
    expect(credit).toBeDefined();
    expect(credit?.trade_count).toBe(1);
    expect(credit?.total_credit).toBeGreaterThan(0);
  });
});
