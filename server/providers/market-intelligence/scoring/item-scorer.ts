
import {
  BARE_JSON_INSTRUCTION,
  classifyFailureCause,
  type LlmClient,
  LlmMalformedResponseError,
  type LlmRequest,
  unwrapFencedJson,
} from '../../../pipeline/debate-engine/index.js';
import { type Logger, logCaughtFailure } from '../../../shared/index.js';

export interface ItemScore {
  index: number;
  sentiment: 1 | 0 | -1;
  confidence: number;
  omitted?: boolean;
}

export interface ScorableItem {
  entity: string;
  headline: string;
  summary: string;
}

export const UNSCORED: Omit<ItemScore, 'index'> = { sentiment: 0, confidence: 0.05 };

const SYSTEM_INSTRUCTION =
  'You classify the market sentiment of financial news headlines that are SUPPLIED TO YOU. ' +
  'Do not use any knowledge beyond the supplied text. Do not recall or invent headlines. ' +
  'For each numbered item return its sentiment for the named entity: 1 = bullish, ' +
  '0 = neutral, -1 = bearish, and a confidence in [0,1] reflecting how clearly the ' +
  'supplied text supports that reading. A headline that is not about the entity, or ' +
  'carries no directional information, is 0 at low confidence. Respond as JSON: ' +
  '{"scores":[{"index":number,"sentiment":1|0|-1,"confidence":number}]}\n\n' +
  BARE_JSON_INSTRUCTION;

function isScore(value: unknown): value is ItemScore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ItemScore>;
  return (
    typeof candidate.index === 'number' &&
    (candidate.sentiment === 1 || candidate.sentiment === 0 || candidate.sentiment === -1) &&
    typeof candidate.confidence === 'number' &&
    Number.isFinite(candidate.confidence)
  );
}

function clampConfidence(value: number): number {
  return Math.min(0.95, Math.max(0.05, value));
}

export interface ScoreItemsDeps {
  llmClient: LlmClient;
  trace_id?: string | undefined;
  logger: Logger;
}

export interface ScoreItemsResult {
  scores: ItemScore[];
  degraded: boolean;
}

export async function scoreItems(
  items: readonly ScorableItem[],
  deps: ScoreItemsDeps,
): Promise<ScoreItemsResult> {
  if (items.length === 0) return { scores: [], degraded: false };

  const fallback = items.map((_, index) => ({ index, ...UNSCORED }));

  const numbered = items
    .map((item, index) => `${index}. [${item.entity}] ${item.headline} ${item.summary}`.trim())
    .join('\n');

  const request: LlmRequest<{ scores: ItemScore[] }> = {
    prompt: `${SYSTEM_INSTRUCTION}\n\nItems:\n${numbered}`,
    context: {
      analyst_views: [],
      attribution: {
        ...(deps.trace_id === undefined ? {} : { trace_id: deps.trace_id }),
        stage: 'market_intelligence',
        gate_stage: 'market_intelligence_scoring',
      },
    },
    parseResponse: (rawText: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(unwrapFencedJson(rawText));
      } catch {
        return { valid: false as const, reason: 'response was not valid JSON' };
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return { valid: false as const, reason: 'response JSON was not an object' };
      }
      const scores = (parsed as { scores?: unknown }).scores;
      if (!Array.isArray(scores)) {
        return { valid: false as const, reason: 'response had no scores array' };
      }
      const valid = scores.filter(isScore);
      if (valid.length === 0) {
        return {
          valid: false as const,
          reason: 'no item in the scores array matched the expected shape',
        };
      }
      return { valid: true as const, data: { scores: valid } };
    },
  };

  let scores: ItemScore[];
  try {
    const response = await deps.llmClient.complete(request);
    scores = response.data.scores;
  } catch (error) {
    const trace_id = deps.trace_id ?? 'unattributed';
    const message =
      'market intelligence: item scoring failed; this batch degrades to UNSCORED ' +
      '(neutral, floor confidence) rather than a genuine neutral read';
    const failure_cause = classifyFailureCause(error);
    if (error instanceof LlmMalformedResponseError) {
      logCaughtFailure(
        deps.logger,
        {
          trace_id,
          stage: 'market_intelligence',
          level: 'warn',
          event: 'mi_scoring_malformed_response',
          message,
        },
        error,
        { items: items.length, failure_cause },
      );
    } else {
      logCaughtFailure(
        deps.logger,
        {
          trace_id,
          stage: 'market_intelligence',
          level: 'warn',
          event: 'mi_scoring_provider_failure',
          message,
        },
        error,
        { items: items.length, failure_cause },
      );
    }
    return { scores: fallback, degraded: true };
  }

  const byIndex = new Map(scores.map((score) => [score.index, score]));

  return {
    scores: items.map((_, index) => {
      const score = byIndex.get(index);
      if (score === undefined) return { index, ...UNSCORED, omitted: true };
      return {
        index,
        sentiment: score.sentiment,
        confidence: clampConfidence(score.confidence),
      };
    }),
    degraded: false,
  };
}
