import {
  AlwaysOpenCalendar,
  type Bar,
  FixtureDataSource,
  MarketDataServiceImpl,
  RVOL_SESSION_WINDOW,
  SqliteMarketDataStore,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import { screeningInstrumentFor } from '../../providers/universe-pool/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { MockLlmClient } from '../debate-engine/llm/mock-client.js';
import { runBullPersona } from '../debate-engine/personas.js';
import { RVOL_5M_LOOKBACK, rvolLine, technicalAnalyst } from './technical-analyst.js';
import { NOOP_ANALYST_TELEMETRY, type Signal } from './types.js';

const INSTRUMENT = 'SPY';
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;
const SIGNAL: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

const ETP_TICKER = '3USL';
const ETP_UNDERLYING = 'SPY';

const TRADING_DAYS = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16];

const SESSION_OPEN_UTC_HOUR = 13;
const SESSION_OPEN_UTC_MINUTE = 30;
const BARS_PER_DAY = 78;

const BASELINE_VOLUME = 1_000;
const CURRENT_VOLUME = 1_500;

class ManualClock implements Clock {
  constructor(private readonly time: Date) {}
  now(): Date {
    return this.time;
  }
}

function bar(closeTime: Date, index: number, volume: number): Bar {
  const close = 100 + Math.sin(index / 11) * 2;
  return {
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
    close_time: closeTime,
    open: close - 0.2,
    high: close + 0.5,
    low: close - 0.6,
    close,
    volume,
    source: 'fixture',
  };
}

function sessionBars(): Bar[] {
  const bars: Bar[] = [];
  let index = 0;
  for (const [dayIndex, day] of TRADING_DAYS.entries()) {
    const isLastDay = dayIndex === TRADING_DAYS.length - 1;
    const open = Date.UTC(2026, 5, day, SESSION_OPEN_UTC_HOUR, SESSION_OPEN_UTC_MINUTE);
    const count = isLastDay ? BARS_PER_DAY - 1 : BARS_PER_DAY;
    for (let i = 1; i <= count; i++) {
      const isCurrent = isLastDay && i === count;
      bars.push(
        bar(
          new Date(open + i * BAR_INTERVAL_MS),
          index++,
          isCurrent ? CURRENT_VOLUME : BASELINE_VOLUME,
        ),
      );
    }
  }
  return bars;
}

async function runTechnical(
  calendar: TradingCalendar,
  signal: Signal = SIGNAL,
): Promise<AnalystView> {
  const window = sessionBars();
  const asOf = window.at(-1)?.close_time as Date;
  const clock = new ManualClock(asOf);
  return technicalAnalyst.run({
    trace_id: 'trace-rvol',
    signal,
    clock,
    bar: asOf,
    market_intelligence: new MarketIntelligenceStore(clock),
    market_data: new MarketDataServiceImpl(
      new FixtureDataSource(window, { price: 100, observed_at: asOf, source: 'fixture' }, 'stocks'),
      clock,
      'backtest',
      new SqliteMarketDataStore(openSharedStore(':memory:')),
    ),
    calendar,
    telemetry: NOOP_ANALYST_TELEMETRY,
  });
}

const rvolPointOf = (view: AnalystView): string =>
  view.key_points.find((line) => line.startsWith(`RVOL (${TIMEFRAME}):`)) as string;

describe('the RVOL line reaches the debate (#797)', () => {
  it('puts a computed RVOL reading into the analyst’s key_points', async () => {
    const view = await runTechnical(new UsEquityRegularHoursCalendar());

    const point = rvolPointOf(view);
    expect(point).toBe(
      `RVOL (5m): 1.5x the median same-clock-time bucket over ` +
        `${RVOL_SESSION_WINDOW}/${RVOL_SESSION_WINDOW} prior sessions — informational, no vote`,
    );
  });

  it('reaches the persona prompt inside the untrusted wrapper, not merely the view', async () => {
    const view = await runTechnical(new UsEquityRegularHoursCalendar());
    const client = new MockLlmClient();
    client.enqueueText(JSON.stringify({ stance: 'bullish', rationale: 'r' }));
    await runBullPersona(client, { trace_id: 'trace-rvol', analyst_views: [view] });
    const prompt = client.requests[0]?.prompt as string;

    expect(prompt.slice(prompt.indexOf('<untrusted_analyst_data>'))).toContain(rvolPointOf(view));
  });

  it('degrades to a stated reason rather than a fabricated ratio under an always-open calendar', async () => {
    const view = await runTechnical(new AlwaysOpenCalendar());

    expect(rvolPointOf(view)).toBe(
      `RVOL (5m): unavailable (no_session_anchor, 0/${RVOL_SESSION_WINDOW} sessions matched) — ` +
        'informational, no vote',
    );
  });
});

describe('RVOL feeds no vote — #745’s one-vote-per-axis rule is untouched (#797)', () => {
  it('leaves direction, confidence and the axis-vote line identical whether RVOL reads or degrades', async () => {
    const withRvol = await runTechnical(new UsEquityRegularHoursCalendar());
    const withoutRvol = await runTechnical(new AlwaysOpenCalendar());

    expect(rvolPointOf(withRvol)).not.toBe(rvolPointOf(withoutRvol));
    expect(withRvol.direction).toBe(withoutRvol.direction);
    expect(withRvol.confidence).toBe(withoutRvol.confidence);

    const axisLine = (view: AnalystView): string =>
      view.key_points.find((line) => line.startsWith('Axis votes:')) as string;
    expect(axisLine(withRvol)).toBe(axisLine(withoutRvol));
    expect(axisLine(withRvol).toLowerCase()).not.toContain('rvol');
  });
});

describe('the #744 volume caveat is rendered, not merely known (#797)', () => {
  it('says nothing extra for a liquid US instrument, whose own volume IS the informed volume', () => {
    expect(screeningInstrumentFor(INSTRUMENT)).toBeNull();
    expect(
      rvolLine(
        INSTRUMENT,
        { rvol: 1.5, sessions_used: 10, sessions_target: 10, degraded_reason: null },
        null,
      ),
    ).not.toContain('wrapper');
  });

  it('names the wrapper and the informed instrument when the traded line is an ETP', () => {
    expect(screeningInstrumentFor(ETP_TICKER)).toBe(ETP_UNDERLYING);

    const line = rvolLine(
      ETP_TICKER,
      { rvol: 1.5, sessions_used: 10, sessions_target: 10, degraded_reason: null },
      screeningInstrumentFor(ETP_TICKER),
    );

    expect(line).toContain(`measured on ${ETP_TICKER}, a leveraged-ETP wrapper`);
    expect(line).toContain(`The informed instrument is ${ETP_UNDERLYING}`);
    expect(line).toContain('#797');
  });
});

describe('the measured debate-input delta for the RVOL line (#797)', () => {
  it('records what the RVOL line costs, per persona per round', async () => {
    const view = await runTechnical(new UsEquityRegularHoursCalendar());
    const point = rvolPointOf(view);
    const without: AnalystView = {
      ...view,
      key_points: view.key_points.filter((line) => line !== point),
    };

    const promptFor = async (v: AnalystView): Promise<string> => {
      const client = new MockLlmClient();
      client.enqueueText(JSON.stringify({ stance: 'bullish', rationale: 'r' }));
      await runBullPersona(client, { trace_id: 'trace-rvol', analyst_views: [v] });
      return client.requests[0]?.prompt as string;
    };

    const before = await promptFor(without);
    const after = await promptFor(view);

    const chars = { before: before.length, after: after.length };
    const tokens = { before: Math.round(chars.before / 4), after: Math.round(chars.after / 4) };
    const etpPoint = rvolLine(
      ETP_TICKER,
      { rvol: 1.5, sessions_used: 10, sessions_target: 10, degraded_reason: null },
      ETP_UNDERLYING,
    );
    // eslint-disable-next-line no-console
    console.log(
      `#797 debate-input measurement (one persona, one round, one analyst view): ` +
        `${chars.before} -> ${chars.after} chars, ~${tokens.before} -> ~${tokens.after} tokens ` +
        `(+${tokens.after - tokens.before}); RVOL line ${point.length} chars ` +
        `(~${Math.round(point.length / 4)} tokens), ETP-caveat form ${etpPoint.length} chars ` +
        `(~${Math.round(etpPoint.length / 4)} tokens); technical key_points ` +
        `${without.key_points.join('\n').length} -> ${view.key_points.join('\n').length} chars`,
    );

    expect(chars.after).toBeGreaterThan(chars.before);
    expect(tokens.after - tokens.before).toBeLessThan(60);
    expect(Math.round(etpPoint.length / 4)).toBeLessThan(100);
  });
});

describe('the RVOL window is wide enough to ever produce a number (#797)', () => {
  it('asks for more than ten sessions of 5m bars', () => {
    expect(RVOL_5M_LOOKBACK).toBeGreaterThan((RVOL_SESSION_WINDOW + 1) * BARS_PER_DAY);
  });
});
