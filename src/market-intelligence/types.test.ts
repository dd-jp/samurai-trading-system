import type {
  AgentIntelligence,
  AssetClass,
  ConflictResolution,
  IntelligenceItem,
  MarketContext,
  MarketContextCallback,
} from './types.js';

describe('AssetClass', () => {
  it('accepts only crypto, stocks', () => {
    const crypto: AssetClass = 'crypto';
    const stocks: AssetClass = 'stocks';

    expect([crypto, stocks]).toEqual(['crypto', 'stocks']);
    // @ts-expect-error — not a valid AssetClass
    const invalid: AssetClass = 'forex';
    expect(invalid).toBeDefined();
  });
});

describe('IntelligenceItem', () => {
  it('matches the upstream item shape', () => {
    const item: IntelligenceItem = {
      id: 'deepresearch-bloomberg-2026-07-14T09:00:00Z-AAPL',
      source: 'bloomberg',
      type: 'news',
      timestamp: new Date('2026-07-14T09:00:00Z'),
      entity: 'AAPL',
      headline: 'Apple beats earnings estimates',
      sentiment: 1,
      confidence: 0.9,
    };

    expectTypeOf(item).toMatchTypeOf<IntelligenceItem>();
    expect(['news', 'sentiment']).toContain(item.type);
    expect([1, 0, -1]).toContain(item.sentiment);
  });

  it('allows the optional summary and url fields', () => {
    const item: IntelligenceItem = {
      id: 'grok-twitter-2026-07-14T09:05:00Z-AAPL',
      source: 'twitter',
      type: 'sentiment',
      timestamp: new Date('2026-07-14T09:05:00Z'),
      entity: 'AAPL',
      headline: 'Retail sentiment turns bullish on AAPL',
      sentiment: 1,
      confidence: 0.6,
      summary: 'Volume of bullish mentions up 3x in the last hour.',
      url: 'https://twitter.com/example/status/123',
    };

    expect(item.summary).toBeDefined();
    expect(item.url).toBeDefined();
  });
});

describe('AgentIntelligence', () => {
  it('matches the upstream envelope shape', () => {
    const envelope: AgentIntelligence = {
      agent_id: 'deepresearch',
      timestamp: new Date('2026-07-14T09:00:00Z'),
      asset_class: 'stocks',
      items: [],
    };

    expectTypeOf(envelope).toMatchTypeOf<AgentIntelligence>();
    expect(['deepresearch', 'grok']).toContain(envelope.agent_id);
  });
});

describe('MarketContext', () => {
  it('matches the downstream contract shape', () => {
    const context: MarketContext = {
      timestamp: new Date('2026-07-14T09:10:00Z'),
      asset_class: 'stocks',
      news: [],
      social: [],
      conflicts: [],
      stale: true,
      last_updated: null,
    };

    expectTypeOf(context).toMatchTypeOf<MarketContext>();
    expect(Object.keys(context).sort()).toEqual(
      ['timestamp', 'asset_class', 'news', 'social', 'conflicts', 'stale', 'last_updated'].sort(),
    );
  });

  it('allows a non-null last_updated when not stale', () => {
    const context: MarketContext = {
      timestamp: new Date('2026-07-14T09:10:00Z'),
      asset_class: 'crypto',
      news: [],
      social: [],
      conflicts: [],
      stale: false,
      last_updated: new Date('2026-07-14T09:09:58Z'),
    };

    expectTypeOf(context).toMatchTypeOf<MarketContext>();
    expect(context.last_updated).toBeInstanceOf(Date);
  });
});

describe('MarketContextCallback', () => {
  it('accepts a callback shaped (ctx: MarketContext) => void', () => {
    const callback: MarketContextCallback = (ctx) => {
      expect(ctx.asset_class).toBeDefined();
    };

    expectTypeOf(callback).toMatchTypeOf<MarketContextCallback>();
  });
});

describe('ConflictResolution', () => {
  it('matches the audit-log shape', () => {
    const resolution: ConflictResolution = {
      entity: 'AAPL',
      deepresearch_signal: { sentiment: 1, confidence: 0.9 },
      grok_signal: { sentiment: -1, confidence: 0.4 },
      resolved_winner: 'deepresearch',
      reason: 'high_impact_news',
    };

    expectTypeOf(resolution).toMatchTypeOf<ConflictResolution>();
    expect(['deepresearch', 'grok']).toContain(resolution.resolved_winner);
  });
});
