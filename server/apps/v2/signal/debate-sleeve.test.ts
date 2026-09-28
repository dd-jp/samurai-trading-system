import { describe, expect, it } from 'vitest';
import type { Sleeve, SleeveContext, SleeveOutput } from '../../../../contracts/index.js';
import type { AnalystView } from '../../../pipeline/debate-engine/index.js';
import { UNCAPPED_SPEND } from '../../../pipeline/debate-engine/index.js';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import type { BarsSource } from '../data/index.js';
import { addDays, NO_NEWS } from '../data/index.js';
import { inputsHash } from '../journal/index.js';
import {
  actionFor,
  buildUniverse,
  createDebateSleeve,
  directionFrom,
  JUDGE_CONFIDENCE_BY_AGREEING_DEBATERS,
  newsView,
  resolveTechnical,
  technicalRead,
} from './debate-sleeve.js';
import { buildLlmPanel, seatModels } from './llm-panel.js';
import { DEBATE_SLEEVE_SPEC } from './parameters.js';
import { BULLISH_SCRIPT, type Script, ScriptedTransport } from './scripted-transport.js';

async function decideAll(sleeve: Sleeve, context: SleeveContext): Promise<SleeveOutput> {
  const universe = sleeve.universe(context);
  const output = await sleeve.decide(context, universe.instruments);
  return { decisions: output.decisions, refusals: [...universe.refusals, ...output.refusals] };
}

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

function withCalendar(all: readonly BarSeries[]): readonly BarSeries[] {
  const dates = [...new Set(all.flatMap((entry) => entry.bars.map((bar) => bar.date)))].sort();
  const reference = dates.map((date) => ({
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    rawClose: 1,
  }));
  return [...all, { symbol: 'SPY', bars: reference }];
}

function source(all: readonly BarSeries[]): BarsSource {
  const withReference = withCalendar(all);
  return { load: (symbol) => withReference.find((entry) => entry.symbol === symbol) };
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

  it("takes arm 2's own thresholds instead of the zero default when given one (#1773)", () => {
    const thresholds = { longAbove: 0.02, shortBelow: -0.02 };
    expect(directionFrom(101, 100, 0.01, thresholds)).toBe('neutral');
    expect(directionFrom(101, 100, 0.03, thresholds)).toBe('bullish');
    expect(directionFrom(99, 100, -0.01, thresholds)).toBe('neutral');
    expect(directionFrom(99, 100, -0.03, thresholds)).toBe('bearish');
  });
});

describe('actionFor', () => {
  it('names the reason after the source that computed the direction', () => {
    expect(actionFor('bullish', 'technical')).toEqual({
      action: 'enter_long',
      reason: 'technical bullish',
    });
    expect(actionFor('bearish', 'technical')).toEqual({
      action: 'skip',
      reason: 'shorts_disabled',
    });
    expect(actionFor('neutral', 'technical')).toEqual({
      action: 'none',
      reason: 'technical neutral',
    });
    expect(actionFor('bullish', 'judge')).toEqual({
      action: 'enter_long',
      reason: 'judge bullish',
    });
  });
});

describe('resolveTechnical', () => {
  it('resolves ok with the full history once the 200-session window is covered', () => {
    const series = trending('UP', 260, 0.001);
    const outcome = resolveTechnical(
      source([series]),
      () => 'alpaca',
      'UP',
      nextDate(series),
      clock.now(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.read.view.direction).toBe('bullish');
      expect(outcome.venue).toBe('alpaca');
    }
  });

  it('reports no_bars for a symbol with no series and window_coverage for a gapped one', () => {
    const series = trending('UP', 260, 0.001);
    const full = { symbol: 'FULL', bars: series.bars };
    const gapped = source([
      full,
      { symbol: 'GAPPED', bars: series.bars.filter((_, i) => i % 15 !== 0) },
    ]);
    expect(
      resolveTechnical(source([]), () => 'alpaca', 'MISSING', nextDate(series), clock.now()),
    ).toMatchObject({ ok: false, reason: 'no_bars' });
    expect(
      resolveTechnical(gapped, () => 'alpaca', 'GAPPED', nextDate(series), clock.now()),
    ).toMatchObject({ ok: false, reason: 'window_coverage' });
  });
});

describe('buildUniverse', () => {
  it('is the same universe both the debate sleeve and arm 2 select (#1773 extraction)', () => {
    const series = trending('UP', 260, 0.001);
    const universe = buildUniverse(source([series]), () => ['UP', 'MISSING'], nextDate(series));
    expect(universe.instruments).toContain('UP');
    expect(universe.refusals.map((refusal) => refusal.parameter)).toEqual([
      'G18_SMALL_CAP_FLOORS',
      'LSE_LIQUIDITY_SCREEN',
    ]);
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
      'prior-day candle: body 0.00%, upper wick 50.00%, lower wick 50.00% of range',
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
      'prior-day candle: body 0.00%, upper wick 50.00%, lower wick 50.00% of range',
    ]);
  });

  it('reports the prior-day candle body/wick split, undefined on a zero-range bar (#1772)', () => {
    const series = trending('UP', 260, 0.001);
    const lastClose = series.bars.at(-1)?.close ?? 0;
    const flatBar: DailyBar = {
      date: '2099-01-01',
      open: lastClose,
      high: lastClose,
      low: lastClose,
      close: lastClose,
      volume: 1_000_000,
      rawClose: lastClose,
    };
    const flat = technicalRead([...series.bars, flatBar], 't', clock.now());
    expect(flat?.view.key_points.at(-1)).toBe(
      'prior-day candle: n/a (zero range, or open/close outside high-low)',
    );
    const marubozu: DailyBar = {
      date: '2099-01-01',
      open: lastClose * 0.99,
      high: lastClose,
      low: lastClose * 0.99,
      close: lastClose,
      volume: 1_000_000,
      rawClose: lastClose,
    };
    const bull = technicalRead([...series.bars, marubozu], 't', clock.now());
    expect(bull?.view.key_points.at(-1)).toBe(
      'prior-day candle: body 100.00%, upper wick 0.00%, lower wick 0.00% of range',
    );
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
    const output = await decideAll(sleeve, {
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
      (decision?.price ?? 0) - DEBATE_SLEEVE_SPEC.sizing.stopAtrMultiple * (decision?.atr ?? 0),
      9,
    );
    expect(decision?.confidence).toBe(1);
    expect(decision?.inputs_hash).toHaveLength(64);
    expect(decision?.debate_id).toBeDefined();
    const called = transports.flatMap((transport) => transport.calls.map((call) => call.model));
    expect(called).toHaveLength(3);
    expect(called).toContain('anthropic/claude-opus-5.5');
    expect(called.join(' ')).not.toContain('fable');
    for (const transport of transports) {
      for (const call of transport.calls) {
        expect(call.prompt).not.toMatch(/api[_-]?key|ALPACA|SAXO|account/i);
        expect(call.prompt).toContain('prior-day candle:');
      }
    }
    expect(output.refusals.map((refusal) => refusal.parameter)).toEqual([
      'G18_SMALL_CAP_FLOORS',
      'LSE_LIQUIDITY_SCREEN',
    ]);
    expect(decision?.payload).toMatchObject({ headlines: 0, disagreement: '', converged: true });
  });

  it('changes inputs_hash when the candle line changes and nothing else does (#1772)', () => {
    const bars = trending('UP', 260, 0.001).bars;
    const models = seatModels('2026-09-26');
    const withCandle = technicalRead(bars, 't', clock.now())?.view as AnalystView;
    const withoutCandle: AnalystView = {
      ...withCandle,
      key_points: withCandle.key_points.slice(0, -1),
    };
    expect(inputsHash(bars, [withCandle], models)).not.toBe(
      inputsHash(bars, [withoutCandle], models),
    );
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
      const output = await decideAll(sleeve, {
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
    const withNews = await decideAll(
      make(() => Promise.resolve(['UP raises guidance'])),
      context,
    );
    expect(withNews.decisions[0]?.payload).toMatchObject({ headlines: 1 });
    expect(
      transports
        .flatMap((t) => t.calls)
        .every((call) => call.prompt.includes('UP raises guidance')),
    ).toBe(true);
    const withoutHash = withNews.decisions[0]?.inputs_hash;
    const noNews = await decideAll(
      make(() => Promise.resolve([])),
      context,
    );
    expect(noNews.decisions[0]?.inputs_hash).not.toBe(withoutHash);
    const before = transports.flatMap((t) => t.calls).length;
    const failed = await decideAll(
      make(() => Promise.reject(new Error('alpaca news 500'))),
      context,
    );
    expect(failed.decisions[0]).toMatchObject({
      direction: 'neutral',
      action: 'skip',
      inputs_hash: '',
    });
    expect(failed.decisions[0]?.reason).toMatch(/^news_error:.*alpaca news 500/);
    expect(transports.flatMap((t) => t.calls).length).toBe(before);
  });

  it('journals debater disagreement and the judge confidence it implies', async () => {
    const series = trending('UP', 260, 0.001);
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
      bars: source([series]),
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      news: NO_NEWS,
      clock,
    });
    const output = await decideAll(sleeve, {
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions[0]).toMatchObject({ action: 'enter_long', reason: 'judge bullish' });
    expect(output.decisions[0]?.payload.disagreement).toBe('bull and bear disagree on direction');
    expect(output.decisions[0]?.confidence).toBe(JUDGE_CONFIDENCE_BY_AGREEING_DEBATERS[1]);
  });

  it('skips a name whose 200-session window is not covered before any LLM call (#1791)', async () => {
    const series = trending('UP', 260, 0.001);
    const full = { symbol: 'FULL', bars: series.bars };
    const gapped = { symbol: 'UP', bars: series.bars.filter((_, index) => index % 15 !== 0) };
    const transports: ScriptedTransport[] = [];
    const sleeve = createDebateSleeve({
      panel: panelWith(BULLISH_SCRIPT, transports),
      bars: source([full, gapped]),
      constituents: () => ['UP'],
      venueFor: () => 'alpaca',
      news: NO_NEWS,
      clock,
    });
    const output = await decideAll(sleeve, {
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions[0]).toMatchObject({
      direction: 'neutral',
      action: 'skip',
      reason: 'window_coverage',
      price: full.bars.at(-1)?.close,
      inputs_hash: '',
    });
    expect(transports.flatMap((transport) => transport.calls)).toEqual([]);
  });

  it("reads an LSE name's 200-session window off ISF, not SPY, since the two calendars diverge", async () => {
    // own skips ~17 of 261 days (UK-only bank holidays CSP1, an LSE line, doesn't
    // trade); ISF shares those gaps (also LSE) so it self-covers, but SPY (US, no
    // gaps) would demand bars on days CSP1 never had, failing coverage if wrongly read
    const full = trending('CSP1', 261, 0.001).bars;
    const gapDates = new Set(full.filter((_, index) => index % 15 === 0).map((bar) => bar.date));
    const own = full.filter((bar) => !gapDates.has(bar.date));
    const isf = { symbol: 'ISF', bars: own };
    const spy = { symbol: 'SPY', bars: full };
    const bars: BarsSource = {
      load: (symbol) => {
        if (symbol === 'CSP1') return { symbol: 'CSP1', bars: own };
        if (symbol === 'ISF') return isf;
        if (symbol === 'SPY') return spy;
        return undefined;
      },
    };
    const transports: ScriptedTransport[] = [];
    const sleeve = createDebateSleeve({
      panel: panelWith(BULLISH_SCRIPT, transports),
      bars,
      constituents: () => ['CSP1'],
      venueFor: () => 'saxo',
      news: NO_NEWS,
      clock,
    });
    const output = await decideAll(sleeve, {
      tradingDate: nextDate({ symbol: 'CSP1', bars: own }),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions[0]).not.toMatchObject({ reason: 'window_coverage' });
    expect(transports.flatMap((transport) => transport.calls)).not.toEqual([]);
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
    const short = (await decideAll(make(bearish), context)).decisions[0];
    expect(short).toMatchObject({
      action: 'skip',
      reason: 'shorts_disabled',
      direction: 'bearish',
    });
    const neutral = (await decideAll(make(NEUTRAL_SCRIPT), context)).decisions[0];
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
    const output = await decideAll(sleeve, {
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
    const output = await decideAll(sleeve, {
      tradingDate: nextDate(series),
      macroDay: false,
      dryRun: true,
    });
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toMatch(/^llm_error:/);
  });
});
