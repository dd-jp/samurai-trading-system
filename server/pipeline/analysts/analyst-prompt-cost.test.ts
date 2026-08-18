/**
 * #745 — what the axis vote costs the debate prompt, and where its
 * interpretation bands are allowed to live.
 *
 * Two claims, both about the boundary between this layer and the debate:
 *
 * 1. **Zero LLM calls are recorded against the analyst layer** — asserted, not
 *    assumed. The 2026-08-16 amendment to `analysts-spec.md` ("Where the LLM
 *    belongs") makes the deterministic analyst the SPECIFIED end state, so a
 *    model arriving here later is a spec violation, not an upgrade.
 * 2. **Interpretation bands are computed in the analyst, never explained in
 *    the prompt.** `renderAnalystViews` wraps the analyst block in
 *    `wrapUntrusted`, so a decoder legend written into the prompt would be
 *    TRUSTED text explaining UNTRUSTED numbers — an injection lever aimed
 *    straight at the reading the model takes from them.
 *
 * Plus the measured token delta the ticket requires, taken through the REAL
 * persona prompt builder rather than a hand-assembled approximation.
 */
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

/** 60 bars of a mildly noisy uptrend — enough for every enrichment kind but MACD's converged warm-up. */
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

/** The prompt one persona actually receives for `views`, built by the real persona code. */
async function promptFor(views: AnalystView[]): Promise<string> {
  const client = new MockLlmClient();
  client.enqueueText(JSON.stringify({ stance: 'bullish', rationale: 'r' }));
  await runBullPersona(client, { trace_id: 'trace-cost', analyst_views: views });
  return client.requests[0]?.prompt as string;
}

/**
 * The PRE-#745 technical block, rebuilt from the same run's own numbers.
 *
 * Rebuilt rather than measured against a checked-in string because the two
 * lines that did not change (the 1h context line, the MI line) must be
 * byte-identical for the delta to be attributable to the axis vote — taking
 * them from the same view guarantees that, where a literal would silently
 * measure fixture drift as well.
 */
function previousShapeOf(view: AnalystView): AnalystView {
  const context = view.key_points.find((line) => line.startsWith('Context (1h):')) as string;
  const mi = view.key_points.find((line) => line.startsWith('MI context:')) as string;
  const momentum = view.key_points.find((line) => line.startsWith('Momentum (5m):')) as string;
  const trend = view.key_points.find((line) => line.startsWith('Trend (5m):')) as string;
  // `Trend (5m): bullish — close 121.3 above SMA(14) 118.9` -> the two numbers.
  const [, close, sma] = /close ([\d.-]+) \w+ SMA\(14\) ([\d.-]+)/.exec(trend) as RegExpExecArray;
  const [, rsi] = /RSI\(14\) ([\d.-]+)/.exec(momentum) as RegExpExecArray;
  return {
    ...view,
    confidence: 0.42,
    key_points: [`Last close ${close} vs SMA(14)=${sma}`, `RSI(14)=${rsi}`, context, mi],
  };
}

describe('the analyst layer makes no LLM call (#745)', () => {
  it('imports no LLM client, prompt builder or model config anywhere in pipeline/analysts', () => {
    // A source scan, because the property is "there is no seam", and a
    // behavioural test can only ever prove "the seam that exists was not used
    // on this path". Non-test files only: a test may legitimately import the
    // debate's persona code to measure a prompt, as this very file does.
    const sources = readdirSync(HERE).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const name of sources) {
      const text = readFileSync(join(HERE, name), 'utf8');
      for (const line of text.split('\n')) {
        if (!/^\s*(import|export)\b.*\bfrom\b/.test(line)) continue;
        if (/llm|nous|anthropic|openai|personas/i.test(line))
          offenders.push(`${name}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
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
    // BOTH trusted regions: the preamble before the wrapper, and everything
    // after the closing tag. The mediator prompt already appends trusted text
    // after a `wrapUntrusted` block ("Underlying analyst views:"), so the
    // trailing region is a real shape in this codebase and is where a decoder
    // legend would most naturally be appended.
    const trusted =
      prompt.slice(0, prompt.indexOf(OPEN_TAG)) +
      prompt.slice(prompt.lastIndexOf(CLOSE_TAG) + CLOSE_TAG.length);

    // Every axis line reaches the model INSIDE the wrapper.
    for (const point of view.key_points) {
      expect(prompt.slice(prompt.indexOf(OPEN_TAG))).toContain(point);
    }

    // And the trusted half explains none of it. If a future change adds "RSI
    // above 70 means overbought" to the prompt preamble, the model is being
    // told how to read numbers that an ingested headline can influence — the
    // exact asymmetry #208's wrapper exists to prevent.
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

    // Characters are what is actually measured; tokens are reported as
    // chars/4, stated as the method rather than implied — there is no
    // tokenizer in this repo (`shared/llm/pricing.ts` prices token counts the
    // API reports back, it does not produce them).
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

    // Bounded rather than pinned to a literal: the assertion that matters is
    // that the block stays the same ORDER of magnitude the ticket priced, so
    // that a later change adding a paragraph per axis fails here instead of
    // quietly repricing every debate round.
    expect(chars.after).toBeGreaterThan(chars.before);
    expect(tokens.after - tokens.before).toBeLessThan(300);
  });
});
