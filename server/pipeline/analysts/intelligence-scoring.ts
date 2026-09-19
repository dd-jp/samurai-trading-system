import type { IntelligenceItem } from '../../providers/market-intelligence/index.js';
import type { Direction } from '../debate-engine/index.js';

export function directionFrom(items: IntelligenceItem[]): Direction {
  if (items.length === 0) {
    return 'neutral';
  }
  const netSentiment = items.reduce((sum, item) => sum + item.sentiment, 0) / items.length;
  if (netSentiment > 0) {
    return 'bullish';
  }
  if (netSentiment < 0) {
    return 'bearish';
  }
  return 'neutral';
}

export function confidenceFrom(items: IntelligenceItem[]): number {
  if (items.length === 0) {
    return 0.05;
  }
  const avg = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
  return Math.min(0.95, Math.max(0.05, avg));
}
