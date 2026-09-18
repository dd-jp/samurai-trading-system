import { describe, expect, it } from 'vitest';
import { createLedger, LEDGER_CAP, updateLedger } from './ledger.ts';
import { at, doneThrough, makeLane, makeView } from './test-support.ts';

describe('updateLedger — first-paint seeding', () => {
  it('seeds from currently-settled lanes, stamped with their last non-null recorded_at', () => {
    const next = makeView([
      doneThrough('BTC-USD', 'go-1', 'execution', { startMs: 0, outcome: 'go' }),
      makeLane({
        instrument: 'ETH-USD',
        trace_id: 'stop-1',
        outcome: 'stopped',
        final_stage: 'risk',
        cells: {
          analysts: { state: 'done', recorded_at: at(10_000) },
          debate: { state: 'done', recorded_at: at(11_000) },
          trader: { state: 'done', recorded_at: at(12_000) },
          risk: { state: 'stopped', recorded_at: at(13_000) },
        },
        started_at: at(9_000),
      }),
    ]);
    const state = updateLedger(createLedger(), next);
    expect(state.entries.map((e) => e.trace_id)).toEqual(['stop-1', 'go-1']);
    expect(state.entries[0]).toMatchObject({
      instrument: 'ETH-USD',
      outcome: 'stopped',
      final_stage: 'risk',
      settled_at: at(13_000),
    });
    expect(state.entries[1]?.settled_at).toBe(at(6_000));
  });

  it('does not seed in-flight or idle lanes', () => {
    const next = makeView([
      doneThrough('BTC-USD', 'run-1', 'debate', { outcome: 'in_flight' }),
      makeLane({ instrument: 'SPY', outcome: 'idle' }),
    ]);
    expect(updateLedger(createLedger(), next).entries).toEqual([]);
  });
});

describe('updateLedger — settles while watching', () => {
  it('appends a lane that settled, newest first', () => {
    const prev = makeView([doneThrough('BTC-USD', 'go-1', 'execution', { outcome: 'go' })]);
    const seeded = updateLedger(createLedger(), prev);
    const next = makeView([
      doneThrough('BTC-USD', 'go-1', 'execution', { outcome: 'go' }),
      doneThrough('ETH-USD', 'ng-1', 'verdict', { startMs: 50_000, outcome: 'no_go' }),
    ]);
    const state = updateLedger(seeded, next);
    expect(state.entries.map((e) => e.trace_id)).toEqual(['ng-1', 'go-1']);
    expect(state.entries[0]?.outcome).toBe('no_go');
  });

  it('ledgers every settled outcome, including the ones that never reach Verdict', () => {
    const next = makeView([
      doneThrough('A', 't-go', 'execution', { startMs: 0, outcome: 'go' }),
      doneThrough('B', 't-nogo', 'verdict', { startMs: 10_000, outcome: 'no_go' }),
      makeLane({
        instrument: 'C',
        trace_id: 't-stop',
        outcome: 'stopped',
        final_stage: 'risk',
        cells: { risk: { state: 'stopped', recorded_at: at(20_000) } },
      }),
      makeLane({
        instrument: 'D',
        trace_id: 't-skip',
        outcome: 'quorum_skip',
        final_stage: 'analysts',
        cells: { analysts: { state: 'stopped', recorded_at: at(30_000) } },
      }),
    ]);
    const state = updateLedger(createLedger(), next);
    expect(state.entries.map((e) => e.outcome)).toEqual(['quorum_skip', 'stopped', 'no_go', 'go']);
  });
});

describe('updateLedger — dedupe', () => {
  it('never re-adds a trace on a re-poll of an unchanged lane', () => {
    const view = makeView([doneThrough('BTC-USD', 'go-1', 'execution', { outcome: 'go' })]);
    let state = updateLedger(createLedger(), view);
    state = updateLedger(state, view);
    state = updateLedger(state, view);
    expect(state.entries).toHaveLength(1);
  });

  it('dedupes against ALL seen traces, even ones the cap evicted', () => {
    let state = updateLedger(
      createLedger(),
      makeView([doneThrough('BTC-USD', 'old-trace', 'execution', { outcome: 'go' })]),
    );
    for (let i = 0; i < LEDGER_CAP; i++) {
      state = updateLedger(
        state,
        makeView([
          doneThrough('ETH-USD', `t-${i}`, 'verdict', { startMs: i * 1_000, outcome: 'no_go' }),
        ]),
      );
    }
    expect(state.entries.some((e) => e.trace_id === 'old-trace')).toBe(false);
    const again = updateLedger(
      state,
      makeView([doneThrough('BTC-USD', 'old-trace', 'execution', { outcome: 'go' })]),
    );
    expect(again.entries.some((e) => e.trace_id === 'old-trace')).toBe(false);
    expect(again.entries).toHaveLength(LEDGER_CAP);
  });
});

describe('updateLedger — cap and ordering', () => {
  it('caps entries at 30, evicting the oldest', () => {
    let state = createLedger();
    for (let i = 0; i < LEDGER_CAP + 5; i++) {
      state = updateLedger(
        state,
        makeView([
          doneThrough('BTC-USD', `t-${i}`, 'verdict', { startMs: i * 1_000, outcome: 'no_go' }),
        ]),
      );
    }
    expect(state.entries).toHaveLength(LEDGER_CAP);
    expect(state.entries[0]?.trace_id).toBe(`t-${LEDGER_CAP + 4}`);
    expect(state.entries.at(-1)?.trace_id).toBe('t-5');
  });

  it('keeps valid entries newest-first when a malformed recorded_at is mixed in', () => {
    const next = makeView([
      doneThrough('A', 't-a', 'verdict', { startMs: 10_000, outcome: 'no_go' }),
      makeLane({
        instrument: 'BAD-1',
        trace_id: 't-bad-1',
        outcome: 'stopped',
        final_stage: 'risk',
        cells: { risk: { state: 'stopped', recorded_at: 'not a timestamp' } },
      }),
      doneThrough('B', 't-b', 'verdict', { startMs: 30_000, outcome: 'no_go' }),
      makeLane({
        instrument: 'BAD-2',
        trace_id: 't-bad-2',
        outcome: 'stopped',
        final_stage: 'risk',
        cells: { risk: { state: 'stopped', recorded_at: '2026-13-45T99:99:99Z' } },
      }),
      doneThrough('C', 't-c', 'verdict', { startMs: 20_000, outcome: 'no_go' }),
    ]);
    const state = updateLedger(createLedger(), next);
    expect(state.entries.map((e) => e.trace_id)).toEqual([
      't-b',
      't-c',
      't-a',
      't-bad-1',
      't-bad-2',
    ]);
  });

  it('orders a same-poll seed batch newest-settled first', () => {
    const next = makeView([
      doneThrough('A', 't-a', 'verdict', { startMs: 30_000, outcome: 'no_go' }),
      doneThrough('B', 't-b', 'verdict', { startMs: 10_000, outcome: 'no_go' }),
      doneThrough('C', 't-c', 'verdict', { startMs: 20_000, outcome: 'no_go' }),
    ]);
    const state = updateLedger(createLedger(), next);
    expect(state.entries.map((e) => e.trace_id)).toEqual(['t-a', 't-c', 't-b']);
  });
});
