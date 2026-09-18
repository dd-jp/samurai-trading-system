import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlwaysOpenCalendar,
  type Bar,
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { MockLlmClient } from '../debate-engine/llm/mock-client.js';
import { runBullPersona } from '../debate-engine/personas.js';
import { technicalAnalyst } from './technical-analyst.js';
import { NOOP_ANALYST_TELEMETRY, type Signal } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTRUMENT = 'BTC-USD';
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;
const SIGNAL: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };
const OPEN_TAG = '<untrusted_analyst_data>';
const CLOSE_TAG = '</untrusted_analyst_data>';

class ManualClock implements Clock {
  constructor(private readonly time: Date) {}
  now(): Date {
    return this.time;
  }
}

function bars(count = 60): Bar[] {
  const start = new Date('2026-07-14T00:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => {
    const closeTime = new Date(start + i * BAR_INTERVAL_MS);
    const close = 100 + i * 0.4 + Math.sin(i / 3) * 1.5;
    return {
      instrument: INSTRUMENT,
      timeframe: TIMEFRAME,
      open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
      close_time: closeTime,
      open: close - 0.2,
      high: close + 0.5,
      low: close - 0.6,
      close,
      volume: 100 + i,
      source: 'fixture',
    } satisfies Bar;
  });
}

async function runTechnical(): Promise<AnalystView> {
  const window = bars();
  const asOf = window.at(-1)?.close_time as Date;
  const clock = new ManualClock(asOf);
  return technicalAnalyst.run({
    trace_id: 'trace-cost',
    signal: SIGNAL,
    clock,
    bar: asOf,
    market_intelligence: new MarketIntelligenceStore(clock),
    market_data: new MarketDataServiceImpl(
      new FixtureDataSource(
        window,
        { price: 999, observed_at: asOf, source: 'fixture-live' },
        SIGNAL.asset_class,
      ),
      clock,
      'backtest',
      new SqliteMarketDataStore(openSharedStore(':memory:')),
    ),
    calendar: new AlwaysOpenCalendar(),
    telemetry: NOOP_ANALYST_TELEMETRY,
  });
}

async function promptFor(views: AnalystView[]): Promise<string> {
  const client = new MockLlmClient();
  client.enqueueText(JSON.stringify({ stance: 'bullish', rationale: 'r' }));
  await runBullPersona(client, { trace_id: 'trace-cost', analyst_views: views });
  return client.requests[0]?.prompt as string;
}

function previousShapeOf(view: AnalystView): AnalystView {
  const context = view.key_points.find((line) => line.startsWith('Context (1h):')) as string;
  const mi = view.key_points.find((line) => line.startsWith('MI context:')) as string;
  const momentum = view.key_points.find((line) => line.startsWith('Momentum (5m):')) as string;
  const trend = view.key_points.find((line) => line.startsWith('Trend (5m):')) as string;
  const [, close, sma] = /close ([\d.-]+) \w+ SMA\(14\) ([\d.-]+)/.exec(trend) as RegExpExecArray;
  const [, rsi] = /RSI\(14\) ([\d.-]+)/.exec(momentum) as RegExpExecArray;
  return {
    ...view,
    confidence: 0.42,
    key_points: [`Last close ${close} vs SMA(14)=${sma}`, `RSI(14)=${rsi}`, context, mi],
  };
}

function findLlmImportOffenders(dir: string, sources: string[]): string[] {
  const offenders: string[] = [];
  for (const name of sources) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (!/^\s*(import|export)\b.*\bfrom\b/.test(line)) continue;
      if (/llm|nous|anthropic|openai|personas/i.test(line))
        offenders.push(`${name}: ${line.trim()}`);
    }
  }
  return offenders;
}

describe('the analyst layer makes no LLM call (#745)', () => {
  it('imports no LLM client, prompt builder or model config anywhere in pipeline/analysts', () => {
    const sources = readdirSync(HERE).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(3);

    expect(findLlmImportOffenders(HERE, sources)).toEqual([]);
  });

  it('and records no LLM request while producing a full five-axis view', async () => {
    const client = new MockLlmClient();

    const view = await runTechnical();

    expect(view.key_points.some((line) => line.startsWith('Axis votes:'))).toBe(true);
    expect(client.requests).toHaveLength(0);
  });
});

describe('interpretation bands are computed in the analyst, not the prompt (#745)', () => {
  it('puts every band inside the untrusted block, and no decoder legend outside it', async () => {
    const view = await runTechnical();
    const prompt = await promptFor([view]);
    const trusted =
      prompt.slice(0, prompt.indexOf(OPEN_TAG)) +
      prompt.slice(prompt.lastIndexOf(CLOSE_TAG) + CLOSE_TAG.length);

    for (const point of view.key_points) {
      expect(prompt.slice(prompt.indexOf(OPEN_TAG))).toContain(point);
    }

    for (const legend of ['RSI', 'ADX', 'MACD', 'Donchian', 'squeeze', 'overbought', 'oversold']) {
      expect(trusted).not.toContain(legend);
    }
  });
});

describe('the measured debate-input delta (#745)', () => {
  it('records what the axis vote costs, per persona per round', async () => {
    const view = await runTechnical();
    const before = await promptFor([previousShapeOf(view)]);
    const after = await promptFor([view]);

    const chars = { before: before.length, after: after.length };
    const tokens = { before: Math.round(chars.before / 4), after: Math.round(chars.after / 4) };
    // eslint-disable-next-line no-console
    console.log(
      `#745 debate-input measurement (one persona, one round, one analyst view): ` +
        `${chars.before} -> ${chars.after} chars, ~${tokens.before} -> ~${tokens.after} tokens ` +
        `(+${tokens.after - tokens.before}); technical key_points ` +
        `${previousShapeOf(view).key_points.join('\n').length} -> ` +
        `${view.key_points.join('\n').length} chars`,
    );

    expect(chars.after).toBeGreaterThan(chars.before);
    expect(tokens.after - tokens.before).toBeLessThan(300);
  });
});
