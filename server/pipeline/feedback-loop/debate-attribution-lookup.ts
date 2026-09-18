import type { DebateLogStore } from '../../shared/index.js';
import type { AnalystContribution } from '../debate-engine/index.js';

export function getContributionsForAttribution(
  store: DebateLogStore,
  debate_id: string,
): AnalystContribution[] | undefined {
  const row = store.getByDebateId(debate_id);
  if (row === undefined || row.termination === 'latency_truncated') {
    return undefined;
  }
  return row.contributions;
}
