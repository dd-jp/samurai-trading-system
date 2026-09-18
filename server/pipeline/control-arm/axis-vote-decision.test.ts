import type { AnalystView } from '../debate-engine/index.js';
import {
  AXIS_VOTE_ANALYST_TYPE,
  CONTROL_DEBATE_ID_PREFIX,
  controlArmDecision,
} from './axis-vote-decision.js';

const BAR = new Date('2026-09-01T09:00:00.000Z');

function view(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'technical-1',
    analyst_type: AXIS_VOTE_ANALYST_TYPE,
    direction: 'bullish',
    confidence: 0.72,
    key_points: ['trend up', 'momentum up'],
    timestamp: BAR,
    ...overrides,
  };
}

describe('controlArmDecision (#753 — falsifier arm 2 entry)', () => {
  it.each([
    { direction: 'bullish' as const, confidence: 0.81 },
    { direction: 'bearish' as const, confidence: 0.66 },
    { direction: 'neutral' as const, confidence: 0.2 },
  ])('passes the axis vote through unmodified ($direction)', ({ direction, confidence }) => {
    const decision = controlArmDecision({
      instrument: '3LUS',
      views: [view({ direction, confidence })],
      bar: BAR,
    });

    expect(decision?.direction).toBe(direction);
    expect(decision?.confidence).toBe(confidence);
    expect(decision?.bar_timestamp).toEqual(BAR);
  });

  it('is subclass-independent — the bracket split happens downstream, from the shared table', () => {
    const views = [view({ direction: 'bearish', confidence: 0.6 })];

    const indexEtp = controlArmDecision({ instrument: '3LUS', views, bar: BAR });
    const singleStock = controlArmDecision({ instrument: '3LTS', views, bar: BAR });

    expect(indexEtp?.direction).toBe(singleStock?.direction);
    expect(indexEtp?.confidence).toBe(singleStock?.confidence);
    expect(indexEtp?.converged).toBe(singleStock?.converged);
  });

  it('is a pure function — the same input yields a byte-identical result', () => {
    const views = [view()];
    const first = controlArmDecision({ instrument: '3LUS', views, bar: BAR });
    const second = controlArmDecision({ instrument: '3LUS', views: [...views], bar: BAR });

    expect(second).toEqual(first);
    expect(second?.debate_id).toBe(first?.debate_id);
  });

  it('decides from the axis vote alone — other analysts cannot move it', () => {
    const axis = view({ direction: 'bullish', confidence: 0.7 });
    const alone = controlArmDecision({ instrument: '3LUS', views: [axis], bar: BAR });
    const crowded = controlArmDecision({
      instrument: '3LUS',
      views: [
        view({ analyst_type: 'sentiment', direction: 'bearish', confidence: 0.99 }),
        axis,
        view({ analyst_type: 'fundamental', direction: 'bearish', confidence: 0.95 }),
      ],
      bar: BAR,
    });

    expect(crowded?.direction).toBe('bullish');
    expect(crowded?.confidence).toBe(0.7);
    expect(crowded?.debate_id).toBe(alone?.debate_id);
  });

  it('declines rather than substituting when the axis vote is absent', () => {
    expect(controlArmDecision({ instrument: '3LUS', views: [], bar: BAR })).toBeNull();
    expect(
      controlArmDecision({
        instrument: '3LUS',
        views: [view({ analyst_type: 'sentiment', direction: 'bullish', confidence: 0.9 })],
        bar: BAR,
      }),
    ).toBeNull();
  });

  it('reports a unanimous, zero-round, zero-latency decision with no contributions', () => {
    const decision = controlArmDecision({ instrument: '3LUS', views: [view()], bar: BAR });

    expect(decision?.converged).toBe(true);
    expect(decision?.rounds_completed).toBe(0);
    expect(decision?.latency_ms).toBe(0);
    expect(decision?.contributions).toEqual([]);
    expect(decision?.open_items).toEqual([]);
    expect(decision?.synthesis).toContain('No model was called');
  });

  it('namespaces its decision id so it can never be mistaken for a debate id', () => {
    const decision = controlArmDecision({ instrument: '3LUS', views: [view()], bar: BAR });

    expect(decision?.debate_id.startsWith(CONTROL_DEBATE_ID_PREFIX)).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(decision?.debate_id ?? '')).toBe(false);
  });

  it('gives different bars and different votes different ids', () => {
    const base = controlArmDecision({ instrument: '3LUS', views: [view()], bar: BAR });
    const laterBar = controlArmDecision({
      instrument: '3LUS',
      views: [view()],
      bar: new Date(BAR.getTime() + 3_600_000),
    });
    const otherName = controlArmDecision({ instrument: '3LTS', views: [view()], bar: BAR });
    const otherVote = controlArmDecision({
      instrument: '3LUS',
      views: [view({ direction: 'bearish' })],
      bar: BAR,
    });

    const ids = [base, laterBar, otherName, otherVote].map((decision) => decision?.debate_id);
    expect(new Set(ids).size).toBe(4);
  });

  it('imports no LLM client, debate engine runtime or mediator — types only', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./axis-vote-decision.ts', import.meta.url), 'utf8');

    const importLines = source
      .split('\n')
      .filter((line) => /^import\s/.test(line) || /^\s+from\s+'/.test(line));
    expect(
      importLines.some((line) => line.includes("import { createHash } from 'node:crypto'")),
    ).toBe(true);
    expect(
      importLines.some((line) =>
        line.includes("import type { AnalystView, DebateResult } from '../debate-engine/index.js'"),
      ),
    ).toBe(true);
    expect(importLines).toHaveLength(2);
    expect(/import\s+\{[^}]*\}\s+from\s+'.*llm/i.test(source)).toBe(false);
    expect(source).not.toMatch(/\bawait\b/);
  });
});
