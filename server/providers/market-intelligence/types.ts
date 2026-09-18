import type { AssetClass } from '../../shared/index.js';

export type { AssetClass };

export type Duration = number;

export interface AgentIntelligence {
  agent_id: 'deepresearch' | 'grok' | 'alpaca-news' | 'polymarket' | 'gdelt-gkg';
  timestamp: Date;
  asset_class: AssetClass;
  items: IntelligenceItem[];
}

export interface IntelligenceItem {
  id: string;
  source: string;
  type: 'news' | 'sentiment';
  timestamp: Date;
  entity: string;
  scope?: 'entity' | 'asset_class';
  headline: string;
  sentiment: 1 | 0 | -1;
  confidence: number;
  summary?: string;
  url?: string;
}

export interface MarketContext {
  timestamp: Date;
  asset_class: AssetClass;
  news: IntelligenceItem[];
  social: IntelligenceItem[];
  intel: IntelligenceItem[];
  stale: boolean;
  last_updated: Date | null;
}

export type MarketContextCallback = (ctx: MarketContext) => void;
