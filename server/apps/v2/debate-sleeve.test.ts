import { describe, expect, it } from 'vitest';
import { UNCAPPED_SPEND } from '../../pipeline/debate-engine/index.js';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { createDebateSleeve, technicalRead } from './debate-sleeve.js';
import { buildLlmPanel } from './llm-panel.js';
import { addDays } from './macro-calendar.js';
import { STOP_ATR_MULTIPLE } from './position-size.js';
import {
  BULLISH_SCRIPT,
  NEUTRAL_SCRIPT,
  type Script,
  ScriptedTransport,
} from './scripted-transport.js';
import type { BarsSource } from './universe.js';

const clock = new SimulatedClock(new Date('2026-09-25T07:00:00.000Z'));

function trending(symbol: string, days: number, slope: number, start = 100): BarSeries {
  const bars: DailyBar[] = [];
  const origin = Date.UTC(2025, 0, 1);
  for (let i = 0; i < days; i += 1) {
    const close = start * (1 + slope * i);
    bars.push({
      date: new Date(origin + i * 86_400_000).toISOString().slice(0, 10),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: close,
    });
  }
  return { symbol, bars };
}

function source(all: readonly BarSeries[]): BarsSource {
  return { load: (symbol) => all.find((entry) => entry.symbol === symbol) };
}

const nextDate = (series: BarSeries) => addDays(series.bars.at(-1)?.date ?? '', 1);

function panelWith(
  script: Script,
  transports: ScriptedTransport[] = [],
  spendCap = UNCAPPED_SPEND,
) {
  return buildLlmPanel({
    transportFor: (pin) => {
      const transport = new ScriptedTransport(pin, script);
      transports.push(transport);
      return transport;
    },
    spendSink: { record: () => {} },
    spendCap,
  });
}

const bullishScript = BULLISH_SCRIPT;

describe('technicalRead', () => {
  it('reads trend, trailing returns and ATR from daily bars', () => {
    const series = trending('UP', 260, 0.001);
    const read = technicalRead(series.bars, 'trace', clock.now());
    expect(read?.view.direction).toBe('bullish');
    expect(read?.view.analyst_type).toBe('technical');
    expect(read?.atr).toBeGreaterThan(0);
    expect(read?.price).toBe(series.bars.at(-1)?.rawClose);
    expect(read?.view.key_points.join(' ')).toContain('200-day SMA');
    expect(
      technicalRead(trending('DOWN', 260, -0.001).bars, 't', clock.now())?.view.direction,
    ).toBe('bearish');
    expect(technicalRead(trending('SHORT', 30, 0.001).bars, 't', clock.now())?.view.direction).toBe(
      'neutral',
    );
    expect(technicalRead([], 't', clock.now())).toBeUndefined();
  });
});

describe('createDebateSleeve', () => {
  it('debates the liquidity core, enters long on a bullish judge with a 2-ATR stop', async () => {
    const series = trending('UP', 260, 0.001);
    const transports: ScriptedTransport[] = [];
    const sleeve = createDebateSleeve({
      panel: panelWith(bullishScript, transports),
      bars: source([series]),
      constituents: () => ['UP', 'MISSING'],
      venueFor: () => 'alpaca',
      clock,
    });
    const output = await sleeve.decide({
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions).toHaveLength(1);
    const decision = output.decisions[0];
    expect(decision).toMatchObject({
      sleeve_id: 'debate',
      instrument: 'UP',
      venue: 'alpaca',
      direction: 'bullish',
      action: 'enter_long',
      reason: 'judge bullish',
    });
    expect(decision?.stop_price).toBeCloseTo(
      (decision?.price ?? 0) - STOP_ATR_MULTIPLE * (decision?.atr ?? 0),
      9,
    );
    expect(decision?.confidence).toBe(1);
    expect(decision?.inputs_hash).toHaveLength(64);
    expect(decision?.debate_id).toBeDefined();
    const called = transports.flatMap((transport) => transport.calls.map((call) => call.model));
    expect(called).toHaveLength(3);
    expect(called).toContain('claude-opus-5');
    expect(called.join(' ')).not.toContain('fable');
    for (const transport of transports) {
      for (const call of transport.calls) {
        expect(call.prompt).not.toMatch(/api[_-]?key|ALPACA|SAXO|account/i);
      }
    }
    expect(output.refusals.map((refusal) => refusal.parameter)).toEqual([
      'G18_SMALL_CAP_FLOORS',
      'G4_MOVERS_SELECTION_RULE',
    ]);
  });

  it('skips a bearish judge because shorts are off and does nothing on neutral', async () => {
    const series = trending('DOWN', 260, -0.001);
    const bearish: Script = (request) =>
      (request.messages[0]?.content ?? '').includes('Mediator persona')
        ? '{"stance":"bearish","rationale":"down","converged":true}'
        : '{"stance":"bearish","rationale":"down"}';
    const make = (script: Script) =>
      createDebateSleeve({
        panel: panelWith(script),
        bars: source([series]),
        constituents: () => ['DOWN'],
        venueFor: () => 'alpaca',
        clock,
      });
    const context = { tradingDate: nextDate(series), macroDay: false, dryRun: true };
    const short = (await make(bearish).decide(context)).decisions[0];
    expect(short).toMatchObject({
      action: 'skip',
      reason: 'shorts_disabled',
      direction: 'bearish',
    });
    const neutral = (await make(NEUTRAL_SCRIPT).decide(context)).decisions[0];
    expect(neutral).toMatchObject({
      action: 'none',
      reason: 'judge neutral',
      direction: 'neutral',
    });
  });

  it('makes no LLM call when the monthly cap refuses', async () => {
    const series = trending('UP', 260, 0.001);
    const transports: ScriptedTransport[] = [];
    const sleeve = createDebateSleeve({
      panel: panelWith(bullishScript, transports, {
        check: () => ({ admitted: false, spent_usd: 30, budget_usd: 30, kind: 'budget' }),
      }),
      bars: source([series]),
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      clock,
    });
    const output = await sleeve.decide({
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions[0]).toMatchObject({ action: 'skip', reason: 'llm_spend_cap:budget' });
    expect(transports.every((transport) => transport.calls.length === 0)).toBe(true);
  });

  it('records an LLM failure as a skip instead of aborting the cycle', async () => {
    const series = trending('UP', 260, 0.001);
    const sleeve = createDebateSleeve({
      panel: panelWith(() => 'not json'),
      bars: source([series]),
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      clock,
    });
    const output = await sleeve.decide({
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toMatch(/^llm_error:/);
  });
});
