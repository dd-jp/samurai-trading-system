import { SimulatedClock } from '../shared/index.js';
import type {
  DebateInput,
  DebaterPersona,
  MediatorAssessment,
  MediatorPersona,
  MediatorSynthesis,
  RoundContext,
} from './round-orchestrator.js';
import { MAX_ROUNDS, runDebate } from './round-orchestrator.js';
import type { AnalystView, Direction } from './types.js';

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'a1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['Volume confirms breakout.'],
    timestamp: new Date('2026-07-14T09:00:00Z'),
    ...overrides,
  };
}

function makeSynthesis(overrides: Partial<MediatorSynthesis> = {}): MediatorSynthesis {
  return {
    synthesis: 'Net bullish with residual momentum risk.',
    position: 'Enter a small long.',
    confidence: 0.7,
    direction: 'bullish',
    disagreement_summary: 'Bull and bear disagree on volume durability.',
    open_items: [],
    ...overrides,
  };
}

/** A bull/bear stub that records the order it was called in and echoes a fixed argument. */
function stubDebater(persona: 'bull' | 'bear', calls: string[]): DebaterPersona {
  return {
    argue: vi.fn(async (context: RoundContext) => {
      calls.push(`${persona}:${context.round}`);
      return { persona, round: context.round, argument: `${persona} argument` };
    }),
  };
}

/**
 * A mediator whose convergence verdict per round is scripted. `convergeOn`
 * lists rounds it should signal convergence on; any other round returns
 * converged=false.
 */
function stubMediator(
  convergeOn: number[],
  calls: string[],
  synthesisOverrides: Partial<MediatorSynthesis> = {},
): MediatorPersona {
  return {
    assess: vi.fn(async (context: RoundContext): Promise<MediatorAssessment> => {
      calls.push(`mediator:${context.round}`);
      const converged = convergeOn.includes(context.round);
      const stances: { analyst_id: string; stance: Direction }[] = context.views.map((v) => ({
        analyst_id: v.analyst_id,
        stance: v.direction,
      }));
      return {
        converged,
        stances,
        synthesis: makeSynthesis({
          open_items: converged ? [] : ['Volume durability unresolved.'],
          ...synthesisOverrides,
        }),
      };
    }),
  };
}

function makeInput(views: AnalystView[] = [makeView()]): DebateInput {
  return { views, instrument: 'BTC-USD', bar: new Date('2026-07-14T09:00:00Z') };
}

describe('runDebate', () => {
  it('runs personas in bull -> bear -> mediator order each round', async () => {
    const calls: string[] = [];
    await runDebate(makeInput(), {
      bull: stubDebater('bull', calls),
      bear: stubDebater('bear', calls),
      mediator: stubMediator([1], calls),
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    expect(calls).toEqual(['bull:1', 'bear:1', 'mediator:1']);
  });

  it('terminates early when the mediator signals convergence in round 1', async () => {
    const calls: string[] = [];
    const result = await runDebate(makeInput(), {
      bull: stubDebater('bull', calls),
      bear: stubDebater('bear', calls),
      mediator: stubMediator([1], calls),
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    expect(result.converged).toBe(true);
    expect(result.rounds_completed).toBe(1);
    expect(result.open_items).toEqual([]);
    // Exactly one round's worth of persona calls.
    expect(calls).toEqual(['bull:1', 'bear:1', 'mediator:1']);
  });

  it('checks the mediator convergence signal after every round', async () => {
    const calls: string[] = [];
    const mediator = stubMediator([2], calls);

    const result = await runDebate(makeInput(), {
      bull: stubDebater('bull', calls),
      bear: stubDebater('bear', calls),
      mediator,
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    expect(mediator.assess).toHaveBeenCalledTimes(2);
    expect(result.rounds_completed).toBe(2);
    expect(result.converged).toBe(true);
  });

  it('enforces the 3-round hard cap and reports converged=false with non-empty open_items', async () => {
    const calls: string[] = [];
    const result = await runDebate(makeInput(), {
      bull: stubDebater('bull', calls),
      bear: stubDebater('bear', calls),
      mediator: stubMediator([], calls), // never converges
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    expect(result.rounds_completed).toBe(MAX_ROUNDS);
    expect(result.converged).toBe(false);
    expect(result.open_items.length).toBeGreaterThan(0);
    expect(calls).toEqual([
      'bull:1',
      'bear:1',
      'mediator:1',
      'bull:2',
      'bear:2',
      'mediator:2',
      'bull:3',
      'bear:3',
      'mediator:3',
    ]);
  });

  describe('maxRounds option (#581)', () => {
    it('caps a non-converging debate at maxRounds=1 with converged=false and non-empty open_items', async () => {
      const calls: string[] = [];
      const result = await runDebate(
        makeInput(),
        {
          bull: stubDebater('bull', calls),
          bear: stubDebater('bear', calls),
          mediator: stubMediator([], calls), // never converges
          clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
        },
        { maxRounds: 1 },
      );

      expect(result.rounds_completed).toBe(1);
      expect(result.converged).toBe(false);
      expect(result.open_items.length).toBeGreaterThan(0);
      expect(calls).toEqual(['bull:1', 'bear:1', 'mediator:1']);
    });

    it('defaults to MAX_ROUNDS when maxRounds is undefined', async () => {
      const calls: string[] = [];
      const result = await runDebate(
        makeInput(),
        {
          bull: stubDebater('bull', calls),
          bear: stubDebater('bear', calls),
          mediator: stubMediator([], calls),
          clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
        },
        { maxRounds: undefined },
      );

      expect(result.rounds_completed).toBe(MAX_ROUNDS);
    });

    it.each([0, 4, 1.5, Number.NaN])('refuses maxRounds=%s', async (maxRounds) => {
      await expect(
        runDebate(
          makeInput(),
          {
            bull: stubDebater('bull', []),
            bear: stubDebater('bear', []),
            mediator: stubMediator([], []),
            clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
          },
          { maxRounds },
        ),
      ).rejects.toThrow(/maxRounds must be an integer/);
    });
  });

  it('guards the hard-cap invariant when the mediator returns empty open_items', async () => {
    const calls: string[] = [];
    const result = await runDebate(makeInput(), {
      bull: stubDebater('bull', calls),
      bear: stubDebater('bear', calls),
      // Never converges but returns empty open_items — orchestrator must backfill.
      mediator: stubMediator([], calls, { open_items: [] }),
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    expect(result.converged).toBe(false);
    expect(result.open_items).toEqual([result.disagreement_summary]);
  });

  it('assembles the full synthesis into the DebateResult on every termination', async () => {
    const result = await runDebate(makeInput(), {
      bull: stubDebater('bull', []),
      bear: stubDebater('bear', []),
      mediator: stubMediator([1], []),
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    expect(result.synthesis).toBe('Net bullish with residual momentum risk.');
    expect(result.position).toBe('Enter a small long.');
    expect(result.confidence).toBe(0.7);
    expect(result.direction).toBe('bullish');
    expect(result.disagreement_summary).toBe('Bull and bear disagree on volume durability.');
  });

  it('tracks per-round stances into contributions across rounds', async () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', analyst_type: 'fundamental', direction: 'bearish' }),
    ];

    const result = await runDebate(makeInput(views), {
      bull: stubDebater('bull', []),
      bear: stubDebater('bear', []),
      mediator: stubMediator([], []), // 3 rounds
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    expect(result.contributions).toHaveLength(2);
    // Each analyst recorded a stance in all 3 rounds.
    expect(result.contributions[0].stance_during_debate).toHaveLength(MAX_ROUNDS);
    expect(result.contributions[1].stance_during_debate).toHaveLength(MAX_ROUNDS);
  });

  it('measures latency_ms from the injected clock', async () => {
    const clock = new SimulatedClock(new Date('2026-07-14T09:00:00.000Z'));
    // Advance the clock as the mediator "works".
    const mediator: MediatorPersona = {
      assess: vi.fn(async (context: RoundContext) => {
        clock.advanceTo(new Date('2026-07-14T09:00:00.500Z'));
        return {
          converged: true,
          stances: context.views.map((v) => ({ analyst_id: v.analyst_id, stance: v.direction })),
          synthesis: makeSynthesis(),
        };
      }),
    };

    const result = await runDebate(makeInput(), {
      bull: stubDebater('bull', []),
      bear: stubDebater('bear', []),
      mediator,
      clock,
    });

    expect(result.latency_ms).toBe(500);
  });

  it('produces a deterministic debate_id from instrument, bar, and views', async () => {
    const input = makeInput();
    const personas = () => ({
      bull: stubDebater('bull', []),
      bear: stubDebater('bear', []),
      mediator: stubMediator([1], []),
      clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
    });

    const first = await runDebate(input, personas());
    const second = await runDebate(input, personas());

    expect(first.debate_id).toBe(second.debate_id);
  });

  describe('cancellation (#347)', () => {
    it('threads the signal into every round context so personas can cancel their own call', async () => {
      const controller = new AbortController();
      const seen: (AbortSignal | undefined)[] = [];
      const record = (context: RoundContext) => {
        seen.push(context.signal);
      };

      await runDebate(
        makeInput(),
        {
          bull: {
            argue: async (context) => {
              record(context);
              return { persona: 'bull', round: context.round, argument: 'b' };
            },
          },
          bear: {
            argue: async (context) => {
              record(context);
              return { persona: 'bear', round: context.round, argument: 'b' };
            },
          },
          mediator: {
            assess: async (context): Promise<MediatorAssessment> => {
              record(context);
              return { converged: true, stances: [], synthesis: makeSynthesis() };
            },
          },
          clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
        },
        { signal: controller.signal },
      );

      expect(seen).toEqual([controller.signal, controller.signal, controller.signal]);
    });

    it('issues strictly fewer persona calls when the signal aborts mid-debate', async () => {
      const controller = new AbortController();
      const calls: string[] = [];
      const personas = {
        // Bear aborts the debate the moment it is asked — standing in for the
        // latency budget firing while bear's LLM call is in flight.
        bull: stubDebater('bull', calls),
        bear: {
          argue: vi.fn(async (context: RoundContext) => {
            calls.push(`bear:${context.round}`);
            controller.abort();
            return { persona: 'bear' as const, round: context.round, argument: 'bear argument' };
          }),
        },
        mediator: stubMediator([], calls),
        clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
      };

      await expect(
        runDebate(makeInput(), personas, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });

      // Two calls, not the nine an uncancelled 3-round debate would make: the
      // mediator is never asked, and neither are rounds 2 and 3.
      expect(calls).toEqual(['bull:1', 'bear:1']);
      expect(personas.mediator.assess).not.toHaveBeenCalled();
    });

    it('makes no persona call at all when handed an already-aborted signal', async () => {
      const calls: string[] = [];

      await expect(
        runDebate(
          makeInput(),
          {
            bull: stubDebater('bull', calls),
            bear: stubDebater('bear', calls),
            mediator: stubMediator([1], calls),
            clock: new SimulatedClock(new Date('2026-07-14T09:00:00Z')),
          },
          { signal: AbortSignal.abort() },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(calls).toEqual([]);
    });
  });
});
