import { createHash } from 'node:crypto';
import type { AnalystView, DebateResult } from '../debate-engine/index.js';

export const AXIS_VOTE_ANALYST_TYPE = 'technical';

export const CONTROL_DEBATE_ID_PREFIX = 'control:';

const NO_DEBATE_HAPPENED =
  'Falsifier arm 2 (#753): no debate was held. The direction and confidence below are the ' +
  "technical analyst's deterministic axis vote (assessAxes), thresholded by the Trader's own " +
  'conviction floor. No model was called at any point on this path.';

export function controlArmDecision(input: {
  instrument: string;
  views: readonly AnalystView[];
  bar: Date;
}): DebateResult | null {
  const axisVote = input.views.find((view) => view.analyst_type === AXIS_VOTE_ANALYST_TYPE);
  if (axisVote === undefined) return null;

  return {
    direction: axisVote.direction,
    confidence: axisVote.confidence,

    bar_timestamp: input.bar,
    debate_id: controlDebateId(input.instrument, input.bar, axisVote),

    converged: true,
    rounds_completed: 0,
    latency_ms: 0,
    contributions: [],
    open_items: [],
    synthesis: NO_DEBATE_HAPPENED,
    position: NO_DEBATE_HAPPENED,
    disagreement_summary: NO_DEBATE_HAPPENED,
    read: true,
  };
}

function controlDebateId(instrument: string, bar: Date, axisVote: AnalystView): string {
  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
    analyst_id: axisVote.analyst_id,
    direction: axisVote.direction,
    confidence: axisVote.confidence,
    key_points: axisVote.key_points,
  });

  return `${CONTROL_DEBATE_ID_PREFIX}${createHash('sha256').update(payload).digest('hex')}`;
}
