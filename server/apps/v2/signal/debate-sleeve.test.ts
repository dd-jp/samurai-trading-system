import { describe, expect, it } from 'vitest';
import { UNCAPPED_SPEND } from '../../../pipeline/debate-engine/index.js';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import type { BarsSource } from '../data/index.js';
import { addDays, NO_NEWS } from '../data/index.js';
import { STOP_ATR_MULTIPLE } from '../risk/index.js';
import {
  createDebateSleeve,
  directionFrom,
  JUDGE_CONFIDENCE_BY_AGREEING_DEBATERS,
  newsView,
  technicalRead,
} from './debate-sleeve.js';
import { buildLlmPanel } from './llm-panel.js';
import { BULLISH_SCRIPT, type Script, ScriptedTransport } from './scripted-transport.js';

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
const NEUTRAL_SCRIPT: Script = (request) =>
  (request.messages[0]?.content ?? '').includes('Mediator persona')
    ? '{"stance":"neutral","rationale":"flat","converged":true}'
    : '{"stance":"neutral","rationale":"flat"}';

describe('directionFrom', () => {
  it('needs both the SMA and the 63-day return to agree, and treats zero as neither', () => {
    expect(directionFrom(101, 100, 0.01)).toBe('bullish');
    expect(directionFrom(99, 100, -0.01)).toBe('bearish');
    expect(directionFrom(101, 100, -0.01)).toBe('neutral');
    expect(directionFrom(99, 100, 0.01)).toBe('neutral');
    expect(directionFrom(101, 100, 0)).toBe('neutral');
    expect(directionFrom(99, 100, 0)).toBe('neutral');
    expect(directionFrom(100, 100, 0.01)).toBe('neutral');
    expect(directionFrom(100, 100, -0.01)).toBe('neutral');
    expect(directionFrom(101, undefined, 0.01)).toBe('neutral');
    expect(directionFrom(101, 100, undefined)).toBe('neutral');
  });
});

describe('newsView', () => {
  it('is a neutral analyst view carrying the headlines or an explicit empty marker', () => {
    const now = clock.now();
    expect(newsView(['a', 'b'], 't', now)).toEqual({
      trace_id: 't',
      analyst_id: 'news',
      analyst_type: 'news',
      direction: 'neutral',
      confidence: 0.5,
      key_points: ['a', 'b'],
      timestamp: now,
    });
    expect(newsView([], 't', now).key_points).toEqual(['no per-name headlines in the window']);
  });
});

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

  it('needs exactly 200 bars for the SMA and reports each input in a fixed format', () => {
    const full = trending('UP', 200, 0.001).bars;
    const read = technicalRead(full, 't', clock.now());
    const pct = (a: number, b: number) => `${((a / b - 1) * 100).toFixed(2)}%`;
    const close = (index: number) => full[index]?.close ?? Number.NaN;
    const sma = full.reduce((total, bar) => total + bar.close, 0) / 200;
    expect(read?.view.direction).toBe('bullish');
    expect(read?.view.confidence).toBe(0.6);
    expect(read?.view.key_points).toEqual([
      `close ${close(199).toFixed(2)} vs 200-day SMA ${sma.toFixed(2)}`,
      `20-day return ${pct(close(199), close(179))}`,
      `63-day return ${pct(close(199), close(136))}`,
      expect.stringMatching(/^20-day ATR \d+\.\d{4}$/),
    ]);
    const short = technicalRead(full.slice(1), 't', clock.now());
    expect(short?.view.direction).toBe('neutral');
    expect(short?.view.confidence).toBe(0.5);
    expect(short?.view.key_points[0]).toBe(`close ${close(199).toFixed(2)} vs 200-day SMA n/a`);
    const thin = technicalRead(full.slice(-5), 't', clock.now());
    expect(thin?.atr).toBeUndefined();
    expect(thin?.view.key_points.slice(1)).toEqual([
      '20-day return n/a',
      '63-day return n/a',
      '20-day ATR n/a',
    ]);
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
      news: NO_NEWS,
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
    expect(called).toContain('anthropic/claude-opus-5');
    expect(called.join(' ')).not.toContain('fable');
    for (const transport of transports) {
      for (const call of transport.calls) {
        expect(call.prompt).not.toMatch(/api[_-]?key|ALPACA|SAXO|account/i);
      }
    }
    expect(output.refusals.map((refusal) => refusal.parameter)).toEqual(['G18_SMALL_CAP_FLOORS']);
    expect(decision?.payload).toMatchObject({ headlines: 0, disagreement: '', converged: true });
  });

  it('hashes only the last 200 bars of history', async () => {
    const base = trending('UP', 260, 0.001);
    const decide = async (series: BarSeries) => {
      const sleeve = createDebateSleeve({
        panel: panelWith(bullishScript),
        bars: source([series]),
        constituents: () => ['UP'],
        venueFor: () => 'alpaca',
        news: NO_NEWS,
        clock,
      });
      const output = await sleeve.decide({
        tradingDate: nextDate(series),
        macroDay: false,
        dryRun: true,
      });
      return output.decisions[0]?.inputs_hash;
    };
    const retouch = (index: number): BarSeries => ({
      symbol: base.symbol,
      bars: base.bars.map((bar, i) => (i === index ? { ...bar, open: bar.open * 1.5 } : bar)),
    });
    const reference = await decide(base);
    expect(await decide(retouch(59))).toBe(reference);
    expect(await decide(retouch(60))).not.toBe(reference);
  });

  it('feeds per-name headlines to the debaters and skips the name when the news source fails', async () => {
    const series = trending('UP', 260, 0.001);
    const transports: ScriptedTransport[] = [];
    const make = (headlines: () => Promise<readonly string[]>) =>
      createDebateSleeve({
        panel: panelWith(bullishScript, transports),
        bars: source([series]),
        constituents: () => ['UP'],
        venueFor: () => 'alpaca',
        news: { headlines },
        clock,
      });
    const context = { tradingDate: nextDate(series), macroDay: false, dryRun: true };
    const withNews = await make(() => Promise.resolve(['UP raises guidance'])).decide(context);
    expect(withNews.decisions[0]?.payload).toMatchObject({ headlines: 1 });
    expect(
      transports
        .flatMap((t) => t.calls)
        .every((call) => call.prompt.includes('UP raises guidance')),
    ).toBe(true);
    const withoutHash = withNews.decisions[0]?.inputs_hash;
    const noNews = await make(() => Promise.resolve([])).decide(context);
    expect(noNews.decisions[0]?.inputs_hash).not.toBe(withoutHash);
    const before = transports.flatMap((t) => t.calls).length;
    const failed = await make(() => Promise.reject(new Error('alpaca news 500'))).decide(context);
    expect(failed.decisions[0]?.action).toBe('skip');
    expect(failed.decisions[0]?.reason).toMatch(/^news_error:.*alpaca news 500/);
    expect(transports.flatMap((t) => t.calls).length).toBe(before);
  });

  it('skips a bullish judge when the ATR is unavailable and journals disagreement', async () => {
    const series = trending('UP', 260, 0.001);
    const short = { symbol: 'UP', bars: series.bars.slice(-5) };
    const disagreeing: Script = (request) => {
      const prompt = request.messages[0]?.content ?? '';
      if (prompt.includes('Mediator persona'))
        return '{"stance":"bullish","rationale":"j","converged":false}';
      return prompt.includes('Bear persona')
        ? '{"stance":"bearish","rationale":"b"}'
        : '{"stance":"bullish","rationale":"u"}';
    };
    const sleeve = createDebateSleeve({
      panel: panelWith(disagreeing),
      bars: source([short]),
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      news: NO_NEWS,
      clock,
    });
    const output = await sleeve.decide({
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions[0]).toMatchObject({
      action: 'skip',
      reason: 'atr_unavailable',
      stop_price: undefined,
    });
    expect(output.decisions[0]?.payload.disagreement).toBe('bull and bear disagree on direction');
    expect(output.decisions[0]?.confidence).toBe(JUDGE_CONFIDENCE_BY_AGREEING_DEBATERS[1]);
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
        news: NO_NEWS,
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
      news: NO_NEWS,
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
      news: NO_NEWS,
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
