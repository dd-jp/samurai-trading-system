/**
 * Per-item sentiment scoring over SUPPLIED TEXT (#555, map #552).
 *
 * ## Why scoring is not optional
 *
 * #555 framed this as a choice and the analyst code closed it. The analysts are
 * deterministic — there is no LLM client anywhere in `server/pipeline/analysts/`
 * — and `fundamental-analyst.ts` reads exactly two scored fields:
 *
 * ```ts
 * const netSentiment = items.reduce((sum, i) => sum + i.sentiment, 0) / items.length;
 * const avg          = items.reduce((sum, i) => sum + i.confidence, 0) / items.length;
 * ```
 *
 * Both are required on `IntelligenceItem`. Ingesting unscored items with
 * `sentiment: 0` would leave `fundamental` **permanently neutral with a full
 * `.news` array** — and, worse, would remove the `NO_DATA_MARKER` that the
 * conviction score relies on to *exclude* a mute analyst from its evidence
 * average. The result would be #625's 0.5478 ceiling reinstated invisibly, on a
 * system that looked fixed.
 *
 * ## Why this is not the retrieval design that failed
 *
 * The model is asked to **classify text we already fetched**, never to recall
 * or retrieve anything. That is the whole decoupling: confabulation risk
 * collapses because every input token came from the archive, and
 * `retrievalEvidence` becomes archive-row provenance rather than a claim the
 * model makes about itself. ADR-0009 is untouched — this rides the existing
 * Nous client.
 *
 * ## Cost
 *
 * Metered as `stage: 'market_intelligence'` against the ADR-0008 cap. Headroom
 * is ample and larger than #555's ticket assumed: measured debate spend is
 * $0.878/day (#657), and post-#617 the debate leg projects to ~$0.31/day, ~9%
 * of the $50/14d cap. Items are scored in ONE batched call per refresh rather
 * than one call per item — the analyst needs a score per item, which is what
 * the response carries; it does not need a request per item.
 */

import type { LlmClient, LlmRequest } from '../../../pipeline/debate-engine/index.js';

/** What the model returns for one item. */
export interface ItemScore {
  /** Index into the batch as supplied — the join back to the item. */
  index: number;
  sentiment: 1 | 0 | -1;
  confidence: number;
}

/** The text handed to the model. Deliberately minimal: headline plus entity. */
export interface ScorableItem {
  entity: string;
  headline: string;
  summary: string;
}

/**
 * Neutral at floor confidence — what an item scores when the model could not be
 * reached or answered unusably.
 *
 * NOT a silent default. The caller logs the failure, and the value is chosen so
 * that a scoring outage degrades toward "no directional opinion" rather than
 * toward a fabricated one: `sentiment: 0` contributes nothing to
 * `netSentiment`, so an unscored batch cannot push an analyst into a direction
 * it has no evidence for.
 */
export const UNSCORED: Omit<ItemScore, 'index'> = { sentiment: 0, confidence: 0.05 };

const SYSTEM_INSTRUCTION =
  'You classify the market sentiment of financial news headlines that are SUPPLIED TO YOU. ' +
  'Do not use any knowledge beyond the supplied text. Do not recall or invent headlines. ' +
  'For each numbered item return its sentiment for the named entity: 1 = bullish, ' +
  '0 = neutral, -1 = bearish, and a confidence in [0,1] reflecting how clearly the ' +
  'supplied text supports that reading. A headline that is not about the entity, or ' +
  'carries no directional information, is 0 at low confidence. Respond as JSON: ' +
  '{"scores":[{"index":number,"sentiment":1|0|-1,"confidence":number}]}';

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

/** Clamped to the same [0.05, 0.95] band the analysts use for their own reads. */
function clampConfidence(value: number): number {
  return Math.min(0.95, Math.max(0.05, value));
}

export interface ScoreItemsDeps {
  llmClient: LlmClient;
  trace_id?: string | undefined;
}

/**
 * Scores a batch, returning one score per supplied item **in input order**.
 *
 * Never throws and never returns a short array: an item the model omitted, or a
 * batch that failed outright, comes back as `UNSCORED`. A scoring failure must
 * not take down the tick — the analysts degrade to "no opinion", which is a
 * state they already handle, rather than the ingestion path throwing inside the
 * refresh loop.
 */
export async function scoreItems(
  items: readonly ScorableItem[],
  deps: ScoreItemsDeps,
): Promise<ItemScore[]> {
  const fallback = items.map((_, index) => ({ index, ...UNSCORED }));
  if (items.length === 0) return [];

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
      },
    },
    parseResponse: (rawText: string) => {
      // The model may fence the JSON; take the outermost object.
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start === -1 || end <= start) {
        return { valid: false as const, reason: 'no JSON object in response' };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText.slice(start, end + 1));
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
      return { valid: true as const, data: { scores: scores.filter(isScore) } };
    },
  };

  let scores: ItemScore[];
  try {
    const response = await deps.llmClient.complete(request);
    scores = response.data.scores;
  } catch {
    // Caller logs; see the doc comment on why this degrades rather than throws.
    return fallback;
  }

  const byIndex = new Map(scores.map((score) => [score.index, score]));

  return items.map((_, index) => {
    const score = byIndex.get(index);
    if (score === undefined) return { index, ...UNSCORED };
    return {
      index,
      sentiment: score.sentiment,
      confidence: clampConfidence(score.confidence),
    };
  });
}
