import { createHash } from 'node:crypto';
import type { AnalystView } from './types.js';

function normalizeView(view: AnalystView) {
  return {
    analyst_id: view.analyst_id,
    analyst_type: view.analyst_type,
    direction: view.direction,
    confidence: view.confidence,
    key_points: view.key_points,
  };
}

export function computeDebateId(instrument: string, bar: Date, views: AnalystView[]): string {
  const normalized = views
    .map(normalizeView)
    .sort((a, b) => a.analyst_id.localeCompare(b.analyst_id));

  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
    views: normalized,
  });

  return createHash('sha256').update(payload).digest('hex');
}
